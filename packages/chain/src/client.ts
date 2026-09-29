import { createPublicClient, defineChain, http, type PublicClient } from "viem";

import type { ChainConfig } from "./config.js";
import { ChainConfigError } from "./errors.js";

/**
 * Canonical Multicall3 deployment, present at the same address on virtually
 * every EVM chain. Verified live on Robinhood Chain via `eth_getCode`
 * 2026-07-11 — see docs/data-sources.md.
 */
export const MULTICALL3_ADDRESS =
  "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/**
 * Create a viem public client for the configured chain.
 *
 * `readContract`/`eth_call`s issued within the same 16ms window are coalesced
 * into a single Multicall3 `aggregate3` request (allowFailure per sub-call, so
 * one adversarial revert never poisons its batch-mates). This divides RPC
 * compute-unit cost roughly by the batch size for state-read-heavy passes.
 *
 * viem's transport-level retry is disabled: retries are handled by
 * {@link withRetry} at the call site so attempts stay bounded, observable,
 * and classified in one place.
 */
export function createChainPublicClient(config: ChainConfig): PublicClient {
  const url = config.rpcUrls[0];
  if (url === undefined) {
    throw new ChainConfigError("rpcUrls", "at least one RPC URL is required");
  }
  const chain = defineChain({
    id: config.chainId,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [...config.rpcUrls] } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } }
  });
  return createPublicClient({
    chain,
    transport: http(url, { retryCount: 0 }),
    batch: { multicall: { wait: 16 } }
  });
}
