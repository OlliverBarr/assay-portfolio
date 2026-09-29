import { describe, expect, it } from "vitest";

import { computeBalances } from "../src/index.js";
import {
  BASE,
  HOLDER_A,
  HOLDER_B,
  HOLDER_C,
  POOL,
  ZERO,
  transfer
} from "./fixtures.js";

describe("computeBalances", () => {
  it("nets a transfer stream and drops the mint source", () => {
    const balances = computeBalances([
      transfer(ZERO, HOLDER_A, 100n),
      transfer(HOLDER_A, HOLDER_B, 40n),
      transfer(HOLDER_A, POOL, 10n),
      transfer(HOLDER_B, HOLDER_C, 15n),
      transfer(HOLDER_C, HOLDER_B, 15n),
      transfer(HOLDER_B, ZERO, 5n)
    ]);

    expect(balances.size).toBe(3);
    expect(balances.get(HOLDER_A)).toBe(50n);
    expect(balances.get(HOLDER_B)).toBe(35n);
    expect(balances.get(POOL)).toBe(10n);
    // Zero (mint source, net negative) and a net-zero passthrough drop out.
    expect(balances.has(ZERO)).toBe(false);
    expect(balances.has(HOLDER_C)).toBe(false);
  });

  it("drops a holder who transfers out everything received", () => {
    const balances = computeBalances([
      transfer(ZERO, HOLDER_A, 100n),
      transfer(HOLDER_A, HOLDER_B, 100n)
    ]);

    expect(balances.has(HOLDER_A)).toBe(false);
    expect(balances.get(HOLDER_B)).toBe(100n);
  });

  it("nets multiple credits and debits per address exactly", () => {
    const balances = computeBalances([
      transfer(ZERO, HOLDER_A, 1000n),
      transfer(HOLDER_A, HOLDER_B, 200n),
      transfer(HOLDER_B, HOLDER_A, 50n),
      transfer(HOLDER_A, HOLDER_B, 300n)
    ]);

    expect(balances.get(HOLDER_A)).toBe(550n);
    expect(balances.get(HOLDER_B)).toBe(450n);
  });

  it("normalizes address casing so mixed-case transfers net together", () => {
    const lower = BASE.toLowerCase() as `0x${string}`;
    const balances = computeBalances([
      transfer(ZERO, BASE, 100n),
      transfer(lower, HOLDER_A, 40n)
    ]);

    expect(balances.get(BASE)).toBe(60n);
    expect(balances.get(HOLDER_A)).toBe(40n);
  });

  it("returns an empty map for no transfers", () => {
    expect(computeBalances([]).size).toBe(0);
  });

  it("seeded on a prior balance, nets the same result as a single from-scratch pass", () => {
    const full = [
      transfer(ZERO, HOLDER_A, 100n),
      transfer(HOLDER_A, HOLDER_B, 40n),
      transfer(HOLDER_A, POOL, 10n),
      transfer(HOLDER_B, HOLDER_C, 15n)
    ];
    const scratch = computeBalances(full);

    const seed = computeBalances(full.slice(0, 2)); // A=60, B=40
    const incremental = computeBalances(full.slice(2), seed);

    expect(incremental).toEqual(scratch);
  });

  it("a seeded holder who sells out entirely drops from the result", () => {
    const seed = new Map([[HOLDER_A, 40n]]);
    const balances = computeBalances(
      [transfer(HOLDER_A, HOLDER_B, 40n)],
      seed
    );

    expect(balances.has(HOLDER_A)).toBe(false);
    expect(balances.get(HOLDER_B)).toBe(40n);
  });
});
