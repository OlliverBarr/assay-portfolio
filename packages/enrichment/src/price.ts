import { MAX_USD_WAD, WAD, mulDiv, pow10 } from "./fixed.js";

/**
 * Price math for pool state. All prices are WAD-scaled bigints denominating
 * "one whole base token, in whole quote tokens" (decimal-adjusted).
 *
 * V3 prices MUST derive from sqrtPriceX96 pool state — dividing token
 * balances of a concentrated-liquidity pool yields garbage.
 */

const Q192 = 2n ** 192n;

export interface V2PriceParams {
  readonly reserveBase: bigint;
  readonly reserveQuote: bigint;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
}

/**
 * V2 constant-product price of the base token in quote tokens.
 * Null when either reserve is zero — an empty pool has no price.
 */
export function v2PriceWad(params: V2PriceParams): bigint | null {
  if (params.reserveBase === 0n || params.reserveQuote === 0n) return null;
  // (reserveQuote / 10^qDec) / (reserveBase / 10^bDec), WAD-scaled.
  return mulDiv(
    params.reserveQuote * pow10(params.baseDecimals),
    WAD,
    params.reserveBase * pow10(params.quoteDecimals)
  );
}

export interface V3PriceParams {
  readonly sqrtPriceX96: bigint;
  /** True when the base token is token0 of the pool. */
  readonly baseIsToken0: boolean;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
}

/**
 * V3 price of the base token in quote tokens from slot0 state.
 * Raw price of token0 in token1 is sqrtPriceX96^2 / 2^192; the decimal
 * adjustment converts to whole-token terms. Null when sqrtPriceX96 is zero
 * (uninitialized pool).
 */
export function v3PriceWad(params: V3PriceParams): bigint | null {
  if (params.sqrtPriceX96 === 0n) return null;
  const priceX192 = params.sqrtPriceX96 * params.sqrtPriceX96;
  if (params.baseIsToken0) {
    // token1 per token0: raw * 10^dec0 / 10^dec1, WAD-scaled.
    return mulDiv(
      priceX192 * pow10(params.token0Decimals),
      WAD,
      Q192 * pow10(params.token1Decimals)
    );
  }
  // token0 per token1: inverse.
  return mulDiv(
    Q192 * pow10(params.token1Decimals),
    WAD,
    priceX192 * pow10(params.token0Decimals)
  );
}

/**
 * USD value of a raw token amount given the token's WAD USD price.
 * Returns null on overflow (adversarial supply/price data).
 */
export function usdValueWad(
  rawAmount: bigint,
  decimals: number,
  priceUsdWad: bigint
): bigint | null {
  const value = mulDiv(rawAmount, priceUsdWad, pow10(decimals));
  return value >= MAX_USD_WAD ? null : value;
}

/**
 * estimatedFdvUsd = price x reported total supply. Named "estimated"
 * because early tokens have no reliable circulating supply.
 */
export function estimatedFdvUsdWad(
  priceUsdWad: bigint,
  totalSupply: bigint,
  decimals: number
): bigint | null {
  return usdValueWad(totalSupply, decimals, priceUsdWad);
}
