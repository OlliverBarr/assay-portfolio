import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getCohortPercentiles,
  getDeployerLaunchStats,
  getEarlyBuyerRetention,
  getLiquidityTrajectory,
  getPoolsDueForOutcome,
  getSimulationRegression,
  getTokenOutcomes,
  insertPoolActivitySnapshots,
  insertPools,
  insertPoolSnapshots,
  insertPoolSwapEvents,
  insertTokenOutcome,
  insertTokens,
  insertTradeSimulation,
  upsertTokenHolders,
  type Db,
  type PoolInsert,
  type PoolSnapshotInsert,
  type TokenOutcomeInsert
} from "../src/index.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

const CHAIN_ID = 8181;
const T0 = new Date("2024-01-01T00:00:00.000Z");

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
    ...overrides
  };
}

function snapshotFixture(
  poolAddress: string,
  capturedAt: Date,
  overrides: Partial<PoolSnapshotInsert> = {}
): PoolSnapshotInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress,
    blockNumber: 1n,
    capturedAt,
    calculationMethod: "v2-reserves",
    ...overrides
  };
}

describe("signals repositories", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  describe("getLiquidityTrajectory", () => {
    it("returns undefined when the pool has no snapshots", async () => {
      await insertPools(db, [poolFixture("0xPoolNone")]);
      expect(
        await getLiquidityTrajectory(db, CHAIN_ID, "0xPoolNone")
      ).toBeUndefined();
    });

    it("handles a single snapshot with zero drawdown and zero duration", async () => {
      await insertPools(db, [poolFixture("0xPoolSingle")]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xPoolSingle", T0, { quoteLiquidityUsd: "1000" })
      ]);
      const trajectory = await getLiquidityTrajectory(db, CHAIN_ID, "0xPoolSingle");
      expect(trajectory).not.toBeUndefined();
      expect(Number(trajectory?.peakQuoteLiquidityUsd)).toBe(1000);
      expect(Number(trajectory?.latestQuoteLiquidityUsd)).toBe(1000);
      expect(trajectory?.drawdownBps).toBe(0);
      expect(trajectory?.minutesAbove80PctPeak).toBe(0);
      expect(trajectory?.snapshotCount).toBe(1);
      expect(trajectory?.firstCapturedAt).toEqual(T0);
    });

    it("computes drawdown and time above 80% of peak from consecutive gaps", async () => {
      await insertPools(db, [poolFixture("0xPoolMulti")]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xPoolMulti", minutes(0), { quoteLiquidityUsd: "1000" }),
        snapshotFixture("0xPoolMulti", minutes(10), { quoteLiquidityUsd: "2000" }), // peak
        snapshotFixture("0xPoolMulti", minutes(20), { quoteLiquidityUsd: "1800" }),
        snapshotFixture("0xPoolMulti", minutes(40), { quoteLiquidityUsd: "1200" })
      ]);
      const trajectory = await getLiquidityTrajectory(db, CHAIN_ID, "0xPoolMulti");
      expect(Number(trajectory?.peakQuoteLiquidityUsd)).toBe(2000);
      expect(Number(trajectory?.latestQuoteLiquidityUsd)).toBe(1200);
      expect(trajectory?.drawdownBps).toBe(4000);
      // Threshold = 1600. Gap [0,10) has left value 1000 (< threshold, not
      // counted). Gap [10,20) has left value 2000 (counted, 10min). Gap
      // [20,40) has left value 1800 (counted, 20min). Total 30.
      expect(trajectory?.minutesAbove80PctPeak).toBe(30);
      expect(trajectory?.snapshotCount).toBe(4);
      expect(trajectory?.firstCapturedAt).toEqual(minutes(0));
    });

    it("treats a collapse as a near-total drawdown from peak", async () => {
      await insertPools(db, [poolFixture("0xPoolCollapse")]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xPoolCollapse", minutes(0), { quoteLiquidityUsd: "10000" }),
        snapshotFixture("0xPoolCollapse", minutes(60), { quoteLiquidityUsd: "1500" })
      ]);
      const trajectory = await getLiquidityTrajectory(db, CHAIN_ID, "0xPoolCollapse");
      expect(trajectory?.drawdownBps).toBe(8500);
      expect(Number(trajectory?.latestQuoteLiquidityUsd)).toBe(1500);
    });

    it("excludes null-valued snapshots from peak/drawdown but keeps the count", async () => {
      await insertPools(db, [poolFixture("0xPoolNullable")]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xPoolNullable", minutes(0), {
          quoteLiquidityUsd: null,
          nullReason: "zero-liquidity"
        }),
        snapshotFixture("0xPoolNullable", minutes(5), { quoteLiquidityUsd: "500" })
      ]);
      const trajectory = await getLiquidityTrajectory(db, CHAIN_ID, "0xPoolNullable");
      expect(trajectory?.snapshotCount).toBe(2);
      expect(trajectory?.firstCapturedAt).toEqual(minutes(0));
      expect(Number(trajectory?.peakQuoteLiquidityUsd)).toBe(500);
      expect(Number(trajectory?.latestQuoteLiquidityUsd)).toBe(500);
      expect(trajectory?.drawdownBps).toBe(0);
      expect(trajectory?.minutesAbove80PctPeak).toBe(0);
    });

    it("returns undefined when every snapshot value is null", async () => {
      await insertPools(db, [poolFixture("0xPoolAllNull")]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xPoolAllNull", minutes(0), {
          quoteLiquidityUsd: null,
          nullReason: "no-usd-anchor"
        })
      ]);
      expect(
        await getLiquidityTrajectory(db, CHAIN_ID, "0xPoolAllNull")
      ).toBeUndefined();
    });
  });

  describe("getSimulationRegression", () => {
    function simFixture(
      tokenAddress: string,
      simulatedAt: Date,
      status: "PASS" | "FAIL" | "UNKNOWN"
    ) {
      return {
        chainId: CHAIN_ID,
        tokenAddress,
        poolAddress: "0xPool",
        blockNumber: 1n,
        simulatedAt,
        route: "uniswap-v2",
        buyStatus: status,
        transferStatus: status,
        sellStatus: status,
        status
      };
    }

    it("returns undefined with no simulations", async () => {
      expect(
        await getSimulationRegression(db, CHAIN_ID, "0xTokenNone")
      ).toBeUndefined();
    });

    it("flags a regression when a prior PASS is followed by a FAIL", async () => {
      await insertTradeSimulation(db, simFixture("0xTokenReg", minutes(0), "PASS"));
      await insertTradeSimulation(db, simFixture("0xTokenReg", minutes(10), "PASS"));
      await insertTradeSimulation(db, simFixture("0xTokenReg", minutes(20), "FAIL"));
      const regression = await getSimulationRegression(db, CHAIN_ID, "0xTokenReg");
      expect(regression).toEqual({
        latestStatus: "FAIL",
        priorPassCount: 2,
        regressed: true
      });
    });

    it("does not flag a regression when the latest run passes", async () => {
      await insertTradeSimulation(db, simFixture("0xTokenOk", minutes(0), "FAIL"));
      await insertTradeSimulation(db, simFixture("0xTokenOk", minutes(10), "PASS"));
      const regression = await getSimulationRegression(db, CHAIN_ID, "0xTokenOk");
      expect(regression).toEqual({
        latestStatus: "PASS",
        priorPassCount: 0,
        regressed: false
      });
    });

    it("does not flag a regression when nothing ever passed", async () => {
      await insertTradeSimulation(db, simFixture("0xTokenFail", minutes(0), "FAIL"));
      const regression = await getSimulationRegression(db, CHAIN_ID, "0xTokenFail");
      expect(regression).toEqual({
        latestStatus: "FAIL",
        priorPassCount: 0,
        regressed: false
      });
    });
  });

  describe("getEarlyBuyerRetention", () => {
    function swapFixture(
      poolAddress: string,
      observedAt: Date,
      logIndex: number,
      side: "BUY" | "SELL",
      recipient: string
    ) {
      return {
        chainId: CHAIN_ID,
        poolAddress,
        factoryKind: "uniswap-v2",
        blockNumber: 1n,
        transactionHash: `0xtx${poolAddress}${logIndex}`,
        logIndex,
        sender: recipient,
        recipient,
        token0AmountRaw: "1",
        token1AmountRaw: "1",
        baseAmountRaw: "1",
        quoteAmountRaw: "1",
        side,
        quoteTokenAddress: "0xQuote",
        baseTokenAddress: "0xBase",
        observedAt
      };
    }

    it("returns undefined when the pool has no stored swaps", async () => {
      expect(
        await getEarlyBuyerRetention(db, CHAIN_ID, "0xPoolNoSwaps", "0xToken", 20)
      ).toBeUndefined();
    });

    it("counts distinct early buyers and how many still hold a balance", async () => {
      const pool = "0xPoolRetention";
      const token = "0xTokenRetention";
      await insertPoolSwapEvents(db, [
        swapFixture(pool, minutes(0), 0, "BUY", "0xBuyerA"),
        // Duplicate BUY from the same buyer inside the window; distinct
        // recipients must not double-count.
        swapFixture(pool, minutes(2), 1, "BUY", "0xBuyerA"),
        swapFixture(pool, minutes(5), 2, "BUY", "0xBuyerB"),
        swapFixture(pool, minutes(5), 3, "SELL", "0xBuyerA"),
        // Outside the 20-minute window from the first swap.
        swapFixture(pool, minutes(25), 4, "BUY", "0xBuyerC")
      ]);
      await upsertTokenHolders(db, [
        { chainId: CHAIN_ID, tokenAddress: token, holderAddress: "0xBuyerA", balanceRaw: "0", updatedBlock: 1n },
        { chainId: CHAIN_ID, tokenAddress: token, holderAddress: "0xBuyerB", balanceRaw: "500", updatedBlock: 1n }
      ]);
      const retention = await getEarlyBuyerRetention(db, CHAIN_ID, pool, token, 20);
      expect(retention).toEqual({ earlyBuyers: 2, stillHolding: 1 });
    });
  });

  describe("getDeployerLaunchStats", () => {
    it("returns zeroes for a deployer with no other tokens", async () => {
      await insertTokens(db, [
        { chainId: CHAIN_ID, address: "0xCandidateOnly", firstSeenBlock: 1n, deployerAddress: "0xLoneDeployer" }
      ]);
      const stats = await getDeployerLaunchStats(db, CHAIN_ID, "0xLoneDeployer", "0xCandidateOnly");
      expect(stats).toEqual({ tokenCount: 0, survived: 0, died: 0 });
    });

    it("splits prior tokens into survived/died/pending, excluding the candidate", async () => {
      const deployer = "0xSerialDeployer";
      await insertTokens(db, [
        { chainId: CHAIN_ID, address: "0xCandidate", firstSeenBlock: 1n, deployerAddress: deployer },
        { chainId: CHAIN_ID, address: "0xSurvivor", firstSeenBlock: 1n, deployerAddress: deployer },
        { chainId: CHAIN_ID, address: "0xCasualty", firstSeenBlock: 1n, deployerAddress: deployer },
        { chainId: CHAIN_ID, address: "0xPending", firstSeenBlock: 1n, deployerAddress: deployer },
        // A token that died at 24h then recovered by 72h must count as
        // survived only, never double-counted as died.
        { chainId: CHAIN_ID, address: "0xRecovered", firstSeenBlock: 1n, deployerAddress: deployer }
      ]);

      function outcome(
        tokenAddress: string,
        horizonHours: number,
        outcome: "SURVIVED" | "DIED"
      ): TokenOutcomeInsert {
        return {
          chainId: CHAIN_ID,
          tokenAddress,
          poolAddress: `0xPool${tokenAddress}${horizonHours}`,
          horizonHours,
          outcome,
          firstObservedAt: T0,
          details: {}
        };
      }
      await insertTokenOutcome(db, outcome("0xSurvivor", 24, "SURVIVED"));
      await insertTokenOutcome(db, outcome("0xCasualty", 24, "DIED"));
      await insertTokenOutcome(db, outcome("0xRecovered", 24, "DIED"));
      await insertTokenOutcome(db, outcome("0xRecovered", 72, "SURVIVED"));

      const stats = await getDeployerLaunchStats(db, CHAIN_ID, deployer, "0xCandidate");
      expect(stats).toEqual({ tokenCount: 4, survived: 2, died: 1 });
    });
  });

  describe("insertTokenOutcome / getTokenOutcomes", () => {
    it("is idempotent on (chain, pool, horizon) and never overwrites the first label", async () => {
      const row: TokenOutcomeInsert = {
        chainId: CHAIN_ID,
        tokenAddress: "0xTokenOutcome",
        poolAddress: "0xPoolOutcome",
        horizonHours: 24,
        outcome: "SURVIVED",
        firstObservedAt: T0,
        details: { peak: "1000" }
      };
      await insertTokenOutcome(db, row);
      await insertTokenOutcome(db, { ...row, outcome: "DIED" });

      const rows = await getTokenOutcomes(db, CHAIN_ID, "0xTokenOutcome");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe("SURVIVED");
    });

    it("returns outcomes for a token ordered by horizon", async () => {
      const token = "0xTokenMultiHorizon";
      await insertTokenOutcome(db, {
        chainId: CHAIN_ID,
        tokenAddress: token,
        poolAddress: "0xPoolMh",
        horizonHours: 72,
        outcome: "SURVIVED",
        firstObservedAt: T0,
        details: {}
      });
      await insertTokenOutcome(db, {
        chainId: CHAIN_ID,
        tokenAddress: token,
        poolAddress: "0xPoolMh",
        horizonHours: 24,
        outcome: "DIED",
        firstObservedAt: T0,
        details: {}
      });
      const rows = await getTokenOutcomes(db, CHAIN_ID, token);
      expect(rows.map((row) => row.horizonHours)).toEqual([24, 72]);
    });
  });

  describe("getPoolsDueForOutcome", () => {
    it("selects only old-enough, unlabeled pools for the given horizon", async () => {
      const now = new Date();
      const longAgo = new Date(now.getTime() - 30 * 60 * 60 * 1000);
      const recently = new Date(now.getTime() - 10 * 60 * 60 * 1000);
      const veryLongAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

      await insertPools(db, [
        poolFixture("0xDuePool", { createdAtBlock: 1n }),
        poolFixture("0xTooYoungPool", { createdAtBlock: 2n }),
        poolFixture("0xAlreadyLabeledPool", { createdAtBlock: 3n }),
        poolFixture("0xDueOtherHorizonPool", { createdAtBlock: 4n })
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xDuePool", longAgo),
        snapshotFixture("0xTooYoungPool", recently),
        snapshotFixture("0xAlreadyLabeledPool", veryLongAgo),
        snapshotFixture("0xDueOtherHorizonPool", veryLongAgo)
      ]);
      await insertTokenOutcome(db, {
        chainId: CHAIN_ID,
        tokenAddress: "0xTokenAlreadyLabeled",
        poolAddress: "0xAlreadyLabeledPool",
        horizonHours: 24,
        outcome: "SURVIVED",
        firstObservedAt: veryLongAgo,
        details: {}
      });
      // Labeled at a different horizon: still due for 24h.
      await insertTokenOutcome(db, {
        chainId: CHAIN_ID,
        tokenAddress: "0xTokenDueOtherHorizon",
        poolAddress: "0xDueOtherHorizonPool",
        horizonHours: 72,
        outcome: "SURVIVED",
        firstObservedAt: veryLongAgo,
        details: {}
      });

      const due = await getPoolsDueForOutcome(db, CHAIN_ID, 24, 10);
      const duePoolAddresses = due.map((row) => row.poolAddress).sort();
      expect(duePoolAddresses).toEqual(["0xDueOtherHorizonPool", "0xDuePool"].sort());
    });

    it("respects the limit", async () => {
      const veryLongAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await insertPools(db, [
        poolFixture("0xDueA", { createdAtBlock: 1n }),
        poolFixture("0xDueB", { createdAtBlock: 2n })
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xDueA", veryLongAgo),
        snapshotFixture("0xDueB", veryLongAgo)
      ]);
      const due = await getPoolsDueForOutcome(db, CHAIN_ID, 24, 1);
      expect(due).toHaveLength(1);
    });
  });

  describe("getCohortPercentiles", () => {
    function activityFixture(
      poolAddress: string,
      capturedAt: Date,
      uniqueBuyers1h: number,
      quoteBuyVolumeRaw1h: string,
      quoteSellVolumeRaw1h: string
    ) {
      return {
        chainId: CHAIN_ID,
        poolAddress,
        blockNumber: 1n,
        capturedAt,
        uniqueBuyers20m: uniqueBuyers1h,
        uniqueBuyers1h,
        buyCount20m: 0,
        sellCount20m: 0,
        quoteBuyVolumeRaw20m: "0",
        quoteSellVolumeRaw20m: "0",
        quoteBuyVolumeRaw1h,
        quoteSellVolumeRaw1h
      };
    }

    async function seedCohort() {
      // Candidate: discovered at T0, latest snapshot at +60min -> age 60min
      // at its own snapshot, 10 buyers, inflow 800.
      await insertPools(db, [
        poolFixture("0xCandidatePool", { discoveredAt: T0 }),
        poolFixture("0xPeerBoundaryLow", { discoveredAt: T0 }),
        poolFixture("0xPeerBoundaryHigh", { discoveredAt: T0 }),
        poolFixture("0xPeerMid1", { discoveredAt: T0 }),
        poolFixture("0xPeerMid2", { discoveredAt: T0 }),
        poolFixture("0xPeerTooYoung", { discoveredAt: T0 }),
        poolFixture("0xPeerTooOld", { discoveredAt: T0 })
      ]);
      await insertPoolActivitySnapshots(db, [
        activityFixture("0xCandidatePool", minutes(60), 10, "1000", "200"), // inflow 800
        activityFixture("0xPeerBoundaryLow", minutes(30), 5, "500", "0"), // age 30, inflow 500
        activityFixture("0xPeerBoundaryHigh", minutes(120), 15, "2000", "100"), // age 120, inflow 1900
        activityFixture("0xPeerMid1", minutes(60), 10, "800", "0"), // age 60, inflow 800
        activityFixture("0xPeerMid2", minutes(90), 20, "100", "50"), // age 90, inflow 50
        activityFixture("0xPeerTooYoung", minutes(29), 100, "9999", "0"), // age 29, excluded
        activityFixture("0xPeerTooOld", minutes(121), 0, "0", "0") // age 121, excluded
      ]);
    }

    /** Fixture times anchor at a fixed 2024 T0, so tests widen the live
     * freshness window explicitly; production keeps the 60-minute default. */
    const WIDE_FRESHNESS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

    it("computes buyer and net-inflow percentiles over the same-age cohort, excluding the candidate and out-of-band peers", async () => {
      await seedCohort();
      const result = await getCohortPercentiles(
        db,
        CHAIN_ID,
        "0xCandidatePool",
        60,
        4,
        WIDE_FRESHNESS_MS
      );
      expect(result?.cohortSize).toBe(4);
      // Peers <= 10 buyers: BoundaryLow(5), Mid1(10) => 2/4 = 5000 bps.
      expect(result?.buyerPercentileBps).toBe(5000);
      // Peers with inflow <= 800: BoundaryLow(500), Mid1(800), Mid2(50) => 3/4 = 7500 bps.
      expect(result?.netInflowPercentileBps).toBe(7500);
    });

    it("excludes peers whose latest snapshot is older than the freshness window — the cohort compares live pools", async () => {
      await seedCohort();
      // Every fixture snapshot is anchored in 2024, far past any live
      // window: with the default freshness the cohort is empty.
      const result = await getCohortPercentiles(db, CHAIN_ID, "0xCandidatePool", 60, 1);
      expect(result).toBeUndefined();
    });

    it("returns undefined when the cohort is smaller than minCohort", async () => {
      await seedCohort();
      const result = await getCohortPercentiles(
        db,
        CHAIN_ID,
        "0xCandidatePool",
        60,
        5,
        WIDE_FRESHNESS_MS
      );
      expect(result).toBeUndefined();
    });

    it("returns undefined when the candidate has no activity snapshot", async () => {
      await insertPools(db, [poolFixture("0xNoActivityPool")]);
      const result = await getCohortPercentiles(db, CHAIN_ID, "0xNoActivityPool", 60, 1);
      expect(result).toBeUndefined();
    });
  });
});
