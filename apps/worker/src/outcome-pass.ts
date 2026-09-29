import {
  getPoolsDueForOutcome,
  insertTokenOutcome,
  listPoolSnapshots,
  type Db,
  type PoolSnapshotRow,
  type TokenOutcomeInsert
} from "@assay/database";

/** `SURVIVED` when the pool held onto its liquidity and valuation; `DIED` otherwise. */
export type OutcomeLabel = "SURVIVED" | "DIED";

export interface OutcomePassConfig {
  /** Hours after first observation at which a pool is labeled. */
  readonly horizons: readonly number[];
  /**
   * Minimum share of peak `quoteLiquidityUsd`, in bps, that must still be
   * present at the horizon for the pool to count as SURVIVED.
   */
  readonly survivalMinLiquidityFractionBps: number;
  /** Minimum `estimatedFdvUsd` at the horizon required to count as SURVIVED. */
  readonly survivalMinFdvUsd: number;
  /** Pools labeled per horizon per pass. */
  readonly batchLimit: number;
}

const DEFAULT_CONFIG: OutcomePassConfig = {
  horizons: [24, 72],
  survivalMinLiquidityFractionBps: 3000,
  survivalMinFdvUsd: 10_000,
  batchLimit: 200
};

export interface OutcomePassOptions {
  readonly db: Db;
  readonly chainId: number;
  /** Overrides merged onto the defaults; unset fields keep their default. */
  readonly config?: Partial<OutcomePassConfig>;
  /** Stops between (horizon, pool) pairs — already-inserted labels stay committed. */
  readonly signal?: AbortSignal;
  /** Injectable clock; caps the labeling window at "now" for deterministic tests. */
  readonly now?: () => Date;
}

export interface OutcomePoolError {
  readonly poolAddress: string;
  readonly horizonHours: number;
  readonly message: string;
}

export interface OutcomePassResult {
  readonly chainId: number;
  readonly horizons: readonly number[];
  readonly poolsConsidered: number;
  readonly labeled: number;
  readonly survived: number;
  readonly died: number;
  readonly skipped: number;
  readonly poolErrors: OutcomePoolError[];
  readonly stopped: boolean;
}

/**
 * Coarse USD gating, deliberately lossy — mirrors `parseUsdNumber` in
 * `@assay/scoring` (not part of that package's public surface, so a local
 * copy lives here). Only valid for threshold comparisons, never money
 * movement, which stays bigint / integer strings.
 */
function parseUsdNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export interface OutcomeComputation {
  readonly outcome: OutcomeLabel;
  readonly peakQuoteLiquidityUsd: string;
  readonly quoteLiquidityAtHorizonUsd: string;
  readonly estimatedFdvAtHorizonUsd: string;
  readonly firstObservedAt: Date;
  readonly details: Record<string, unknown>;
}

/**
 * Label one pool's outcome at one horizon from its snapshot series, per the
 * signals contract:
 *
 * - Peak = max `quoteLiquidityUsd` over snapshots captured within
 *   `[first, first + horizonHours]`.
 * - At-horizon = the LAST snapshot captured within that window.
 * - SURVIVED iff at-horizon liquidity >= `survivalMinLiquidityFractionBps` of
 *   peak AND at-horizon `estimatedFdvUsd` >= `survivalMinFdvUsd`. Else DIED.
 *
 * Snapshots are ingestion-time forward-only, so the window is additionally
 * capped at `now` — never inferred beyond what has actually been observed.
 * Returns null when the pool lacks the snapshots needed to label honestly
 * (fewer than two priced snapshots in the window, or the at-horizon snapshot
 * is missing liquidity/FDV) — such pools are skipped, never labeled.
 */
export function computeOutcomeLabel(
  snapshots: readonly PoolSnapshotRow[],
  horizonHours: number,
  config: Pick<
    OutcomePassConfig,
    "survivalMinLiquidityFractionBps" | "survivalMinFdvUsd"
  >,
  now: Date
): OutcomeComputation | null {
  if (snapshots.length === 0) return null;
  const first = snapshots[0]!;

  const windowEndMs = Math.min(
    first.capturedAt.getTime() + horizonHours * 60 * 60 * 1000,
    now.getTime()
  );
  const inWindow = snapshots.filter(
    (snapshot) => snapshot.capturedAt.getTime() <= windowEndMs
  );

  const priced = inWindow.filter(
    (snapshot): snapshot is PoolSnapshotRow & { quoteLiquidityUsd: string } =>
      snapshot.quoteLiquidityUsd !== null
  );
  if (priced.length < 2) return null;

  let peak = priced[0]!;
  for (const snapshot of priced) {
    if (Number(snapshot.quoteLiquidityUsd) > Number(peak.quoteLiquidityUsd)) {
      peak = snapshot;
    }
  }

  const atHorizon = inWindow[inWindow.length - 1]!;
  if (atHorizon.quoteLiquidityUsd === null || atHorizon.estimatedFdvUsd === null) {
    return null;
  }

  const peakUsd = parseUsdNumber(peak.quoteLiquidityUsd);
  const atHorizonLiquidityUsd = parseUsdNumber(atHorizon.quoteLiquidityUsd);
  const atHorizonFdvUsd = parseUsdNumber(atHorizon.estimatedFdvUsd);
  if (peakUsd === null || atHorizonLiquidityUsd === null || atHorizonFdvUsd === null) {
    return null;
  }

  const requiredLiquidityUsd =
    (peakUsd * config.survivalMinLiquidityFractionBps) / 10_000;
  const liquidityThresholdMet = atHorizonLiquidityUsd >= requiredLiquidityUsd;
  const fdvThresholdMet = atHorizonFdvUsd >= config.survivalMinFdvUsd;
  const outcome: OutcomeLabel =
    liquidityThresholdMet && fdvThresholdMet ? "SURVIVED" : "DIED";

  return {
    outcome,
    peakQuoteLiquidityUsd: peak.quoteLiquidityUsd,
    quoteLiquidityAtHorizonUsd: atHorizon.quoteLiquidityUsd,
    estimatedFdvAtHorizonUsd: atHorizon.estimatedFdvUsd,
    firstObservedAt: first.capturedAt,
    details: {
      horizonHours,
      firstObservedAt: first.capturedAt.toISOString(),
      windowEndAt: new Date(windowEndMs).toISOString(),
      snapshotCount: snapshots.length,
      snapshotsInWindow: inWindow.length,
      peakCapturedAt: peak.capturedAt.toISOString(),
      peakQuoteLiquidityUsd: peak.quoteLiquidityUsd,
      atHorizonCapturedAt: atHorizon.capturedAt.toISOString(),
      quoteLiquidityAtHorizonUsd: atHorizon.quoteLiquidityUsd,
      estimatedFdvAtHorizonUsd: atHorizon.estimatedFdvUsd,
      requiredLiquidityUsd: requiredLiquidityUsd.toString(),
      survivalMinLiquidityFractionBps: config.survivalMinLiquidityFractionBps,
      survivalMinFdvUsd: config.survivalMinFdvUsd,
      liquidityThresholdMet,
      fdvThresholdMet,
      observation:
        "forward-only from first ingested snapshot; window capped at min(first + horizonHours, now)"
    }
  };
}

/**
 * Label every pool due for a survival outcome at each configured horizon.
 * "Due" is delegated entirely to `getPoolsDueForOutcome` (first snapshot at
 * least `horizonHours` old, no existing outcome row for that horizon) —
 * this pass never relabels; `insertTokenOutcome` is idempotent as a
 * defensive backstop. Pools lacking the snapshots needed to label honestly
 * are skipped, not labeled. Per-pool failures are collected; one bad pool
 * never starves the rest of the batch.
 */
export async function runOutcomePass(
  options: OutcomePassOptions
): Promise<OutcomePassResult> {
  const { db, chainId } = options;
  const config: OutcomePassConfig = { ...DEFAULT_CONFIG, ...options.config };
  const now = options.now ?? (() => new Date());
  // Function call (not property read) so TS doesn't narrow `aborted` across awaits.
  const isAborted = (): boolean => options.signal?.aborted === true;

  let poolsConsidered = 0;
  let labeled = 0;
  let survived = 0;
  let died = 0;
  let skipped = 0;
  const poolErrors: OutcomePoolError[] = [];
  let stopped = false;

  for (const horizonHours of config.horizons) {
    if (stopped) break;
    if (isAborted()) {
      stopped = true;
      break;
    }

    const duePools = await getPoolsDueForOutcome(
      db,
      chainId,
      horizonHours,
      config.batchLimit
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
        const computed = computeOutcomeLabel(
          snapshots,
          horizonHours,
          config,
          now()
        );
        if (computed === null) {
          skipped += 1;
          continue;
        }

        const insert: TokenOutcomeInsert = {
          chainId,
          tokenAddress,
          poolAddress: pool.poolAddress,
          horizonHours,
          outcome: computed.outcome,
          peakQuoteLiquidityUsd: computed.peakQuoteLiquidityUsd,
          quoteLiquidityAtHorizonUsd: computed.quoteLiquidityAtHorizonUsd,
          estimatedFdvAtHorizonUsd: computed.estimatedFdvAtHorizonUsd,
          firstObservedAt: computed.firstObservedAt,
          details: computed.details
        };
        await insertTokenOutcome(db, insert);

        labeled += 1;
        if (computed.outcome === "SURVIVED") survived += 1;
        else died += 1;
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
    survived,
    died,
    skipped,
    poolErrors,
    stopped
  };
}
