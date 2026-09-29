import type { Address, Hex } from "viem";

import {
  RetryExhaustedError,
  swapTopicByKind,
  withRetry,
  type ChainConfig,
  type FactoryLogSource,
  type RawFactoryLog,
  type RetryOptions
} from "@assay/chain";
import {
  advanceActivityProcessedBlock,
  getActivityCursor,
  getCursor,
  initializeActivityCursor,
  insertPoolActivitySnapshots,
  insertPoolSwapEvents,
  listActiveTrustedQuotePoolsCreatedBefore,
  listActiveTrustedQuotePoolsNeedingActivityRefresh,
  listPoolSwapEventsSince,
  listTrustedQuotePoolsCreatedBefore,
  recordActivityObservedBlock,
  type ActivePoolCriteria,
  type Db,
  type PoolActivitySnapshotInsert,
  type PoolRow,
  type PoolSwapEventInsert,
  type PoolSwapEventRow
} from "@assay/database";

import { ACTIVITY_MAX_WINDOW_MS, buildActivitySnapshot } from "./aggregate.js";
import { decodeSwapLog } from "./decode.js";
import { ActivityHaltError, SwapDecodeError } from "./errors.js";
import { normalizeSwapEvent, toPoolSwapEventInsert } from "./normalize.js";

export interface ActivityPassOptions {
  readonly db: Db;
  readonly logSource: FactoryLogSource;
  readonly config: ChainConfig;
  /** Blocks per getLogs request. Default 2000. */
  readonly chunkSize?: bigint;
  /** Head lag before a block is considered scannable. Default 0. */
  readonly confirmations?: bigint;
  readonly retry?: Partial<RetryOptions>;
  /** Stops at the next chunk boundary after committed progress. */
  readonly signal?: AbortSignal;
  /**
   * Scope per-chunk pool selection to the active set so chunk cost scales
   * with launch activity, not all-time pool count. Unset = every trusted
   * pool (only sane for tests and small bounded ranges). Any pool that can
   * reach an alert tier is active by construction: the watch band contains
   * every alertable FDV band, so scoping here never starves the funnel.
   */
  readonly active?: ActivePoolCriteria;
  /**
   * Refresh lane: re-snapshot active pools whose latest activity snapshot
   * is older than this, so rolling buyer windows decay even for pools with
   * no new swaps. Default 15 minutes. Only runs when `active` is set.
   */
  readonly snapshotRefreshMs?: number;
  /** Max pools re-snapshotted by the refresh lane per pass. Default 400. */
  readonly refreshBatchLimit?: number;
}

export interface ActivityPassResult {
  readonly chainId: number;
  readonly scannedFromBlock: bigint | null;
  readonly scannedToBlock: bigint | null;
  readonly chunksProcessed: number;
  readonly logsSeen: number;
  readonly swapEventsInserted: number;
  readonly snapshotsInserted: number;
  readonly poolsSelected: number;
  /** Pools re-snapshotted by the staleness refresh lane this pass. */
  readonly poolsRefreshed: number;
  readonly stopped: boolean;
}

const EMPTY_RESULT_FIELDS = {
  scannedFromBlock: null,
  scannedToBlock: null,
  chunksProcessed: 0,
  logsSeen: 0,
  swapEventsInserted: 0,
  snapshotsInserted: 0,
  poolsSelected: 0,
  poolsRefreshed: 0,
  stopped: false
} as const;

const DEFAULT_SNAPSHOT_REFRESH_MS = 15 * 60 * 1000;
const DEFAULT_REFRESH_BATCH_LIMIT = 400;

function bigintMin(values: readonly bigint[]): bigint {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new RangeError("bigintMin requires at least one value");
  }
  let min = first;
  for (const value of rest) {
    if (value < min) min = value;
  }
  return min;
}

function rangeTopics(pools: readonly PoolRow[]): Hex[] {
  return [
    ...new Set(
      pools.map((pool) => {
        if (pool.factoryKind !== "uniswap-v2" && pool.factoryKind !== "uniswap-v3") {
          throw new SwapDecodeError(
            `unsupported pool kind ${pool.factoryKind} for pool ${pool.poolAddress}`,
            { blockNumber: pool.createdAtBlock, logIndex: pool.createdLogIndex }
          );
        }
        return swapTopicByKind[pool.factoryKind];
      })
    )
  ];
}

function normalizeChunkLogs(
  logs: readonly RawFactoryLog[],
  poolByAddress: ReadonlyMap<string, PoolRow>,
  observedAt: Date
): PoolSwapEventInsert[] {
  const rows: PoolSwapEventInsert[] = [];
  for (const log of logs) {
    const pool = poolByAddress.get(log.address.toLowerCase());
    if (pool === undefined) {
      throw new SwapDecodeError(`log from unwatched pool ${log.address}`, {
        blockNumber: log.blockNumber,
        logIndex: log.logIndex
      });
    }
    const normalized = normalizeSwapEvent(decodeSwapLog(log, pool));
    if (normalized !== null) {
      rows.push(toPoolSwapEventInsert(normalized, observedAt));
    }
  }
  return rows;
}

/**
 * Rolling-window snapshots for `pools`, reading exactly the widest window of
 * events in ONE multi-pool query — never a pool's full swap history.
 */
async function buildWindowedSnapshots(
  db: Db,
  chainId: number,
  pools: readonly PoolRow[],
  blockNumber: bigint,
  capturedAt: Date
): Promise<PoolActivitySnapshotInsert[]> {
  if (pools.length === 0) return [];
  const since = new Date(capturedAt.getTime() - ACTIVITY_MAX_WINDOW_MS);
  const events = await listPoolSwapEventsSince(
    db,
    chainId,
    pools.map((pool) => pool.poolAddress),
    since
  );
  const byPool = new Map<string, PoolSwapEventRow[]>();
  for (const event of events) {
    const key = event.poolAddress.toLowerCase();
    const bucket = byPool.get(key);
    if (bucket === undefined) byPool.set(key, [event]);
    else bucket.push(event);
  }
  return pools.map((pool) =>
    buildActivitySnapshot(
      pool,
      blockNumber,
      byPool.get(pool.poolAddress.toLowerCase()) ?? [],
      capturedAt
    )
  );
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * The staleness refresh lane: re-snapshot active pools whose latest rolling
 * snapshot has aged past the refresh window, so buyer windows decay even
 * when a pool stops trading. Never touches the cursor — it is pure snapshot
 * decay, safe to run on every pass including fully-caught-up ones.
 */
async function runRefreshLane(
  db: Db,
  chainId: number,
  active: ActivePoolCriteria,
  target: bigint,
  snapshotRefreshMs: number,
  limit: number
): Promise<number> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - snapshotRefreshMs);
  const pools = await listActiveTrustedQuotePoolsNeedingActivityRefresh(
    db,
    chainId,
    target,
    active,
    staleBefore,
    limit
  );
  if (pools.length === 0) return 0;
  const snapshots = await buildWindowedSnapshots(db, chainId, pools, target, now);
  return insertPoolActivitySnapshots(db, snapshots);
}

/**
 * Run one activity pass over already-discovered trusted-quote pools.
 *
 * Progress invariant: each chunk's normalized swaps, rolling snapshots, and
 * cursor advance commit in one transaction. Persistent RPC failure raises
 * ActivityHaltError and leaves the cursor at the last safe block.
 *
 * Scaling invariant (2026-07-11 incident): with `active` set, per-chunk work
 * is proportional to the active set, snapshots are written only for pools
 * with swaps in the chunk (plus the bounded refresh lane), and snapshot
 * construction reads only the widest rolling window of events — never a
 * pool's full swap history and never the all-time pool population.
 */
export async function runActivityPass(
  options: ActivityPassOptions
): Promise<ActivityPassResult> {
  const { db, logSource, config } = options;
  const chunkSize = options.chunkSize ?? 2_000n;
  const confirmations = options.confirmations ?? 0n;
  const snapshotRefreshMs =
    options.snapshotRefreshMs ?? DEFAULT_SNAPSHOT_REFRESH_MS;
  const refreshBatchLimit =
    options.refreshBatchLimit ?? DEFAULT_REFRESH_BATCH_LIMIT;
  if (chunkSize < 1n) {
    throw new RangeError(`chunkSize must be >= 1, got ${chunkSize}`);
  }

  const emptyResult = {
    chainId: config.chainId,
    ...EMPTY_RESULT_FIELDS
  };

  const discoveryCursor = await getCursor(db, config.chainId);
  if (discoveryCursor === undefined) return emptyResult;

  const latest = await withRetry(
    "getLatestBlockNumber",
    () => logSource.getLatestBlockNumber(),
    options.retry
  );
  const safeHead = latest > confirmations ? latest - confirmations : 0n;
  const target = minBigint(safeHead, discoveryCursor.latestProcessedBlock);

  let cursor = await getActivityCursor(db, config.chainId);
  if (cursor === undefined) {
    // First run only: the full-population read is a one-time cost to find
    // the earliest creation block, never a per-pass cost.
    const initialPools = await listTrustedQuotePoolsCreatedBefore(
      db,
      config.chainId,
      target
    );
    const initialProcessed =
      initialPools.length === 0
        ? target
        : bigintMin(initialPools.map((pool) => pool.createdAtBlock)) - 1n;
    await initializeActivityCursor(db, config.chainId, initialProcessed);
    cursor = await getActivityCursor(db, config.chainId);
    if (cursor === undefined) {
      throw new ActivityHaltError(
        "activity cursor missing after initialization",
        { fromBlock: initialProcessed + 1n, toBlock: target }
      );
    }
  }
  await recordActivityObservedBlock(db, config.chainId, latest);

  let from = cursor.latestProcessedBlock + 1n;
  if (from > target) {
    // Fully caught up: rolling windows must still decay.
    const refreshed =
      options.active === undefined
        ? 0
        : await runRefreshLane(
            db,
            config.chainId,
            options.active,
            cursor.latestProcessedBlock,
            snapshotRefreshMs,
            refreshBatchLimit
          );
    return { ...emptyResult, poolsRefreshed: refreshed };
  }

  const scannedFromBlock = from;
  let chunksProcessed = 0;
  let logsSeen = 0;
  let swapEventsInserted = 0;
  let snapshotsInserted = 0;
  let poolsSelected = 0;
  let stopped = false;

  while (from <= target) {
    if (options.signal?.aborted === true) {
      stopped = true;
      break;
    }
    const to = from + chunkSize - 1n > target ? target : from + chunkSize - 1n;
    const pools =
      options.active === undefined
        ? await listTrustedQuotePoolsCreatedBefore(db, config.chainId, to)
        : await listActiveTrustedQuotePoolsCreatedBefore(
            db,
            config.chainId,
            to,
            options.active
          );
    poolsSelected = Math.max(poolsSelected, pools.length);

    let logs: RawFactoryLog[] = [];
    if (pools.length > 0) {
      const addresses = pools.map((pool) => pool.poolAddress as Address);
      const topics = rangeTopics(pools);
      try {
        logs = await withRetry(
          `getLogs ${from}-${to}`,
          () => logSource.getLogs({ addresses, topics, fromBlock: from, toBlock: to }),
          options.retry
        );
      } catch (error) {
        if (error instanceof RetryExhaustedError) {
          throw new ActivityHaltError(
            "swap log fetch failed after bounded retries",
            { fromBlock: from, toBlock: to, cause: error }
          );
        }
        throw error;
      }
    }

    const poolByAddress = new Map(
      pools.map((pool) => [pool.poolAddress.toLowerCase(), pool] as const)
    );
    const capturedAt = new Date();
    const swapRows = normalizeChunkLogs(logs, poolByAddress, capturedAt);
    // Snapshot only pools this chunk actually touched — the refresh lane
    // owns decay for everything else.
    const touched = new Map<string, PoolRow>();
    for (const row of swapRows) {
      const key = row.poolAddress.toLowerCase();
      const pool = poolByAddress.get(key);
      if (pool !== undefined) touched.set(key, pool);
    }

    const inserted = await db.transaction(async (tx) => {
      const eventCount = await insertPoolSwapEvents(tx, swapRows);
      const snapshots = await buildWindowedSnapshots(
        tx,
        config.chainId,
        [...touched.values()],
        to,
        capturedAt
      );
      const snapshotCount = await insertPoolActivitySnapshots(tx, snapshots);
      await advanceActivityProcessedBlock(tx, config.chainId, to);
      return { eventCount, snapshotCount };
    });

    chunksProcessed += 1;
    logsSeen += logs.length;
    swapEventsInserted += inserted.eventCount;
    snapshotsInserted += inserted.snapshotCount;
    from = to + 1n;
  }

  const poolsRefreshed =
    options.active === undefined
      ? 0
      : await runRefreshLane(
          db,
          config.chainId,
          options.active,
          stopped ? from - 1n : target,
          snapshotRefreshMs,
          refreshBatchLimit
        );

  return {
    chainId: config.chainId,
    scannedFromBlock,
    scannedToBlock: stopped ? from - 1n : target,
    chunksProcessed,
    logsSeen,
    swapEventsInserted,
    snapshotsInserted,
    poolsSelected,
    poolsRefreshed,
    stopped
  };
}
