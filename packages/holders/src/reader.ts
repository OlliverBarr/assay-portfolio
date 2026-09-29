import { getAddress, isAddress, parseAbiItem, type Address, type PublicClient } from "viem";

import {
  fetchLogsBisectingOversized,
  withRetry,
  type RetryOptions
} from "@assay/chain";

/** Standard ERC-20 transfer event; the only source of truth for balances. */
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

/** Default block span per `getLogs` call to stay under provider range caps. */
const DEFAULT_CHUNK_SIZE = 2_000n;

/** One decoded ERC-20 transfer: raw token units move `from` -> `to`. */
export interface Erc20Transfer {
  readonly from: Address;
  readonly to: Address;
  readonly valueRaw: bigint;
}

/**
 * One entry of the Etherscan-compatible `getcontractcreation` result, as
 * Blockscout returns it. Only the creator is typed; the rest is ignored.
 */
interface ExplorerCreationEntry {
  readonly contractCreator?: string;
}

interface ExplorerCreationResponse {
  readonly status?: string;
  readonly result?: ExplorerCreationEntry[] | string | null;
}

/** Retryable explorer failure: unreachable, rate-limited, or 5xx. */
class ExplorerTransientError extends Error {
  override readonly name = "ExplorerTransientError";
}

/**
 * Minimal chain-read surface for holder enumeration. `PublicClient` satisfies
 * it structurally; tests substitute deterministic fakes. Reads may throw —
 * infra failures surface as RetryExhaustedError and the pass halts.
 */
export interface HolderReader {
  getErc20TransferLogs(
    token: Address,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<Erc20Transfer[]>;
  getBlockNumber(): Promise<bigint>;
  /**
   * Explorer contract-creator lookup; null when unavailable (never throws for
   * a miss). Null is a missing signal, not a provenance verdict.
   */
  fetchContractCreation(address: Address): Promise<Address | null>;
}

export interface HolderReaderOptions {
  /** Max block span per `getLogs` request. Must be >= 1. */
  readonly chunkSize?: bigint;
  /** Blockscout base URL; when absent, deployer resolution is always null. */
  readonly explorerUrl?: string;
  readonly retry?: Partial<RetryOptions>;
}

/** Production {@link HolderReader} over a viem public client + Blockscout. */
export function createHolderReader(
  client: PublicClient,
  options: HolderReaderOptions = {}
): HolderReader {
  const chunkSize =
    options.chunkSize !== undefined && options.chunkSize > 0n
      ? options.chunkSize
      : DEFAULT_CHUNK_SIZE;
  const { explorerUrl, retry } = options;
  return {
    async getErc20TransferLogs(token, fromBlock, toBlock) {
      const transfers: Erc20Transfer[] = [];
      for (let start = fromBlock; start <= toBlock; start += chunkSize) {
        const last = start + chunkSize - 1n;
        const end = last < toBlock ? last : toBlock;
        const logs = await withRetry(
          `getErc20TransferLogs ${token} ${start}-${end}`,
          () =>
            fetchLogsBisectingOversized(start, end, (fromBlock, toBlock) =>
              client.getLogs({
                address: token,
                event: transferEvent,
                fromBlock,
                toBlock
              })
            ),
          retry
        );
        for (const log of logs) {
          const { from, to, value } = log.args;
          if (from === undefined || to === undefined || value === undefined) {
            // A well-formed Transfer always carries all three; a missing arg
            // means a malformed/impostor log — skip it rather than mis-net.
            continue;
          }
          transfers.push({
            from: getAddress(from),
            to: getAddress(to),
            valueRaw: value
          });
        }
      }
      return transfers;
    },
    getBlockNumber() {
      return withRetry("getBlockNumber", () => client.getBlockNumber(), retry);
    },
    async fetchContractCreation(address) {
      if (explorerUrl === undefined || explorerUrl === "") return null;
      const url =
        `${explorerUrl}/api?module=contract&action=getcontractcreation` +
        `&contractaddresses=${address}`;
      let body: ExplorerCreationResponse | null;
      try {
        // Measured live: this Blockscout endpoint 500s intermittently even
        // for indexed contracts, so transient failures get bounded retries.
        // Exhaustion is still a missing signal (null), never a pass halt.
        body = await withRetry(
          `fetchContractCreation ${address}`,
          async () => {
            let response: Response;
            try {
              response = await fetch(url);
            } catch (cause) {
              throw new ExplorerTransientError("explorer unreachable", {
                cause
              });
            }
            if (response.status === 429 || response.status >= 500) {
              throw new ExplorerTransientError(
                `explorer HTTP ${response.status}`
              );
            }
            // Any other non-OK answer is a permanent miss, not worth retrying.
            if (!response.ok) return null;
            try {
              return (await response.json()) as ExplorerCreationResponse;
            } catch {
              return null;
            }
          },
          { ...retry, isRetryable: (error) => error instanceof ExplorerTransientError }
        );
      } catch {
        // Explorer down is a missing signal, not a provenance verdict.
        return null;
      }
      if (body === null || !Array.isArray(body.result)) return null;
      const creator = body.result[0]?.contractCreator;
      // Blockscout returns lowercase hex; checksum before trusting it.
      if (creator === undefined || !isAddress(creator)) return null;
      return getAddress(creator);
    }
  };
}
