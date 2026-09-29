import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  insertEligibilityResult,
  insertPools,
  insertPoolSnapshots,
  insertScoreResult,
  insertTokenPerformance,
  insertTokens,
  listWinnerRetroItems,
  type Db
} from "@assay/database";
import { createTestDatabase, type TestDatabaseHandle } from "@assay/database/testing";
import {
  DEFAULT_ALERT_THRESHOLDS,
  DEFAULT_ELIGIBILITY_CONFIG
} from "@assay/scoring";

import { runWinnersRetroPass } from "../src/winners-retro-pass.js";

const CHAIN_ID = 4747;
const POOL = "0xPoolWinner";
const TOKEN = "0xTokenWinner";
const WETH = "0xWethWethWethWethWethWethWethWethWethWe1";
const ENTRY_AT = new Date("2026-07-10T00:00:00Z");

function minutes(n: number): Date {
  return new Date(ENTRY_AT.getTime() + n * 60 * 1000);
}

/**
 * Seeds one band-entrant with a SUSTAINED 6x peak: entry FDV $50k, then a
 * full 15-minute bucket (3 snapshots) holding $300k with $18k quote
 * liquidity — clears both default-style bars used by the pass options below.
 */
async function seedWinner(db: Db): Promise<void> {
  await insertTokens(db, [
    {
      chainId: CHAIN_ID,
      address: TOKEN,
      firstSeenBlock: 100n,
      name: "Winner",
      symbol: "WIN",
      decimals: 18,
      totalSupply: "1000000000000000000000000",
      metadataStatus: "PASS"
    }
  ]);
  await insertPools(db, [
    {
      chainId: CHAIN_ID,
      poolAddress: POOL,
      factoryAddress: "0xFactory",
      dex: "uniswap",
      factoryKind: "uniswap-v2",
      token0Address: TOKEN,
      token1Address: WETH,
      quoteTokenAddress: WETH,
      baseTokenAddress: TOKEN,
      createdAtBlock: 100n,
      createdTxHash: `0x${"2".padStart(64, "0")}`,
      createdLogIndex: 0,
      discoveredAt: ENTRY_AT
    }
  ]);
  await insertPoolSnapshots(
    db,
    [0, 60, 61, 70, 74].map((minute, index) => ({
      chainId: CHAIN_ID,
      poolAddress: POOL,
      blockNumber: BigInt(200 + index),
      capturedAt: minutes(minute),
      calculationMethod: "v2-reserves",
      priceUsd: minute === 0 ? "0.00005" : "0.0003",
      estimatedFdvUsd: minute === 0 ? "50000" : "300000",
      quoteLiquidityUsd: minute === 0 ? "12000" : "18000",
      totalLiquidityUsd: minute === 0 ? "20000" : "36000"
    }))
  );
  await insertTokenPerformance(db, {
    chainId: CHAIN_ID,
    tokenAddress: TOKEN,
    poolAddress: POOL,
    horizonHours: 24,
    bandMinFdvUsd: "50000",
    bandMaxFdvUsd: "200000",
    enteredAt: ENTRY_AT,
    entryBlock: 200n,
    entryPriceUsd: "0.00005",
    entryFdvUsd: "50000",
    maxMultipleBps: 60_000,
    maxDrawdownBps: 1_000,
    minutesToPeak: 60,
    snapshotsInWindow: 5,
    entryFeatures: {},
    details: {}
  });
}

/** Shadow decision near entry: hard-gated on sell simulation. */
async function seedShadowDecision(db: Db): Promise<void> {
  await insertEligibilityResult(db, {
    chainId: CHAIN_ID,
    tokenAddress: TOKEN,
    poolAddress: POOL,
    blockNumber: 200n,
    eligible: false,
    failedRules: ["sellSimulationPass"],
    reasons: ["Sell simulation did not pass (status UNKNOWN)"],
    features: {},
    evaluatedAt: minutes(5)
  });
  await insertScoreResult(db, {
    chainId: CHAIN_ID,
    tokenAddress: TOKEN,
    poolAddress: POOL,
    blockNumber: 200n,
    eligible: false,
    score: 41,
    components: {},
    alertLevel: "RED",
    positiveReasons: [],
    riskReasons: [],
    scoredAt: minutes(5)
  });
}

describe("runWinnersRetroPass end-to-end", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    await seedWinner(db);
    await seedShadowDecision(db);
  });

  afterEach(async () => {
    await handle.close();
  });

  function runPass(sent: string[]) {
    return runWinnersRetroPass({
      db,
      chainId: CHAIN_ID,
      transport: {
        send(text: string): Promise<void> {
          sent.push(text);
          return Promise.resolve();
        }
      },
      minMultipleBps: 50_000,
      minExitLiquidityUsd: 15_000,
      alertMinScore: 50,
      alertMinScoreRed: 0,
      eligibilityConfig: DEFAULT_ELIGIBILITY_CONFIG,
      alertThresholds: DEFAULT_ALERT_THRESHOLDS
    });
  }

  it("detects a sustained winner, attributes the shadow hard gate, and sends one digest", async () => {
    const sent: string[] = [];
    const result = await runPass(sent);

    expect(result.poolErrors).toEqual([]);
    expect(result.candidates).toBe(1);
    expect(result.evaluated).toBe(1);
    expect(result.newWinners).toBe(1);
    expect(result.digestSent).toBe(true);
    expect(sent).toHaveLength(1);

    // Digest carries the escaped identity, tier, and gate detail.
    expect(sent[0]).toContain("<code>0xTokenWinner</code>");
    expect(sent[0]).toContain("T5");
    expect(sent[0]).toContain("sellSimulationPass");
    expect(sent[0]).toContain("provisional");

    const rows = await listWinnerRetroItems(db, CHAIN_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.coverageTier).toBe(5);
    expect(rows[0]?.sustainedMultipleBps).toBe(60_000);
    expect(rows[0]?.exitQuoteLiquidityUsd).toContain("18000");
    expect(rows[0]?.alerted).toBe(false);
    expect(rows[0]?.provisional).toBe(true);
  });

  it("is idempotent: a second pass evaluates nothing and sends no digest", async () => {
    const first: string[] = [];
    await runPass(first);
    expect(first).toHaveLength(1);

    const second: string[] = [];
    const result = await runPass(second);
    expect(result.candidates).toBe(0);
    expect(result.newWinners).toBe(0);
    expect(result.digestSent).toBe(false);
    expect(second).toHaveLength(0);
    expect(await listWinnerRetroItems(db, CHAIN_ID)).toHaveLength(1);
  });

  it("persists a non-qualifying near-miss without sending a digest", async () => {
    // Second candidate: wick 5x but never a confirmed sustained bucket
    // (single snapshot at the peak) — evaluated, persisted, not a winner.
    const POOL2 = "0xPoolWick";
    const TOKEN2 = "0xTokenWick";
    await insertPools(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: POOL2,
        factoryAddress: "0xFactory",
        dex: "uniswap",
        factoryKind: "uniswap-v2",
        token0Address: TOKEN2,
        token1Address: WETH,
        quoteTokenAddress: WETH,
        baseTokenAddress: TOKEN2,
        createdAtBlock: 101n,
        createdTxHash: `0x${"3".padStart(64, "0")}`,
        createdLogIndex: 0,
        discoveredAt: ENTRY_AT
      }
    ]);
    await insertPoolSnapshots(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: POOL2,
        blockNumber: 300n,
        capturedAt: minutes(30),
        calculationMethod: "v2-reserves",
        priceUsd: "0.0003",
        estimatedFdvUsd: "300000",
        quoteLiquidityUsd: "18000",
        totalLiquidityUsd: "36000"
      }
    ]);
    await insertTokenPerformance(db, {
      chainId: CHAIN_ID,
      tokenAddress: TOKEN2,
      poolAddress: POOL2,
      horizonHours: 24,
      bandMinFdvUsd: "50000",
      bandMaxFdvUsd: "200000",
      enteredAt: ENTRY_AT,
      entryBlock: 300n,
      entryPriceUsd: "0.00005",
      entryFdvUsd: "50000",
      maxMultipleBps: 60_000,
      maxDrawdownBps: 1_000,
      minutesToPeak: 30,
      snapshotsInWindow: 1,
      entryFeatures: {},
      details: {}
    });

    const sent: string[] = [];
    const result = await runPass(sent);

    expect(result.evaluated).toBe(2);
    // Only the sustained pool qualifies; the wick is persisted but silent.
    expect(result.newWinners).toBe(1);
    const rows = await listWinnerRetroItems(db, CHAIN_ID);
    expect(rows).toHaveLength(2);
    const wick = rows.find((row) => row.poolAddress === POOL2);
    expect(wick?.sustainedMultipleBps).toBe(0);
  });

  /** Full post-2026-07-15 entry-feature shape; sim FAIL (explicit honeypot signature) so replay hard-gates under the 2026-07-20 missing≠fail contract. */
  const REPLAY_ENTRY_FEATURES = {
    quoteLiquidityUsd: "12000",
    totalLiquidityUsd: "20000",
    ageMinutesAtEntry: 45,
    uniqueBuyers20m: 12,
    uniqueBuyers1h: 30,
    buyCount20m: 25,
    sellCount20m: 5,
    quoteBuyVolumeRaw20m: "2000000000000000000",
    quoteSellVolumeRaw20m: "500000000000000000",
    buySizeGiniBps: 3_000,
    buySizeEntropyBps: 8_000,
    repeatedSizeBuyPctBps: 400,
    floatBps: 9_000,
    supplyInPoolBps: 7_000,
    adjustedTop10PctBps: 2_000,
    deployerPctBps: 200,
    holderCount: 120,
    adjustedHolderCount: 100,
    largestHolderPctBps: 700,
    holderClusterScoreBps: 100,
    riskStatus: "UNKNOWN",
    simulationStatus: "FAIL",
    effectiveSellLossBps: null,
    criticalPermissionPresent: false,
    isProxy: null,
    verificationStatus: "UNKNOWN"
  };

  async function seedSecondWinner(entryFeatures: unknown): Promise<void> {
    const POOL3 = "0xPoolReplay";
    const TOKEN3 = "0xTokenReplay";
    await insertPools(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: POOL3,
        factoryAddress: "0xFactory",
        dex: "uniswap",
        factoryKind: "uniswap-v2",
        token0Address: TOKEN3,
        token1Address: WETH,
        quoteTokenAddress: WETH,
        baseTokenAddress: TOKEN3,
        createdAtBlock: 102n,
        createdTxHash: `0x${"4".padStart(64, "0")}`,
        createdLogIndex: 0,
        discoveredAt: ENTRY_AT
      }
    ]);
    await insertPoolSnapshots(
      db,
      [0, 60, 61, 70, 74].map((minute, index) => ({
        chainId: CHAIN_ID,
        poolAddress: POOL3,
        blockNumber: BigInt(400 + index),
        capturedAt: minutes(minute),
        calculationMethod: "v2-reserves",
        priceUsd: minute === 0 ? "0.00005" : "0.0003",
        estimatedFdvUsd: minute === 0 ? "50000" : "300000",
        quoteLiquidityUsd: minute === 0 ? "12000" : "18000",
        totalLiquidityUsd: minute === 0 ? "20000" : "36000"
      }))
    );
    await insertTokenPerformance(db, {
      chainId: CHAIN_ID,
      tokenAddress: TOKEN3,
      poolAddress: POOL3,
      horizonHours: 24,
      bandMinFdvUsd: "50000",
      bandMaxFdvUsd: "200000",
      enteredAt: ENTRY_AT,
      entryBlock: 400n,
      entryPriceUsd: "0.00005",
      entryFdvUsd: "50000",
      maxMultipleBps: 60_000,
      maxDrawdownBps: 1_000,
      minutesToPeak: 60,
      snapshotsInWindow: 5,
      entryFeatures,
      details: {}
    });
  }

  it("replays the stored entry vector when no shadow decision exists near entry", async () => {
    await seedSecondWinner(REPLAY_ENTRY_FEATURES);

    const sent: string[] = [];
    const result = await runPass(sent);
    expect(result.poolErrors).toEqual([]);
    expect(result.newWinners).toBe(2);

    const rows = await listWinnerRetroItems(db, CHAIN_ID);
    const replayed = rows.find((row) => row.poolAddress === "0xPoolReplay");
    expect(replayed?.coverageTier).toBe(5);
    expect(replayed?.tierLabel).toBe("hard-gated");
    const attribution = replayed?.gateAttribution as { source: string; failedRules: string[] };
    expect(attribution.source).toBe("replay");
    expect(attribution.failedRules).toContain("sellSimulationPass");
    // Digest names the replayed failing rule, not "signals missing".
    expect(sent[0]).toContain("0xTokenReplay");
    expect(sent[0]).toContain("sellSimulationPass");
  });

  it("keeps tier 4 for pre-gate-input legacy entry features with no shadow row", async () => {
    // The 2026-07-11..14 production shape lacked risk-permission and 20m
    // activity fields; replaying it would fabricate gate inputs, so it must
    // stay attributed as signals-missing.
    await seedSecondWinner({
      quoteLiquidityUsd: "12000",
      totalLiquidityUsd: "20000",
      ageMinutesAtEntry: 45,
      uniqueBuyers1h: 30,
      riskStatus: "PASS",
      simulationStatus: "PASS",
      effectiveSellLossBps: 200
    });

    const sent: string[] = [];
    await runPass(sent);

    const rows = await listWinnerRetroItems(db, CHAIN_ID);
    const legacy = rows.find((row) => row.poolAddress === "0xPoolReplay");
    expect(legacy?.coverageTier).toBe(4);
    expect(legacy?.tierLabel).toBe("signals-missing");
    expect((legacy?.gateAttribution as { source: string }).source).toBe("none");
  });
});
