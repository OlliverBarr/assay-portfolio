import type { Address } from "viem";

import type { ChainConfig, QuoteAssetConfig } from "@assay/chain";
import { listPoolsByPair, type Db, type PoolRow } from "@assay/database";

import { WAD, mulDiv } from "./fixed.js";
import { usdValueWad, v2PriceWad, v3PriceWad } from "./price.js";
import type { PoolStateReader } from "./reader.js";

/**
 * USD anchoring (docs/decisions.md): USDG is exactly $1.00. WETH/USD comes
 * from the single deepest WETH/USDG pool (highest USDG-side balance) at
 * read time. VIRTUAL/USD chains one hop further off the same live reads:
 * deepest VIRTUAL-vs-(USDG|WETH) pool, priced directly against USDG or
 * converted through wethUsdWad. No external price feed; every side is an
 * allow-listed asset, so pool depth represents real capital.
 */

export interface UsdAnchor {
  readonly wethUsdWad: bigint;
  readonly anchorPoolAddress: Address;
  /** VIRTUAL/USD, or null when VIRTUAL is unconfigured or its deepest anchor pool is below the depth floor. */
  readonly virtualUsdWad: bigint | null;
  readonly virtualAnchorPoolAddress: Address | null;
}

/**
 * Minimum USD depth (quote-side balance, converted to USD) a VIRTUAL
 * anchor pool must hold before its price is trusted. This is a depth
 * floor, not a staleness check: every enrichment pass re-reads the anchor
 * live, so there is never a "stale" price to guard against. What a live
 * read cannot fix is a drained pool — a few hundred dollars of remaining
 * liquidity lets a trivial trade move the quoted price arbitrarily, which
 * would then get chained onto every VIRTUAL-quoted pool in the long tail.
 * Below this floor VIRTUAL/USD resolves null and those pools fall back to
 * the existing "no-usd-anchor" null snapshot instead of trusting it.
 */
export const MIN_ANCHOR_DEPTH_USD_WAD = 50_000n * WAD;

/**
 * Price of `baseAddress` in quote tokens from pool state (V2 reserves or
 * V3 sqrtPriceX96), decimal-adjusted and WAD-scaled. Shared by the
 * WETH/USDG anchor and the VIRTUAL anchor — both are "one base token
 * priced in one quote token from a single pool's live state".
 */
async function priceBaseInQuoteWad(
  pool: PoolRow,
  baseAddress: string,
  baseDecimals: number,
  quoteDecimals: number,
  stateReader: PoolStateReader
): Promise<bigint | null> {
  const baseIsToken0 = pool.token0Address === baseAddress;
  if (pool.factoryKind === "uniswap-v2") {
    const { reserve0, reserve1 } = await stateReader.getV2Reserves(
      pool.poolAddress as Address
    );
    return v2PriceWad({
      reserveBase: baseIsToken0 ? reserve0 : reserve1,
      reserveQuote: baseIsToken0 ? reserve1 : reserve0,
      baseDecimals,
      quoteDecimals
    });
  }
  const sqrtPriceX96 = await stateReader.getSqrtPriceX96(
    pool.poolAddress as Address
  );
  return v3PriceWad({
    sqrtPriceX96,
    baseIsToken0,
    token0Decimals: baseIsToken0 ? baseDecimals : quoteDecimals,
    token1Decimals: baseIsToken0 ? quoteDecimals : baseDecimals
  });
}

interface VirtualAnchorCandidate {
  readonly pool: PoolRow;
  readonly depthUsdWad: bigint;
  readonly quoteSide: "USDG" | "WETH";
}

/**
 * Resolve VIRTUAL/USD from the deepest VIRTUAL pool paired against USDG
 * or WETH. Depth is compared in USD terms so the two quote sides are
 * commensurable: USDG-side depth is the pool's USDG balance (USDG = $1);
 * WETH-side depth is the pool's WETH balance times the already-resolved
 * `wethUsdWad`. A pool below `MIN_ANCHOR_DEPTH_USD_WAD` never wins.
 */
async function resolveVirtualAnchor(
  db: Db,
  stateReader: PoolStateReader,
  chainId: number,
  virtual: QuoteAssetConfig,
  weth: QuoteAssetConfig,
  usdg: QuoteAssetConfig,
  wethUsdWad: bigint
): Promise<{ virtualUsdWad: bigint; virtualAnchorPoolAddress: Address } | null> {
  const [usdgPairs, wethPairs] = await Promise.all([
    listPoolsByPair(db, chainId, virtual.address, usdg.address),
    listPoolsByPair(db, chainId, virtual.address, weth.address)
  ]);

  let best: VirtualAnchorCandidate | null = null;
  for (const pool of usdgPairs) {
    const balance = await stateReader.getBalanceOf(
      usdg.address,
      pool.poolAddress as Address
    );
    const depthUsdWad = usdValueWad(balance, usdg.decimals, WAD) ?? 0n;
    if (best === null || depthUsdWad > best.depthUsdWad) {
      best = { pool, depthUsdWad, quoteSide: "USDG" };
    }
  }
  // WETH-anchored VIRTUAL requires wethUsdWad non-null: without a live
  // WETH/USD price there is nothing to convert WETH-side depth into.
  for (const pool of wethPairs) {
    const balance = await stateReader.getBalanceOf(
      weth.address,
      pool.poolAddress as Address
    );
    const depthUsdWad = usdValueWad(balance, weth.decimals, wethUsdWad) ?? 0n;
    if (best === null || depthUsdWad > best.depthUsdWad) {
      best = { pool, depthUsdWad, quoteSide: "WETH" };
    }
  }

  if (best === null || best.depthUsdWad < MIN_ANCHOR_DEPTH_USD_WAD) return null;

  const quoteDecimals = best.quoteSide === "USDG" ? usdg.decimals : weth.decimals;
  const virtualPriceWad = await priceBaseInQuoteWad(
    best.pool,
    virtual.address,
    virtual.decimals,
    quoteDecimals,
    stateReader
  );
  if (virtualPriceWad === null || virtualPriceWad === 0n) return null;

  const virtualUsdWad =
    best.quoteSide === "USDG"
      ? virtualPriceWad
      : mulDiv(virtualPriceWad, wethUsdWad, WAD);

  return {
    virtualUsdWad,
    virtualAnchorPoolAddress: best.pool.poolAddress as Address
  };
}

/**
 * Resolve the WETH/USD anchor, or null when it cannot exist (no WETH or
 * USDG configured, no WETH/USDG pool discovered, or the deepest pool is
 * empty). RPC failures propagate — they are pass-level problems. VIRTUAL,
 * when configured, is resolved as an additional chained hop off the same
 * live reads; a failed VIRTUAL resolution only nulls out the VIRTUAL
 * fields, it never fails the WETH anchor.
 */
export async function resolveUsdAnchor(
  db: Db,
  stateReader: PoolStateReader,
  config: ChainConfig
): Promise<UsdAnchor | null> {
  const weth = config.quoteAssets.find((asset) => asset.symbol === "WETH");
  const usdg = config.quoteAssets.find((asset) => asset.symbol === "USDG");
  if (weth === undefined || usdg === undefined) return null;

  const candidates = await listPoolsByPair(
    db,
    config.chainId,
    weth.address,
    usdg.address
  );
  if (candidates.length === 0) return null;

  // Deepest = highest USDG-side balance: dollar depth is comparable across
  // V2 and V3 without pricing anything first.
  let best: { pool: PoolRow; usdgBalance: bigint } | null = null;
  for (const pool of candidates) {
    const usdgBalance = await stateReader.getBalanceOf(
      usdg.address,
      pool.poolAddress as Address
    );
    if (best === null || usdgBalance > best.usdgBalance) {
      best = { pool, usdgBalance };
    }
  }
  if (best === null || best.usdgBalance === 0n) return null;

  const wethUsdWad = await priceBaseInQuoteWad(
    best.pool,
    weth.address,
    weth.decimals,
    usdg.decimals,
    stateReader
  );
  if (wethUsdWad === null || wethUsdWad === 0n) return null;

  const virtual = config.quoteAssets.find((asset) => asset.symbol === "VIRTUAL");
  const virtualAnchor =
    virtual === undefined
      ? null
      : await resolveVirtualAnchor(
          db,
          stateReader,
          config.chainId,
          virtual,
          weth,
          usdg,
          wethUsdWad
        );

  return {
    wethUsdWad,
    anchorPoolAddress: best.pool.poolAddress as Address,
    virtualUsdWad: virtualAnchor?.virtualUsdWad ?? null,
    virtualAnchorPoolAddress: virtualAnchor?.virtualAnchorPoolAddress ?? null
  };
}
