/**
 * WAD fixed-point arithmetic (18 implied decimal places) over bigint.
 *
 * This is the ONLY numeric representation for derived financial values
 * (prices, USD amounts). Raw on-chain integers stay raw bigint; JS `number`
 * never touches either. Values are persisted as decimal strings into
 * postgres numeric(60,18) columns.
 */

export const WAD = 10n ** 18n;

/**
 * Values at or above this are treated as overflow (reason "overflow"):
 * numeric(60,18) holds 42 integer digits; 10^36 USD is already absurd, so
 * anything larger is adversarial supply/price data, not information.
 */
export const MAX_USD_WAD = 10n ** 36n * WAD;

/** floor(a * b / denominator), exact in bigint. */
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError("mulDiv division by zero");
  }
  return (a * b) / denominator;
}

/** 10^exp for non-negative exp. */
export function pow10(exp: number): bigint {
  if (!Number.isSafeInteger(exp) || exp < 0) {
    throw new RangeError(`pow10 exponent must be a non-negative integer, got ${exp}`);
  }
  return 10n ** BigInt(exp);
}

/**
 * Format a WAD value as a plain decimal string, trailing zeros trimmed
 * ("2500", "0.000000000001", "-1.5"). Exact — no rounding beyond the WAD
 * resolution the value already has.
 */
export function formatWad(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const integer = abs / WAD;
  const fraction = abs % WAD;
  const sign = negative ? "-" : "";
  if (fraction === 0n) return `${sign}${integer}`;
  const fractionStr = fraction.toString().padStart(18, "0").replace(/0+$/, "");
  return `${sign}${integer}.${fractionStr}`;
}
