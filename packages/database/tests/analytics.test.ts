import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANALYTICS_REALIZED_HORIZON_HOURS,
  PRECISION_SCORE_FLOORS,
  foldPrecisionCurve,
  getFeatureQuartiles,
  getFunnelSummary,
  getJudgmentQuality,
  getLaunchCadence,
  getRecentAlertOutcomes,
  getScorePrecision,
  getSurvivalByHorizon,
  insertAlertSent,
  insertEligibilityResult,
  insertJudgmentBrief,
  insertPools,
  insertScoreResult,
  insertTokenPerformance,
  insertTokens,
  type AlertSentInsert,
  type Db,
  type JudgmentBriefInsert,
  type PoolInsert,
  type TokenEligibilityResultInsert,
  type TokenInsert,
  type TokenPerformanceInsert,
  type TokenScoreResultInsert
} from "../src/index.js";
import * as schema from "../src/schema.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

const CHAIN_ID = 4663;
const OTHER_CHAIN_ID = 8453;
const T0 = new Date("2026-06-01T00:00:00.000Z");

function minutes(n: number): Date {
  return new Date(T0.getTime() + n * 60_000);
}

function poolFixture(
  poolAddress: string,
  overrides: Partial<PoolInsert> = {}
): PoolInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress,
    factoryAddress: "0xFactory",
    dex: "uniswap",
    factoryKind: "uniswap-v2",
    token0Address: "0xQuote",
    token1Address: "0xBase",
    createdAtBlock: 1n,
    createdTxHash: `0xcreate${poolAddress}`,
    createdLogIndex: 0,
    discoveredAt: T0,
    ...overrides
  };
}

function tokenFixture(
  address: string,
  overrides: Partial<TokenInsert> = {}
): TokenInsert {
  return {
    chainId: CHAIN_ID,
    address,
    firstSeenBlock: 1n,
    name: "Token",
    symbol: "TKN",
    decimals: 18,
    ...overrides
  };
}

function performanceFixture(
  tokenAddress: string,
  poolAddress: string,
  horizonHours: number,
  overrides: Partial<TokenPerformanceInsert> = {}
): TokenPerformanceInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress,
    poolAddress,
    horizonHours,
    bandMinFdvUsd: "50000",
    bandMaxFdvUsd: "200000",
    enteredAt: T0,
    entryBlock: 1n,
    entryPriceUsd: "0.001",
    entryFdvUsd: "100000",
    maxMultipleBps: 15000,
    maxDrawdownBps: 1000,
    minutesToPeak: 30,
    snapshotsInWindow: 5,
    entryFeatures: {},
    details: {},
    ...overrides
  };
}

function scoreFixture(
  tokenAddress: string,
  poolAddress: string,
  scoredAt: Date,
  overrides: Partial<TokenScoreResultInsert> = {}
): TokenScoreResultInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress,
    poolAddress,
    blockNumber: 1n,
    scoredAt,
    eligible: true,
    score: 72,
    components: {},
    alertLevel: "YELLOW",
    positiveReasons: [],
    riskReasons: [],
    ...overrides
  };
}

function eligibilityFixture(
  tokenAddress: string,
  poolAddress: string,
  evaluatedAt: Date,
  overrides: Partial<TokenEligibilityResultInsert> = {}
): TokenEligibilityResultInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress,
    poolAddress,
    blockNumber: 1n,
    evaluatedAt,
    eligible: true,
    failedRules: [],
    reasons: ["All eligibility requirements are satisfied"],
    features: { tokenAddress },
    ...overrides
  };
}

function alertFixture(
  tokenAddress: string,
  poolAddress: string,
  sentAt: Date,
  overrides: Partial<AlertSentInsert> = {}
): AlertSentInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress,
    poolAddress,
    alertLevel: "YELLOW",
    score: 72,
    sentAt,
    reason: "score increase",
    transport: "telegram",
    delivered: true,
    ...overrides
  };
}

function judgmentFixture(
  tokenAddress: string,
  poolAddress: string,
  overrides: Partial<JudgmentBriefInsert> = {}
): JudgmentBriefInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress,
    poolAddress,
    mode: "LIVE",
    alertId: null,
    evalRunId: null,
    asOf: T0,
    promptName: "research-brief",
    promptVersion: 1,
    templateHash: "hash-v1",
    model: "test-model",
    status: "COMPLETED",
    thesis: "thesis text",
    confidenceBps: 5000,
    recommendation: "WATCH",
    createdAt: T0,
    ...overrides
  };
}

describe("analytics", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  describe("empty database", () => {
    it("returns zero/empty shapes for every query, JSON-safe", async () => {
      const funnel = await getFunnelSummary(db, CHAIN_ID);
      expect(funnel).toEqual({
        pools: 0,
        trustedQuotePools: 0,
        bandEntrantPools: 0,
        eligibleTokens: 0,
        alertedTokens: { RED: 0, YELLOW: 0, GREEN: 0 }
      });
      expect(JSON.parse(JSON.stringify(funnel))).toEqual(funnel);

      const cadence = await getLaunchCadence(db, CHAIN_ID, 30);
      expect(cadence).toEqual([]);
      expect(JSON.parse(JSON.stringify(cadence))).toEqual(cadence);

      const precision = await getScorePrecision(db, CHAIN_ID, 72);
      expect(precision.horizonHours).toBe(72);
      expect(precision.scored).toBe(0);
      expect(precision.unscored).toBe(0);
      expect(precision.points).toHaveLength(11);
      for (const point of precision.points) {
        expect(point.n).toBe(0);
        expect(point.share2x).toBe(0);
        expect(point.share5x).toBe(0);
        expect(point.share10x).toBe(0);
      }
      expect(JSON.parse(JSON.stringify(precision))).toEqual(precision);

      const quartiles = await getFeatureQuartiles(
        db,
        CHAIN_ID,
        72,
        "quoteLiquidityUsd"
      );
      expect(quartiles).toEqual({
        feature: "quoteLiquidityUsd",
        horizonHours: 72,
        nullRows: 0,
        buckets: []
      });
      expect(JSON.parse(JSON.stringify(quartiles))).toEqual(quartiles);

      const survival = await getSurvivalByHorizon(db, CHAIN_ID);
      expect(survival).toEqual([]);
      expect(JSON.parse(JSON.stringify(survival))).toEqual(survival);

      const alerts = await getRecentAlertOutcomes(db, CHAIN_ID, 50);
      expect(alerts).toEqual([]);
      expect(JSON.parse(JSON.stringify(alerts))).toEqual(alerts);

      const judgment = await getJudgmentQuality(db, CHAIN_ID);
      expect(judgment).toEqual({ versions: [], weekly: [] });
      expect(JSON.parse(JSON.stringify(judgment))).toEqual(judgment);
    });
  });

  describe("getScorePrecision", () => {
    it("excludes late as-of scores, computes floor shares, and scopes by chain", async () => {
      // Only score is scored 20 minutes after entry, past the 15-minute
      // as-of grace, so it must land in `unscored`, not the curve.
      await insertTokenPerformance(
        db,
        performanceFixture("0xLateToken", "0xLatePool", 72, {
          maxMultipleBps: 5000
        })
      );
      await insertScoreResult(
        db,
        scoreFixture("0xLateToken", "0xLatePool", minutes(20), { score: 90 })
      );

      // Winner: scored in-window, realized >= 10x.
      await insertTokenPerformance(
        db,
        performanceFixture("0xWinnerToken", "0xWinnerPool", 72, {
          maxMultipleBps: 150_000
        })
      );
      await insertScoreResult(
        db,
        scoreFixture("0xWinnerToken", "0xWinnerPool", minutes(10), {
          score: 85
        })
      );

      // Loser: scored in-window, realized well under 2x.
      await insertTokenPerformance(
        db,
        performanceFixture("0xLoserToken", "0xLoserPool", 72, {
          maxMultipleBps: 5000
        })
      );
      await insertScoreResult(
        db,
        scoreFixture("0xLoserToken", "0xLoserPool", minutes(10), {
          score: 55
        })
      );

      // Different chain: must be excluded entirely, not just from the curve.
      await insertTokenPerformance(
        db,
        performanceFixture("0xOtherChainToken", "0xOtherChainPool", 72, {
          chainId: OTHER_CHAIN_ID,
          maxMultipleBps: 200_000
        })
      );
      await insertScoreResult(
        db,
        scoreFixture("0xOtherChainToken", "0xOtherChainPool", minutes(10), {
          chainId: OTHER_CHAIN_ID,
          score: 95
        })
      );

      const curve = await getScorePrecision(db, CHAIN_ID, 72);

      expect(curve.scored).toBe(2);
      expect(curve.unscored).toBe(1);

      const floor70 = curve.points.find((point) => point.floor === 70);
      expect(floor70).toEqual({
        floor: 70,
        n: 1,
        share2x: 1,
        share5x: 1,
        share10x: 1
      });

      const floor0 = curve.points.find((point) => point.floor === 0);
      expect(floor0?.n).toBe(2);
      expect(floor0?.share10x).toBe(0.5);
    });
  });

  describe("foldPrecisionCurve", () => {
    it("reports all-zero shares, never NaN, for an empty pair set", () => {
      const points = foldPrecisionCurve([], PRECISION_SCORE_FLOORS);

      expect(points).toHaveLength(11);
      for (const point of points) {
        expect(point.n).toBe(0);
        expect(point.share2x).toBe(0);
        expect(point.share5x).toBe(0);
        expect(point.share10x).toBe(0);
        expect(Number.isNaN(point.share2x)).toBe(false);
        expect(Number.isNaN(point.share5x)).toBe(false);
        expect(Number.isNaN(point.share10x)).toBe(false);
      }
    });
  });

  describe("getFeatureQuartiles", () => {
    it("excludes missing/non-numeric rows from nullRows and splits the rest into even quartiles", async () => {
      const numericValues = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
      for (const [index, value] of numericValues.entries()) {
        await insertTokenPerformance(
          db,
          performanceFixture(
            `0xQuartileToken${index}`,
            `0xQuartilePool${index}`,
            72,
            {
              maxMultipleBps: 5000 + index * 10_000,
              entryFeatures: { quoteLiquidityUsd: value }
            }
          )
        );
      }

      // Missing key entirely.
      await insertTokenPerformance(
        db,
        performanceFixture("0xNullKeyToken", "0xNullKeyPool", 72, {
          entryFeatures: {}
        })
      );
      // Present but non-numeric.
      await insertTokenPerformance(
        db,
        performanceFixture("0xNonNumericToken", "0xNonNumericPool", 72, {
          entryFeatures: { quoteLiquidityUsd: "unknown" }
        })
      );

      const quartiles = await getFeatureQuartiles(
        db,
        CHAIN_ID,
        72,
        "quoteLiquidityUsd"
      );

      expect(quartiles.nullRows).toBe(2);
      expect(quartiles.buckets).toHaveLength(4);
      for (const bucket of quartiles.buckets) {
        expect(bucket.n).toBe(2);
      }

      const bucket1 = quartiles.buckets.find((bucket) => bucket.bucket === 1);
      const bucket4 = quartiles.buckets.find((bucket) => bucket.bucket === 4);
      expect(bucket1?.maxValue).toBeLessThanOrEqual(bucket4?.minValue ?? 0);
    });
  });

  describe("getRecentAlertOutcomes", () => {
    it("nulls realized fields without a performance label, nulls metadata without a token row, newest first", async () => {
      await insertTokens(
        db,
        [tokenFixture("0xLabeledToken", { name: "Labeled", symbol: "LBL" })]
      );
      await insertTokenPerformance(
        db,
        performanceFixture(
          "0xLabeledToken",
          "0xLabeledPool",
          ANALYTICS_REALIZED_HORIZON_HOURS,
          { maxMultipleBps: 45_000, maxDrawdownBps: 2000 }
        )
      );
      await insertAlertSent(
        db,
        alertFixture("0xLabeledToken", "0xLabeledPool", minutes(0))
      );

      // No tokens row and no performance row for this one.
      await insertAlertSent(
        db,
        alertFixture("0xUnknownToken", "0xUnknownPool", minutes(10))
      );

      const rows = await getRecentAlertOutcomes(db, CHAIN_ID, 50);
      expect(rows).toHaveLength(2);
      const [newest, oldest] = rows;

      expect(new Date(newest?.sentAt ?? 0).getTime()).toBe(
        minutes(10).getTime()
      );
      expect(newest?.tokenAddress).toBe("0xUnknownToken");
      expect(newest?.name).toBeNull();
      expect(newest?.symbol).toBeNull();
      expect(newest?.maxMultipleBps).toBeNull();
      expect(newest?.maxDrawdownBps).toBeNull();

      expect(new Date(oldest?.sentAt ?? 0).getTime()).toBe(
        minutes(0).getTime()
      );
      expect(oldest?.tokenAddress).toBe("0xLabeledToken");
      expect(oldest?.name).toBe("Labeled");
      expect(oldest?.symbol).toBe("LBL");
      expect(oldest?.maxMultipleBps).toBe(45_000);
      expect(oldest?.maxDrawdownBps).toBe(2000);
    });

    it("clamps limit to 200 even when a larger limit is requested", async () => {
      const rows: AlertSentInsert[] = [];
      for (let index = 0; index < 205; index += 1) {
        rows.push(
          alertFixture(
            `0xClampToken${index}`,
            `0xClampPool${index}`,
            minutes(index)
          )
        );
      }
      await db.insert(schema.alertsSent).values(rows);

      const result = await getRecentAlertOutcomes(db, CHAIN_ID, 500);
      expect(result).toHaveLength(200);
    });
  });

  describe("getFunnelSummary", () => {
    it("counts pools, distinct band-entrant pools, and distinct eligible/alerted tokens", async () => {
      await insertPools(db, [
        poolFixture("0xTrustedPool", { quoteTokenAddress: "0xQuote" }),
        poolFixture("0xUntrustedPool")
      ]);

      // Two horizons for the same pool must count as one band-entrant pool.
      await insertTokenPerformance(
        db,
        performanceFixture("0xBandToken", "0xTrustedPool", 24)
      );
      await insertTokenPerformance(
        db,
        performanceFixture("0xBandToken", "0xTrustedPool", 72)
      );

      // Two eligibility rows for the same token must count once.
      await insertEligibilityResult(
        db,
        eligibilityFixture("0xEligibleToken", "0xTrustedPool", minutes(0))
      );
      await insertEligibilityResult(
        db,
        eligibilityFixture("0xEligibleToken", "0xTrustedPool", minutes(5))
      );
      await insertEligibilityResult(
        db,
        eligibilityFixture("0xIneligibleToken", "0xTrustedPool", minutes(0), {
          eligible: false,
          failedRules: ["min-liquidity"]
        })
      );

      // Two RED alerts for the same token must count once at that level.
      await insertAlertSent(
        db,
        alertFixture("0xRedToken", "0xTrustedPool", minutes(0), {
          alertLevel: "RED"
        })
      );
      await insertAlertSent(
        db,
        alertFixture("0xRedToken", "0xTrustedPool", minutes(5), {
          alertLevel: "RED"
        })
      );
      await insertAlertSent(
        db,
        alertFixture("0xYellowToken", "0xTrustedPool", minutes(0), {
          alertLevel: "YELLOW"
        })
      );

      const funnel = await getFunnelSummary(db, CHAIN_ID);

      expect(funnel.pools).toBe(2);
      expect(funnel.trustedQuotePools).toBe(1);
      expect(funnel.bandEntrantPools).toBe(1);
      expect(funnel.eligibleTokens).toBe(1);
      expect(funnel.alertedTokens).toEqual({ RED: 1, YELLOW: 1, GREEN: 0 });
    });
  });

  describe("getJudgmentQuality", () => {
    it("excludes REPLAY briefs and nulls avgConfidenceBps for versions with no COMPLETED briefs", async () => {
      await insertJudgmentBrief(
        db,
        judgmentFixture("0xToken1", "0xPool1", {
          promptVersion: 1,
          status: "COMPLETED",
          confidenceBps: 8000,
          alertId: 1n
        })
      );
      await insertJudgmentBrief(
        db,
        judgmentFixture("0xToken2", "0xPool2", {
          promptVersion: 1,
          status: "COMPLETED",
          confidenceBps: 9000,
          alertId: 2n
        })
      );
      await insertJudgmentBrief(
        db,
        judgmentFixture("0xToken3", "0xPool3", {
          promptVersion: 1,
          status: "REJECTED_FABRICATED_CITATION",
          confidenceBps: null,
          alertId: 3n
        })
      );
      // REPLAY row for the same version, with a confidence value that would
      // corrupt the LIVE average if it leaked in.
      await insertJudgmentBrief(
        db,
        judgmentFixture("0xToken1", "0xPool1", {
          promptVersion: 1,
          mode: "REPLAY",
          status: "COMPLETED",
          confidenceBps: 1,
          alertId: null,
          evalRunId: 1n
        })
      );
      // A version with only a FAILED brief.
      await insertJudgmentBrief(
        db,
        judgmentFixture("0xToken4", "0xPool4", {
          promptVersion: 2,
          status: "FAILED",
          confidenceBps: null,
          alertId: 4n
        })
      );

      const quality = await getJudgmentQuality(db, CHAIN_ID);

      const v1 = quality.versions.find((v) => v.promptVersion === 1);
      expect(v1).toEqual({
        promptVersion: 1,
        completed: 2,
        rejectedFabricated: 1,
        failed: 0,
        avgConfidenceBps: 8500
      });

      const v2 = quality.versions.find((v) => v.promptVersion === 2);
      expect(v2).toEqual({
        promptVersion: 2,
        completed: 0,
        rejectedFabricated: 0,
        failed: 1,
        avgConfidenceBps: null
      });
    });
  });
});
