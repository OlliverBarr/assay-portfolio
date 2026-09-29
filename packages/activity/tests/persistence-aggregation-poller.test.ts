import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceActivityProcessedBlock,
  getActivityCursor,
  initializeActivityCursor,
  initializeCursor,
  insertPoolActivitySnapshots,
  insertPools,
  insertPoolSwapEvents,
  listPoolActivitySnapshots,
  listPoolSwapEvents,
  type Db,
  type PoolSwapEventInsert,
  type PoolSwapEventRow
} from "@assay/database";
import { createTestDatabase, type TestDatabaseHandle } from "@assay/database/testing";

import { buildActivitySnapshot, ActivityHaltError, runActivityPass } from "../src/index.js";
import {
  POOL,
  TEST_CHAIN_ID,
  TEST_CONFIG,
  TEST_RETRY,
  WETH,
  addr,
  makeV2SwapLog,
  poolFixture,
  poolRow,
  txHash,
  FakeLogSource
} from "./fixtures.js";

const BUYER_A = addr("21");
const BUYER_B = addr("22");
const SELLER = addr("23");

function swapInsert(overrides: Partial<PoolSwapEventInsert> = {}): PoolSwapEventInsert {
  return {
    chainId: TEST_CHAIN_ID,
    poolAddress: POOL,
    factoryKind: "uniswap-v2",
    blockNumber: 101n,
    transactionHash: txHash(101),
    logIndex: 0,
    sender: addr("11"),
    recipient: BUYER_A,
    token0AmountRaw: "-5",
    token1AmountRaw: "1000000000000000000",
    baseAmountRaw: "5",
    quoteAmountRaw: "1000000000000000000",
    side: "BUY",
    quoteTokenAddress: WETH.address,
    baseTokenAddress: addr("cc"),
    observedAt: new Date("2026-07-10T12:00:00.000Z"),
    ...overrides
  };
}

function eventRow(overrides: Partial<PoolSwapEventRow> = {}): PoolSwapEventRow {
  return {
    ...swapInsert(),
    ...overrides,
    id: overrides.id ?? 1n,
    observedAt: overrides.observedAt ?? new Date("2026-07-10T12:00:00.000Z")
  };
}

describe("activity persistence, aggregation, and cursor", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  it("inserts duplicate log delivery exactly once", async () => {
    const row = swapInsert();

    const first = await insertPoolSwapEvents(db, [row]);
    const second = await insertPoolSwapEvents(db, [row]);
    const stored = await listPoolSwapEvents(db, TEST_CHAIN_ID, POOL);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(stored).toHaveLength(1);
  });

  it("inserts duplicate rows in one batch exactly once", async () => {
    const row = swapInsert();

    const inserted = await insertPoolSwapEvents(db, [row, row]);
    const stored = await listPoolSwapEvents(db, TEST_CHAIN_ID, POOL);

    expect(inserted).toBe(1);
    expect(stored).toHaveLength(1);
  });

  it("preserves raw integer amounts exactly", async () => {
    const raw = "1234567890123456789012345678901234567890";
    await insertPoolSwapEvents(db, [swapInsert({ quoteAmountRaw: raw })]);

    const [stored] = await listPoolSwapEvents(db, TEST_CHAIN_ID, POOL);

    expect(stored?.quoteAmountRaw).toBe(raw);
    expect(stored?.token0AmountRaw).toBe("-5");
  });

  it("keeps activity snapshots append-only", async () => {
    const snapshot = buildActivitySnapshot(poolRow(), 120n, [], new Date("2026-07-10T12:00:00.000Z"));

    await insertPoolActivitySnapshots(db, [snapshot, { ...snapshot, blockNumber: 121n }]);
    const rows = await listPoolActivitySnapshots(db, TEST_CHAIN_ID, POOL);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.blockNumber)).toEqual([120n, 121n]);
  });

  it("initializes the activity cursor idempotently", async () => {
    await initializeActivityCursor(db, TEST_CHAIN_ID, 99n);
    await initializeActivityCursor(db, TEST_CHAIN_ID, 10n);

    const cursor = await getActivityCursor(db, TEST_CHAIN_ID);

    expect(cursor?.latestProcessedBlock).toBe(99n);
  });

  it("never moves the processed activity block backward", async () => {
    await initializeActivityCursor(db, TEST_CHAIN_ID, 99n);
    await advanceActivityProcessedBlock(db, TEST_CHAIN_ID, 150n);
    await advanceActivityProcessedBlock(db, TEST_CHAIN_ID, 120n);

    const cursor = await getActivityCursor(db, TEST_CHAIN_ID);

    expect(cursor?.latestProcessedBlock).toBe(150n);
  });

  it("counts unique buyers, excludes sellers, and sums exact quote volumes", () => {
    const capturedAt = new Date("2026-07-10T12:00:00.000Z");
    const events = [
      eventRow({ id: 1n, recipient: BUYER_A, side: "BUY", quoteAmountRaw: "100", observedAt: new Date("2026-07-10T11:55:00.000Z") }),
      eventRow({ id: 2n, recipient: BUYER_A, transactionHash: txHash(2), logIndex: 1, side: "BUY", quoteAmountRaw: "200", observedAt: new Date("2026-07-10T11:50:00.000Z") }),
      eventRow({ id: 3n, recipient: BUYER_B, transactionHash: txHash(3), logIndex: 2, side: "BUY", quoteAmountRaw: "300", observedAt: new Date("2026-07-10T11:30:00.000Z") }),
      eventRow({ id: 4n, sender: SELLER, transactionHash: txHash(4), logIndex: 3, side: "SELL", quoteAmountRaw: "40", observedAt: new Date("2026-07-10T11:58:00.000Z") }),
      eventRow({ id: 5n, transactionHash: txHash(5), logIndex: 4, side: "UNKNOWN", quoteAmountRaw: "999", observedAt: new Date("2026-07-10T11:59:00.000Z") }),
      eventRow({ id: 6n, recipient: addr("24"), transactionHash: txHash(6), logIndex: 5, side: "BUY", quoteAmountRaw: "700", observedAt: new Date("2026-07-10T10:59:59.000Z") })
    ];

    const snapshot = buildActivitySnapshot(poolRow(), 200n, events, capturedAt);

    expect(snapshot.uniqueBuyers20m).toBe(1);
    expect(snapshot.uniqueBuyers1h).toBe(2);
    expect(snapshot.buyCount20m).toBe(2);
    expect(snapshot.sellCount20m).toBe(1);
    expect(snapshot.quoteBuyVolumeRaw20m).toBe("300");
    expect(snapshot.quoteSellVolumeRaw20m).toBe("40");
    expect(snapshot.quoteBuyVolumeRaw1h).toBe("600");
    expect(snapshot.quoteSellVolumeRaw1h).toBe("40");
  });

  it("leaves cursor unmoved on partial failure and resumes at processed plus one", async () => {
    await initializeCursor(db, TEST_CHAIN_ID, 150n);
    await insertPools(db, [poolFixture()]);
    const source = new FakeLogSource([makeV2SwapLog({ blockNumber: 101n })], 150n);
    source.failWhen = (params) => params.fromBlock === 120n;

    await expect(
      runActivityPass({ db, logSource: source, config: TEST_CONFIG, chunkSize: 20n, retry: TEST_RETRY })
    ).rejects.toBeInstanceOf(ActivityHaltError);
    expect((await getActivityCursor(db, TEST_CHAIN_ID))?.latestProcessedBlock).toBe(119n);

    source.failWhen = null;
    const result = await runActivityPass({ db, logSource: source, config: TEST_CONFIG, chunkSize: 20n, retry: TEST_RETRY });

    expect(result.scannedFromBlock).toBe(120n);
    expect((await getActivityCursor(db, TEST_CHAIN_ID))?.latestProcessedBlock).toBe(150n);
  });

  it("rescans without gaps or duplicate swap events", async () => {
    await initializeCursor(db, TEST_CHAIN_ID, 140n);
    await insertPools(db, [poolFixture()]);
    const duplicate = makeV2SwapLog({ amount0Out: 1n, amount1In: 10n, blockNumber: 101n, tx: 1 });
    const source = new FakeLogSource([
      duplicate,
      duplicate,
      makeV2SwapLog({ amount0In: 2n, amount1Out: 20n, blockNumber: 130n, tx: 2 })
    ], 140n);

    const first = await runActivityPass({ db, logSource: source, config: TEST_CONFIG, chunkSize: 20n });
    const second = await runActivityPass({ db, logSource: source, config: TEST_CONFIG, chunkSize: 20n });
    const stored = await listPoolSwapEvents(db, TEST_CHAIN_ID, POOL);

    expect(first.swapEventsInserted).toBe(2);
    expect(second.scannedFromBlock).toBeNull();
    expect(stored).toHaveLength(2);
    expect(source.calls.map((call) => [call.fromBlock, call.toBlock])).toEqual([
      [100n, 119n],
      [120n, 139n],
      [140n, 140n]
    ]);
  });

  it("stops at a chunk boundary when aborted", async () => {
    await initializeCursor(db, TEST_CHAIN_ID, 140n);
    await insertPools(db, [poolFixture()]);
    const source = new FakeLogSource([makeV2SwapLog({ blockNumber: 101n })], 140n);
    const controller = new AbortController();
    const originalGetLogs = source.getLogs.bind(source);
    source.getLogs = (params) => {
      const result = originalGetLogs(params);
      controller.abort();
      return result;
    };

    const result = await runActivityPass({
      db,
      logSource: source,
      config: TEST_CONFIG,
      chunkSize: 20n,
      signal: controller.signal
    });

    expect(result.stopped).toBe(true);
    expect(result.scannedToBlock).toBe(119n);
    expect((await getActivityCursor(db, TEST_CHAIN_ID))?.latestProcessedBlock).toBe(119n);
  });
});

describe("active-scoped activity pass", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  const POOL_B = addr("de");

  /** Pool A is young (active); pool B predates the youth cutoff and has no
   * watch-band snapshot, so it is outside the active set. */
  function activeCriteria(now = new Date()) {
    return {
      now,
      activeMinCreatedBlock: 50n,
      watchMinFdvUsd: 40_000,
      watchMaxFdvUsd: 300_000
    };
  }

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    await initializeCursor(db, TEST_CHAIN_ID, 150n);
    await insertPools(db, [
      poolFixture({ createdAtBlock: 100n }),
      poolFixture({ poolAddress: POOL_B, createdAtBlock: 10n, createdTxHash: txHash(9) })
    ]);
  });

  afterEach(async () => {
    await handle.close();
  });

  it("scopes chunk selection to the active set and snapshots only swap-touched pools", async () => {
    const source = new FakeLogSource([makeV2SwapLog({ blockNumber: 141n })], 150n);
    await initializeActivityCursor(db, TEST_CHAIN_ID, 140n);

    const result = await runActivityPass({
      db,
      logSource: source,
      config: TEST_CONFIG,
      chunkSize: 20n,
      active: activeCriteria()
    });

    // Only the active pool reaches the log filter — chunk cost tracks the
    // active set, not the all-time pool population.
    expect(result.poolsSelected).toBe(1);
    expect(source.calls.every((call) => call.addresses.length === 1)).toBe(true);
    expect(result.swapEventsInserted).toBe(1);
    // Snapshots exist only for the swap-touched pool.
    expect(await listPoolActivitySnapshots(db, TEST_CHAIN_ID, POOL)).toHaveLength(1);
    expect(await listPoolActivitySnapshots(db, TEST_CHAIN_ID, POOL_B)).toHaveLength(0);
  });

  it("refresh lane decays stale rolling windows without moving the cursor", async () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    // Caught-up cursor: the pass has no range to scan.
    await initializeActivityCursor(db, TEST_CHAIN_ID, 150n);
    // Old swaps + an old snapshot claiming one 1h buyer.
    await insertPoolSwapEvents(db, [
      swapInsert({ observedAt: twoHoursAgo, blockNumber: 120n })
    ]);
    await insertPoolActivitySnapshots(db, [
      buildActivitySnapshot(
        poolRow({ createdAtBlock: 100n }),
        120n,
        await listPoolSwapEvents(db, TEST_CHAIN_ID, POOL),
        twoHoursAgo
      )
    ]);
    const stale = await listPoolActivitySnapshots(db, TEST_CHAIN_ID, POOL);
    expect(stale[0]?.uniqueBuyers1h).toBe(1);

    const source = new FakeLogSource([], 150n);
    const result = await runActivityPass({
      db,
      logSource: source,
      config: TEST_CONFIG,
      chunkSize: 20n,
      active: activeCriteria(now),
      snapshotRefreshMs: 15 * 60 * 1000
    });

    expect(result.poolsRefreshed).toBe(1);
    expect(result.scannedFromBlock).toBeNull();
    expect((await getActivityCursor(db, TEST_CHAIN_ID))?.latestProcessedBlock).toBe(150n);
    const snapshots = await listPoolActivitySnapshots(db, TEST_CHAIN_ID, POOL);
    expect(snapshots).toHaveLength(2);
    // The refreshed snapshot sees the 2h-old buys outside every window.
    expect(snapshots[1]?.uniqueBuyers1h).toBe(0);
    expect(snapshots[1]?.uniqueBuyers20m).toBe(0);
    // Inactive pool B is never refreshed.
    expect(await listPoolActivitySnapshots(db, TEST_CHAIN_ID, POOL_B)).toHaveLength(0);

    // A fresh snapshot is not re-refreshed on the next pass.
    const second = await runActivityPass({
      db,
      logSource: source,
      config: TEST_CONFIG,
      chunkSize: 20n,
      active: activeCriteria(new Date()),
      snapshotRefreshMs: 15 * 60 * 1000
    });
    expect(second.poolsRefreshed).toBe(0);
  });
});
