import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  insertPools,
  insertPoolSnapshots,
  insertTokens,
  insertTokenOutcome,
  getTokenOutcomes,
  type Db,
  type PoolInsert,
  type PoolSnapshotInsert,
  type PoolSnapshotRow,
  type TokenInsert
} from "@assay/database";
import {
  createTestDatabase,
  type TestDatabaseHandle
} from "@assay/database/testing";

import {
  computeOutcomeLabel,
  runOutcomePass,
  type OutcomePassOptions
} from "../src/outcome-pass.js";

const CHAIN_ID = 4242;
const POOL = "0x1111111111111111111111111111111111111111";
const BASE = "0x3333333333333333333333333333333333333333";
const QUOTE = "0x4444444444444444444444444444444444444444";
const HOUR_MS = 60 * 60 * 1000;

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
    priceUsd: "1",
    estimatedFdvUsd: "100000",
    quoteLiquidityUsd: "50000",
    totalLiquidityUsd: "100000",
    ...overrides
  };
}

let nextSnapshotId = 1n;

/** Builds a fully-formed `PoolSnapshotRow` for pure `computeOutcomeLabel` unit tests. */
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
    priceUsd: "1",
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

const SURVIVAL_CONFIG = {
  survivalMinLiquidityFractionBps: 3000,
  survivalMinFdvUsd: 10_000
};

describe("computeOutcomeLabel", () => {
  const first = new Date("2026-01-01T00:00:00.000Z");
  const atHorizon = new Date(first.getTime() + 24 * HOUR_MS);
  const evalNow = new Date(first.getTime() + 48 * HOUR_MS);

  it("labels SURVIVED when at-horizon liquidity is exactly at the fraction and FDV exactly at the floor", () => {
    const snapshots = [
      snapshotRow(first, { quoteLiquidityUsd: "100000", estimatedFdvUsd: "50000" }),
      snapshotRow(atHorizon, { quoteLiquidityUsd: "30000", estimatedFdvUsd: "10000" })
    ];
    const result = computeOutcomeLabel(snapshots, 24, SURVIVAL_CONFIG, evalNow);
    expect(result?.outcome).toBe("SURVIVED");
    expect(result?.peakQuoteLiquidityUsd).toBe("100000");
    expect(result?.quoteLiquidityAtHorizonUsd).toBe("30000");
    expect(result?.estimatedFdvAtHorizonUsd).toBe("10000");
  });

  it("labels DIED when at-horizon liquidity is one cent under the survival fraction", () => {
    const snapshots = [
      snapshotRow(first, { quoteLiquidityUsd: "100000", estimatedFdvUsd: "50000" }),
      snapshotRow(atHorizon, { quoteLiquidityUsd: "29999.99", estimatedFdvUsd: "50000" })
    ];
    const result = computeOutcomeLabel(snapshots, 24, SURVIVAL_CONFIG, evalNow);
    expect(result?.outcome).toBe("DIED");
  });

  it("labels DIED when FDV is one cent under the floor even with peak liquidity retained", () => {
    const snapshots = [
      snapshotRow(first, { quoteLiquidityUsd: "100000", estimatedFdvUsd: "50000" }),
      snapshotRow(atHorizon, { quoteLiquidityUsd: "100000", estimatedFdvUsd: "9999.99" })
    ];
    const result = computeOutcomeLabel(snapshots, 24, SURVIVAL_CONFIG, evalNow);
    expect(result?.outcome).toBe("DIED");
  });

  it("skips (returns null) a pool with fewer than two priced snapshots in the window", () => {
    const snapshots = [snapshotRow(first, { quoteLiquidityUsd: "100000" })];
    expect(computeOutcomeLabel(snapshots, 24, SURVIVAL_CONFIG, evalNow)).toBeNull();
  });

  it("skips a pool whose only in-window snapshots lack a priced quote liquidity", () => {
    const snapshots = [
      snapshotRow(first, { quoteLiquidityUsd: null, nullReason: "no-usd-anchor" }),
      snapshotRow(atHorizon, { quoteLiquidityUsd: null, nullReason: "no-usd-anchor" })
    ];
    expect(computeOutcomeLabel(snapshots, 24, SURVIVAL_CONFIG, evalNow)).toBeNull();
  });

  it("skips when the at-horizon snapshot is missing estimatedFdvUsd", () => {
    const snapshots = [
      snapshotRow(first, { quoteLiquidityUsd: "100000", estimatedFdvUsd: "50000" }),
      snapshotRow(atHorizon, { quoteLiquidityUsd: "100000", estimatedFdvUsd: null })
    ];
    expect(computeOutcomeLabel(snapshots, 24, SURVIVAL_CONFIG, evalNow)).toBeNull();
  });

  it("ignores snapshots captured after the horizon window", () => {
    const snapshots = [
      snapshotRow(first, { quoteLiquidityUsd: "100000", estimatedFdvUsd: "50000" }),
      snapshotRow(atHorizon, { quoteLiquidityUsd: "30000", estimatedFdvUsd: "10000" }),
      snapshotRow(new Date(atHorizon.getTime() + HOUR_MS), {
        quoteLiquidityUsd: "1",
        estimatedFdvUsd: "1"
      })
    ];
    const result = computeOutcomeLabel(snapshots, 24, SURVIVAL_CONFIG, evalNow);
    // The out-of-window collapse must not leak into the at-horizon reading.
    expect(result?.outcome).toBe("SURVIVED");
    expect(result?.quoteLiquidityAtHorizonUsd).toBe("30000");
  });

  it("records every input in details, including the forward-only observation note", () => {
    const snapshots = [
      snapshotRow(first, { quoteLiquidityUsd: "100000", estimatedFdvUsd: "50000" }),
      snapshotRow(atHorizon, { quoteLiquidityUsd: "30000", estimatedFdvUsd: "10000" })
    ];
    const result = computeOutcomeLabel(snapshots, 24, SURVIVAL_CONFIG, evalNow);
    expect(result?.details).toMatchObject({
      horizonHours: 24,
      firstObservedAt: first.toISOString(),
      peakQuoteLiquidityUsd: "100000",
      quoteLiquidityAtHorizonUsd: "30000",
      estimatedFdvAtHorizonUsd: "10000",
      survivalMinLiquidityFractionBps: 3000,
      survivalMinFdvUsd: 10_000,
      liquidityThresholdMet: true,
      fdvThresholdMet: true
    });
    expect(String(result?.details["observation"])).toContain("forward-only");
  });
});

describe("runOutcomePass", () => {
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

  function options(overrides: Partial<OutcomePassOptions> = {}): OutcomePassOptions {
    return { db, chainId: CHAIN_ID, ...overrides };
  }

  /** Seeds a pool whose first snapshot is safely older than every configured horizon. */
  async function seedDuePool(): Promise<{ firstAt: Date; atHorizon72: Date; now: Date }> {
    const now = new Date();
    const firstAt = new Date(now.getTime() - 80 * HOUR_MS);
    const atHorizon72 = new Date(firstAt.getTime() + 72 * HOUR_MS);
    await insertPoolSnapshots(db, [
      snapshotInsert(firstAt, { quoteLiquidityUsd: "100000", estimatedFdvUsd: "50000" }),
      snapshotInsert(new Date(firstAt.getTime() + 24 * HOUR_MS), {
        quoteLiquidityUsd: "30000",
        estimatedFdvUsd: "10000"
      }),
      snapshotInsert(atHorizon72, { quoteLiquidityUsd: "1000", estimatedFdvUsd: "500" })
    ]);
    return { firstAt, atHorizon72, now };
  }

  it("labels a pool SURVIVED at the 24h horizon and DIED at the 72h horizon in one pass", async () => {
    const { now } = await seedDuePool();
    const result = await runOutcomePass(
      options({ config: { horizons: [24, 72] }, now: () => now })
    );

    expect(result.labeled).toBe(2);
    expect(result.survived).toBe(1);
    expect(result.died).toBe(1);
    expect(result.poolErrors).toEqual([]);

    const rows = await getTokenOutcomes(db, CHAIN_ID, BASE);
    expect(rows).toHaveLength(2);
    const byHorizon = new Map(rows.map((row) => [row.horizonHours, row]));
    expect(byHorizon.get(24)?.outcome).toBe("SURVIVED");
    expect(byHorizon.get(72)?.outcome).toBe("DIED");
    expect(byHorizon.get(24)?.details).toMatchObject({ horizonHours: 24 });
    expect(byHorizon.get(24)?.firstObservedAt).toBeInstanceOf(Date);
  });

  it("skips a pool with too few snapshots without inserting an outcome", async () => {
    const now = new Date();
    const firstAt = new Date(now.getTime() - 80 * HOUR_MS);
    await insertPoolSnapshots(db, [
      snapshotInsert(firstAt, { quoteLiquidityUsd: "100000", estimatedFdvUsd: "50000" })
    ]);

    const result = await runOutcomePass(
      options({ config: { horizons: [24] }, now: () => now })
    );

    expect(result.labeled).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await getTokenOutcomes(db, CHAIN_ID, BASE)).toEqual([]);
  });

  it("never relabels an already-labeled (pool, horizon) pair on a second pass", async () => {
    await seedDuePool();
    const firstRun = await runOutcomePass(
      options({ config: { horizons: [24, 72] } })
    );
    expect(firstRun.labeled).toBe(2);

    const secondRun = await runOutcomePass(
      options({ config: { horizons: [24, 72] } })
    );
    expect(secondRun.labeled).toBe(0);
    expect(secondRun.poolsConsidered).toBe(0);

    const rows = await getTokenOutcomes(db, CHAIN_ID, BASE);
    expect(rows).toHaveLength(2);
  });

  it("stays idempotent even if insertTokenOutcome is called twice for the same key", async () => {
    const { firstAt } = await seedDuePool();
    await insertTokenOutcome(db, {
      chainId: CHAIN_ID,
      tokenAddress: BASE,
      poolAddress: POOL,
      horizonHours: 24,
      outcome: "SURVIVED",
      peakQuoteLiquidityUsd: "100000",
      quoteLiquidityAtHorizonUsd: "30000",
      estimatedFdvAtHorizonUsd: "10000",
      firstObservedAt: firstAt,
      details: { seeded: true }
    });

    await runOutcomePass(options({ config: { horizons: [24] } }));

    const rows = await getTokenOutcomes(db, CHAIN_ID, BASE);
    const at24h = rows.filter((row) => row.horizonHours === 24);
    expect(at24h).toHaveLength(1);
    expect(at24h[0]?.details).toEqual({ seeded: true });
  });

  it("skips pools without a resolved base token", async () => {
    const now = new Date();
    const firstAt = new Date(now.getTime() - 80 * HOUR_MS);
    await insertPools(db, [
      poolInsert({
        poolAddress: "0x9999999999999999999999999999999999999999",
        baseTokenAddress: null
      })
    ]);
    await insertPoolSnapshots(db, [
      snapshotInsert(firstAt, {
        poolAddress: "0x9999999999999999999999999999999999999999",
        quoteLiquidityUsd: "100000",
        estimatedFdvUsd: "50000"
      }),
      snapshotInsert(new Date(firstAt.getTime() + 24 * HOUR_MS), {
        poolAddress: "0x9999999999999999999999999999999999999999",
        quoteLiquidityUsd: "30000",
        estimatedFdvUsd: "10000"
      })
    ]);

    const result = await runOutcomePass(options({ config: { horizons: [24] } }));
    expect(result.skipped).toBe(1);
    expect(result.labeled).toBe(0);
  });

  it("stops between pools once the signal is aborted, persisting nothing already labeled", async () => {
    await seedDuePool();
    const controller = new AbortController();
    controller.abort();

    const result = await runOutcomePass(
      options({ config: { horizons: [24, 72] }, signal: controller.signal })
    );

    expect(result.stopped).toBe(true);
    expect(result.labeled).toBe(0);
    expect(await getTokenOutcomes(db, CHAIN_ID, BASE)).toEqual([]);
  });
});
