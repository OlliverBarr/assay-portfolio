import { describe, expect, it } from "vitest";

import type { TokenOutcomeRow, TokenPerformanceRow } from "@assay/database";

import { buildDiedCohortReport } from "../src/calibrate-died.js";
import { wilsonInterval } from "../src/judge-report.js";

const CHAIN_ID = 6363;
const BASE = "0x3333333333333333333333333333333333333333";
const POOL = "0x1111111111111111111111111111111111111111";
const T0 = new Date("2026-02-01T00:00:00.000Z");
const TUNE_UNTIL = new Date("2026-07-13T00:00:00.000Z");
const TUNE_DATE = new Date("2026-07-10T00:00:00.000Z");
const CONFIRM_DATE = new Date("2026-07-15T00:00:00.000Z");

let nextId = 1n;

function performanceRow(
  overrides: Partial<TokenPerformanceRow> & { entryFeatures?: unknown } = {}
): TokenPerformanceRow {
  const id = nextId;
  nextId += 1n;
  const row: TokenPerformanceRow = {
    id,
    chainId: CHAIN_ID,
    tokenAddress: BASE,
    poolAddress: `${POOL}${id}`,
    horizonHours: 72,
    bandMinFdvUsd: "10000",
    bandMaxFdvUsd: "100000",
    enteredAt: T0,
    entryBlock: 100n,
    entryPriceUsd: "0.001",
    entryFdvUsd: "50000",
    maxMultipleBps: 15_000,
    maxDrawdownBps: 0,
    minutesToPeak: 0,
    snapshotsInWindow: 1,
    entryFeatures: {},
    labeledAt: T0,
    details: {},
    ...overrides
  };
  return row;
}

/** Outcome row DIED for `poolAddress`; join key is (chainId, poolAddress, horizonHours). */
function diedOutcome(poolAddress: string, horizonHours = 72): TokenOutcomeRow {
  const id = nextId;
  nextId += 1n;
  return {
    id,
    chainId: CHAIN_ID,
    tokenAddress: BASE,
    poolAddress,
    horizonHours,
    outcome: "DIED",
    peakQuoteLiquidityUsd: null,
    quoteLiquidityAtHorizonUsd: null,
    estimatedFdvAtHorizonUsd: null,
    firstObservedAt: T0,
    labeledAt: T0,
    details: {}
  };
}

describe("buildDiedCohortReport - lift and Wilson interval", () => {
  it("computes a correct RUGGED lift and finite Wilson interval when a bucket is entirely RUGGED", () => {
    // 8 rows ranked by ageMinutesAtEntry, splitting into 4 quartiles of 2.
    // Only the two lowest-value (q1) rows died; the population RUGGED rate
    // is therefore 2/8 = 2500bps, and q1's own rate is 2/2 = 10000bps.
    const rows = [
      performanceRow({ entryFeatures: { ageMinutesAtEntry: 1 } }), // q1, RUGGED
      performanceRow({ entryFeatures: { ageMinutesAtEntry: 2 } }), // q1, RUGGED
      performanceRow({ entryFeatures: { ageMinutesAtEntry: 3 }, maxMultipleBps: 15_000 }), // q2
      performanceRow({ entryFeatures: { ageMinutesAtEntry: 4 }, maxMultipleBps: 15_000 }), // q2
      performanceRow({ entryFeatures: { ageMinutesAtEntry: 5 }, maxMultipleBps: 15_000 }), // q3
      performanceRow({ entryFeatures: { ageMinutesAtEntry: 6 }, maxMultipleBps: 15_000 }), // q3
      performanceRow({ entryFeatures: { ageMinutesAtEntry: 7 }, maxMultipleBps: 15_000 }), // q4
      performanceRow({ entryFeatures: { ageMinutesAtEntry: 8 }, maxMultipleBps: 15_000 }) // q4
    ];
    const outcomes = [diedOutcome(rows[0]!.poolAddress), diedOutcome(rows[1]!.poolAddress)];

    const report = buildDiedCohortReport(rows, outcomes, {
      horizonHours: 72,
      tuneUntil: TUNE_UNTIL
    });

    expect(report.populationRugged).toEqual({
      n: 8,
      successes: 2,
      rateBps: 2_500,
      wilsonLowerBps: wilsonInterval(2, 8)!.lowerBps,
      wilsonUpperBps: wilsonInterval(2, 8)!.upperBps
    });

    const feature = report.features.find((entry) => entry.feature === "ageMinutesAtEntry");
    expect(feature).toBeDefined();
    const q1 = feature!.buckets.find((bucket) => bucket.bucket === "q1");
    expect(q1).toBeDefined();
    expect(q1!.rugged).toEqual({
      n: 2,
      successes: 2,
      rateBps: 10_000,
      wilsonLowerBps: wilsonInterval(2, 2)!.lowerBps,
      wilsonUpperBps: wilsonInterval(2, 2)!.upperBps
    });
    expect(q1!.rugged.wilsonLowerBps).not.toBeNull();
    expect(q1!.rugged.wilsonUpperBps).not.toBeNull();
    // 10000bps bucket rate - 2500bps population rate.
    expect(q1!.liftBps).toBe(7_500);
  });
});

describe("buildDiedCohortReport - coverage gate", () => {
  it("flags a feature with more than 40% null rows as lowCoverage and excludes it from the ranked summary", () => {
    // 5 rows: 3 null (60% null, 40% non-null coverage) on buySizeGiniBps.
    // The 2 non-null rows both died, in both the tune and confirm periods,
    // which would otherwise rank as a strong, confirmed "signal" - proving
    // the coverage gate, not the signal classifier, is what excludes it.
    const rows = [
      performanceRow({ entryFeatures: {}, enteredAt: TUNE_DATE }),
      performanceRow({ entryFeatures: {}, enteredAt: CONFIRM_DATE }),
      performanceRow({ entryFeatures: {}, enteredAt: TUNE_DATE }),
      performanceRow({ entryFeatures: { buySizeGiniBps: 100 }, enteredAt: TUNE_DATE }),
      performanceRow({ entryFeatures: { buySizeGiniBps: 200 }, enteredAt: CONFIRM_DATE })
    ];
    const outcomes = [diedOutcome(rows[3]!.poolAddress), diedOutcome(rows[4]!.poolAddress)];

    const report = buildDiedCohortReport(rows, outcomes, {
      horizonHours: 72,
      tuneUntil: TUNE_UNTIL
    });

    const feature = report.features.find((entry) => entry.feature === "buySizeGiniBps");
    expect(feature).toBeDefined();
    expect(feature!.coverageBps).toBe(4_000);
    expect(feature!.lowCoverage).toBe(true);
    expect(
      report.commonalities.some((entry) => entry.feature === "buySizeGiniBps")
    ).toBe(false);
  });
});

describe("buildDiedCohortReport - out-of-time confirmation", () => {
  it("labels a bucket unconfirmed when its lift direction reverses between the tune and confirm periods", () => {
    // 8 rows, one per (quartile x period) cell for q1 and q4, plus 4 filler
    // rows for q2/q3 so the quartile split is a clean 2/2/2/2. q1 dies only
    // in the tune period (lift positive there) and survives in confirm
    // while a different quartile (q4) dies in confirm (lift negative for
    // q1 there, since q1's own confirm rate is 0 against a nonzero
    // population confirm rate) - a genuine sign reversal, not a flat lift.
    const q1Tune = performanceRow({ entryFeatures: { floatBps: 1 }, enteredAt: TUNE_DATE });
    const q1Confirm = performanceRow({ entryFeatures: { floatBps: 2 }, enteredAt: CONFIRM_DATE });
    const q2Tune = performanceRow({ entryFeatures: { floatBps: 3 }, enteredAt: TUNE_DATE });
    const q2Confirm = performanceRow({ entryFeatures: { floatBps: 4 }, enteredAt: CONFIRM_DATE });
    const q3Tune = performanceRow({ entryFeatures: { floatBps: 5 }, enteredAt: TUNE_DATE });
    const q3Confirm = performanceRow({ entryFeatures: { floatBps: 6 }, enteredAt: CONFIRM_DATE });
    const q4Tune = performanceRow({ entryFeatures: { floatBps: 7 }, enteredAt: TUNE_DATE });
    const q4Confirm = performanceRow({ entryFeatures: { floatBps: 8 }, enteredAt: CONFIRM_DATE });

    const rows = [q1Tune, q1Confirm, q2Tune, q2Confirm, q3Tune, q3Confirm, q4Tune, q4Confirm];
    const outcomes = [diedOutcome(q1Tune.poolAddress), diedOutcome(q4Confirm.poolAddress)];

    const report = buildDiedCohortReport(rows, outcomes, {
      horizonHours: 72,
      tuneUntil: TUNE_UNTIL
    });

    const feature = report.features.find((entry) => entry.feature === "floatBps");
    expect(feature).toBeDefined();
    const q1 = feature!.buckets.find((bucket) => bucket.bucket === "q1");
    expect(q1).toBeDefined();

    // Tune population: 1 of 4 died (q1Tune) = 2500bps; q1's own tune rate
    // is 1/1 = 10000bps, so its tune lift is positive.
    expect(q1!.tune?.liftBps).toBeGreaterThan(0);
    // Confirm population: 1 of 4 died (q4Confirm) = 2500bps; q1's own
    // confirm rate is 0/1 = 0bps, so its confirm lift is negative.
    expect(q1!.confirm?.liftBps).toBeLessThan(0);
    expect(q1!.commonality).toBe("unconfirmed");
    expect(
      report.commonalities.some(
        (entry) => entry.feature === "floatBps" && entry.bucket === "q1"
      )
    ).toBe(false);
  });
});

describe("buildDiedCohortReport - empty population", () => {
  it("returns a zeroed report for no rows", () => {
    const report = buildDiedCohortReport([], [], { horizonHours: 72, tuneUntil: TUNE_UNTIL });
    expect(report.windowN).toBe(0);
    expect(report.populationRugged).toEqual({
      n: 0,
      successes: 0,
      rateBps: 0,
      wilsonLowerBps: null,
      wilsonUpperBps: null
    });
    expect(report.features).toEqual([]);
    expect(report.commonalities).toEqual([]);
  });
});
