import type { Address, Hex } from "viem";

import {
  poolCreationTopicByKind,
  withRetry,
  RetryExhaustedError,
  type ChainConfig,
  type FactoryDescriptor,
  type FactoryLogSource,
  type RawFactoryLog,
  type RetryOptions
} from "@assay/chain";
import {
  advanceProcessedBlock,
  getCursor,
  initializeCursor,
  insertPools,
  insertTokens,
  recordObservedBlock,
  type Db,
  type PoolInsert,
  type TokenInsert
} from "@assay/database";

import { decodePoolCreationLog, type PoolCreationEvent } from "./decode.js";
import { DiscoveryHaltError, PoolDecodeError } from "./errors.js";
import { classifyQuoteSide } from "./normalize.js";

export interface DiscoveryPassOptions {
  readonly db: Db;
  readonly logSource: FactoryLogSource;
  readonly config: ChainConfig;
  /** Blocks per getLogs request. Default 2000. */
  readonly chunkSize?: bigint;
  /** Head lag before a block is considered scannable. Default 0. */
  readonly confirmations?: bigint;
  readonly retry?: Partial<RetryOptions>;
  /**
   * Stops the pass at the next chunk boundary — a transactionally safe
   * point. Already-committed chunks stay committed; the result reports
   * partial progress via `stopped: true`.
   */
  readonly signal?: AbortSignal;
}

export interface DiscoveryPassResult {
  readonly chainId: number;
  /** Null when there was nothing to scan. */
  readonly scannedFromBlock: bigint | null;
  readonly scannedToBlock: bigint | null;
  readonly chunksProcessed: number;
  readonly logsSeen: number;
  readonly poolsInserted: number;
  /** True when the pass stopped early because the signal aborted. */
  readonly stopped: boolean;
}

function bigintMin(values: readonly bigint[]): bigint {
  let min = values[0];
  if (min === undefined) {
    throw new RangeError("bigintMin requires at least one value");
  }
  for (const value of values) {
    if (value < min) min = value;
  }
  return min;
}

function toPoolInsert(
  chainId: number,
  event: PoolCreationEvent,
  config: ChainConfig
): PoolInsert {
  const { quoteToken, baseTokenAddress } = classifyQuoteSide(
    event,
    config.quoteAssets
  );
  return {
    chainId,
    poolAddress: event.poolAddress,
    factoryAddress: event.factory.address,
    dex: event.factory.dex,
    factoryKind: event.factory.kind,
    token0Address: event.token0,
    token1Address: event.token1,
    feePpm: event.feePpm,
    tickSpacing: event.tickSpacing,
    quoteTokenAddress: quoteToken?.address ?? null,
    baseTokenAddress,
    createdAtBlock: event.blockNumber,
    createdTxHash: event.transactionHash,
    createdLogIndex: event.logIndex
  };
}

/**
 * Run one discovery pass: scan from the persisted cursor to the current
 * safe head in bounded chunks.
 *
 * Restart-safety invariant: each chunk's tokens, pools, and cursor advance
 * commit in ONE transaction. A crash or halt between chunks resumes exactly
 * at `latestProcessedBlock + 1` — no gaps, and re-scans are idempotent.
 */
export async function runDiscoveryPass(
  options: DiscoveryPassOptions
): Promise<DiscoveryPassResult> {
  const { db, logSource, config } = options;
  const chunkSize = options.chunkSize ?? 2_000n;
  const confirmations = options.confirmations ?? 0n;
  if (chunkSize < 1n) {
    throw new RangeError(`chunkSize must be >= 1, got ${chunkSize}`);
  }

  const emptyResult: DiscoveryPassResult = {
    chainId: config.chainId,
    scannedFromBlock: null,
    scannedToBlock: null,
    chunksProcessed: 0,
    logsSeen: 0,
    poolsInserted: 0,
    stopped: false
  };

  if (config.factories.length === 0) return emptyResult;

  const factoryByAddress = new Map<string, FactoryDescriptor>(
    config.factories.map((factory) => [
      factory.address.toLowerCase(),
      factory
    ])
  );
  const addresses: Address[] = config.factories.map((f) => f.address);
  const topics: Hex[] = [
    ...new Set(config.factories.map((f) => poolCreationTopicByKind[f.kind]))
  ];

  const latest = await withRetry(
    "getLatestBlockNumber",
    () => logSource.getLatestBlockNumber(),
    options.retry
  );

  // First run: consider everything before the earliest factory deployment
  // as already processed, so scanning starts at the deployment block.
  const initialProcessed =
    bigintMin(config.factories.map((f) => f.deploymentBlock)) - 1n;
  await initializeCursor(db, config.chainId, initialProcessed);
  const cursor = await getCursor(db, config.chainId);
  if (cursor === undefined) {
    throw new DiscoveryHaltError("cursor missing after initialization", {
      fromBlock: initialProcessed + 1n,
      toBlock: latest
    });
  }
  await recordObservedBlock(db, config.chainId, latest);

  const target = latest - confirmations;
  let from = cursor.latestProcessedBlock + 1n;
  if (from > target) return emptyResult;

  const scannedFromBlock = from;
  let chunksProcessed = 0;
  let logsSeen = 0;
  let poolsInserted = 0;

  let stopped = false;
  while (from <= target) {
    if (options.signal?.aborted === true) {
      stopped = true;
      break;
    }
    const to = from + chunkSize - 1n > target ? target : from + chunkSize - 1n;

    let logs: RawFactoryLog[];
    try {
      logs = await withRetry(
        `getLogs ${from}-${to}`,
        () => logSource.getLogs({ addresses, topics, fromBlock: from, toBlock: to }),
        options.retry
      );
    } catch (error) {
      if (error instanceof RetryExhaustedError) {
        // Cursor stays at the last committed chunk; never skip a range.
        throw new DiscoveryHaltError(
          "log fetch failed after bounded retries",
          { fromBlock: from, toBlock: to, cause: error }
        );
      }
      throw error;
    }

    const events: PoolCreationEvent[] = [];
    for (const log of logs) {
      const factory = factoryByAddress.get(log.address.toLowerCase());
      if (factory === undefined) {
        throw new PoolDecodeError(
          `log from unwatched address ${log.address}`,
          { blockNumber: log.blockNumber, logIndex: log.logIndex }
        );
      }
      events.push(decodePoolCreationLog(log, factory));
    }

    // Duplicate log delivery within a chunk: keep the first occurrence.
    const uniqueEvents = new Map<string, PoolCreationEvent>();
    for (const event of events) {
      const key = event.poolAddress.toLowerCase();
      if (!uniqueEvents.has(key)) uniqueEvents.set(key, event);
    }

    const poolRows: PoolInsert[] = [];
    const tokenFirstSeen = new Map<Address, bigint>();
    for (const event of uniqueEvents.values()) {
      poolRows.push(toPoolInsert(config.chainId, event, config));
      for (const token of [event.token0, event.token1]) {
        const seen = tokenFirstSeen.get(token);
        if (seen === undefined || event.blockNumber < seen) {
          tokenFirstSeen.set(token, event.blockNumber);
        }
      }
    }
    const tokenRows: TokenInsert[] = [...tokenFirstSeen.entries()].map(
      ([address, firstSeenBlock]) => ({
        chainId: config.chainId,
        address,
        firstSeenBlock
      })
    );

    // Atomic unit of progress: pools, tokens, and cursor advance together.
    const insertedInChunk = await db.transaction(async (tx) => {
      await insertTokens(tx, tokenRows);
      const inserted = await insertPools(tx, poolRows);
      await advanceProcessedBlock(tx, config.chainId, to);
      return inserted;
    });

    chunksProcessed += 1;
    logsSeen += logs.length;
    poolsInserted += insertedInChunk;
    from = to + 1n;
  }

  return {
    chainId: config.chainId,
    scannedFromBlock,
    // When stopped early, report the last committed block, not the target.
    scannedToBlock: stopped ? from - 1n : target,
    chunksProcessed,
    logsSeen,
    poolsInserted,
    stopped
  };
}
