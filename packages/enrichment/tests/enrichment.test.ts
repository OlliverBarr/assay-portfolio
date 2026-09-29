import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress, stringToHex, type Address } from "viem";

import {
  insertPools,
  insertPoolSnapshots,
  insertTokens,
  listPoolSnapshots,
  type Db,
  type PoolInsert,
  type TokenInsert
} from "@assay/database";
import { createTestDatabase, type TestDatabaseHandle } from "@assay/database/testing";
import { RetryExhaustedError } from "@assay/chain";
import type { ChainConfig, QuoteAssetConfig } from "@assay/chain";

import {
  EnrichmentHaltError,
  WAD,
  createPoolStateReader,
  estimatedFdvUsdWad,
  fetchTokenMetadata,
  formatWad,
  resolveUsdAnchor,
  runEnrichmentPass,
  usdValueWad,
  v2PriceWad,
  v3PriceWad,
  type ChainReader
} from "../src/index.js";

const CHAIN_ID = 4663;
const Q96 = 2n ** 96n;

function addr(byte: string): Address {
  return getAddress(`0x${byte.repeat(20)}`);
}

const WETH: QuoteAssetConfig = { address: addr("aa"), symbol: "WETH", decimals: 18 };
const USDG: QuoteAssetConfig = { address: addr("bb"), symbol: "USDG", decimals: 6 };
const BASE = addr("11");
const ANCHOR_POOL = addr("a1");
const BASE_POOL = addr("b1");

const CONFIG: ChainConfig = {
  chainId: CHAIN_ID,
  rpcUrls: ["http://127.0.0.1:8545"],
  factories: [],
  quoteAssets: [WETH, USDG]
};

class FakeReader implements ChainReader {
  blockNumber = 1_000n;
  /** When set, getBlockNumber rejects as if bounded retries were exhausted. */
  blockNumberInfraFails = false;
  readonly queues = new Map<string, unknown[]>();
  readonly reserves = new Map<string, readonly [bigint, bigint, number]>();
  readonly slot0 = new Map<string, readonly [bigint, number, number, number, number, number, boolean]>();
  readonly balances = new Map<string, bigint>();

  queue(address: Address, functionName: string, values: unknown[]): void {
    this.queues.set(`${address}:${functionName}`, [...values]);
  }

  setBalance(token: Address, holder: Address, value: bigint): void {
    this.balances.set(`${token}:${holder}`, value);
  }

  getBlockNumber(): Promise<bigint> {
    if (this.blockNumberInfraFails) {
      return Promise.reject(
        new RetryExhaustedError("getBlockNumber", 4, new Error("rpc down"))
      );
    }
    return Promise.resolve(this.blockNumber);
  }

  readContract(args: {
    address: Address;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown> {
    if (args.functionName === "getReserves") {
      const value = this.reserves.get(args.address);
      if (value === undefined) throw new Error(`missing reserves ${args.address}`);
      return Promise.resolve(value);
    }
    if (args.functionName === "slot0") {
      const value = this.slot0.get(args.address);
      if (value === undefined) throw new Error(`missing slot0 ${args.address}`);
      return Promise.resolve(value);
    }
    if (args.functionName === "balanceOf") {
      const holder = args.args?.[0] as Address | undefined;
      if (holder === undefined) throw new Error("missing balance holder");
      return Promise.resolve(this.balances.get(`${args.address}:${holder}`) ?? 0n);
    }
    const key = `${args.address}:${args.functionName}`;
    const queue = this.queues.get(key);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`missing read ${key}`);
    }
    const value = queue.shift();
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value);
  }
}

function pool(overrides: Partial<PoolInsert>): PoolInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress: BASE_POOL,
    factoryAddress: addr("f2"),
    dex: "uniswap",
    factoryKind: "uniswap-v2",
    token0Address: BASE,
    token1Address: WETH.address,
    quoteTokenAddress: WETH.address,
    baseTokenAddress: BASE,
    createdAtBlock: 100n,
    createdTxHash: `0x${"cd".repeat(32)}`,
    createdLogIndex: 0,
    ...overrides
  };
}

function token(overrides: Partial<TokenInsert> = {}): TokenInsert {
  return {
    chainId: CHAIN_ID,
    address: BASE,
    firstSeenBlock: 100n,
    name: "Base",
    symbol: "BASE",
    decimals: 18,
    totalSupply: (1_000_000n * 10n ** 18n).toString(),
    metadataStatus: "PASS",
    metadataBlock: 999n,
    ...overrides
  };
}

describe("fixed-point and price math", () => {
  it("formats WAD values exactly", () => {
    expect(formatWad(2500n * WAD)).toBe("2500");
    expect(formatWad(WAD / 4n)).toBe("0.25");
    expect(formatWad(-15n * (WAD / 10n))).toBe("-1.5");
  });

  it("calculates V2 prices across token decimals", () => {
    expect(
      v2PriceWad({
        reserveBase: 2n * 10n ** 18n,
        reserveQuote: 5n * 10n ** 6n,
        baseDecimals: 18,
        quoteDecimals: 6
      })
    ).toBe(25n * 10n ** 17n);
    expect(
      v2PriceWad({
        reserveBase: 0n,
        reserveQuote: 5n * 10n ** 6n,
        baseDecimals: 18,
        quoteDecimals: 6
      })
    ).toBeNull();
  });

  it("calculates V3 prices from sqrtPriceX96 and decimal adjustment", () => {
    expect(
      v3PriceWad({
        sqrtPriceX96: Q96,
        baseIsToken0: true,
        token0Decimals: 18,
        token1Decimals: 18
      })
    ).toBe(WAD);
    expect(
      v3PriceWad({
        sqrtPriceX96: Q96,
        baseIsToken0: true,
        token0Decimals: 18,
        token1Decimals: 6
      })
    ).toBe(10n ** 30n);
    expect(
      v3PriceWad({
        sqrtPriceX96: 0n,
        baseIsToken0: true,
        token0Decimals: 18,
        token1Decimals: 6
      })
    ).toBeNull();
  });

  it("calculates FDV and guards overflow", () => {
    expect(
      estimatedFdvUsdWad(25n * 10n ** 17n, 1_000_000n * 10n ** 6n, 6)
    ).toBe(2_500_000n * WAD);
    expect(usdValueWad(10n ** 54n, 18, WAD)).toBeNull();
  });
});

describe("fetchTokenMetadata", () => {
  it("passes with normal string metadata", async () => {
    const reader = new FakeReader();
    reader.queue(BASE, "name", ["Base Token"]);
    reader.queue(BASE, "symbol", ["BASE"]);
    reader.queue(BASE, "decimals", [18]);
    reader.queue(BASE, "totalSupply", [1_000n]);

    await expect(fetchTokenMetadata(reader, BASE)).resolves.toEqual({
      status: "PASS",
      name: "Base Token",
      symbol: "BASE",
      decimals: 18,
      totalSupply: 1_000n
    });
  });

  it("falls back to bytes32 strings and treats missing cosmetic fields as nonfatal", async () => {
    const reader = new FakeReader();
    reader.queue(BASE, "name", [new Error("string revert"), stringToHex("BytesName", { size: 32 })]);
    reader.queue(BASE, "symbol", [new Error("symbol revert"), new Error("bytes32 revert")]);
    reader.queue(BASE, "decimals", [6n]);
    reader.queue(BASE, "totalSupply", [1_000n]);

    await expect(fetchTokenMetadata(reader, BASE)).resolves.toMatchObject({
      status: "PASS",
      name: "BytesName",
      symbol: null,
      decimals: 6,
      totalSupply: 1_000n
    });
  });

  it("returns ERROR for missing required metadata or absurd decimals", async () => {
    const missing = new FakeReader();
    missing.queue(BASE, "name", ["Base"]);
    missing.queue(BASE, "symbol", ["BASE"]);
    missing.queue(BASE, "decimals", [new Error("decimals revert")]);
    missing.queue(BASE, "totalSupply", [1_000n]);
    await expect(fetchTokenMetadata(missing, BASE)).resolves.toMatchObject({
      status: "ERROR",
      decimals: null,
      totalSupply: 1_000n
    });

    const absurd = new FakeReader();
    absurd.queue(BASE, "name", ["Base"]);
    absurd.queue(BASE, "symbol", ["BASE"]);
    absurd.queue(BASE, "decimals", [45]);
    absurd.queue(BASE, "totalSupply", [1_000n]);
    await expect(fetchTokenMetadata(absurd, BASE)).resolves.toMatchObject({
      status: "ERROR",
      decimals: null
    });
  });
});

describe("runEnrichmentPass", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  async function seedBasePool(reader: FakeReader): Promise<void> {
    await insertTokens(db, [
      token(),
      token({
        address: WETH.address,
        name: "Wrapped Ether",
        symbol: "WETH",
        decimals: 18,
        totalSupply: (1_000_000n * 10n ** 18n).toString()
      })
    ]);
    await insertPools(db, [
      pool({
        poolAddress: ANCHOR_POOL,
        token0Address: WETH.address,
        token1Address: USDG.address,
        quoteTokenAddress: USDG.address,
        baseTokenAddress: WETH.address,
        createdLogIndex: 0
      }),
      pool({ poolAddress: BASE_POOL, createdLogIndex: 1 })
    ]);
    reader.reserves.set(ANCHOR_POOL, [10n * 10n ** 18n, 20_000n * 10n ** 6n, 0]);
    reader.reserves.set(BASE_POOL, [1_000n * 10n ** 18n, 5n * 10n ** 18n, 0]);
    reader.setBalance(USDG.address, ANCHOR_POOL, 20_000n * 10n ** 6n);
    reader.setBalance(WETH.address, BASE_POOL, 5n * 10n ** 18n);
    reader.setBalance(BASE, BASE_POOL, 1_000n * 10n ** 18n);
  }

  it("snapshots WETH-quoted pools through the deepest WETH/USDG anchor", async () => {
    const reader = new FakeReader();
    await seedBasePool(reader);

    const result = await runEnrichmentPass({ db, reader, config: CONFIG });
    expect(result).toMatchObject({
      poolsSelected: 2,
      activePools: 0,
      idlePools: 0,
      snapshotsInserted: 2,
      metadataRefreshed: 0,
      poolErrors: []
    });

    const rows = await listPoolSnapshots(db, CHAIN_ID, BASE_POOL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      priceUsd: "10.000000000000000000",
      estimatedFdvUsd: "10000000.000000000000000000",
      quoteLiquidityUsd: "10000.000000000000000000",
      totalLiquidityUsd: "20000.000000000000000000",
      anchorPoolAddress: ANCHOR_POOL,
      nullReason: null
    });
  });

  it("appends snapshots instead of updating history", async () => {
    const reader = new FakeReader();
    await seedBasePool(reader);
    await runEnrichmentPass({ db, reader, config: CONFIG });
    await runEnrichmentPass({ db, reader, config: CONFIG });
    expect(await listPoolSnapshots(db, CHAIN_ID, BASE_POOL)).toHaveLength(2);
  });

  it("halts with EnrichmentHaltError when the head-block read is exhausted", async () => {
    const reader = new FakeReader();
    await seedBasePool(reader);
    reader.blockNumberInfraFails = true;

    await expect(
      runEnrichmentPass({ db, reader, config: CONFIG })
    ).rejects.toBeInstanceOf(EnrichmentHaltError);

    // Nothing was written: the pass halted before touching any pool.
    expect(await listPoolSnapshots(db, CHAIN_ID, BASE_POOL)).toHaveLength(0);
  });

  it("records null snapshots for missing anchors, zero liquidity, and metadata errors", async () => {
    const reader = new FakeReader();
    await insertTokens(db, [token({ metadataStatus: "ERROR", decimals: null, totalSupply: null })]);
    await insertPools(db, [pool({})]);

    let result = await runEnrichmentPass({ db, reader, config: CONFIG });
    expect(result.snapshotsInserted).toBe(1);
    expect((await listPoolSnapshots(db, CHAIN_ID, BASE_POOL))[0]?.nullReason).toBe("metadata-error");

    await handle.close();
    handle = await createTestDatabase();
    db = handle.db;
    await insertTokens(db, [token()]);
    await insertPools(db, [pool({})]);
    result = await runEnrichmentPass({ db, reader, config: CONFIG });
    expect(result.snapshotsInserted).toBe(1);
    expect((await listPoolSnapshots(db, CHAIN_ID, BASE_POOL))[0]?.nullReason).toBe("no-usd-anchor");

    await handle.close();
    handle = await createTestDatabase();
    db = handle.db;
    await seedBasePool(reader);
    reader.reserves.set(BASE_POOL, [0n, 0n, 0]);
    result = await runEnrichmentPass({ db, reader, config: CONFIG });
    expect(result.snapshotsInserted).toBe(2);
    expect((await listPoolSnapshots(db, CHAIN_ID, BASE_POOL))[0]?.nullReason).toBe("zero-liquidity");
  });

  it("continues after one pool fails and stops between pools on abort", async () => {
    const reader = new FakeReader();
    await seedBasePool(reader);
    await insertPools(db, [
      pool({
        poolAddress: addr("b2"),
        createdLogIndex: 2,
        token0Address: addr("12"),
        baseTokenAddress: addr("12")
      })
    ]);
    await insertTokens(db, [token({ address: addr("12") })]);
    reader.setBalance(WETH.address, addr("b2"), 1n);
    reader.setBalance(addr("12"), addr("b2"), 1n);

    const result = await runEnrichmentPass({ db, reader, config: CONFIG, concurrency: 1 });
    expect(result.poolErrors).toHaveLength(1);
    expect(result.snapshotsInserted).toBe(2);

    const controller = new AbortController();
    controller.abort();
    const stopped = await runEnrichmentPass({
      db,
      reader,
      config: CONFIG,
      signal: controller.signal
    });
    expect(stopped.stopped).toBe(true);
    expect(stopped.snapshotsInserted).toBe(0);
  });
});

describe("VIRTUAL anchoring", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  const VIRTUAL: QuoteAssetConfig = { address: addr("ee"), symbol: "VIRTUAL", decimals: 18 };
  const CONFIG_WITH_VIRTUAL: ChainConfig = {
    ...CONFIG,
    quoteAssets: [WETH, USDG, VIRTUAL]
  };
  const WETH_USDG_ANCHOR_POOL = addr("e0");

  /** Seeds the base WETH/USD anchor (deepest WETH/USDG pool -> wethUsdWad = 2000). */
  async function seedWethAnchor(reader: FakeReader): Promise<void> {
    await insertTokens(db, [
      token({
        address: WETH.address,
        name: "Wrapped Ether",
        symbol: "WETH",
        decimals: 18,
        totalSupply: (1_000_000n * 10n ** 18n).toString()
      })
    ]);
    await insertPools(db, [
      pool({
        poolAddress: WETH_USDG_ANCHOR_POOL,
        token0Address: WETH.address,
        token1Address: USDG.address,
        quoteTokenAddress: USDG.address,
        baseTokenAddress: WETH.address,
        createdLogIndex: 0
      })
    ]);
    reader.reserves.set(WETH_USDG_ANCHOR_POOL, [10n * 10n ** 18n, 20_000n * 10n ** 6n, 0]);
    reader.setBalance(USDG.address, WETH_USDG_ANCHOR_POOL, 20_000n * 10n ** 6n);
  }

  it("prices a VIRTUAL-quoted pool through the WETH-paired anchor when it is deeper", async () => {
    const reader = new FakeReader();
    await seedWethAnchor(reader);

    const virtualWethPool = addr("e1");
    const virtualUsdgPool = addr("e2");
    await insertPools(db, [
      pool({
        poolAddress: virtualWethPool,
        token0Address: VIRTUAL.address,
        token1Address: WETH.address,
        quoteTokenAddress: WETH.address,
        baseTokenAddress: VIRTUAL.address,
        createdLogIndex: 1
      }),
      pool({
        poolAddress: virtualUsdgPool,
        token0Address: VIRTUAL.address,
        token1Address: USDG.address,
        quoteTokenAddress: USDG.address,
        baseTokenAddress: VIRTUAL.address,
        createdLogIndex: 2
      })
    ]);
    // WETH-side depth: 100 WETH x $2000 = $200,000.
    reader.reserves.set(virtualWethPool, [500_000n * 10n ** 18n, 100n * 10n ** 18n, 0]);
    reader.setBalance(WETH.address, virtualWethPool, 100n * 10n ** 18n);
    // USDG-side depth: $60,000 — above the floor, but shallower than the WETH side.
    reader.reserves.set(virtualUsdgPool, [100_000n * 10n ** 18n, 60_000n * 10n ** 6n, 0]);
    reader.setBalance(USDG.address, virtualUsdgPool, 60_000n * 10n ** 6n);

    const meme = addr("e5");
    const memeVirtualPool = addr("e3");
    await insertTokens(db, [token({ address: meme, name: "Meme", symbol: "MEME" })]);
    await insertPools(db, [
      pool({
        poolAddress: memeVirtualPool,
        token0Address: meme,
        token1Address: VIRTUAL.address,
        quoteTokenAddress: VIRTUAL.address,
        baseTokenAddress: meme,
        createdLogIndex: 3
      })
    ]);
    reader.reserves.set(memeVirtualPool, [1_000n * 10n ** 18n, 50n * 10n ** 18n, 0]);
    reader.setBalance(VIRTUAL.address, memeVirtualPool, 50n * 10n ** 18n);
    reader.setBalance(meme, memeVirtualPool, 1_000n * 10n ** 18n);

    const result = await runEnrichmentPass({ db, reader, config: CONFIG_WITH_VIRTUAL });
    expect(result.poolErrors).toEqual([]);

    const rows = await listPoolSnapshots(db, CHAIN_ID, memeVirtualPool);
    expect(rows[0]).toMatchObject({
      // VIRTUAL/WETH price 0.0002 x wethUsdWad 2000 = $0.4/VIRTUAL; MEME price
      // 0.05 VIRTUAL x $0.4 = $0.02.
      priceUsd: "0.020000000000000000",
      estimatedFdvUsd: "20000.000000000000000000",
      quoteLiquidityUsd: "20.000000000000000000",
      totalLiquidityUsd: "40.000000000000000000",
      anchorPoolAddress: virtualWethPool,
      nullReason: null
    });
  });

  it("prices a VIRTUAL-quoted pool through the USDG-paired anchor when it is deeper", async () => {
    const reader = new FakeReader();
    await seedWethAnchor(reader);

    const virtualWethPool = addr("e1");
    const virtualUsdgPool = addr("e2");
    await insertPools(db, [
      pool({
        poolAddress: virtualWethPool,
        token0Address: VIRTUAL.address,
        token1Address: WETH.address,
        quoteTokenAddress: WETH.address,
        baseTokenAddress: VIRTUAL.address,
        createdLogIndex: 1
      }),
      pool({
        poolAddress: virtualUsdgPool,
        token0Address: VIRTUAL.address,
        token1Address: USDG.address,
        quoteTokenAddress: USDG.address,
        baseTokenAddress: VIRTUAL.address,
        createdLogIndex: 2
      })
    ]);
    // WETH-side depth: 10 WETH x $2000 = $20,000 — above the floor, but shallower.
    reader.reserves.set(virtualWethPool, [50_000n * 10n ** 18n, 10n * 10n ** 18n, 0]);
    reader.setBalance(WETH.address, virtualWethPool, 10n * 10n ** 18n);
    // USDG-side depth: $300,000 — the deepest anchor.
    reader.reserves.set(virtualUsdgPool, [400_000n * 10n ** 18n, 300_000n * 10n ** 6n, 0]);
    reader.setBalance(USDG.address, virtualUsdgPool, 300_000n * 10n ** 6n);

    const base2 = addr("e6");
    const base2VirtualPool = addr("e4");
    await insertTokens(db, [token({ address: base2, name: "Base2", symbol: "BASE2" })]);
    await insertPools(db, [
      pool({
        poolAddress: base2VirtualPool,
        token0Address: base2,
        token1Address: VIRTUAL.address,
        quoteTokenAddress: VIRTUAL.address,
        baseTokenAddress: base2,
        createdLogIndex: 3
      })
    ]);
    reader.reserves.set(base2VirtualPool, [2_000n * 10n ** 18n, 80n * 10n ** 18n, 0]);
    reader.setBalance(VIRTUAL.address, base2VirtualPool, 80n * 10n ** 18n);
    reader.setBalance(base2, base2VirtualPool, 2_000n * 10n ** 18n);

    const result = await runEnrichmentPass({ db, reader, config: CONFIG_WITH_VIRTUAL });
    expect(result.poolErrors).toEqual([]);

    const rows = await listPoolSnapshots(db, CHAIN_ID, base2VirtualPool);
    expect(rows[0]).toMatchObject({
      // VIRTUAL/USDG price 0.75 (USDG = $1 directly); BASE2 price 0.04 VIRTUAL x $0.75 = $0.03.
      priceUsd: "0.030000000000000000",
      estimatedFdvUsd: "30000.000000000000000000",
      quoteLiquidityUsd: "60.000000000000000000",
      totalLiquidityUsd: "120.000000000000000000",
      anchorPoolAddress: virtualUsdgPool,
      nullReason: null
    });
  });

  it("resolves VIRTUAL/USD to null when every anchor pool is below the depth floor, while WETH/USDG pools still price", async () => {
    const reader = new FakeReader();
    await seedWethAnchor(reader);

    const virtualWethPool = addr("e1");
    const virtualUsdgPool = addr("e2");
    await insertPools(db, [
      pool({
        poolAddress: virtualWethPool,
        token0Address: VIRTUAL.address,
        token1Address: WETH.address,
        quoteTokenAddress: WETH.address,
        baseTokenAddress: VIRTUAL.address,
        createdLogIndex: 1
      }),
      pool({
        poolAddress: virtualUsdgPool,
        token0Address: VIRTUAL.address,
        token1Address: USDG.address,
        quoteTokenAddress: USDG.address,
        baseTokenAddress: VIRTUAL.address,
        createdLogIndex: 2
      })
    ]);
    // Both sides drained: $2,000 and $1,000 depth, well under the $50k floor.
    reader.reserves.set(virtualWethPool, [1_000_000n * 10n ** 18n, 1n * 10n ** 18n, 0]);
    reader.setBalance(WETH.address, virtualWethPool, 1n * 10n ** 18n);
    reader.reserves.set(virtualUsdgPool, [1_000_000n * 10n ** 18n, 1_000n * 10n ** 6n, 0]);
    reader.setBalance(USDG.address, virtualUsdgPool, 1_000n * 10n ** 6n);

    const meme = addr("e5");
    const memeVirtualPool = addr("e3");
    await insertTokens(db, [token({ address: meme, name: "Meme", symbol: "MEME" })]);
    await insertPools(db, [
      pool({
        poolAddress: memeVirtualPool,
        token0Address: meme,
        token1Address: VIRTUAL.address,
        quoteTokenAddress: VIRTUAL.address,
        baseTokenAddress: meme,
        createdLogIndex: 3
      })
    ]);

    // A normal WETH-quoted pool in the same pass: the VIRTUAL breaker
    // tripping must never affect the unrelated WETH/USDG anchor chain.
    const wethQuotedBase = addr("e8");
    const wethQuotedPool = addr("e7");
    await insertTokens(db, [token({ address: wethQuotedBase, name: "Other", symbol: "OTH" })]);
    await insertPools(db, [
      pool({
        poolAddress: wethQuotedPool,
        token0Address: wethQuotedBase,
        token1Address: WETH.address,
        quoteTokenAddress: WETH.address,
        baseTokenAddress: wethQuotedBase,
        createdLogIndex: 4
      })
    ]);
    reader.reserves.set(wethQuotedPool, [1_000n * 10n ** 18n, 5n * 10n ** 18n, 0]);
    reader.setBalance(WETH.address, wethQuotedPool, 5n * 10n ** 18n);
    reader.setBalance(wethQuotedBase, wethQuotedPool, 1_000n * 10n ** 18n);

    const result = await runEnrichmentPass({ db, reader, config: CONFIG_WITH_VIRTUAL });
    expect(result.poolErrors).toEqual([]);
    expect(result.anchorPoolAddress).toBe(WETH_USDG_ANCHOR_POOL);

    const virtualRows = await listPoolSnapshots(db, CHAIN_ID, memeVirtualPool);
    expect(virtualRows[0]).toMatchObject({ priceUsd: null, nullReason: "no-usd-anchor" });

    const wethRows = await listPoolSnapshots(db, CHAIN_ID, wethQuotedPool);
    expect(wethRows[0]).toMatchObject({
      priceUsd: "10.000000000000000000",
      nullReason: null
    });
  });

  it("leaves VIRTUAL-quoted pools and the WETH/USD anchor unaffected when VIRTUAL is not configured", async () => {
    const reader = new FakeReader();
    await seedWethAnchor(reader);

    const meme = addr("e5");
    const memeVirtualPool = addr("e3");
    await insertTokens(db, [token({ address: meme, name: "Meme", symbol: "MEME" })]);
    await insertPools(db, [
      pool({
        poolAddress: memeVirtualPool,
        token0Address: meme,
        token1Address: VIRTUAL.address,
        quoteTokenAddress: VIRTUAL.address,
        baseTokenAddress: meme,
        createdLogIndex: 1
      })
    ]);

    // CONFIG has no VIRTUAL entry — behavior must match a plain unrecognized quote token.
    const result = await runEnrichmentPass({ db, reader, config: CONFIG });
    expect(result.poolErrors).toEqual([]);
    expect(result.anchorPoolAddress).toBe(WETH_USDG_ANCHOR_POOL);

    const rows = await listPoolSnapshots(db, CHAIN_ID, memeVirtualPool);
    expect(rows[0]).toMatchObject({ priceUsd: null, nullReason: "no-trusted-quote" });

    const anchor = await resolveUsdAnchor(db, createPoolStateReader(reader), CONFIG);
    expect(anchor).toMatchObject({
      wethUsdWad: 2_000n * WAD,
      anchorPoolAddress: WETH_USDG_ANCHOR_POOL,
      virtualUsdWad: null,
      virtualAnchorPoolAddress: null
    });
  });
});

describe("runEnrichmentPass — two-lane selection", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  const NOW = new Date("2024-06-01T00:00:00.000Z");
  function hoursAgo(n: number): Date {
    return new Date(NOW.getTime() - n * 60 * 60 * 1000);
  }

  // Youth is on-chain: pools created at/after block 1000 are active.
  const MIN_CREATED_BLOCK = 1_000n;
  const YOUNG_BLOCK = 1_500n;
  const OLD_BLOCK = 100n;
  const CRITERIA = {
    now: NOW,
    activeMinCreatedBlock: MIN_CREATED_BLOCK,
    watchMinFdvUsd: 100,
    watchMaxFdvUsd: 1_000
  };
  const IDLE_REFRESH_MS = 4 * 60 * 60 * 1000; // 4h
  const IDLE_BATCH_LIMIT = 10;

  const ACTIVE_POOL = addr("c1"); // young: always active
  const ACTIVE_BASE = addr("d1");
  const IDLE_DUE_POOL = addr("c2"); // old, stale snapshot: due for idle refresh
  const IDLE_DUE_BASE = addr("d2");
  const IDLE_NOT_DUE_POOL = addr("c3"); // old, fresh snapshot: not due yet
  const IDLE_NOT_DUE_BASE = addr("d3");
  // Old, but its latest snapshot's FDV sits in the watch band (active) AND
  // that same snapshot is stale enough to independently qualify as idle-due
  // — exercises the active/idle dedupe.
  const BOTH_QUALIFYING_POOL = addr("c4");
  const BOTH_QUALIFYING_BASE = addr("d4");

  function trustedPool(
    poolAddress: Address,
    baseAddress: Address,
    createdAtBlock: bigint,
    logIndex: number
  ): PoolInsert {
    return pool({
      poolAddress,
      token0Address: baseAddress,
      baseTokenAddress: baseAddress,
      createdLogIndex: logIndex,
      createdAtBlock
    });
  }

  async function seed(reader: FakeReader): Promise<void> {
    await insertTokens(db, [
      token({
        address: WETH.address,
        name: "Wrapped Ether",
        symbol: "WETH",
        decimals: 18,
        totalSupply: (1_000_000n * 10n ** 18n).toString()
      }),
      token({ address: ACTIVE_BASE, name: "Active", symbol: "ACT" }),
      token({ address: IDLE_DUE_BASE, name: "IdleDue", symbol: "IDD" }),
      token({ address: IDLE_NOT_DUE_BASE, name: "IdleNotDue", symbol: "IND" }),
      token({ address: BOTH_QUALIFYING_BASE, name: "Both", symbol: "BOTH" })
    ]);
    await insertPools(db, [
      pool({
        poolAddress: ANCHOR_POOL,
        token0Address: WETH.address,
        token1Address: USDG.address,
        quoteTokenAddress: USDG.address,
        baseTokenAddress: WETH.address,
        createdLogIndex: 0,
        createdAtBlock: YOUNG_BLOCK
      }),
      trustedPool(ACTIVE_POOL, ACTIVE_BASE, YOUNG_BLOCK, 1),
      trustedPool(IDLE_DUE_POOL, IDLE_DUE_BASE, OLD_BLOCK, 2),
      trustedPool(IDLE_NOT_DUE_POOL, IDLE_NOT_DUE_BASE, OLD_BLOCK, 3),
      trustedPool(BOTH_QUALIFYING_POOL, BOTH_QUALIFYING_BASE, OLD_BLOCK, 4)
    ]);
    await insertPoolSnapshots(db, [
      {
        chainId: CHAIN_ID,
        poolAddress: IDLE_DUE_POOL,
        blockNumber: 1n,
        capturedAt: hoursAgo(8),
        calculationMethod: "v2-reserves"
      },
      {
        chainId: CHAIN_ID,
        poolAddress: IDLE_NOT_DUE_POOL,
        blockNumber: 1n,
        capturedAt: hoursAgo(1),
        calculationMethod: "v2-reserves"
      },
      {
        chainId: CHAIN_ID,
        poolAddress: BOTH_QUALIFYING_POOL,
        blockNumber: 1n,
        capturedAt: hoursAgo(8),
        calculationMethod: "v2-reserves",
        estimatedFdvUsd: "500"
      }
    ]);

    reader.reserves.set(ANCHOR_POOL, [10n * 10n ** 18n, 20_000n * 10n ** 6n, 0]);
    reader.setBalance(USDG.address, ANCHOR_POOL, 20_000n * 10n ** 6n);
    for (const poolAddress of [
      ACTIVE_POOL,
      IDLE_DUE_POOL,
      IDLE_NOT_DUE_POOL,
      BOTH_QUALIFYING_POOL
    ]) {
      reader.reserves.set(poolAddress, [1_000n * 10n ** 18n, 5n * 10n ** 18n, 0]);
    }
  }

  it("selects the active pool every pass and the idle pool only when stale, deduping a pool that qualifies for both", async () => {
    const reader = new FakeReader();
    await seed(reader);

    const result = await runEnrichmentPass({
      db,
      reader,
      config: CONFIG,
      selection: {
        active: CRITERIA,
        idleRefreshMs: IDLE_REFRESH_MS,
        idleBatchLimit: IDLE_BATCH_LIMIT
      }
    });

    // Active: ANCHOR_POOL (young), ACTIVE_POOL (young), BOTH_QUALIFYING_POOL (FDV band).
    expect(result.activePools).toBe(3);
    // Idle: only the stale, non-active pool.
    expect(result.idlePools).toBe(1);
    expect(result.poolsSelected).toBe(4);
    expect(result.snapshotsInserted).toBe(4);
    expect(result.poolErrors).toEqual([]);

    expect(await listPoolSnapshots(db, CHAIN_ID, ACTIVE_POOL)).toHaveLength(1);
    expect(await listPoolSnapshots(db, CHAIN_ID, IDLE_DUE_POOL)).toHaveLength(2);
    // Not-due pool keeps its original snapshot only — not refreshed this pass.
    expect(await listPoolSnapshots(db, CHAIN_ID, IDLE_NOT_DUE_POOL)).toHaveLength(1);
    // Both-qualifying pool is snapshotted exactly once — active lane wins,
    // no duplicate insert from the idle lane.
    expect(await listPoolSnapshots(db, CHAIN_ID, BOTH_QUALIFYING_POOL)).toHaveLength(2);
  });

  it("keeps legacy single-lane selection when `selection` is absent", async () => {
    const reader = new FakeReader();
    await seed(reader);

    const result = await runEnrichmentPass({ db, reader, config: CONFIG });

    expect(result.activePools).toBe(0);
    expect(result.idlePools).toBe(0);
    // Legacy path selects every trusted-quote pool regardless of age/FDV.
    expect(result.poolsSelected).toBe(5);
    expect(result.snapshotsInserted).toBe(5);
  });
});
