import { describe, expect, it } from "vitest";

import type { TokenOutcomeRow, TokenPerformanceRow } from "@assay/database";

import { buildJudgeReport, wilsonInterval, type JudgeReportBrief } from "../src/judge-report.js";

const CHAIN_ID = 4242;
const T0 = new Date("2026-01-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let nextId = 1n;

function briefFixture(overrides: Partial<JudgeReportBrief> = {}): JudgeReportBrief {
  const id = nextId;
  nextId += 1n;
  return {
    id,
    chainId: CHAIN_ID,
    tokenAddress: `0xToken${id}`,
    poolAddress: `0xPool${id}`,
    mode: "REPLAY",
    alertId: null,
    evalRunId: null,
    asOf: T0,
    promptName: "research-brief",
    promptVersion: 1,
    templateHash: "hash-v1",
    model: "test-model",
    status: "COMPLETED",
    thesis: "thesis text",
    confidenceBps: 5000,
    recommendation: "WATCH",
    riskCalls: [],
    disconfirming: [],
    whatWouldChange: [],
    citationsTotal: 3,
    citationsVerified: 3,
    delivery: null,
    costUsd: null,
    tokensIn: 100,
    tokensOut: 50,
    latencyMs: 1000,
    error: null,
    createdAt: T0,
    toolCallCount: 0,
    ...overrides
  };
}

function perfFixture(
  poolAddress: string,
  overrides: Partial<TokenPerformanceRow> = {}
): TokenPerformanceRow {
  const id = nextId;
  nextId += 1n;
  return {
    id,
    chainId: CHAIN_ID,
    tokenAddress: `0xToken${id}`,
    poolAddress,
    horizonHours: 72,
    bandMinFdvUsd: "50000",
    bandMaxFdvUsd: "200000",
    enteredAt: T0,
    entryBlock: 1n,
    entryPriceUsd: "0.001",
    entryFdvUsd: "100000",
    maxMultipleBps: 10_000,
    maxDrawdownBps: 0,
    minutesToPeak: 0,
    snapshotsInWindow: 1,
    entryFeatures: {},
    labeledAt: T0,
    details: {},
    ...overrides
  };
}

function outcomeFixture(
  poolAddress: string,
  overrides: Partial<TokenOutcomeRow> = {}
): TokenOutcomeRow {
  const id = nextId;
  nextId += 1n;
  return {
    id,
    chainId: CHAIN_ID,
    tokenAddress: `0xToken${id}`,
    poolAddress,
    horizonHours: 72,
    outcome: "SURVIVED",
    peakQuoteLiquidityUsd: null,
    quoteLiquidityAtHorizonUsd: null,
    estimatedFdvAtHorizonUsd: null,
    firstObservedAt: T0,
    labeledAt: T0,
    details: {},
    ...overrides
  };
}

describe("wilsonInterval", () => {
  it("matches the known-value 95% Wilson interval for p=0.5, n=20", () => {
    expect(wilsonInterval(10, 20)).toEqual({ lowerBps: 2993, upperBps: 7007 });
  });

  it("matches the known-value 95% Wilson interval for p=0.5, n=100", () => {
    expect(wilsonInterval(50, 100)).toEqual({ lowerBps: 4038, upperBps: 5962 });
  });

  it("clamps the lower bound at 0 for a zero-success sample", () => {
    expect(wilsonInterval(0, 5)).toEqual({ lowerBps: 0, upperBps: 4345 });
  });

  it("clamps the upper bound at 10000 for an all-success sample", () => {
    expect(wilsonInterval(5, 5)).toEqual({ lowerBps: 5655, upperBps: 10_000 });
  });

  it("returns null for an empty sample", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe("buildJudgeReport", () => {
  it("returns no slices for no input", () => {
    expect(buildJudgeReport([], [], [])).toEqual({ from: null, to: null, slices: [] });
  });

  it("computes Brier, calibration, per-tag precision/recall, fabrication rate, taxonomy, and medians on a hand-worked fixture", () => {
    const poolA = "0xPoolA";
    const poolB = "0xPoolB";
    const poolC = "0xPoolC";
    const poolD = "0xPoolD";

    // RESEARCH @ 80% implied hit, realized RUNNER -> Brier (0.8-1)^2 = 0.04 -> 40000 micro.
    const briefA = briefFixture({
      poolAddress: poolA,
      recommendation: "RESEARCH",
      confidenceBps: 8000,
      riskCalls: [
        { risk: "r1", tag: "RUG_LP_PULL", severity: "HIGH", evidence: [] },
        { risk: "r2", tag: "SELL_RESTRICTION", severity: "LOW", evidence: [] }
      ],
      costUsd: "0.01",
      latencyMs: 1000,
      toolCallCount: 2,
      asOf: T0
    });
    // PASS @ implied hit 10000-9000=1000bps, realized BLED (not runner) -> Brier (0.1-0)^2 = 0.01 -> 10000 micro.
    const briefB = briefFixture({
      poolAddress: poolB,
      recommendation: "PASS",
      confidenceBps: 9000,
      riskCalls: [{ risk: "r3", tag: "CONCENTRATION_DUMP", severity: "HIGH", evidence: [] }],
      costUsd: "0.02",
      latencyMs: 2000,
      toolCallCount: 0,
      asOf: new Date(T0.getTime() + DAY_MS)
    });
    // WATCH @ implied hit 5000bps, realized RUGGED (died) -> Brier (0.5-0)^2 = 0.25 -> 250000 micro.
    const briefC = briefFixture({
      poolAddress: poolC,
      recommendation: "WATCH",
      confidenceBps: 5000,
      riskCalls: [{ risk: "r4", tag: "RUG_LP_PULL", severity: "HIGH", evidence: [] }],
      costUsd: null,
      latencyMs: 3000,
      toolCallCount: 1,
      asOf: new Date(T0.getTime() + 2 * DAY_MS)
    });
    // REJECTED — counts toward n and fabrication rate, never toward scoring.
    const briefD = briefFixture({
      poolAddress: poolD,
      status: "REJECTED_FABRICATED_CITATION",
      recommendation: "RESEARCH",
      confidenceBps: 7000,
      costUsd: "0.03",
      latencyMs: 4000,
      toolCallCount: 3,
      asOf: new Date(T0.getTime() + 3 * DAY_MS)
    });

    const perfA = perfFixture(poolA, { maxMultipleBps: 25_000, maxDrawdownBps: 1_000 }); // RUNNER
    const perfB = perfFixture(poolB, { maxMultipleBps: 10_500, maxDrawdownBps: 6_000 }); // BLED, deep drawdown
    const perfC = perfFixture(poolC, { maxMultipleBps: 10_000, maxDrawdownBps: 0 }); // RUGGED via died
    const perfD = perfFixture(poolD, { maxMultipleBps: 12_000, maxDrawdownBps: 0 });
    const outcomeC = outcomeFixture(poolC, { outcome: "DIED" });

    const report = buildJudgeReport(
      [briefA, briefB, briefC, briefD],
      [perfA, perfB, perfC, perfD],
      [outcomeC]
    );

    expect(report.slices).toHaveLength(1);
    const slice = report.slices[0]!;
    expect(slice.promptName).toBe("research-brief");
    expect(slice.promptVersion).toBe(1);
    expect(slice.horizonHours).toBe(72);
    expect(slice.n).toBe(4);
    expect(slice.scored).toBe(3);
    expect(slice.taxonomy).toEqual({ RESEARCH: 2, WATCH: 1, PASS: 1 });

    expect(slice.fabricationRate).toEqual({
      n: 4,
      successes: 1,
      rateBps: 2_500,
      wilsonLowerBps: 456,
      wilsonUpperBps: 6_994
    });

    expect(slice.brierMeanMicro).toBe(100_000);

    const bucket80 = slice.calibration.find((b) => b.bucket === "80-90")!;
    expect(bucket80).toMatchObject({ n: 1, meanStatedBps: 8_000 });
    expect(bucket80.realized.successes).toBe(1);
    const bucket10 = slice.calibration.find((b) => b.bucket === "10-20")!;
    expect(bucket10).toMatchObject({ n: 1, meanStatedBps: 1_000 });
    expect(bucket10.realized.successes).toBe(0);
    const bucket50 = slice.calibration.find((b) => b.bucket === "50-60")!;
    expect(bucket50).toMatchObject({ n: 1, meanStatedBps: 5_000 });
    expect(bucket50.realized.successes).toBe(0);

    const tags = new Map(slice.tags.map((tag) => [tag.tag, tag]));

    const rugLpPull = tags.get("RUG_LP_PULL")!;
    expect(rugLpPull.measured).toBe(true);
    expect(rugLpPull.predicted).toBe(2);
    expect(rugLpPull.precision).toEqual({
      n: 2,
      successes: 1,
      rateBps: 5_000,
      wilsonLowerBps: 945,
      wilsonUpperBps: 9_055
    });
    expect(rugLpPull.recall).toEqual({
      n: 1,
      successes: 1,
      rateBps: 10_000,
      wilsonLowerBps: 2_065,
      wilsonUpperBps: 10_000
    });

    const concentrationDump = tags.get("CONCENTRATION_DUMP")!;
    expect(concentrationDump.predicted).toBe(1);
    expect(concentrationDump.precision).toMatchObject({ n: 1, successes: 1, rateBps: 10_000 });
    expect(concentrationDump.recall).toMatchObject({ n: 2, successes: 1, rateBps: 5_000 });

    const noFollowThrough = tags.get("NO_FOLLOW_THROUGH")!;
    expect(noFollowThrough.measured).toBe(true);
    expect(noFollowThrough.predicted).toBe(0);
    expect(noFollowThrough.precision).toBeNull();
    expect(noFollowThrough.recall).toEqual({
      n: 1,
      successes: 0,
      rateBps: 0,
      wilsonLowerBps: 0,
      wilsonUpperBps: 7_935
    });

    const sellRestriction = tags.get("SELL_RESTRICTION")!;
    expect(sellRestriction.measured).toBe(false);
    expect(sellRestriction.predicted).toBe(1);
    expect(sellRestriction.precision).toBeNull();
    expect(sellRestriction.recall).toBeNull();

    const washCoordination = tags.get("WASH_COORDINATION")!;
    expect(washCoordination.measured).toBe(false);
    expect(washCoordination.predicted).toBe(0);

    const other = tags.get("OTHER")!;
    expect(other.measured).toBe(false);
    expect(other.predicted).toBe(0);

    expect(slice.medianCostUsd).toBe(0.02);
    expect(slice.medianLatencyMs).toBe(2_500);
    expect(slice.medianToolCalls).toBe(1.5);

    expect(slice.periodStart).toBe(T0.toISOString());
    expect(slice.periodEnd).toBe(new Date(T0.getTime() + 3 * DAY_MS).toISOString());

    expect(slice.items).toHaveLength(3);
    const itemC = slice.items.find((item) => item.poolAddress === poolC)!;
    expect(itemC.realizedLabel).toBe("RUGGED");
    expect(itemC.realizedHit).toBe(false);
    expect(itemC.brierMicro).toBe(250_000);
    expect(itemC.riskMatches).toEqual({ RUG_LP_PULL: true });
  });

  it("classifies RUGGED from a liquidity collapse even when the token technically survived", () => {
    const pool = "0xCollapsedPool";
    const brief = briefFixture({
      poolAddress: pool,
      recommendation: "RESEARCH",
      confidenceBps: 9_000
    });
    const perf = perfFixture(pool, { maxMultipleBps: 15_000, maxDrawdownBps: 0 });
    const outcome = outcomeFixture(pool, {
      outcome: "SURVIVED",
      peakQuoteLiquidityUsd: "100000",
      quoteLiquidityAtHorizonUsd: "10000" // 10% of peak, below the 20% collapse threshold
    });

    const report = buildJudgeReport([brief], [perf], [outcome]);
    const item = report.slices[0]!.items[0]!;
    expect(item.realizedLabel).toBe("RUGGED");
    expect(item.realizedHit).toBe(false);
  });

  it("slices strictly out-of-time on [from, to] and uses the explicit bounds as the period", () => {
    const pools = ["0xP1", "0xP2", "0xP3"];
    const briefs = pools.map((pool, index) =>
      briefFixture({
        poolAddress: pool,
        recommendation: "WATCH",
        asOf: new Date(T0.getTime() + index * DAY_MS)
      })
    );
    const perfRows = pools.map((pool) => perfFixture(pool, { maxMultipleBps: 10_000 }));

    const from = new Date(T0.getTime() + 12 * 60 * 60 * 1000); // between briefs[0] and briefs[1]
    const to = new Date(T0.getTime() + DAY_MS + 12 * 60 * 60 * 1000); // between briefs[1] and briefs[2]

    const report = buildJudgeReport(briefs, perfRows, [], { from, to });
    expect(report.from).toBe(from.toISOString());
    expect(report.to).toBe(to.toISOString());
    expect(report.slices).toHaveLength(1);
    expect(report.slices[0]!.n).toBe(1);
    expect(report.slices[0]!.periodStart).toBe(from.toISOString());
    expect(report.slices[0]!.periodEnd).toBe(to.toISOString());
  });

  it("slices independently per (promptName, promptVersion, horizonHours)", () => {
    const poolA = "0xHzA";
    const poolB = "0xHzB";
    const poolC = "0xHzC";

    const briefV1H72 = briefFixture({ poolAddress: poolA, promptVersion: 1 });
    const briefV2H72 = briefFixture({ poolAddress: poolB, promptVersion: 2 });
    const briefV1H168 = briefFixture({ poolAddress: poolC, promptVersion: 1 });

    const perfRows = [
      perfFixture(poolA, { horizonHours: 72, maxMultipleBps: 10_000 }),
      perfFixture(poolB, { horizonHours: 72, maxMultipleBps: 10_000 }),
      perfFixture(poolC, { horizonHours: 168, maxMultipleBps: 10_000 })
    ];

    const report = buildJudgeReport([briefV1H72, briefV2H72, briefV1H168], perfRows, []);
    expect(report.slices).toHaveLength(3);
    const keys = report.slices
      .map((slice) => `${slice.promptVersion}:${slice.horizonHours}`)
      .sort();
    expect(keys).toEqual(["1:168", "1:72", "2:72"]);
  });

  it("excludes FAILED briefs and briefs with no matching realized outcome entirely", () => {
    const failed = briefFixture({ poolAddress: "0xFailed", status: "FAILED", recommendation: null, confidenceBps: null });
    const noOutcome = briefFixture({ poolAddress: "0xNoOutcome" });
    // Only `failed`'s and `noOutcome`'s pools exist — neither has a matching token_performance row.
    const report = buildJudgeReport([failed, noOutcome], [], []);
    expect(report.slices).toEqual([]);
  });
});
