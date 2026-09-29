import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  countUntrustedPoolsCreatedSince,
  getShadowDecisionAsOf,
  hasAlertBefore,
  insertAlertSent,
  insertEligibilityResult,
  insertPools,
  insertScoreResult,
  insertTokenPerformance,
  insertWinnerRetroItems,
  listWinnerCandidatePerformance,
  listWinnerRetroItems,
  type AlertSentInsert,
  type Db,
  type PoolInsert,
  type TokenEligibilityResultInsert,
  type TokenPerformanceInsert,
  type TokenScoreResultInsert,
  type WinnerRetroItemInsert
} from "../src/index.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

const CHAIN_ID = 9191;
const T0 = new Date("2024-06-01T00:00:00.000Z");

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
    quoteTokenAddress: "0xQuote",
    baseTokenAddress: "0xBase",
    createdAtBlock: 1n,
    createdTxHash: `0xcreate${poolAddress}`,
    createdLogIndex: 0,
    discoveredAt: T0,
    ...overrides
  };
}

function performanceFixture(
  poolAddress: string,
  horizonHours: number,
  overrides: Partial<TokenPerformanceInsert> = {}
): TokenPerformanceInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress: "0xToken1",
    poolAddress,
    horizonHours,
    bandMinFdvUsd: "50000",
    bandMaxFdvUsd: "200000",
    enteredAt: T0,
    entryBlock: 1n,
    entryPriceUsd: "0.001",
    entryFdvUsd: "100000",
    maxMultipleBps: 60_000,
    maxDrawdownBps: 1000,
    minutesToPeak: 30,
    snapshotsInWindow: 5,
    entryFeatures: {},
    labeledAt: T0,
    details: {},
    ...overrides
  };
}

function winnerRetroItemFixture(
  poolAddress: string,
  horizonHours: number,
  overrides: Partial<WinnerRetroItemInsert> = {}
): WinnerRetroItemInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress: "0xToken1",
    poolAddress,
    horizonHours,
    entryAt: T0,
    entryFdvUsd: "100000",
    wickMultipleBps: 60_000,
    sustainedMultipleBps: 55_000,
    exitQuoteLiquidityUsd: "20000",
    minutesToSustainedPeak: 45,
    provisional: true,
    coverageTier: 7,
    tierLabel: "caught",
    alerted: true,
    gateAttribution: {
      source: "shadow",
      eligible: true,
      failedRules: [],
      softFailedRules: [],
      score: 80,
      alertLevel: "YELLOW",
      floor: 50
    },
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

describe("winners-retro repositories", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  describe("listWinnerCandidatePerformance", () => {
    it("excludes pools already retroed for that horizon and respects the multiple floor", async () => {
      await insertPools(db, [
        poolFixture("0xPoolAlreadyRetroed"),
        poolFixture("0xPoolBelowFloor"),
        poolFixture("0xPoolCandidate")
      ]);
      await insertTokenPerformance(
        db,
        performanceFixture("0xPoolAlreadyRetroed", 24, { maxMultipleBps: 70_000 })
      );
      await insertTokenPerformance(
        db,
        performanceFixture("0xPoolBelowFloor", 24, { maxMultipleBps: 40_000 })
      );
      await insertTokenPerformance(
        db,
        performanceFixture("0xPoolCandidate", 72, { maxMultipleBps: 80_000 })
      );
      // Already-autopsied: same (chainId, poolAddress, horizonHours) key.
      await insertWinnerRetroItems(db, [
        winnerRetroItemFixture("0xPoolAlreadyRetroed", 24)
      ]);

      const candidates = await listWinnerCandidatePerformance(
        db,
        CHAIN_ID,
        50_000,
        10
      );

      expect(candidates.map((row) => row.poolAddress)).toEqual([
        "0xPoolCandidate"
      ]);
    });

    it("orders candidates by labeledAt ascending and respects the limit", async () => {
      await insertPools(db, [
        poolFixture("0xPoolLater"),
        poolFixture("0xPoolEarlier")
      ]);
      await insertTokenPerformance(
        db,
        performanceFixture("0xPoolLater", 24, { labeledAt: minutes(60) })
      );
      await insertTokenPerformance(
        db,
        performanceFixture("0xPoolEarlier", 24, { labeledAt: minutes(10) })
      );

      const candidates = await listWinnerCandidatePerformance(
        db,
        CHAIN_ID,
        50_000,
        1
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.poolAddress).toBe("0xPoolEarlier");
    });
  });

  describe("insertWinnerRetroItems / listWinnerRetroItems", () => {
    it("is idempotent on (chainId, poolAddress, horizonHours) and RETURNING reports only first-time inserts", async () => {
      const firstBatch = await insertWinnerRetroItems(db, [
        winnerRetroItemFixture("0xPoolA", 24, { sustainedMultipleBps: 55_000 })
      ]);
      expect(firstBatch).toHaveLength(1);
      expect(firstBatch[0]?.sustainedMultipleBps).toBe(55_000);

      // Same key, different payload: conflict is dropped, nothing returned.
      const secondBatch = await insertWinnerRetroItems(db, [
        winnerRetroItemFixture("0xPoolA", 24, { sustainedMultipleBps: 99_999 })
      ]);
      expect(secondBatch).toEqual([]);

      const rows = await listWinnerRetroItems(db, CHAIN_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.sustainedMultipleBps).toBe(55_000);
    });

    it("reports only the new rows when a batch mixes new and already-present keys", async () => {
      await insertWinnerRetroItems(db, [winnerRetroItemFixture("0xPoolA", 24)]);

      const batch = await insertWinnerRetroItems(db, [
        winnerRetroItemFixture("0xPoolA", 24), // already present
        winnerRetroItemFixture("0xPoolB", 24), // new
        winnerRetroItemFixture("0xPoolA", 72) // new (different horizon)
      ]);

      expect(batch.map((row) => `${row.poolAddress}:${row.horizonHours}`).sort()).toEqual(
        ["0xPoolA:72", "0xPoolB:24"].sort()
      );
    });

    it("listWinnerRetroItems filters by since and respects limit, newest first", async () => {
      await insertWinnerRetroItems(db, [
        winnerRetroItemFixture("0xPoolOld", 24, {
          entryAt: minutes(0)
        })
      ]);
      await insertWinnerRetroItems(db, [
        winnerRetroItemFixture("0xPoolNew", 24, {
          entryAt: minutes(10)
        })
      ]);

      const all = await listWinnerRetroItems(db, CHAIN_ID);
      expect(all.map((row) => row.poolAddress)).toEqual([
        "0xPoolNew",
        "0xPoolOld"
      ]);

      const limited = await listWinnerRetroItems(db, CHAIN_ID, { limit: 1 });
      expect(limited).toHaveLength(1);
      expect(limited[0]?.poolAddress).toBe("0xPoolNew");
    });
  });

  describe("countUntrustedPoolsCreatedSince", () => {
    it("counts only untrusted pools discovered at or after the cutoff", async () => {
      const cutoff = minutes(100);
      await insertPools(db, [
        // Trusted quote, after cutoff: excluded (not untrusted).
        poolFixture("0xTrustedNew", {
          discoveredAt: minutes(150)
        }),
        // Untrusted, before cutoff: excluded (too old).
        poolFixture("0xUntrustedOld", {
          quoteTokenAddress: null,
          baseTokenAddress: null,
          discoveredAt: minutes(50)
        }),
        // Untrusted, at the cutoff exactly: included (>= since).
        poolFixture("0xUntrustedAtCutoff", {
          quoteTokenAddress: null,
          baseTokenAddress: null,
          discoveredAt: cutoff
        }),
        // Untrusted, after cutoff: included.
        poolFixture("0xUntrustedNew", {
          quoteTokenAddress: null,
          baseTokenAddress: null,
          discoveredAt: minutes(200)
        })
      ]);

      const censusCount = await countUntrustedPoolsCreatedSince(
        db,
        CHAIN_ID,
        cutoff
      );

      expect(censusCount).toBe(2);
    });
  });

  describe("getShadowDecisionAsOf", () => {
    it("returns the nearest-in-window eligibility/score pair", async () => {
      await insertEligibilityResult(
        db,
        eligibilityFixture("0xToken1", "0xPoolA", minutes(10), {
          eligible: false,
          failedRules: ["minQuoteLiquidity"]
        })
      );
      await insertScoreResult(
        db,
        scoreFixture("0xToken1", "0xPoolA", minutes(10), {
          score: 12,
          alertLevel: "GRAY"
        })
      );
      // A later, out-of-window pair for the same token — must not win.
      await insertEligibilityResult(
        db,
        eligibilityFixture("0xToken1", "0xPoolA", minutes(500))
      );
      await insertScoreResult(
        db,
        scoreFixture("0xToken1", "0xPoolA", minutes(500))
      );

      const decision = await getShadowDecisionAsOf(
        db,
        CHAIN_ID,
        "0xToken1",
        minutes(15),
        10 * 60_000 // 10 minute window
      );

      expect(decision).toBeDefined();
      expect(decision?.eligible).toBe(false);
      expect(decision?.failedRules).toEqual(["minQuoteLiquidity"]);
      expect(decision?.score).toBe(12);
      expect(decision?.alertLevel).toBe("GRAY");
      // Not persisted on token_eligibility_results (see repositories.ts doc).
      expect(decision?.softFailedRules).toEqual([]);
    });

    it("returns undefined when the nearest eligibility row falls outside the window", async () => {
      await insertEligibilityResult(
        db,
        eligibilityFixture("0xToken1", "0xPoolA", minutes(10))
      );
      await insertScoreResult(
        db,
        scoreFixture("0xToken1", "0xPoolA", minutes(10))
      );

      const decision = await getShadowDecisionAsOf(
        db,
        CHAIN_ID,
        "0xToken1",
        minutes(100),
        10 * 60_000 // 10 minute window: minutes(10) is 90 minutes before `at`
      );

      expect(decision).toBeUndefined();
    });

    it("returns undefined when the token has never been scored", async () => {
      await insertEligibilityResult(
        db,
        eligibilityFixture("0xToken1", "0xPoolA", minutes(10))
      );

      const decision = await getShadowDecisionAsOf(
        db,
        CHAIN_ID,
        "0xToken1",
        minutes(15),
        10 * 60_000
      );

      expect(decision).toBeUndefined();
    });
  });

  describe("hasAlertBefore", () => {
    it("is true at the boundary instant and false strictly before the first alert", async () => {
      await insertAlertSent(
        db,
        alertFixture("0xToken1", "0xPoolA", minutes(20))
      );

      expect(
        await hasAlertBefore(db, CHAIN_ID, "0xToken1", minutes(20))
      ).toBe(true);
      expect(
        await hasAlertBefore(db, CHAIN_ID, "0xToken1", minutes(21))
      ).toBe(true);
      expect(
        await hasAlertBefore(db, CHAIN_ID, "0xToken1", minutes(19))
      ).toBe(false);
    });

    it("is false when no alert exists for the token", async () => {
      expect(
        await hasAlertBefore(db, CHAIN_ID, "0xTokenNoAlerts", minutes(999))
      ).toBe(false);
    });
  });
});
