import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getActivitySnapshotAt,
  getHolderSnapshotAt,
  getPoolsDueForPerformance,
  getTokenRiskAt,
  insertPoolActivitySnapshots,
  insertPools,
  insertPoolSnapshots,
  insertTokenHolderSnapshot,
  insertTokenPerformance,
  insertTokenRisk,
  listTokenPerformance,
  type Db,
  type PoolActivitySnapshotInsert,
  type PoolInsert,
  type PoolSnapshotInsert,
  type TokenHolderSnapshotInsert,
  type TokenPerformanceInsert,
  type TokenRiskInsert
} from "../src/index.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

const CHAIN_ID = 7171;
const T0 = new Date("2024-03-01T00:00:00.000Z");

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
    maxMultipleBps: 15000,
    maxDrawdownBps: 1000,
    minutesToPeak: 30,
    snapshotsInWindow: 5,
    entryFeatures: {},
    details: {},
    ...overrides
  };
}

function activityFixture(
  poolAddress: string,
  capturedAt: Date,
  overrides: Partial<PoolActivitySnapshotInsert> = {}
): PoolActivitySnapshotInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress,
    blockNumber: 1n,
    capturedAt,
    uniqueBuyers20m: 1,
    uniqueBuyers1h: 1,
    buyCount20m: 1,
    sellCount20m: 0,
    quoteBuyVolumeRaw20m: "0",
    quoteSellVolumeRaw20m: "0",
    quoteBuyVolumeRaw1h: "0",
    quoteSellVolumeRaw1h: "0",
    ...overrides
  };
}

function holderSnapshotFixture(
  tokenAddress: string,
  capturedAt: Date,
  overrides: Partial<TokenHolderSnapshotInsert> = {}
): TokenHolderSnapshotInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress,
    blockNumber: 1n,
    capturedAt,
    holderCount: 10,
    adjustedHolderCount: 8,
    largestHolderPctBps: 1000,
    top10PctBps: 5000,
    adjustedTop10PctBps: 4000,
    excluded: [],
    ...overrides
  };
}

function riskFixture(
  tokenAddress: string,
  poolAddress: string,
  assessedAt: Date,
  overrides: Partial<TokenRiskInsert> = {}
): TokenRiskInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress,
    poolAddress,
    blockNumber: 1n,
    assessedAt,
    status: "PASS",
    verificationStatus: "VERIFIED",
    permissionFindings: [],
    simulationStatus: "PASS",
    riskReasons: [],
    positiveReasons: [],
    ...overrides
  };
}

describe("performance repositories", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  describe("insertTokenPerformance / listTokenPerformance", () => {
    it("is idempotent on the (chainId, poolAddress, horizonHours) unique key", async () => {
      await insertPools(db, [poolFixture("0xPoolA")]);
      await insertTokenPerformance(
        db,
        performanceFixture("0xPoolA", 72, { maxMultipleBps: 15000 })
      );
      await insertTokenPerformance(
        db,
        performanceFixture("0xPoolA", 72, { maxMultipleBps: 99999 })
      );

      const rows = await listTokenPerformance(db, CHAIN_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.maxMultipleBps).toBe(15000);
    });

    it("allows separate rows per horizon for the same pool", async () => {
      await insertPools(db, [poolFixture("0xPoolA")]);
      await insertTokenPerformance(db, performanceFixture("0xPoolA", 72));
      await insertTokenPerformance(db, performanceFixture("0xPoolA", 168));

      const rows = await listTokenPerformance(db, CHAIN_ID);
      expect(rows.map((row) => row.horizonHours).sort((a, b) => a - b)).toEqual([72, 168]);
    });
  });

  describe("getPoolsDueForPerformance", () => {
    const BAND = { minFdvUsd: 50_000, maxFdvUsd: 200_000 };
    /** In-band, priced snapshot — the shape that defines a band entry. */
    const inBand = { estimatedFdvUsd: "100000", priceUsd: "0.001" };

    it("selects only unlabeled pools with an elapsed in-band entry for the given horizon", async () => {
      const now = Date.now();
      const longAgo = new Date(now - 200 * 60 * 60 * 1000);
      const recently = new Date(now - 10 * 60 * 60 * 1000);
      const veryLongAgo = new Date(now - 300 * 60 * 60 * 1000);

      await insertPools(db, [
        poolFixture("0xDuePool", { createdAtBlock: 1n }),
        poolFixture("0xTooYoungPool", { createdAtBlock: 2n }),
        poolFixture("0xAlreadyLabeledPool", { createdAtBlock: 3n }),
        poolFixture("0xDueOtherHorizonPool", { createdAtBlock: 4n })
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xDuePool", longAgo, inBand),
        // In band, but the 168h window from this snapshot has not elapsed.
        snapshotFixture("0xTooYoungPool", recently, inBand),
        snapshotFixture("0xAlreadyLabeledPool", veryLongAgo, inBand),
        snapshotFixture("0xDueOtherHorizonPool", veryLongAgo, inBand)
      ]);
      await insertTokenPerformance(
        db,
        performanceFixture("0xAlreadyLabeledPool", 168, { enteredAt: veryLongAgo })
      );
      // Labeled at a different horizon: still due for 168h.
      await insertTokenPerformance(
        db,
        performanceFixture("0xDueOtherHorizonPool", 72, { enteredAt: veryLongAgo })
      );

      const due = await getPoolsDueForPerformance(db, CHAIN_ID, 168, 10, BAND);
      const duePoolAddresses = due.map((row) => row.poolAddress).sort();
      expect(duePoolAddresses).toEqual(
        ["0xDueOtherHorizonPool", "0xDuePool"].sort()
      );
    });

    it("never selects pools that never entered the band — old never-band pools cannot starve the batch", async () => {
      const veryLongAgo = new Date(Date.now() - 300 * 60 * 60 * 1000);
      // Two OLD pools that never touched the band (the starvation population
      // observed live 2026-07-12), created BEFORE the real band entrant.
      await insertPools(db, [
        poolFixture("0xNeverBandA", { createdAtBlock: 1n }),
        poolFixture("0xNeverBandB", { createdAtBlock: 2n }),
        poolFixture("0xBandEntrant", { createdAtBlock: 3n })
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xNeverBandA", veryLongAgo, {
          estimatedFdvUsd: "5000",
          priceUsd: "0.001"
        }),
        // In-band FDV but never priced: not a valid entry either.
        snapshotFixture("0xNeverBandB", veryLongAgo, {
          estimatedFdvUsd: "100000",
          priceUsd: null
        }),
        snapshotFixture("0xBandEntrant", veryLongAgo, inBand)
      ]);

      // Limit 1 — with the old coarse filter the oldest never-band pool
      // would consume the whole batch and the entrant would starve forever.
      const due = await getPoolsDueForPerformance(db, CHAIN_ID, 168, 1, BAND);
      expect(due.map((row) => row.poolAddress)).toEqual(["0xBandEntrant"]);
    });

    it("respects the limit", async () => {
      const veryLongAgo = new Date(Date.now() - 300 * 60 * 60 * 1000);
      await insertPools(db, [
        poolFixture("0xDueA", { createdAtBlock: 1n }),
        poolFixture("0xDueB", { createdAtBlock: 2n })
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xDueA", veryLongAgo, inBand),
        snapshotFixture("0xDueB", veryLongAgo, inBand)
      ]);
      const due = await getPoolsDueForPerformance(db, CHAIN_ID, 168, 1, BAND);
      expect(due).toHaveLength(1);
    });
  });

  describe("getActivitySnapshotAt", () => {
    it("returns undefined when the pool has no activity snapshots", async () => {
      expect(
        await getActivitySnapshotAt(db, CHAIN_ID, "0xPoolA", minutes(10))
      ).toBeUndefined();
    });

    it("returns the latest snapshot at or before the cutoff, never after", async () => {
      await insertPools(db, [poolFixture("0xPoolA")]);
      await insertPoolActivitySnapshots(db, [
        activityFixture("0xPoolA", minutes(0), { uniqueBuyers1h: 1 }),
        activityFixture("0xPoolA", minutes(10), { uniqueBuyers1h: 2 }),
        activityFixture("0xPoolA", minutes(20), { uniqueBuyers1h: 3 })
      ]);

      const before = await getActivitySnapshotAt(db, CHAIN_ID, "0xPoolA", minutes(5));
      expect(before?.uniqueBuyers1h).toBe(1);

      const at = await getActivitySnapshotAt(db, CHAIN_ID, "0xPoolA", minutes(10));
      expect(at?.uniqueBuyers1h).toBe(2);

      const after = await getActivitySnapshotAt(db, CHAIN_ID, "0xPoolA", minutes(999));
      expect(after?.uniqueBuyers1h).toBe(3);

      const beforeAll = await getActivitySnapshotAt(db, CHAIN_ID, "0xPoolA", minutes(-5));
      expect(beforeAll).toBeUndefined();
    });

    it("breaks ties on id when two rows share the same captured_at", async () => {
      await insertPools(db, [poolFixture("0xPoolA")]);
      await insertPoolActivitySnapshots(db, [
        activityFixture("0xPoolA", minutes(10), { uniqueBuyers1h: 1 })
      ]);
      await insertPoolActivitySnapshots(db, [
        activityFixture("0xPoolA", minutes(10), { uniqueBuyers1h: 2 })
      ]);

      const result = await getActivitySnapshotAt(db, CHAIN_ID, "0xPoolA", minutes(10));
      // The later-inserted row has the higher id and wins the tiebreak.
      expect(result?.uniqueBuyers1h).toBe(2);
    });
  });

  describe("getHolderSnapshotAt", () => {
    it("returns undefined when the token has no holder snapshots", async () => {
      expect(
        await getHolderSnapshotAt(db, CHAIN_ID, "0xToken1", minutes(10))
      ).toBeUndefined();
    });

    it("returns the latest snapshot at or before the cutoff, never after", async () => {
      await insertTokenHolderSnapshot(
        db,
        holderSnapshotFixture("0xToken1", minutes(0), { adjustedHolderCount: 1 })
      );
      await insertTokenHolderSnapshot(
        db,
        holderSnapshotFixture("0xToken1", minutes(10), { adjustedHolderCount: 2 })
      );
      await insertTokenHolderSnapshot(
        db,
        holderSnapshotFixture("0xToken1", minutes(20), { adjustedHolderCount: 3 })
      );

      const before = await getHolderSnapshotAt(db, CHAIN_ID, "0xToken1", minutes(5));
      expect(before?.adjustedHolderCount).toBe(1);

      const at = await getHolderSnapshotAt(db, CHAIN_ID, "0xToken1", minutes(10));
      expect(at?.adjustedHolderCount).toBe(2);

      const after = await getHolderSnapshotAt(db, CHAIN_ID, "0xToken1", minutes(999));
      expect(after?.adjustedHolderCount).toBe(3);

      const beforeAll = await getHolderSnapshotAt(db, CHAIN_ID, "0xToken1", minutes(-5));
      expect(beforeAll).toBeUndefined();
    });

    it("breaks ties on id when two rows share the same captured_at", async () => {
      await insertTokenHolderSnapshot(
        db,
        holderSnapshotFixture("0xToken1", minutes(10), { adjustedHolderCount: 1 })
      );
      await insertTokenHolderSnapshot(
        db,
        holderSnapshotFixture("0xToken1", minutes(10), { adjustedHolderCount: 2 })
      );

      const result = await getHolderSnapshotAt(db, CHAIN_ID, "0xToken1", minutes(10));
      expect(result?.adjustedHolderCount).toBe(2);
    });
  });

  describe("getTokenRiskAt", () => {
    it("returns undefined when the token has no risk assessments", async () => {
      expect(
        await getTokenRiskAt(db, CHAIN_ID, "0xToken1", minutes(10))
      ).toBeUndefined();
    });

    it("returns the latest assessment at or before the cutoff, never after", async () => {
      await insertTokenRisk(
        db,
        riskFixture("0xToken1", "0xPoolA", minutes(0), { status: "UNKNOWN" })
      );
      await insertTokenRisk(
        db,
        riskFixture("0xToken1", "0xPoolA", minutes(10), { status: "PASS" })
      );
      await insertTokenRisk(
        db,
        riskFixture("0xToken1", "0xPoolA", minutes(20), { status: "FAIL" })
      );

      const before = await getTokenRiskAt(db, CHAIN_ID, "0xToken1", minutes(5));
      expect(before?.status).toBe("UNKNOWN");

      const at = await getTokenRiskAt(db, CHAIN_ID, "0xToken1", minutes(10));
      expect(at?.status).toBe("PASS");

      const after = await getTokenRiskAt(db, CHAIN_ID, "0xToken1", minutes(999));
      expect(after?.status).toBe("FAIL");

      const beforeAll = await getTokenRiskAt(db, CHAIN_ID, "0xToken1", minutes(-5));
      expect(beforeAll).toBeUndefined();
    });

    it("breaks ties on id when two rows share the same assessed_at", async () => {
      await insertTokenRisk(
        db,
        riskFixture("0xToken1", "0xPoolA", minutes(10), { status: "UNKNOWN" })
      );
      await insertTokenRisk(
        db,
        riskFixture("0xToken1", "0xPoolA", minutes(10), { status: "PASS" })
      );

      const result = await getTokenRiskAt(db, CHAIN_ID, "0xToken1", minutes(10));
      expect(result?.status).toBe("PASS");
    });
  });
});
