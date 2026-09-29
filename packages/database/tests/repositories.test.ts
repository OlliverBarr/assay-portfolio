import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceProcessedBlock,
  getCursor,
  getTokensByAddresses,
  initializeCursor,
  insertPools,
  insertTokens,
  listPools,
  recordObservedBlock,
  updateTokenDeployer,
  type Db,
  type PoolInsert
} from "../src/index.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

const CHAIN_ID = 4242;

function poolFixture(overrides: Partial<PoolInsert> = {}): PoolInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress: "0x1111111111111111111111111111111111111111",
    factoryAddress: "0x2222222222222222222222222222222222222222",
    dex: "uniswap",
    factoryKind: "uniswap-v2",
    token0Address: "0x3333333333333333333333333333333333333333",
    token1Address: "0x4444444444444444444444444444444444444444",
    createdAtBlock: 105n,
    createdTxHash: `0x${"ab".repeat(32)}`,
    createdLogIndex: 0,
    ...overrides
  };
}

describe("repositories", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  describe("cursor", () => {
    it("initializes once and ignores re-initialization", async () => {
      await initializeCursor(db, CHAIN_ID, 99n);
      await advanceProcessedBlock(db, CHAIN_ID, 150n);
      // A restart re-runs initialization; it must not reset progress.
      await initializeCursor(db, CHAIN_ID, 99n);
      const cursor = await getCursor(db, CHAIN_ID);
      expect(cursor?.latestProcessedBlock).toBe(150n);
    });

    it("never moves the processed watermark backwards", async () => {
      await initializeCursor(db, CHAIN_ID, 99n);
      await advanceProcessedBlock(db, CHAIN_ID, 200n);
      await advanceProcessedBlock(db, CHAIN_ID, 150n);
      const cursor = await getCursor(db, CHAIN_ID);
      expect(cursor?.latestProcessedBlock).toBe(200n);
    });

    it("tracks observed head separately and forward-only", async () => {
      await initializeCursor(db, CHAIN_ID, 99n);
      await recordObservedBlock(db, CHAIN_ID, 500n);
      await recordObservedBlock(db, CHAIN_ID, 400n);
      const cursor = await getCursor(db, CHAIN_ID);
      expect(cursor?.latestObservedBlock).toBe(500n);
      expect(cursor?.latestProcessedBlock).toBe(99n);
    });

    it("returns undefined for an unknown chain", async () => {
      expect(await getCursor(db, 1)).toBeUndefined();
    });
  });

  describe("insertPools", () => {
    it("inserts a pool exactly once under duplicate delivery", async () => {
      const first = await insertPools(db, [poolFixture()]);
      const second = await insertPools(db, [
        poolFixture({ createdLogIndex: 7 })
      ]);
      expect(first).toBe(1);
      expect(second).toBe(0);
      const rows = await listPools(db, CHAIN_ID);
      expect(rows).toHaveLength(1);
      // Original discovery record wins; the duplicate never overwrites.
      expect(rows[0]?.createdLogIndex).toBe(0);
    });

    it("handles duplicate rows within a single batch", async () => {
      const inserted = await insertPools(db, [poolFixture(), poolFixture()]);
      expect(inserted).toBe(1);
    });
  });

  describe("insertTokens", () => {
    it("preserves the original first-seen block on re-insert", async () => {
      await insertTokens(db, [
        { chainId: CHAIN_ID, address: "0xToken", firstSeenBlock: 100n }
      ]);
      const second = await insertTokens(db, [
        { chainId: CHAIN_ID, address: "0xToken", firstSeenBlock: 200n }
      ]);
      expect(second).toBe(0);
    });
  });

  describe("bind-parameter cap (regression: 2026-07-11 MAX_PARAMETERS_EXCEEDED crash loop)", () => {
    it("getTokensByAddresses survives an address list beyond the 65,534-parameter cap", async () => {
      await insertTokens(db, [
        { chainId: CHAIN_ID, address: "0xFirst", firstSeenBlock: 1n },
        { chainId: CHAIN_ID, address: "0xLast", firstSeenBlock: 2n }
      ]);
      // 70k addresses forces at least two chunks; known tokens are placed at
      // both ends so a dropped or duplicated chunk changes the result.
      const addresses = [
        "0xFirst",
        ...Array.from({ length: 69_998 }, (_, i) => `0xMissing${i}`),
        "0xLast"
      ];
      const rows = await getTokensByAddresses(db, CHAIN_ID, addresses);
      expect(rows.map((row) => row.address).sort()).toEqual([
        "0xFirst",
        "0xLast"
      ]);
    }, 60_000); // 50k-parameter chunks are slow on wasm PGlite.

    it("insertTokens chunks a bulk insert and reports the exact inserted count", async () => {
      const rows = Array.from({ length: 4_100 }, (_, i) => ({
        chainId: CHAIN_ID,
        address: `0xBulk${i}`,
        firstSeenBlock: 1n
      }));
      const inserted = await insertTokens(db, rows);
      expect(inserted).toBe(4_100);
      // Idempotent across chunk boundaries too.
      const again = await insertTokens(db, rows);
      expect(again).toBe(0);
    });
  });

  describe("updateTokenDeployer", () => {
    it("starts unattempted and records a resolution attempt in place", async () => {
      await insertTokens(db, [
        { chainId: CHAIN_ID, address: "0xToken", firstSeenBlock: 100n }
      ]);
      const [before] = await getTokensByAddresses(db, CHAIN_ID, ["0xToken"]);
      // Never attempted: status and timestamp are both null.
      expect(before?.deployerStatus).toBeNull();
      expect(before?.deployerCheckedAt).toBeNull();

      const checkedAt = new Date("2026-07-10T00:00:00Z");
      await updateTokenDeployer(db, CHAIN_ID, "0xToken", {
        deployerAddress: null,
        deployerStatus: "UNKNOWN",
        deployerCheckedAt: checkedAt
      });
      const [unknown] = await getTokensByAddresses(db, CHAIN_ID, ["0xToken"]);
      // Attempted-but-unknown is distinguishable from unattempted.
      expect(unknown?.deployerAddress).toBeNull();
      expect(unknown?.deployerStatus).toBe("UNKNOWN");
      expect(unknown?.deployerCheckedAt?.getTime()).toBe(checkedAt.getTime());

      await updateTokenDeployer(db, CHAIN_ID, "0xToken", {
        deployerAddress: "0xDeployer",
        deployerStatus: "RESOLVED",
        deployerCheckedAt: new Date("2026-07-10T01:00:00Z")
      });
      const [resolved] = await getTokensByAddresses(db, CHAIN_ID, ["0xToken"]);
      expect(resolved?.deployerAddress).toBe("0xDeployer");
      expect(resolved?.deployerStatus).toBe("RESOLVED");
    });
  });
});
