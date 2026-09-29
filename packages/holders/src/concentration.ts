import { getAddress, zeroAddress, type Address } from "viem";

import type { HolderExclusionRecord } from "@assay/database";

/** Address zero — mint/burn origin, never an economic holder. */
const ZERO_ADDRESS: Address = getAddress(zeroAddress);
/** Canonical dead-address burn sink (`0x…dEaD`). */
const BURN_ADDRESS: Address = getAddress(
  "0x000000000000000000000000000000000000dEaD"
);

/** How many top holders the concentration metrics aggregate. */
const TOP_N = 10;

/** Reason string the pool address is declared under in `excluded` (see
 * `pass.ts`); reused to derive `supplyInPoolBps` without a separate
 * pool-address parameter. */
const POOL_EXCLUSION_REASON = "pool-address";

export interface ConcentrationInput {
  /** Token total supply in raw units; a denominator fallback when the scan
   * observed no positive balances (partial history). */
  readonly totalSupply: bigint;
  /** Caller-declared non-economic addresses (e.g. the pool) with reasons.
   * Zero and the canonical burn address are always added on top. */
  readonly excluded: readonly HolderExclusionRecord[];
  /** Resolved token deployer; null/absent when provenance is unknown. */
  readonly deployer?: Address | null;
}

export interface ConcentrationResult {
  readonly holderCount: number;
  readonly adjustedHolderCount: number;
  readonly largestHolderPctBps: number;
  readonly top10PctBps: number;
  readonly adjustedTop10PctBps: number;
  /**
   * Deployer's share of the adjusted circulating supply (same denominator as
   * `adjustedTop10PctBps`). Null when the deployer is unknown or is itself an
   * excluded non-economic address; 0 when resolved but holding nothing.
   */
  readonly deployerPctBps: number | null;
  /**
   * `(totalSupply - Σ excluded-holder balances - deployerBalance) / totalSupply`,
   * in bps, clamped to [0, 10000]. The deployer term is subtracted only when
   * the deployer is resolved AND not already one of the excluded addresses
   * (never double-subtracted). When the deployer is unresolved the term is
   * omitted entirely, so the value is a CEILING on the true float — the real
   * float can only be lower once the deployer resolves. Null when
   * `totalSupply` is 0 (denominator unknown).
   */
  readonly floatBps: number | null;
  /**
   * Share of `totalSupply` held by the pool address(es) declared in
   * `excluded` under {@link POOL_EXCLUSION_REASON}, in bps, clamped to
   * [0, 10000]. Null when `totalSupply` is 0.
   */
  readonly supplyInPoolBps: number | null;
  /** The excluded addresses that actually held a positive balance. */
  readonly excluded: HolderExclusionRecord[];
}

/**
 * Integer basis points of `numerator / denominator`, computed entirely in
 * bigint and clamped to [0, 10000] before the (now always-safe) `Number`
 * conversion. Unlike {@link toBps}, the numerator here can be negative
 * (stale total-supply metadata undercounting observed balances) or exceed
 * the denominator, so clamping happens on the bigint quotient itself —
 * never on a float — to stay exact for balances beyond
 * `Number.MAX_SAFE_INTEGER`.
 */
function toClampedBps(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  let bps = (numerator * 10_000n) / denominator;
  if (bps < 0n) bps = 0n;
  else if (bps > 10_000n) bps = 10_000n;
  return Number(bps);
}

/** Integer basis points of `numerator / denominator`, floored, clamped at 0. */
function toBps(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  return Number((numerator * 10_000n) / denominator);
}

/** Sum of the `n` largest entries of a descending-sorted balance list. */
function sumTop(sorted: readonly bigint[], n: number): bigint {
  const limit = Math.min(n, sorted.length);
  let sum = 0n;
  for (let i = 0; i < limit; i += 1) sum += sorted[i] ?? 0n;
  return sum;
}

/**
 * Concentration metrics for a set of holder balances.
 *
 * Percentages are basis points of the circulating supply (the sum of the
 * balances). "Adjusted" metrics drop non-economic holders — zero address, the
 * canonical burn address, and any caller-declared address such as the pool —
 * and are taken against the adjusted circulating supply. Exclusion is by
 * address identity only, never by token name/label. `floatBps` and
 * `supplyInPoolBps` are instead taken against `totalSupply` (see their
 * field docs on {@link ConcentrationResult}).
 */
export function computeConcentration(
  balances: ReadonlyMap<Address, bigint>,
  input: ConcentrationInput
): ConcentrationResult {
  const exclusionReasons = new Map<Address, string>();
  exclusionReasons.set(ZERO_ADDRESS, "zero-address");
  exclusionReasons.set(BURN_ADDRESS, "burn-address");
  for (const record of input.excluded) {
    const address = getAddress(record.address);
    if (!exclusionReasons.has(address)) {
      exclusionReasons.set(address, record.reason);
    }
  }

  let circulatingSum = 0n;
  let adjustedSum = 0n;
  let adjustedHolderCount = 0;
  const allValues: bigint[] = [];
  const adjustedValues: bigint[] = [];
  for (const [address, balance] of balances) {
    circulatingSum += balance;
    allValues.push(balance);
    if (!exclusionReasons.has(getAddress(address))) {
      adjustedSum += balance;
      adjustedValues.push(balance);
      adjustedHolderCount += 1;
    }
  }
  allValues.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  adjustedValues.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));

  const circulating = circulatingSum > 0n ? circulatingSum : input.totalSupply;
  const largest = allValues[0] ?? 0n;

  const excluded: HolderExclusionRecord[] = [];
  for (const [address, reason] of exclusionReasons) {
    if (balances.has(address)) excluded.push({ address, reason });
  }

  // Deployer balance, resolved once and reused for both `deployerPctBps`
  // (share of adjusted supply) and `floatBps` (subtracted from total
  // supply): null means the term does not apply — deployer unresolved or
  // itself already in the exclusion set — never subtract twice.
  let deployerBalance: bigint | null = null;
  if (input.deployer !== undefined && input.deployer !== null) {
    const deployer = getAddress(input.deployer);
    if (!exclusionReasons.has(deployer)) {
      deployerBalance = balances.get(deployer) ?? 0n;
    }
  }
  const deployerPctBps =
    deployerBalance === null ? null : toBps(deployerBalance, adjustedSum);

  // Sum of every exclusion-listed address that actually held a balance —
  // exactly circulatingSum (all holders) minus adjustedSum (non-excluded
  // holders only).
  const excludedBalanceSum = circulatingSum - adjustedSum;
  const floatBps =
    input.totalSupply === 0n
      ? null
      : toClampedBps(
          input.totalSupply - excludedBalanceSum - (deployerBalance ?? 0n),
          input.totalSupply
        );

  let poolBalance = 0n;
  for (const record of input.excluded) {
    if (record.reason === POOL_EXCLUSION_REASON) {
      poolBalance += balances.get(getAddress(record.address)) ?? 0n;
    }
  }
  const supplyInPoolBps =
    input.totalSupply === 0n
      ? null
      : toClampedBps(poolBalance, input.totalSupply);

  return {
    holderCount: balances.size,
    adjustedHolderCount,
    largestHolderPctBps: toBps(largest, circulating),
    top10PctBps: toBps(sumTop(allValues, TOP_N), circulating),
    adjustedTop10PctBps: toBps(sumTop(adjustedValues, TOP_N), adjustedSum),
    deployerPctBps,
    floatBps,
    supplyInPoolBps,
    excluded
  };
}
