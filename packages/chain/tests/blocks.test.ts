import { describe, expect, it } from "vitest";

import { findBlockNumberByTimestamp, type BlockTimestampReader } from "../src/blocks.js";

/**
 * Synthetic chain: block n has timestamp 1000 + 2n (monotone, non-strict
 * duplicates injected below). Records every block fetched so tests can
 * assert the search stays logarithmic.
 */
function makeReader(
  timestamps: ReadonlyMap<bigint, bigint>
): BlockTimestampReader & { reads: bigint[] } {
  const reads: bigint[] = [];
  return {
    reads,
    getBlock: ({ blockNumber }) => {
      reads.push(blockNumber);
      const timestamp = timestamps.get(blockNumber);
      if (timestamp === undefined) {
        throw new Error(`unexpected block ${blockNumber}`);
      }
      return Promise.resolve({ timestamp });
    }
  };
}

function linearChain(min: bigint, head: bigint): Map<bigint, bigint> {
  const map = new Map<bigint, bigint>();
  for (let n = min; n <= head; n += 1n) map.set(n, 1000n + 2n * n);
  return map;
}

const BOUNDS = { minBlock: 10n, headBlock: 500n };

describe("findBlockNumberByTimestamp", () => {
  it("finds the first block at or after the target timestamp", async () => {
    const reader = makeReader(linearChain(10n, 500n));
    // Block 250 has ts 1500; target 1499 -> still block 250 (first >= 1499).
    await expect(
      findBlockNumberByTimestamp(reader, 1499n, BOUNDS)
    ).resolves.toBe(250n);
    await expect(
      findBlockNumberByTimestamp(reader, 1500n, BOUNDS)
    ).resolves.toBe(250n);
    // Target 1501 -> block 251 (ts 1502).
    await expect(
      findBlockNumberByTimestamp(reader, 1501n, BOUNDS)
    ).resolves.toBe(251n);
  });

  it("returns minBlock when even the oldest block meets the target", async () => {
    const reader = makeReader(linearChain(10n, 500n));
    await expect(findBlockNumberByTimestamp(reader, 0n, BOUNDS)).resolves.toBe(
      10n
    );
  });

  it("returns head + 1 when no block is recent enough", async () => {
    const reader = makeReader(linearChain(10n, 500n));
    // Head ts is 2000; a future target matches nothing.
    await expect(
      findBlockNumberByTimestamp(reader, 999_999n, BOUNDS)
    ).resolves.toBe(501n);
  });

  it("returns the FIRST block of a duplicate-timestamp run", async () => {
    const timestamps = linearChain(10n, 500n);
    // Blocks 300..310 all share ts 5000 (idle chain burst semantics).
    for (let n = 300n; n <= 310n; n += 1n) timestamps.set(n, 5000n);
    for (let n = 311n; n <= 500n; n += 1n) timestamps.set(n, 5000n + n);
    const reader = makeReader(timestamps);
    await expect(
      findBlockNumberByTimestamp(reader, 5000n, BOUNDS)
    ).resolves.toBe(300n);
  });

  it("stays logarithmic in the search span", async () => {
    const reader = makeReader(linearChain(10n, 500n));
    await findBlockNumberByTimestamp(reader, 1500n, BOUNDS);
    // 490-block span: 2 boundary probes + <= ceil(log2(490)) bisections.
    expect(reader.reads.length).toBeLessThanOrEqual(11);
  });

  it("rejects inverted bounds", async () => {
    const reader = makeReader(linearChain(10n, 500n));
    await expect(
      findBlockNumberByTimestamp(reader, 1500n, {
        minBlock: 500n,
        headBlock: 10n
      })
    ).rejects.toThrow(RangeError);
  });
});
