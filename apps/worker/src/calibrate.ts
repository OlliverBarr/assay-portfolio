/**
 * Read-only calibration report: buckets the full `token_performance`
 * population (every band-crossing pool, not just alerted/eligible ones) by
 * entry-time feature quartiles and reports realized `max_multiple_bps` /
 * `max_drawdown_bps` per bucket, so alert thresholds can be tuned against
 * observed reality instead of guesswork.
 *
 *   bun apps/worker/src/calibrate.ts
 */
import { loadChainConfigFromEnv } from "@assay/chain";
import {
  createDatabase,
  listTokenPerformance,
  type TokenPerformanceRow
} from "@assay/database";

import { loadDatabaseUrlFromEnv } from "./config.js";
import { createLogger, type Logger } from "./log.js";

/**
 * Numeric entry-time features bucketed for calibration, plus the "is this a
 * hit" thresholds. The feature-key list is duplicated in
 * packages/database/src/analytics.ts (ANALYTICS_FEATURE_KEYS) — packages
 * never import from apps, so keep the two lists in sync by hand.
 */
const CALIBRATION_CONFIG = {
  featureKeys: [
    "quoteLiquidityUsd",
    "totalLiquidityUsd",
    "ageMinutesAtEntry",
    "uniqueBuyers1h",
    "buySizeGiniBps",
    "buySizeEntropyBps",
    "repeatedSizeBuyPctBps",
    "floatBps",
    "supplyInPoolBps",
    "adjustedTop10PctBps",
    "deployerPctBps",
    "adjustedHolderCount",
    "effectiveSellLossBps"
  ] as const,
  multipleThresholdsBps: {
    x2: 20_000,
    x5: 50_000
  }
} as const;

export type CalibrationFeatureKey = (typeof CALIBRATION_CONFIG.featureKeys)[number];

export interface CalibrationHeadline {
  readonly horizonHours: number;
  readonly count: number;
  readonly minMultipleBps: number;
  readonly medianMultipleBps: number;
  readonly p75MultipleBps: number;
  readonly maxMultipleBps: number;
  readonly shareAtLeast2xBps: number;
  readonly shareAtLeast5xBps: number;
  readonly medianDrawdownBps: number;
}

export type CalibrationBucketLabel = "null" | "q1" | "q2" | "q3" | "q4";

export interface CalibrationBucket {
  readonly bucket: CalibrationBucketLabel;
  readonly count: number;
  readonly medianMultipleBps: number;
  readonly p75MultipleBps: number;
  readonly shareAtLeast2xBps: number;
  readonly shareAtLeast5xBps: number;
  readonly medianDrawdownBps: number;
}

export interface CalibrationFeatureReport {
  readonly feature: CalibrationFeatureKey;
  readonly horizonHours: number;
  readonly buckets: readonly CalibrationBucket[];
}

export interface CalibrationReport {
  readonly headline: readonly CalibrationHeadline[];
  readonly features: readonly CalibrationFeatureReport[];
}

/**
 * Reads one numeric feature off a row's `entryFeatures` jsonb payload.
 * Coerces both plain-number bps fields and USD decimal-string fields
 * (`quoteLiquidityUsd`, `totalLiquidityUsd`) through `Number()`, same
 * threshold-gating convention as `parseUsdNumber` elsewhere in the pass —
 * never used for money movement, only for quartile ranking. Missing keys,
 * nulls, and non-finite values all collapse to null (the "null" bucket).
 */
export function readFeatureValue(
  entryFeatures: unknown,
  key: CalibrationFeatureKey
): number | null {
  if (entryFeatures === null || typeof entryFeatures !== "object") return null;
  const raw = (entryFeatures as Partial<Record<CalibrationFeatureKey, unknown>>)[key];
  if (raw === null || raw === undefined) return null;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Nearest-rank percentile over an ascending-sorted array; 0 for an empty array. */
function percentile(sortedValues: readonly number[], p: number): number {
  const n = sortedValues.length;
  if (n === 0) return 0;
  const rank = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sortedValues[rank]!;
}

function shareAtLeastBps(sortedValues: readonly number[], thresholdBps: number): number {
  if (sortedValues.length === 0) return 0;
  const hits = sortedValues.filter((value) => value >= thresholdBps).length;
  return Math.round((hits / sortedValues.length) * 10_000);
}

interface MultipleStats {
  readonly sortedMultiples: readonly number[];
  readonly medianMultipleBps: number;
  readonly p75MultipleBps: number;
  readonly shareAtLeast2xBps: number;
  readonly shareAtLeast5xBps: number;
  readonly medianDrawdownBps: number;
}

/** Shared multiple/drawdown stats for one group of rows (a horizon slice or a bucket). */
function summarizeMultiples(rows: readonly TokenPerformanceRow[]): MultipleStats {
  const sortedMultiples = rows.map((row) => row.maxMultipleBps).sort((a, b) => a - b);
  const sortedDrawdowns = rows.map((row) => row.maxDrawdownBps).sort((a, b) => a - b);
  return {
    sortedMultiples,
    medianMultipleBps: percentile(sortedMultiples, 50),
    p75MultipleBps: percentile(sortedMultiples, 75),
    shareAtLeast2xBps: shareAtLeastBps(
      sortedMultiples,
      CALIBRATION_CONFIG.multipleThresholdsBps.x2
    ),
    shareAtLeast5xBps: shareAtLeastBps(
      sortedMultiples,
      CALIBRATION_CONFIG.multipleThresholdsBps.x5
    ),
    medianDrawdownBps: percentile(sortedDrawdowns, 50)
  };
}

function buildHeadline(
  horizonHours: number,
  rows: readonly TokenPerformanceRow[]
): CalibrationHeadline {
  const stats = summarizeMultiples(rows);
  return {
    horizonHours,
    count: rows.length,
    minMultipleBps: stats.sortedMultiples[0] ?? 0,
    maxMultipleBps: stats.sortedMultiples[stats.sortedMultiples.length - 1] ?? 0,
    medianMultipleBps: stats.medianMultipleBps,
    p75MultipleBps: stats.p75MultipleBps,
    shareAtLeast2xBps: stats.shareAtLeast2xBps,
    shareAtLeast5xBps: stats.shareAtLeast5xBps,
    medianDrawdownBps: stats.medianDrawdownBps
  };
}

/** Splits rank-sorted entries into 4 contiguous, near-equal-size quartile groups. */
export function splitIntoQuartiles<T>(sorted: readonly T[]): T[][] {
  const buckets: T[][] = [[], [], [], []];
  const n = sorted.length;
  for (let i = 0; i < n; i += 1) {
    const bucketIndex = Math.min(3, Math.floor((i * 4) / n));
    buckets[bucketIndex]!.push(sorted[i]!);
  }
  return buckets;
}

function buildBucket(
  bucket: CalibrationBucketLabel,
  rows: readonly TokenPerformanceRow[]
): CalibrationBucket {
  const stats = summarizeMultiples(rows);
  return {
    bucket,
    count: rows.length,
    medianMultipleBps: stats.medianMultipleBps,
    p75MultipleBps: stats.p75MultipleBps,
    shareAtLeast2xBps: stats.shareAtLeast2xBps,
    shareAtLeast5xBps: stats.shareAtLeast5xBps,
    medianDrawdownBps: stats.medianDrawdownBps
  };
}

function buildFeatureReport(
  feature: CalibrationFeatureKey,
  horizonHours: number,
  rows: readonly TokenPerformanceRow[]
): CalibrationFeatureReport {
  const withValue: { row: TokenPerformanceRow; value: number }[] = [];
  const nullRows: TokenPerformanceRow[] = [];
  for (const row of rows) {
    const value = readFeatureValue(row.entryFeatures, feature);
    if (value === null) nullRows.push(row);
    else withValue.push({ row, value });
  }
  withValue.sort((a, b) => a.value - b.value);
  const quartiles = splitIntoQuartiles(withValue.map((entry) => entry.row));

  const buckets: CalibrationBucket[] = [];
  if (nullRows.length > 0) buckets.push(buildBucket("null", nullRows));
  const labels: CalibrationBucketLabel[] = ["q1", "q2", "q3", "q4"];
  for (const [index, label] of labels.entries()) {
    const bucketRows = quartiles[index]!;
    if (bucketRows.length > 0) buckets.push(buildBucket(label, bucketRows));
  }

  return { feature, horizonHours, buckets };
}

/**
 * Pure report builder: headline multiple distribution per horizon, plus
 * per-feature quartile buckets (nulls as their own bucket) with realized
 * multiple/drawdown stats per bucket, split per horizon so windows of
 * different lengths never get mixed into the same distribution.
 */
export function buildCalibrationReport(
  rows: readonly TokenPerformanceRow[]
): CalibrationReport {
  const byHorizon = new Map<number, TokenPerformanceRow[]>();
  for (const row of rows) {
    const group = byHorizon.get(row.horizonHours);
    if (group === undefined) byHorizon.set(row.horizonHours, [row]);
    else group.push(row);
  }
  const horizons = [...byHorizon.keys()].sort((a, b) => a - b);

  const headline = horizons.map((horizonHours) =>
    buildHeadline(horizonHours, byHorizon.get(horizonHours)!)
  );

  const features: CalibrationFeatureReport[] = [];
  for (const horizonHours of horizons) {
    const horizonRows = byHorizon.get(horizonHours)!;
    for (const feature of CALIBRATION_CONFIG.featureKeys) {
      features.push(buildFeatureReport(feature, horizonHours, horizonRows));
    }
  }

  return { headline, features };
}

function logHeadline(logger: Logger, headline: readonly CalibrationHeadline[]): void {
  for (const row of headline) {
    logger.info("calibrate.headline", { ...row });
  }
}

function logFeatures(logger: Logger, features: readonly CalibrationFeatureReport[]): void {
  for (const report of features) {
    for (const bucket of report.buckets) {
      logger.info("calibrate.bucket", {
        feature: report.feature,
        horizonHours: report.horizonHours,
        ...bucket
      });
    }
  }
}

async function main(): Promise<void> {
  const logger = createLogger();
  const env = process.env;
  const config = loadChainConfigFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);

  const handle = createDatabase(databaseUrl);
  try {
    await handle.applyMigrations();
    const rows = await listTokenPerformance(handle.db, config.chainId);
    const report = buildCalibrationReport(rows);

    logHeadline(logger, report.headline);
    logFeatures(logger, report.features);

    logger.info("calibrate.summary", {
      totalRows: rows.length,
      horizons: report.headline.map((row) => row.horizonHours)
    });
  } finally {
    await handle.close();
  }
}

// Run only when executed directly — see feedback.ts; importing the pure
// report builders must never open a database connection.
if (import.meta.main) {
  main().catch((error: unknown) => {
    createLogger().error("calibrate.crashed", { error });
    process.exit(1);
  });
}
