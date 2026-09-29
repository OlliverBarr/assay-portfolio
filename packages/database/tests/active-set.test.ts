import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  insertPools,
  insertPoolSnapshots,
  listActiveTrustedQuotePools,
  listIdleTrustedQuotePoolsDue,
  listTrustedQuotePoolsNeedingRisk,
  type ActivePoolCriteria,
  type Db,
  type PoolInsert,
  type PoolSnapshotInsert
} from "../src/index.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

const CHAIN_ID = 9191;
const T0 = new Date("2024-06-01T00:00:00.000Z");
// On-chain youth cutoff: pools created at or after this block are active.
const MIN_CREATED_BLOCK = 1_000n;
const YOUNG_BLOCK = 1_500n;
const OLD_BLOCK = 50n;

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

// Youth measured on-chain (block >= 1000); watch band $100k-$200k.
const CRITERIA: ActivePoolCriteria = {
  now: T0,
  activeMinCreatedBlock: MIN_CREATED_BLOCK,
  watchMinFdvUsd: 100_000,
  watchMaxFdvUsd: 200_000
};

describe("active set selection", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  describe("listActiveTrustedQuotePools", () => {
    it("includes a young pool regardless of snapshots", async () => {
      await insertPools(db, [
        poolFixture("0xYoung", { createdAtBlock: YOUNG_BLOCK })
      ]);
      const rows = await listActiveTrustedQuotePools(db, CHAIN_ID, CRITERIA);
      expect(rows.map((row) => row.poolAddress)).toEqual(["0xYoung"]);
    });

    it("excludes a backfilled pool: old on-chain, freshly discovered", async () => {
      // The 2026-07-11 incident: ingestion time must never make an
      // on-chain-old pool "young". discoveredAt is deliberately NOW.
      await insertPools(db, [
        poolFixture("0xBackfilled", {
          createdAtBlock: OLD_BLOCK,
          discoveredAt: new Date()
        })
      ]);
      const rows = await listActiveTrustedQuotePools(db, CHAIN_ID, CRITERIA);
      expect(rows).toHaveLength(0);
    });

    it("includes an old pool whose latest snapshot FDV is inside the watch band", async () => {
      await insertPools(db, [
        poolFixture("0xOldInBand", { createdAtBlock: OLD_BLOCK })
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xOldInBand", hours(-1), { estimatedFdvUsd: "150000" })
      ]);
      const rows = await listActiveTrustedQuotePools(db, CHAIN_ID, CRITERIA);
      expect(rows.map((row) => row.poolAddress)).toEqual(["0xOldInBand"]);
    });

    it("excludes an old pool whose LATEST snapshot FDV is out of band, even when an older snapshot was in band", async () => {
      await insertPools(db, [
        poolFixture("0xOldDrifted", { createdAtBlock: OLD_BLOCK })
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xOldDrifted", hours(-5), { estimatedFdvUsd: "150000" }),
        snapshotFixture("0xOldDrifted", hours(-1), { estimatedFdvUsd: "500000" })
      ]);
      const rows = await listActiveTrustedQuotePools(db, CHAIN_ID, CRITERIA);
      expect(rows).toHaveLength(0);
    });

    it("excludes an old pool whose latest snapshot has a null FDV", async () => {
      await insertPools(db, [
        poolFixture("0xOldNullFdv", { createdAtBlock: OLD_BLOCK })
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xOldNullFdv", hours(-1), {
          estimatedFdvUsd: null,
          nullReason: "no-usd-anchor"
        })
      ]);
      const rows = await listActiveTrustedQuotePools(db, CHAIN_ID, CRITERIA);
      expect(rows).toHaveLength(0);
    });

    it("never returns an untrusted-quote pool, even when young", async () => {
      await insertPools(db, [
        poolFixture("0xUntrusted", {
          createdAtBlock: YOUNG_BLOCK,
          quoteTokenAddress: null,
          baseTokenAddress: null
        })
      ]);
      const rows = await listActiveTrustedQuotePools(db, CHAIN_ID, CRITERIA);
      expect(rows).toHaveLength(0);
    });
  });

  describe("listIdleTrustedQuotePoolsDue", () => {
    const IDLE_CUTOFF = hours(-4);

    it("orders no-snapshot pools first then stalest-first, respects the idle cutoff, and never returns active pools", async () => {
      await insertPools(db, [
        poolFixture("0xNoSnapshot", { createdAtBlock: OLD_BLOCK }),
        poolFixture("0xStaleMost", { createdAtBlock: OLD_BLOCK }),
        poolFixture("0xStaleLess", { createdAtBlock: OLD_BLOCK }),
        poolFixture("0xFresh", { createdAtBlock: OLD_BLOCK }),
        poolFixture("0xActiveByAge", { createdAtBlock: YOUNG_BLOCK }),
        poolFixture("0xActiveByFdv", { createdAtBlock: OLD_BLOCK })
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xStaleMost", hours(-8)),
        snapshotFixture("0xStaleLess", hours(-6)),
        // Fresher than the idle cutoff: not due yet.
        snapshotFixture("0xFresh", hours(-1)),
        // Stale by capturedAt, but active because its FDV sits in the watch
        // band — must never surface on the idle lane even though it would
        // otherwise sort ahead of every other stale pool here.
        snapshotFixture("0xActiveByFdv", hours(-9), { estimatedFdvUsd: "150000" })
      ]);

      const due = await listIdleTrustedQuotePoolsDue(
        db,
        CHAIN_ID,
        CRITERIA,
        IDLE_CUTOFF,
        10
      );
      expect(due.map((row) => row.poolAddress)).toEqual([
        "0xNoSnapshot",
        "0xStaleMost",
        "0xStaleLess"
      ]);
    });

    it("respects the limit", async () => {
      await insertPools(db, [
        poolFixture("0xIdleA", { createdAtBlock: OLD_BLOCK }),
        poolFixture("0xIdleB", { createdAtBlock: OLD_BLOCK })
      ]);
      const due = await listIdleTrustedQuotePoolsDue(
        db,
        CHAIN_ID,
        CRITERIA,
        IDLE_CUTOFF,
        1
      );
      expect(due).toHaveLength(1);
    });

    it("never returns an untrusted-quote pool", async () => {
      await insertPools(db, [
        poolFixture("0xUntrustedIdle", {
          createdAtBlock: OLD_BLOCK,
          quoteTokenAddress: null,
          baseTokenAddress: null
        })
      ]);
      const due = await listIdleTrustedQuotePoolsDue(
        db,
        CHAIN_ID,
        CRITERIA,
        IDLE_CUTOFF,
        10
      );
      expect(due).toHaveLength(0);
    });
  });

  describe("listTrustedQuotePoolsNeedingRisk with active criteria", () => {
    it("drops out-of-band pools when `active` is given, but keeps legacy behavior without it", async () => {
      await insertPools(db, [
        poolFixture("0xNeedsRiskActive", { createdAtBlock: YOUNG_BLOCK }),
        poolFixture("0xNeedsRiskIdle", { createdAtBlock: OLD_BLOCK })
      ]);

      const scoped = await listTrustedQuotePoolsNeedingRisk(
        db,
        CHAIN_ID,
        T0,
        undefined,
        CRITERIA
      );
      expect(scoped.map((row) => row.poolAddress)).toEqual([
        "0xNeedsRiskActive"
      ]);

      const legacy = await listTrustedQuotePoolsNeedingRisk(db, CHAIN_ID, T0);
      expect(legacy.map((row) => row.poolAddress).sort()).toEqual(
        ["0xNeedsRiskActive", "0xNeedsRiskIdle"].sort()
      );
    });
  });
});
