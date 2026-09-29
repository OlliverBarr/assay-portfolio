import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  chainCursor,
  getCursor,
  listPools,
  type Db
} from "@assay/database";
import { createTestDatabase } from "@assay/database/testing";
import type { RawFactoryLog } from "@assay/chain";

import { DiscoveryHaltError } from "../src/errors.js";
import { runDiscoveryPass } from "../src/poller.js";
import {
  FakeLogSource,
  TEST_CHAIN_ID,
  TEST_CONFIG,
  TEST_RETRY,
  USDC,
  WETH,
  addr,
  makeV2Log,
  makeV3Log
} from "./fixtures.js";

interface TestDb {
  db: Db;
  close(): Promise<void>;
}

/** Three pools spread across the 100-159 range, one per 20-block chunk. */
function fixtureLogs(): RawFactoryLog[] {
  return [
    makeV2Log({
      token0: WETH.address,
      token1: addr("c1"),
      pair: addr("d1"),
      blockNumber: 105n
    }),
    makeV3Log({
      token0: addr("c2"),
      token1: USDC.address,
      pool: addr("d2"),
      fee: 3000,
      blockNumber: 125n
    }),
    makeV2Log({
      token0: addr("c3"),
      token1: addr("c4"),
      pair: addr("d3"),
      blockNumber: 145n
    })
  ];
}

describe("runDiscoveryPass", () => {
  let handle: TestDb;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  const passOptions = (source: FakeLogSource) => ({
    db,
    logSource: source,
    config: TEST_CONFIG,
    chunkSize: 20n,
    retry: TEST_RETRY
  });

  it("ingests every pool-creation event from deployment to head", async () => {
    const source = new FakeLogSource(fixtureLogs(), 159n);

    const result = await runDiscoveryPass(passOptions(source));

    expect(result.poolsInserted).toBe(3);
    expect(result.scannedFromBlock).toBe(100n);
    expect(result.scannedToBlock).toBe(159n);

    const cursor = await getCursor(db, TEST_CHAIN_ID);
    expect(cursor?.latestProcessedBlock).toBe(159n);
    expect(cursor?.latestObservedBlock).toBe(159n);

    const pools = await listPools(db, TEST_CHAIN_ID);
    expect(pools.map((pool) => pool.poolAddress)).toEqual([
      addr("d1"),
      addr("d2"),
      addr("d3")
    ]);
    // Quote-side normalization is persisted with the pool.
    expect(pools[0]?.quoteTokenAddress).toBe(WETH.address);
    expect(pools[0]?.baseTokenAddress).toBe(addr("c1"));
    expect(pools[1]?.quoteTokenAddress).toBe(USDC.address);
    expect(pools[1]?.feePpm).toBe(3000);
    // Untrusted pair is stored for completeness but carries no trusted side.
    expect(pools[2]?.quoteTokenAddress).toBeNull();
  });

  it("does nothing when there are no new blocks", async () => {
    const source = new FakeLogSource(fixtureLogs(), 159n);
    await runDiscoveryPass(passOptions(source));

    const secondSource = new FakeLogSource(fixtureLogs(), 159n);
    const result = await runDiscoveryPass(passOptions(secondSource));

    expect(result.poolsInserted).toBe(0);
    expect(result.scannedFromBlock).toBeNull();
    expect(secondSource.calls).toHaveLength(0);
  });

  it("lags the head by the configured confirmations", async () => {
    const source = new FakeLogSource(fixtureLogs(), 150n);
    await runDiscoveryPass({ ...passOptions(source), confirmations: 10n });

    const cursor = await getCursor(db, TEST_CHAIN_ID);
    expect(cursor?.latestProcessedBlock).toBe(140n);
    expect(cursor?.latestObservedBlock).toBe(150n);
  });

  it("inserts duplicated log deliveries exactly once", async () => {
    const logs = fixtureLogs();
    const duplicated = [...logs, ...logs.map((log) => ({ ...log }))];
    const source = new FakeLogSource(duplicated, 159n);

    const result = await runDiscoveryPass(passOptions(source));

    expect(result.logsSeen).toBe(6);
    expect(result.poolsInserted).toBe(3);
    expect(await listPools(db, TEST_CHAIN_ID)).toHaveLength(3);
  });

  it("re-scanning an already processed range creates no duplicates", async () => {
    const source = new FakeLogSource(fixtureLogs(), 159n);
    await runDiscoveryPass(passOptions(source));

    // Simulate an operator rewinding the cursor (e.g. after a bug fix).
    await db
      .update(chainCursor)
      .set({ latestProcessedBlock: 99n })
      .where(eq(chainCursor.chainId, TEST_CHAIN_ID));

    const result = await runDiscoveryPass(passOptions(source));
    expect(result.logsSeen).toBe(3);
    expect(result.poolsInserted).toBe(0);
    expect(await listPools(db, TEST_CHAIN_ID)).toHaveLength(3);
  });

  it("recovers from a transient RPC failure within one pass", async () => {
    const source = new FakeLogSource(fixtureLogs(), 159n);
    source.transientFailuresRemaining = 2; // < TEST_RETRY.attempts

    const result = await runDiscoveryPass(passOptions(source));

    expect(result.poolsInserted).toBe(3);
    const cursor = await getCursor(db, TEST_CHAIN_ID);
    expect(cursor?.latestProcessedBlock).toBe(159n);
  });

  it("halts loudly on persistent failure without advancing the cursor", async () => {
    const source = new FakeLogSource(fixtureLogs(), 159n);
    source.failWhen = (params) => params.fromBlock >= 120n;

    await expect(runDiscoveryPass(passOptions(source))).rejects.toBeInstanceOf(
      DiscoveryHaltError
    );

    // First chunk (100-119) committed; nothing after the failed range did.
    const cursor = await getCursor(db, TEST_CHAIN_ID);
    expect(cursor?.latestProcessedBlock).toBe(119n);
    const pools = await listPools(db, TEST_CHAIN_ID);
    expect(pools.map((pool) => pool.poolAddress)).toEqual([addr("d1")]);
  });

  it("resumes after a mid-range crash with no gaps and no duplicates", async () => {
    // Acceptance test from docs/current-status.md: ingest, die halfway,
    // restart, resume gap-free, produce no duplicate pools.
    const crashing = new FakeLogSource(fixtureLogs(), 159n);
    crashing.failWhen = (params) => params.fromBlock >= 120n;
    await expect(
      runDiscoveryPass(passOptions(crashing))
    ).rejects.toBeInstanceOf(DiscoveryHaltError);

    // "Restart": a fresh worker with a healthy source and the same database.
    const healthy = new FakeLogSource(fixtureLogs(), 159n);
    const result = await runDiscoveryPass(passOptions(healthy));

    // Resumed exactly where the crash left off — no gap, no re-scan.
    expect(healthy.calls[0]?.fromBlock).toBe(120n);
    expect(result.scannedFromBlock).toBe(120n);
    expect(result.scannedToBlock).toBe(159n);
    expect(result.poolsInserted).toBe(2);

    const cursor = await getCursor(db, TEST_CHAIN_ID);
    expect(cursor?.latestProcessedBlock).toBe(159n);
    const pools = await listPools(db, TEST_CHAIN_ID);
    expect(pools.map((pool) => pool.poolAddress)).toEqual([
      addr("d1"),
      addr("d2"),
      addr("d3")
    ]);
  });

  it("stops at a chunk boundary when aborted, keeping committed work", async () => {
    const source = new FakeLogSource(fixtureLogs(), 159n);
    const controller = new AbortController();
    const original = source.getLogs.bind(source);
    // Abort while the first chunk is in flight: the chunk must still commit,
    // and the pass must stop before fetching the second chunk.
    source.getLogs = (params) => {
      controller.abort();
      return original(params);
    };

    const result = await runDiscoveryPass({
      ...passOptions(source),
      signal: controller.signal
    });

    expect(result.stopped).toBe(true);
    expect(result.chunksProcessed).toBe(1);
    expect(result.scannedToBlock).toBe(119n);
    expect(source.calls).toHaveLength(1);
    const cursor = await getCursor(db, TEST_CHAIN_ID);
    expect(cursor?.latestProcessedBlock).toBe(119n);
    expect(await listPools(db, TEST_CHAIN_ID)).toHaveLength(1);
  });

  it("returns an empty result when no factories are configured", async () => {
    const source = new FakeLogSource([], 159n);
    const result = await runDiscoveryPass({
      ...passOptions(source),
      config: { ...TEST_CONFIG, factories: [] }
    });
    expect(result.poolsInserted).toBe(0);
    expect(result.scannedFromBlock).toBeNull();
    expect(await getCursor(db, TEST_CHAIN_ID)).toBeUndefined();
  });
});
