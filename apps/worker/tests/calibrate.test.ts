import { describe, expect, it } from "vitest";

import type { TokenPerformanceRow } from "@assay/database";

import { buildCalibrationReport } from "../src/calibrate.js";

const CHAIN_ID = 6363;
const BASE = "0x3333333333333333333333333333333333333333";
const POOL = "0x1111111111111111111111111111111111111111";
const T0 = new Date("2026-02-01T00:00:00.000Z");

let nextId = 1n;

function performanceRow(
  overrides: Partial<TokenPerformanceRow> & { entryFeatures?: unknown } = {}
): TokenPerformanceRow {
  const row: TokenPerformanceRow = {
    id: nextId,
    chainId: CHAIN_ID,
    tokenAddress: BASE,
    poolAddress: `${POOL}${nextId}`,
    horizonHours: 72,
    bandMinFdvUsd: "50000",
    bandMaxFdvUsd: "200000",
    enteredAt: T0,
    entryBlock: 100n,
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
  nextId += 1n;
  return row;
}

describe("buildCalibrationReport", () => {
  it("buckets rows into near-equal quartiles by feature value, with an explicit null bucket, on a hand-computed fixture set", () => {
    const rows = [
      performanceRow({
        maxMultipleBps: 15_000,
        maxDrawdownBps: 1_000,
        entryFeatures: { adjustedTop10PctBps: null }
      }), // null bucket
      performanceRow({
        maxMultipleBps: 10_000,
        maxDrawdownBps: 0,
        entryFeatures: { adjustedTop10PctBps: 10 }
      }), // q1
      performanceRow({
        maxMultipleBps: 20_000,
        maxDrawdownBps: 2_000,
        entryFeatures: { adjustedTop10PctBps: 20 }
      }), // q1
      performanceRow({
        maxMultipleBps: 25_000,
        maxDrawdownBps: 1_500,
        entryFeatures: { adjustedTop10PctBps: 30 }
      }), // q2
      performanceRow({
        maxMultipleBps: 50_000,
        maxDrawdownBps: 3_000,
        entryFeatures: { adjustedTop10PctBps: 40 }
      }), // q2
      performanceRow({
        maxMultipleBps: 60_000,
        maxDrawdownBps: 4_000,
        entryFeatures: { adjustedTop10PctBps: 50 }
      }), // q3
      performanceRow({
        maxMultipleBps: 70_000,
        maxDrawdownBps: 500,
        entryFeatures: { adjustedTop10PctBps: 60 }
      }), // q3
      performanceRow({
        maxMultipleBps: 100_000,
        maxDrawdownBps: 100,
        entryFeatures: { adjustedTop10PctBps: 70 }
      }) // q4
    ];

    const report = buildCalibrationReport(rows);

    // Headline over all 8 rows at the one horizon present.
    expect(report.headline).toEqual([
      {
        horizonHours: 72,
        count: 8,
        minMultipleBps: 10_000,
        medianMultipleBps: 25_000,
        p75MultipleBps: 60_000,
        maxMultipleBps: 100_000,
        shareAtLeast2xBps: 7_500,
        shareAtLeast5xBps: 5_000,
        medianDrawdownBps: 1_000
      }
    ]);

    const featureReport = report.features.find(
      (entry) => entry.feature === "adjustedTop10PctBps" && entry.horizonHours === 72
    );
    expect(featureReport).toBeDefined();
    expect(featureReport?.buckets).toEqual([
      {
        bucket: "null",
        count: 1,
        medianMultipleBps: 15_000,
        p75MultipleBps: 15_000,
        shareAtLeast2xBps: 0,
        shareAtLeast5xBps: 0,
        medianDrawdownBps: 1_000
      },
      {
        bucket: "q1",
        count: 2,
        medianMultipleBps: 10_000,
        p75MultipleBps: 20_000,
        shareAtLeast2xBps: 5_000,
        shareAtLeast5xBps: 0,
        medianDrawdownBps: 0
      },
      {
        bucket: "q2",
        count: 2,
        medianMultipleBps: 25_000,
        p75MultipleBps: 50_000,
        shareAtLeast2xBps: 10_000,
        shareAtLeast5xBps: 5_000,
        medianDrawdownBps: 1_500
      },
      {
        bucket: "q3",
        count: 2,
        medianMultipleBps: 60_000,
        p75MultipleBps: 70_000,
        shareAtLeast2xBps: 10_000,
        shareAtLeast5xBps: 10_000,
        medianDrawdownBps: 500
      },
      {
        bucket: "q4",
        count: 1,
        medianMultipleBps: 100_000,
        p75MultipleBps: 100_000,
        shareAtLeast2xBps: 10_000,
        shareAtLeast5xBps: 10_000,
        medianDrawdownBps: 100
      }
    ]);
  });

  it("collapses an entirely-missing feature to a single null bucket with no quartile buckets", () => {
    const rows = [
      performanceRow({ entryFeatures: {} }),
      performanceRow({ entryFeatures: { buySizeGiniBps: null } }),
      performanceRow({ entryFeatures: null })
    ];
    const report = buildCalibrationReport(rows);
    const featureReport = report.features.find(
      (entry) => entry.feature === "buySizeGiniBps"
    );
    expect(featureReport?.buckets).toEqual([
      {
        bucket: "null",
        count: 3,
        medianMultipleBps: 10_000,
        p75MultipleBps: 10_000,
        shareAtLeast2xBps: 0,
        shareAtLeast5xBps: 0,
        medianDrawdownBps: 0
      }
    ]);
  });

  it("coerces USD decimal-string features numerically, not lexically, when bucketing", () => {
    const rows = [
      performanceRow({ entryFeatures: { quoteLiquidityUsd: "9000" } }),
      performanceRow({ entryFeatures: { quoteLiquidityUsd: "10000" } }),
      performanceRow({ entryFeatures: { quoteLiquidityUsd: "50000" } }),
      performanceRow({ entryFeatures: { quoteLiquidityUsd: "200000" } })
    ];
    const report = buildCalibrationReport(rows);
    const featureReport = report.features.find(
      (entry) => entry.feature === "quoteLiquidityUsd"
    );
    // Lexical sort would place "10000" before "50000" before "9000"; numeric
    // sort must place "9000" first.
    expect(featureReport?.buckets.map((bucket) => bucket.bucket)).toEqual([
      "q1",
      "q2",
      "q3",
      "q4"
    ]);
    expect(featureReport?.buckets.every((bucket) => bucket.count === 1)).toBe(true);
  });

  it("keeps horizons fully separate in both headline and feature buckets", () => {
    const rows = [
      performanceRow({ horizonHours: 72, maxMultipleBps: 20_000 }),
      performanceRow({ horizonHours: 72, maxMultipleBps: 30_000 }),
      performanceRow({ horizonHours: 168, maxMultipleBps: 90_000 })
    ];
    const report = buildCalibrationReport(rows);
    expect(report.headline.map((row) => row.horizonHours)).toEqual([72, 168]);
    expect(report.headline.find((row) => row.horizonHours === 72)?.count).toBe(2);
    expect(report.headline.find((row) => row.horizonHours === 168)?.count).toBe(1);

    const featuresAt72 = report.features.filter((entry) => entry.horizonHours === 72);
    const featuresAt168 = report.features.filter((entry) => entry.horizonHours === 168);
    expect(featuresAt72.length).toBeGreaterThan(0);
    expect(featuresAt72.length).toBe(featuresAt168.length);
  });

  it("returns an empty report for no rows", () => {
    expect(buildCalibrationReport([])).toEqual({ headline: [], features: [] });
  });
});
