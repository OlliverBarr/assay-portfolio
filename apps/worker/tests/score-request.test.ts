import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  insertPoolActivitySnapshots,
  insertPools,
  insertPoolSnapshots,
  insertTokens,
  type Db
} from "@assay/database";
import { createTestDatabase, type TestDatabaseHandle } from "@assay/database/testing";
import {
  DEFAULT_ALERT_THRESHOLDS,
  DEFAULT_ELIGIBILITY_CONFIG
} from "@assay/scoring";

import { buildScorecard, parseScoreRequest } from "../src/score-request.js";

const ADDRESS = `0x${"a".repeat(40)}`;

describe("parseScoreRequest", () => {
  it("accepts a bare pasted address and lowercases it", () => {
    expect(parseScoreRequest(` 0x${"A".repeat(40)} `)).toEqual({
      kind: "score",
      tokenAddress: ADDRESS
    });
  });

  it("accepts /score with an address argument", () => {
    expect(parseScoreRequest(`/score ${ADDRESS}`)).toEqual({
      kind: "score",
      tokenAddress: ADDRESS
    });
  });

  it("accepts a bot-suffixed, case-insensitive command", () => {
    expect(parseScoreRequest(`/SCORE@assay_bot ${ADDRESS}`)).toEqual({
      kind: "score",
      tokenAddress: ADDRESS
    });
  });

  it("returns usage for /score without a valid address", () => {
    expect(parseScoreRequest("/score")).toEqual({ kind: "usage" });
    expect(parseScoreRequest("/score not-an-address")).toEqual({
      kind: "usage"
    });
    expect(parseScoreRequest("/score 0x1234")).toEqual({ kind: "usage" });
  });

  it("ignores ordinary messages, including embedded addresses", () => {
    expect(parseScoreRequest("gm")).toBeUndefined();
    expect(parseScoreRequest(`check out ${ADDRESS} today`)).toBeUndefined();
    expect(parseScoreRequest("/join code")).toBeUndefined();
  });
});

describe("buildScorecard", () => {
  const CHAIN_ID = 4242;
  const POOL = "0xPoolScore";
  const TOKEN = "0xTokenScore";
  const WETH = "0xWethWethWethWethWethWethWethWethWethWe1";

  let handle: TestDatabaseHandle;
  let db: Db;

  const options = () => ({
    db,
    chainId: CHAIN_ID,
    eligibilityConfig: DEFAULT_ELIGIBILITY_CONFIG,
    alertThresholds: DEFAULT_ALERT_THRESHOLDS
  });

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  async function seedPool(
    poolAddress: string,
    withSnapshot: boolean
  ): Promise<void> {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    await insertPools(db, [
      {
        chainId: CHAIN_ID,
        poolAddress,
        factoryAddress: "0xFactory",
        dex: "uniswap",
        factoryKind: "uniswap-v2",
        token0Address: TOKEN,
        token1Address: WETH,
        quoteTokenAddress: WETH,
        baseTokenAddress: TOKEN,
        createdAtBlock: 100n,
        createdTxHash: `0x${"1".padStart(64, "0")}`,
        createdLogIndex: 0,
        discoveredAt: thirtyMinAgo
      }
    ]);
    if (!withSnapshot) return;
    await insertPoolSnapshots(db, [
      {
        chainId: CHAIN_ID,
        poolAddress,
        blockNumber: 200n,
        capturedAt: new Date(),
        calculationMethod: "v2-reserves",
        priceUsd: "0.00006",
        estimatedFdvUsd: "25000",
        quoteLiquidityUsd: "18000",
        totalLiquidityUsd: "20000"
      }
    ]);
    await insertPoolActivitySnapshots(db, [
      {
        chainId: CHAIN_ID,
        poolAddress,
        blockNumber: 200n,
        capturedAt: new Date(),
        uniqueBuyers20m: 8,
        uniqueBuyers1h: 20,
        buyCount20m: 10,
        sellCount20m: 2,
        quoteBuyVolumeRaw20m: "1000",
        quoteSellVolumeRaw20m: "100",
        quoteBuyVolumeRaw1h: "5000",
        quoteSellVolumeRaw1h: "500"
      }
    ]);
  }

  it("explains when no trusted-quote pool exists for the token", async () => {
    const text = await buildScorecard(options(), ADDRESS);
    expect(text).toContain("No trusted-quote pool found");
    expect(text).toContain(ADDRESS);
  });

  it("explains when the pool has no market snapshot yet", async () => {
    await seedPool(POOL, false);
    const text = await buildScorecard(options(), TOKEN.toLowerCase());
    expect(text).toContain("no market snapshot");
    expect(text).toContain("1 trusted-quote pool");
  });

  it("renders an explainable scorecard from persisted signals", async () => {
    await insertTokens(db, [
      {
        chainId: CHAIN_ID,
        address: TOKEN,
        firstSeenBlock: 100n,
        name: "Fixture",
        symbol: "FIX",
        decimals: 18,
        totalSupply: "1000000000000000000000000",
        metadataStatus: "PASS"
      }
    ]);
    await seedPool(POOL, true);

    // Lowercased input (as parseScoreRequest emits) must still match the
    // mixed-case stored address.
    const text = await buildScorecard(options(), TOKEN.toLowerCase());

    expect(text).toContain("Fixture (FIX)");
    expect(text).toMatch(/Score \d+\/100/);
    expect(text).toContain("Components: liquidity ");
    expect(text).toContain("FDV $25,000");
    expect(text).toContain("quote $18,000");
    expect(text).toContain("Buyers 1h 20 (20m 8)");
    expect(text).toMatch(/snapshot \d+m old/);
    expect(text).toContain("block 200");
    // Plain-text reply ends with the token address for tap-to-copy.
    expect(text.trimEnd().endsWith(TOKEN)).toBe(true);
  });

  it("scores the best of several trusted-quote pools", async () => {
    await seedPool(POOL, true);
    await seedPool("0xPoolScore2", false);

    const text = await buildScorecard(options(), TOKEN.toLowerCase());
    expect(text).toContain("best of 2 pools");
  });
});
