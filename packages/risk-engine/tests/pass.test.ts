import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getLatestTokenRiskForPool,
  insertPoolSnapshots,
  insertPools,
  listTokenRisks,
  tradeSimulations,
  type ActivePoolCriteria,
  type Db,
  type FdvBandCriteria,
  type PoolInsert
} from "@assay/database";
import { createTestDatabase, type TestDatabaseHandle } from "@assay/database/testing";

import { RiskHaltError, runRiskPass, type RiskPassOptions } from "../src/index.js";
import {
  BASE,
  POOL,
  QUOTE,
  TEST_CHAIN_ID,
  addr,
  codeWith,
  FakeRiskReader,
  fakeSimulator,
  rawSim,
  snapshotInsert,
  type FakeRiskReaderState
} from "./fixtures.js";

const TEST_CONFIG = {
  chainId: TEST_CHAIN_ID,
  rpcUrls: ["http://127.0.0.1:8545"],
  factories: [],
  quoteAssets: []
};

function poolInsert(overrides: Partial<PoolInsert> = {}): PoolInsert {
  return {
    chainId: TEST_CHAIN_ID,
    poolAddress: POOL,
    factoryAddress: addr("f2"),
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

/** Reader state for a clean, verified, non-proxy, tradeable token. */
function cleanReaderState(): FakeRiskReaderState {
  return {
    blockNumber: 1000n,
    code: { [BASE.toLowerCase()]: codeWith([]) },
    verification: {
      [BASE.toLowerCase()]: { ABI: "[{\"type\":\"function\"}]" }
    }
  };
}

describe("runRiskPass", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    await insertPools(db, [poolInsert()]);
  });

  afterEach(async () => {
    await handle.close();
  });

  function options(
    state: FakeRiskReaderState,
    extra: Partial<RiskPassOptions> = {},
    withSimulator = true
  ): RiskPassOptions {
    return {
      db,
      reader: new FakeRiskReader(state),
      config: TEST_CONFIG,
      ...(withSimulator ? { simulator: fakeSimulator(rawSim()) } : {}),
      ...extra
    };
  }

  it("assesses a clean token as PASS and persists risk + simulation", async () => {
    const result = await runRiskPass(options(cleanReaderState()));

    expect(result.poolsSelected).toBe(1);
    expect(result.passed).toBe(1);

    const risks = await listTokenRisks(db, TEST_CHAIN_ID, BASE);
    expect(risks).toHaveLength(1);
    expect(risks[0]?.status).toBe("PASS");
    expect(risks[0]?.simulationStatus).toBe("PASS");
    expect(risks[0]?.effectiveSellLossBps).toBe(100);

    const sims = await db.select().from(tradeSimulations);
    expect(sims).toHaveLength(1);
    expect(sims[0]?.route).toBe("uniswap-v2");
    expect(sims[0]?.blockNumber).toBe(1000n);
  });

  it("records a FAIL when a critical permission is present", async () => {
    const pauseSelector = "0x8456cb59"; // pause()
    const state: FakeRiskReaderState = {
      ...cleanReaderState(),
      code: { [BASE.toLowerCase()]: codeWith([pauseSelector]) }
    };
    const result = await runRiskPass(options(state));

    expect(result.failed).toBe(1);
    const [risk] = await listTokenRisks(db, TEST_CHAIN_ID, BASE);
    expect(risk?.status).toBe("FAIL");
  });

  it("stays UNKNOWN (never PASS) without a simulator", async () => {
    const result = await runRiskPass(
      options(cleanReaderState(), {}, false)
    );
    expect(result.unknown).toBe(1);
    const [risk] = await listTokenRisks(db, TEST_CHAIN_ID, BASE);
    expect(risk?.status).toBe("UNKNOWN");
    expect(risk?.simulationStatus).toBe("UNKNOWN");
  });

  it("skips already-assessed pools on the next pass (restart-safe)", async () => {
    await runRiskPass(options(cleanReaderState()));
    const second = await runRiskPass(options(cleanReaderState()));

    expect(second.poolsSelected).toBe(0);
    expect(await listTokenRisks(db, TEST_CHAIN_ID, BASE)).toHaveLength(1);
  });

  it("re-assesses and appends when the prior verdict is stale", async () => {
    await runRiskPass(options(cleanReaderState()));
    // Staleness window in the future forces re-selection of every pool.
    const second = await runRiskPass(
      options(cleanReaderState(), { stalenessMs: -60_000 })
    );

    expect(second.poolsSelected).toBe(1);
    expect(await listTokenRisks(db, TEST_CHAIN_ID, BASE)).toHaveLength(2);
  });

  it("halts loudly on infra failure without persisting", async () => {
    await expect(
      runRiskPass(options({ ...cleanReaderState(), blockNumberInfraFails: true }))
    ).rejects.toBeInstanceOf(RiskHaltError);
    expect(await listTokenRisks(db, TEST_CHAIN_ID, BASE)).toHaveLength(0);
  });

  it("halts when a chain read exhausts retries mid-assessment", async () => {
    await expect(
      runRiskPass(
        options({ ...cleanReaderState(), infraFailAddresses: [BASE.toLowerCase()] })
      )
    ).rejects.toBeInstanceOf(RiskHaltError);
  });

  it("records ERROR for a hostile non-infra read and keeps going", async () => {
    const result = await runRiskPass(
      options({ ...cleanReaderState(), errorAddresses: [BASE.toLowerCase()] })
    );
    expect(result.errored).toBe(1);
    expect(result.poolErrors).toHaveLength(1);
    const [risk] = await listTokenRisks(db, TEST_CHAIN_ID, BASE);
    expect(risk?.status).toBe("ERROR");
    expect(risk?.nullReason).toBe("analysis-error");
  });

  it("stops at a pool boundary when aborted, persisting nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runRiskPass(
      options(cleanReaderState(), { signal: controller.signal })
    );

    expect(result.stopped).toBe(true);
    expect(result.assessed).toBe(0);
    expect(await listTokenRisks(db, TEST_CHAIN_ID, BASE)).toHaveLength(0);
  });

  it("keeps the latest verdict retrievable per pool", async () => {
    await runRiskPass(options(cleanReaderState()));
    const latest = await getLatestTokenRiskForPool(db, TEST_CHAIN_ID, POOL);
    expect(latest?.status).toBe("PASS");
  });

  it("scopes selection to the backlog set when `backlog` is given, and keeps legacy behavior without it", async () => {
    const idleBase = addr("ff");
    const idlePool = addr("ee");
    await insertPools(db, [
      poolInsert({
        poolAddress: idlePool,
        token0Address: idleBase,
        token1Address: QUOTE,
        baseTokenAddress: idleBase,
        quoteTokenAddress: QUOTE,
        // On-chain old: below the youth cutoff (the default pool sits at 100n).
        createdAtBlock: 50n
      })
    ]);
    const backlog: ActivePoolCriteria = {
      now: new Date(),
      activeMinCreatedBlock: 100n,
      watchMinFdvUsd: 0,
      watchMaxFdvUsd: 0
    };

    const scoped = await runRiskPass(options(cleanReaderState(), { backlog }));
    expect(scoped.poolsSelected).toBe(1);
    expect(await getLatestTokenRiskForPool(db, TEST_CHAIN_ID, POOL)).toBeDefined();
    expect(
      await getLatestTokenRiskForPool(db, TEST_CHAIN_ID, idlePool)
    ).toBeUndefined();

    // Legacy call (no `band`/`backlog`) still picks up the pool the
    // backlog-scoped pass skipped.
    const legacy = await runRiskPass(options(cleanReaderState()));
    expect(legacy.poolsSelected).toBe(1);
    expect(
      await getLatestTokenRiskForPool(db, TEST_CHAIN_ID, idlePool)
    ).toBeDefined();
  });

  describe("band-priority selection", () => {
    const BAND: FdvBandCriteria = { minFdvUsd: 40_000, maxFdvUsd: 300_000 };

    function backlogCriteria(
      overrides: Partial<ActivePoolCriteria> = {}
    ): ActivePoolCriteria {
      return {
        now: new Date(),
        // Well above every pool's createdAtBlock in these tests unless a
        // pool is meant to qualify for the backlog lane explicitly.
        activeMinCreatedBlock: 1000n,
        watchMinFdvUsd: 0,
        watchMaxFdvUsd: 0,
        ...overrides
      };
    }

    it("selects the band lane before the backlog lane when `poolLimit` caps the combined pass", async () => {
      const bandBase = addr("11");
      const bandPool = addr("12");
      const backlogBase = addr("21");
      const backlogPool = addr("22");
      await insertPools(db, [
        poolInsert({
          poolAddress: bandPool,
          token0Address: bandBase,
          token1Address: QUOTE,
          baseTokenAddress: bandBase,
          quoteTokenAddress: QUOTE,
          createdAtBlock: 500n
        }),
        poolInsert({
          poolAddress: backlogPool,
          token0Address: backlogBase,
          token1Address: QUOTE,
          baseTokenAddress: backlogBase,
          quoteTokenAddress: QUOTE,
          createdAtBlock: 1500n
        })
      ]);
      await insertPoolSnapshots(db, [
        snapshotInsert(bandPool, new Date(), { estimatedFdvUsd: "100000" })
      ]);

      const result = await runRiskPass(
        options(cleanReaderState(), {
          band: BAND,
          backlog: backlogCriteria(),
          poolLimit: 1
        })
      );

      expect(result.poolsSelected).toBe(1);
      expect(
        await getLatestTokenRiskForPool(db, TEST_CHAIN_ID, bandPool)
      ).toBeDefined();
      expect(
        await getLatestTokenRiskForPool(db, TEST_CHAIN_ID, backlogPool)
      ).toBeUndefined();
    });

    it("never exceeds `poolLimit` across the combined band + backlog lanes", async () => {
      const bandBaseA = addr("11");
      const bandPoolA = addr("12");
      const bandBaseB = addr("13");
      const bandPoolB = addr("14");
      const backlogBaseOld = addr("21");
      const backlogPoolOld = addr("22");
      const backlogBaseNew = addr("23");
      const backlogPoolNew = addr("24");
      await insertPools(db, [
        poolInsert({
          poolAddress: bandPoolA,
          token0Address: bandBaseA,
          token1Address: QUOTE,
          baseTokenAddress: bandBaseA,
          quoteTokenAddress: QUOTE,
          createdAtBlock: 500n
        }),
        poolInsert({
          poolAddress: bandPoolB,
          token0Address: bandBaseB,
          token1Address: QUOTE,
          baseTokenAddress: bandBaseB,
          quoteTokenAddress: QUOTE,
          createdAtBlock: 600n
        }),
        poolInsert({
          poolAddress: backlogPoolOld,
          token0Address: backlogBaseOld,
          token1Address: QUOTE,
          baseTokenAddress: backlogBaseOld,
          quoteTokenAddress: QUOTE,
          createdAtBlock: 1500n
        }),
        poolInsert({
          poolAddress: backlogPoolNew,
          token0Address: backlogBaseNew,
          token1Address: QUOTE,
          baseTokenAddress: backlogBaseNew,
          quoteTokenAddress: QUOTE,
          createdAtBlock: 1600n
        })
      ]);
      await insertPoolSnapshots(db, [
        snapshotInsert(bandPoolA, new Date(), { estimatedFdvUsd: "100000" }),
        snapshotInsert(bandPoolB, new Date(), { estimatedFdvUsd: "150000" })
      ]);

      const result = await runRiskPass(
        options(cleanReaderState(), {
          band: BAND,
          backlog: backlogCriteria(),
          poolLimit: 3
        })
      );

      expect(result.poolsSelected).toBeLessThanOrEqual(3);
      expect(result.poolsSelected).toBe(3);
      expect(
        await getLatestTokenRiskForPool(db, TEST_CHAIN_ID, bandPoolA)
      ).toBeDefined();
      expect(
        await getLatestTokenRiskForPool(db, TEST_CHAIN_ID, bandPoolB)
      ).toBeDefined();
      // Backlog lane, newest-created first: only the one remaining budget
      // slot goes to the newer backlog pool.
      expect(
        await getLatestTokenRiskForPool(db, TEST_CHAIN_ID, backlogPoolNew)
      ).toBeDefined();
      expect(
        await getLatestTokenRiskForPool(db, TEST_CHAIN_ID, backlogPoolOld)
      ).toBeUndefined();
    });

    it("assesses a pool that qualifies for both lanes exactly once", async () => {
      const bothBase = addr("31");
      const bothPool = addr("32");
      await insertPools(db, [
        poolInsert({
          poolAddress: bothPool,
          token0Address: bothBase,
          token1Address: QUOTE,
          baseTokenAddress: bothBase,
          quoteTokenAddress: QUOTE,
          // Active via block (>= activeMinCreatedBlock) AND in-band via
          // FDV: qualifies for both the band lane and the backlog lane.
          createdAtBlock: 2000n
        })
      ]);
      await insertPoolSnapshots(db, [
        snapshotInsert(bothPool, new Date(), { estimatedFdvUsd: "100000" })
      ]);

      const result = await runRiskPass(
        options(cleanReaderState(), {
          band: BAND,
          backlog: backlogCriteria(),
          poolLimit: 2
        })
      );

      expect(result.poolsSelected).toBe(1);
      expect(result.assessed).toBe(1);
      const risks = await listTokenRisks(db, TEST_CHAIN_ID, bothBase);
      expect(risks).toHaveLength(1);
    });
  });
});
