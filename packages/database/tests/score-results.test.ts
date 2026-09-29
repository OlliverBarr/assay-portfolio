import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  insertScoreResult,
  listTokenScoreResultsSince,
  type Db,
  type TokenScoreResultInsert
} from "../src/index.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

const CHAIN_ID = 5151;
const T0 = new Date("2024-09-01T00:00:00.000Z");

function minutes(n: number): Date {
  return new Date(T0.getTime() + n * 60_000);
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

describe("listTokenScoreResultsSince", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  it("returns only rows at/after `since`, ascending by scoredAt", async () => {
    await insertScoreResult(
      db,
      scoreFixture("0xBefore", "0xPool", minutes(0))
    );
    await insertScoreResult(
      db,
      scoreFixture("0xLater", "0xPool", minutes(20))
    );
    await insertScoreResult(
      db,
      scoreFixture("0xExact", "0xPool", minutes(10))
    );

    const rows = await listTokenScoreResultsSince(db, CHAIN_ID, minutes(10));

    expect(rows.map((row) => row.tokenAddress)).toEqual([
      "0xExact",
      "0xLater"
    ]);
    expect(rows[0]?.scoredAt.getTime()).toBeLessThan(
      rows[1]?.scoredAt.getTime() ?? 0
    );
  });

  it("scopes to the given chainId", async () => {
    await insertScoreResult(
      db,
      scoreFixture("0xOtherChain", "0xPool", minutes(30), {
        chainId: CHAIN_ID + 1
      })
    );
    await insertScoreResult(
      db,
      scoreFixture("0xThisChain", "0xPool", minutes(30))
    );

    const rows = await listTokenScoreResultsSince(db, CHAIN_ID, minutes(0));

    expect(rows.map((row) => row.tokenAddress)).toEqual(["0xThisChain"]);
  });
});
