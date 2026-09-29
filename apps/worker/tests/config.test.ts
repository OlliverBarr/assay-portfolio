import { describe, expect, it } from "vitest";

import {
  DEFAULT_TUNING,
  WorkerConfigError,
  loadDatabaseUrlFromEnv,
  loadOperatorWalletsFromEnv,
  loadWorkerTuningFromEnv
} from "../src/config.js";

describe("loadWorkerTuningFromEnv", () => {
  it("falls back to defaults when unset", () => {
    expect(loadWorkerTuningFromEnv({})).toEqual(DEFAULT_TUNING);
  });

  it("parses explicit values", () => {
    expect(
      loadWorkerTuningFromEnv({
        DISCOVERY_POLL_INTERVAL_MS: "5000",
        DISCOVERY_CHUNK_SIZE: "500",
        DISCOVERY_CONFIRMATIONS: "3",
        ENRICHMENT_INTERVAL_MS: "30000",
        ENRICHMENT_CONCURRENCY: "2",
        ACTIVE_POOL_MAX_AGE_HOURS: "48",
        WATCH_MIN_FDV_USD: "30000",
        WATCH_MAX_FDV_USD: "400000",
        ENRICHMENT_IDLE_REFRESH_MS: "10800000",
        ENRICHMENT_IDLE_BATCH_LIMIT: "100",
        ACTIVITY_POLL_INTERVAL_MS: "7000",
        ACTIVITY_CHUNK_SIZE: "250",
        ACTIVITY_CONFIRMATIONS: "4",
        ACTIVITY_SNAPSHOT_REFRESH_MS: "600000",
        ACTIVITY_REFRESH_BATCH_LIMIT: "200",
        RISK_POLL_INTERVAL_MS: "45000",
        RISK_STALENESS_MS: "120000",
        RISK_MAX_SELL_LOSS_BPS: "800",
        HOLDERS_POLL_INTERVAL_MS: "90000",
        HOLDERS_STALENESS_MS: "600000",
        HOLDERS_BAND_LIMIT: "150",
        HOLDERS_BACKLOG_LIMIT: "25",
        BAND_LANE_MIN_QUOTE_LIQUIDITY_USD: "0",
        HOLDERS_SCAN_CHUNK_BLOCKS: "10000",
        SCORING_POLL_INTERVAL_MS: "45000",
        ALERT_COOLDOWN_MS: "300000",
        ALERT_MIN_SCORE: "60",
        ALERT_REALERT_MIN_SCORE_DELTA: "15",
        RISK_BATCH_LIMIT: "100",
        SCORING_SHADOW_INTERVAL_MS: "1800000",
        OUTCOME_POLL_INTERVAL_MS: "7200000",
        OUTCOME_HORIZONS_HOURS: "12,48,96",
        OUTCOME_MIN_LIQUIDITY_FRACTION_BPS: "2500",
        OUTCOME_MIN_FDV_USD: "5000",
        OUTCOME_BATCH_LIMIT: "50",
        LIQUIDITY_COLLAPSE_FRACTION_BPS: "1500",
        PERFORMANCE_POLL_INTERVAL_MS: "1800000",
        PERFORMANCE_HORIZONS_HOURS: "48,120",
        PERFORMANCE_BAND_MIN_FDV_USD: "60000",
        PERFORMANCE_BAND_MAX_FDV_USD: "180000",
        PERFORMANCE_BATCH_LIMIT: "25",
        SUBSCRIPTIONS_POLL_INTERVAL_MS: "60000",
        RETENTION_WINDOW_MINUTES: "30",
        COHORT_MIN_SIZE: "12",
        WINNERS_RETRO_INTERVAL_MS: "7200000",
        WINNERS_MIN_MULTIPLE_BPS: "30000",
        WINNERS_MIN_EXIT_LIQUIDITY_USD: "20000",
        ALERT_MIN_SCORE_RED: "72",
        ELIGIBILITY_MIN_FDV_USD: "12000",
        ELIGIBILITY_MAX_FDV_USD: "110000",
        ELIGIBILITY_MIN_TOTAL_LIQUIDITY_USD: "6000",
        ELIGIBILITY_MIN_QUOTE_LIQUIDITY_USD: "3000",
        ELIGIBILITY_MIN_UNIQUE_BUYERS: "18",
        ELIGIBILITY_MIN_AGE_MINUTES: "7",
        ALERT_RED_MIN_FDV_USD: "11000",
        ALERT_RED_MAX_FDV_USD: "42000",
        ALERT_RED_MIN_LIQUIDITY_USD: "3500",
        ALERT_RED_MIN_UNIQUE_BUYERS: "9",
        ALERT_YELLOW_MIN_FDV_USD: "41000",
        ALERT_YELLOW_MAX_FDV_USD: "99000",
        ALERT_YELLOW_MIN_LIQUIDITY_USD: "5500",
        ALERT_GREEN_MIN_FDV_USD: "52000",
        ALERT_GREEN_MAX_FDV_USD: "88000",
        ALERT_GREEN_MIN_UNIQUE_BUYERS: "26"
      })
    ).toEqual({
      pollIntervalMs: 5000,
      chunkSize: 500n,
      confirmations: 3n,
      enrichmentIntervalMs: 30_000,
      enrichmentConcurrency: 2,
      activePoolMaxAgeHours: 48,
      watchMinFdvUsd: 30_000,
      watchMaxFdvUsd: 400_000,
      enrichmentIdleRefreshMs: 10_800_000,
      enrichmentIdleBatchLimit: 100,
      activityIntervalMs: 7_000,
      activityChunkSize: 250n,
      activityConfirmations: 4n,
      activitySnapshotRefreshMs: 600_000,
      activityRefreshBatchLimit: 200,
      riskIntervalMs: 45_000,
      riskStalenessMs: 120_000,
      riskMaxSellLossBps: 800,
      holdersIntervalMs: 90_000,
      holdersStalenessMs: 600_000,
      holdersBandLimit: 150,
      holdersBacklogLimit: 25,
      bandLaneMinQuoteLiquidityUsd: 0,
      holdersScanChunkBlocks: 10_000n,
      reAlertMinScoreDelta: 15,
      scoringIntervalMs: 45_000,
      alertCooldownMs: 300_000,
      alertMinScore: 60,
      alertMinScoreRed: 72,
      alertDuplicateNameCooldownMs: 21_600_000,
      riskBatchLimit: 100,
      shadowIntervalMs: 1_800_000,
      outcomeIntervalMs: 7_200_000,
      outcomeHorizonsHours: [12, 48, 96],
      outcomeMinLiquidityFractionBps: 2_500,
      outcomeMinFdvUsd: 5_000,
      outcomeBatchLimit: 50,
      performanceIntervalMs: 1_800_000,
      performanceHorizonsHours: [48, 120],
      performanceBandMinFdvUsd: 60_000,
      performanceBandMaxFdvUsd: 180_000,
      performanceBatchLimit: 25,
      subscriptionsIntervalMs: 60_000,
      liquidityCollapseFractionBps: 1_500,
      retentionWindowMinutes: 30,
      cohortMinSize: 12,
      winnersRetroIntervalMs: 7_200_000,
      winnersMinMultipleBps: 30_000,
      winnersMinExitLiquidityUsd: 20_000,
      eligibilityMinFdvUsd: 12_000,
      eligibilityMaxFdvUsd: 110_000,
      eligibilityMinTotalLiquidityUsd: 6_000,
      eligibilityMinQuoteLiquidityUsd: 3_000,
      eligibilityMinUniqueBuyers: 18,
      eligibilityMinAgeMinutes: 7,
      redMinFdvUsd: 11_000,
      redMaxFdvUsd: 42_000,
      redMinLiquidityUsd: 3_500,
      redMinUniqueBuyers: 9,
      yellowMinFdvUsd: 41_000,
      yellowMaxFdvUsd: 99_000,
      yellowMinLiquidityUsd: 5_500,
      greenMinFdvUsd: 52_000,
      greenMaxFdvUsd: 88_000,
      greenMinUniqueBuyers: 26
    });
  });

  it("rejects a non-numeric poll interval instead of defaulting", () => {
    expect(() =>
      loadWorkerTuningFromEnv({ DISCOVERY_POLL_INTERVAL_MS: "fast" })
    ).toThrow(WorkerConfigError);
  });

  it("rejects a zero chunk size", () => {
    expect(() =>
      loadWorkerTuningFromEnv({ DISCOVERY_CHUNK_SIZE: "0" })
    ).toThrow(WorkerConfigError);
  });

  it("rejects negative confirmations but allows zero", () => {
    expect(() =>
      loadWorkerTuningFromEnv({ DISCOVERY_CONFIRMATIONS: "-1" })
    ).toThrow(WorkerConfigError);
    expect(
      loadWorkerTuningFromEnv({ DISCOVERY_CONFIRMATIONS: "0" }).confirmations
    ).toBe(0n);
  });

  it("rejects a negative alert min score but allows zero", () => {
    expect(() => loadWorkerTuningFromEnv({ ALERT_MIN_SCORE: "-5" })).toThrow(
      WorkerConfigError
    );
    expect(loadWorkerTuningFromEnv({ ALERT_MIN_SCORE: "0" }).alertMinScore).toBe(
      0
    );
  });

  it("rejects malformed enrichment tuning", () => {
    expect(() =>
      loadWorkerTuningFromEnv({ ENRICHMENT_INTERVAL_MS: "0" })
    ).toThrow(WorkerConfigError);
    expect(() =>
      loadWorkerTuningFromEnv({ ENRICHMENT_CONCURRENCY: "wide" })
    ).toThrow(WorkerConfigError);
    expect(() =>
      loadWorkerTuningFromEnv({ ACTIVITY_POLL_INTERVAL_MS: "0" })
    ).toThrow(WorkerConfigError);
    expect(() =>
      loadWorkerTuningFromEnv({ ACTIVITY_CHUNK_SIZE: "0" })
    ).toThrow(WorkerConfigError);
    expect(() =>
      loadWorkerTuningFromEnv({ ACTIVITY_CONFIRMATIONS: "-1" })
    ).toThrow(WorkerConfigError);
  });

  it("rejects a malformed horizons list instead of defaulting", () => {
    expect(() =>
      loadWorkerTuningFromEnv({ OUTCOME_HORIZONS_HOURS: "24,soon" })
    ).toThrow(WorkerConfigError);
    expect(() =>
      loadWorkerTuningFromEnv({ OUTCOME_HORIZONS_HOURS: "0,24" })
    ).toThrow(WorkerConfigError);
  });
});

describe("loadDatabaseUrlFromEnv", () => {
  it("returns the configured URL", () => {
    expect(loadDatabaseUrlFromEnv({ DATABASE_URL: "postgres://x" })).toBe(
      "postgres://x"
    );
  });

  it("rejects a missing or empty URL", () => {
    expect(() => loadDatabaseUrlFromEnv({})).toThrow(WorkerConfigError);
    expect(() => loadDatabaseUrlFromEnv({ DATABASE_URL: " " })).toThrow(
      WorkerConfigError
    );
  });
});

describe("loadOperatorWalletsFromEnv", () => {
  it("returns empty when unset or blank", () => {
    expect(loadOperatorWalletsFromEnv({})).toEqual([]);
    expect(loadOperatorWalletsFromEnv({ OPERATOR_WALLET_ADDRESSES: "  " })).toEqual([]);
  });

  it("parses and checksums a comma-separated list", () => {
    const wallets = loadOperatorWalletsFromEnv({
      OPERATOR_WALLET_ADDRESSES:
        "0x30b0a6c97cf015495e022219ba0f9a3787c90177, 0x8a36aab432cb2926c6f05f8761800eae0cdbd010"
    });
    expect(wallets).toEqual([
      "0x30B0A6c97Cf015495e022219bA0F9a3787c90177",
      "0x8a36AaB432cB2926c6f05F8761800eaE0Cdbd010"
    ]);
  });

  it("hard-fails on a malformed address instead of silently blinding detection", () => {
    expect(() =>
      loadOperatorWalletsFromEnv({ OPERATOR_WALLET_ADDRESSES: "0xnope" })
    ).toThrow(WorkerConfigError);
  });
});
