import {
  getActivitySnapshotAt,
  getHolderSnapshotAt,
  getPoolsDueForPerformance,
  getTokenRiskAt,
  insertTokenPerformance,
  listPoolSnapshots,
  type Db,
  type PoolActivitySnapshotRow,
  type PoolRow,
  type PoolSnapshotRow,
  type TokenHolderSnapshotRow,
  type TokenPerformanceInsert,
  type TokenRiskRow
} from "@assay/database";
import type { RiskStatus, SimulationStatus, VerificationStatus } from "@assay/scoring";

import { hasCriticalPermission } from "./candidate.js";

export interface PerformancePassConfig {
  /** Hours after band entry at which a pool is labeled. */
  readonly horizons: readonly number[];
  /** Lower bound (inclusive) of the FDV band that defines "entry". */
  readonly bandMinFdvUsd: number;
  /** Upper bound (inclusive) of the FDV band that defines "entry". */
  readonly bandMaxFdvUsd: number;
  /** Pools labeled per horizon per pass. */
  readonly batchLimit: number;
}

const DEFAULT_CONFIG: PerformancePassConfig = {
  horizons: [72, 168],
  bandMinFdvUsd: 50_000,
  bandMaxFdvUsd: 200_000,
  batchLimit: 200
};

export interface PerformancePassOptions {
  readonly db: Db;
  readonly chainId: number;
  /** Overrides merged onto the defaults; unset fields keep their default. */
  readonly config?: Partial<PerformancePassConfig>;
  /** Stops between (horizon, pool) pairs — already-inserted labels stay committed. */
  readonly signal?: AbortSignal;
  /** Injectable clock; caps the labeling window at "now" for deterministic tests. */
  readonly now?: () => Date;
}

export interface PerformancePoolError {
  readonly poolAddress: string;
  readonly horizonHours: number;
  readonly message: string;
}

export interface PerformancePassResult {
  readonly chainId: number;
  readonly horizons: readonly number[];
  readonly poolsConsidered: number;
  readonly labeled: number;
  readonly skipped: number;
  readonly poolErrors: PerformancePoolError[];
  readonly stopped: boolean;
}

/**
 * Coarse USD gating, deliberately lossy — mirrors `parseUsdNumber` in
 * `@assay/scoring` (not part of that package's public surface, so a local
 * copy lives here, same as outcome-pass.ts). Only valid for threshold
 * comparisons, never money movement, which stays bigint / integer strings.
 */
function parseUsdNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/**
 * Entry-time feature vector; every field is null when its source row is
 * absent. This is the winners-retro replay contract: it must carry every
 * eligibility-gate input (activity, risk permissions, holder concentration)
 * so a winner with no shadow decision near band entry can still be replayed
 * through evaluateEligibility/scoreOpportunity instead of collapsing into
 * tier 4 "signals-missing". `parseEntryFeatures` (winners-retro.ts) is the
 * strict read-side inverse — a field added here must be added there.
 */
export interface PerformanceEntryFeatures {
  readonly quoteLiquidityUsd: string | null;
  readonly totalLiquidityUsd: string | null;
  readonly ageMinutesAtEntry: number;
  readonly uniqueBuyers20m: number | null;
  readonly uniqueBuyers1h: number | null;
  readonly buyCount20m: number | null;
  readonly sellCount20m: number | null;
  readonly quoteBuyVolumeRaw20m: string | null;
  readonly quoteSellVolumeRaw20m: string | null;
  readonly buySizeGiniBps: number | null;
  readonly buySizeEntropyBps: number | null;
  readonly repeatedSizeBuyPctBps: number | null;
  readonly floatBps: number | null;
  readonly supplyInPoolBps: number | null;
  readonly adjustedTop10PctBps: number | null;
  readonly deployerPctBps: number | null;
  readonly holderCount: number | null;
  readonly adjustedHolderCount: number | null;
  readonly largestHolderPctBps: number | null;
  readonly holderClusterScoreBps: number | null;
  readonly riskStatus: RiskStatus | null;
  readonly simulationStatus: SimulationStatus | null;
  readonly effectiveSellLossBps: number | null;
  readonly criticalPermissionPresent: boolean | null;
  readonly isProxy: boolean | null;
  readonly verificationStatus: VerificationStatus | null;
}

export interface PerformanceComputation {
  readonly entrySnapshot: PoolSnapshotRow;
  readonly peakSnapshot: PoolSnapshotRow;
  readonly maxMultipleBps: number;
  readonly maxDrawdownBps: number;
  readonly minutesToPeak: number;
  readonly snapshotsInWindow: number;
  readonly windowEndAt: Date;
  readonly details: Record<string, unknown>;
}

/**
 * Label one pool's realized performance at one horizon from its snapshot
 * series, per the performance contract:
 *
 * - Entry = the FIRST OBSERVED snapshot (by array/id order) with a non-null
 *   `estimatedFdvUsd` inside `[band.bandMinFdvUsd, band.bandMaxFdvUsd]` AND a
 *   non-null `priceUsd`. Forward-only: observation gaps mean "first
 *   observed", never "first ever".
 * - The window `[entry.capturedAt, entry.capturedAt + horizonHours]` must be
 *   fully elapsed (`now >= windowEnd`) — never relabel a partial window.
 * - `maxMultipleBps` = max(price)/entryPrice in bps over priced snapshots in
 *   the window (entry included, so it is always >= 10000 unless the feed
 *   never returns a higher price, in which case it is exactly 10000).
 * - `maxDrawdownBps` = worst (entry - trough)/entry in bps, using only
 *   priced snapshots at or before the peak snapshot (pain before payoff);
 *   never negative.
 * - `minutesToPeak` = minutes from entry to the peak-price snapshot.
 *
 * Returns null when there is no observed band entry, the window has not yet
 * fully elapsed, or the entry's own price fields fail to parse — such pools
 * are skipped, never labeled.
 */
export function computePerformanceLabel(
  snapshots: readonly PoolSnapshotRow[],
  horizonHours: number,
  band: Pick<PerformancePassConfig, "bandMinFdvUsd" | "bandMaxFdvUsd">,
  now: Date
): PerformanceComputation | null {
  let entryIndex = -1;
  for (let i = 0; i < snapshots.length; i += 1) {
    const snapshot = snapshots[i]!;
    const fdvUsd = parseUsdNumber(snapshot.estimatedFdvUsd);
    if (fdvUsd === null) continue;
    if (fdvUsd < band.bandMinFdvUsd || fdvUsd > band.bandMaxFdvUsd) continue;
    if (parseUsdNumber(snapshot.priceUsd) === null) continue;
    entryIndex = i;
    break;
  }
  if (entryIndex === -1) return null;

  const entry = snapshots[entryIndex]!;
  const entryPriceUsd = parseUsdNumber(entry.priceUsd);
  if (entryPriceUsd === null) return null;

  const windowEndMs = entry.capturedAt.getTime() + horizonHours * 60 * 60 * 1000;
  if (now.getTime() < windowEndMs) return null;
  const windowEndAt = new Date(windowEndMs);

  const inWindow = snapshots
    .slice(entryIndex)
    .filter((snapshot) => snapshot.capturedAt.getTime() <= windowEndMs);

  const priced = inWindow.filter(
    (snapshot): snapshot is PoolSnapshotRow & { priceUsd: string } =>
      snapshot.priceUsd !== null
  );
  if (priced.length === 0) return null;

  let peakIndex = 0;
  let peakPriceUsd = parseUsdNumber(priced[0]!.priceUsd) ?? entryPriceUsd;
  for (let i = 1; i < priced.length; i += 1) {
    const priceUsd = parseUsdNumber(priced[i]!.priceUsd);
    if (priceUsd !== null && priceUsd > peakPriceUsd) {
      peakPriceUsd = priceUsd;
      peakIndex = i;
    }
  }
  const peak = priced[peakIndex]!;

  let troughPriceUsd = entryPriceUsd;
  for (let i = 0; i <= peakIndex; i += 1) {
    const priceUsd = parseUsdNumber(priced[i]!.priceUsd);
    if (priceUsd !== null && priceUsd < troughPriceUsd) {
      troughPriceUsd = priceUsd;
    }
  }

  const maxMultipleBps = Math.round((peakPriceUsd / entryPriceUsd) * 10_000);
  const maxDrawdownBps = Math.max(
    0,
    Math.round(((entryPriceUsd - troughPriceUsd) / entryPriceUsd) * 10_000)
  );
  const minutesToPeak = Math.round(
    (peak.capturedAt.getTime() - entry.capturedAt.getTime()) / 60_000
  );

  return {
    entrySnapshot: entry,
    peakSnapshot: peak,
    maxMultipleBps,
    maxDrawdownBps,
    minutesToPeak,
    snapshotsInWindow: inWindow.length,
    windowEndAt,
    details: {
      horizonHours,
      bandMinFdvUsd: band.bandMinFdvUsd,
      bandMaxFdvUsd: band.bandMaxFdvUsd,
      entrySnapshotId: entry.id.toString(),
      entryBlockNumber: entry.blockNumber.toString(),
      entryCapturedAt: entry.capturedAt.toISOString(),
      entryPriceUsd: entry.priceUsd,
      entryFdvUsd: entry.estimatedFdvUsd,
      windowEndAt: windowEndAt.toISOString(),
      peakSnapshotId: peak.id.toString(),
      peakCapturedAt: peak.capturedAt.toISOString(),
      peakPriceUsd: peak.priceUsd,
      snapshotCount: snapshots.length,
      snapshotsInWindow: inWindow.length,
      pricedSnapshotsInWindow: priced.length,
      maxMultipleBps,
      maxDrawdownBps,
      minutesToPeak,
      observation:
        "forward-only from first observed band-entry snapshot; window requires now >= entry.capturedAt + horizonHours"
    }
  };
}

export function buildEntryFeatures(
  entry: PoolSnapshotRow,
  pool: PoolRow,
  activity: PoolActivitySnapshotRow | undefined,
  holder: TokenHolderSnapshotRow | undefined,
  risk: TokenRiskRow | undefined
): PerformanceEntryFeatures {
  const ageMs = entry.capturedAt.getTime() - pool.discoveredAt.getTime();
  return {
    quoteLiquidityUsd: entry.quoteLiquidityUsd,
    totalLiquidityUsd: entry.totalLiquidityUsd,
    ageMinutesAtEntry: Math.max(0, Math.floor(ageMs / 60_000)),
    uniqueBuyers20m: activity?.uniqueBuyers20m ?? null,
    uniqueBuyers1h: activity?.uniqueBuyers1h ?? null,
    buyCount20m: activity?.buyCount20m ?? null,
    sellCount20m: activity?.sellCount20m ?? null,
    quoteBuyVolumeRaw20m: activity?.quoteBuyVolumeRaw20m ?? null,
    quoteSellVolumeRaw20m: activity?.quoteSellVolumeRaw20m ?? null,
    buySizeGiniBps: activity?.buySizeGiniBps ?? null,
    buySizeEntropyBps: activity?.buySizeEntropyBps ?? null,
    repeatedSizeBuyPctBps: activity?.repeatedSizeBuyPctBps ?? null,
    floatBps: holder?.floatBps ?? null,
    supplyInPoolBps: holder?.supplyInPoolBps ?? null,
    adjustedTop10PctBps: holder?.adjustedTop10PctBps ?? null,
    deployerPctBps: holder?.deployerPctBps ?? null,
    holderCount: holder?.holderCount ?? null,
    adjustedHolderCount: holder?.adjustedHolderCount ?? null,
    largestHolderPctBps: holder?.largestHolderPctBps ?? null,
    holderClusterScoreBps: holder?.holderClusterScoreBps ?? null,
    riskStatus: (risk?.status ?? null) as RiskStatus | null,
    simulationStatus: (risk?.simulationStatus ?? null) as SimulationStatus | null,
    effectiveSellLossBps: risk?.effectiveSellLossBps ?? null,
    criticalPermissionPresent:
      risk === undefined ? null : hasCriticalPermission(risk.permissionFindings),
    isProxy: risk?.isProxy ?? null,
    verificationStatus: (risk?.verificationStatus ?? null) as VerificationStatus | null
  };
}

/**
 * Label every pool due for a performance outcome at each configured
 * horizon, population-wide — no alert/eligibility conditioning. "Due" is
 * delegated to `getPoolsDueForPerformance` (a coarse age filter over the
 * first snapshot); real entry detection and window-completeness happen in
 * `computePerformanceLabel`, so a pool can come back "due" and still be
 * skipped, never relabeled. `insertTokenPerformance` is idempotent as a
 * defensive backstop. Per-pool failures are collected; one bad pool never
 * starves the rest of the batch. No RPC anywhere in this pass — DB only.
 */
export async function runPerformancePass(
  options: PerformancePassOptions
): Promise<PerformancePassResult> {
  const { db, chainId } = options;
  const config: PerformancePassConfig = { ...DEFAULT_CONFIG, ...options.config };
  const now = options.now ?? (() => new Date());
  // Function call (not property read) so TS doesn't narrow `aborted` across awaits.
  const isAborted = (): boolean => options.signal?.aborted === true;

  let poolsConsidered = 0;
  let labeled = 0;
  let skipped = 0;
  const poolErrors: PerformancePoolError[] = [];
  let stopped = false;

  for (const horizonHours of config.horizons) {
    if (stopped) break;
    if (isAborted()) {
      stopped = true;
      break;
    }

    const duePools = await getPoolsDueForPerformance(
      db,
      chainId,
      horizonHours,
      config.batchLimit,
      { minFdvUsd: config.bandMinFdvUsd, maxFdvUsd: config.bandMaxFdvUsd }
    );

    for (const pool of duePools) {
      if (isAborted()) {
        stopped = true;
        break;
      }
      poolsConsidered += 1;

      const tokenAddress = pool.baseTokenAddress;
      if (tokenAddress === null) {
        skipped += 1;
        continue;
      }

      try {
        const snapshots = await listPoolSnapshots(db, chainId, pool.poolAddress);
        const computed = computePerformanceLabel(
          snapshots,
          horizonHours,
          config,
          now()
        );
        if (computed === null) {
          skipped += 1;
          continue;
        }

        const entry = computed.entrySnapshot;
        const [activity, holder, risk] = await Promise.all([
          getActivitySnapshotAt(db, chainId, pool.poolAddress, entry.capturedAt),
          getHolderSnapshotAt(db, chainId, tokenAddress, entry.capturedAt),
          getTokenRiskAt(db, chainId, tokenAddress, entry.capturedAt)
        ]);
        const entryFeatures = buildEntryFeatures(entry, pool, activity, holder, risk);

        const insert: TokenPerformanceInsert = {
          chainId,
          tokenAddress,
          poolAddress: pool.poolAddress,
          horizonHours,
          bandMinFdvUsd: config.bandMinFdvUsd.toString(),
          bandMaxFdvUsd: config.bandMaxFdvUsd.toString(),
          enteredAt: entry.capturedAt,
          entryBlock: entry.blockNumber,
          entryPriceUsd: entry.priceUsd!,
          entryFdvUsd: entry.estimatedFdvUsd!,
          maxMultipleBps: computed.maxMultipleBps,
          maxDrawdownBps: computed.maxDrawdownBps,
          minutesToPeak: computed.minutesToPeak,
          snapshotsInWindow: computed.snapshotsInWindow,
          entryFeatures,
          details: computed.details
        };
        await insertTokenPerformance(db, insert);

        labeled += 1;
      } catch (error) {
        poolErrors.push({
          poolAddress: pool.poolAddress,
          horizonHours,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  return {
    chainId,
    horizons: config.horizons,
    poolsConsidered,
    labeled,
    skipped,
    poolErrors,
    stopped
  };
}
