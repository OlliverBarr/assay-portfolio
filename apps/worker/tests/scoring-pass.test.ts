import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  insertPoolActivitySnapshots,
  insertPools,
  insertPoolSnapshots,
  insertTokenRisk,
  insertTokens,
  listAlertsSent,
  tokenEligibilityResults,
  tokenScoreResults,
  type Db
} from "@assay/database";
import { createTestDatabase, type TestDatabaseHandle } from "@assay/database/testing";
import type { ChainConfig } from "@assay/chain";
import {
  DEFAULT_ALERT_THRESHOLDS,
  DEFAULT_ELIGIBILITY_CONFIG
} from "@assay/scoring";

import { runScoringPass } from "../src/scoring-pass.js";

const CHAIN_ID = 4242;
const POOL = "0xPoolYellow";
const TOKEN = "0xTokenYellow";
const WETH = "0xWethWethWethWethWethWethWethWethWethWe1";

const CONFIG = {
  chainId: CHAIN_ID,
  rpcUrl: "http://localhost:0",
  factories: [],
  quoteAssets: []
} as unknown as ChainConfig;

/**
 * End-to-end funnel regression: a pool whose signals satisfy YELLOW must
 * produce a persisted eligibility row, a persisted score row, and a
 * delivered alert — with zero pool errors. This exact path was silently
 * broken in production for a full day: candidates existed but every persist
 * threw (bigint in the features jsonb) and the pass only logged an error
 * COUNT. Nothing short of an end-to-end assertion catches that class.
 *
 * Fixture: $25k FDV, $18k quote, 20 buyers/1h, sim UNKNOWN. Under the
 * 2026-07-20 contract this is ELIGIBLE (missing sim is flagged, not
 * failed) and classifies YELLOW (research tier).
 */
describe("runScoringPass end-to-end", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;

    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
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
        createdTxHash: `0x${"1".padStart(64, "0")}`,
        createdLogIndex: 0,
        discoveredAt: thirtyMinAgo
      }
    ]);
    await insertPoolSnapshots(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: POOL,
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
        poolAddress: POOL,
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
  });

  afterEach(async () => {
    await handle.close();
  });

  it("persists eligibility + score and delivers a YELLOW research alert with zero pool errors", async () => {
    const sent: string[] = [];
    const result = await runScoringPass({
      db,
      config: CONFIG,
      transport: {
        send(text: string): Promise<void> {
          sent.push(text);
          return Promise.resolve();
        }
      },
      transportName: "dry-run",
      alertCooldownMs: 60_000,
      alertMinScore: 0,
      alertMinScoreRed: 0,
      reAlertMinScoreDelta: 0,
      duplicateNameCooldownMs: 0,
      eligibilityConfig: DEFAULT_ELIGIBILITY_CONFIG,
      alertThresholds: DEFAULT_ALERT_THRESHOLDS
    });

    expect(result.poolErrors).toEqual([]);
    expect(result.yellow).toBe(1);
    expect(result.candidates).toBe(1);
    expect(result.alertsEmitted).toBe(1);
    expect(sent).toHaveLength(1);

    const alerts = await listAlertsSent(db, CHAIN_ID);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.alertLevel).toBe("YELLOW");
    expect(alerts[0]?.delivered).toBe(true);
  });

  it("gates out-of-band pools before the signal battery when a band is set", async () => {
    const result = await runScoringPass({
      db,
      config: CONFIG,
      transport: {
        send: () => Promise.resolve()
      },
      transportName: "dry-run",
      alertCooldownMs: 60_000,
      alertMinScore: 0,
      alertMinScoreRed: 0,
      reAlertMinScoreDelta: 0,
      duplicateNameCooldownMs: 0,
      eligibilityConfig: DEFAULT_ELIGIBILITY_CONFIG,
      alertThresholds: DEFAULT_ALERT_THRESHOLDS,
      band: {
        minFdvUsd: 100_000,
        maxFdvUsd: 300_000
      }
    });

    // FDV 25k sits below the 100k band floor: SQL selection never returns
    // the pool, so it is never evaluated or alerted.
    expect(result.poolsEvaluated).toBe(0);
    expect(result.candidates).toBe(0);
    expect(result.shadowLogged).toBe(0);
    expect(await listAlertsSent(db, CHAIN_ID)).toHaveLength(0);
  });

  it("stores eligibility + score but suppresses delivery when the score is below alertMinScore", async () => {
    const sent: string[] = [];
    const result = await runScoringPass({
      db,
      config: CONFIG,
      transport: {
        send(text: string): Promise<void> {
          sent.push(text);
          return Promise.resolve();
        }
      },
      transportName: "dry-run",
      alertCooldownMs: 60_000,
      // Fixture candidate scores well below 100: the gate must suppress.
      alertMinScore: 100,
      alertMinScoreRed: 0,
      reAlertMinScoreDelta: 0,
      duplicateNameCooldownMs: 0,
      eligibilityConfig: DEFAULT_ELIGIBILITY_CONFIG,
      alertThresholds: DEFAULT_ALERT_THRESHOLDS
    });

    expect(result.poolErrors).toEqual([]);
    // Still classified and tracked as a candidate…
    expect(result.yellow).toBe(1);
    expect(result.candidates).toBe(1);
    expect(result.shadowLogged).toBe(0);
    const scoreRows = await db.select().from(tokenScoreResults);
    expect(scoreRows).toHaveLength(1);
    // …but nothing is delivered or recorded as sent.
    expect(result.alertsEmitted).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await listAlertsSent(db, CHAIN_ID)).toHaveLength(0);
  });

  it("suppresses a RED delivery below alertMinScoreRed while keeping the candidate persisted", async () => {
    // Thin out the activity (later block wins): 6 buyers/1h clears the RED
    // buyer floor (5) but the score falls below the YELLOW floor (65), so
    // the candidate classifies RED, the tier the RED-only floor gates.
    await insertPoolActivitySnapshots(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: POOL,
        blockNumber: 201n,
        capturedAt: new Date(),
        uniqueBuyers20m: 2,
        uniqueBuyers1h: 6,
        buyCount20m: 3,
        sellCount20m: 1,
        quoteBuyVolumeRaw20m: "200",
        quoteSellVolumeRaw20m: "50",
        quoteBuyVolumeRaw1h: "800",
        quoteSellVolumeRaw1h: "150"
      }
    ]);
    const sent: string[] = [];
    const result = await runScoringPass({
      db,
      config: CONFIG,
      transport: {
        send(text: string): Promise<void> {
          sent.push(text);
          return Promise.resolve();
        }
      },
      transportName: "dry-run",
      alertCooldownMs: 60_000,
      // Global floor cleared (0), but the fixture's RED score sits below
      // the RED-only floor: early-watch delivery must be withheld.
      alertMinScore: 0,
      alertMinScoreRed: 100,
      reAlertMinScoreDelta: 0,
      duplicateNameCooldownMs: 0,
      eligibilityConfig: DEFAULT_ELIGIBILITY_CONFIG,
      alertThresholds: DEFAULT_ALERT_THRESHOLDS
    });

    expect(result.poolErrors).toEqual([]);
    expect(result.red).toBe(1);
    expect(result.candidates).toBe(1);
    const scoreRows = await db.select().from(tokenScoreResults);
    expect(scoreRows).toHaveLength(1);
    expect(result.alertsEmitted).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await listAlertsSent(db, CHAIN_ID)).toHaveLength(0);
  });

  it("delivers only the first of a same-named copycat wave within the duplicate-name window", async () => {
    // Second token: different address, name normalizing identically to the
    // fixture's ("Fixture" vs "  FIXTURE! ") — the live 2026-07-12 "Robin
    // World" wave, four contracts alerting within 11 seconds.
    const COPY_TOKEN = "0xTokenYellowCopy";
    const COPY_POOL = "0xPoolYellowCopy";
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    await insertTokens(db, [
      {
        chainId: CHAIN_ID,
        address: COPY_TOKEN,
        firstSeenBlock: 101n,
        name: "  FIXTURE! ",
        symbol: "FIX2",
        decimals: 18,
        totalSupply: "1000000000000000000000000",
        metadataStatus: "PASS"
      }
    ]);
    await insertPools(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: COPY_POOL,
        factoryAddress: "0xFactory",
        dex: "uniswap",
        factoryKind: "uniswap-v2",
        token0Address: COPY_TOKEN,
        token1Address: WETH,
        quoteTokenAddress: WETH,
        baseTokenAddress: COPY_TOKEN,
        createdAtBlock: 101n,
        createdTxHash: `0x${"2".padStart(64, "0")}`,
        createdLogIndex: 0,
        discoveredAt: thirtyMinAgo
      }
    ]);
    await insertPoolSnapshots(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: COPY_POOL,
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
        poolAddress: COPY_POOL,
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

    const sent: string[] = [];
    const result = await runScoringPass({
      db,
      config: CONFIG,
      transport: {
        send(text: string): Promise<void> {
          sent.push(text);
          return Promise.resolve();
        }
      },
      transportName: "dry-run",
      alertCooldownMs: 60_000,
      alertMinScore: 0,
      alertMinScoreRed: 0,
      reAlertMinScoreDelta: 0,
      duplicateNameCooldownMs: 6 * 60 * 60 * 1000,
      eligibilityConfig: DEFAULT_ELIGIBILITY_CONFIG,
      alertThresholds: DEFAULT_ALERT_THRESHOLDS
    });

    expect(result.poolErrors).toEqual([]);
    // Both candidates evaluated and persisted…
    expect(result.candidates).toBe(2);
    const scoreRows = await db.select().from(tokenScoreResults);
    expect(scoreRows).toHaveLength(2);
    // …but the identically-named, same-level sibling delivers only once.
    expect(result.alertsEmitted).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await listAlertsSent(db, CHAIN_ID)).toHaveLength(1);
  });
});

/**
 * Shadow-logging regression: GRAY candidates used to be skipped entirely
 * (`if (level === "GRAY") continue;` before any persistence), which means
 * threshold recalibration could only ever see the alerted population —
 * pure selection bias. GRAY rows must now persist under a throttle (so an
 * unmoving classification doesn't flood the tables) while still never
 * alerting.
 */
describe("runScoringPass shadow logging (GRAY candidates)", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  const GRAY_POOL = "0xPoolGray";
  const GRAY_TOKEN = "0xTokenGray";
  const BAND = { minFdvUsd: 40_000, maxFdvUsd: 100_000 };

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;

    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    await insertTokens(db, [
      {
        chainId: CHAIN_ID,
        address: GRAY_TOKEN,
        firstSeenBlock: 100n,
        name: "Fixture Gray",
        symbol: "GRY",
        decimals: 18,
        totalSupply: "1000000000000000000000000",
        metadataStatus: "PASS"
      }
    ]);
    await insertPools(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: GRAY_POOL,
        factoryAddress: "0xFactory",
        dex: "uniswap",
        factoryKind: "uniswap-v2",
        token0Address: GRAY_TOKEN,
        token1Address: WETH,
        quoteTokenAddress: WETH,
        baseTokenAddress: GRAY_TOKEN,
        createdAtBlock: 100n,
        createdTxHash: `0x${"2".padStart(64, "0")}`,
        createdLogIndex: 0,
        discoveredAt: thirtyMinAgo
      }
    ]);
    // In-band FDV (60k, inside the 40k-100k selection band) with too few
    // distinct buyers for the RED early-watch tier (3 < 5) and a score far
    // below the YELLOW floor: classifies GRAY (2026-07-20 tiers).
    await insertPoolSnapshots(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: GRAY_POOL,
        blockNumber: 200n,
        capturedAt: new Date(),
        calculationMethod: "v2-reserves",
        priceUsd: "0.00006",
        estimatedFdvUsd: "60000",
        quoteLiquidityUsd: "18000",
        totalLiquidityUsd: "20000"
      }
    ]);
    await insertPoolActivitySnapshots(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: GRAY_POOL,
        blockNumber: 200n,
        capturedAt: new Date(),
        uniqueBuyers20m: 2,
        uniqueBuyers1h: 3,
        buyCount20m: 3,
        sellCount20m: 1,
        quoteBuyVolumeRaw20m: "200",
        quoteSellVolumeRaw20m: "50",
        quoteBuyVolumeRaw1h: "800",
        quoteSellVolumeRaw1h: "150"
      }
    ]);
  });

  afterEach(async () => {
    await handle.close();
  });

  function runPass(overrides: { shadowIntervalMs?: number } = {}) {
    return runScoringPass({
      db,
      config: CONFIG,
      transport: { send: () => Promise.resolve() },
      transportName: "dry-run",
      alertCooldownMs: 60_000,
      alertMinScore: 0,
      alertMinScoreRed: 0,
      reAlertMinScoreDelta: 0,
      duplicateNameCooldownMs: 0,
      eligibilityConfig: DEFAULT_ELIGIBILITY_CONFIG,
      alertThresholds: DEFAULT_ALERT_THRESHOLDS,
      band: BAND,
      ...overrides
    });
  }

  it("persists eligibility + score for a GRAY band candidate and counts it in shadowLogged", async () => {
    const result = await runPass();

    expect(result.poolErrors).toEqual([]);
    expect(result.poolsEvaluated).toBe(1);
    expect(result.candidates).toBe(0);
    expect(result.shadowLogged).toBe(1);

    const scoreRows = await db.select().from(tokenScoreResults);
    expect(scoreRows).toHaveLength(1);
    expect(scoreRows[0]?.alertLevel).toBe("GRAY");

    const eligibilityRows = await db.select().from(tokenEligibilityResults);
    expect(eligibilityRows).toHaveLength(1);
  });

  it("does not duplicate GRAY shadow-log rows on a second pass within shadowIntervalMs", async () => {
    const first = await runPass({ shadowIntervalMs: 3_600_000 });
    expect(first.shadowLogged).toBe(1);

    const second = await runPass({ shadowIntervalMs: 3_600_000 });
    expect(second.shadowLogged).toBe(0);

    const scoreRows = await db.select().from(tokenScoreResults);
    expect(scoreRows).toHaveLength(1);
    const eligibilityRows = await db.select().from(tokenEligibilityResults);
    expect(eligibilityRows).toHaveLength(1);
  });

  it("never sends an alert for a GRAY candidate, shadow-logged or not", async () => {
    const sent: string[] = [];
    const result = await runScoringPass({
      db,
      config: CONFIG,
      transport: {
        send(text: string): Promise<void> {
          sent.push(text);
          return Promise.resolve();
        }
      },
      transportName: "dry-run",
      alertCooldownMs: 60_000,
      // A minScore of 0 would deliver any alerted level; GRAY still must not.
      alertMinScore: 0,
      alertMinScoreRed: 0,
      reAlertMinScoreDelta: 0,
      duplicateNameCooldownMs: 0,
      eligibilityConfig: DEFAULT_ELIGIBILITY_CONFIG,
      alertThresholds: DEFAULT_ALERT_THRESHOLDS,
      band: BAND
    });

    expect(result.shadowLogged).toBe(1);
    expect(result.alertsEmitted).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await listAlertsSent(db, CHAIN_ID)).toHaveLength(0);
  });

  it("skips the shadow log entirely for a GRAY candidate with zero buyers in the last hour", async () => {
    // Dead band pools (final FDV frozen in-band) would otherwise be
    // re-persisted every interval forever (live 2026-07-12: 3,233 band
    // pools, 146 with a buyer in the hour).
    await insertPoolActivitySnapshots(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: GRAY_POOL,
        blockNumber: 201n,
        capturedAt: new Date(),
        uniqueBuyers20m: 0,
        uniqueBuyers1h: 0,
        buyCount20m: 0,
        sellCount20m: 0,
        quoteBuyVolumeRaw20m: "0",
        quoteSellVolumeRaw20m: "0",
        quoteBuyVolumeRaw1h: "0",
        quoteSellVolumeRaw1h: "0"
      }
    ]);

    const result = await runPass();
    expect(result.poolsEvaluated).toBe(1);
    expect(result.shadowLogged).toBe(0);
    expect(await db.select().from(tokenScoreResults)).toHaveLength(0);
  });
});

/**
 * $10k–$100k band move (2026-07-13): the pass must surface a sub-$40k
 * candidate under the new default config, and the SAME features under an
 * explicit legacy config must classify GRAY/ineligible — proving the band
 * tracks the threaded config rather than hardcoded constants.
 */
describe("runScoringPass low-band config threading", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  const LOW_POOL = "0xPoolLowBand";
  const LOW_TOKEN = "0xTokenLowBand";

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;

    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    await insertTokens(db, [
      {
        chainId: CHAIN_ID,
        address: LOW_TOKEN,
        firstSeenBlock: 100n,
        name: "Low Band Fixture",
        symbol: "LOW",
        decimals: 18,
        totalSupply: "1000000000000000000000000",
        metadataStatus: "PASS"
      }
    ]);
    await insertPools(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: LOW_POOL,
        factoryAddress: "0xFactory",
        dex: "uniswap",
        factoryKind: "uniswap-v2",
        token0Address: LOW_TOKEN,
        token1Address: WETH,
        quoteTokenAddress: WETH,
        baseTokenAddress: LOW_TOKEN,
        createdAtBlock: 100n,
        createdTxHash: `0x${"3".padStart(64, "0")}`,
        createdLogIndex: 0,
        discoveredAt: thirtyMinAgo
      }
    ]);
    // $15k FDV with band-proportional liquidity: the 2026-07-20 GREEN/YELLOW
    // sweet-spot floor, far below the legacy eligibility floor (75k) and the
    // legacy RED band min (40k).
    await insertPoolSnapshots(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: LOW_POOL,
        blockNumber: 200n,
        capturedAt: new Date(),
        calculationMethod: "v2-reserves",
        priceUsd: "0.000015",
        estimatedFdvUsd: "15000",
        quoteLiquidityUsd: "6000",
        totalLiquidityUsd: "8000"
      }
    ]);
    await insertPoolActivitySnapshots(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: LOW_POOL,
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
    // Passing simulation so the hard eligibility rules can all pass.
    await insertTokenRisk(db, {
      chainId: CHAIN_ID,
      tokenAddress: LOW_TOKEN,
      poolAddress: LOW_POOL,
      blockNumber: 200n,
      assessedAt: new Date(),
      status: "PASS",
      verificationStatus: "VERIFIED",
      permissionFindings: [],
      simulationStatus: "PASS",
      effectiveSellLossBps: 150,
      riskReasons: [],
      positiveReasons: []
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  function runPass(configs: {
    eligibilityConfig: typeof DEFAULT_ELIGIBILITY_CONFIG;
    alertThresholds: typeof DEFAULT_ALERT_THRESHOLDS;
  }) {
    return runScoringPass({
      db,
      config: CONFIG,
      transport: { send: () => Promise.resolve() },
      transportName: "dry-run",
      alertCooldownMs: 60_000,
      alertMinScore: 0,
      alertMinScoreRed: 0,
      reAlertMinScoreDelta: 0,
      duplicateNameCooldownMs: 0,
      ...configs
    });
  }

  it("classifies a $15k candidate YELLOW and eligible under the new default config", async () => {
    const result = await runPass({
      eligibilityConfig: DEFAULT_ELIGIBILITY_CONFIG,
      alertThresholds: DEFAULT_ALERT_THRESHOLDS
    });

    expect(result.poolErrors).toEqual([]);
    // $15k is the YELLOW band floor; score (sub-GREEN, above the YELLOW
    // floor) lands it in the research tier.
    expect(result.yellow).toBe(1);
    expect(result.candidates).toBe(1);

    const eligibilityRows = await db.select().from(tokenEligibilityResults);
    expect(eligibilityRows).toHaveLength(1);
    expect(eligibilityRows[0]?.eligible).toBe(true);
    const scoreRows = await db.select().from(tokenScoreResults);
    expect(scoreRows[0]?.alertLevel).toBe("YELLOW");
  });

  it("classifies the identical candidate GRAY and ineligible under an explicit legacy config", async () => {
    const result = await runPass({
      eligibilityConfig: {
        ...DEFAULT_ELIGIBILITY_CONFIG,
        minFdvUsd: 75_000,
        maxFdvUsd: 250_000,
        minTotalLiquidityUsd: 20_000,
        minQuoteLiquidityUsd: 10_000,
        minUniqueBuyers: 30
      },
      alertThresholds: {
        ...DEFAULT_ALERT_THRESHOLDS,
        redMinFdvUsd: 40_000,
        redMaxFdvUsd: 100_000,
        redMinLiquidityUsd: 15_000,
        redMinUniqueBuyers: 15
      }
    });

    expect(result.poolErrors).toEqual([]);
    expect(result.red).toBe(0);
    expect(result.candidates).toBe(0);
    // GRAY → shadow-logged, not alerted; the persisted row is ineligible.
    expect(result.shadowLogged).toBe(1);
    expect(result.alertsEmitted).toBe(0);
    const eligibilityRows = await db.select().from(tokenEligibilityResults);
    expect(eligibilityRows).toHaveLength(1);
    expect(eligibilityRows[0]?.eligible).toBe(false);
    const scoreRows = await db.select().from(tokenScoreResults);
    expect(scoreRows[0]?.alertLevel).toBe("GRAY");
  });
});
