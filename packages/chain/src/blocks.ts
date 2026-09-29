import { withRetry, type RetryOptions } from "./retry.js";

/** Minimal block-header reader; satisfied by a viem `PublicClient`. */
export interface BlockTimestampReader {
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

export interface BlockSearchBounds {
  /** Lowest block worth considering (e.g. earliest factory deployment). */
  readonly minBlock: bigint;
  /** Current chain head (or any block known to exist). */
  readonly headBlock: bigint;
}

/**
 * First block whose timestamp is >= `targetTimestamp` (unix seconds), found
 * by binary search over the chain's monotonically non-decreasing block
 * timestamps. O(log n) `eth_getBlockByNumber` calls.
 *
 * Boundary semantics:
 * - Every block in bounds is older than the target -> `headBlock + 1n`
 *   (callers comparing `block >= result` then match nothing, correctly).
 * - The block at `minBlock` already meets the target -> `minBlock`.
 *
 * This exists because wall-clock columns like `discovered_at` reflect when
 * WE ingested a row, not when the chain produced it — after a backfill or
 * downtime catch-up they misclassify old pools as young. On-chain age must
 * be measured in blocks.
 */
export async function findBlockNumberByTimestamp(
  reader: BlockTimestampReader,
  targetTimestamp: bigint,
  bounds: BlockSearchBounds,
  retry?: Partial<RetryOptions>
): Promise<bigint> {
  if (bounds.minBlock > bounds.headBlock) {
    throw new RangeError(
      `minBlock ${bounds.minBlock} exceeds headBlock ${bounds.headBlock}`
    );
  }
  const timestampAt = async (blockNumber: bigint): Promise<bigint> => {
    const block = await withRetry(
      `getBlock(${blockNumber})`,
      () => reader.getBlock({ blockNumber }),
      retry
    );
    return block.timestamp;
  };

  let low = bounds.minBlock;
  let high = bounds.headBlock;
  if ((await timestampAt(high)) < targetTimestamp) return high + 1n;
  if ((await timestampAt(low)) >= targetTimestamp) return low;

  // Invariant: ts(low) < target <= ts(high).
  while (high - low > 1n) {
    const mid = low + (high - low) / 2n;
    if ((await timestampAt(mid)) >= targetTimestamp) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return high;
}
