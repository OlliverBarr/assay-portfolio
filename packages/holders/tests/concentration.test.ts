import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";

import { computeConcentration } from "../src/index.js";
import { BURN, HOLDER_A, HOLDER_B, HOLDER_C, POOL, ZERO } from "./fixtures.js";

describe("computeConcentration", () => {
  it("computes bps of circulating supply and largest holder", () => {
    const balances = new Map<Address, bigint>([
      [HOLDER_A, 60n],
      [HOLDER_B, 30n],
      [HOLDER_C, 10n]
    ]);
    const result = computeConcentration(balances, {
      totalSupply: 100n,
      excluded: []
    });

    expect(result.holderCount).toBe(3);
    expect(result.largestHolderPctBps).toBe(6000);
    expect(result.top10PctBps).toBe(10000);
    expect(result.excluded).toEqual([]);
  });

  it("floors basis points instead of rounding", () => {
    const balances = new Map<Address, bigint>([
      [HOLDER_A, 1n],
      [HOLDER_B, 2n]
    ]);
    // 1 / 3 = 3333.33.. bps -> floored to 3333.
    const result = computeConcentration(balances, {
      totalSupply: 3n,
      excluded: []
    });
    expect(result.largestHolderPctBps).toBe(6666);
  });

  it("excludes pool, zero, and burn from adjusted metrics by address", () => {
    const balances = new Map<Address, bigint>([
      [HOLDER_A, 50n],
      [BURN, 30n],
      [ZERO, 10n],
      [POOL, 10n]
    ]);
    const result = computeConcentration(balances, {
      totalSupply: 100n,
      excluded: [{ address: POOL, reason: "pool-address" }]
    });

    // Raw metrics see every positive balance.
    expect(result.holderCount).toBe(4);
    expect(result.largestHolderPctBps).toBe(5000);
    expect(result.top10PctBps).toBe(10000);

    // Adjusted keeps only the single economic holder.
    expect(result.adjustedHolderCount).toBe(1);
    expect(result.adjustedTop10PctBps).toBe(10000);

    expect(result.excluded).toEqual([
      { address: ZERO, reason: "zero-address" },
      { address: BURN, reason: "burn-address" },
      { address: POOL, reason: "pool-address" }
    ]);
  });

  it("only reports excluded addresses that actually held a balance", () => {
    const balances = new Map<Address, bigint>([
      [HOLDER_A, 70n],
      [POOL, 30n]
    ]);
    const result = computeConcentration(balances, {
      totalSupply: 100n,
      excluded: [{ address: POOL, reason: "pool-address" }]
    });
    // No zero/burn balance present -> not reported.
    expect(result.excluded).toEqual([
      { address: POOL, reason: "pool-address" }
    ]);
    expect(result.adjustedHolderCount).toBe(1);
    expect(result.adjustedTop10PctBps).toBe(10000);
  });

  it("returns zero bps for an empty holder set", () => {
    const result = computeConcentration(new Map(), {
      totalSupply: 0n,
      excluded: []
    });
    expect(result).toMatchObject({
      holderCount: 0,
      adjustedHolderCount: 0,
      largestHolderPctBps: 0,
      top10PctBps: 0,
      adjustedTop10PctBps: 0,
      excluded: []
    });
  });

  it("caps top-10 at the ten largest of many holders", () => {
    // 12 holders of 10 each -> top-10 = 100 of 120 -> 8333 bps.
    const balances = new Map<Address, bigint>();
    for (let i = 0; i < 12; i += 1) {
      const address = getAddress(`0x${String(i + 1).padStart(40, "0")}`);
      balances.set(address, 10n);
    }
    const result = computeConcentration(balances, {
      totalSupply: 120n,
      excluded: []
    });
    expect(result.holderCount).toBe(12);
    expect(result.top10PctBps).toBe(8333);
    expect(result.largestHolderPctBps).toBe(833);
  });

  it.each([6, 8, 9, 18])(
    "is decimal-agnostic for %i-decimal tokens",
    (decimals) => {
      const scale = 10n ** BigInt(decimals);
      const balances = new Map<Address, bigint>([
        [HOLDER_A, 60n * scale],
        [HOLDER_B, 30n * scale],
        [POOL, 10n * scale]
      ]);
      const result = computeConcentration(balances, {
        totalSupply: 100n * scale,
        excluded: [{ address: POOL, reason: "pool-address" }]
      });

      // Basis points are identical regardless of the raw magnitude.
      expect(result.largestHolderPctBps).toBe(6000);
      expect(result.top10PctBps).toBe(10000);
      expect(result.adjustedHolderCount).toBe(2);
      // Adjusted: A+B = 90*scale of 90*scale circulating.
      expect(result.adjustedTop10PctBps).toBe(10000);
    }
  );

  describe("deployerPctBps", () => {
    it("is the deployer's share of the adjusted supply, matching the top-10 denominator", () => {
      const balances = new Map<Address, bigint>([
        [HOLDER_A, 60n],
        [HOLDER_B, 30n],
        [POOL, 10n]
      ]);
      const result = computeConcentration(balances, {
        totalSupply: 100n,
        excluded: [{ address: POOL, reason: "pool-address" }],
        deployer: HOLDER_A
      });
      // Adjusted supply = 90 (pool excluded): 60/90 -> floored 6666 bps,
      // the same denominator adjustedTop10PctBps (90/90 = 10000) uses.
      expect(result.adjustedTop10PctBps).toBe(10000);
      expect(result.deployerPctBps).toBe(6666);
    });

    it("is 0 when the deployer resolved but holds nothing", () => {
      const balances = new Map<Address, bigint>([[HOLDER_A, 100n]]);
      const result = computeConcentration(balances, {
        totalSupply: 100n,
        excluded: [],
        deployer: HOLDER_C
      });
      expect(result.deployerPctBps).toBe(0);
    });

    it("lands exactly on the 800 bps eligibility boundary", () => {
      const balances = new Map<Address, bigint>([
        [HOLDER_A, 800n],
        [HOLDER_B, 9_200n]
      ]);
      const result = computeConcentration(balances, {
        totalSupply: 10_000n,
        excluded: [],
        deployer: HOLDER_A
      });
      // 800 / 10000 adjusted = exactly 8% = 800 bps.
      expect(result.deployerPctBps).toBe(800);
    });

    it("is null when the deployer is an excluded non-economic address", () => {
      const balances = new Map<Address, bigint>([
        [HOLDER_A, 90n],
        [POOL, 10n]
      ]);
      const result = computeConcentration(balances, {
        totalSupply: 100n,
        excluded: [{ address: POOL, reason: "pool-address" }],
        deployer: POOL
      });
      expect(result.deployerPctBps).toBeNull();
    });

    it("is null when the deployer is unknown", () => {
      const balances = new Map<Address, bigint>([[HOLDER_A, 100n]]);
      const withNull = computeConcentration(balances, {
        totalSupply: 100n,
        excluded: [],
        deployer: null
      });
      const withAbsent = computeConcentration(balances, {
        totalSupply: 100n,
        excluded: []
      });
      expect(withNull.deployerPctBps).toBeNull();
      expect(withAbsent.deployerPctBps).toBeNull();
    });

    it("matches a lowercase deployer against checksummed balances", () => {
      const balances = new Map<Address, bigint>([
        [HOLDER_A, 25n],
        [HOLDER_B, 75n]
      ]);
      const result = computeConcentration(balances, {
        totalSupply: 100n,
        excluded: [],
        deployer: HOLDER_A.toLowerCase() as Address
      });
      expect(result.deployerPctBps).toBe(2500);
    });
  });

  describe("floatBps and supplyInPoolBps", () => {
    it("subtracts the resolved deployer's balance, making float lower than the unresolved ceiling", () => {
      const balances = new Map<Address, bigint>([
        [HOLDER_A, 50n],
        [HOLDER_B, 30n],
        [POOL, 10n],
        [HOLDER_C, 10n] // deployer's own balance
      ]);
      const base = {
        totalSupply: 100n,
        excluded: [{ address: POOL, reason: "pool-address" }]
      };
      const unresolved = computeConcentration(balances, base);
      const resolved = computeConcentration(balances, {
        ...base,
        deployer: HOLDER_C
      });

      // Unresolved: float omits the deployer term entirely -> a ceiling.
      // 100 - pool(10) = 90 -> 9000 bps.
      expect(unresolved.floatBps).toBe(9000);
      // Resolved: float additionally drops the deployer's 10 -> 80 -> 8000.
      expect(resolved.floatBps).toBe(8000);
      expect(resolved.floatBps).toBeLessThan(unresolved.floatBps ?? 0);
    });

    it("does not double-subtract when the deployer is already in the exclusion set", () => {
      const balances = new Map<Address, bigint>([
        [HOLDER_A, 90n],
        [POOL, 10n]
      ]);
      const result = computeConcentration(balances, {
        totalSupply: 100n,
        excluded: [{ address: POOL, reason: "pool-address" }],
        deployer: POOL
      });
      // Float drops the pool's 10 once, not twice: 100 - 10 = 90 -> 9000 bps.
      expect(result.floatBps).toBe(9000);
    });

    it("is 0 float and 10000 supplyInPool when the entire supply sits in the pool", () => {
      const balances = new Map<Address, bigint>([[POOL, 100n]]);
      const result = computeConcentration(balances, {
        totalSupply: 100n,
        excluded: [{ address: POOL, reason: "pool-address" }]
      });
      expect(result.floatBps).toBe(0);
      expect(result.supplyInPoolBps).toBe(10000);
    });

    it("is null for both when totalSupply is 0", () => {
      const balances = new Map<Address, bigint>([[HOLDER_A, 100n]]);
      const result = computeConcentration(balances, {
        totalSupply: 0n,
        excluded: [{ address: POOL, reason: "pool-address" }]
      });
      expect(result.floatBps).toBeNull();
      expect(result.supplyInPoolBps).toBeNull();
    });

    it("clamps floatBps to 0 rather than going negative against a stale totalSupply", () => {
      const balances = new Map<Address, bigint>([
        [HOLDER_A, 40n],
        [POOL, 90n] // observed pool balance alone exceeds recorded supply
      ]);
      const result = computeConcentration(balances, {
        totalSupply: 50n,
        excluded: [{ address: POOL, reason: "pool-address" }]
      });
      // Raw would be (50 - 90) / 50 = -80% -> clamped to 0.
      expect(result.floatBps).toBe(0);
    });

    it("clamps supplyInPoolBps to 10000 rather than exceeding it", () => {
      const balances = new Map<Address, bigint>([[POOL, 150n]]);
      const result = computeConcentration(balances, {
        totalSupply: 100n,
        excluded: [{ address: POOL, reason: "pool-address" }]
      });
      // Raw would be 150% -> clamped to 10000.
      expect(result.supplyInPoolBps).toBe(10000);
    });

    it.each([6, 8, 9, 18])(
      "is decimal-agnostic for %i-decimal tokens",
      (decimals) => {
        const scale = 10n ** BigInt(decimals);
        const balances = new Map<Address, bigint>([
          [HOLDER_A, 70n * scale],
          [POOL, 20n * scale],
          [HOLDER_B, 10n * scale]
        ]);
        const result = computeConcentration(balances, {
          totalSupply: 100n * scale,
          excluded: [{ address: POOL, reason: "pool-address" }],
          deployer: HOLDER_B
        });
        // float = (100 - 20 - 10) / 100 = 70%, regardless of raw magnitude.
        expect(result.floatBps).toBe(7000);
        expect(result.supplyInPoolBps).toBe(2000);
      }
    );

    it("stays exact for balances beyond Number.MAX_SAFE_INTEGER", () => {
      const huge = 10n ** 30n; // far past 2^53
      const balances = new Map<Address, bigint>([
        [HOLDER_A, (huge * 7n) / 10n],
        [POOL, (huge * 2n) / 10n],
        [HOLDER_C, (huge * 1n) / 10n] // deployer
      ]);
      const result = computeConcentration(balances, {
        totalSupply: huge,
        excluded: [{ address: POOL, reason: "pool-address" }],
        deployer: HOLDER_C
      });
      expect(result.floatBps).toBe(7000);
      expect(result.supplyInPoolBps).toBe(2000);
    });
  });
});
