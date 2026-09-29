import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getLatestScoreResultAt,
  insertPools,
  insertPoolSnapshots,
  insertScoreResult,
  insertTokenHolderSnapshot,
  insertTokenRisk,
  listBandTrustedQuotePools,
  listBandTrustedQuotePoolsNeedingHolders,
  listBandTrustedQuotePoolsNeedingRisk,
  listYoungTrustedQuotePoolsNeedingHolders,
  type Db,
  type FdvBandCriteria,
  type PoolInsert,
  type PoolSnapshotInsert
} from "../src/index.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

const CHAIN_ID = 9393;
const T0 = new Date("2024-06-01T00:00:00.000Z");
const BAND: FdvBandCriteria = { minFdvUsd: 40_000, maxFdvUsd: 300_000 };
const STALE_BEFORE = new Date(T0.getTime() + 60 * 60 * 1000); // T0+1h

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
    token1Address: `0xBase${poolAddress}`,
    quoteTokenAddress: "0xQuote",
    baseTokenAddress: `0xBase${poolAddress}`,
    createdAtBlock: 100n,
    createdTxHash: `0xcreate${poolAddress}`,
    createdLogIndex: 0,
    discoveredAt: T0,
    ...overrides
  };
}

function snapshotFixture(
  poolAddress: string,
  fdvUsd: string | null,
  overrides: Partial<PoolSnapshotInsert> = {}
): PoolSnapshotInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress,
    blockNumber: 1n,
    capturedAt: T0,
    calculationMethod: "v2-reserves",
    estimatedFdvUsd: fdvUsd,
    ...overrides
  };
}

async function holderSnapshot(
  db: Db,
  tokenAddress: string,
  capturedAt: Date
): Promise<void> {
  await insertTokenHolderSnapshot(db, {
    chainId: CHAIN_ID,
    tokenAddress,
    blockNumber: 1n,
    capturedAt,
    holderCount: 1,
    adjustedHolderCount: 1,
    largestHolderPctBps: 100,
    top10PctBps: 100,
    adjustedTop10PctBps: 100,
    deployerPctBps: null,
    holderClusterScoreBps: null,
    floatBps: null,
    supplyInPoolBps: null,
    excluded: []
  });
}

describe("band-priority selection", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  describe("listBandTrustedQuotePools", () => {
    it("selects only pools whose LATEST snapshot FDV is inside the band", async () => {
      await insertPools(db, [
        poolFixture("0xInBand"),
        poolFixture("0xBelow"),
        poolFixture("0xLeftBand")
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xInBand", "100000"),
        snapshotFixture("0xBelow", "10000"),
        // Older snapshot in band, latest out of band: must NOT select.
        snapshotFixture("0xLeftBand", "150000"),
        snapshotFixture("0xLeftBand", "500000", { blockNumber: 2n, capturedAt: hours(1) })
      ]);
      const rows = await listBandTrustedQuotePools(db, CHAIN_ID, BAND);
      expect(rows.map((row) => row.poolAddress)).toEqual(["0xInBand"]);
    });

    it("orders newest-created first and respects the limit", async () => {
      await insertPools(db, [
        poolFixture("0xOldPool", { createdAtBlock: 10n }),
        poolFixture("0xNewPool", { createdAtBlock: 20n }),
        poolFixture("0xMidPool", { createdAtBlock: 15n })
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xOldPool", "100000"),
        snapshotFixture("0xNewPool", "100000"),
        snapshotFixture("0xMidPool", "100000")
      ]);
      const rows = await listBandTrustedQuotePools(db, CHAIN_ID, BAND, 2);
      expect(rows.map((row) => row.poolAddress)).toEqual(["0xNewPool", "0xMidPool"]);
    });
  });

  describe("listBandTrustedQuotePoolsNeedingHolders", () => {
    it("selects band pools with a missing or stale holder snapshot, skips fresh ones", async () => {
      await insertPools(db, [
        poolFixture("0xNoSnap"),
        poolFixture("0xStale"),
        poolFixture("0xFresh"),
        poolFixture("0xOutOfBand")
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xNoSnap", "100000"),
        snapshotFixture("0xStale", "100000"),
        snapshotFixture("0xFresh", "100000"),
        snapshotFixture("0xOutOfBand", "10000")
      ]);
      await holderSnapshot(db, "0xBase0xStale", T0); // < STALE_BEFORE
      await holderSnapshot(db, "0xBase0xFresh", hours(2)); // >= STALE_BEFORE

      const rows = await listBandTrustedQuotePoolsNeedingHolders(
        db,
        CHAIN_ID,
        BAND,
        STALE_BEFORE,
        10
      );
      expect(rows.map((row) => row.poolAddress).sort()).toEqual(["0xNoSnap", "0xStale"]);
    });
    it("applies the quote-liquidity floor only when positive; null liquidity fails the floor", async () => {
      await insertPools(db, [
        poolFixture("0xNullLiq"),
        poolFixture("0xBelowFloor"),
        poolFixture("0xAtFloor"),
        poolFixture("0xAboveFloor")
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xNullLiq", "100000"),
        snapshotFixture("0xBelowFloor", "100000", { quoteLiquidityUsd: "100" }),
        snapshotFixture("0xAtFloor", "100000", { quoteLiquidityUsd: "500" }),
        snapshotFixture("0xAboveFloor", "100000", { quoteLiquidityUsd: "2500" })
      ]);

      const floored = await listBandTrustedQuotePoolsNeedingHolders(
        db,
        CHAIN_ID,
        BAND,
        STALE_BEFORE,
        10,
        500
      );
      expect(floored.map((row) => row.poolAddress).sort()).toEqual([
        "0xAboveFloor",
        "0xAtFloor"
      ]);

      // Floor 0 (default) disables the condition entirely.
      const unfloored = await listBandTrustedQuotePoolsNeedingHolders(
        db,
        CHAIN_ID,
        BAND,
        STALE_BEFORE,
        10
      );
      expect(unfloored.map((row) => row.poolAddress).sort()).toEqual([
        "0xAboveFloor",
        "0xAtFloor",
        "0xBelowFloor",
        "0xNullLiq"
      ]);
    });

    it("evaluates the floor against the LATEST snapshot, not any older one", async () => {
      await insertPools(db, [poolFixture("0xDrained")]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xDrained", "100000", { quoteLiquidityUsd: "5000" }),
        // Liquidity pulled: latest snapshot below the floor.
        snapshotFixture("0xDrained", "100000", {
          blockNumber: 2n,
          capturedAt: hours(1),
          quoteLiquidityUsd: "50"
        })
      ]);
      const rows = await listBandTrustedQuotePoolsNeedingHolders(
        db,
        CHAIN_ID,
        BAND,
        STALE_BEFORE,
        10,
        500
      );
      expect(rows).toEqual([]);
    });
  });

  describe("listYoungTrustedQuotePoolsNeedingHolders", () => {
    it("selects young pools regardless of band, newest first, bounded", async () => {
      await insertPools(db, [
        poolFixture("0xYoungA", { createdAtBlock: 1_000n }),
        poolFixture("0xYoungB", { createdAtBlock: 2_000n }),
        poolFixture("0xAncient", { createdAtBlock: 5n })
      ]);
      const rows = await listYoungTrustedQuotePoolsNeedingHolders(
        db,
        CHAIN_ID,
        500n,
        STALE_BEFORE,
        1
      );
      expect(rows.map((row) => row.poolAddress)).toEqual(["0xYoungB"]);
    });
  });

  describe("listBandTrustedQuotePoolsNeedingRisk", () => {
    it("skips band pools with a fresh risk verdict, selects stale/missing", async () => {
      await insertPools(db, [poolFixture("0xRisked"), poolFixture("0xUnrisked")]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xRisked", "100000"),
        snapshotFixture("0xUnrisked", "100000")
      ]);
      await insertTokenRisk(db, {
        chainId: CHAIN_ID,
        tokenAddress: "0xBase0xRisked",
        poolAddress: "0xRisked",
        blockNumber: 1n,
        assessedAt: hours(2), // fresh (>= STALE_BEFORE)
        status: "PASS",
        verificationStatus: "UNKNOWN",
        isProxy: false,
        implementationAddress: null,
        permissionFindings: [],
        simulationStatus: "UNKNOWN",
        effectiveBuyLossBps: null,
        effectiveSellLossBps: null,
        riskReasons: [],
        positiveReasons: [],
        nullReason: null
      });
      const rows = await listBandTrustedQuotePoolsNeedingRisk(
        db,
        CHAIN_ID,
        BAND,
        STALE_BEFORE,
        10
      );
      expect(rows.map((row) => row.poolAddress)).toEqual(["0xUnrisked"]);
    });
    it("applies the quote-liquidity floor to the risk band lane", async () => {
      await insertPools(db, [poolFixture("0xDust"), poolFixture("0xFunded")]);
      await insertPoolSnapshots(db, [
        snapshotFixture("0xDust", "100000", { quoteLiquidityUsd: "10" }),
        snapshotFixture("0xFunded", "100000", { quoteLiquidityUsd: "3000" })
      ]);
      const rows = await listBandTrustedQuotePoolsNeedingRisk(
        db,
        CHAIN_ID,
        BAND,
        STALE_BEFORE,
        10,
        500
      );
      expect(rows.map((row) => row.poolAddress)).toEqual(["0xFunded"]);
    });
  });

  describe("getLatestScoreResultAt", () => {
    it("returns the newest scored_at for the token, undefined when unscored", async () => {
      expect(await getLatestScoreResultAt(db, CHAIN_ID, "0xTok")).toBeUndefined();
      for (const scoredAt of [T0, hours(3), hours(1)]) {
        await insertScoreResult(db, {
          chainId: CHAIN_ID,
          tokenAddress: "0xTok",
          poolAddress: "0xPool",
          blockNumber: 1n,
          eligible: false,
          score: 10,
          components: {},
          alertLevel: "GRAY",
          positiveReasons: [],
          riskReasons: [],
          scoredAt
        });
      }
      const latest = await getLatestScoreResultAt(db, CHAIN_ID, "0xTok");
      expect(latest?.toISOString()).toBe(hours(3).toISOString());
    });
  });
});
