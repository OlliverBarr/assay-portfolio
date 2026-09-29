import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";

import { classifySimulation, createQuoteRouteSimulator } from "../src/index.js";
import { BASE, QUOTE, poolRow } from "./fixtures.js";

const ROUTER = "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba" as Address;
const QUOTER = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7" as Address;
const PROBE = 1_000_000n;

interface ReadCall {
  functionName: string;
  args: readonly unknown[];
}

/**
 * PublicClient stub whose readContract routes on the leg direction: a quote
 * asset going in is the buy leg, the base asset going in is the sell leg.
 */
function fakeClient(
  legs: {
    buy: () => bigint;
    sell: (sellIn: bigint) => bigint;
  },
  calls: ReadCall[] = []
): PublicClient {
  return {
    readContract: (params: ReadCall) => {
      calls.push(params);
      if (params.functionName === "getAmountsOut") {
        const [amountIn, path] = params.args as [bigint, readonly Address[]];
        const out = path[0] === QUOTE ? legs.buy() : legs.sell(amountIn);
        return Promise.resolve([amountIn, out]);
      }
      const [{ tokenIn, amountIn }] = params.args as [
        { tokenIn: Address; amountIn: bigint }
      ];
      const out = tokenIn === QUOTE ? legs.buy() : legs.sell(amountIn);
      return Promise.resolve([out, 0n, 0, 0n]);
    }
  } as unknown as PublicClient;
}

/**
 * PublicClient stub whose buy/sell legs see the actual `amountIn`, so tests
 * can express size-dependent quotes (slippage curves) and per-notional
 * reverts. A leg returning `"revert"` rejects like a real revert.
 */
function fakeCurveClient(
  legs: {
    buy: (amountIn: bigint) => bigint | "revert";
    sell: (amountIn: bigint) => bigint | "revert";
  },
  calls: ReadCall[] = []
): PublicClient {
  return {
    readContract: (params: ReadCall) => {
      calls.push(params);
      if (params.functionName === "getAmountsOut") {
        const [amountIn, path] = params.args as [bigint, readonly Address[]];
        const out = path[0] === QUOTE ? legs.buy(amountIn) : legs.sell(amountIn);
        if (out === "revert") return Promise.reject(new Error("execution reverted"));
        return Promise.resolve([amountIn, out]);
      }
      const [{ tokenIn, amountIn }] = params.args as [
        { tokenIn: Address; amountIn: bigint }
      ];
      const out = tokenIn === QUOTE ? legs.buy(amountIn) : legs.sell(amountIn);
      if (out === "revert") return Promise.reject(new Error("execution reverted"));
      return Promise.resolve([out, 0n, 0, 0n]);
    }
  } as unknown as PublicClient;
}

const v3Pool = poolRow({ factoryKind: "uniswap-v3", feePpm: 500 });

describe("createQuoteRouteSimulator", () => {
  it("V3 round trip: sell-loss baseline is the probe input, so loss is measurable", async () => {
    const simulator = createQuoteRouteSimulator(
      fakeClient({ buy: () => 500_000_000n, sell: () => 990_000n }),
      { v3Quoter: QUOTER, probeQuoteInRaw: PROBE }
    );
    const raw = await simulator.simulate(v3Pool);

    expect(raw.buyQuoteInRaw).toBe(PROBE);
    expect(raw.buyBaseOutRaw).toBe(500_000_000n);
    expect(raw.sellBaseInRaw).toBe(500_000_000n);
    expect(raw.sellQuoteOutRaw).toBe(990_000n);
    expect(raw.spotQuoteOutRaw).toBe(PROBE);

    const verdict = classifySimulation(raw);
    expect(verdict.status).toBe("PASS");
    // (1_000_000 - 990_000) / 1_000_000 = 100 bps round-trip loss.
    expect(verdict.effectiveSellLossBps).toBe(100);
  });

  it("V2 round trip: measures loss through getAmountsOut against the probe input", async () => {
    const calls: ReadCall[] = [];
    const simulator = createQuoteRouteSimulator(
      fakeClient({ buy: () => 250_000n, sell: () => 980_000n }, calls),
      { v2Router: ROUTER, probeQuoteInRaw: PROBE, slippageCurveNotionalsUsd: [] }
    );
    const raw = await simulator.simulate(poolRow());

    expect(calls.map((c) => c.functionName)).toEqual([
      "getAmountsOut",
      "getAmountsOut"
    ]);
    expect(raw.sellBaseInRaw).toBe(250_000n);
    expect(raw.spotQuoteOutRaw).toBe(PROBE);

    const verdict = classifySimulation(raw);
    expect(verdict.status).toBe("PASS");
    expect(verdict.effectiveSellLossBps).toBe(200);
  });

  it("marks an excessive round-trip loss as FAIL (honeypot signal)", async () => {
    const simulator = createQuoteRouteSimulator(
      fakeClient({ buy: () => 500_000_000n, sell: () => 400_000n }),
      { v3Quoter: QUOTER, probeQuoteInRaw: PROBE }
    );
    const verdict = classifySimulation(await simulator.simulate(v3Pool));
    expect(verdict.status).toBe("FAIL");
    expect(verdict.effectiveSellLossBps).toBe(6_000);
    expect(verdict.reasons.some((r) => r.includes("sell loss"))).toBe(true);
  });

  it("records a reverting sell quote as a failed sell leg with null loss", async () => {
    const simulator = createQuoteRouteSimulator(
      fakeClient({
        buy: () => 500_000_000n,
        sell: () => {
          throw new Error("execution reverted");
        }
      }),
      { v3Quoter: QUOTER, probeQuoteInRaw: PROBE }
    );
    const raw = await simulator.simulate(v3Pool);
    expect(raw.sellReverted).toBe(true);

    const verdict = classifySimulation(raw);
    expect(verdict.status).toBe("FAIL");
    expect(verdict.effectiveSellLossBps).toBe(null);
  });

  it("stays a no-op UNKNOWN when the route address is not configured", async () => {
    const simulator = createQuoteRouteSimulator(
      fakeClient({ buy: () => 1n, sell: () => 1n })
    );
    const raw = await simulator.simulate(v3Pool);
    expect(raw.buyQuoteInRaw).toBe(null);
    expect(raw.spotQuoteOutRaw).toBe(null);
    expect(classifySimulation(raw).status).toBe("UNKNOWN");
  });

  it("uses the quote and base addresses from the pool row for both legs", async () => {
    const calls: ReadCall[] = [];
    const simulator = createQuoteRouteSimulator(
      fakeClient({ buy: () => 10n, sell: () => 999_999n }, calls),
      { v3Quoter: QUOTER, probeQuoteInRaw: PROBE }
    );
    await simulator.simulate(v3Pool);
    const [buyCall, sellCall] = calls as [ReadCall, ReadCall];
    const buyParams = (buyCall.args as [{ tokenIn: Address; tokenOut: Address }])[0];
    const sellParams = (sellCall.args as [{ tokenIn: Address; tokenOut: Address }])[0];
    expect(buyParams.tokenIn).toBe(QUOTE);
    expect(buyParams.tokenOut).toBe(BASE);
    expect(sellParams.tokenIn).toBe(BASE);
    expect(sellParams.tokenOut).toBe(QUOTE);
  });
});

describe("createQuoteRouteSimulator sell-slippage curve", () => {
  // Loss grows with size: lossBps == amountIn / 10_000_000n exactly, so the
  // default $500/$2,000/$5,000 notionals (raw 5e8/2e9/5e9 at 6-decimal $1
  // anchoring) yield 50/200/500 bps.
  const sizeDependentSell = (amountIn: bigint): bigint => {
    const lossBpsForSize = amountIn / 10_000_000n;
    return amountIn - (amountIn * lossBpsForSize) / 10_000n;
  };

  it("probes the default $500/$2,000/$5,000 notionals as an ascending, monotonic curve", async () => {
    const simulator = createQuoteRouteSimulator(
      fakeCurveClient({ buy: (amountIn) => amountIn, sell: sizeDependentSell }),
      { v2Router: ROUTER, probeQuoteInRaw: PROBE }
    );
    const raw = await simulator.simulate(poolRow());
    const curve = raw.slippageCurve;
    expect(curve).not.toBeNull();
    expect(curve?.map((p) => p.notionalUsd)).toEqual(["500", "2000", "5000"]);
    expect(curve?.map((p) => p.lossBps)).toEqual([50, 200, 500]);
    expect(curve?.[0]?.lossBps).toBeLessThan(curve?.[1]?.lossBps ?? Infinity);
    expect(curve?.[1]?.lossBps).toBeLessThan(curve?.[2]?.lossBps ?? Infinity);
  });

  it("survives a single reverting notional: only that point is null, others still compute", async () => {
    const simulator = createQuoteRouteSimulator(
      fakeCurveClient({
        buy: (amountIn) => amountIn,
        sell: (amountIn) => (amountIn === 2_000_000_000n ? "revert" : sizeDependentSell(amountIn))
      }),
      { v3Quoter: QUOTER, probeQuoteInRaw: PROBE }
    );
    const raw = await simulator.simulate(v3Pool);
    const curve = raw.slippageCurve;
    expect(curve?.map((p) => p.notionalUsd)).toEqual(["500", "2000", "5000"]);
    expect(curve?.[0]?.lossBps).toBe(50);
    expect(curve?.[1]?.lossBps).toBe(null);
    expect(curve?.[2]?.lossBps).toBe(500);
  });

  it("converts USD notionals to raw quote units via the probe's own $1 anchoring, for 6- and 18-decimal quote tokens", async () => {
    for (const decimals of [6, 18]) {
      const probe = 10n ** BigInt(decimals);
      const calls: ReadCall[] = [];
      const simulator = createQuoteRouteSimulator(
        fakeCurveClient({ buy: () => 1_000n, sell: () => 1_000n }, calls),
        { v2Router: ROUTER, probeQuoteInRaw: probe }
      );
      await simulator.simulate(poolRow());
      const buyAmounts = calls
        .filter((_c, i) => i % 2 === 0)
        .map((c) => (c.args as [bigint, unknown])[0]);
      expect(buyAmounts).toEqual([probe, probe * 500n, probe * 2_000n, probe * 5_000n]);
    }
  });

  it("yields a null curve when the notionals vector is empty (disabled)", async () => {
    const simulator = createQuoteRouteSimulator(
      fakeClient({ buy: () => 500_000_000n, sell: () => 990_000n }),
      { v3Quoter: QUOTER, probeQuoteInRaw: PROBE, slippageCurveNotionalsUsd: [] }
    );
    const raw = await simulator.simulate(v3Pool);
    expect(raw.slippageCurve).toBeNull();
  });

  it("preserves the configured notional order verbatim, without re-sorting", async () => {
    const simulator = createQuoteRouteSimulator(
      fakeCurveClient({ buy: () => 1_000n, sell: () => 1_000n }),
      {
        v2Router: ROUTER,
        probeQuoteInRaw: PROBE,
        slippageCurveNotionalsUsd: [10, 5_000, 250]
      }
    );
    const raw = await simulator.simulate(poolRow());
    expect(raw.slippageCurve?.map((p) => p.notionalUsd)).toEqual([
      "10",
      "5000",
      "250"
    ]);
  });

  it("stays null when the route address is not configured (no curve calls made)", async () => {
    const calls: ReadCall[] = [];
    const simulator = createQuoteRouteSimulator(
      fakeCurveClient({ buy: (amountIn) => amountIn, sell: sizeDependentSell }, calls)
    );
    const raw = await simulator.simulate(v3Pool);
    expect(raw.slippageCurve).toBeNull();
    expect(calls).toEqual([]);
  });
});
