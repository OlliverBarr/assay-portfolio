import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  insertPoolActivitySnapshots,
  insertPools,
  insertPoolSnapshots,
  insertPoolSwapEvents,
  listActiveTrustedQuotePoolsCreatedBefore,
  listActiveTrustedQuotePoolsNeedingActivityRefresh,
  listPoolSwapEventsSince,
  type ActivePoolCriteria,
  type Db,
  type PoolActivitySnapshotInsert,
  type PoolInsert,
  type PoolSnapshotInsert,
  type PoolSwapEventInsert
} from "../src/index.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

const CHAIN_ID = 7373;
const T0 = new Date("2024-06-01T00:00:00.000Z");
// On-chain youth cutoff: pools created at or after this block are active.
const MIN_CREATED_BLOCK = 1_000n;
const YOUNG_BLOCK = 1_500n;
const OLD_BLOCK = 50n;
const BLOCK_NUMBER = 2_000n;

function hours(n: number): Date {
  return new Date(T0.getTime() + n * 60 * 60 * 1000);
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
    createdAtBlock: OLD_BLOCK,
    createdTxHash: `0xcreate${poolAddress}`,
    createdLogIndex: 0,
    discoveredAt: T0,
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

function activitySnapshotFixture(
  poolAddress: string,
  capturedAt: Date,
  overrides: Partial<PoolActivitySnapshotInsert> = {}
): PoolActivitySnapshotInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress,
    blockNumber: 1n,
    capturedAt,
    uniqueBuyers20m: 0,
    uniqueBuyers1h: 0,
    buyCount20m: 0,
    sellCount20m: 0,
    quoteBuyVolumeRaw20m: "0",
    quoteSellVolumeRaw20m: "0",
    quoteBuyVolumeRaw1h: "0",
    quoteSellVolumeRaw1h: "0",
    ...overrides
  };
}

function swapFixture(
  poolAddress: string,
  observedAt: Date,
  logIndex: number,
  overrides: Partial<PoolSwapEventInsert> = {}
): PoolSwapEventInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress,
    factoryKind: "uniswap-v2",
    blockNumber: 1n,
    transactionHash: `0xtx${poolAddress}${logIndex}`,
    logIndex,
    sender: "0xSender",
    recipient: "0xRecipient",
    token0AmountRaw: "1",
    token1AmountRaw: "1",
    baseAmountRaw: "1",
    quoteAmountRaw: "1",
    side: "BUY",
    quoteTokenAddress: "0xQuote",
    baseTokenAddress: "0xBase",
    observedAt,
    ...overrides
  };
}

// Youth measured on-chain (block >= 1000); watch band $100k-$200k.
const CRITERIA: ActivePoolCriteria = {
  now: T0,
  activeMinCreatedBlock: MIN_CREATED_BLOCK,
  watchMinFdvUsd: 100_000,
  watchMaxFdvUsd: 200_000
};

describe("activity-scoped queries", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  describe("listActiveTrustedQuotePoolsCreatedBefore", () => {
    it("includes a young pool created at or before blockNumber", async () => {
      await insertPools(db, [
        poolFixture("0xYoung", { createdAtBlock: YOUNG_BLOCK })
      ]);
      const rows = await listActiveTrustedQuotePoolsCreatedBefore(
        db,
        CHAIN_ID,
        BLOCK_NUMBER,
        CRITERIA
      );
      expect(rows.map((row) => row.poolAddress)).toEqual(["0xYoung"]);
    });

    it("excludes an old pool with no watch-band snapshot", async () => {
      await insertPools(db, [
        poolFixture("0xOldOutOfBand", { createdAtBlock: OLD_BLOCK })
      ]);
      const rows = await listActiveTrustedQuotePoolsCreatedBefore(
        db,
        CHAIN_ID,
        BLOCK_NUMBER,
        CRITERIA
      );
      expect(rows).toHaveLength(0);
    });

    it("includes an old pool whose latest snapshot FDV is in the watch band", async () => {
      await insertPools(db, [
        poolFixture("0xOldInBand", { createdAtBlock: OLD_BLOCK })
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xOldInBand", hours(-1), { estimatedFdvUsd: "150000" })
      ]);
      const rows = await listActiveTrustedQuotePoolsCreatedBefore(
        db,
        CHAIN_ID,
        BLOCK_NUMBER,
        CRITERIA
      );
      expect(rows.map((row) => row.poolAddress)).toEqual(["0xOldInBand"]);
    });

    it("excludes a pool created after blockNumber even when young", async () => {
      await insertPools(db, [
        poolFixture("0xTooNew", { createdAtBlock: BLOCK_NUMBER + 1n })
      ]);
      const rows = await listActiveTrustedQuotePoolsCreatedBefore(
        db,
        CHAIN_ID,
        BLOCK_NUMBER,
        CRITERIA
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe("listPoolSwapEventsSince", () => {
    it("excludes swaps observed before `since`", async () => {
      await insertPoolSwapEvents(db, [
        swapFixture("0xPoolA", hours(-2), 0)
      ]);
      const rows = await listPoolSwapEventsSince(
        db,
        CHAIN_ID,
        ["0xPoolA"],
        hours(-1)
      );
      expect(rows).toHaveLength(0);
    });

    it("returns swaps for multiple pools in one call, ordered by observedAt asc", async () => {
      await insertPoolSwapEvents(db, [
        swapFixture("0xPoolA", hours(2), 0),
        swapFixture("0xPoolB", hours(0), 0),
        swapFixture("0xPoolA", hours(1), 1)
      ]);
      const rows = await listPoolSwapEventsSince(
        db,
        CHAIN_ID,
        ["0xPoolA", "0xPoolB"],
        hours(-1)
      );
      expect(
        rows.map((row) => [row.poolAddress, row.observedAt.getTime()])
      ).toEqual([
        ["0xPoolB", hours(0).getTime()],
        ["0xPoolA", hours(1).getTime()],
        ["0xPoolA", hours(2).getTime()]
      ]);
    });

    it("returns an empty array for an empty address list", async () => {
      const rows = await listPoolSwapEventsSince(db, CHAIN_ID, [], hours(-1));
      expect(rows).toHaveLength(0);
    });
  });

  describe("listActiveTrustedQuotePoolsNeedingActivityRefresh", () => {
    const STALE_BEFORE = hours(-4);

    it("includes an active pool with no activity snapshot at all", async () => {
      await insertPools(db, [
        poolFixture("0xNoSnapshot", { createdAtBlock: YOUNG_BLOCK })
      ]);
      const due = await listActiveTrustedQuotePoolsNeedingActivityRefresh(
        db,
        CHAIN_ID,
        BLOCK_NUMBER,
        CRITERIA,
        STALE_BEFORE,
        10
      );
      expect(due.map((row) => row.poolAddress)).toEqual(["0xNoSnapshot"]);
    });

    it("excludes an active pool whose latest activity snapshot is fresh", async () => {
      await insertPools(db, [
        poolFixture("0xFresh", { createdAtBlock: YOUNG_BLOCK })
      ]);
      await insertPoolActivitySnapshots(db, [
        activitySnapshotFixture("0xFresh", hours(-1))
      ]);
      const due = await listActiveTrustedQuotePoolsNeedingActivityRefresh(
        db,
        CHAIN_ID,
        BLOCK_NUMBER,
        CRITERIA,
        STALE_BEFORE,
        10
      );
      expect(due).toHaveLength(0);
    });

    it("includes stale pools ordered stalest-first and respects the limit", async () => {
      await insertPools(db, [
        poolFixture("0xStaleMost", { createdAtBlock: YOUNG_BLOCK }),
        poolFixture("0xStaleLess", { createdAtBlock: YOUNG_BLOCK })
      ]);
      await insertPoolActivitySnapshots(db, [
        activitySnapshotFixture("0xStaleMost", hours(-8)),
        activitySnapshotFixture("0xStaleLess", hours(-6))
      ]);
      const due = await listActiveTrustedQuotePoolsNeedingActivityRefresh(
        db,
        CHAIN_ID,
        BLOCK_NUMBER,
        CRITERIA,
        STALE_BEFORE,
        10
      );
      expect(due.map((row) => row.poolAddress)).toEqual([
        "0xStaleMost",
        "0xStaleLess"
      ]);

      const limited = await listActiveTrustedQuotePoolsNeedingActivityRefresh(
        db,
        CHAIN_ID,
        BLOCK_NUMBER,
        CRITERIA,
        STALE_BEFORE,
        1
      );
      expect(limited.map((row) => row.poolAddress)).toEqual(["0xStaleMost"]);
    });

    it("excludes a non-active (idle, out-of-band) pool even when its snapshot is stale", async () => {
      await insertPools(db, [
        poolFixture("0xIdleStale", { createdAtBlock: OLD_BLOCK })
      ]);
      await insertPoolActivitySnapshots(db, [
        activitySnapshotFixture("0xIdleStale", hours(-8))
      ]);
      const due = await listActiveTrustedQuotePoolsNeedingActivityRefresh(
        db,
        CHAIN_ID,
        BLOCK_NUMBER,
        CRITERIA,
        STALE_BEFORE,
        10
      );
      expect(due).toHaveLength(0);
    });
  });
});
