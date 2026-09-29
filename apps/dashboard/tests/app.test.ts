import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  insertAlertSent,
  insertPools,
  insertScoreResult,
  insertTokenPerformance,
  insertTokens,
  type AlertSentInsert,
  type Db,
  type FeatureQuartiles,
  type FunnelSummary,
  type JudgmentQuality,
  type LaunchCadencePoint,
  type PoolInsert,
  type PrecisionCurve,
  type RecentAlertRow,
  type SurvivalPoint,
  type TokenInsert,
  type TokenPerformanceInsert,
  type TokenScoreResultInsert
} from "@assay/database";
import {
  createTestDatabase,
  type TestDatabaseHandle
} from "@assay/database/testing";

import { buildDashboardApp } from "../src/app.js";

const CHAIN_ID = 4663;
const POOL = "0x1111111111111111111111111111111111111111";
const BASE = "0x3333333333333333333333333333333333333333";
const QUOTE = "0x4444444444444444444444444444444444444444";
const T0 = new Date("2026-05-01T00:00:00.000Z");

function poolFixture(overrides: Partial<PoolInsert> = {}): PoolInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress: POOL,
    factoryAddress: "0x2222222222222222222222222222222222222222",
    dex: "uniswap",
    factoryKind: "uniswap-v2",
    token0Address: BASE,
    token1Address: QUOTE,
    quoteTokenAddress: QUOTE,
    baseTokenAddress: BASE,
    createdAtBlock: 100n,
    createdTxHash: `0x${"ab".repeat(32)}`,
    createdLogIndex: 0,
    ...overrides
  };
}

function tokenFixture(overrides: Partial<TokenInsert> = {}): TokenInsert {
  return {
    chainId: CHAIN_ID,
    address: BASE,
    firstSeenBlock: 100n,
    name: "Fixture Token",
    symbol: "FIX",
    ...overrides
  };
}

function performanceFixture(
  overrides: Partial<TokenPerformanceInsert> = {}
): TokenPerformanceInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress: BASE,
    poolAddress: POOL,
    horizonHours: 72,
    bandMinFdvUsd: "50000",
    bandMaxFdvUsd: "200000",
    enteredAt: T0,
    entryBlock: 100n,
    entryPriceUsd: "0.001",
    entryFdvUsd: "100000",
    maxMultipleBps: 25_000,
    maxDrawdownBps: 1_000,
    minutesToPeak: 30,
    snapshotsInWindow: 5,
    entryFeatures: { quoteLiquidityUsd: 50_000 },
    details: {},
    ...overrides
  };
}

function scoreFixture(
  overrides: Partial<TokenScoreResultInsert> = {}
): TokenScoreResultInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress: BASE,
    poolAddress: POOL,
    blockNumber: 100n,
    scoredAt: T0,
    eligible: true,
    score: 82,
    components: {},
    alertLevel: "GREEN",
    positiveReasons: [],
    riskReasons: [],
    ...overrides
  };
}

function alertFixture(overrides: Partial<AlertSentInsert> = {}): AlertSentInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress: BASE,
    poolAddress: POOL,
    alertLevel: "GREEN",
    score: 82,
    reason: "band entry",
    transport: "dry-run",
    delivered: true,
    ...overrides
  };
}

describe("buildDashboardApp: seeded population", () => {
  let handle: TestDatabaseHandle;
  let db: Db;
  let app: FastifyInstance;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    await insertPools(db, [poolFixture()]);
    await insertTokens(db, [tokenFixture()]);
    await insertTokenPerformance(db, performanceFixture());
    await insertScoreResult(db, scoreFixture());
    await insertAlertSent(db, alertFixture());
    app = buildDashboardApp({ db, chainId: CHAIN_ID });
  });

  afterEach(async () => {
    await app.close();
    await handle.close();
  });

  it("GET /api/funnel returns 200 with the funnel shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/funnel" });
    expect(res.statusCode).toBe(200);
    const body = res.json<FunnelSummary>();
    expect(body).toMatchObject({
      pools: 1,
      trustedQuotePools: 1,
      bandEntrantPools: 1
    });
    expect(typeof body.alertedTokens.RED).toBe("number");
    expect(typeof body.alertedTokens.YELLOW).toBe("number");
    expect(typeof body.alertedTokens.GREEN).toBe("number");
  });

  it("GET /api/launches returns 200 with an array of cadence points", async () => {
    const res = await app.inject({ method: "GET", url: "/api/launches?days=30" });
    expect(res.statusCode).toBe(200);
    const body = res.json<LaunchCadencePoint[]>();
    expect(Array.isArray(body)).toBe(true);
    const first = body[0];
    if (first !== undefined) {
      expect(typeof first.day).toBe("string");
      expect(typeof first.pools).toBe("number");
      expect(typeof first.trustedQuotePools).toBe("number");
    }
  });

  it("GET /api/precision returns 200 with the precision-curve shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/precision?horizon=72" });
    expect(res.statusCode).toBe(200);
    const body = res.json<PrecisionCurve>();
    expect(body.horizonHours).toBe(72);
    expect(typeof body.scored).toBe("number");
    expect(typeof body.unscored).toBe("number");
    expect(Array.isArray(body.points)).toBe(true);
  });

  it("GET /api/quartiles returns 200 with the quartiles shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/quartiles?feature=quoteLiquidityUsd&horizon=72"
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<FeatureQuartiles>();
    expect(body.feature).toBe("quoteLiquidityUsd");
    expect(body.horizonHours).toBe(72);
    expect(typeof body.nullRows).toBe("number");
    expect(Array.isArray(body.buckets)).toBe(true);
  });

  it("GET /api/survival returns 200 with an array", async () => {
    const res = await app.inject({ method: "GET", url: "/api/survival" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json<SurvivalPoint[]>())).toBe(true);
  });

  it("GET /api/alerts returns 200 with the recent-alert row shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/alerts?limit=50" });
    expect(res.statusCode).toBe(200);
    const body = res.json<RecentAlertRow[]>();
    expect(body).toHaveLength(1);
    const first = body[0];
    expect(typeof first?.sentAt).toBe("string");
    expect(first).toMatchObject({
      alertLevel: "GREEN",
      score: 82,
      tokenAddress: BASE,
      name: "Fixture Token",
      symbol: "FIX",
      delivered: true,
      transport: "dry-run"
    });
    expect(["number", "object"]).toContain(typeof first?.maxMultipleBps);
  });

  it("GET /api/judgment returns 200 with the judgment-quality shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/judgment" });
    expect(res.statusCode).toBe(200);
    const body = res.json<JudgmentQuality>();
    expect(Array.isArray(body.versions)).toBe(true);
    expect(Array.isArray(body.weekly)).toBe(true);
  });

  it("400s on an unknown feature key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/quartiles?feature=notAKey"
    });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json<{ error: string }>().error).toBe("string");
  });

  it("400s on a disallowed precision horizon", async () => {
    const res = await app.inject({ method: "GET", url: "/api/precision?horizon=48" });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json<{ error: string }>().error).toBe("string");
  });

  it("400s on a non-numeric days param", async () => {
    const res = await app.inject({ method: "GET", url: "/api/launches?days=abc" });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json<{ error: string }>().error).toBe("string");
  });

  it("serves index.html at /", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("serves the chart.js UMD bundle at /chart.umd.js", async () => {
    const res = await app.inject({ method: "GET", url: "/chart.umd.js" });
    expect(res.statusCode).toBe(200);
  });
});

describe("buildDashboardApp: empty database", () => {
  let handle: TestDatabaseHandle;
  let app: FastifyInstance;

  beforeEach(async () => {
    handle = await createTestDatabase();
    app = buildDashboardApp({ db: handle.db, chainId: CHAIN_ID });
  });

  afterEach(async () => {
    await app.close();
    await handle.close();
  });

  it("GET /api/funnel returns the all-zero shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/funnel" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      pools: 0,
      trustedQuotePools: 0,
      bandEntrantPools: 0,
      eligibleTokens: 0,
      alertedTokens: { RED: 0, YELLOW: 0, GREEN: 0 }
    });
  });

  it("GET /api/alerts returns an empty array", async () => {
    const res = await app.inject({ method: "GET", url: "/api/alerts" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
