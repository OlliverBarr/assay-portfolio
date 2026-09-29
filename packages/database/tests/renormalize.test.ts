import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getPool,
  insertPools,
  renormalizeUntrustedPools,
  type Db,
  type PoolInsert
} from "../src/index.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

const CHAIN_ID = 4242;

const WETH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VIRTUAL = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RANDOM_A = "0xcccccccccccccccccccccccccccccccccccccccc";
const RANDOM_B = "0xdddddddddddddddddddddddddddddddddddddddd";

// Config order matters only among assets sharing a pool; VIRTUAL is last,
// matching the worker's allow-list (WETH preferred over VIRTUAL as quote).
const QUOTE_ASSETS = [{ address: WETH }, { address: VIRTUAL }];

let poolSeq = 0;

function poolFixture(overrides: Partial<PoolInsert> = {}): PoolInsert {
  poolSeq += 1;
  const suffix = poolSeq.toString(16).padStart(2, "0");
  return {
    chainId: CHAIN_ID,
    poolAddress: `0x${suffix.repeat(20)}`,
    factoryAddress: "0x2222222222222222222222222222222222222222",
    dex: "uniswap",
    factoryKind: "uniswap-v2",
    token0Address: RANDOM_A,
    token1Address: RANDOM_B,
    createdAtBlock: 105n,
    createdTxHash: `0x${suffix.repeat(32)}`,
    createdLogIndex: 0,
    ...overrides
  };
}

describe("renormalizeUntrustedPools", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  it("backfills a null-quote pool with the allow-listed asset on token0", async () => {
    const fixture = poolFixture({ token0Address: VIRTUAL, token1Address: RANDOM_B });
    await insertPools(db, [fixture]);

    const updated = await renormalizeUntrustedPools(db, CHAIN_ID, QUOTE_ASSETS);
    expect(updated).toBe(1);

    const row = await getPool(db, CHAIN_ID, fixture.poolAddress);
    expect(row?.quoteTokenAddress).toBe(VIRTUAL);
    expect(row?.baseTokenAddress).toBe(RANDOM_B);
  });

  it("backfills a null-quote pool with the allow-listed asset on token1", async () => {
    const fixture = poolFixture({ token0Address: RANDOM_A, token1Address: VIRTUAL });
    await insertPools(db, [fixture]);

    const updated = await renormalizeUntrustedPools(db, CHAIN_ID, QUOTE_ASSETS);
    expect(updated).toBe(1);

    const row = await getPool(db, CHAIN_ID, fixture.poolAddress);
    expect(row?.quoteTokenAddress).toBe(VIRTUAL);
    expect(row?.baseTokenAddress).toBe(RANDOM_A);
  });

  it("leaves already-normalized pools untouched", async () => {
    const fixture = poolFixture({
      token0Address: RANDOM_A,
      token1Address: WETH,
      quoteTokenAddress: WETH,
      baseTokenAddress: RANDOM_A
    });
    await insertPools(db, [fixture]);

    const updated = await renormalizeUntrustedPools(db, CHAIN_ID, QUOTE_ASSETS);
    expect(updated).toBe(0);

    const row = await getPool(db, CHAIN_ID, fixture.poolAddress);
    expect(row?.quoteTokenAddress).toBe(WETH);
    expect(row?.baseTokenAddress).toBe(RANDOM_A);
  });

  it("leaves null-quote pools with no allow-listed side untouched", async () => {
    const fixture = poolFixture({ token0Address: RANDOM_A, token1Address: RANDOM_B });
    await insertPools(db, [fixture]);

    const updated = await renormalizeUntrustedPools(db, CHAIN_ID, QUOTE_ASSETS);
    expect(updated).toBe(0);

    const row = await getPool(db, CHAIN_ID, fixture.poolAddress);
    expect(row?.quoteTokenAddress).toBeNull();
    expect(row?.baseTokenAddress).toBeNull();
  });

  it("is idempotent: a second run updates nothing once fully backfilled", async () => {
    const virtualOnToken0 = poolFixture({ token0Address: VIRTUAL, token1Address: RANDOM_B });
    const virtualOnToken1 = poolFixture({ token0Address: RANDOM_A, token1Address: VIRTUAL });
    const untrusted = poolFixture({ token0Address: RANDOM_A, token1Address: RANDOM_B });
    await insertPools(db, [virtualOnToken0, virtualOnToken1, untrusted]);

    const first = await renormalizeUntrustedPools(db, CHAIN_ID, QUOTE_ASSETS);
    expect(first).toBe(2);

    const second = await renormalizeUntrustedPools(db, CHAIN_ID, QUOTE_ASSETS);
    expect(second).toBe(0);
  });
});
