import { BaseError, ResponseBodyTooLargeError } from "viem";
import type { Address, Hex, PublicClient } from "viem";

/**
 * A raw factory log, undecoded. Discovery owns decoding so the chain
 * package stays free of product logic.
 */
export interface RawFactoryLog {
  readonly address: Address;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface GetLogsParams {
  readonly addresses: readonly Address[];
  /** topic0 filter — pool-creation event selectors only. */
  readonly topics: readonly Hex[];
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

/**
 * Minimal log-source abstraction. Production uses an RPC-backed
 * implementation; tests substitute deterministic fixtures.
 */
export interface FactoryLogSource {
  getLogs(params: GetLogsParams): Promise<RawFactoryLog[]>;
  getLatestBlockNumber(): Promise<bigint>;
}

/**
 * Run a block-range log fetch, recursively bisecting the range whenever the
 * response exceeds viem's body-size cap (`maxResponseBodySize`, default
 * 10 MiB; the transport cancels the body mid-stream, so the reported size
 * is only a lower bound), concatenating the halves in block order. Halves
 * fetch sequentially: bisection must not multiply concurrent RPC load
 * exactly when the provider is returning its largest responses.
 *
 * A single block whose logs still overflow the cap cannot be split further
 * and rethrows; that is a genuine halt, not an event to skip (live incident
 * 2026-07-16: one dense swap stretch crash-looped the worker for 4.7h
 * because this error was neither retryable nor splittable anywhere).
 */
export async function fetchLogsBisectingOversized<T>(
  fromBlock: bigint,
  toBlock: bigint,
  fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>
): Promise<T[]> {
  try {
    return [...(await fetchRange(fromBlock, toBlock))];
  } catch (error) {
    const oversized =
      error instanceof BaseError &&
      error.walk((cause) => cause instanceof ResponseBodyTooLargeError) !==
        null;
    if (!oversized || fromBlock >= toBlock) throw error;
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    const left = await fetchLogsBisectingOversized(fromBlock, mid, fetchRange);
    const right = await fetchLogsBisectingOversized(
      mid + 1n,
      toBlock,
      fetchRange
    );
    left.push(...right);
    return left;
  }
}

/** RPC-backed {@link FactoryLogSource} using a viem public client. */
export function createRpcLogSource(client: PublicClient): FactoryLogSource {
  return {
    async getLogs(params) {
      const logs = await fetchLogsBisectingOversized(
        params.fromBlock,
        params.toBlock,
        (fromBlock, toBlock) =>
          client.getLogs({
            address: [...params.addresses],
            fromBlock,
            toBlock
          })
      );
      const wanted = new Set(params.topics);
      return logs
        .filter((log) => log.topics[0] !== undefined && wanted.has(log.topics[0]))
        .map((log) => {
          if (
            log.blockNumber === null ||
            log.transactionHash === null ||
            log.logIndex === null
          ) {
            // Pending logs must never reach the pipeline; the poller only
            // requests finalized ranges, so this indicates a broken provider.
            throw new Error(
              `RPC returned a pending log for range ${params.fromBlock}-${params.toBlock}`
            );
          }
          return {
            address: log.address,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
            topics: log.topics,
            data: log.data
          };
        });
    },
    async getLatestBlockNumber() {
      return client.getBlockNumber();
    }
  };
}
