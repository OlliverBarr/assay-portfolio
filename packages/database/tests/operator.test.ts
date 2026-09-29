import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getLatestDeliveredAlertBySimilarName,
  getLatestSnapshotCapturedAt,
  insertAlertSent,
  insertOperatorDecision,
  insertPools,
  insertPoolSnapshots,
  insertTokens,
  listAlertsSent,
  listOperatorDecisions,
  type AlertSentInsert,
  type Db,
  type OperatorDecisionInsert,
  type PoolInsert,
  type PoolSnapshotInsert
} from "../src/index.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

const CHAIN_ID = 9191;
const OTHER_CHAIN_ID = 9292;
const T0 = new Date("2024-02-01T00:00:00.000Z");

function minutes(n: number): Date {
  return new Date(T0.getTime() + n * 60_000);
}

function poolFixture(
  chainId: number,
  poolAddress: string,
  overrides: Partial<PoolInsert> = {}
): PoolInsert {
  return {
    chainId,
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
  chainId: number,
  poolAddress: string,
  capturedAt: Date,
  overrides: Partial<PoolSnapshotInsert> = {}
): PoolSnapshotInsert {
  return {
    chainId,
    poolAddress,
    blockNumber: 1n,
    capturedAt,
    calculationMethod: "v2-reserves",
    ...overrides
  };
}

function decisionFixture(
  overrides: Partial<OperatorDecisionInsert> = {}
): OperatorDecisionInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress: "0xToken1",
    action: "ENTERED",
    reason: "clean holder distribution, organic buy pressure",
    ...overrides
  };
}

function alertFixture(
  chainId: number,
  tokenAddress: string,
  overrides: Partial<AlertSentInsert> = {}
): AlertSentInsert {
  return {
    chainId,
    tokenAddress,
    poolAddress: "0xPool1",
    alertLevel: "YELLOW",
    score: 80,
    reason: "level increase",
    transport: "dry-run",
    delivered: true,
    ...overrides
  };
}

describe("operator repositories", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  describe("insertOperatorDecision / listOperatorDecisions", () => {
    it("stores optional fields as null when omitted", async () => {
      const inserted = await insertOperatorDecision(db, decisionFixture());
      expect(inserted.poolAddress).toBeNull();
      expect(inserted.sizeUsd).toBeNull();
      expect(inserted.priceUsd).toBeNull();
      expect(inserted.action).toBe("ENTERED");
      expect(inserted.recordedAt).toBeInstanceOf(Date);
    });

    it("stores optional fields when provided", async () => {
      const inserted = await insertOperatorDecision(
        db,
        decisionFixture({
          poolAddress: "0xPool1",
          sizeUsd: "500.5",
          priceUsd: "0.000123"
        })
      );
      expect(inserted.poolAddress).toBe("0xPool1");
      expect(inserted.sizeUsd).toBe("500.500000000000000000");
      expect(inserted.priceUsd).toBe("0.000123000000000000");
    });

    it("lists newest first, scoped to the chain", async () => {
      await insertOperatorDecision(
        db,
        decisionFixture({ recordedAt: minutes(0), reason: "first" })
      );
      await insertOperatorDecision(
        db,
        decisionFixture({ recordedAt: minutes(10), reason: "second" })
      );
      await insertOperatorDecision(
        db,
        decisionFixture({
          chainId: OTHER_CHAIN_ID,
          recordedAt: minutes(20),
          reason: "other chain"
        })
      );

      const rows = await listOperatorDecisions(db, CHAIN_ID);
      expect(rows.map((row) => row.reason)).toEqual(["second", "first"]);
    });

    it("scopes to a token address when given", async () => {
      await insertOperatorDecision(
        db,
        decisionFixture({ tokenAddress: "0xToken1", reason: "token1" })
      );
      await insertOperatorDecision(
        db,
        decisionFixture({ tokenAddress: "0xToken2", reason: "token2" })
      );

      const rows = await listOperatorDecisions(db, CHAIN_ID, "0xToken1");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reason).toBe("token1");
    });
  });

  describe("getLatestSnapshotCapturedAt", () => {
    it("returns undefined when the chain has no snapshots", async () => {
      expect(
        await getLatestSnapshotCapturedAt(db, CHAIN_ID)
      ).toBeUndefined();
    });

    it("returns the single snapshot's captured_at", async () => {
      await insertPools(db, [poolFixture(CHAIN_ID, "0xPoolA")]);
      await insertPoolSnapshots(db, [
        snapshotFixture(CHAIN_ID, "0xPoolA", minutes(5))
      ]);
      expect(await getLatestSnapshotCapturedAt(db, CHAIN_ID)).toEqual(
        minutes(5)
      );
    });

    it("returns the max captured_at across pools, scoped per chain", async () => {
      await insertPools(db, [
        poolFixture(CHAIN_ID, "0xPoolA"),
        poolFixture(CHAIN_ID, "0xPoolB"),
        poolFixture(OTHER_CHAIN_ID, "0xPoolC")
      ]);
      await insertPoolSnapshots(db, [
        snapshotFixture(CHAIN_ID, "0xPoolA", minutes(5)),
        snapshotFixture(CHAIN_ID, "0xPoolB", minutes(30)),
        snapshotFixture(CHAIN_ID, "0xPoolA", minutes(15)),
        snapshotFixture(OTHER_CHAIN_ID, "0xPoolC", minutes(90))
      ]);

      expect(await getLatestSnapshotCapturedAt(db, CHAIN_ID)).toEqual(
        minutes(30)
      );
      expect(await getLatestSnapshotCapturedAt(db, OTHER_CHAIN_ID)).toEqual(
        minutes(90)
      );
    });
  });

  describe("listAlertsSent", () => {
    it("returns only alerts for the given chain, newest first", async () => {
      await insertAlertSent(
        db,
        alertFixture(CHAIN_ID, "0xToken1", { sentAt: minutes(0) })
      );
      await insertAlertSent(
        db,
        alertFixture(CHAIN_ID, "0xToken2", { sentAt: minutes(10) })
      );
      await insertAlertSent(
        db,
        alertFixture(OTHER_CHAIN_ID, "0xToken3", { sentAt: minutes(20) })
      );

      const rows = await listAlertsSent(db, CHAIN_ID);
      expect(rows.map((row) => row.tokenAddress)).toEqual([
        "0xToken2",
        "0xToken1"
      ]);
    });
  });

  describe("getLatestDeliveredAlertBySimilarName", () => {
    const SINCE = minutes(-60);

    beforeEach(async () => {
      await insertTokens(db, [
        {
          chainId: CHAIN_ID,
          address: "0xToken1",
          firstSeenBlock: 1n,
          name: "Robin World",
          symbol: "Robin",
          decimals: 18,
          totalSupply: "1",
          metadataStatus: "PASS"
        },
        {
          chainId: CHAIN_ID,
          address: "0xToken2",
          firstSeenBlock: 1n,
          name: "  ROBIN-WORLD! ",
          symbol: "RW",
          decimals: 18,
          totalSupply: "1",
          metadataStatus: "PASS"
        }
      ]);
    });

    it("matches a delivered sibling across punctuation/case/whitespace variants", async () => {
      await insertAlertSent(
        db,
        alertFixture(CHAIN_ID, "0xToken1", { sentAt: minutes(0) })
      );
      const sibling = await getLatestDeliveredAlertBySimilarName(
        db,
        CHAIN_ID,
        "  ROBIN-WORLD! ",
        "0xToken2",
        SINCE
      );
      expect(sibling?.tokenAddress).toBe("0xToken1");
    });

    it("never returns the excluded token itself", async () => {
      await insertAlertSent(
        db,
        alertFixture(CHAIN_ID, "0xToken1", { sentAt: minutes(0) })
      );
      expect(
        await getLatestDeliveredAlertBySimilarName(
          db,
          CHAIN_ID,
          "Robin World",
          "0xToken1",
          SINCE
        )
      ).toBeUndefined();
    });

    it("ignores undelivered rows and rows before the window", async () => {
      await insertAlertSent(
        db,
        alertFixture(CHAIN_ID, "0xToken1", {
          sentAt: minutes(0),
          delivered: false
        })
      );
      await insertAlertSent(
        db,
        alertFixture(CHAIN_ID, "0xToken1", { sentAt: minutes(-120) })
      );
      expect(
        await getLatestDeliveredAlertBySimilarName(
          db,
          CHAIN_ID,
          "Robin World",
          "0xToken2",
          SINCE
        )
      ).toBeUndefined();
    });

    it("returns undefined for a name normalizing to nothing", async () => {
      expect(
        await getLatestDeliveredAlertBySimilarName(
          db,
          CHAIN_ID,
          " ··· ",
          "0xToken2",
          SINCE
        )
      ).toBeUndefined();
    });
  });
});
