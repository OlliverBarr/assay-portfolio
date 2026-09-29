import { getAddress, isAddress, type Address } from "viem";

import { ChainConfigError } from "./errors.js";

/**
 * Which pool-creation event shape a factory emits.
 * `uniswap-v2`: PairCreated(token0, token1, pair, allPairsLength).
 * `uniswap-v3`: PoolCreated(token0, token1, fee, tickSpacing, pool).
 */
export type FactoryKind = "uniswap-v2" | "uniswap-v3";

export interface FactoryDescriptor {
  /** Human-readable DEX name, e.g. "uniswap". */
  readonly dex: string;
  readonly kind: FactoryKind;
  readonly address: Address;
  /** Block at which the factory was deployed; discovery never scans earlier. */
  readonly deploymentBlock: bigint;
}

export interface QuoteAssetConfig {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export interface ChainConfig {
  readonly chainId: number;
  readonly rpcUrls: readonly string[];
  readonly factories: readonly FactoryDescriptor[];
  /**
   * Allow-listed quote assets, in preference order. When both pool sides are
   * allow-listed, the earlier entry wins as the quote side.
   */
  readonly quoteAssets: readonly QuoteAssetConfig[];
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

function requireEnv(env: EnvSource, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value === "") {
    throw new ChainConfigError(key, "value is required but missing or empty");
  }
  return value;
}

function parseAddressEnv(env: EnvSource, key: string): Address | undefined {
  const value = env[key]?.trim();
  if (value === undefined || value === "") return undefined;
  if (!isAddress(value)) {
    throw new ChainConfigError(key, `"${value}" is not a valid EVM address`);
  }
  return getAddress(value);
}

function parseBigIntEnv(env: EnvSource, key: string): bigint | undefined {
  const value = env[key]?.trim();
  if (value === undefined || value === "") return undefined;
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) {
      throw new ChainConfigError(key, "block number must be non-negative");
    }
    return parsed;
  } catch (error) {
    if (error instanceof ChainConfigError) throw error;
    throw new ChainConfigError(key, `"${value}" is not a valid integer`);
  }
}

function parseFactory(
  env: EnvSource,
  dex: string,
  kind: FactoryKind,
  addressKey: string,
  startBlockKey: string
): FactoryDescriptor | undefined {
  const address = parseAddressEnv(env, addressKey);
  if (address === undefined) return undefined;
  const deploymentBlock = parseBigIntEnv(env, startBlockKey);
  if (deploymentBlock === undefined) {
    throw new ChainConfigError(
      startBlockKey,
      `required because ${addressKey} is set; discovery must never scan before the factory deployment block`
    );
  }
  return { dex, kind, address, deploymentBlock };
}

function parseQuoteAsset(
  env: EnvSource,
  symbol: string,
  decimals: number,
  addressKey: string
): QuoteAssetConfig | undefined {
  const address = parseAddressEnv(env, addressKey);
  if (address === undefined) return undefined;
  return { address, symbol, decimals };
}

/**
 * Build the chain configuration from environment variables.
 *
 * Factories and quote assets whose addresses are unset are omitted rather
 * than guessed, so the pipeline can run against a partial configuration
 * while chain constants are still being verified. Malformed values are a
 * hard error — never silently ignored.
 */
export function loadChainConfigFromEnv(env: EnvSource): ChainConfig {
  const chainIdRaw = requireEnv(env, "ROBINHOOD_CHAIN_ID");
  const chainId = Number(chainIdRaw);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new ChainConfigError(
      "ROBINHOOD_CHAIN_ID",
      `"${chainIdRaw}" is not a positive integer`
    );
  }

  const rpcUrl = requireEnv(env, "ROBINHOOD_CHAIN_RPC_URL");

  const factories: FactoryDescriptor[] = [];
  const v2 = parseFactory(
    env,
    "uniswap",
    "uniswap-v2",
    "UNISWAP_V2_FACTORY_ADDRESS",
    "UNISWAP_V2_FACTORY_START_BLOCK"
  );
  if (v2) factories.push(v2);
  const v3 = parseFactory(
    env,
    "uniswap",
    "uniswap-v3",
    "UNISWAP_V3_FACTORY_ADDRESS",
    "UNISWAP_V3_FACTORY_START_BLOCK"
  );
  if (v3) factories.push(v3);

  const quoteAssets: QuoteAssetConfig[] = [];
  const weth = parseQuoteAsset(env, "WETH", 18, "QUOTE_ASSET_WETH_ADDRESS");
  if (weth) quoteAssets.push(weth);
  const usdg = parseQuoteAsset(env, "USDG", 6, "QUOTE_ASSET_USDG_ADDRESS");
  if (usdg) quoteAssets.push(usdg);
  const usdc = parseQuoteAsset(env, "USDC", 6, "QUOTE_ASSET_USDC_ADDRESS");
  if (usdc) quoteAssets.push(usdc);
  // VIRTUAL last: classifyQuoteSide prefers earlier entries, so a
  // VIRTUAL/WETH pool keeps WETH as its quote side (matches existing rows).
  // Its USD price is chained through a live anchor each enrichment pass —
  // see packages/enrichment/src/anchor.ts.
  const virtual = parseQuoteAsset(env, "VIRTUAL", 18, "QUOTE_ASSET_VIRTUAL_ADDRESS");
  if (virtual) quoteAssets.push(virtual);

  return { chainId, rpcUrls: [rpcUrl], factories, quoteAssets };
}
