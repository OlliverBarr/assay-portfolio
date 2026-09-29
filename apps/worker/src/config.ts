import { getAddress, isAddress, type Address } from "viem";

import type { EnvSource } from "@assay/chain";
import {
  DEFAULT_ALERT_THRESHOLDS,
  DEFAULT_ELIGIBILITY_CONFIG,
  type AlertThresholds,
  type EligibilityConfig
} from "@assay/scoring";

/** Raised when worker-level configuration is missing or malformed. */
export class WorkerConfigError extends Error {
  override readonly name = "WorkerConfigError";
  readonly field: string;

  constructor(field: string, message: string) {
    super(`Invalid worker configuration for "${field}": ${message}`);
    this.field = field;
  }
}

export interface WorkerTuning {
  /** Delay between discovery passes. */
  readonly pollIntervalMs: number;
  /** Blocks per getLogs request. */
  readonly chunkSize: bigint;
  /** Head lag before a block is considered scannable. */
  readonly confirmations: bigint;
  /** Delay between enrichment passes. */
  readonly enrichmentIntervalMs: number;
  /** Bounded RPC parallelism across pools during enrichment. */
  readonly enrichmentConcurrency: number;
  /** Pools discovered within this window are always in the active set. */
  readonly activePoolMaxAgeHours: number;
  /** Latest-snapshot FDV band that keeps an older pool in the active set. */
  readonly watchMinFdvUsd: number;
  readonly watchMaxFdvUsd: number;
  /** Idle (non-active) pools are re-valued when older than this. */
  readonly enrichmentIdleRefreshMs: number;
  /** Idle pools re-valued per enrichment pass. */
  readonly enrichmentIdleBatchLimit: number;
  /** Delay between activity ingestion passes. */
  readonly activityIntervalMs: number;
  /** Blocks per swap-log request. */
  readonly activityChunkSize: bigint;
  /** Head lag before swap logs are considered scannable. */
  readonly activityConfirmations: bigint;
  /** Re-snapshot an active pool whose rolling windows are older than this. */
  readonly activitySnapshotRefreshMs: number;
  /** Max pools the activity refresh lane re-snapshots per pass. */
  readonly activityRefreshBatchLimit: number;
  /** Delay between risk-assessment passes. */
  readonly riskIntervalMs: number;
  /** Re-assess a token whose latest risk verdict is older than this. */
  readonly riskStalenessMs: number;
  /** Sell loss at or above this many bps marks a route untradeable. */
  readonly riskMaxSellLossBps: number;
  /** Delay between holder-scan passes. */
  readonly holdersIntervalMs: number;
  /** Re-scan holders for a token whose snapshot is older than this. */
  readonly holdersStalenessMs: number;
  /** Band-lane cap: holder scans per pass for watch-band pools. */
  readonly holdersBandLimit: number;
  /** Backlog-lane cap: holder scans per pass for young pre-band pools. */
  readonly holdersBacklogLimit: number;
  /**
   * Quote-liquidity floor (USD) for the holders/risk band lanes; 0 disables.
   * Estimated FDV is nominal (dust pools can report any FDV), so band
   * membership alone must not spend transfer-log or simulation budget.
   * Below eligibility's quote minimum nothing alertable is lost.
   */
  readonly bandLaneMinQuoteLiquidityUsd: number;
  /** Blocks per transfer-log getLogs request in holder scans. */
  readonly holdersScanChunkBlocks: bigint;
  /** Delay between scoring/alert passes. */
  readonly scoringIntervalMs: number;
  /** Minimum gap before re-alerting a token at the same/lower level. */
  readonly alertCooldownMs: number;
  /** Alerts scoring below this are stored but not delivered. 0 disables. */
  readonly alertMinScore: number;
  /**
   * Additional delivery floor for RED-level (early watch) alerts only;
   * effective RED floor is max(alertMinScore, alertMinScoreRed). 0 falls
   * back to alertMinScore.
   */
  readonly alertMinScoreRed: number;
  /** Same/lower-level re-alerts need this much score improvement. 0 disables. */
  readonly reAlertMinScoreDelta: number;
  /**
   * Delivery suppression window for same-named sibling tokens (copycat
   * launch waves); an alert outranking the delivered sibling still fires.
   * 0 disables.
   */
  readonly alertDuplicateNameCooldownMs: number;
  /** Eligibility gates (band-dependent; safety caps stay in @assay/scoring). */
  readonly eligibilityMinFdvUsd: number;
  readonly eligibilityMaxFdvUsd: number;
  readonly eligibilityMinTotalLiquidityUsd: number;
  readonly eligibilityMinQuoteLiquidityUsd: number;
  readonly eligibilityMinUniqueBuyers: number;
  /**
   * Eligibility minimum token age in minutes. Default 0 (2026-07-20): the
   * old 20-minute floor excluded >50% of ≥10x winners (median entry age
   * 10 min). Raise via ELIGIBILITY_MIN_AGE_MINUTES if instant-rug
   * snapshots become a delivered-alert problem (keep it ≤5).
   */
  readonly eligibilityMinAgeMinutes: number;
  /** Alert tier FDV/liquidity/buyer bands (score gates are scoring-model constants). */
  readonly redMinFdvUsd: number;
  readonly redMaxFdvUsd: number;
  readonly redMinLiquidityUsd: number;
  readonly redMinUniqueBuyers: number;
  readonly yellowMinFdvUsd: number;
  readonly yellowMaxFdvUsd: number;
  readonly yellowMinLiquidityUsd: number;
  readonly greenMinFdvUsd: number;
  readonly greenMaxFdvUsd: number;
  readonly greenMinUniqueBuyers: number;
  /** Combined band+backlog risk assessments per pass. */
  readonly riskBatchLimit: number;
  /** Min gap between persisted GRAY (shadow) score rows per token. */
  readonly shadowIntervalMs: number;
  /** Delay between outcome-labeling passes. */
  readonly outcomeIntervalMs: number;
  /** Survival horizons in hours (e.g. 24, 72). */
  readonly outcomeHorizonsHours: readonly number[];
  /** Min share of peak quote liquidity (bps) still present at horizon = SURVIVED. */
  readonly outcomeMinLiquidityFractionBps: number;
  /** Min estimated FDV at horizon required to count as SURVIVED. */
  readonly outcomeMinFdvUsd: number;
  /** Pools labeled per horizon per outcome pass. */
  readonly outcomeBatchLimit: number;
  /** Delay between performance-labeling passes. */
  readonly performanceIntervalMs: number;
  /** Realized-performance horizons in hours after band entry. */
  readonly performanceHorizonsHours: readonly number[];
  /** Reference band whose first crossing defines "entry". */
  readonly performanceBandMinFdvUsd: number;
  readonly performanceBandMaxFdvUsd: number;
  /** Pools labeled per horizon per performance pass. */
  readonly performanceBatchLimit: number;
  /** Delay between Telegram subscription-sync passes. */
  readonly subscriptionsIntervalMs: number;
  /** Latest quote liquidity below this fraction of peak (bps) = LP pull. */
  readonly liquidityCollapseFractionBps: number;
  /** "Early buyer" retention window from the pool's first stored swap. */
  readonly retentionWindowMinutes: number;
  /** Cohort percentiles are withheld below this many same-age peers. */
  readonly cohortMinSize: number;
  /** Delay between winners-retro passes. */
  readonly winnersRetroIntervalMs: number;
  /** Wick-multiple floor (bps) pre-filtering winner candidates in SQL. */
  readonly winnersMinMultipleBps: number;
  /** Sustained winners below this exit quote liquidity are dropped. */
  readonly winnersMinExitLiquidityUsd: number;
}

export const DEFAULT_TUNING: WorkerTuning = {
  pollIntervalMs: 15_000,
  chunkSize: 2_000n,
  confirmations: 0n,
  enrichmentIntervalMs: 60_000,
  enrichmentConcurrency: 5,
  activePoolMaxAgeHours: 72,
  // Watch band: superset of the $10k–$100k focus band with headroom above
  // the eligibility max so a pool at the top of GREEN isn't dropped from the
  // scoring/active set on a tick (2026-07-13 band move).
  watchMinFdvUsd: 10_000,
  watchMaxFdvUsd: 120_000,
  enrichmentIdleRefreshMs: 6 * 60 * 60 * 1000,
  enrichmentIdleBatchLimit: 400,
  activityIntervalMs: 30_000,
  activityChunkSize: 2_000n,
  activityConfirmations: 0n,
  activitySnapshotRefreshMs: 15 * 60 * 1000,
  activityRefreshBatchLimit: 400,
  riskIntervalMs: 60_000,
  riskStalenessMs: 6 * 60 * 60 * 1000,
  riskMaxSellLossBps: 5_000,
  holdersIntervalMs: 120_000,
  holdersStalenessMs: 15 * 60 * 1000,
  holdersBandLimit: 300,
  holdersBacklogLimit: 50,
  bandLaneMinQuoteLiquidityUsd: 500,
  holdersScanChunkBlocks: 2_000n,
  scoringIntervalMs: 60_000,
  alertCooldownMs: 30 * 60 * 1000,
  // 80 (2026-07-20 model rebuild, measured on the labeled replay): the
  // precision-tilted operating point. Floor 70 delivered ~138/day; floor 80
  // delivers ~11/day at 68% >=10x precision (vs 1.7% base). First-week live
  // volume tunes this +/-5 before any component weight moves
  // (docs/scoring-model.md).
  alertMinScore: 80,
  alertMinScoreRed: 70,
  reAlertMinScoreDelta: 10,
  alertDuplicateNameCooldownMs: 6 * 60 * 60 * 1000,
  eligibilityMinFdvUsd: 10_000,
  eligibilityMaxFdvUsd: 100_000,
  eligibilityMinTotalLiquidityUsd: 5_000,
  eligibilityMinQuoteLiquidityUsd: 2_500,
  eligibilityMinUniqueBuyers: 15,
  eligibilityMinAgeMinutes: 0,
  // Tier bands re-cut 2026-07-20 to the measured 10x zone ($15-40k sweet
  // spot); RED liquidity now gates on QUOTE liquidity (docs/scoring-model.md).
  redMinFdvUsd: 10_000,
  redMaxFdvUsd: 100_000,
  redMinLiquidityUsd: 2_500,
  redMinUniqueBuyers: 5,
  yellowMinFdvUsd: 15_000,
  yellowMaxFdvUsd: 60_000,
  yellowMinLiquidityUsd: 8_000,
  greenMinFdvUsd: 15_000,
  greenMaxFdvUsd: 40_000,
  greenMinUniqueBuyers: 20,
  riskBatchLimit: 200,
  shadowIntervalMs: 60 * 60 * 1000,
  outcomeIntervalMs: 60 * 60 * 1000,
  outcomeHorizonsHours: [24, 72],
  outcomeMinLiquidityFractionBps: 3_000,
  outcomeMinFdvUsd: 10_000,
  outcomeBatchLimit: 200,
  performanceIntervalMs: 60 * 60 * 1000,
  // 24h is the retro's provisional horizon: labels appear a day after band
  // entry instead of three, at the cost of wick-noise (marked provisional).
  performanceHorizonsHours: [24, 72, 168],
  performanceBandMinFdvUsd: 50_000,
  performanceBandMaxFdvUsd: 200_000,
  performanceBatchLimit: 200,
  subscriptionsIntervalMs: 30_000,
  liquidityCollapseFractionBps: 2_000,
  retentionWindowMinutes: 60,
  cohortMinSize: 8,
  winnersRetroIntervalMs: 60 * 60 * 1000,
  winnersMinMultipleBps: 50_000,
  winnersMinExitLiquidityUsd: 15_000
};

function parsePositiveInt(
  env: EnvSource,
  key: string,
  fallback: number
): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkerConfigError(key, `"${raw}" is not a positive integer`);
  }
  return value;
}

/** Like {@link parsePositiveInt} but 0 is allowed (used to disable a gate). */
function parseNonNegativeInt(
  env: EnvSource,
  key: string,
  fallback: number
): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerConfigError(key, `"${raw}" is not a non-negative integer`);
  }
  return value;
}

function parseNonNegativeBigInt(
  env: EnvSource,
  key: string,
  fallback: bigint,
  minimum: bigint
): bigint {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    throw new WorkerConfigError(key, `"${raw}" is not an integer`);
  }
  if (value < minimum) {
    throw new WorkerConfigError(key, `must be >= ${minimum}, got "${raw}"`);
  }
  return value;
}

/** Comma-separated list of positive integers, e.g. "24,72" or "500,2000,5000". */
function parsePositiveIntList(
  env: EnvSource,
  key: string,
  fallback: readonly number[]
): readonly number[] {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const values = raw.split(",").map((part) => Number(part.trim()));
  if (values.length === 0 || values.some((v) => !Number.isSafeInteger(v) || v <= 0)) {
    throw new WorkerConfigError(
      key,
      `"${raw}" is not a comma-separated list of positive integers`
    );
  }
  return values;
}

/**
 * Parse discovery tuning from the environment. Unset values fall back to
 * defaults; malformed values are hard errors — a mistyped chunk size must
 * stop the worker, not silently scan with a default.
 */
export function loadWorkerTuningFromEnv(env: EnvSource): WorkerTuning {
  return {
    pollIntervalMs: parsePositiveInt(
      env,
      "DISCOVERY_POLL_INTERVAL_MS",
      DEFAULT_TUNING.pollIntervalMs
    ),
    chunkSize: parseNonNegativeBigInt(
      env,
      "DISCOVERY_CHUNK_SIZE",
      DEFAULT_TUNING.chunkSize,
      1n
    ),
    confirmations: parseNonNegativeBigInt(
      env,
      "DISCOVERY_CONFIRMATIONS",
      DEFAULT_TUNING.confirmations,
      0n
    ),
    enrichmentIntervalMs: parsePositiveInt(
      env,
      "ENRICHMENT_INTERVAL_MS",
      DEFAULT_TUNING.enrichmentIntervalMs
    ),
    enrichmentConcurrency: parsePositiveInt(
      env,
      "ENRICHMENT_CONCURRENCY",
      DEFAULT_TUNING.enrichmentConcurrency
    ),
    activePoolMaxAgeHours: parsePositiveInt(
      env,
      "ACTIVE_POOL_MAX_AGE_HOURS",
      DEFAULT_TUNING.activePoolMaxAgeHours
    ),
    watchMinFdvUsd: parsePositiveInt(
      env,
      "WATCH_MIN_FDV_USD",
      DEFAULT_TUNING.watchMinFdvUsd
    ),
    watchMaxFdvUsd: parsePositiveInt(
      env,
      "WATCH_MAX_FDV_USD",
      DEFAULT_TUNING.watchMaxFdvUsd
    ),
    enrichmentIdleRefreshMs: parsePositiveInt(
      env,
      "ENRICHMENT_IDLE_REFRESH_MS",
      DEFAULT_TUNING.enrichmentIdleRefreshMs
    ),
    enrichmentIdleBatchLimit: parsePositiveInt(
      env,
      "ENRICHMENT_IDLE_BATCH_LIMIT",
      DEFAULT_TUNING.enrichmentIdleBatchLimit
    ),
    activityIntervalMs: parsePositiveInt(
      env,
      "ACTIVITY_POLL_INTERVAL_MS",
      DEFAULT_TUNING.activityIntervalMs
    ),
    activityChunkSize: parseNonNegativeBigInt(
      env,
      "ACTIVITY_CHUNK_SIZE",
      DEFAULT_TUNING.activityChunkSize,
      1n
    ),
    activityConfirmations: parseNonNegativeBigInt(
      env,
      "ACTIVITY_CONFIRMATIONS",
      DEFAULT_TUNING.activityConfirmations,
      0n
    ),
    activitySnapshotRefreshMs: parsePositiveInt(
      env,
      "ACTIVITY_SNAPSHOT_REFRESH_MS",
      DEFAULT_TUNING.activitySnapshotRefreshMs
    ),
    activityRefreshBatchLimit: parsePositiveInt(
      env,
      "ACTIVITY_REFRESH_BATCH_LIMIT",
      DEFAULT_TUNING.activityRefreshBatchLimit
    ),
    riskIntervalMs: parsePositiveInt(
      env,
      "RISK_POLL_INTERVAL_MS",
      DEFAULT_TUNING.riskIntervalMs
    ),
    riskStalenessMs: parsePositiveInt(
      env,
      "RISK_STALENESS_MS",
      DEFAULT_TUNING.riskStalenessMs
    ),
    riskMaxSellLossBps: parsePositiveInt(
      env,
      "RISK_MAX_SELL_LOSS_BPS",
      DEFAULT_TUNING.riskMaxSellLossBps
    ),
    holdersIntervalMs: parsePositiveInt(
      env,
      "HOLDERS_POLL_INTERVAL_MS",
      DEFAULT_TUNING.holdersIntervalMs
    ),
    holdersStalenessMs: parsePositiveInt(
      env,
      "HOLDERS_STALENESS_MS",
      DEFAULT_TUNING.holdersStalenessMs
    ),
    holdersBandLimit: parsePositiveInt(
      env,
      "HOLDERS_BAND_LIMIT",
      DEFAULT_TUNING.holdersBandLimit
    ),
    holdersBacklogLimit: parsePositiveInt(
      env,
      "HOLDERS_BACKLOG_LIMIT",
      DEFAULT_TUNING.holdersBacklogLimit
    ),
    bandLaneMinQuoteLiquidityUsd: parseNonNegativeInt(
      env,
      "BAND_LANE_MIN_QUOTE_LIQUIDITY_USD",
      DEFAULT_TUNING.bandLaneMinQuoteLiquidityUsd
    ),
    holdersScanChunkBlocks: parseNonNegativeBigInt(
      env,
      "HOLDERS_SCAN_CHUNK_BLOCKS",
      DEFAULT_TUNING.holdersScanChunkBlocks,
      1n
    ),
    scoringIntervalMs: parsePositiveInt(
      env,
      "SCORING_POLL_INTERVAL_MS",
      DEFAULT_TUNING.scoringIntervalMs
    ),
    alertCooldownMs: parsePositiveInt(
      env,
      "ALERT_COOLDOWN_MS",
      DEFAULT_TUNING.alertCooldownMs
    ),
    alertMinScore: parseNonNegativeInt(
      env,
      "ALERT_MIN_SCORE",
      DEFAULT_TUNING.alertMinScore
    ),
    alertMinScoreRed: parseNonNegativeInt(
      env,
      "ALERT_MIN_SCORE_RED",
      DEFAULT_TUNING.alertMinScoreRed
    ),
    eligibilityMinFdvUsd: parsePositiveInt(
      env,
      "ELIGIBILITY_MIN_FDV_USD",
      DEFAULT_TUNING.eligibilityMinFdvUsd
    ),
    eligibilityMaxFdvUsd: parsePositiveInt(
      env,
      "ELIGIBILITY_MAX_FDV_USD",
      DEFAULT_TUNING.eligibilityMaxFdvUsd
    ),
    eligibilityMinTotalLiquidityUsd: parsePositiveInt(
      env,
      "ELIGIBILITY_MIN_TOTAL_LIQUIDITY_USD",
      DEFAULT_TUNING.eligibilityMinTotalLiquidityUsd
    ),
    eligibilityMinQuoteLiquidityUsd: parsePositiveInt(
      env,
      "ELIGIBILITY_MIN_QUOTE_LIQUIDITY_USD",
      DEFAULT_TUNING.eligibilityMinQuoteLiquidityUsd
    ),
    eligibilityMinUniqueBuyers: parseNonNegativeInt(
      env,
      "ELIGIBILITY_MIN_UNIQUE_BUYERS",
      DEFAULT_TUNING.eligibilityMinUniqueBuyers
    ),
    eligibilityMinAgeMinutes: parseNonNegativeInt(
      env,
      "ELIGIBILITY_MIN_AGE_MINUTES",
      DEFAULT_TUNING.eligibilityMinAgeMinutes
    ),
    redMinFdvUsd: parsePositiveInt(
      env,
      "ALERT_RED_MIN_FDV_USD",
      DEFAULT_TUNING.redMinFdvUsd
    ),
    redMaxFdvUsd: parsePositiveInt(
      env,
      "ALERT_RED_MAX_FDV_USD",
      DEFAULT_TUNING.redMaxFdvUsd
    ),
    redMinLiquidityUsd: parsePositiveInt(
      env,
      "ALERT_RED_MIN_LIQUIDITY_USD",
      DEFAULT_TUNING.redMinLiquidityUsd
    ),
    redMinUniqueBuyers: parseNonNegativeInt(
      env,
      "ALERT_RED_MIN_UNIQUE_BUYERS",
      DEFAULT_TUNING.redMinUniqueBuyers
    ),
    yellowMinFdvUsd: parsePositiveInt(
      env,
      "ALERT_YELLOW_MIN_FDV_USD",
      DEFAULT_TUNING.yellowMinFdvUsd
    ),
    yellowMaxFdvUsd: parsePositiveInt(
      env,
      "ALERT_YELLOW_MAX_FDV_USD",
      DEFAULT_TUNING.yellowMaxFdvUsd
    ),
    yellowMinLiquidityUsd: parsePositiveInt(
      env,
      "ALERT_YELLOW_MIN_LIQUIDITY_USD",
      DEFAULT_TUNING.yellowMinLiquidityUsd
    ),
    greenMinFdvUsd: parsePositiveInt(
      env,
      "ALERT_GREEN_MIN_FDV_USD",
      DEFAULT_TUNING.greenMinFdvUsd
    ),
    greenMaxFdvUsd: parsePositiveInt(
      env,
      "ALERT_GREEN_MAX_FDV_USD",
      DEFAULT_TUNING.greenMaxFdvUsd
    ),
    greenMinUniqueBuyers: parseNonNegativeInt(
      env,
      "ALERT_GREEN_MIN_UNIQUE_BUYERS",
      DEFAULT_TUNING.greenMinUniqueBuyers
    ),
    riskBatchLimit: parsePositiveInt(
      env,
      "RISK_BATCH_LIMIT",
      DEFAULT_TUNING.riskBatchLimit
    ),
    shadowIntervalMs: parsePositiveInt(
      env,
      "SCORING_SHADOW_INTERVAL_MS",
      DEFAULT_TUNING.shadowIntervalMs
    ),
    outcomeIntervalMs: parsePositiveInt(
      env,
      "OUTCOME_POLL_INTERVAL_MS",
      DEFAULT_TUNING.outcomeIntervalMs
    ),
    outcomeHorizonsHours: parsePositiveIntList(
      env,
      "OUTCOME_HORIZONS_HOURS",
      DEFAULT_TUNING.outcomeHorizonsHours
    ),
    outcomeMinLiquidityFractionBps: parsePositiveInt(
      env,
      "OUTCOME_MIN_LIQUIDITY_FRACTION_BPS",
      DEFAULT_TUNING.outcomeMinLiquidityFractionBps
    ),
    outcomeMinFdvUsd: parsePositiveInt(
      env,
      "OUTCOME_MIN_FDV_USD",
      DEFAULT_TUNING.outcomeMinFdvUsd
    ),
    outcomeBatchLimit: parsePositiveInt(
      env,
      "OUTCOME_BATCH_LIMIT",
      DEFAULT_TUNING.outcomeBatchLimit
    ),
    performanceIntervalMs: parsePositiveInt(
      env,
      "PERFORMANCE_POLL_INTERVAL_MS",
      DEFAULT_TUNING.performanceIntervalMs
    ),
    performanceHorizonsHours: parsePositiveIntList(
      env,
      "PERFORMANCE_HORIZONS_HOURS",
      DEFAULT_TUNING.performanceHorizonsHours
    ),
    performanceBandMinFdvUsd: parsePositiveInt(
      env,
      "PERFORMANCE_BAND_MIN_FDV_USD",
      DEFAULT_TUNING.performanceBandMinFdvUsd
    ),
    performanceBandMaxFdvUsd: parsePositiveInt(
      env,
      "PERFORMANCE_BAND_MAX_FDV_USD",
      DEFAULT_TUNING.performanceBandMaxFdvUsd
    ),
    performanceBatchLimit: parsePositiveInt(
      env,
      "PERFORMANCE_BATCH_LIMIT",
      DEFAULT_TUNING.performanceBatchLimit
    ),
    subscriptionsIntervalMs: parsePositiveInt(
      env,
      "SUBSCRIPTIONS_POLL_INTERVAL_MS",
      DEFAULT_TUNING.subscriptionsIntervalMs
    ),
    liquidityCollapseFractionBps: parsePositiveInt(
      env,
      "LIQUIDITY_COLLAPSE_FRACTION_BPS",
      DEFAULT_TUNING.liquidityCollapseFractionBps
    ),
    retentionWindowMinutes: parsePositiveInt(
      env,
      "RETENTION_WINDOW_MINUTES",
      DEFAULT_TUNING.retentionWindowMinutes
    ),
    cohortMinSize: parsePositiveInt(
      env,
      "COHORT_MIN_SIZE",
      DEFAULT_TUNING.cohortMinSize
    ),
    winnersRetroIntervalMs: parsePositiveInt(
      env,
      "WINNERS_RETRO_INTERVAL_MS",
      DEFAULT_TUNING.winnersRetroIntervalMs
    ),
    winnersMinMultipleBps: parsePositiveInt(
      env,
      "WINNERS_MIN_MULTIPLE_BPS",
      DEFAULT_TUNING.winnersMinMultipleBps
    ),
    winnersMinExitLiquidityUsd: parseNonNegativeInt(
      env,
      "WINNERS_MIN_EXIT_LIQUIDITY_USD",
      DEFAULT_TUNING.winnersMinExitLiquidityUsd
    ),
    reAlertMinScoreDelta: parseNonNegativeInt(
      env,
      "ALERT_REALERT_MIN_SCORE_DELTA",
      DEFAULT_TUNING.reAlertMinScoreDelta
    ),
    alertDuplicateNameCooldownMs: parseNonNegativeInt(
      env,
      "ALERT_DUPLICATE_NAME_COOLDOWN_MS",
      DEFAULT_TUNING.alertDuplicateNameCooldownMs
    )
  };
}

/**
 * Band-dependent eligibility gates plus the age floor from tuning;
 * band-independent safety caps (sell loss, deployer/top-10 concentration)
 * keep the scoring-model defaults; they are not part of the band
 * configuration.
 */
export function eligibilityConfigFromTuning(
  tuning: WorkerTuning
): EligibilityConfig {
  return {
    ...DEFAULT_ELIGIBILITY_CONFIG,
    minFdvUsd: tuning.eligibilityMinFdvUsd,
    maxFdvUsd: tuning.eligibilityMaxFdvUsd,
    minTotalLiquidityUsd: tuning.eligibilityMinTotalLiquidityUsd,
    minQuoteLiquidityUsd: tuning.eligibilityMinQuoteLiquidityUsd,
    minUniqueBuyers: tuning.eligibilityMinUniqueBuyers,
    minAgeMinutes: tuning.eligibilityMinAgeMinutes
  };
}

/**
 * Alert tier FDV/liquidity/buyer bands from tuning; score gates and the
 * GREEN concentration cap keep the scoring-model defaults.
 */
export function alertThresholdsFromTuning(
  tuning: WorkerTuning
): AlertThresholds {
  return {
    ...DEFAULT_ALERT_THRESHOLDS,
    redMinFdvUsd: tuning.redMinFdvUsd,
    redMaxFdvUsd: tuning.redMaxFdvUsd,
    redMinLiquidityUsd: tuning.redMinLiquidityUsd,
    redMinUniqueBuyers: tuning.redMinUniqueBuyers,
    yellowMinFdvUsd: tuning.yellowMinFdvUsd,
    yellowMaxFdvUsd: tuning.yellowMaxFdvUsd,
    yellowMinLiquidityUsd: tuning.yellowMinLiquidityUsd,
    greenMinFdvUsd: tuning.greenMinFdvUsd,
    greenMaxFdvUsd: tuning.greenMaxFdvUsd,
    greenMinUniqueBuyers: tuning.greenMinUniqueBuyers
  };
}

export interface TelegramConfig {
  readonly botToken: string;
  readonly chatId: string;
}

/**
 * Telegram credentials, or undefined when unset — in which case the worker
 * runs alerts in dry-run (logged, not sent). Partial config (one of the two)
 * is a hard error: a half-configured alerter would silently drop alerts.
 */
export function loadTelegramConfigFromEnv(
  env: EnvSource
): TelegramConfig | undefined {
  const botToken = env["TELEGRAM_BOT_TOKEN"]?.trim();
  const chatId = env["TELEGRAM_CHAT_ID"]?.trim();
  const hasToken = botToken !== undefined && botToken !== "";
  const hasChat = chatId !== undefined && chatId !== "";
  if (!hasToken && !hasChat) return undefined;
  if (!hasToken) {
    throw new WorkerConfigError("TELEGRAM_BOT_TOKEN", "required when TELEGRAM_CHAT_ID is set");
  }
  if (!hasChat) {
    throw new WorkerConfigError("TELEGRAM_CHAT_ID", "required when TELEGRAM_BOT_TOKEN is set");
  }
  return { botToken, chatId };
}

export interface RiskSimulatorConfig {
  readonly v2Router?: Address;
  readonly v3Quoter?: Address;
  /** Quote notionals (USD) probed for the sell-slippage curve; unset = simulator default. */
  readonly slippageCurveNotionalsUsd?: readonly number[];
}

function parseOptionalAddress(env: EnvSource, key: string): Address | undefined {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!isAddress(raw)) {
    throw new WorkerConfigError(key, `"${raw}" is not a valid EVM address`);
  }
  return getAddress(raw);
}

/**
 * Operator wallet addresses for automatic entry/exit detection in the
 * feedback report. Optional: unset/empty means detection is off and only
 * manual `decide` records count. Malformed addresses hard-fail (a typo'd
 * wallet would silently blind the detector).
 */
export function loadOperatorWalletsFromEnv(env: EnvSource): Address[] {
  const raw = env["OPERATOR_WALLET_ADDRESSES"]?.trim();
  if (raw === undefined || raw === "") return [];
  return raw.split(",").map((part) => {
    const candidate = part.trim();
    if (!isAddress(candidate)) {
      throw new WorkerConfigError(
        "OPERATOR_WALLET_ADDRESSES",
        `"${candidate}" is not a valid EVM address`
      );
    }
    return getAddress(candidate);
  });
}

/**
 * Optional router/quoter addresses enabling live tradeability simulation.
 * Absent addresses leave simulation UNKNOWN rather than fabricating a verdict;
 * malformed addresses hard-fail the worker.
 */
export function loadRiskSimulatorConfigFromEnv(
  env: EnvSource
): RiskSimulatorConfig {
  const v2Router = parseOptionalAddress(env, "RISK_V2_ROUTER_ADDRESS");
  const v3Quoter = parseOptionalAddress(env, "RISK_V3_QUOTER_ADDRESS");
  const rawNotionals = env["RISK_SLIPPAGE_CURVE_NOTIONALS_USD"]?.trim();
  const slippageCurveNotionalsUsd =
    rawNotionals === undefined || rawNotionals === ""
      ? undefined
      : parsePositiveIntList(env, "RISK_SLIPPAGE_CURVE_NOTIONALS_USD", []);
  return {
    ...(v2Router === undefined ? {} : { v2Router }),
    ...(v3Quoter === undefined ? {} : { v3Quoter }),
    ...(slippageCurveNotionalsUsd === undefined ? {} : { slippageCurveNotionalsUsd })
  };
}

/** Required database connection string. */
export function loadDatabaseUrlFromEnv(env: EnvSource): string {
  const url = env["DATABASE_URL"]?.trim();
  if (url === undefined || url === "") {
    throw new WorkerConfigError("DATABASE_URL", "value is required");
  }
  return url;
}

const JUDGMENT_MIN_ALERT_LEVELS = ["RED", "YELLOW", "GREEN"] as const;

export type JudgmentMinAlertLevel = (typeof JUDGMENT_MIN_ALERT_LEVELS)[number];

function parseJudgmentMinAlertLevel(
  env: EnvSource,
  key: string,
  fallback: JudgmentMinAlertLevel
): JudgmentMinAlertLevel {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if ((JUDGMENT_MIN_ALERT_LEVELS as readonly string[]).includes(raw)) {
    return raw as JudgmentMinAlertLevel;
  }
  throw new WorkerConfigError(
    key,
    `"${raw}" is not one of ${JUDGMENT_MIN_ALERT_LEVELS.join(", ")}`
  );
}

export interface JudgmentLlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export interface JudgmentConfig {
  /** False disables the loop entirely: no alerts are read, no briefs are generated. */
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly minAlertLevel: JudgmentMinAlertLevel;
  readonly batchLimit: number;
  readonly maxToolRounds: number;
  readonly timeoutMs: number;
  /**
   * Per-token re-brief suppression window: a new alert for a token with a
   * COMPLETED brief this recent is not briefed again unless its level
   * escalated. 0 disables (every alert briefs).
   */
  readonly rebriefCooldownMs: number;
  /** Set iff `enabled`. */
  readonly llm?: JudgmentLlmConfig;
}

const DEFAULT_LLM_API_BASE_URL = "https://api.openai.com/v1";

/**
 * Advisory judgment-layer config. Mirrors `loadTelegramConfigFromEnv`: the
 * loop is OFF unless both `LLM_API_KEY` and `JUDGMENT_MODEL` are set; a
 * half-configured LLM (one of the two) is a hard error rather than a
 * silently disabled loop or a runtime crash on the first pass.
 */
export function loadJudgmentConfigFromEnv(env: EnvSource): JudgmentConfig {
  const pollIntervalMs = parsePositiveInt(env, "JUDGMENT_POLL_INTERVAL_MS", 30_000);
  const minAlertLevel = parseJudgmentMinAlertLevel(env, "JUDGMENT_MIN_ALERT_LEVEL", "YELLOW");
  const batchLimit = parsePositiveInt(env, "JUDGMENT_BATCH_LIMIT", 5);
  const maxToolRounds = parsePositiveInt(env, "JUDGMENT_MAX_TOOL_ROUNDS", 8);
  const timeoutMs = parsePositiveInt(env, "JUDGMENT_TIMEOUT_MS", 90_000);
  const rebriefCooldownMs = parseNonNegativeInt(
    env,
    "JUDGMENT_REBRIEF_COOLDOWN_MS",
    24 * 60 * 60 * 1000
  );

  const apiKey = env["LLM_API_KEY"]?.trim();
  const model = env["JUDGMENT_MODEL"]?.trim();
  const hasApiKey = apiKey !== undefined && apiKey !== "";
  const hasModel = model !== undefined && model !== "";

  if (!hasApiKey && !hasModel) {
    return {
      enabled: false,
      pollIntervalMs,
      minAlertLevel,
      batchLimit,
      maxToolRounds,
      timeoutMs,
      rebriefCooldownMs
    };
  }
  if (!hasApiKey) {
    throw new WorkerConfigError("LLM_API_KEY", "required when JUDGMENT_MODEL is set");
  }
  if (!hasModel) {
    throw new WorkerConfigError("JUDGMENT_MODEL", "required when LLM_API_KEY is set");
  }
  const baseUrl = env["LLM_API_BASE_URL"]?.trim();
  return {
    enabled: true,
    pollIntervalMs,
    minAlertLevel,
    batchLimit,
    maxToolRounds,
    timeoutMs,
    rebriefCooldownMs,
    llm: {
      baseUrl: baseUrl === undefined || baseUrl === "" ? DEFAULT_LLM_API_BASE_URL : baseUrl,
      apiKey,
      model
    }
  };
}
