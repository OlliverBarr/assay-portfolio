import type { Address } from "viem";

import { RetryExhaustedError } from "@assay/chain";
import type { ChainConfig, QuoteAssetConfig, RetryOptions } from "@assay/chain";
import {
  getTokensByAddresses,
  insertPoolSnapshots,
  listActiveTrustedQuotePools,
  listIdleTrustedQuotePoolsDue,
  listTrustedQuotePools,
  updateTokenMetadata,
  type ActivePoolCriteria,
  type Db,
  type PoolRow,
  type PoolSnapshotInsert,
  type TokenRow
} from "@assay/database";

import { resolveUsdAnchor, type UsdAnchor } from "./anchor.js";
import { EnrichmentHaltError } from "./errors.js";
import { MAX_USD_WAD, WAD, formatWad, mulDiv } from "./fixed.js";
import { fetchTokenMetadata } from "./metadata.js";
import { estimatedFdvUsdWad, usdValueWad, v2PriceWad, v3PriceWad } from "./price.js";
import { createPoolStateReader, type ChainReader, type PoolStateReader } from "./reader.js";

/** Why a snapshot's value columns are null. Distinct from zero on purpose. */
export type SnapshotNullReason =
  | "metadata-error"
  | "no-usd-anchor"
  | "zero-liquidity"
  | "overflow"
  | "no-trusted-quote";

export interface EnrichmentPassOptions {
  readonly db: Db;
  readonly reader: ChainReader;
  readonly config: ChainConfig;
  readonly retry?: Partial<RetryOptions>;
  /** Stops between pools — snapshots already written stay written. */
  readonly signal?: AbortSignal;
  /** Bounded RPC parallelism across pools. Default 5. */
  readonly concurrency?: number;
  /** Cap the number of pools processed (ops/smoke tooling). Ignored when `selection` is set. */
  readonly poolLimit?: number;
  /**
   * Two-lane selection: the active set every pass, plus idle pools whose
   * latest snapshot is due for a slow-cadence refresh. Absent -> legacy
   * single-lane selection via `listTrustedQuotePools`/`poolLimit`, so RPC
   * cost scales with all-time pool count until a caller opts in.
   */
  readonly selection?: {
    readonly active: ActivePoolCriteria;
    /** Idle pools are due when their latest snapshot is older than this. */
    readonly idleRefreshMs: number;
    readonly idleBatchLimit: number;
  };
}

export interface PoolEnrichmentError {
  readonly poolAddress: string;
  readonly message: string;
}

export interface EnrichmentPassResult {
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly poolsSelected: number;
  /** Active-lane pool count. 0 when `selection` is absent (legacy pass). */
  readonly activePools: number;
  /** Idle-lane pool count, deduped against the active lane. */
  readonly idlePools: number;
  readonly snapshotsInserted: number;
  readonly metadataRefreshed: number;
  readonly poolErrors: PoolEnrichmentError[];
  readonly anchorPoolAddress: string | null;
  readonly stopped: boolean;
}

interface PassContext {
  readonly db: Db;
  readonly reader: ChainReader;
  readonly stateReader: PoolStateReader;
  readonly config: ChainConfig;
  readonly retry: Partial<RetryOptions> | undefined;
  readonly blockNumber: bigint;
  readonly anchorPoolAddress: string | null;
  readonly wethUsdWad: bigint | null;
  readonly virtualUsdWad: bigint | null;
  readonly virtualAnchorPoolAddress: string | null;
  readonly tokensByAddress: Map<string, TokenRow>;
}

function nullSnapshot(
  pool: PoolRow,
  blockNumber: bigint,
  reason: SnapshotNullReason,
  anchorPoolAddress: string | null
): PoolSnapshotInsert {
  return {
    chainId: pool.chainId,
    poolAddress: pool.poolAddress,
    blockNumber,
    calculationMethod:
      pool.factoryKind === "uniswap-v2" ? "v2-reserves" : "v3-slot0",
    priceUsd: null,
    estimatedFdvUsd: null,
    quoteLiquidityUsd: null,
    totalLiquidityUsd: null,
    anchorPoolAddress,
    nullReason: reason
  };
}

/** WAD USD price of one whole quote token, or null with a reason. */
function quoteUsdWad(
  quote: QuoteAssetConfig,
  ctx: PassContext
): { value: bigint; anchored: boolean } | null {
  if (quote.symbol === "USDG") return { value: WAD, anchored: false };
  if (quote.symbol === "WETH") {
    return ctx.wethUsdWad === null
      ? null
      : { value: ctx.wethUsdWad, anchored: true };
  }
  if (quote.symbol === "VIRTUAL") {
    return ctx.virtualUsdWad === null
      ? null
      : { value: ctx.virtualUsdWad, anchored: true };
  }
  // Additional stablecoins would be anchored here; none are configured yet.
  return null;
}

async function refreshMetadataIfNeeded(
  ctx: PassContext,
  tokenAddress: string
): Promise<{ row: TokenRow | undefined; refreshed: boolean }> {
  const existing = ctx.tokensByAddress.get(tokenAddress);
  if (existing?.metadataStatus === "PASS") {
    return { row: existing, refreshed: false };
  }
  const metadata = await fetchTokenMetadata(
    ctx.reader,
    tokenAddress as Address,
    ctx.retry
  );
  await updateTokenMetadata(ctx.db, ctx.config.chainId, tokenAddress, {
    name: metadata.name,
    symbol: metadata.symbol,
    decimals: metadata.decimals,
    totalSupply: metadata.totalSupply?.toString() ?? null,
    metadataStatus: metadata.status,
    metadataBlock: ctx.blockNumber
  });
  const updated: TokenRow | undefined =
    existing === undefined
      ? undefined
      : {
          ...existing,
          name: metadata.name,
          symbol: metadata.symbol,
          decimals: metadata.decimals,
          totalSupply: metadata.totalSupply?.toString() ?? null,
          metadataStatus: metadata.status,
          metadataBlock: ctx.blockNumber
        };
  if (updated !== undefined) ctx.tokensByAddress.set(tokenAddress, updated);
  return { row: updated, refreshed: true };
}

/** Price of the base token in quote tokens from pool state, or null. */
async function priceInQuoteWad(
  ctx: PassContext,
  pool: PoolRow,
  baseDecimals: number,
  quoteDecimals: number
): Promise<bigint | null> {
  const baseIsToken0 = pool.token0Address === pool.baseTokenAddress;
  if (pool.factoryKind === "uniswap-v2") {
    const { reserve0, reserve1 } = await ctx.stateReader.getV2Reserves(
      pool.poolAddress as Address
    );
    return v2PriceWad({
      reserveBase: baseIsToken0 ? reserve0 : reserve1,
      reserveQuote: baseIsToken0 ? reserve1 : reserve0,
      baseDecimals,
      quoteDecimals
    });
  }
  const sqrtPriceX96 = await ctx.stateReader.getSqrtPriceX96(
    pool.poolAddress as Address
  );
  return v3PriceWad({
    sqrtPriceX96,
    baseIsToken0,
    token0Decimals: baseIsToken0 ? baseDecimals : quoteDecimals,
    token1Decimals: baseIsToken0 ? quoteDecimals : baseDecimals
  });
}

async function enrichPool(
  ctx: PassContext,
  pool: PoolRow
): Promise<{ snapshot: PoolSnapshotInsert; metadataRefreshed: boolean }> {
  const quote = ctx.config.quoteAssets.find(
    (asset) => asset.address === pool.quoteTokenAddress
  );
  const baseAddress = pool.baseTokenAddress;
  if (quote === undefined || baseAddress === null) {
    return {
      snapshot: nullSnapshot(pool, ctx.blockNumber, "no-trusted-quote", null),
      metadataRefreshed: false
    };
  }

  const { row: token, refreshed } = await refreshMetadataIfNeeded(
    ctx,
    baseAddress
  );
  if (
    token === undefined ||
    token.metadataStatus !== "PASS" ||
    token.decimals === null ||
    token.totalSupply === null
  ) {
    return {
      snapshot: nullSnapshot(pool, ctx.blockNumber, "metadata-error", null),
      metadataRefreshed: refreshed
    };
  }

  const quoteUsd = quoteUsdWad(quote, ctx);
  if (quoteUsd === null) {
    return {
      snapshot: nullSnapshot(pool, ctx.blockNumber, "no-usd-anchor", null),
      metadataRefreshed: refreshed
    };
  }
  const anchorUsed = quoteUsd.anchored
    ? quote.symbol === "VIRTUAL"
      ? ctx.virtualAnchorPoolAddress
      : ctx.anchorPoolAddress
    : null;

  const priceQuoteWad = await priceInQuoteWad(
    ctx,
    pool,
    token.decimals,
    quote.decimals
  );
  if (priceQuoteWad === null || priceQuoteWad === 0n) {
    return {
      snapshot: nullSnapshot(pool, ctx.blockNumber, "zero-liquidity", anchorUsed),
      metadataRefreshed: refreshed
    };
  }

  const priceUsdWad = mulDiv(priceQuoteWad, quoteUsd.value, WAD);
  if (priceUsdWad >= MAX_USD_WAD) {
    return {
      snapshot: nullSnapshot(pool, ctx.blockNumber, "overflow", anchorUsed),
      metadataRefreshed: refreshed
    };
  }

  const fdvWad = estimatedFdvUsdWad(
    priceUsdWad,
    BigInt(token.totalSupply),
    token.decimals
  );

  // Liquidity estimate from pool balances (fine for both kinds; price NEVER
  // comes from balances).
  const poolAddress = pool.poolAddress as Address;
  const quoteBalance = await ctx.stateReader.getBalanceOf(
    quote.address,
    poolAddress
  );
  const baseBalance = await ctx.stateReader.getBalanceOf(
    baseAddress as Address,
    poolAddress
  );
  const quoteLiquidityWad = usdValueWad(
    quoteBalance,
    quote.decimals,
    quoteUsd.value
  );
  const baseLiquidityWad = usdValueWad(
    baseBalance,
    token.decimals,
    priceUsdWad
  );
  const totalLiquidityWad =
    quoteLiquidityWad !== null && baseLiquidityWad !== null
      ? quoteLiquidityWad + baseLiquidityWad
      : null;

  return {
    snapshot: {
      chainId: pool.chainId,
      poolAddress: pool.poolAddress,
      blockNumber: ctx.blockNumber,
      calculationMethod:
        pool.factoryKind === "uniswap-v2" ? "v2-reserves" : "v3-slot0",
      priceUsd: formatWad(priceUsdWad),
      estimatedFdvUsd: fdvWad === null ? null : formatWad(fdvWad),
      quoteLiquidityUsd:
        quoteLiquidityWad === null ? null : formatWad(quoteLiquidityWad),
      totalLiquidityUsd:
        totalLiquidityWad === null ? null : formatWad(totalLiquidityWad),
      anchorPoolAddress: anchorUsed,
      nullReason: fdvWad === null || totalLiquidityWad === null ? "overflow" : null
    },
    metadataRefreshed: refreshed
  };
}

/**
 * One enrichment pass: resolve the USD anchor, then snapshot every
 * trusted-quote pool. Per-pool failures are collected and reported — one
 * hostile token must never starve the rest of the watchlist. Pass-level
 * failures (anchor/RPC infrastructure) propagate to the caller's loop.
 */
export async function runEnrichmentPass(
  options: EnrichmentPassOptions
): Promise<EnrichmentPassResult> {
  const { db, reader, config } = options;
  const concurrency = options.concurrency ?? 5;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be >= 1, got ${concurrency}`);
  }
  const stateReader = createPoolStateReader(reader, options.retry);

  let blockNumber: bigint;
  let anchor: UsdAnchor | null;
  try {
    blockNumber = await stateReader.getBlockNumber();
    anchor = await resolveUsdAnchor(db, stateReader, config);
  } catch (error) {
    if (error instanceof RetryExhaustedError) {
      throw new EnrichmentHaltError("chain read failed during enrichment", {
        cause: error
      });
    }
    throw error;
  }

  let pools: PoolRow[];
  let activePools = 0;
  let idlePools = 0;
  if (options.selection === undefined) {
    pools = await listTrustedQuotePools(db, config.chainId, options.poolLimit);
  } else {
    const { active, idleRefreshMs, idleBatchLimit } = options.selection;
    const activeRows = await listActiveTrustedQuotePools(
      db,
      config.chainId,
      active
    );
    const idleCutoff = new Date(active.now.getTime() - idleRefreshMs);
    const idleRows = await listIdleTrustedQuotePoolsDue(
      db,
      config.chainId,
      active,
      idleCutoff,
      idleBatchLimit
    );
    const activeAddresses = new Set(
      activeRows.map((pool) => pool.poolAddress)
    );
    const dedupedIdle = idleRows.filter(
      (pool) => !activeAddresses.has(pool.poolAddress)
    );
    pools = [...activeRows, ...dedupedIdle];
    activePools = activeRows.length;
    idlePools = dedupedIdle.length;
  }

  const baseAddresses = [
    ...new Set(
      pools
        .map((pool) => pool.baseTokenAddress)
        .filter((address): address is string => address !== null)
    )
  ];
  const tokenRows = await getTokensByAddresses(
    db,
    config.chainId,
    baseAddresses
  );

  const ctx: PassContext = {
    db,
    reader,
    stateReader,
    config,
    retry: options.retry,
    blockNumber,
    anchorPoolAddress: anchor?.anchorPoolAddress ?? null,
    wethUsdWad: anchor?.wethUsdWad ?? null,
    virtualUsdWad: anchor?.virtualUsdWad ?? null,
    virtualAnchorPoolAddress: anchor?.virtualAnchorPoolAddress ?? null,
    tokensByAddress: new Map(tokenRows.map((row) => [row.address, row]))
  };

  let snapshotsInserted = 0;
  let metadataRefreshed = 0;
  let stopped = false;
  const poolErrors: PoolEnrichmentError[] = [];

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted === true) {
        stopped = true;
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      const pool = pools[index];
      if (pool === undefined) return;
      try {
        const { snapshot, metadataRefreshed: refreshed } = await enrichPool(
          ctx,
          pool
        );
        const inserted = await insertPoolSnapshots(db, [snapshot]);
        snapshotsInserted += inserted;
        if (refreshed) metadataRefreshed += 1;
      } catch (error) {
        poolErrors.push({
          poolAddress: pool.poolAddress,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pools.length) }, worker)
  );

  return {
    chainId: config.chainId,
    blockNumber,
    poolsSelected: pools.length,
    activePools,
    idlePools,
    snapshotsInserted,
    metadataRefreshed,
    poolErrors,
    anchorPoolAddress: anchor?.anchorPoolAddress ?? null,
    stopped
  };
}
