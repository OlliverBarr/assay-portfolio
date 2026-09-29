/**
 * Read-only died-cohort commonality report: buckets the current-band,
 * fixed-horizon `token_performance` population by entry-feature quartiles
 * and reports the RUGGED rate (classifyRealizedOutcome's "went to zero"
 * label) in each bucket against the population base rate, so the
 * change-protocol in docs/scoring-model.md has a hypothesis-generator
 * instead of guesswork. Sends and mutates nothing, gates nothing: never
 * feeds eligibility, scoring, or alert delivery.
 *
 * Two anti-overfitting guardrails, both load-bearing:
 *
 *  1. Coverage gate (`MIN_COVERAGE_SHARE_BPS`): a feature with too many
 *     nulls in the window is flagged `lowCoverage` and excluded from the
 *     ranked commonalities summary, but still shown so the gap is visible
 *     rather than silently dropped.
 *  2. Out-of-time confirmation: every bucket's lift is computed separately
 *     for the tune and confirm periods (same split as calibrate-sweep.ts's
 *     `periodOf`, imported from there so the binning can never diverge). A
 *     bucket only counts as a `signal` when its lift direction holds in
 *     both periods; a single-period-only association is `unconfirmed`.
 *
 *   bun apps/worker/src/calibrate-died.ts
 *   bun apps/worker/src/calibrate-died.ts -- --horizon=72 --tune-until=2026-07-13
 */
import { loadChainConfigFromEnv } from "@assay/chain";
import {
  createDatabase,
  listTokenOutcomes,
  listTokenPerformance,
  type TokenOutcomeRow,
  type TokenPerformanceRow
} from "@assay/database";
import {
  classifyRealizedOutcome,
  DEFAULT_TAXONOMY_CONFIG,
  type RealizedLabel,
  type TaxonomyConfig
} from "@assay/judgment";

import {
  buildCalibrationReport,
  type CalibrationBucketLabel,
  type CalibrationFeatureKey,
  readFeatureValue,
  splitIntoQuartiles
} from "./calibrate.js";
import { DEFAULT_TUNE_UNTIL, periodOf, type Period } from "./calibrate-sweep.js";
import { assertKnownFlags, readFlag } from "./cli-flags.js";
import { loadDatabaseUrlFromEnv } from "./config.js";
import { wilsonInterval, type JudgeReportRate } from "./judge-report.js";
import { createLogger, type Logger } from "./log.js";

// ---------------------------------------------------------------------------
// Population filter (current band + fixed horizon; mirrors calibrate-sweep.ts's
// filterPopulation, which exports nothing, so the band bounds are replicated
// here rather than imported).
// ---------------------------------------------------------------------------

/**
 * Current FDV band ($10k-$100k, live since 2026-07-13). `token_performance`
 * is append-once and carries the band active at labeling time per row, so
 * older rows (labeled under a prior band) are excluded by value.
 */
const CURRENT_BAND_MIN_FDV_USD = 10_000;
const CURRENT_BAND_MAX_FDV_USD = 100_000;

const DEFAULT_HORIZON_HOURS = 72;

type SkipReason = "wrongHorizon" | "wrongBand";

interface FilterResult {
  readonly kept: TokenPerformanceRow[];
  readonly skipCounts: Readonly<Record<SkipReason, number>>;
}

function filterPopulation(
  rows: readonly TokenPerformanceRow[],
  horizonHours: number
): FilterResult {
  const skipCounts: Record<SkipReason, number> = { wrongHorizon: 0, wrongBand: 0 };
  const kept: TokenPerformanceRow[] = [];
  for (const row of rows) {
    if (row.horizonHours !== horizonHours) {
      skipCounts.wrongHorizon += 1;
      continue;
    }
    if (
      Number(row.bandMinFdvUsd) !== CURRENT_BAND_MIN_FDV_USD ||
      Number(row.bandMaxFdvUsd) !== CURRENT_BAND_MAX_FDV_USD
    ) {
      skipCounts.wrongBand += 1;
      continue;
    }
    kept.push(row);
  }
  return { kept, skipCounts };
}

// ---------------------------------------------------------------------------
// Realized-outcome classification (RUGGED = the died cohort)
// ---------------------------------------------------------------------------

/** Latest quote liquidity below this share of its peak counts as collapsed. Mirrors judge-report.ts's LIQUIDITY_COLLAPSE_SHARE (not exported). */
const LIQUIDITY_COLLAPSE_SHARE = 0.2;

/** Mirrors isLiquidityCollapsed in judge-report.ts (not exported): read off the frozen outcome row rather than a live snapshot series. */
function isLiquidityCollapsed(outcome: TokenOutcomeRow | undefined): boolean {
  if (outcome === undefined) return false;
  const peak = outcome.peakQuoteLiquidityUsd === null ? null : Number(outcome.peakQuoteLiquidityUsd);
  const atHorizon =
    outcome.quoteLiquidityAtHorizonUsd === null ? null : Number(outcome.quoteLiquidityAtHorizonUsd);
  if (peak === null || atHorizon === null || !Number.isFinite(peak) || !Number.isFinite(atHorizon)) {
    return false;
  }
  return peak > 0 && atHorizon < peak * LIQUIDITY_COLLAPSE_SHARE;
}

interface ClassifiedRow {
  readonly row: TokenPerformanceRow;
  readonly label: RealizedLabel;
  readonly period: Period;
}

/** Joins filtered performance rows to their outcome label via classifyRealizedOutcome (RUGGED dominance, reused verbatim) and bins each into a tune/confirm period. */
function classifyPopulation(
  rows: readonly TokenPerformanceRow[],
  outcomeRows: readonly TokenOutcomeRow[],
  tuneUntil: Date,
  taxonomyConfig: TaxonomyConfig
): readonly ClassifiedRow[] {
  const outcomeByKey = new Map<string, TokenOutcomeRow>();
  for (const outcome of outcomeRows) {
    outcomeByKey.set(`${outcome.chainId}|${outcome.poolAddress}|${outcome.horizonHours}`, outcome);
  }
  return rows.map((row) => {
    const outcome = outcomeByKey.get(`${row.chainId}|${row.poolAddress}|${row.horizonHours}`);
    const label = classifyRealizedOutcome(
      {
        maxMultipleBps: row.maxMultipleBps,
        died: outcome?.outcome === "DIED",
        liquidityCollapsed: isLiquidityCollapsed(outcome)
      },
      taxonomyConfig
    );
    return { row, label, period: periodOf(row.enteredAt, tuneUntil) };
  });
}

// ---------------------------------------------------------------------------
// Rate + lift computation
// ---------------------------------------------------------------------------

/** Non-null share below this threshold marks a feature lowCoverage (60%). */
const MIN_COVERAGE_SHARE_BPS = 6_000;

/** Mirrors buildRate in judge-report.ts (not exported): every reported rate carries its Wilson 95% interval. */
function toRate(successes: number, n: number): JudgeReportRate {
  const interval = wilsonInterval(successes, n);
  return {
    n,
    successes,
    rateBps: n === 0 ? 0 : Math.round((successes / n) * 10_000),
    wilsonLowerBps: interval?.lowerBps ?? null,
    wilsonUpperBps: interval?.upperBps ?? null
  };
}

function ruggedRate(rows: readonly ClassifiedRow[]): JudgeReportRate {
  const successes = rows.filter((entry) => entry.label === "RUGGED").length;
  return toRate(successes, rows.length);
}

export type DiedCohortCommonalitySignal = "signal" | "unconfirmed";

export interface DiedCohortPeriodLift {
  readonly rugged: JudgeReportRate;
  /** rugged.rateBps - the population RUGGED rate for that same period, signed. */
  readonly liftBps: number;
}

export interface DiedCohortFeatureBucket {
  readonly bucket: CalibrationBucketLabel;
  /** Whole-window (all periods) RUGGED rate within this bucket. */
  readonly rugged: JudgeReportRate;
  /** rugged.rateBps - the whole-window population RUGGED rate, signed. */
  readonly liftBps: number;
  /** Null when this bucket has no rows in that period. */
  readonly tune: DiedCohortPeriodLift | null;
  readonly confirm: DiedCohortPeriodLift | null;
  /** "signal" only when the lift direction holds in both tune and confirm. */
  readonly commonality: DiedCohortCommonalitySignal;
}

function buildPeriodLift(
  rows: readonly ClassifiedRow[],
  population: JudgeReportRate
): DiedCohortPeriodLift {
  const rugged = ruggedRate(rows);
  return { rugged, liftBps: rugged.rateBps - population.rateBps };
}

function classifyCommonality(
  tune: DiedCohortPeriodLift | null,
  confirm: DiedCohortPeriodLift | null
): DiedCohortCommonalitySignal {
  if (tune === null || confirm === null) return "unconfirmed";
  if (tune.liftBps === 0 || confirm.liftBps === 0) return "unconfirmed";
  const sameDirection = (tune.liftBps > 0) === (confirm.liftBps > 0);
  return sameDirection ? "signal" : "unconfirmed";
}

function buildFeatureBucket(
  bucket: CalibrationBucketLabel,
  rows: readonly ClassifiedRow[],
  populationOverall: JudgeReportRate,
  populationTune: JudgeReportRate,
  populationConfirm: JudgeReportRate
): DiedCohortFeatureBucket {
  const overall = ruggedRate(rows);
  const tuneRows = rows.filter((entry) => entry.period === "tune");
  const confirmRows = rows.filter((entry) => entry.period === "confirm");
  const tune = tuneRows.length > 0 ? buildPeriodLift(tuneRows, populationTune) : null;
  const confirm = confirmRows.length > 0 ? buildPeriodLift(confirmRows, populationConfirm) : null;
  return {
    bucket,
    rugged: overall,
    liftBps: overall.rateBps - populationOverall.rateBps,
    tune,
    confirm,
    commonality: classifyCommonality(tune, confirm)
  };
}

export interface DiedCohortFeatureReport {
  readonly feature: CalibrationFeatureKey;
  /** Non-null share of the window, bps. */
  readonly coverageBps: number;
  /** True when coverageBps < 60%: excluded from the ranked commonalities summary, still shown here. */
  readonly lowCoverage: boolean;
  readonly buckets: readonly DiedCohortFeatureBucket[];
}

function buildFeatureReport(
  feature: CalibrationFeatureKey,
  rows: readonly ClassifiedRow[],
  populationOverall: JudgeReportRate,
  populationTune: JudgeReportRate,
  populationConfirm: JudgeReportRate
): DiedCohortFeatureReport {
  const withValue: { entry: ClassifiedRow; value: number }[] = [];
  const nullRows: ClassifiedRow[] = [];
  for (const entry of rows) {
    const value = readFeatureValue(entry.row.entryFeatures, feature);
    if (value === null) nullRows.push(entry);
    else withValue.push({ entry, value });
  }
  withValue.sort((a, b) => a.value - b.value);
  const quartiles = splitIntoQuartiles(withValue.map((item) => item.entry));

  const coverageBps =
    rows.length === 0 ? 0 : Math.round((withValue.length / rows.length) * 10_000);
  const lowCoverage = coverageBps < MIN_COVERAGE_SHARE_BPS;

  const buckets: DiedCohortFeatureBucket[] = [];
  if (nullRows.length > 0) {
    buckets.push(
      buildFeatureBucket("null", nullRows, populationOverall, populationTune, populationConfirm)
    );
  }
  const labels: CalibrationBucketLabel[] = ["q1", "q2", "q3", "q4"];
  for (const [index, label] of labels.entries()) {
    const bucketRows = quartiles[index]!;
    if (bucketRows.length > 0) {
      buckets.push(
        buildFeatureBucket(label, bucketRows, populationOverall, populationTune, populationConfirm)
      );
    }
  }

  return { feature, coverageBps, lowCoverage, buckets };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface DiedCohortCommonality {
  readonly feature: CalibrationFeatureKey;
  readonly bucket: CalibrationBucketLabel;
  readonly liftBps: number;
  readonly rugged: JudgeReportRate;
}

export interface DiedCohortReport {
  readonly horizonHours: number;
  /** Rows kept after the current-band + horizon filter, across all periods. */
  readonly windowN: number;
  readonly skipCounts: Readonly<Record<SkipReason, number>>;
  readonly populationRugged: JudgeReportRate;
  readonly populationRuggedTune: JudgeReportRate;
  readonly populationRuggedConfirm: JudgeReportRate;
  /** Every feature in CALIBRATION_CONFIG.featureKeys, including lowCoverage ones. */
  readonly features: readonly DiedCohortFeatureReport[];
  /** Coverage-gated, signal-only, ranked by |liftBps| descending. */
  readonly commonalities: readonly DiedCohortCommonality[];
  readonly disclaimer: string;
}

const DISCLAIMER =
  "Hypothesis-generator feeding the docs/scoring-model.md change protocol, advisory only; low-coverage features are not yet trustworthy rug signals.";

export interface DiedCohortReportOptions {
  readonly horizonHours?: number;
  readonly tuneUntil?: Date;
  readonly taxonomyConfig?: TaxonomyConfig;
}

/**
 * Pure report builder: current-band, fixed-horizon population classified by
 * classifyRealizedOutcome, bucketed per calibrate.ts's feature list, with a
 * RUGGED-rate lift against the population base rate, gated by coverage and
 * confirmed out-of-time. Never opens a database connection.
 */
export function buildDiedCohortReport(
  perfRows: readonly TokenPerformanceRow[],
  outcomeRows: readonly TokenOutcomeRow[],
  options: DiedCohortReportOptions = {}
): DiedCohortReport {
  const horizonHours = options.horizonHours ?? DEFAULT_HORIZON_HOURS;
  const tuneUntil = options.tuneUntil ?? new Date(DEFAULT_TUNE_UNTIL);
  const taxonomyConfig = options.taxonomyConfig ?? DEFAULT_TAXONOMY_CONFIG;

  const { kept, skipCounts } = filterPopulation(perfRows, horizonHours);
  const classified = classifyPopulation(kept, outcomeRows, tuneUntil, taxonomyConfig);

  const populationOverall = ruggedRate(classified);
  const populationTune = ruggedRate(classified.filter((entry) => entry.period === "tune"));
  const populationConfirm = ruggedRate(classified.filter((entry) => entry.period === "confirm"));

  // CALIBRATION_CONFIG.featureKeys itself is not exported from calibrate.ts,
  // but buildCalibrationReport emits one CalibrationFeatureReport per key
  // per horizon, so filtering its output to one horizon recovers the exact
  // runtime list in declared order instead of a second, hand-copied array.
  const featureKeys = buildCalibrationReport(kept)
    .features.filter((entry) => entry.horizonHours === horizonHours)
    .map((entry) => entry.feature);
  const features = featureKeys.map((feature) =>
    buildFeatureReport(feature, classified, populationOverall, populationTune, populationConfirm)
  );

  const commonalities: DiedCohortCommonality[] = [];
  for (const featureReport of features) {
    if (featureReport.lowCoverage) continue;
    for (const bucket of featureReport.buckets) {
      if (bucket.commonality !== "signal") continue;
      commonalities.push({
        feature: featureReport.feature,
        bucket: bucket.bucket,
        liftBps: bucket.liftBps,
        rugged: bucket.rugged
      });
    }
  }
  commonalities.sort((a, b) => Math.abs(b.liftBps) - Math.abs(a.liftBps));

  return {
    horizonHours,
    windowN: classified.length,
    skipCounts,
    populationRugged: populationOverall,
    populationRuggedTune: populationTune,
    populationRuggedConfirm: populationConfirm,
    features,
    commonalities,
    disclaimer: DISCLAIMER
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logReport(logger: Logger, report: DiedCohortReport): void {
  logger.info("calibrate_died.disclaimer", { disclaimer: report.disclaimer });
  logger.info("calibrate_died.summary", {
    horizonHours: report.horizonHours,
    windowN: report.windowN,
    skipCounts: report.skipCounts,
    populationRugged: report.populationRugged,
    populationRuggedTune: report.populationRuggedTune,
    populationRuggedConfirm: report.populationRuggedConfirm
  });
  for (const featureReport of report.features) {
    for (const bucket of featureReport.buckets) {
      logger.info("calibrate_died.bucket", {
        feature: featureReport.feature,
        coverageBps: featureReport.coverageBps,
        lowCoverage: featureReport.lowCoverage,
        ...bucket
      });
    }
  }
  for (const commonality of report.commonalities) {
    logger.info("calibrate_died.commonality", { ...commonality });
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly help: boolean;
  readonly horizonHours: number;
  readonly tuneUntil: Date;
}

/** Parses calibrate:died's CLI flags. Never touches the environment or a database. */
function parseCliArgs(argv: readonly string[]): CliArgs {
  assertKnownFlags(argv, ["horizon", "tune-until"], ["help"]);

  const help = argv.includes("--help");

  const horizonRaw = readFlag(argv, "horizon");
  const horizonHours = horizonRaw === undefined ? DEFAULT_HORIZON_HOURS : Number(horizonRaw);
  if (!Number.isFinite(horizonHours) || horizonHours <= 0) {
    throw new Error(`--horizon must be a positive number, got "${horizonRaw}"`);
  }

  const tuneUntilRaw = readFlag(argv, "tune-until");
  const tuneUntil = tuneUntilRaw === undefined ? new Date(DEFAULT_TUNE_UNTIL) : new Date(tuneUntilRaw);
  if (Number.isNaN(tuneUntil.getTime())) {
    throw new Error(`--tune-until must be an ISO date, got "${tuneUntilRaw}"`);
  }

  return { help, horizonHours, tuneUntil };
}

async function main(): Promise<void> {
  const logger = createLogger();
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    logger.info("calibrate_died.usage", {
      usage: "bun apps/worker/src/calibrate-died.ts [--horizon=72] [--tune-until=2026-07-13]"
    });
    return;
  }

  const env = process.env;
  const chainConfig = loadChainConfigFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);

  const handle = createDatabase(databaseUrl);
  try {
    await handle.applyMigrations();
    const [perfRows, outcomeRows] = await Promise.all([
      listTokenPerformance(handle.db, chainConfig.chainId),
      listTokenOutcomes(handle.db, chainConfig.chainId)
    ]);
    const report = buildDiedCohortReport(perfRows, outcomeRows, {
      horizonHours: args.horizonHours,
      tuneUntil: args.tuneUntil
    });
    logReport(logger, report);
  } finally {
    await handle.close();
  }
}

// Run only when executed directly, see feedback.ts; importing the pure
// report builder above must never open a database connection.
if (import.meta.main) {
  main().catch((error: unknown) => {
    createLogger().error("calibrate_died.crashed", { error });
    process.exit(1);
  });
}
