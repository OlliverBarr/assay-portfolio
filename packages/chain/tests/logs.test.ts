import { describe, expect, it } from "vitest";
import {
  HttpRequestError,
  ResponseBodyTooLargeError,
  type PublicClient
} from "viem";

import { createRpcLogSource, fetchLogsBisectingOversized } from "../src/index.js";

/** Streaming abort at the cap: viem reports the cap, not the true size. */
function oversizedError(): ResponseBodyTooLargeError {
  return new ResponseBodyTooLargeError({ maxSize: 10, size: 11 });
}

interface FakeLog {
  readonly blockNumber: bigint;
  readonly tag: string;
}

/**
 * Range fetcher over a fixed per-block log table that throws viem's
 * oversized-response error whenever a range holds more than `maxPerResponse`
 * logs, recording every requested range.
 */
function fakeFetcher(
  logsByBlock: ReadonlyMap<bigint, readonly string[]>,
  maxPerResponse: number,
  wrap: (error: ResponseBodyTooLargeError) => Error = (error) => error
) {
  const calls: Array<{ from: bigint; to: bigint }> = [];
  const fetchRange = (from: bigint, to: bigint): Promise<readonly FakeLog[]> => {
    calls.push({ from, to });
    const logs: FakeLog[] = [];
    for (let block = from; block <= to; block += 1n) {
      for (const tag of logsByBlock.get(block) ?? []) {
        logs.push({ blockNumber: block, tag });
      }
    }
    if (logs.length > maxPerResponse) {
      return Promise.reject(wrap(oversizedError()));
    }
    return Promise.resolve(logs);
  };
  return { calls, fetchRange };
}

describe("fetchLogsBisectingOversized", () => {
  it("returns a fitting response from a single fetch", async () => {
    const { calls, fetchRange } = fakeFetcher(
      new Map([
        [1n, ["a"]],
        [3n, ["b"]]
      ]),
      10
    );
    const logs = await fetchLogsBisectingOversized(1n, 4n, fetchRange);
    expect(logs.map((log) => log.tag)).toEqual(["a", "b"]);
    expect(calls).toEqual([{ from: 1n, to: 4n }]);
  });

  it("bisects only the oversized half and preserves block order", async () => {
    // Blocks 1-8; the density sits in 6-7, so the left half must fetch
    // whole while the right half splits until each piece fits.
    const { calls, fetchRange } = fakeFetcher(
      new Map([
        [1n, ["a"]],
        [6n, ["b", "c"]],
        [7n, ["d", "e"]],
        [8n, ["f"]]
      ]),
      2
    );
    const logs = await fetchLogsBisectingOversized(1n, 8n, fetchRange);
    expect(logs.map((log) => log.tag)).toEqual(["a", "b", "c", "d", "e", "f"]);
    // 1-8 overflows, 1-4 fits, 5-8 overflows, 5-6 fits, 7-8 overflows,
    // then 7 and 8 fetch alone.
    expect(calls).toEqual([
      { from: 1n, to: 8n },
      { from: 1n, to: 4n },
      { from: 5n, to: 8n },
      { from: 5n, to: 6n },
      { from: 7n, to: 8n },
      { from: 7n, to: 7n },
      { from: 8n, to: 8n }
    ]);
  });

  it("detects the oversize abort wrapped in another viem error's cause chain", async () => {
    const { fetchRange } = fakeFetcher(
      new Map([
        [1n, ["a", "b"]],
        [2n, ["c", "d"]]
      ]),
      2,
      (error) =>
        new HttpRequestError({ url: "https://rpc.test", cause: error })
    );
    const logs = await fetchLogsBisectingOversized(1n, 2n, fetchRange);
    expect(logs.map((log) => log.tag)).toEqual(["a", "b", "c", "d"]);
  });

  it("rethrows when a single block still overflows the cap", async () => {
    const { calls, fetchRange } = fakeFetcher(
      new Map([[3n, ["a", "b", "c"]]]),
      2
    );
    await expect(
      fetchLogsBisectingOversized(1n, 4n, fetchRange)
    ).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    // The failing single block is never re-fetched in a loop.
    expect(calls.filter((call) => call.from === 3n && call.to === 3n)).toHaveLength(1);
  });

  it("propagates non-oversize errors without splitting", async () => {
    let callCount = 0;
    await expect(
      fetchLogsBisectingOversized(1n, 100n, () => {
        callCount += 1;
        return Promise.reject(new Error("rpc down"));
      })
    ).rejects.toThrow("rpc down");
    expect(callCount).toBe(1);
  });
});

describe("createRpcLogSource oversized responses", () => {
  const TOPIC =
    "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9" as const;

  it("bisects an oversized getLogs range and still filters/maps the result", async () => {
    const ranges: Array<{ from: bigint; to: bigint }> = [];
    const client = {
      getLogs(args: { fromBlock: bigint; toBlock: bigint }) {
        ranges.push({ from: args.fromBlock, to: args.toBlock });
        if (args.toBlock - args.fromBlock >= 1n) {
          return Promise.reject(oversizedError());
        }
        return Promise.resolve([
          {
            address: "0x1111111111111111111111111111111111111111",
            blockNumber: args.fromBlock,
            transactionHash: `0x${"ab".repeat(32)}`,
            logIndex: 0,
            topics: [TOPIC],
            data: "0x"
          },
          {
            // Unwanted topic0: must be filtered out, exactly as unsplit.
            address: "0x2222222222222222222222222222222222222222",
            blockNumber: args.fromBlock,
            transactionHash: `0x${"cd".repeat(32)}`,
            logIndex: 1,
            topics: [`0x${"00".repeat(32)}`],
            data: "0x"
          }
        ]);
      }
    } as unknown as PublicClient;

    const source = createRpcLogSource(client);
    const logs = await source.getLogs({
      addresses: ["0x1111111111111111111111111111111111111111"],
      topics: [TOPIC],
      fromBlock: 10n,
      toBlock: 11n
    });

    expect(ranges).toEqual([
      { from: 10n, to: 11n },
      { from: 10n, to: 10n },
      { from: 11n, to: 11n }
    ]);
    expect(logs.map((log) => log.blockNumber)).toEqual([10n, 11n]);
    expect(logs.every((log) => log.topics[0] === TOPIC)).toBe(true);
  });
});
