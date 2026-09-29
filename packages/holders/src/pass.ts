import { getAddress, type Address } from "viem";

import { RetryExhaustedError, type ChainConfig } from "@assay/chain";
import {
  getTokensByAddresses,
  insertTokenHolderSnapshot,
  listBandTrustedQuotePoolsNeedingHolders,
  listTokenHolders,
  listYoungTrustedQuotePoolsNeedingHolders,
  updateTokenDeployer,
  updateTokenHolderScanBlock,
  upsertTokenHolders,
  type Db,
  type FdvBandCriteria,
  type PoolRow,
  type TokenHolderInsert,
  type TokenHolderSnapshotInsert,
  type TokenRow
} from "@assay/database";

import { computeBalances } from "./balances.js";
import { computeConcentration } from "./concentration.js";
import { HolderHaltError } from "./errors.js";
import type { Erc20Transfer, HolderReader } from "./reader.js";

/** Default re-scan window: a holder snapshot older than this is refreshed. */
const DEFAULT_STALENESS_MS = 15 * 60 * 1000;

/** How long an UNKNOWN deployer resolution rests before the explorer is
 * asked again — bounds attempts to at most one per token per window. */
const DEPLOYER_RETRY_MS = 60 * 60 * 1000;

export interface HolderPassOptions {
  readonly db: Db;
  readonly reader: HolderReader;
  readonly config: ChainConfig;
  /** Stops between pools — already-committed snapshots stay committed. */
  readonly signal?: AbortSignal;
  /** Re-scan pools whose latest snapshot is older than this. */
  readonly stalenessMs?: number;
  /** Injectable clock for deterministic selection/tests. */
  readonly now?: () => Date;
  /**
   * Two-lane pool selection, replacing the old unbounded full-population
   * scan. The band lane is the product's alert-relevant surface (a token
   * priced inside the watch band, with a missing/stale holder snapshot) and
   * is always selected first and fully bounded by `bandLimit`. The optional
   * backlog lane fills a second, independently bounded budget from young
   * pre-band pools so early holder coverage keeps warming up — but because
   * it runs strictly after the band lane and never grows its budget, it can
   * never starve band-relevant tokens of scan capacity (the 2026-07-12
   * audit found the reverse: an unbounded backlog-only sweep left band
   * tokens with zero holder coverage).
   */
  readonly selection: {
    readonly band: FdvBandCriteria;
    readonly bandLimit: number;
    /**
     * Band-lane quote-liquidity floor in USD (0 disables). Dust pools carry
     * arbitrary nominal FDV but near-zero quote capital, and a cold holder
     * scan walks the token's full transfer history, the dominant getLogs
     * spend (2026-07-14 incident). Below the floor a pool cannot pass
     * eligibility anyway, so no alertable signal is lost.
     */
    readonly bandMinQuoteLiquidityUsd?: number;
    readonly backlog?: { readonly minCreatedBlock: bigint; readonly limit: number };
  };
}

export interface HolderPoolError {
  readonly poolAddress: string;
  readonly message: string;
}

export interface HolderPassResult {
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly poolsSelected: number;
  readonly assessed: number;
  readonly snapshotsInserted: number;
  readonly poolErrors: HolderPoolError[];
  readonly stopped: boolean;
}

/**
 * Scan and persist holder distribution for pools selected by two priority
 * lanes: the band lane (trusted-quote pools currently valued inside the
 * watch band, missing/stale holder snapshot) always runs first and owns its
 * own bounded budget, because those are the tokens the product can actually
 * alert on today. The optional backlog lane then tops up from young
 * pre-band pools within its own separate bound, so early coverage keeps
 * accruing without ever eating into the band lane's budget — a pool in both
 * lanes is only ever scanned once. Staleness and FDV-band membership are
 * both evaluated in SQL now, not per-pool in this loop.
 *
 * Infra failure (RetryExhaustedError from a chain read) halts the pass with a
 * HolderHaltError so the worker backs off; selection is idempotent, so pending
 * pools are re-scanned next pass. A hostile token whose log read throws a
 * non-infra error is recorded and skipped without starving the rest.
 */
export async function runHolderPass(
  options: HolderPassOptions
): Promise<HolderPassResult> {
  const { db, reader, config, selection } = options;
  const now = options.now ?? (() => new Date());
  const stalenessMs = options.stalenessMs ?? DEFAULT_STALENESS_MS;

  let blockNumber: bigint;
  try {
    blockNumber = await reader.getBlockNumber();
  } catch (error) {
    if (error instanceof RetryExhaustedError) {
      throw new HolderHaltError("chain head read failed", { cause: error });
    }
    throw error;
  }

  const staleBefore = new Date(now().getTime() - stalenessMs);
  const bandPools = await listBandTrustedQuotePoolsNeedingHolders(
    db,
    config.chainId,
    selection.band,
    staleBefore,
    selection.bandLimit,
    selection.bandMinQuoteLiquidityUsd ?? 0
  );
  const backlogPools =
    selection.backlog === undefined
      ? []
      : await listYoungTrustedQuotePoolsNeedingHolders(
          db,
          config.chainId,
          selection.backlog.minCreatedBlock,
          staleBefore,
          selection.backlog.limit
        );
  const seenPoolAddresses = new Set<string>();
  const selected: PoolRow[] = [];
  for (const pool of [...bandPools, ...backlogPools]) {
    if (seenPoolAddresses.has(pool.poolAddress)) continue;
    seenPoolAddresses.add(pool.poolAddress);
    selected.push(pool);
  }

  const baseAddresses = selected
    .map((pool) => pool.baseTokenAddress)
    .filter((address): address is string => address !== null);
  const tokenRows = await getTokensByAddresses(db, config.chainId, baseAddresses);
  const tokenByAddress = new Map<string, TokenRow>();
  for (const token of tokenRows) {
    tokenByAddress.set(token.address, token);
  }

  let assessed = 0;
  let snapshotsInserted = 0;
  let stopped = false;
  const poolErrors: HolderPoolError[] = [];

  for (const pool of selected) {
    if (options.signal?.aborted === true) {
      stopped = true;
      break;
    }
    const base = pool.baseTokenAddress;
    if (base === null) continue;

    let snapshot: TokenHolderSnapshotInsert;
    let holderRows: TokenHolderInsert[];
    try {
      const token = tokenByAddress.get(base);
      const cursor = token?.holderScanBlock ?? null;
      let transfers: readonly Erc20Transfer[];
      let seed: Map<Address, bigint> | undefined;
      if (cursor === null) {
        // Never incrementally scanned: walk the full range and compute
        // balances from scratch. Seeding on top of a full replay would
        // double-count every transfer the seed already reflects.
        transfers = await reader.getErc20TransferLogs(
          getAddress(base),
          pool.createdAtBlock,
          blockNumber
        );
        seed = undefined;
      } else {
        const stored = await listTokenHolders(db, config.chainId, base);
        seed = new Map(
          stored.map(
            (row) =>
              [getAddress(row.holderAddress), BigInt(row.balanceRaw)] as const
          )
        );
        // Cursor already at (or past) head: another pool sharing this base
        // token advanced it earlier this pass, or nothing has moved since
        // the last scan. Skip the log fetch entirely — the RPC cost this
        // incremental scan exists to avoid — and recompute from the stored
        // balances alone.
        transfers =
          cursor >= blockNumber
            ? []
            : await reader.getErc20TransferLogs(
                getAddress(base),
                cursor + 1n,
                blockNumber
              );
      }
      const balances = computeBalances(transfers, seed);

      // Deployer provenance: reuse a prior resolution; otherwise ask the
      // explorer at most once per retry window and record the attempt so an
      // unanswered explorer is UNKNOWN (retryable), never re-hammered.
      let deployer: Address | null = null;
      if (token !== undefined) {
        if (token.deployerStatus === "RESOLVED" && token.deployerAddress !== null) {
          deployer = getAddress(token.deployerAddress);
        } else {
          const lastChecked = token.deployerCheckedAt?.getTime();
          const attemptDue =
            lastChecked === undefined ||
            lastChecked <= now().getTime() - DEPLOYER_RETRY_MS;
          if (attemptDue) {
            deployer = await reader.fetchContractCreation(getAddress(base));
            const update = {
              deployerAddress: deployer,
              deployerStatus: (deployer === null ? "UNKNOWN" : "RESOLVED") as
                | "UNKNOWN"
                | "RESOLVED",
              deployerCheckedAt: now()
            };
            await updateTokenDeployer(db, config.chainId, base, update);
            // Pools sharing this base token reuse the outcome this pass.
            tokenByAddress.set(base, { ...token, ...update });
          }
        }
      }

      const concentration = computeConcentration(balances, {
        totalSupply:
          token?.totalSupply !== null && token?.totalSupply !== undefined
            ? BigInt(token.totalSupply)
            : 0n,
        excluded: [{ address: pool.poolAddress, reason: "pool-address" }],
        deployer
      });
      if (seed === undefined) {
        holderRows = [...balances.entries()].map(([holderAddress, balance]) => ({
          chainId: config.chainId,
          tokenAddress: base,
          holderAddress,
          balanceRaw: balance.toString(),
          updatedBlock: blockNumber
        }));
      } else {
        // Incremental scan: only addresses this window's transfers touched
        // can have changed. A holder who sold to exactly zero drops out of
        // `balances` (only positive balances are economic holders) but MUST
        // still be upserted so their stale positive balance is overwritten.
        const touched = new Set<Address>();
        for (const { from, to } of transfers) {
          touched.add(getAddress(from));
          touched.add(getAddress(to));
        }
        holderRows = [...touched].map((holderAddress) => ({
          chainId: config.chainId,
          tokenAddress: base,
          holderAddress,
          balanceRaw: (balances.get(holderAddress) ?? 0n).toString(),
          updatedBlock: blockNumber
        }));
      }
      snapshot = {
        chainId: config.chainId,
        tokenAddress: base,
        blockNumber,
        holderCount: concentration.holderCount,
        adjustedHolderCount: concentration.adjustedHolderCount,
        largestHolderPctBps: concentration.largestHolderPctBps,
        top10PctBps: concentration.top10PctBps,
        adjustedTop10PctBps: concentration.adjustedTop10PctBps,
        deployerPctBps: concentration.deployerPctBps,
        floatBps: concentration.floatBps,
        supplyInPoolBps: concentration.supplyInPoolBps,
        holderClusterScoreBps: null,
        excluded: concentration.excluded
      };
    } catch (error) {
      if (error instanceof RetryExhaustedError) {
        throw new HolderHaltError("chain read failed during holder scan", {
          cause: error
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      poolErrors.push({ poolAddress: pool.poolAddress, message });
      continue;
    }

    await db.transaction(async (tx) => {
      await upsertTokenHolders(tx, holderRows);
      await insertTokenHolderSnapshot(tx, snapshot);
      await updateTokenHolderScanBlock(tx, config.chainId, base, blockNumber);
    });
    // Keep the in-memory token snapshot current so a second pool sharing
    // this base token later in the same pass sees the advanced cursor.
    const priorToken = tokenByAddress.get(base);
    if (priorToken !== undefined) {
      tokenByAddress.set(base, { ...priorToken, holderScanBlock: blockNumber });
    }
    assessed += 1;
    snapshotsInserted += 1;
  }

  return {
    chainId: config.chainId,
    blockNumber,
    poolsSelected: selected.length,
    assessed,
    snapshotsInserted,
    poolErrors,
    stopped
  };
}
