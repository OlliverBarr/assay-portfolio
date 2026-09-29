import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getLatestHolderSnapshot,
  getTokensByAddresses,
  insertPoolSnapshots,
  insertPools,
  insertTokens,
  tokenHolderSnapshots,
  tokenHolders,
  updateTokenDeployer,
  type Db,
  type FdvBandCriteria
} from "@assay/database";
import {
  createTestDatabase,
  type TestDatabaseHandle
} from "@assay/database/testing";

import { HolderHaltError, runHolderPass, type HolderPassOptions } from "../src/index.js";
import {
  BASE,
  BASE2,
  FakeHolderReader,
  HOLDER_A,
  HOLDER_B,
  HOLDER_C,
  POOL,
  POOL2,
  QUOTE,
  TEST_CHAIN_ID,
  TEST_CONFIG,
  ZERO,
  addr,
  poolInsert,
  snapshotInsert,
  tokenInsert,
  transfer,
  type FakeHolderReaderState
} from "./fixtures.js";

/** Default test selection: band lane disabled (limit 0), backlog lane wide
 * open (minCreatedBlock 0n, generous limit) so existing scans behave like
 * "every inserted pool is a candidate" unless a test overrides `selection`
 * to exercise band-priority behavior specifically. */
const DEFAULT_SELECTION: HolderPassOptions["selection"] = {
  band: { minFdvUsd: 0, maxFdvUsd: 0 },
  bandLimit: 0,
  backlog: { minCreatedBlock: 0n, limit: 1000 }
};

/** ZERO -> A(60), B(30), POOL(10): 100 supply, pool holds 10. */
function baseTransfers() {
  return [
    transfer(ZERO, HOLDER_A, 60n),
    transfer(ZERO, HOLDER_B, 30n),
    transfer(ZERO, POOL, 10n)
  ];
}

describe("runHolderPass", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    await insertPools(db, [poolInsert()]);
    await insertTokens(db, [tokenInsert(BASE, "100")]);
  });

  afterEach(async () => {
    await handle.close();
  });

  function options(
    state: FakeHolderReaderState,
    extra: Partial<HolderPassOptions> = {}
  ): HolderPassOptions {
    return {
      db,
      reader: new FakeHolderReader(state),
      config: TEST_CONFIG,
      selection: DEFAULT_SELECTION,
      ...extra
    };
  }

  it("scans, computes, and persists a holder snapshot + balances", async () => {
    const result = await runHolderPass(
      options({ transfersByToken: { [BASE.toLowerCase()]: baseTransfers() } })
    );

    expect(result.poolsSelected).toBe(1);
    expect(result.assessed).toBe(1);
    expect(result.snapshotsInserted).toBe(1);
    expect(result.poolErrors).toEqual([]);
    expect(result.stopped).toBe(false);

    const snapshot = await getLatestHolderSnapshot(db, TEST_CHAIN_ID, BASE);
    expect(snapshot).toMatchObject({
      holderCount: 3,
      adjustedHolderCount: 2,
      largestHolderPctBps: 6000,
      top10PctBps: 10000,
      adjustedTop10PctBps: 10000,
      // totalSupply 100, only the pool (10) excluded, deployer unresolved:
      // float = (100 - 10) / 100 = 9000 bps; pool share = 10/100 = 1000 bps.
      floatBps: 9000,
      supplyInPoolBps: 1000
    });
    expect(snapshot?.excluded).toEqual([
      { address: POOL, reason: "pool-address" }
    ]);
    expect(snapshot?.deployerPctBps).toBeNull();

    const holders = await db.select().from(tokenHolders);
    expect(holders).toHaveLength(3);
    const balanceByHolder = new Map(
      holders.map((row) => [row.holderAddress, row.balanceRaw])
    );
    expect(balanceByHolder.get(HOLDER_A)).toBe("60");
    expect(balanceByHolder.get(POOL)).toBe("10");
  });

  it("skips pools with a fresh snapshot on the next pass (restart-safe)", async () => {
    await runHolderPass(
      options({ transfersByToken: { [BASE.toLowerCase()]: baseTransfers() } })
    );
    const second = await runHolderPass(
      options({ transfersByToken: { [BASE.toLowerCase()]: baseTransfers() } })
    );

    expect(second.poolsSelected).toBe(0);
    expect(second.assessed).toBe(0);
    expect(await db.select().from(tokenHolderSnapshots)).toHaveLength(1);
  });

  it("re-scans and appends a new snapshot when the prior one is stale", async () => {
    await runHolderPass(
      options({ transfersByToken: { [BASE.toLowerCase()]: baseTransfers() } })
    );
    const second = await runHolderPass(
      options(
        { transfersByToken: { [BASE.toLowerCase()]: baseTransfers() } },
        { stalenessMs: -60_000 }
      )
    );

    expect(second.poolsSelected).toBe(1);
    expect(second.snapshotsInserted).toBe(1);
    // Append-only: both snapshots are retained, never updated in place.
    expect(await db.select().from(tokenHolderSnapshots)).toHaveLength(2);
  });

  it("halts loudly when the head read exhausts retries, persisting nothing", async () => {
    await expect(
      runHolderPass(options({ blockNumberInfraFails: true }))
    ).rejects.toBeInstanceOf(HolderHaltError);
    expect(await db.select().from(tokenHolderSnapshots)).toHaveLength(0);
  });

  it("halts when a log read exhausts retries mid-scan", async () => {
    await expect(
      runHolderPass(options({ infraFailTokens: [BASE.toLowerCase()] }))
    ).rejects.toBeInstanceOf(HolderHaltError);
    expect(await db.select().from(tokenHolderSnapshots)).toHaveLength(0);
  });

  it("records a hostile token and keeps scanning the rest", async () => {
    await insertPools(db, [
      poolInsert({
        poolAddress: POOL2,
        token0Address: BASE2,
        baseTokenAddress: BASE2,
        factoryAddress: addr("f3"),
        quoteTokenAddress: QUOTE,
        token1Address: QUOTE,
        createdAtBlock: 101n,
        createdLogIndex: 1
      })
    ]);
    await insertTokens(db, [tokenInsert(BASE2, "100")]);

    const result = await runHolderPass(
      options({
        transfersByToken: { [BASE.toLowerCase()]: baseTransfers() },
        errorTokens: [BASE2.toLowerCase()]
      })
    );

    expect(result.poolsSelected).toBe(2);
    expect(result.assessed).toBe(1);
    expect(result.snapshotsInserted).toBe(1);
    expect(result.poolErrors).toHaveLength(1);
    expect(result.poolErrors[0]?.poolAddress).toBe(POOL2);

    // The clean pool committed; the hostile one produced no snapshot.
    expect(await getLatestHolderSnapshot(db, TEST_CHAIN_ID, BASE)).toBeDefined();
    expect(
      await getLatestHolderSnapshot(db, TEST_CHAIN_ID, BASE2)
    ).toBeUndefined();
  });

  it("stops at a pool boundary when aborted, persisting nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runHolderPass(
      options(
        { transfersByToken: { [BASE.toLowerCase()]: baseTransfers() } },
        { signal: controller.signal }
      )
    );

    expect(result.stopped).toBe(true);
    expect(result.assessed).toBe(0);
    expect(result.snapshotsInserted).toBe(0);
    expect(await db.select().from(tokenHolderSnapshots)).toHaveLength(0);
  });

  describe("incremental holder scan", () => {
    it("full-scan-then-incremental matches a from-scratch scan of the whole range", async () => {
      const history = [
        transfer(ZERO, HOLDER_A, 100n, 150n),
        transfer(HOLDER_A, HOLDER_B, 40n, 200n),
        transfer(HOLDER_A, POOL, 10n, 300n),
        transfer(HOLDER_B, HOLDER_C, 15n, 600n),
        transfer(HOLDER_A, HOLDER_C, 10n, 700n)
      ];
      const transfersByToken = { [BASE.toLowerCase()]: history };

      await runHolderPass(options({ transfersByToken, blockNumber: 500n }));
      await runHolderPass(
        options({ transfersByToken, blockNumber: 1000n }, { stalenessMs: -60_000 })
      );
      const [token] = await getTokensByAddresses(db, TEST_CHAIN_ID, [BASE]);
      expect(token?.holderScanBlock).toBe(1000n);

      const incrementalBalances = new Map(
        (await db.select().from(tokenHolders))
          .filter((row) => row.tokenAddress === BASE)
          .map((row) => [row.holderAddress, row.balanceRaw])
      );
      expect(incrementalBalances.get(HOLDER_A)).toBe("40");
      expect(incrementalBalances.get(HOLDER_B)).toBe("25");
      expect(incrementalBalances.get(HOLDER_C)).toBe("25");
      expect(incrementalBalances.get(POOL)).toBe("10");

      // Same transfer history, scanned by a second base token in one
      // from-scratch pass — the two must land on identical balances.
      await insertPools(db, [
        poolInsert({
          poolAddress: POOL2,
          token0Address: BASE2,
          baseTokenAddress: BASE2,
          factoryAddress: addr("f4"),
          quoteTokenAddress: QUOTE,
          token1Address: QUOTE,
          createdAtBlock: 100n,
          createdLogIndex: 1
        })
      ]);
      await insertTokens(db, [tokenInsert(BASE2, "100")]);
      await runHolderPass(
        options({
          transfersByToken: { [BASE2.toLowerCase()]: history },
          blockNumber: 1000n
        })
      );
      const scratchBalances = new Map(
        (await db.select().from(tokenHolders))
          .filter((row) => row.tokenAddress === BASE2)
          .map((row) => [row.holderAddress, row.balanceRaw])
      );

      expect(scratchBalances).toEqual(incrementalBalances);
    });

    it("overwrites a stored balance to zero when a holder sells out during the delta window", async () => {
      const transfersByToken = {
        [BASE.toLowerCase()]: [
          transfer(ZERO, HOLDER_A, 60n, 150n),
          transfer(ZERO, HOLDER_B, 40n, 150n),
          transfer(HOLDER_B, HOLDER_A, 40n, 600n)
        ]
      };

      await runHolderPass(options({ transfersByToken, blockNumber: 500n }));
      const afterFirst = (await db.select().from(tokenHolders)).filter(
        (row) => row.tokenAddress === BASE
      );
      expect(
        afterFirst.find((row) => row.holderAddress === HOLDER_B)?.balanceRaw
      ).toBe("40");

      await runHolderPass(
        options({ transfersByToken, blockNumber: 1000n }, { stalenessMs: -60_000 })
      );
      const afterSecond = (await db.select().from(tokenHolders)).filter(
        (row) => row.tokenAddress === BASE
      );
      const byHolder = new Map(
        afterSecond.map((row) => [row.holderAddress, row.balanceRaw])
      );

      expect(byHolder.get(HOLDER_A)).toBe("100");
      // Overwritten to zero, not deleted: a stale positive row would
      // otherwise keep inflating this holder's reported balance forever.
      expect(byHolder.get(HOLDER_B)).toBe("0");
      expect(afterSecond).toHaveLength(2);
    });

    it("leaves the cursor unchanged when the delta fetch errors before the commit", async () => {
      const transfersByToken = {
        [BASE.toLowerCase()]: [transfer(ZERO, HOLDER_A, 60n, 150n)]
      };
      await runHolderPass(options({ transfersByToken, blockNumber: 500n }));
      const [tokenAfterFirst] = await getTokensByAddresses(db, TEST_CHAIN_ID, [BASE]);
      expect(tokenAfterFirst?.holderScanBlock).toBe(500n);

      const result = await runHolderPass(
        options(
          {
            transfersByToken,
            blockNumber: 1000n,
            errorTokens: [BASE.toLowerCase()]
          },
          { stalenessMs: -60_000 }
        )
      );

      expect(result.poolErrors).toHaveLength(1);
      const [tokenAfterFailure] = await getTokensByAddresses(db, TEST_CHAIN_ID, [BASE]);
      expect(tokenAfterFailure?.holderScanBlock).toBe(500n);
      expect(await db.select().from(tokenHolderSnapshots)).toHaveLength(1);
    });

    it("skips the log fetch and still snapshots from stored balances once the cursor reaches head", async () => {
      const transfersByToken = {
        [BASE.toLowerCase()]: [
          transfer(ZERO, HOLDER_A, 60n, 150n),
          transfer(ZERO, POOL, 10n, 150n)
        ]
      };
      const firstReader = new FakeHolderReader({ transfersByToken, blockNumber: 500n });
      await runHolderPass(options({}, { reader: firstReader }));
      expect(firstReader.logCalls).toHaveLength(1);

      const secondReader = new FakeHolderReader({ transfersByToken, blockNumber: 500n });
      const second = await runHolderPass(
        options({}, { reader: secondReader, stalenessMs: -60_000 })
      );

      expect(secondReader.logCalls).toHaveLength(0);
      expect(second.assessed).toBe(1);
      expect(second.snapshotsInserted).toBe(1);
      const snapshot = await getLatestHolderSnapshot(db, TEST_CHAIN_ID, BASE);
      expect(snapshot?.blockNumber).toBe(500n);
      expect(snapshot?.holderCount).toBe(2);
    });

    it("a second pool sharing the base token sees cursor==head and skips its own fetch", async () => {
      await insertPools(db, [
        poolInsert({
          poolAddress: POOL2,
          token0Address: BASE,
          baseTokenAddress: BASE,
          factoryAddress: addr("f5"),
          quoteTokenAddress: QUOTE,
          token1Address: QUOTE,
          createdAtBlock: 100n,
          createdLogIndex: 1
        })
      ]);
      const transfersByToken = {
        [BASE.toLowerCase()]: [transfer(ZERO, HOLDER_A, 60n, 150n)]
      };
      const reader = new FakeHolderReader({ transfersByToken, blockNumber: 500n });

      const result = await runHolderPass(options({}, { reader }));

      expect(result.poolsSelected).toBe(2);
      expect(result.assessed).toBe(2);
      expect(result.snapshotsInserted).toBe(2);
      // Both pools resolve the same base token; only the first fetches logs.
      expect(reader.logCalls).toHaveLength(1);
    });
  });

  describe("band-priority selection", () => {
    const BAND_POOL = addr("e1");
    const BAND_TOKEN = addr("b3");
    const BAND: FdvBandCriteria = { minFdvUsd: 100_000, maxFdvUsd: 200_000 };

    it("scans a band pool whose holder snapshot is missing", async () => {
      await insertPools(db, [
        poolInsert({
          poolAddress: BAND_POOL,
          token0Address: BAND_TOKEN,
          baseTokenAddress: BAND_TOKEN,
          factoryAddress: addr("f9"),
          quoteTokenAddress: QUOTE,
          token1Address: QUOTE,
          createdAtBlock: 500n,
          createdLogIndex: 0
        })
      ]);
      await insertTokens(db, [tokenInsert(BAND_TOKEN, "100")]);
      await insertPoolSnapshots(db, [
        snapshotInsert(BAND_POOL, new Date(), { estimatedFdvUsd: "150000" })
      ]);

      const result = await runHolderPass(
        options(
          { transfersByToken: {} },
          { selection: { band: BAND, bandLimit: 10 } }
        )
      );

      // Only the band pool matches — the default BASE pool has no snapshot
      // at all, so it never satisfies the band's FDV-membership condition.
      expect(result.poolsSelected).toBe(1);
      expect(result.assessed).toBe(1);
      expect(await getLatestHolderSnapshot(db, TEST_CHAIN_ID, BAND_TOKEN)).toBeDefined();
      expect(await getLatestHolderSnapshot(db, TEST_CHAIN_ID, BASE)).toBeUndefined();
    });

    it("skips a band pool whose holder snapshot is fresh", async () => {
      await insertPools(db, [
        poolInsert({
          poolAddress: BAND_POOL,
          token0Address: BAND_TOKEN,
          baseTokenAddress: BAND_TOKEN,
          factoryAddress: addr("f9"),
          quoteTokenAddress: QUOTE,
          token1Address: QUOTE,
          createdAtBlock: 500n,
          createdLogIndex: 0
        })
      ]);
      await insertTokens(db, [tokenInsert(BAND_TOKEN, "100")]);
      await insertPoolSnapshots(db, [
        snapshotInsert(BAND_POOL, new Date(), { estimatedFdvUsd: "150000" })
      ]);
      const selection = { band: BAND, bandLimit: 10 };

      await runHolderPass(options({ transfersByToken: {} }, { selection }));
      const second = await runHolderPass(options({ transfersByToken: {} }, { selection }));

      // The first pass's snapshot is fresh (just captured), so the band
      // lane's staleness condition excludes the pool on the second pass.
      expect(second.poolsSelected).toBe(0);
      expect(second.assessed).toBe(0);
    });

    it("backlog lane respects its own limit and never displaces the band lane", async () => {
      const backlogTokens = [addr("b4"), addr("b5"), addr("b6")];
      await insertPools(db, [
        poolInsert({
          poolAddress: BAND_POOL,
          token0Address: BAND_TOKEN,
          baseTokenAddress: BAND_TOKEN,
          factoryAddress: addr("f9"),
          quoteTokenAddress: QUOTE,
          token1Address: QUOTE,
          createdAtBlock: 1n,
          createdLogIndex: 0
        }),
        ...backlogTokens.map((token, index) =>
          poolInsert({
            poolAddress: addr(`e${2 + index}`),
            token0Address: token,
            baseTokenAddress: token,
            factoryAddress: addr(`f${2 + index}`),
            quoteTokenAddress: QUOTE,
            token1Address: QUOTE,
            createdAtBlock: 300n + BigInt(index),
            createdLogIndex: 0
          })
        )
      ]);
      await insertTokens(db, [
        tokenInsert(BAND_TOKEN, "100"),
        ...backlogTokens.map((token) => tokenInsert(token, "100"))
      ]);
      await insertPoolSnapshots(db, [
        snapshotInsert(BAND_POOL, new Date(), { estimatedFdvUsd: "150000" })
      ]);

      const result = await runHolderPass(
        options(
          { transfersByToken: {} },
          {
            selection: {
              band: BAND,
              bandLimit: 5,
              backlog: { minCreatedBlock: 300n, limit: 2 }
            }
          }
        )
      );

      // Band lane (1) unaffected by the backlog's separate budget, plus the
      // backlog lane capped at its own limit (2 of the 3 eligible pools).
      expect(result.poolsSelected).toBe(3);
      expect(result.assessed).toBe(3);
      expect(await getLatestHolderSnapshot(db, TEST_CHAIN_ID, BAND_TOKEN)).toBeDefined();
      // Newest-created-first: blocks 301 and 302 win the limit-2 backlog
      // budget; the oldest eligible backlog pool (block 300) is left behind.
      expect(
        await getLatestHolderSnapshot(db, TEST_CHAIN_ID, backlogTokens[1]!)
      ).toBeDefined();
      expect(
        await getLatestHolderSnapshot(db, TEST_CHAIN_ID, backlogTokens[2]!)
      ).toBeDefined();
      expect(
        await getLatestHolderSnapshot(db, TEST_CHAIN_ID, backlogTokens[0]!)
      ).toBeUndefined();
    });

    it("scans a pool that qualifies for both lanes exactly once", async () => {
      const overlapPool = addr("e9");
      const overlapToken = addr("b7");
      await insertPools(db, [
        poolInsert({
          poolAddress: overlapPool,
          token0Address: overlapToken,
          baseTokenAddress: overlapToken,
          factoryAddress: addr("fa"),
          quoteTokenAddress: QUOTE,
          token1Address: QUOTE,
          createdAtBlock: 500n,
          createdLogIndex: 0
        })
      ]);
      await insertTokens(db, [tokenInsert(overlapToken, "100")]);
      await insertPoolSnapshots(db, [
        snapshotInsert(overlapPool, new Date(), { estimatedFdvUsd: "150000" })
      ]);

      const result = await runHolderPass(
        options(
          { transfersByToken: {} },
          {
            selection: {
              band: BAND,
              bandLimit: 5,
              // minCreatedBlock excludes the default BASE pool (100n) so
              // only the overlap pool double-matches both lanes' queries.
              backlog: { minCreatedBlock: 400n, limit: 5 }
            }
          }
        )
      );

      expect(result.poolsSelected).toBe(1);
      expect(result.assessed).toBe(1);
      expect(result.snapshotsInserted).toBe(1);
      expect(await getLatestHolderSnapshot(db, TEST_CHAIN_ID, overlapToken)).toBeDefined();
    });
  });

  describe("deployer provenance", () => {
    it("resolves the deployer, persists it, and writes a real deployerPctBps", async () => {
      const result = await runHolderPass(
        options({
          transfersByToken: { [BASE.toLowerCase()]: baseTransfers() },
          deployerByToken: { [BASE.toLowerCase()]: HOLDER_A }
        })
      );

      expect(result.assessed).toBe(1);
      const snapshot = await getLatestHolderSnapshot(db, TEST_CHAIN_ID, BASE);
      // Adjusted supply = 90 (pool excluded); deployer A holds 60 -> 6666 bps.
      expect(snapshot?.deployerPctBps).toBe(6666);

      const [token] = await getTokensByAddresses(db, TEST_CHAIN_ID, [BASE]);
      expect(token?.deployerAddress).toBe(HOLDER_A);
      expect(token?.deployerStatus).toBe("RESOLVED");
      expect(token?.deployerCheckedAt).toBeInstanceOf(Date);
    });

    it("records an explorer miss as UNKNOWN and keeps the snapshot null", async () => {
      const result = await runHolderPass(
        options({ transfersByToken: { [BASE.toLowerCase()]: baseTransfers() } })
      );

      // The pass is never halted by a missing provenance answer.
      expect(result.assessed).toBe(1);
      const snapshot = await getLatestHolderSnapshot(db, TEST_CHAIN_ID, BASE);
      expect(snapshot?.deployerPctBps).toBeNull();

      // UNKNOWN + timestamp: distinguishable from never-attempted (null).
      const [token] = await getTokensByAddresses(db, TEST_CHAIN_ID, [BASE]);
      expect(token?.deployerAddress).toBeNull();
      expect(token?.deployerStatus).toBe("UNKNOWN");
      expect(token?.deployerCheckedAt).toBeInstanceOf(Date);
    });

    it("does not re-ask the explorer for UNKNOWN inside the retry window", async () => {
      const reader = new FakeHolderReader({
        transfersByToken: { [BASE.toLowerCase()]: baseTransfers() }
      });

      await runHolderPass(options({}, { reader }));
      expect(reader.creationLookups).toHaveLength(1);

      const second = await runHolderPass(
        options({}, { reader, stalenessMs: -60_000 })
      );
      expect(second.snapshotsInserted).toBe(1);
      // Still within the retry window: recorded attempt suppresses a re-ask.
      expect(reader.creationLookups).toHaveLength(1);
      const snapshot = await getLatestHolderSnapshot(db, TEST_CHAIN_ID, BASE);
      expect(snapshot?.deployerPctBps).toBeNull();
    });

    it("re-asks the explorer for UNKNOWN once the retry window elapsed", async () => {
      const start = new Date();
      await runHolderPass(
        options(
          { transfersByToken: { [BASE.toLowerCase()]: baseTransfers() } },
          { now: () => start }
        )
      );

      const later = new Date(start.getTime() + 61 * 60 * 1000);
      const reader = new FakeHolderReader({
        transfersByToken: { [BASE.toLowerCase()]: baseTransfers() },
        deployerByToken: { [BASE.toLowerCase()]: HOLDER_A }
      });
      // Snapshot capturedAt uses the DB clock; force re-selection so only the
      // deployer retry window (driven by the injected clock) is under test.
      await runHolderPass(
        options({}, { reader, now: () => later, stalenessMs: -60_000 })
      );

      expect(reader.creationLookups).toHaveLength(1);
      const snapshot = await getLatestHolderSnapshot(db, TEST_CHAIN_ID, BASE);
      expect(snapshot?.deployerPctBps).toBe(6666);
      const [token] = await getTokensByAddresses(db, TEST_CHAIN_ID, [BASE]);
      expect(token?.deployerStatus).toBe("RESOLVED");
    });

    it("reuses a stored RESOLVED deployer without asking the explorer", async () => {
      await updateTokenDeployer(db, TEST_CHAIN_ID, BASE, {
        deployerAddress: HOLDER_B,
        deployerStatus: "RESOLVED",
        deployerCheckedAt: new Date()
      });
      const reader = new FakeHolderReader({
        transfersByToken: { [BASE.toLowerCase()]: baseTransfers() }
      });

      await runHolderPass(options({}, { reader }));

      expect(reader.creationLookups).toHaveLength(0);
      const snapshot = await getLatestHolderSnapshot(db, TEST_CHAIN_ID, BASE);
      // B holds 30 of the 90 adjusted supply -> 3333 bps.
      expect(snapshot?.deployerPctBps).toBe(3333);
    });
  });
});
