/**
 * Read-only, band-filtered calibrate + counterfactual sweep: the Track-A
 * tool from `local://score-reweight-calibration-plan.md` Step 1. Sends and
 * mutates nothing — only SELECTs `token_performance` / `token_outcomes` and
 * runs the real `@assay/scoring` functions over replayed feature vectors.
 *
 * Does two things `bun run calibrate` does not:
 *
 *  1. Feature-lift report (`buildCalibrationReport`, reused from
 *     `calibrate.ts`) on a band-filtered, single-horizon, out-of-time TUNE
 *     slice — `calibrate.ts` mixes every band ever recorded (calibrate.ts:274
 *     loads all rows; `buildCalibrationReport` only splits by horizon).
 *  2. Counterfactual re-weight sweep: for each row, replay
 *     `parseEntryFeatures` -> `replayCandidateFeatures` ->
 *     `evaluateEligibility` -> `scoreOpportunity` -> `classifyAlertLevel`
 *     exactly as `attributeGate` (winners-retro-pass.ts:127-181) does, then
 *     recompute the total score under an arbitrary re-weighting `W` of the
 *     reconstructable budget of the four score components and compares
 *     "caught" (would have cleared the delivery floor) between the live
 *     weights `R` and `W`, on a pre-registered tune/confirm out-of-time
 *     split. `caught` measures would-clear-floor recall over the labeled
 *     token_performance winner-study set, not delivery volume; use
 *     `bun run floor:volume` for volume questions.
 *
 * No `score.ts` change — this re-weights component *outputs*, it does not
 * touch the live scorer.
 *
 *   bun run calibrate-sweep
 *   bun run calibrate-sweep -- --tune-until=2026-07-13 --winner-bps=20000
 *   bun run calibrate-sweep -- --weights=liquidityDepth:30,buyerBreadth:23,buyFlow:20,lowCapTilt:20
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
  classifyAlertLevel,
  evaluateEligibility,
  scoreOpportunity,
  type AlertLevel,
  type AlertThresholds,
  type EligibilityConfig,
  type ScoreComponents
} from "@assay/scoring";

import { buildCalibrationReport, type CalibrationReport } from "./calibrate.js";
import { assertKnownFlags, readFlag } from "./cli-flags.js";
import {
  alertThresholdsFromTuning,
  eligibilityConfigFromTuning,
  loadDatabaseUrlFromEnv,
  loadWorkerTuningFromEnv,
  WorkerConfigError
} from "./config.js";
import { createLogger, type Logger } from "./log.js";
import { parseEntryFeatures, replayCandidateFeatures } from "./winners-retro.js";

// ---------------------------------------------------------------------------
// Re-weight model (plan "Re-weight model" + Step 1)
// ---------------------------------------------------------------------------

/**
 * Reconstructable maximum per component in replay (`R_i`). All four
 * components of the 2026-07-20 model read covered entry features
 * (quote/total liquidity, buyers 1h/20m, 20m counts+volumes, entry FDV), so
 * every component is reweightable. The single null-in-replay input is the
 * sell-slippage curve (`sellSlippageCurve: null` in
 * `replayCandidateFeatures`), so `liquidityDepth`'s reconstructable max is
 * 28 of its nominal 35 (quote depth 20 + quote/FDV ratio 8); the 7-point
 * slippage sub-score is held at 0, never moved on evidence that does not
 * exist.
 */
const RECONSTRUCTABLE_MAX = {
  liquidityDepth: 28,
  buyerBreadth: 25,
  buyFlow: 20,
  lowCapTilt: 20
} as const;

type ReweightableComponent = keyof typeof RECONSTRUCTABLE_MAX;

const REWEIGHTABLE_COMPONENTS = Object.keys(
  RECONSTRUCTABLE_MAX
) as readonly ReweightableComponent[];

/** `ΣR` — the zero-sum sweep budget every `--weights` value must sum to. */
const TOTAL_RECONSTRUCTABLE_BUDGET = REWEIGHTABLE_COMPONENTS.reduce(
  (sum, key) => sum + RECONSTRUCTABLE_MAX[key],
  0
);

type ComponentWeights = Record<ReweightableComponent, number>;

/**
 * `score'(W) = round(sum n_i * W_i)`, `n_i = r_i / R_i` read straight off
 * the replayed `ScoreComponents`. No component is held constant in the
 * 2026-07-20 model (the old `walletQuality` heldPoints special-case is
 * gone). At `W = R` this reproduces the live total exactly (the sweep
 * tool's fidelity check) since `n_i * R_i == r_i`.
 */
function counterfactualScore(components: ScoreComponents, weights: ComponentWeights): number {
  let weighted = 0;
  for (const key of REWEIGHTABLE_COMPONENTS) {
    const normalized = components[key] / RECONSTRUCTABLE_MAX[key];
    weighted += normalized * weights[key];
  }
  return Math.round(weighted);
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly horizonHours: number;
  readonly winnerBps: number;
  readonly secondaryWinnerBps: number;
  readonly floor: number;
  readonly secondaryFloor: number;
  readonly tuneUntil: Date;
  readonly weights: ComponentWeights;
}

const DEFAULT_HORIZON_HOURS = 72;
const DEFAULT_WINNER_BPS = 20_000;
/** Secondary (5x) winner class — always reported, never CLI-tunable. */
const SECONDARY_WINNER_BPS = 50_000;
const DEFAULT_FLOOR = 80;
/** Always additionally reported alongside `--floor`, per the plan. */
const SECONDARY_FLOOR = 65;
/** Shared out-of-time boundary: also imported by calibrate-died.ts so both reports bin identically. */
export const DEFAULT_TUNE_UNTIL = "2026-07-13";
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function parsePositiveNumberFlag(
  argv: readonly string[],
  flag: string,
  fallback: number
): number {
  const raw = readFlag(argv, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new WorkerConfigError(`--${flag}`, `"${raw}" must be a positive number`);
  }
  return value;
}

function isReweightableComponent(key: string): key is ReweightableComponent {
  return (REWEIGHTABLE_COMPONENTS as readonly string[]).includes(key);
}

/** `liquidityDepth:28,buyerBreadth:25,...` — every reconstructable component required, summing to `ΣR`. */
function parseWeights(raw: string | undefined): ComponentWeights {
  if (raw === undefined) return { ...RECONSTRUCTABLE_MAX };

  const weights: Partial<Record<ReweightableComponent, number>> = {};
  for (const pair of raw.split(",")) {
    const [key, valueRaw] = pair.split(":");
    if (key === undefined || valueRaw === undefined || !isReweightableComponent(key)) {
      throw new WorkerConfigError(
        "--weights",
        `"${pair}" — expected "<component>:<points>" with component in {${REWEIGHTABLE_COMPONENTS.join(", ")}}`
      );
    }
    const value = Number(valueRaw);
    if (!Number.isFinite(value) || value < 0) {
      throw new WorkerConfigError("--weights", `"${pair}" must be a non-negative number`);
    }
    weights[key] = value;
  }
  for (const key of REWEIGHTABLE_COMPONENTS) {
    if (weights[key] === undefined) {
      throw new WorkerConfigError("--weights", `missing component "${key}"`);
    }
  }
  const sum = REWEIGHTABLE_COMPONENTS.reduce((total, key) => total + weights[key]!, 0);
  if (sum !== TOTAL_RECONSTRUCTABLE_BUDGET) {
    throw new WorkerConfigError(
      "--weights",
      `weights sum to ${sum}, must equal ΣR=${TOTAL_RECONSTRUCTABLE_BUDGET}`
    );
  }
  return weights as ComponentWeights;
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  assertKnownFlags(argv, ["horizon", "winner-bps", "floor", "tune-until", "weights"], []);

  const horizonHours = parsePositiveNumberFlag(argv, "horizon", DEFAULT_HORIZON_HOURS);
  const winnerBps = parsePositiveNumberFlag(argv, "winner-bps", DEFAULT_WINNER_BPS);
  const floor = parsePositiveNumberFlag(argv, "floor", DEFAULT_FLOOR);

  const tuneUntilRaw = readFlag(argv, "tune-until") ?? DEFAULT_TUNE_UNTIL;
  const tuneUntil = new Date(`${tuneUntilRaw}T00:00:00.000Z`);
  if (Number.isNaN(tuneUntil.getTime())) {
    throw new WorkerConfigError("--tune-until", `"${tuneUntilRaw}" is not a valid date`);
  }

  const weights = parseWeights(readFlag(argv, "weights"));

  return {
    horizonHours,
    winnerBps,
    secondaryWinnerBps: SECONDARY_WINNER_BPS,
    floor,
    secondaryFloor: SECONDARY_FLOOR,
    tuneUntil,
    weights
  };
}

// ---------------------------------------------------------------------------
// Population filter (plan "Data readiness": current band + horizon + parseable)
// ---------------------------------------------------------------------------

/**
 * Current FDV band ($10k-$100k, live since 2026-07-13 — see
 * `DEFAULT_ELIGIBILITY_CONFIG` in `@assay/scoring/types.ts`). `token_performance`
 * is append-once and carries the band active AT LABELING TIME per row
 * (`bandMinFdvUsd`/`bandMaxFdvUsd`), so older rows (labeled under the prior
 * $50k-$200k band) must be excluded by VALUE, not derived from current env
 * tuning (which only describes the band for *new* labels).
 */
const CURRENT_BAND_MIN_FDV_USD = 10_000;
const CURRENT_BAND_MAX_FDV_USD = 100_000;

type SkipReason = "wrongHorizon" | "wrongBand" | "unparseable";

interface FilterResult {
  readonly kept: TokenPerformanceRow[];
  readonly skipCounts: Record<SkipReason, number>;
}

/** First-failing-stage filter (mirrors `attributeCoverageTier`'s convention): one counted reason per row, never silent. */
function filterPopulation(rows: readonly TokenPerformanceRow[], horizonHours: number): FilterResult {
  const skipCounts: Record<SkipReason, number> = {
    wrongHorizon: 0,
    wrongBand: 0,
    unparseable: 0
  };
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
    if (parseEntryFeatures(row.entryFeatures) === null) {
      skipCounts.unparseable += 1;
      continue;
    }
    kept.push(row);
  }
  return { kept, skipCounts };
}

// ---------------------------------------------------------------------------
// Out-of-time period binning
// ---------------------------------------------------------------------------

export type Period = "tune" | "confirm" | "neither";

/** tune = [tuneUntil-7d, tuneUntil); confirm = [tuneUntil, tuneUntil+7d). */
export function periodOf(enteredAt: Date, tuneUntil: Date): Period {
  const tuneStartMs = tuneUntil.getTime() - WEEK_MS;
  const confirmEndMs = tuneUntil.getTime() + WEEK_MS;
  const at = enteredAt.getTime();
  if (at >= tuneStartMs && at < tuneUntil.getTime()) return "tune";
  if (at >= tuneUntil.getTime() && at < confirmEndMs) return "confirm";
  return "neither";
}

// ---------------------------------------------------------------------------
// Row replay: eligibility + level are W-independent, cached once per row.
// Only the counterfactual score gate is re-evaluated per weight vector.
// ---------------------------------------------------------------------------

interface EvaluatedRow {
  readonly row: TokenPerformanceRow;
  readonly period: Period;
  readonly eligible: boolean;
  readonly level: AlertLevel;
  readonly components: ScoreComponents;
  readonly liveScore: number;
}

function evaluateRow(
  row: TokenPerformanceRow,
  eligibilityConfig: EligibilityConfig,
  alertThresholds: AlertThresholds,
  tuneUntil: Date
): EvaluatedRow {
  // Guaranteed non-null: `filterPopulation` already dropped unparseable rows.
  const entry = parseEntryFeatures(row.entryFeatures)!;
  const features = replayCandidateFeatures(row, entry);
  const eligibility = evaluateEligibility(features, eligibilityConfig);
  const score = scoreOpportunity(features, eligibility);
  const level = classifyAlertLevel(features, eligibility, score, alertThresholds);
  return {
    row,
    period: periodOf(row.enteredAt, tuneUntil),
    eligible: eligibility.eligible,
    level,
    components: score.components,
    liveScore: score.score
  };
}

/**
 * `eligible ∧ level qualifies (non-GRAY) ∧ score'(weights) ≥ effectiveFloor`.
 * RED carries an additional delivery floor (max with the global one) —
 * mirrors the private `effectiveFloor` in winners-retro-pass.ts, so "caught"
 * replays what delivery would actually have done.
 */
function isCaught(
  evaluated: EvaluatedRow,
  weights: ComponentWeights,
  floor: number,
  floorRed: number
): boolean {
  if (!evaluated.eligible || evaluated.level === "GRAY") return false;
  const scorePrime = counterfactualScore(evaluated.components, weights);
  const floorForRow = evaluated.level === "RED" ? Math.max(floor, floorRed) : floor;
  return scorePrime >= floorForRow;
}

// ---------------------------------------------------------------------------
// Period comparison report
// ---------------------------------------------------------------------------

interface PeriodComparison {
  readonly period: Period;
  readonly floor: number;
  readonly n: number;
  readonly winnerN: number;
  readonly winnerN5x: number;
  readonly caughtBaseline: number;
  readonly caughtW: number;
  readonly deltaCaught: number;
  readonly winnersCaughtBaseline: number;
  readonly winnersCaughtW: number;
  readonly deltaWinnersCaught: number;
  readonly winnersCaughtBaseline5x: number;
  readonly winnersCaughtW5x: number;
  readonly deltaWinnersCaught5x: number;
  readonly admittedLosers: number;
  readonly admittedLosersDied: number;
  readonly admittedLosersSurvived: number;
  readonly admittedLosersUnknownOutcome: number;
  readonly precisionBaseline: number;
  readonly recallBaseline: number;
  readonly precisionW: number;
  readonly recallW: number;
}

function buildPeriodComparison(
  period: Period,
  rows: readonly EvaluatedRow[],
  weights: ComponentWeights,
  floor: number,
  floorRed: number,
  winnerBps: number,
  secondaryWinnerBps: number,
  outcomeByKey: ReadonlyMap<string, TokenOutcomeRow>
): PeriodComparison {
  let winnerN = 0;
  let winnerN5x = 0;
  let caughtBaseline = 0;
  let caughtW = 0;
  let winnersCaughtBaseline = 0;
  let winnersCaughtW = 0;
  let winnersCaughtBaseline5x = 0;
  let winnersCaughtW5x = 0;
  let admittedLosers = 0;
  let admittedLosersDied = 0;
  let admittedLosersSurvived = 0;
  let admittedLosersUnknownOutcome = 0;

  for (const evaluated of rows) {
    const isWinner = evaluated.row.maxMultipleBps >= winnerBps;
    const isWinner5x = evaluated.row.maxMultipleBps >= secondaryWinnerBps;
    if (isWinner) winnerN += 1;
    if (isWinner5x) winnerN5x += 1;

    const baselineCaught = isCaught(evaluated, RECONSTRUCTABLE_MAX, floor, floorRed);
    const wCaught = isCaught(evaluated, weights, floor, floorRed);

    if (baselineCaught) {
      caughtBaseline += 1;
      if (isWinner) winnersCaughtBaseline += 1;
      if (isWinner5x) winnersCaughtBaseline5x += 1;
    }
    if (wCaught) {
      caughtW += 1;
      if (isWinner) winnersCaughtW += 1;
      if (isWinner5x) winnersCaughtW5x += 1;
    }
    if (wCaught && !baselineCaught && !isWinner) {
      admittedLosers += 1;
      // Composite key mirrors `token_outcomes`' unique index
      // (chainId, poolAddress, horizonHours) — must stay in lockstep with
      // the identical key built when `outcomeByKey` is populated in `main`.
      const key = `${evaluated.row.chainId}|${evaluated.row.poolAddress}|${evaluated.row.horizonHours}`;
      const outcome = outcomeByKey.get(key);
      if (outcome === undefined) admittedLosersUnknownOutcome += 1;
      else if (outcome.outcome === "DIED") admittedLosersDied += 1;
      else admittedLosersSurvived += 1;
    }
  }

  return {
    period,
    floor,
    n: rows.length,
    winnerN,
    winnerN5x,
    caughtBaseline,
    caughtW,
    deltaCaught: caughtW - caughtBaseline,
    winnersCaughtBaseline,
    winnersCaughtW,
    deltaWinnersCaught: winnersCaughtW - winnersCaughtBaseline,
    winnersCaughtBaseline5x,
    winnersCaughtW5x,
    deltaWinnersCaught5x: winnersCaughtW5x - winnersCaughtBaseline5x,
    admittedLosers,
    admittedLosersDied,
    admittedLosersSurvived,
    admittedLosersUnknownOutcome,
    precisionBaseline: caughtBaseline === 0 ? 0 : winnersCaughtBaseline / caughtBaseline,
    recallBaseline: winnerN === 0 ? 0 : winnersCaughtBaseline / winnerN,
    precisionW: caughtW === 0 ? 0 : winnersCaughtW / caughtW,
    recallW: winnerN === 0 ? 0 : winnersCaughtW / winnerN
  };
}

// ---------------------------------------------------------------------------
// Reachable-ceiling: the entire prize re-weighting can win (plan Step 1.6)
// ---------------------------------------------------------------------------

/** Fixed thresholds (75/55), independent of `--floor` — this line answers "how much headroom exists at all", not "at this floor". */
const CEILING_ALREADY_CAUGHT_FLOOR = 75;
const CEILING_REACHABLE_FLOOR = 55;

interface CeilingCounts {
  readonly totalWinners: number;
  readonly alreadyCaught: number;
  readonly reachable: number;
  readonly gateBlocked: number;
  /** Diagnostic: qualifies (eligible + non-GRAY) but scores below the reachable floor too — not (a), (b), or (c). */
  readonly belowReachableFloor: number;
}

function computeCeiling(rows: readonly EvaluatedRow[], winnerBpsThreshold: number): CeilingCounts {
  let totalWinners = 0;
  let alreadyCaught = 0;
  let reachable = 0;
  let gateBlocked = 0;
  let belowReachableFloor = 0;

  for (const evaluated of rows) {
    if (evaluated.row.maxMultipleBps < winnerBpsThreshold) continue;
    totalWinners += 1;

    if (!evaluated.eligible || evaluated.level === "GRAY") {
      gateBlocked += 1;
      continue;
    }
    const scoreBaseline = counterfactualScore(evaluated.components, RECONSTRUCTABLE_MAX);
    if (scoreBaseline >= CEILING_ALREADY_CAUGHT_FLOOR) alreadyCaught += 1;
    else if (scoreBaseline >= CEILING_REACHABLE_FLOOR) reachable += 1;
    else belowReachableFloor += 1;
  }

  return { totalWinners, alreadyCaught, reachable, gateBlocked, belowReachableFloor };
}

/** Sample-size gate for the primary (2x) reachable class, per out-of-time period. */
const MIN_REACHABLE_WINNERS_PER_PERIOD = 30;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logCalibrationReport(logger: Logger, label: string, report: CalibrationReport): void {
  for (const row of report.headline) {
    logger.info("sweep.feature_lift.headline", { label, ...row });
  }
  for (const featureReport of report.features) {
    for (const bucket of featureReport.buckets) {
      logger.info("sweep.feature_lift.bucket", {
        label,
        feature: featureReport.feature,
        horizonHours: featureReport.horizonHours,
        ...bucket
      });
    }
  }
}

function logCeiling(logger: Logger, label: string, ceiling: CeilingCounts): void {
  logger.info("sweep.ceiling", { label, ...ceiling });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const logger = createLogger();
  const env = process.env;
  const args = parseCliArgs(process.argv.slice(2));
  const chainConfig = loadChainConfigFromEnv(env);
  const tuning = loadWorkerTuningFromEnv(env);
  const eligibilityConfig = eligibilityConfigFromTuning(tuning);
  const alertThresholds = alertThresholdsFromTuning(tuning);
  const databaseUrl = loadDatabaseUrlFromEnv(env);

  logger.info("sweep.args", {
    horizonHours: args.horizonHours,
    winnerBps: args.winnerBps,
    secondaryWinnerBps: args.secondaryWinnerBps,
    floor: args.floor,
    secondaryFloor: args.secondaryFloor,
    alertMinScoreRed: tuning.alertMinScoreRed,
    tuneUntil: args.tuneUntil.toISOString(),
    weights: args.weights,
    reconstructableMax: RECONSTRUCTABLE_MAX,
    totalReconstructableBudget: TOTAL_RECONSTRUCTABLE_BUDGET
  });

  let sampleTooSmall = false;

  const handle = createDatabase(databaseUrl);
  try {
    await handle.applyMigrations();

    const allRows = await listTokenPerformance(handle.db, chainConfig.chainId);
    const outcomes = await listTokenOutcomes(handle.db, chainConfig.chainId);
    const outcomeByKey = new Map<string, TokenOutcomeRow>();
    for (const outcome of outcomes) {
      // Composite key mirrors `token_outcomes`' unique index
      // (chainId, poolAddress, horizonHours).
      const key = `${outcome.chainId}|${outcome.poolAddress}|${outcome.horizonHours}`;
      outcomeByKey.set(key, outcome);
    }

    const { kept: filtered, skipCounts } = filterPopulation(allRows, args.horizonHours);
    logger.info("sweep.skip_counts", {
      totalRows: allRows.length,
      filteredRows: filtered.length,
      ...skipCounts
    });

    const evaluated = filtered.map((row) =>
      evaluateRow(row, eligibilityConfig, alertThresholds, args.tuneUntil)
    );

    const tuneRows = evaluated.filter((row) => row.period === "tune");
    const confirmRows = evaluated.filter((row) => row.period === "confirm");
    const neitherCount = evaluated.length - tuneRows.length - confirmRows.length;
    logger.info("sweep.period_counts", {
      tune: tuneRows.length,
      confirm: confirmRows.length,
      neither: neitherCount
    });

    // --- Fidelity check: score'(R) must equal the live scoreOpportunity score for every row.
    let mismatches = 0;
    for (const row of evaluated) {
      const scorePrime = counterfactualScore(row.components, RECONSTRUCTABLE_MAX);
      if (scorePrime !== row.liveScore) mismatches += 1;
    }
    logger.info("sweep.fidelity", {
      rows: evaluated.length,
      mismatches,
      result: mismatches === 0 ? "PASS" : "FAIL"
    });

    // --- Feature-lift half (tune period only).
    const calibrationReport = buildCalibrationReport(tuneRows.map((row) => row.row));
    logCalibrationReport(logger, "tune", calibrationReport);

    // --- Sweep half: per-period comparison, at --floor and at the secondary 65 floor.
    const floors =
      args.floor === args.secondaryFloor ? [args.floor] : [args.floor, args.secondaryFloor];
    for (const floor of floors) {
      for (const [period, rows] of [
        ["tune", tuneRows],
        ["confirm", confirmRows]
      ] as const) {
        const comparison = buildPeriodComparison(
          period,
          rows,
          args.weights,
          floor,
          tuning.alertMinScoreRed,
          args.winnerBps,
          args.secondaryWinnerBps,
          outcomeByKey
        );
        logger.info("sweep.period", { ...comparison });
      }
    }

    // --- Reachable-ceiling, over ALL filtered rows, both winner classes.
    logCeiling(logger, "2x_all", computeCeiling(evaluated, args.winnerBps));
    logCeiling(logger, "5x_all", computeCeiling(evaluated, args.secondaryWinnerBps));

    // --- Sample-size gate: primary (2x) reachable class, per out-of-time period.
    const tuneCeiling2x = computeCeiling(tuneRows, args.winnerBps);
    const confirmCeiling2x = computeCeiling(confirmRows, args.winnerBps);
    logCeiling(logger, "2x_tune", tuneCeiling2x);
    logCeiling(logger, "2x_confirm", confirmCeiling2x);

    sampleTooSmall =
      tuneCeiling2x.reachable < MIN_REACHABLE_WINNERS_PER_PERIOD ||
      confirmCeiling2x.reachable < MIN_REACHABLE_WINNERS_PER_PERIOD;

    logger.info("sweep.verdict", {
      sampleTooSmall,
      minReachableWinnersPerPeriod: MIN_REACHABLE_WINNERS_PER_PERIOD,
      tuneReachable2x: tuneCeiling2x.reachable,
      confirmReachable2x: confirmCeiling2x.reachable,
      message: sampleTooSmall ? "SAMPLE TOO SMALL — DO NOT SHIP" : "sample size adequate"
    });
  } finally {
    await handle.close();
  }

  if (sampleTooSmall) {
    process.exitCode = 1;
  }
}

// Run only when executed directly — see feedback.ts; importing the pure
// helpers above must never open a database connection.
if (import.meta.main) {
  main().catch((error: unknown) => {
    createLogger().error("sweep.crashed", { error });
    process.exit(1);
  });
}
