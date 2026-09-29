import { describe, expect, it } from "vitest";

import {
  computeBuySizeEntropyBps,
  computeBuySizeGiniBps,
  computeRepeatedSizeBuyPctBps,
  type BuyShapeEvent
} from "../src/index.js";
import { addr } from "./fixtures.js";

const BUYER_A = addr("01").toLowerCase();
const BUYER_B = addr("02").toLowerCase();
const BUYER_C = addr("03").toLowerCase();
const BUYER_D = addr("04").toLowerCase();

function buy(buyer: string, quoteAmountRaw: bigint): BuyShapeEvent {
  return { buyer, quoteAmountRaw };
}

describe("buy-shape signals", () => {
  it("returns null for all three signals with zero buys", () => {
    expect(computeBuySizeGiniBps([])).toBeNull();
    expect(computeBuySizeEntropyBps([])).toBeNull();
    expect(computeRepeatedSizeBuyPctBps([])).toBeNull();
  });

  it("nulls gini and entropy for a single buyer, but still scores repeated-size", () => {
    // A lone buyer has no cross-buyer distribution to describe (contract:
    // 0 or 1 buyers -> null for gini; <=1 buyer -> null for entropy).
    // Repeated-size is event-level, not buyer-count-gated, so it still fires.
    const events = [buy(BUYER_A, 500n), buy(BUYER_A, 500n)];

    expect(computeBuySizeGiniBps(events)).toBeNull();
    expect(computeBuySizeEntropyBps(events)).toBeNull();
    expect(computeRepeatedSizeBuyPctBps(events)).toBe(10000);
  });

  it("scores equal buy sizes across multiple buyers as gini 0 / entropy at max (10000 bps)", () => {
    const events = [
      buy(BUYER_A, 1000n),
      buy(BUYER_B, 1000n),
      buy(BUYER_C, 1000n),
      buy(BUYER_D, 1000n)
    ];

    expect(computeBuySizeGiniBps(events)).toBe(0);
    expect(computeBuySizeEntropyBps(events)).toBe(10000);
  });

  it("scores a single whale among several buyers as high gini / low-but-defined entropy", () => {
    // Edge-case definition (documented in buy-shape.ts): a literal single
    // buyer nulls both signals (see the test above). A DOMINANT buyer among
    // several co-buyers is a different shape -- buyerCount > 1, so this is
    // NOT null; it surfaces as a high gini and a low (near-zero, not null)
    // entropy, which is the "single whale" pattern this signal exists to catch.
    const events = [buy(BUYER_A, 990n), buy(BUYER_B, 5n), buy(BUYER_C, 5n)];

    const gini = computeBuySizeGiniBps(events);
    const entropy = computeBuySizeEntropyBps(events);

    expect(gini).toBe(6567);
    expect(entropy).toBe(573);
    expect(gini).toBeGreaterThan(6000);
    expect(entropy).toBeLessThan(1000);
  });

  it("sums repeated buys from the same buyer into one gini/entropy total", () => {
    // BUYER_A's two buys (300 + 700 = 1000) must aggregate to the same
    // per-buyer total as BUYER_B and BUYER_C's single 1000 buys.
    const events = [
      buy(BUYER_A, 300n),
      buy(BUYER_A, 700n),
      buy(BUYER_B, 1000n),
      buy(BUYER_C, 1000n)
    ];

    expect(computeBuySizeGiniBps(events)).toBe(0);
    expect(computeBuySizeEntropyBps(events)).toBe(10000);
  });

  it("flags a duplicate-size bot pattern with a high repeated-size share", () => {
    const events = [
      buy(BUYER_A, 100n),
      buy(BUYER_B, 100n),
      buy(BUYER_C, 100n),
      buy(BUYER_A, 250n),
      buy(BUYER_B, 300n)
    ];

    expect(computeRepeatedSizeBuyPctBps(events)).toBe(6000);
  });

  it("scores zero repeated-size when every buy size is distinct", () => {
    const events = [buy(BUYER_A, 100n), buy(BUYER_B, 200n), buy(BUYER_C, 300n)];

    expect(computeRepeatedSizeBuyPctBps(events)).toBe(0);
  });

  it("handles bigint buyer totals exceeding 2^53 without precision loss", () => {
    const events = [
      buy(BUYER_A, 5_000_000_000_000_000n),
      buy(BUYER_B, 3_000_000_000_000_001n),
      buy(BUYER_C, 2_000_000_000_000_000n),
      buy(BUYER_D, 1n)
    ];

    // Reference values computed independently with exact rational (Fraction)
    // arithmetic in Python, mirroring the sorted-index gini formula and the
    // Shannon entropy formula -- not derived from this implementation.
    expect(computeBuySizeGiniBps(events)).toBe(4000);
    expect(computeBuySizeEntropyBps(events)).toBe(7427);
  });
});
