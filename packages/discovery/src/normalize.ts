import type { Address } from "viem";

import type { QuoteAssetConfig } from "@assay/chain";

import type { PoolCreationEvent } from "./decode.js";

export interface QuoteClassification {
  /** The allow-listed side, or null when neither side is trusted. */
  readonly quoteToken: QuoteAssetConfig | null;
  /** The non-quote side, or null when no quote side exists. */
  readonly baseTokenAddress: Address | null;
}

/**
 * Decide which pool side is the trusted quote asset.
 *
 * Only explicit allow-list membership counts — symbols and names are never
 * trusted. When both sides are allow-listed (e.g. WETH/USDC), the asset
 * earlier in the configured preference order wins as the quote side.
 */
export function classifyQuoteSide(
  event: Pick<PoolCreationEvent, "token0" | "token1">,
  quoteAssets: readonly QuoteAssetConfig[]
): QuoteClassification {
  for (const asset of quoteAssets) {
    if (asset.address === event.token0) {
      return { quoteToken: asset, baseTokenAddress: event.token1 };
    }
    if (asset.address === event.token1) {
      return { quoteToken: asset, baseTokenAddress: event.token0 };
    }
  }
  return { quoteToken: null, baseTokenAddress: null };
}
