import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  insertPoolActivitySnapshots,
  insertPools,
  insertPoolSnapshots,
  insertTokenHolderSnapshot,
  insertTokenPerformance,
  insertTokenRisk,
  insertTokens,
  listTokenPerformance,
  type Db,
  type PoolActivitySnapshotInsert,
  type PoolInsert,
  type PoolSnapshotInsert,
  type PoolSnapshotRow,
  type TokenHolderSnapshotInsert,
  type TokenInsert,
  type TokenRiskInsert
} from "@assay/database";
import {
  createTestDatabase,
  type TestDatabaseHandle
} from "@assay/database/testing";

import {
  computePerformanceLabel,
  runPerformancePass,
  type PerformancePassOptions
} from "../src/performance-pass.js";

const CHAIN_ID = 5252;
const POOL = "0x1111111111111111111111111111111111111111";
const BASE = "0x3333333333333333333333333333333333333333";
const QUOTE = "0x4444444444444444444444444444444444444444";
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

const BAND = { bandMinFdvUsd: 50_000, bandMaxFdvUsd: 200_000 };

function poolInsert(overrides: Partial<PoolInsert> = {}): PoolInsert {
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

function tokenInsert(overrides: Partial<TokenInsert> = {}): TokenInsert {
  return {
    chainId: CHAIN_ID,
    address: BASE,
    firstSeenBlock: 100n,
    ...overrides
  };
}

function snapshotInsert(
  capturedAt: Date,
  overrides: Partial<PoolSnapshotInsert> = {}
): PoolSnapshotInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress: POOL,
    blockNumber: 100n,
    capturedAt,
    calculationMethod: "v2-reserves",
    priceUsd: "0.001",
    estimatedFdvUsd: "100000",
    quoteLiquidityUsd: "50000",
    totalLiquidityUsd: "100000",
    ...overrides
  };
}

let nextSnapshotId = 1n;

/** Builds a fully-formed `PoolSnapshotRow` for pure `computePerformanceLabel` unit tests. */
function snapshotRow(
  capturedAt: Date,
  overrides: Partial<PoolSnapshotRow> = {}
): PoolSnapshotRow {
  const row: PoolSnapshotRow = {
    id: nextSnapshotId,
    chainId: CHAIN_ID,
    poolAddress: POOL,
    blockNumber: 100n,
    capturedAt,
    calculationMethod: "v2-reserves",
    priceUsd: "0.001",
    estimatedFdvUsd: "100000",
    quoteLiquidityUsd: "50000",
    totalLiquidityUsd: "100000",
    anchorPoolAddress: null,
    nullReason: null,
    ...overrides
  };
  nextSnapshotId += 1n;
  return row;
}

describe("computePerformanceLabel", () => {
  const t0 = new Date("2026-01-01T00:00:00.000Z");
  const farFuture = new Date(t0.getTime() + 1000 * HOUR_MS);

  it("picks the first observed in-band priced snapshot as entry, skipping pre-band and unpriced/unvalued ones", () => {
    const snapshots = [
      snapshotRow(t0, { estimatedFdvUsd: "30000", priceUsd: "0.0003" }), // below band
      snapshotRow(new Date(t0.getTime() + 10 * MIN_MS), {
        estimatedFdvUsd: null,
        priceUsd: "0.001",
        nullReason: "no-usd-anchor"
      }), // FDV null
      snapshotRow(new Date(t0.getTime() + 20 * MIN_MS), {
        estimatedFdvUsd: "100000",
        priceUsd: null,
        nullReason: "no-usd-anchor"
      }), // price null
      snapshotRow(new Date(t0.getTime() + 30 * MIN_MS), {
        estimatedFdvUsd: "120000",
        priceUsd: "0.0012"
      }) // ENTRY
    ];
    const result = computePerformanceLabel(snapshots, 1, BAND, farFuture);
    expect(result).not.toBeNull();
    expect(result?.entrySnapshot.capturedAt).toEqual(
      new Date(t0.getTime() + 30 * MIN_MS)
    );
    expect(result?.entrySnapshot.estimatedFdvUsd).toBe("120000");
  });

  it("returns null when no snapshot ever crossed into the band", () => {
    const snapshots = [
      snapshotRow(t0, { estimatedFdvUsd: "1000", priceUsd: "0.00001" }),
      snapshotRow(new Date(t0.getTime() + 10 * MIN_MS), {
        estimatedFdvUsd: "900000",
        priceUsd: "9"
      })
    ];
    expect(computePerformanceLabel(snapshots, 1, BAND, farFuture)).toBeNull();
  });

  it("returns null when the horizon window has not yet fully elapsed", () => {
    const snapshots = [snapshotRow(t0, { estimatedFdvUsd: "100000", priceUsd: "0.001" })];
    const notYet = new Date(t0.getTime() + 71 * HOUR_MS);
    expect(computePerformanceLabel(snapshots, 72, BAND, notYet)).toBeNull();
    const justElapsed = new Date(t0.getTime() + 72 * HOUR_MS);
    expect(computePerformanceLabel(snapshots, 72, BAND, justElapsed)).not.toBeNull();
  });

  it("gives multiple 10000 and drawdown 0 when price never rises above entry", () => {
    const snapshots = [
      snapshotRow(t0, { priceUsd: "1", estimatedFdvUsd: "100000" }),
      snapshotRow(new Date(t0.getTime() + 30 * MIN_MS), {
        priceUsd: "0.7",
        estimatedFdvUsd: "70000"
      })
    ];
    const result = computePerformanceLabel(snapshots, 1, BAND, farFuture);
    // Peak stays the entry snapshot itself (nothing ever exceeds it), so
    // there is no "pain before the payoff" to record either.
    expect(result?.maxMultipleBps).toBe(10_000);
    expect(result?.maxDrawdownBps).toBe(0);
  });

  it("counts a pre-peak dip toward drawdown but ignores a dip that happens after the peak", () => {
    const snapshots = [
      snapshotRow(t0, { priceUsd: "1", estimatedFdvUsd: "100000" }), // entry
      snapshotRow(new Date(t0.getTime() + 10 * MIN_MS), {
        priceUsd: "0.5",
        estimatedFdvUsd: "50000"
      }), // pre-peak dip: counts
      snapshotRow(new Date(t0.getTime() + 20 * MIN_MS), {
        priceUsd: "2",
        estimatedFdvUsd: "200000"
      }), // peak
      snapshotRow(new Date(t0.getTime() + 30 * MIN_MS), {
        priceUsd: "0.1",
        estimatedFdvUsd: "10000"
      }) // post-peak dip: ignored
    ];
    const result = computePerformanceLabel(snapshots, 1, BAND, farFuture);
    expect(result?.maxMultipleBps).toBe(20_000);
    // (1 - 0.5) / 1 = 5000bps, NOT (1 - 0.1)/1 = 9000bps.
    expect(result?.maxDrawdownBps).toBe(5_000);
    expect(result?.minutesToPeak).toBe(20);
    expect(result?.peakSnapshot.priceUsd).toBe("2");
  });

  it("labels a single-snapshot window with multiple 10000, drawdown 0, minutesToPeak 0", () => {
    const snapshots = [snapshotRow(t0, { priceUsd: "1", estimatedFdvUsd: "100000" })];
    const result = computePerformanceLabel(snapshots, 1, BAND, farFuture);
    expect(result?.maxMultipleBps).toBe(10_000);
    expect(result?.maxDrawdownBps).toBe(0);
    expect(result?.minutesToPeak).toBe(0);
    expect(result?.snapshotsInWindow).toBe(1);
  });

  it("records the forward-only observation note and band bounds in details", () => {
    const snapshots = [snapshotRow(t0, { priceUsd: "1", estimatedFdvUsd: "100000" })];
    const result = computePerformanceLabel(snapshots, 1, BAND, farFuture);
    expect(result?.details).toMatchObject({
      bandMinFdvUsd: BAND.bandMinFdvUsd,
      bandMaxFdvUsd: BAND.bandMaxFdvUsd,
      maxMultipleBps: 10_000,
      maxDrawdownBps: 0
    });
    expect(String(result?.details["observation"])).toContain("forward-only");
  });
});

describe("runPerformancePass", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    await insertPools(db, [poolInsert()]);
    await insertTokens(db, [tokenInsert()]);
  });

  afterEach(async () => {
    await handle.close();
  });

  function options(overrides: Partial<PerformancePassOptions> = {}): PerformancePassOptions {
    return { db, chainId: CHAIN_ID, ...overrides };
  }

  /**
   * Seeds a pool whose first snapshot is far enough in the past to be due at
   * both 72h and 168h, crosses the band 10h in, peaks at different points
   * within each horizon window (so 72h and 168h produce distinct labels),
   * and has a fully-elapsed window at both horizons relative to `now`.
   */
  async function seedMultiHorizonPool(): Promise<{ entryAt: Date; now: Date }> {
    const now = new Date();
    const preBandAt = new Date(now.getTime() - 200 * HOUR_MS);
    const entryAt = new Date(preBandAt.getTime() + 10 * HOUR_MS);
    await insertPoolSnapshots(db, [
      snapshotInsert(preBandAt, { estimatedFdvUsd: "30000", priceUsd: "0.0003" }),
      snapshotInsert(entryAt, { estimatedFdvUsd: "100000", priceUsd: "0.001" }),
      snapshotInsert(new Date(entryAt.getTime() + 24 * HOUR_MS), {
        estimatedFdvUsd: "150000",
        priceUsd: "0.002"
      }),
      snapshotInsert(new Date(entryAt.getTime() + 72 * HOUR_MS), {
        estimatedFdvUsd: "90000",
        priceUsd: "0.0012"
      }),
      snapshotInsert(new Date(entryAt.getTime() + 100 * HOUR_MS), {
        estimatedFdvUsd: "200000",
        priceUsd: "0.0025"
      }),
      snapshotInsert(new Date(entryAt.getTime() + 150 * HOUR_MS), {
        estimatedFdvUsd: "50000",
        priceUsd: "0.0005"
      }),
      snapshotInsert(new Date(entryAt.getTime() + 168 * HOUR_MS), {
        estimatedFdvUsd: "120000",
        priceUsd: "0.0018"
      })
    ]);
    return { entryAt, now };
  }

  it("labels both configured horizons for one pool in a single pass", async () => {
    const { now } = await seedMultiHorizonPool();
    const result = await runPerformancePass(
      options({ config: { horizons: [72, 168] }, now: () => now })
    );

    expect(result.labeled).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.poolErrors).toEqual([]);

    const rows = await listTokenPerformance(db, CHAIN_ID);
    expect(rows).toHaveLength(2);
    const byHorizon = new Map(rows.map((row) => [row.horizonHours, row]));

    const at72 = byHorizon.get(72)!;
    expect(at72.maxMultipleBps).toBe(20_000);
    expect(at72.snapshotsInWindow).toBe(3);

    const at168 = byHorizon.get(168)!;
    expect(at168.maxMultipleBps).toBe(25_000);
    expect(at168.snapshotsInWindow).toBe(6);
    expect(at168.minutesToPeak).toBe(100 * 60);
  });

  it("never relabels an already-labeled (pool, horizon) pair on a second pass", async () => {
    const { now } = await seedMultiHorizonPool();
    const firstRun = await runPerformancePass(
      options({ config: { horizons: [72, 168] }, now: () => now })
    );
    expect(firstRun.labeled).toBe(2);

    const secondRun = await runPerformancePass(
      options({ config: { horizons: [72, 168] }, now: () => now })
    );
    expect(secondRun.labeled).toBe(0);
    expect(secondRun.poolsConsidered).toBe(0);

    const rows = await listTokenPerformance(db, CHAIN_ID);
    expect(rows).toHaveLength(2);
  });

  it("stays idempotent even if insertTokenPerformance is called twice for the same key", async () => {
    const { entryAt } = await seedMultiHorizonPool();
    await insertTokenPerformance(db, {
      chainId: CHAIN_ID,
      tokenAddress: BASE,
      poolAddress: POOL,
      horizonHours: 72,
      bandMinFdvUsd: "50000",
      bandMaxFdvUsd: "200000",
      enteredAt: entryAt,
      entryBlock: 100n,
      entryPriceUsd: "0.001",
      entryFdvUsd: "100000",
      maxMultipleBps: 20_000,
      maxDrawdownBps: 0,
      minutesToPeak: 1440,
      snapshotsInWindow: 3,
      entryFeatures: { seeded: true },
      details: { seeded: true }
    });

    await runPerformancePass(options({ config: { horizons: [72] } }));

    const rows = await listTokenPerformance(db, CHAIN_ID);
    const at72 = rows.filter((row) => row.horizonHours === 72);
    expect(at72).toHaveLength(1);
    expect(at72[0]?.details).toEqual({ seeded: true });
  });

  it("never selects a pool whose snapshots never crossed the band — no batch slot consumed", async () => {
    const now = new Date();
    const firstAt = new Date(now.getTime() - 200 * HOUR_MS);
    await insertPoolSnapshots(db, [
      snapshotInsert(firstAt, { estimatedFdvUsd: "1000", priceUsd: "0.00001" }),
      snapshotInsert(new Date(firstAt.getTime() + 10 * HOUR_MS), {
        estimatedFdvUsd: "2000",
        priceUsd: "0.00002"
      })
    ]);

    // Selection-level exclusion (2026-07-12 starvation fix): a never-band
    // pool used to be selected, skipped with nothing persisted, and
    // re-selected forever — 200 of these starved every real band entrant.
    const result = await runPerformancePass(
      options({ config: { horizons: [72] }, now: () => now })
    );
    expect(result.poolsConsidered).toBe(0);
    expect(result.labeled).toBe(0);
    expect(result.skipped).toBe(0);
    expect(await listTokenPerformance(db, CHAIN_ID)).toEqual([]);

    const secondResult = await runPerformancePass(
      options({ config: { horizons: [72] }, now: () => now })
    );
    expect(secondResult.poolsConsidered).toBe(0);
    expect(await listTokenPerformance(db, CHAIN_ID)).toEqual([]);
  });

  it("skips pools without a resolved base token", async () => {
    const now = new Date();
    const firstAt = new Date(now.getTime() - 200 * HOUR_MS);
    await insertPools(db, [
      poolInsert({
        poolAddress: "0x9999999999999999999999999999999999999999",
        baseTokenAddress: null
      })
    ]);
    await insertPoolSnapshots(db, [
      snapshotInsert(firstAt, {
        poolAddress: "0x9999999999999999999999999999999999999999",
        estimatedFdvUsd: "100000",
        priceUsd: "0.001"
      })
    ]);

    const result = await runPerformancePass(options({ config: { horizons: [72] }, now: () => now }));
    expect(result.skipped).toBe(1);
    expect(result.labeled).toBe(0);
  });

  it("stops between pools once the signal is aborted, persisting nothing already labeled", async () => {
    await seedMultiHorizonPool();
    const controller = new AbortController();
    controller.abort();

    const result = await runPerformancePass(
      options({ config: { horizons: [72, 168] }, signal: controller.signal })
    );

    expect(result.stopped).toBe(true);
    expect(result.labeled).toBe(0);
    expect(await listTokenPerformance(db, CHAIN_ID)).toEqual([]);
  });

  it("leaves entry_features null when activity/holder/risk rows are absent at entry", async () => {
    const { now } = await seedMultiHorizonPool();
    await runPerformancePass(options({ config: { horizons: [72] }, now: () => now }));

    const rows = await listTokenPerformance(db, CHAIN_ID);
    expect(rows).toHaveLength(1);
    const features = rows[0]!.entryFeatures as Record<string, unknown>;
    expect(features["quoteLiquidityUsd"]).toBe("50000.000000000000000000");
    expect(features["totalLiquidityUsd"]).toBe("100000.000000000000000000");
    expect(typeof features["ageMinutesAtEntry"]).toBe("number");
    expect(features["uniqueBuyers1h"]).toBeNull();
    expect(features["buySizeGiniBps"]).toBeNull();
    expect(features["floatBps"]).toBeNull();
    expect(features["adjustedTop10PctBps"]).toBeNull();
    expect(features["deployerPctBps"]).toBeNull();
    expect(features["riskStatus"]).toBeNull();
    expect(features["simulationStatus"]).toBeNull();
    expect(features["effectiveSellLossBps"]).toBeNull();
  });

  it("populates entry_features from activity/holder/risk rows present at entry", async () => {
    const { entryAt, now } = await seedMultiHorizonPool();

    const activity: PoolActivitySnapshotInsert = {
      chainId: CHAIN_ID,
      poolAddress: POOL,
      blockNumber: 100n,
      capturedAt: entryAt,
      uniqueBuyers20m: 3,
      uniqueBuyers1h: 7,
      buyCount20m: 4,
      sellCount20m: 1,
      quoteBuyVolumeRaw20m: "100",
      quoteSellVolumeRaw20m: "10",
      quoteBuyVolumeRaw1h: "500",
      quoteSellVolumeRaw1h: "50",
      buySizeGiniBps: 3200,
      buySizeEntropyBps: 6100,
      repeatedSizeBuyPctBps: 500
    };
    const holder: TokenHolderSnapshotInsert = {
      chainId: CHAIN_ID,
      tokenAddress: BASE,
      blockNumber: 100n,
      capturedAt: entryAt,
      holderCount: 40,
      adjustedHolderCount: 32,
      largestHolderPctBps: 900,
      top10PctBps: 4500,
      adjustedTop10PctBps: 3800,
      deployerPctBps: 250,
      floatBps: 8800,
      supplyInPoolBps: 6100,
      excluded: []
    };
    const risk: TokenRiskInsert = {
      chainId: CHAIN_ID,
      tokenAddress: BASE,
      poolAddress: POOL,
      blockNumber: 100n,
      assessedAt: entryAt,
      status: "PASS",
      verificationStatus: "VERIFIED",
      permissionFindings: [],
      simulationStatus: "PASS",
      effectiveSellLossBps: 150,
      riskReasons: [],
      positiveReasons: []
    };
    await insertPoolActivitySnapshots(db, [activity]);
    await insertTokenHolderSnapshot(db, holder);
    await insertTokenRisk(db, risk);

    await runPerformancePass(options({ config: { horizons: [72] }, now: () => now }));

    const rows = await listTokenPerformance(db, CHAIN_ID);
    expect(rows).toHaveLength(1);
    const features = rows[0]!.entryFeatures as Record<string, unknown>;
    expect(features["uniqueBuyers1h"]).toBe(7);
    expect(features["buySizeGiniBps"]).toBe(3200);
    expect(features["buySizeEntropyBps"]).toBe(6100);
    expect(features["repeatedSizeBuyPctBps"]).toBe(500);
    expect(features["floatBps"]).toBe(8800);
    expect(features["supplyInPoolBps"]).toBe(6100);
    expect(features["adjustedTop10PctBps"]).toBe(3800);
    expect(features["deployerPctBps"]).toBe(250);
    expect(features["adjustedHolderCount"]).toBe(32);
    expect(features["riskStatus"]).toBe("PASS");
    expect(features["simulationStatus"]).toBe("PASS");
    expect(features["effectiveSellLossBps"]).toBe(150);
  });
});
