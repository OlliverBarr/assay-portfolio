import type { Address, Hex, PublicClient } from "viem";

import { withRetry, type RetryOptions } from "@assay/chain";

import type { ExplorerContractResult } from "./verification.js";

/**
 * Minimal chain-read surface for risk analysis. `PublicClient` satisfies the
 * on-chain methods structurally; tests substitute deterministic fakes. Reads
 * may throw — infra failures surface as RetryExhaustedError and the pass halts.
 */
export interface RiskReader {
  getCode(address: Address): Promise<Hex | null>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex | null>;
  getBlockNumber(): Promise<bigint>;
  /** Explorer verification lookup; null when unavailable (never throws for a miss). */
  fetchContractVerification(
    address: Address
  ): Promise<ExplorerContractResult | null>;
}

interface ExplorerSourceResponse {
  readonly status?: string;
  readonly result?: ExplorerContractResult[] | string;
}

export interface RiskReaderOptions {
  /** Blockscout base URL; when absent, verification is always UNKNOWN. */
  readonly explorerUrl?: string;
  readonly retry?: Partial<RetryOptions>;
}

/** Production {@link RiskReader} over a viem public client + Blockscout. */
export function createRiskReader(
  client: PublicClient,
  options: RiskReaderOptions = {}
): RiskReader {
  const { explorerUrl, retry } = options;
  return {
    async getCode(address) {
      const code = await withRetry(
        `getCode ${address}`,
        () => client.getBytecode({ address }),
        retry
      );
      return code ?? null;
    },
    async getStorageAt(address, slot) {
      const value = await withRetry(
        `getStorageAt ${address}`,
        () => client.getStorageAt({ address, slot }),
        retry
      );
      return value ?? null;
    },
    getBlockNumber() {
      return withRetry("getBlockNumber", () => client.getBlockNumber(), retry);
    },
    async fetchContractVerification(address) {
      if (explorerUrl === undefined || explorerUrl === "") return null;
      const url =
        `${explorerUrl}/api?module=contract&action=getsourcecode` +
        `&address=${address}`;
      let response: Response;
      try {
        response = await fetch(url);
      } catch {
        // Explorer unreachable is a missing signal, not a token verdict.
        return null;
      }
      if (!response.ok) return null;
      let body: ExplorerSourceResponse;
      try {
        body = (await response.json()) as ExplorerSourceResponse;
      } catch {
        // A truncated/garbage explorer body is a missing signal (UNKNOWN
        // verification), never a worker crash. Observed live 2026-07-11.
        return null;
      }
      if (!Array.isArray(body.result)) return null;
      return body.result[0] ?? null;
    }
  };
}
