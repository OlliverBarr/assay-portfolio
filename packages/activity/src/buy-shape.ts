/**
 * Buy-shape signals over a pool's 1h window BUY swaps: how concentrated,
 * how "natural", and how bot-like the buy sizes look.
 *
 * All aggregation is done in bigint (raw on-chain quote amounts can exceed
 * 2^53 and must never lose precision). Floating point is used only for the
 * final log-based ratios (entropy) and is bounded so it never touches a raw
 * bigint magnitude directly — see `computeBuySizeEntropyBps`.
 */

/** One BUY event's contribution to the 1h window, already filtered to it. */
export interface BuyShapeEvent {
  /** Buyer identity — same field used for unique-buyer counting (BUY recipient, lowercased). */
  readonly buyer: string;
  /** Raw quote-token amount spent on this BUY. */
  readonly quoteAmountRaw: bigint;
}

function clampBps(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(10000, Math.max(0, Math.round(value)));
}

function aggregateBuyerTotals(events: readonly BuyShapeEvent[]): bigint[] {
  const totals = new Map<string, bigint>();
  for (const event of events) {
    totals.set(event.buyer, (totals.get(event.buyer) ?? 0n) + event.quoteAmountRaw);
  }
  return [...totals.values()];
}

/**
 * Gini coefficient of per-buyer quote spend totals, in bps.
 * 0 = every buyer spent the same amount, 10000 = one buyer holds all volume.
 * 0 or 1 distinct buyers -> null (concentration is undefined/meaningless).
 *
 * Computed with the standard sorted-index formula, entirely in bigint until
 * the final bps division, so magnitudes beyond 2^53 never lose precision:
 *
 *   G = [2 * sum(i * x_i) - (n+1) * sum(x_i)] / (n * sum(x_i))    (x sorted ascending, i 1-indexed)
 */
export function computeBuySizeGiniBps(events: readonly BuyShapeEvent[]): number | null {
  const totals = aggregateBuyerTotals(events).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const buyerCount = totals.length;
  if (buyerCount < 2) return null;

  const total = totals.reduce((sum, value) => sum + value, 0n);
  if (total === 0n) return null;

  let weightedSum = 0n;
  for (let index = 0; index < buyerCount; index += 1) {
    weightedSum += BigInt(index + 1) * totals[index]!;
  }

  const n = BigInt(buyerCount);
  const numerator = 2n * weightedSum - (n + 1n) * total;
  const denominator = n * total;

  const bps = (numerator * 10000n + denominator / 2n) / denominator;
  return clampBps(Number(bps));
}

/**
 * Shannon entropy of per-buyer spend shares, normalized by log(buyerCount)
 * (max possible entropy for that buyer count), in bps. 1 buyer -> null
 * (a lone buyer has no distribution to describe).
 *
 * A dominant buyer among several (a "single whale" with co-buyers) is NOT
 * null: buyerCount > 1, so this returns a low-but-defined bps value (often
 * close to but not exactly 0, depending on the co-buyers' share). Only a
 * literal single-buyer window nulls this signal — that edge is intentional
 * and documented here since the two "single whale" shapes read differently.
 *
 * Each share is computed as an exact bigint ratio scaled to fixed precision
 * before converting to a JS number, so a share derived from bigint totals
 * past 2^53 still converts losslessly (the scaled ratio itself is bounded
 * well under 2^53).
 */
const ENTROPY_PRECISION = 1_000_000_000_000n; // 1e12 < 2^53, exact in a double

export function computeBuySizeEntropyBps(events: readonly BuyShapeEvent[]): number | null {
  const totals = aggregateBuyerTotals(events);
  const buyerCount = totals.length;
  if (buyerCount <= 1) return null;

  const total = totals.reduce((sum, value) => sum + value, 0n);
  if (total === 0n) return null;

  let entropy = 0;
  for (const value of totals) {
    if (value === 0n) continue;
    const scaledShare = (value * ENTROPY_PRECISION) / total;
    if (scaledShare === 0n) continue;
    const share = Number(scaledShare) / Number(ENTROPY_PRECISION);
    entropy += -share * Math.log(share);
  }

  const maxEntropy = Math.log(buyerCount);
  if (maxEntropy <= 0) return null;

  return clampBps((entropy / maxEntropy) * 10000);
}

/**
 * Share of BUY events whose exact quote_amount_raw value recurs >= 2 times
 * in the window, in bps. Flags bot-like repeated buy sizing. 0 buys -> null.
 */
export function computeRepeatedSizeBuyPctBps(events: readonly BuyShapeEvent[]): number | null {
  const total = events.length;
  if (total === 0) return null;

  const counts = new Map<bigint, number>();
  for (const event of events) {
    counts.set(event.quoteAmountRaw, (counts.get(event.quoteAmountRaw) ?? 0) + 1);
  }

  let repeated = 0;
  for (const count of counts.values()) {
    if (count >= 2) repeated += count;
  }

  return clampBps((repeated * 10000) / total);
}
