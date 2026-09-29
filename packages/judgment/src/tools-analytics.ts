/**
 * Pure numeric helpers backing `tools.ts`'s comparables k-NN, base-rate
 * predicates, and liquidity-trajectory tool. Kept dependency-free (no `Db`,
 * no I/O) so every function here is trivially unit-testable and reusable by
 * both the k-NN distance path and the standalone liquidity tool, which must
 * mirror `getLiquidityTrajectory`'s semantics purely over an in-memory
 * series instead of re-querying `pool_snapshots`.
 */
import type { PoolSnapshotRow } from "@assay/database";

import type { BaseRateFeature, SourcedRow } from "./types.js";

/**
 * Defensive numeric coercion shared by jsonb feature reads, typed
 * numeric-string fields (`quoteLiquidityUsd` off a snapshot row), and
 * slippage-curve notional parsing — every untrusted-shape numeric read in
 * this module funnels through here so "missing/garbage -> null" is one
 * rule, not three near-duplicates. Same discipline as `readFeatureValue` in
 * `apps/worker/src/calibrate.ts`.
 */
export function coerceFiniteNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reads one numeric feature off a `token_performance.entry_features` jsonb payload. */
export function readEntryFeatureValue(
  entryFeatures: unknown,
  key: BaseRateFeature
): number | null {
  if (entryFeatures === null || typeof entryFeatures !== "object") return null;
  return coerceFiniteNumber(
    (entryFeatures as Partial<Record<BaseRateFeature, unknown>>)[key]
  );
}

/** USD-denominated features get log10-scaled before standardization (heavy right tail). */
export const USD_LOG_FEATURES: Partial<Record<BaseRateFeature, true>> = {
  quoteLiquidityUsd: true,
  totalLiquidityUsd: true
};

/** log10 scaling for USD features; non-positive USD values are unusable (`null`), never `log10(<=0)`. */
export function transformFeatureValue(
  feature: BaseRateFeature,
  raw: number | null
): number | null {
  if (raw === null) return null;
  if (USD_LOG_FEATURES[feature] === true) {
    return raw <= 0 ? null : Math.log10(raw);
  }
  return raw;
}

export interface FeatureStats {
  readonly mean: number;
  readonly std: number;
}

/** Population mean/std (not sample-corrected) over the non-null transformed values of one feature. */
export function computeFeatureStats(values: readonly number[]): FeatureStats {
  const n = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance) };
}

/**
 * z-score standardization. `undefined` stats (feature entirely absent from
 * the population) or a null value both collapse to `null` — dropped from
 * the pairwise distance rather than treated as zero. A zero-variance
 * feature (every population member identical) standardizes to `0`: still
 * "matched" (both sides had data), just uninformative for ranking.
 */
export function standardizeValue(
  value: number | null,
  stats: FeatureStats | undefined
): number | null {
  if (value === null || stats === undefined) return null;
  if (stats.std === 0) return 0;
  return (value - stats.mean) / stats.std;
}

export interface DistanceResult {
  readonly distance: number;
  readonly matchedFeatures: number;
}

/**
 * Standardized L2 distance over whatever features both sides have a
 * non-null z-score for. A pair sharing zero features is unrankable —
 * distance `+Infinity` sorts it last rather than crashing the comparison.
 */
export function computeStandardizedDistance(
  candidateZ: readonly (number | null)[],
  rowZ: readonly (number | null)[]
): DistanceResult {
  let sumSquares = 0;
  let matchedFeatures = 0;
  for (let i = 0; i < candidateZ.length; i += 1) {
    const c = candidateZ[i];
    const r = rowZ[i];
    if (c === null || c === undefined || r === null || r === undefined) continue;
    sumSquares += (c - r) ** 2;
    matchedFeatures += 1;
  }
  return {
    distance: matchedFeatures === 0 ? Number.POSITIVE_INFINITY : Math.sqrt(sumSquares),
    matchedFeatures
  };
}

/** Nearest-rank percentile over an ascending-sorted array; 0 for an empty array (mirrors calibrate.ts). */
export function percentile(sortedValues: readonly number[], p: number): number {
  const n = sortedValues.length;
  if (n === 0) return 0;
  const rank = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sortedValues[rank]!;
}

/**
 * Evenly-spaced sample indices over `[0, length)`, always including the
 * first and last element. Returns every index when `length <= maxPoints`.
 */
export function downsampleIndices(length: number, maxPoints: number): number[] {
  if (length <= 0) return [];
  if (maxPoints <= 0 || length <= maxPoints) {
    return Array.from({ length }, (_, i) => i);
  }
  if (maxPoints === 1) return [0];
  const indices: number[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    indices.push(Math.round((i * (length - 1)) / (maxPoints - 1)));
  }
  return [...new Set(indices)];
}

/** JSON-safe deep conversion: `bigint` -> decimal string, `Date` -> ISO string. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafe(v);
    }
    return out;
  }
  return value;
}

export type LiquidityTrajectoryResult =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly peakQuoteLiquidityUsd: string;
      readonly currentQuoteLiquidityUsd: string;
      readonly drawdownFromPeakBps: number;
      readonly minutesAbove80PctOfPeak: number;
      readonly collapsed: boolean;
      readonly peakRef: string;
      readonly currentRef: string;
    };

/**
 * Mirrors `getLiquidityTrajectory` (packages/database/src/repositories.ts)
 * exactly, but purely over an already-asOf-filtered, ascending
 * `bundle.marketSeries` slice instead of re-querying `pool_snapshots` — the
 * as-of-safety boundary is the bundle assembly, not this function. Snapshots
 * with a null `quoteLiquidityUsd` are excluded from peak/drawdown math.
 * `collapsed` = latest liquidity < 20% of peak.
 */
export function computeLiquidityTrajectory(
  marketSeries: readonly SourcedRow<PoolSnapshotRow>[]
): LiquidityTrajectoryResult {
  if (marketSeries.length === 0) {
    return { available: false, reason: "no-snapshots" };
  }
  const valued = marketSeries
    .filter((s) => s.row.quoteLiquidityUsd !== null)
    .map((s) => ({
      sourced: s,
      value: Number(s.row.quoteLiquidityUsd)
    }));
  if (valued.length === 0) {
    return { available: false, reason: "no-liquidity-data" };
  }

  let peak = valued[0]!;
  for (const v of valued) {
    if (v.value > peak.value) peak = v;
  }
  const latest = valued[valued.length - 1]!;
  const drawdownFromPeakBps =
    peak.value <= 0 ? 0 : Math.round(((peak.value - latest.value) / peak.value) * 10_000);

  const threshold = peak.value * 0.8;
  let minutesAbove80PctOfPeak = 0;
  for (let i = 0; i < valued.length - 1; i += 1) {
    const current = valued[i]!;
    const next = valued[i + 1]!;
    if (current.value >= threshold) {
      minutesAbove80PctOfPeak +=
        (next.sourced.row.capturedAt.getTime() - current.sourced.row.capturedAt.getTime()) /
        60_000;
    }
  }

  const collapsed = peak.value > 0 && latest.value < peak.value * 0.2;

  return {
    available: true,
    peakQuoteLiquidityUsd: peak.sourced.row.quoteLiquidityUsd!,
    currentQuoteLiquidityUsd: latest.sourced.row.quoteLiquidityUsd!,
    drawdownFromPeakBps,
    minutesAbove80PctOfPeak,
    collapsed,
    peakRef: `pool_snapshots:${peak.sourced.row.id}`,
    currentRef: `pool_snapshots:${latest.sourced.row.id}`
  };
}

