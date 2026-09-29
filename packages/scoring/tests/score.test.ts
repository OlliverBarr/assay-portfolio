import { describe, expect, it } from "vitest";

import {
  DEFAULT_SIGNAL_CONFIG,
  scoreOpportunity,
  type CandidateFeatures,
  type EligibilityResult
} from "../src/index.js";
import { eligibleFeatures, partialLiveFeatures } from "./fixtures.js";

const ELIGIBLE: EligibilityResult = {
  eligible: true,
  failedRules: [],
  softFailedRules: [],
  reasons: []
};
const INELIGIBLE: EligibilityResult = {
  eligible: false,
  failedRules: ["fdvBand"],
  softFailedRules: [],
  reasons: ["Estimated FDV is unavailable"]
};

describe("scoreOpportunity — baseline total & components", () => {
  it("computes the expected component breakdown and total", () => {
    // eligibleFeatures(): quote 20k (16) + ratio 40% (8) + no curve (0) = 24;
    // buyers 60/40 → 15 + 10 = 25; flow 80/(20+1) ≈ 3.8 (15) + inflow (5) = 20;
    // FDV 50k → mid zone 12.
    const result = scoreOpportunity(eligibleFeatures(), ELIGIBLE);
    expect(result.components).toEqual({
      liquidityDepth: 24,
      buyerBreadth: 25,
      buyFlow: 20,
      lowCapTilt: 12
    });
    expect(result.score).toBe(81);
  });

  it("keeps the score within 0-100", () => {
    const result = scoreOpportunity(eligibleFeatures(), ELIGIBLE);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe("scoreOpportunity — the full 0-100 range is attainable", () => {
  /**
   * A best-case-everything candidate. If this ever stops scoring exactly 100,
   * the scale has dead headroom again — the defect the 2026-07-11
   * recalibration removed and the 2026-07-20 rebuild preserves.
   */
  const maximal: Partial<CandidateFeatures> = {
    estimatedFdvUsd: "22000",
    quoteLiquidityUsd: "30000",
    sellSlippageCurve: [
      { notionalUsd: "500", lossBps: 50 },
      { notionalUsd: "2000", lossBps: 60 },
      { notionalUsd: "5000", lossBps: 80 }
    ],
    uniqueBuyers1h: 200,
    uniqueBuyers20m: 30,
    buyCount20m: 50,
    sellCount20m: 10,
    quoteBuyVolumeRaw20m: "5000000000000000000",
    quoteSellVolumeRaw20m: "1000000000000000000"
  };

  it("scores exactly 100 with every component at its maximum", () => {
    const result = scoreOpportunity(eligibleFeatures(maximal), ELIGIBLE);
    expect(result.components).toEqual({
      liquidityDepth: 35,
      buyerBreadth: 25,
      buyFlow: 20,
      lowCapTilt: 20
    });
    expect(result.score).toBe(100);
  });

  it("scores near the bottom for a barely-eligible candidate with no traction", () => {
    const result = scoreOpportunity(
      eligibleFeatures({
        quoteLiquidityUsd: "2500",
        totalLiquidityUsd: "20000",
        estimatedFdvUsd: "90000",
        uniqueBuyers1h: 0,
        uniqueBuyers20m: 0,
        buyCount20m: 2,
        sellCount20m: 0,
        quoteBuyVolumeRaw20m: "1000",
        quoteSellVolumeRaw20m: "0"
      }),
      ELIGIBLE
    );
    // quote at floor (2) + no ratio points (2.5k/90k < 5%) + no buyers (0)
    // + dust-guarded flow (0) + high-FDV tilt (6) = 8.
    expect(result.score).toBe(8);
  });
});

describe("scoreOpportunity — score is independent of eligibility", () => {
  it("returns the same numeric score whether eligible or not", () => {
    const f = eligibleFeatures();
    const passed = scoreOpportunity(f, ELIGIBLE);
    const failed = scoreOpportunity(f, INELIGIBLE);
    expect(failed.score).toBe(passed.score);
  });

  it("folds ineligibility into risk reasons only", () => {
    const f = eligibleFeatures();
    const failed = scoreOpportunity(f, INELIGIBLE);
    expect(failed.riskReasons).toContain("Not eligible: fdvBand");
    const passed = scoreOpportunity(f, ELIGIBLE);
    expect(passed.riskReasons.some((r) => r.startsWith("Not eligible"))).toBe(false);
  });
});

describe("scoreOpportunity — liquidityDepth boundaries", () => {
  it("scores zero with no liquidity and no FDV", () => {
    const c = scoreOpportunity(
      eligibleFeatures({
        quoteLiquidityUsd: "0",
        estimatedFdvUsd: null
      }),
      ELIGIBLE
    ).components;
    expect(c.liquidityDepth).toBe(0);
  });

  it("awards the quote-depth tiers exactly at the $30k/$20k/$10k/$5k/$2.5k breakpoints and one below", () => {
    const depth = (quote: string): number =>
      scoreOpportunity(
        eligibleFeatures({ quoteLiquidityUsd: quote, estimatedFdvUsd: null }),
        ELIGIBLE
      ).components.liquidityDepth;
    expect(depth("30000")).toBe(20);
    expect(depth("29999")).toBe(16);
    expect(depth("20000")).toBe(16);
    expect(depth("19999")).toBe(10);
    expect(depth("10000")).toBe(10);
    expect(depth("9999")).toBe(6);
    expect(depth("5000")).toBe(6);
    expect(depth("4999")).toBe(2);
    expect(depth("2500")).toBe(2);
    expect(depth("2499")).toBe(0);
  });

  it("awards no depth points below the $2.5k eligibility floor", () => {
    const result = scoreOpportunity(
      eligibleFeatures({
        quoteLiquidityUsd: "2499",
        estimatedFdvUsd: null
      }),
      ELIGIBLE
    );
    expect(result.components.liquidityDepth).toBe(0);
    expect(result.riskReasons).toContain("Quote liquidity is thin for the band");
  });

  it("computes the liq/FDV ratio from QUOTE liquidity at the 15% and 20% tiers", () => {
    // quote 15k / fdv 100k = 15% → depth tier 10 + ratio tier 6.
    const at15 = scoreOpportunity(
      eligibleFeatures({
        quoteLiquidityUsd: "15000",
        estimatedFdvUsd: "100000"
      }),
      ELIGIBLE
    );
    expect(at15.components.liquidityDepth).toBe(16);
    expect(at15.positiveReasons).toContain("Quote liquidity-to-FDV ratio above 15%");
    // quote 20k / fdv 100k = 20% → depth tier 16 + ratio tier 8.
    const at20 = scoreOpportunity(
      eligibleFeatures({
        quoteLiquidityUsd: "20000",
        estimatedFdvUsd: "100000"
      }),
      ELIGIBLE
    ).components.liquidityDepth;
    expect(at20).toBe(24);
  });

  it("ignores total liquidity — the token side is inflatable", () => {
    const inflated = scoreOpportunity(
      eligibleFeatures({ totalLiquidityUsd: "9000000" }),
      ELIGIBLE
    ).components.liquidityDepth;
    const modest = scoreOpportunity(
      eligibleFeatures({ totalLiquidityUsd: "20000" }),
      ELIGIBLE
    ).components.liquidityDepth;
    expect(inflated).toBe(modest);
  });
});

describe("scoreOpportunity — liquidityDepth slippage-curve boundaries", () => {
  const cfg = DEFAULT_SIGNAL_CONFIG;
  const isolate = {
    quoteLiquidityUsd: "0",
    estimatedFdvUsd: null
  };

  it("a null curve adds nothing", () => {
    const c = scoreOpportunity(eligibleFeatures({ ...isolate }), ELIGIBLE).components;
    expect(c.liquidityDepth).toBe(0);
  });

  it("rewards a flat, bounded sell-slippage curve with the full sub-score", () => {
    const result = scoreOpportunity(
      eligibleFeatures({
        ...isolate,
        sellSlippageCurve: [
          { notionalUsd: "500", lossBps: 100 },
          { notionalUsd: "2000", lossBps: cfg.slippageCurveFlatMaxBps }
        ]
      }),
      ELIGIBLE
    );
    expect(result.components.liquidityDepth).toBe(cfg.slippageCurveFlatBonusPoints);
    expect(result.positiveReasons).toContain(
      "Sell-slippage stays flat and bounded across probed sizes"
    );
  });

  it("penalizes a steeply growing sell-slippage curve down to the floor", () => {
    const result = scoreOpportunity(
      eligibleFeatures({
        ...isolate,
        sellSlippageCurve: [
          { notionalUsd: "500", lossBps: 400 },
          { notionalUsd: "2000", lossBps: 400 + cfg.slippageCurveSteepGrowthBps }
        ]
      }),
      ELIGIBLE
    );
    expect(result.components.liquidityDepth).toBe(0);
    expect(result.riskReasons).toContain(
      "Sell-slippage grows steeply as probe size increases"
    );
  });

  it("flags a reverted probe on the curve as a risk reason", () => {
    const result = scoreOpportunity(
      eligibleFeatures({
        ...isolate,
        sellSlippageCurve: [
          { notionalUsd: "500", lossBps: 100 },
          { notionalUsd: "2000", lossBps: null }
        ]
      }),
      ELIGIBLE
    );
    expect(result.riskReasons).toContain(
      "Sell-slippage curve includes a reverted probe at a larger size"
    );
  });
});

describe("scoreOpportunity — buyerBreadth tier boundaries", () => {
  const noFlow = {
    buyCount20m: 0,
    sellCount20m: 0,
    quoteBuyVolumeRaw20m: "0",
    quoteSellVolumeRaw20m: "0"
  };

  it("awards the 1h tiers exactly at the 30/15/5/1 breakpoints and at zero", () => {
    const breadth = (buyers: number): number =>
      scoreOpportunity(
        eligibleFeatures({ ...noFlow, uniqueBuyers1h: buyers, uniqueBuyers20m: 0 }),
        ELIGIBLE
      ).components.buyerBreadth;
    expect(breadth(30)).toBe(15);
    expect(breadth(29)).toBe(13);
    expect(breadth(15)).toBe(13);
    expect(breadth(14)).toBe(8);
    expect(breadth(5)).toBe(8);
    expect(breadth(4)).toBe(3);
    expect(breadth(1)).toBe(3);
    expect(breadth(0)).toBe(0);
  });

  it("awards the 20m tiers exactly at the 15/5/1 breakpoints and at zero", () => {
    const breadth = (buyers: number): number =>
      scoreOpportunity(
        eligibleFeatures({ ...noFlow, uniqueBuyers1h: 0, uniqueBuyers20m: buyers }),
        ELIGIBLE
      ).components.buyerBreadth;
    expect(breadth(15)).toBe(10);
    expect(breadth(14)).toBe(6);
    expect(breadth(5)).toBe(6);
    expect(breadth(4)).toBe(3);
    expect(breadth(1)).toBe(3);
    expect(breadth(0)).toBe(0);
  });

  it("flags a dead 1h window as a risk without penalizing points", () => {
    const result = scoreOpportunity(
      eligibleFeatures({ ...noFlow, uniqueBuyers1h: 0, uniqueBuyers20m: 0 }),
      ELIGIBLE
    );
    expect(result.components.buyerBreadth).toBe(0);
    expect(result.riskReasons).toContain("No unique buyers in the last hour");
  });
});

describe("scoreOpportunity — buyFlow ratio boundaries & dust guard", () => {
  const cfg = DEFAULT_SIGNAL_CONFIG;
  // Neutral volumes: equal in/out so ratio tiers are isolated from the bonus.
  const neutralVol = {
    quoteBuyVolumeRaw20m: "1000",
    quoteSellVolumeRaw20m: "1000"
  };

  const flowAt = (buys: number, sells: number): number =>
    scoreOpportunity(
      eligibleFeatures({
        ...neutralVol,
        uniqueBuyers20m: cfg.flowFloorMinUniqueBuyers20m,
        buyCount20m: buys,
        sellCount20m: sells
      }),
      ELIGIBLE
    ).components.buyFlow;

  it("awards the buy/(sell+1) ratio tiers exactly at the 3/1.5/1 breakpoints", () => {
    expect(flowAt(30, 9)).toBe(15); // 30/10 = 3.0
    expect(flowAt(29, 9)).toBe(10); // 2.9
    expect(flowAt(15, 9)).toBe(10); // 1.5
    expect(flowAt(14, 9)).toBe(6); // 1.4
    expect(flowAt(10, 9)).toBe(6); // 1.0
    expect(flowAt(9, 9)).toBe(0); // 0.9 → sells outpace
  });

  it("adds the net-inflow bonus only on a strict volume excess", () => {
    const withInflow = scoreOpportunity(
      eligibleFeatures({
        uniqueBuyers20m: cfg.flowFloorMinUniqueBuyers20m,
        buyCount20m: 30,
        sellCount20m: 9,
        quoteBuyVolumeRaw20m: "1001",
        quoteSellVolumeRaw20m: "1000"
      }),
      ELIGIBLE
    );
    expect(withInflow.components.buyFlow).toBe(20);
    expect(withInflow.positiveReasons).toContain("Positive net quote inflow");
    expect(flowAt(30, 9)).toBe(15); // equal volumes → no bonus
  });

  it("withholds the inflow bonus (not the ratio points) on a malformed volume string", () => {
    const result = scoreOpportunity(
      eligibleFeatures({
        uniqueBuyers20m: cfg.flowFloorMinUniqueBuyers20m,
        buyCount20m: 30,
        sellCount20m: 9,
        quoteBuyVolumeRaw20m: "not-a-number",
        quoteSellVolumeRaw20m: "1000"
      }),
      ELIGIBLE
    );
    expect(result.components.buyFlow).toBe(15);
    expect(result.riskReasons).toContain(
      "Quote flow volumes are unreadable; net-inflow bonus withheld"
    );
  });

  it("withholds ALL flow points when buy count is below the floor", () => {
    const result = scoreOpportunity(
      eligibleFeatures({
        ...neutralVol,
        uniqueBuyers20m: cfg.flowFloorMinUniqueBuyers20m,
        buyCount20m: cfg.flowFloorMinBuys20m - 1,
        sellCount20m: 0
      }),
      ELIGIBLE
    );
    expect(result.components.buyFlow).toBe(0);
    expect(result.riskReasons).toContain(
      "Recent 20m flow is too thin to score (dust guard)"
    );
  });

  it("withholds ALL flow points when unique 20m buyers are below the floor", () => {
    const result = scoreOpportunity(
      eligibleFeatures({
        ...neutralVol,
        uniqueBuyers20m: cfg.flowFloorMinUniqueBuyers20m - 1,
        buyCount20m: 40,
        sellCount20m: 0
      }),
      ELIGIBLE
    );
    expect(result.components.buyFlow).toBe(0);
    expect(result.riskReasons).toContain(
      "Recent 20m flow is too thin to score (dust guard)"
    );
  });

  it("does not flag a completely inactive window as dust", () => {
    const result = scoreOpportunity(
      eligibleFeatures({
        ...neutralVol,
        uniqueBuyers20m: 0,
        buyCount20m: 0,
        sellCount20m: 0
      }),
      ELIGIBLE
    );
    expect(result.components.buyFlow).toBe(0);
    expect(
      result.riskReasons.some((r) => r.includes("dust guard"))
    ).toBe(false);
  });
});

describe("scoreOpportunity — lowCapTilt FDV boundaries", () => {
  const tilt = (fdv: string | null): number =>
    scoreOpportunity(eligibleFeatures({ estimatedFdvUsd: fdv }), ELIGIBLE)
      .components.lowCapTilt;

  it("awards the zone tiers exactly at the $10k/$15k/$40k/$60k/$100k breakpoints", () => {
    expect(tilt("9999")).toBe(0);
    expect(tilt("10000")).toBe(10);
    expect(tilt("14999")).toBe(10);
    expect(tilt("15000")).toBe(20);
    expect(tilt("40000")).toBe(20);
    expect(tilt("40001")).toBe(12);
    expect(tilt("60000")).toBe(12);
    expect(tilt("60001")).toBe(6);
    expect(tilt("100000")).toBe(6);
    expect(tilt("100001")).toBe(0);
  });

  it("is zero with a risk reason when FDV is unavailable", () => {
    const result = scoreOpportunity(
      eligibleFeatures({ estimatedFdvUsd: null }),
      ELIGIBLE
    );
    expect(result.components.lowCapTilt).toBe(0);
    expect(result.riskReasons).toContain("Estimated FDV is unavailable");
  });

  it("marks the sweet spot in positive reasons", () => {
    const result = scoreOpportunity(
      eligibleFeatures({ estimatedFdvUsd: "22000" }),
      ELIGIBLE
    );
    expect(result.positiveReasons).toContain(
      "Entry FDV is in the measured 10x sweet spot"
    );
  });
});

describe("scoreOpportunity — advisory reasons never move the score", () => {
  const cfg = DEFAULT_SIGNAL_CONFIG;

  it("surfaces an unconfirmed simulation as a risk reason without a point change", () => {
    const passed = scoreOpportunity(eligibleFeatures(), ELIGIBLE);
    const unknown = scoreOpportunity(
      eligibleFeatures({ simulationStatus: "UNKNOWN" }),
      ELIGIBLE
    );
    expect(unknown.score).toBe(passed.score);
    expect(unknown.riskReasons).toContain(
      "Sell simulation is not confirmed (status UNKNOWN)"
    );
    expect(passed.positiveReasons).toContain(
      "Trade simulation passes through the real route"
    );
  });

  it("surfaces ownership and deployer values without scoring them", () => {
    const base = scoreOpportunity(eligibleFeatures(), ELIGIBLE);
    const concentrated = scoreOpportunity(
      eligibleFeatures({
        deployerPctBps: 2_000,
        adjustedTop10PctBps: 7_000,
        largestHolderPctBps: 3_500
      }),
      ELIGIBLE
    );
    expect(concentrated.score).toBe(base.score);
    expect(concentrated.riskReasons).toContain(
      "Deployer holds a large share (2000 bps of supply)"
    );
    expect(concentrated.riskReasons).toContain(
      "Adjusted top-10 ownership is highly concentrated (7000 bps)"
    );
    expect(concentrated.riskReasons).toContain(
      "A single holder controls a large share (3500 bps)"
    );
  });

  it("surfaces buy-shape signatures as risk reasons without a point change", () => {
    const base = scoreOpportunity(eligibleFeatures(), ELIGIBLE);
    const shaped = scoreOpportunity(
      eligibleFeatures({
        buySizeGiniBps: cfg.buySizeGiniHighBps,
        buySizeEntropyBps: cfg.buySizeEntropyLowBps,
        repeatedSizeBuyPctBps: cfg.repeatedSizeBuyHighPctBps
      }),
      ELIGIBLE
    );
    expect(shaped.score).toBe(base.score);
    expect(
      shaped.riskReasons.some((r) => r.includes("highly concentrated in one buyer"))
    ).toBe(true);
    expect(shaped.riskReasons.some((r) => r.includes("Buy-size entropy is low"))).toBe(true);
    expect(
      shaped.riskReasons.some((r) => r.includes("repeat an identical quote size"))
    ).toBe(true);
  });

  it("null holder/ownership/deployer data adds no reasons and no points", () => {
    const result = scoreOpportunity(partialLiveFeatures(), INELIGIBLE);
    expect(
      result.riskReasons.some((r) => r.includes("Deployer holds a large share"))
    ).toBe(false);
    expect(
      result.riskReasons.some((r) => r.includes("top-10 ownership is highly concentrated"))
    ).toBe(false);
  });
});

describe("scoreOpportunity — invalidation reasons surfaced independent of eligibility", () => {
  it("surfaces a risk reason when liquidity has collapsed", () => {
    const result = scoreOpportunity(eligibleFeatures({ liquidityCollapsed: true }), ELIGIBLE);
    expect(result.riskReasons).toContain(
      "Liquidity has collapsed from its observed peak (invalidated)"
    );
  });

  it("surfaces a risk reason when the simulation has regressed", () => {
    const result = scoreOpportunity(eligibleFeatures({ simulationRegressed: true }), ELIGIBLE);
    expect(result.riskReasons).toContain(
      "Trade simulation regressed from a prior PASS to FAIL (invalidated)"
    );
  });

  it("adds neither invalidation reason when both are false/null", () => {
    const result = scoreOpportunity(
      eligibleFeatures({ liquidityCollapsed: false, simulationRegressed: null }),
      ELIGIBLE
    );
    expect(result.riskReasons.some((r) => r.includes("(invalidated)"))).toBe(false);
  });
});
