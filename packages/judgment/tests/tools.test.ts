import { createHash } from "node:crypto";

import {
  insertPoolSnapshots,
  listPoolSnapshots,
  insertTokenOutcome,
  insertTokenPerformance,
  insertTokens,
  type Db,
  type PoolActivitySnapshotRow,
  type PoolSnapshotRow,
  type TokenHolderSnapshotRow,
  type TokenInsert,
  type TokenOutcomeInsert,
  type TokenPerformanceInsert,
  type TokenRiskRow,
  type TradeSimulationRow
} from "@assay/database";
import { createTestDatabase, type TestDatabaseHandle } from "@assay/database/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createJudgmentToolkit, DEFAULT_TOOLKIT_CONFIG } from "../src/tools.js";
import type { BaseRateFeature, BundlePool, BundleToken, EvidenceBundle, SourcedRow } from "../src/types.js";

const CHAIN_ID = 4242;
const ASOF = new Date("2025-01-01T00:00:00.000Z");
const CANDIDATE_POOL = "0xCandidatePool";
const CANDIDATE_TOKEN = "0xCandidateToken";
const QUOTE = "0xQuote";
const DEPLOYER = "0xDeployer";

function minutesFromAsOf(n: number): Date {
  return new Date(ASOF.getTime() + n * 60_000);
}

/** Baseline entry-feature vector: every one of the 13 BASE_RATE_FEATURES set, matching the candidate exactly. */
function baselineEntryFeatures(
  overrides: Partial<Record<BaseRateFeature, unknown>> = {}
): Record<string, unknown> {
  return {
    quoteLiquidityUsd: "50000",
    totalLiquidityUsd: "100000",
    ageMinutesAtEntry: 30,
    uniqueBuyers1h: 40,
    buySizeGiniBps: 3000,
    buySizeEntropyBps: 6000,
    repeatedSizeBuyPctBps: 500,
    floatBps: 8000,
    supplyInPoolBps: 6000,
    adjustedTop10PctBps: 3000,
    deployerPctBps: 500,
    adjustedHolderCount: 120,
    effectiveSellLossBps: 200,
    ...overrides
  };
}

function tokenFixture(address: string, overrides: Partial<TokenInsert> = {}): TokenInsert {
  return {
    chainId: CHAIN_ID,
    address,
    firstSeenBlock: 1n,
    name: "Token",
    symbol: "TKN",
    decimals: 18,
    ...overrides
  };
}

let nextPerformanceId = 1n;

function performanceFixture(
  poolAddress: string,
  overrides: Partial<TokenPerformanceInsert> = {}
): TokenPerformanceInsert {
  const id = nextPerformanceId;
  nextPerformanceId += 1n;
  return {
    chainId: CHAIN_ID,
    tokenAddress: `0xToken-${poolAddress}`,
    poolAddress,
    horizonHours: 72,
    bandMinFdvUsd: "50000",
    bandMaxFdvUsd: "200000",
    enteredAt: minutesFromAsOf(-60 - Number(id)),
    entryBlock: id,
    entryPriceUsd: "0.001",
    entryFdvUsd: "100000",
    maxMultipleBps: 15_000,
    maxDrawdownBps: 1_000,
    minutesToPeak: 30,
    snapshotsInWindow: 5,
    entryFeatures: baselineEntryFeatures(),
    labeledAt: minutesFromAsOf(-1),
    details: {},
    ...overrides
  };
}

function outcomeFixture(
  tokenAddress: string,
  poolAddress: string,
  overrides: Partial<TokenOutcomeInsert> = {}
): TokenOutcomeInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress,
    poolAddress,
    horizonHours: 72,
    outcome: "SURVIVED",
    firstObservedAt: minutesFromAsOf(-100),
    labeledAt: minutesFromAsOf(-1),
    details: {},
    ...overrides
  };
}

let nextSnapshotId = 1n;

function snapshotRow(overrides: Partial<PoolSnapshotRow> = {}): PoolSnapshotRow {
  const id = nextSnapshotId;
  nextSnapshotId += 1n;
  return {
    id,
    chainId: CHAIN_ID,
    poolAddress: CANDIDATE_POOL,
    blockNumber: 1n,
    capturedAt: minutesFromAsOf(-10),
    calculationMethod: "v2-reserves",
    priceUsd: "0.002",
    estimatedFdvUsd: "150000",
    quoteLiquidityUsd: "50000",
    totalLiquidityUsd: "100000",
    anchorPoolAddress: null,
    nullReason: null,
    ...overrides
  };
}

function activityRow(overrides: Partial<PoolActivitySnapshotRow> = {}): PoolActivitySnapshotRow {
  return {
    id: 1n,
    chainId: CHAIN_ID,
    poolAddress: CANDIDATE_POOL,
    blockNumber: 1n,
    capturedAt: minutesFromAsOf(-5),
    uniqueBuyers20m: 10,
    uniqueBuyers1h: 40,
    buyCount20m: 12,
    sellCount20m: 3,
    quoteBuyVolumeRaw20m: "1000000000000000000",
    quoteSellVolumeRaw20m: "200000000000000000",
    quoteBuyVolumeRaw1h: "3000000000000000000",
    quoteSellVolumeRaw1h: "500000000000000000",
    buySizeGiniBps: 3_000,
    buySizeEntropyBps: 6_000,
    repeatedSizeBuyPctBps: 500,
    ...overrides
  };
}

function holderRow(overrides: Partial<TokenHolderSnapshotRow> = {}): TokenHolderSnapshotRow {
  return {
    id: 1n,
    chainId: CHAIN_ID,
    tokenAddress: CANDIDATE_TOKEN,
    blockNumber: 1n,
    capturedAt: minutesFromAsOf(-5),
    holderCount: 150,
    adjustedHolderCount: 120,
    largestHolderPctBps: 4_000,
    top10PctBps: 5_000,
    adjustedTop10PctBps: 3_000,
    deployerPctBps: 500,
    holderClusterScoreBps: 1_000,
    floatBps: 8_000,
    supplyInPoolBps: 6_000,
    excluded: [],
    ...overrides
  };
}

function riskRow(overrides: Partial<TokenRiskRow> = {}): TokenRiskRow {
  return {
    id: 1n,
    chainId: CHAIN_ID,
    tokenAddress: CANDIDATE_TOKEN,
    poolAddress: CANDIDATE_POOL,
    blockNumber: 1n,
    assessedAt: minutesFromAsOf(-5),
    status: "PASS",
    verificationStatus: "VERIFIED",
    isProxy: false,
    implementationAddress: null,
    permissionFindings: [],
    simulationStatus: "PASS",
    effectiveBuyLossBps: 150,
    effectiveSellLossBps: 200,
    riskReasons: [],
    positiveReasons: [],
    nullReason: null,
    ...overrides
  };
}

function simulationRow(overrides: Partial<TradeSimulationRow> = {}): TradeSimulationRow {
  return {
    id: 77n,
    chainId: CHAIN_ID,
    tokenAddress: CANDIDATE_TOKEN,
    poolAddress: CANDIDATE_POOL,
    blockNumber: 1n,
    simulatedAt: minutesFromAsOf(-5),
    route: "uniswap-v2",
    buyStatus: "PASS",
    transferStatus: "PASS",
    sellStatus: "PASS",
    buyQuoteInRaw: "1000000000000000000",
    buyBaseOutRaw: "500000000000000000000",
    spotBaseOutRaw: "510000000000000000000",
    sellBaseInRaw: "500000000000000000000",
    sellQuoteOutRaw: "950000000000000000",
    spotQuoteOutRaw: "1000000000000000000",
    effectiveBuyLossBps: 150,
    effectiveSellLossBps: 120,
    slippageCurve: [
      { notionalUsd: "100", lossBps: 50 },
      { notionalUsd: "500", lossBps: 120 },
      { notionalUsd: "1000", lossBps: 300 }
    ],
    revertReason: null,
    status: "PASS",
    ...overrides
  };
}

function sourced<T>(table: SourcedRow<T>["source"]["table"], id: bigint, row: T): SourcedRow<T> {
  return { row, source: { table, rowId: String(id) } };
}

/**
 * Hand-built EvidenceBundle per the frozen types.ts shape — deliberately
 * not routed through bundle.ts (out of scope; owned by another wave-1
 * agent). `discoveredAt` defaults to 30 minutes before `asOf` so the
 * candidate's derived `ageMinutesAtEntry` is 30, matching
 * `baselineEntryFeatures()`.
 */
function buildBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  const token: BundleToken = {
    address: CANDIDATE_TOKEN,
    decimals: 18,
    totalSupply: "1000000000000000000000000",
    deployerAddress: DEPLOYER,
    deployerStatus: "RESOLVED",
    name: null,
    symbol: null
  };
  const pool: BundlePool = {
    address: CANDIDATE_POOL,
    dex: "uniswap",
    kind: "uniswap-v2",
    createdAtBlock: "1",
    discoveredAt: minutesFromAsOf(-30),
    quoteTokenAddress: QUOTE
  };
  const marketSnapshot = snapshotRow({ id: 900n, capturedAt: minutesFromAsOf(-5) });
  return {
    chainId: CHAIN_ID,
    mode: "LIVE",
    asOf: ASOF,
    alert: null,
    token,
    pool,
    marketSeries: [sourced("pool_snapshots", marketSnapshot.id, marketSnapshot)],
    activity: sourced("pool_activity_snapshots", 901n, activityRow({ id: 901n })),
    holders: sourced("token_holder_snapshots", 902n, holderRow({ id: 902n })),
    risk: sourced("token_risks", 903n, riskRow({ id: 903n })),
    simulation: sourced("trade_simulations", 904n, simulationRow({ id: 904n })),
    ...overrides
  };
}

function digest(json: string): string {
  return createHash("sha256").update(json).digest("hex");
}

describe("judgment tools", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  describe("comparableLaunches", () => {
    it("excludes the candidate pool and post-asOf labels, deterministic ordering, null-feature matchedFeatures", async () => {
      await insertTokenPerformance(db, performanceFixture("0xNear1"));
      await insertTokenPerformance(
        db,
        performanceFixture("0xNullFeature", {
          entryFeatures: baselineEntryFeatures({ buySizeGiniBps: null })
        })
      );
      await insertTokenPerformance(
        db,
        performanceFixture("0xFar", {
          entryFeatures: baselineEntryFeatures({
            quoteLiquidityUsd: "5",
            totalLiquidityUsd: "5",
            ageMinutesAtEntry: 5_000,
            uniqueBuyers1h: 1,
            buySizeGiniBps: 9_999,
            buySizeEntropyBps: 0,
            repeatedSizeBuyPctBps: 9_999,
            floatBps: 0,
            supplyInPoolBps: 9_999,
            adjustedTop10PctBps: 9_999,
            deployerPctBps: 9_999,
            adjustedHolderCount: 1,
            effectiveSellLossBps: 9_999
          }),
          maxMultipleBps: 10_500
        })
      );
      // Candidate pool itself — perfect feature match, must never appear.
      await insertTokenPerformance(db, performanceFixture(CANDIDATE_POOL));
      // Post-asOf label — perfect feature match, must never appear.
      await insertTokenPerformance(
        db,
        performanceFixture("0xFutureLabeled", { labeledAt: minutesFromAsOf(10) })
      );

      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });
      const first = await toolkit.execute("comparableLaunches", "{}");
      const second = await toolkit.execute("comparableLaunches", "{}");

      expect(first.isError).toBe(false);
      expect(first.resultJson).toBe(second.resultJson);
      expect(digest(first.resultJson)).toBe(digest(second.resultJson));

      const parsed = JSON.parse(first.resultJson) as {
        horizonHours: number;
        k: number;
        populationSize: number;
        comparables: readonly {
          poolAddress: string;
          matchedFeatures: number;
        }[];
      };
      expect(parsed.horizonHours).toBe(72);
      expect(parsed.populationSize).toBe(3);
      const addresses = parsed.comparables.map((c) => c.poolAddress);
      expect(addresses).toEqual(["0xNear1", "0xNullFeature", "0xFar"]);
      expect(addresses).not.toContain(CANDIDATE_POOL);
      expect(addresses).not.toContain("0xFutureLabeled");

      const near1 = parsed.comparables.find((c) => c.poolAddress === "0xNear1")!;
      const nullFeature = parsed.comparables.find((c) => c.poolAddress === "0xNullFeature")!;
      expect(near1.matchedFeatures).toBe(13);
      expect(nullFeature.matchedFeatures).toBe(12);
    });

    it("caps k at the toolkit's configured comparablesMaxK", async () => {
      for (const suffix of ["A", "B", "C", "D", "E"]) {
        await insertTokenPerformance(
          db,
          performanceFixture(`0xPad${suffix}`, {
            entryFeatures: baselineEntryFeatures({
              ageMinutesAtEntry: 30 + suffix.charCodeAt(0)
            })
          })
        );
      }

      const toolkit = createJudgmentToolkit({
        db,
        bundle: buildBundle(),
        config: { comparablesMaxK: 3 }
      });
      const result = await toolkit.execute("comparableLaunches", JSON.stringify({ k: 100 }));
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.resultJson) as {
        k: number;
        comparables: readonly unknown[];
      };
      expect(parsed.k).toBe(3);
      expect(parsed.comparables).toHaveLength(3);
    });
  });

  describe("baseRateForPattern", () => {
    async function seedBaseRatePopulation(): Promise<void> {
      const rows: readonly [pool: string, age: number, maxMultipleBps: number, outcome: string][] = [
        ["0xBR1", 10, 30_000, "SURVIVED"],
        ["0xBR2", 20, 15_000, "DIED"],
        ["0xBR3", 30, 9_000, "DIED"],
        ["0xBR4", 40, 25_000, "SURVIVED"],
        ["0xBR5", 50, 12_000, "SURVIVED"],
        ["0xBR6", 60, 21_000, "DIED"]
      ];
      for (const [pool, age, maxMultipleBps, outcome] of rows) {
        await insertTokenPerformance(
          db,
          performanceFixture(pool, {
            tokenAddress: `0xBRToken-${pool}`,
            maxMultipleBps,
            entryFeatures: baselineEntryFeatures({ ageMinutesAtEntry: age })
          })
        );
        await insertTokenOutcome(db, outcomeFixture(`0xBRToken-${pool}`, pool, { outcome }));
      }
    }

    it("computes n/populationN/diedPct/runnerPctBps/medianMultipleBps and flags lowSample", async () => {
      await seedBaseRatePopulation();
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });

      const narrow = await toolkit.execute(
        "baseRateForPattern",
        JSON.stringify({ predicates: [{ feature: "ageMinutesAtEntry", op: "lte", value: 30 }] })
      );
      expect(narrow.isError).toBe(false);
      const narrowParsed = JSON.parse(narrow.resultJson) as {
        n: number;
        populationN: number;
        diedPct: number;
        runnerPctBps: number;
        medianMultipleBps: number;
        lowSample?: boolean;
      };
      expect(narrowParsed.populationN).toBe(6);
      expect(narrowParsed.n).toBe(3);
      expect(narrowParsed.lowSample).toBe(true);
      expect(narrowParsed.diedPct).toBeCloseTo(66.67, 2);
      expect(narrowParsed.runnerPctBps).toBe(3_333);
      expect(narrowParsed.medianMultipleBps).toBe(15_000);

      const full = await toolkit.execute(
        "baseRateForPattern",
        JSON.stringify({ predicates: [{ feature: "ageMinutesAtEntry", op: "gte", value: 10 }] })
      );
      const fullParsed = JSON.parse(full.resultJson) as {
        n: number;
        diedPct: number;
        runnerPctBps: number;
        medianMultipleBps: number;
        lowSample?: boolean;
      };
      expect(fullParsed.n).toBe(6);
      expect(fullParsed.lowSample).toBeUndefined();
      expect(fullParsed.diedPct).toBeCloseTo(50, 2);
      expect(fullParsed.runnerPctBps).toBe(5_000);
      expect(fullParsed.medianMultipleBps).toBe(15_000);
    });

    it("rejects more than baseRateMaxPredicates predicates", async () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });
      const result = await toolkit.execute(
        "baseRateForPattern",
        JSON.stringify({
          predicates: [
            { feature: "ageMinutesAtEntry", op: "lte", value: 1 },
            { feature: "uniqueBuyers1h", op: "gte", value: 1 },
            { feature: "floatBps", op: "lte", value: 1 },
            { feature: "supplyInPoolBps", op: "gte", value: 1 }
          ]
        })
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.resultJson)).toHaveProperty("error");
    });
  });

  describe("deployerHistory", () => {
    it("reports unavailable when the deployer is unresolved", async () => {
      const toolkit = createJudgmentToolkit({
        db,
        bundle: buildBundle({
          token: { ...buildBundle().token, deployerAddress: null }
        })
      });
      const result = await toolkit.execute("deployerHistory", "{}");
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.resultJson)).toEqual({
        available: false,
        reason: "deployer-unresolved"
      });
    });

    it("aggregates other tokens by the same resolved deployer, died-only-if-never-survived, as-of filtered", async () => {
      await insertTokens(db, [
        tokenFixture(CANDIDATE_TOKEN, { deployerAddress: DEPLOYER, deployerStatus: "RESOLVED" }),
        tokenFixture("0xSiblingA", { deployerAddress: DEPLOYER, deployerStatus: "RESOLVED" }),
        tokenFixture("0xSiblingB", { deployerAddress: DEPLOYER, deployerStatus: "RESOLVED" })
      ]);
      // Sibling A: DIED at 72h but later SURVIVED at 168h -> never counted as died.
      await insertTokenOutcome(
        db,
        outcomeFixture("0xSiblingA", "0xPoolA", { horizonHours: 72, outcome: "DIED" })
      );
      await insertTokenOutcome(
        db,
        outcomeFixture("0xSiblingA", "0xPoolA", { horizonHours: 168, outcome: "SURVIVED" })
      );
      // Sibling B: DIED, never survived.
      await insertTokenOutcome(
        db,
        outcomeFixture("0xSiblingB", "0xPoolB", { horizonHours: 72, outcome: "DIED" })
      );
      // Future-labeled row for sibling B — must be excluded by the as-of filter.
      await insertTokenOutcome(
        db,
        outcomeFixture("0xSiblingB", "0xPoolB", {
          horizonHours: 168,
          outcome: "SURVIVED",
          labeledAt: minutesFromAsOf(10)
        })
      );

      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });
      const result = await toolkit.execute("deployerHistory", "{}");
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.resultJson) as {
        available: boolean;
        tokenCount: number;
        survived: number;
        died: number;
      };
      expect(parsed).toEqual({ available: true, tokenCount: 2, survived: 1, died: 1 });
    });
  });

  describe("liquidityTrajectory", () => {
    it("matches a hand-computed peak/drawdown/collapse fixture, purely over the bundle series", async () => {
      const s0 = snapshotRow({ id: 10n, capturedAt: minutesFromAsOf(-30), quoteLiquidityUsd: "1000" });
      const s1 = snapshotRow({ id: 11n, capturedAt: minutesFromAsOf(-20), quoteLiquidityUsd: "5000" });
      const s2 = snapshotRow({ id: 12n, capturedAt: minutesFromAsOf(-10), quoteLiquidityUsd: "3000" });
      const s3 = snapshotRow({ id: 13n, capturedAt: minutesFromAsOf(0), quoteLiquidityUsd: "800" });
      const toolkit = createJudgmentToolkit({
        db,
        bundle: buildBundle({
          marketSeries: [s0, s1, s2, s3].map((s) => sourced("pool_snapshots", s.id, s))
        })
      });
      const result = await toolkit.execute("liquidityTrajectory", "{}");
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.resultJson)).toEqual({
        available: true,
        peakQuoteLiquidityUsd: "5000",
        currentQuoteLiquidityUsd: "800",
        drawdownFromPeakBps: 8_400,
        minutesAbove80PctOfPeak: 10,
        collapsed: true,
        peakRef: "pool_snapshots:11",
        currentRef: "pool_snapshots:13"
      });
      expect(result.resultRowIds).toEqual(["pool_snapshots:11", "pool_snapshots:13"]);
    });

    it("reports no-snapshots when the bundle has an empty market series", async () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle({ marketSeries: [] }) });
      const result = await toolkit.execute("liquidityTrajectory", "{}");
      expect(JSON.parse(result.resultJson)).toEqual({
        available: false,
        reason: "no-snapshots"
      });
    });
  });

  describe("slippageAtSize", () => {
    it("returns the curve, ref, and nearest point to sizeUsd", async () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });
      const result = await toolkit.execute("slippageAtSize", JSON.stringify({ sizeUsd: 480 }));
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.resultJson) as {
        available: boolean;
        curve: readonly { notionalUsd: string; lossBps: number | null }[];
        effectiveSellLossBps: number | null;
        nearest: { notionalUsd: string; lossBps: number | null } | null;
        ref: string;
      };
      expect(parsed.available).toBe(true);
      expect(parsed.curve).toHaveLength(3);
      expect(parsed.effectiveSellLossBps).toBe(120);
      expect(parsed.nearest).toEqual({ notionalUsd: "500", lossBps: 120 });
      expect(parsed.ref).toBe("trade_simulations:904");
      expect(result.resultRowIds).toEqual(["trade_simulations:904"]);
    });

    it("reports unavailable when the bundle has no simulation", async () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle({ simulation: null }) });
      const result = await toolkit.execute("slippageAtSize", "{}");
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.resultJson)).toEqual({ available: false });
    });
  });

  describe("cohortPercentiles", () => {
    it("is unavailable in REPLAY mode without touching the database", async () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle({ mode: "REPLAY" }) });
      const result = await toolkit.execute("cohortPercentiles", "{}");
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.resultJson)).toEqual({
        available: false,
        reason: "not-as-of-safe"
      });
    });

    it("is unavailable in LIVE mode when no cohort exists", async () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle({ mode: "LIVE" }) });
      const result = await toolkit.execute("cohortPercentiles", "{}");
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.resultJson)).toEqual({
        available: false,
        reason: "insufficient-cohort"
      });
    });
  });

  describe("fetchCitedRow", () => {
    it("fetches and JSON-safely serializes a citable row", async () => {
      await insertPoolSnapshots(db, [
        {
          chainId: CHAIN_ID,
          poolAddress: CANDIDATE_POOL,
          blockNumber: 55n,
          capturedAt: minutesFromAsOf(-5),
          calculationMethod: "v2-reserves",
          quoteLiquidityUsd: "12345"
        }
      ]);
      const [row] = await listPoolSnapshots(db, CHAIN_ID, CANDIDATE_POOL);
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });
      const result = await toolkit.execute(
        "fetchCitedRow",
        JSON.stringify({ table: "pool_snapshots", rowId: Number(row!.id) })
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.resultJson) as {
        available: boolean;
        row: { id: string; blockNumber: string; capturedAt: string };
      };
      expect(parsed.available).toBe(true);
      expect(parsed.row.id).toBe(row!.id.toString());
      expect(parsed.row.blockNumber).toBe("55");
      expect(typeof parsed.row.capturedAt).toBe("string");
      expect(result.resultRowIds).toEqual([`pool_snapshots:${row!.id}`]);
    });
  });

  describe("invalid arguments never throw", () => {
    it("unknown tool name -> isError", async () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });
      const result = await toolkit.execute("notARealTool", "{}");
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.resultJson)).toHaveProperty("error");
    });

    it("malformed JSON -> isError", async () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });
      const result = await toolkit.execute("liquidityTrajectory", "{not json");
      expect(result.isError).toBe(true);
    });

    it("string where a number is expected -> isError", async () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });
      const result = await toolkit.execute("comparableLaunches", JSON.stringify({ k: "five" }));
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.resultJson)).toHaveProperty("error");
    });

    it("unknown argument key -> isError (additionalProperties: false enforced)", async () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });
      const result = await toolkit.execute(
        "liquidityTrajectory",
        JSON.stringify({ unexpected: true })
      );
      expect(result.isError).toBe(true);
    });

    it("bad table in fetchCitedRow -> isError", async () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });
      const result = await toolkit.execute(
        "fetchCitedRow",
        JSON.stringify({ table: "tokens", rowId: 1 })
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.resultJson)).toHaveProperty("error");
    });
  });

  describe("defs", () => {
    it("exposes strict, additionalProperties:false schemas for every JUDGMENT_TOOL_NAMES entry", () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });
      expect(toolkit.defs.map((d) => d.name).sort()).toEqual(
        [
          "baseRateForPattern",
          "cohortPercentiles",
          "comparableLaunches",
          "deployerHistory",
          "fetchCitedRow",
          "liquidityTrajectory",
          "marketSeries",
          "slippageAtSize"
        ].sort()
      );
      for (const def of toolkit.defs) {
        expect(def.parameters).toMatchObject({ type: "object", additionalProperties: false });
      }
    });

    it("uses the default config when none is supplied", () => {
      const toolkit = createJudgmentToolkit({ db, bundle: buildBundle() });
      const baseRateDef = toolkit.defs.find((d) => d.name === "baseRateForPattern")!;
      const parameters = baseRateDef.parameters as {
        properties: { predicates: { maxItems: number } };
      };
      expect(parameters.properties.predicates.maxItems).toBe(
        DEFAULT_TOOLKIT_CONFIG.baseRateMaxPredicates
      );
    });
  });
});
