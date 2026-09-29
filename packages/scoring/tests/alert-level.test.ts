import { describe, expect, it } from "vitest";

import {
  classifyAlertLevel,
  DEFAULT_ALERT_THRESHOLDS,
  evaluateEligibility,
  scoreOpportunity,
  type EligibilityResult,
  type ScoreComponents,
  type ScoreResult
} from "../src/index.js";
import { eligibleFeatures, partialLiveFeatures } from "./fixtures.js";

const th = DEFAULT_ALERT_THRESHOLDS;

const ZERO_COMPONENTS: ScoreComponents = {
  liquidityDepth: 0,
  buyerBreadth: 0,
  buyFlow: 0,
  lowCapTilt: 0
};

function makeScore(score: number): ScoreResult {
  return { score, components: ZERO_COMPONENTS, positiveReasons: [], riskReasons: [] };
}

const ELIGIBLE: EligibilityResult = {
  eligible: true,
  failedRules: [],
  softFailedRules: [],
  reasons: []
};
const INELIGIBLE: EligibilityResult = {
  eligible: false,
  failedRules: ["sellSimulationPass"],
  softFailedRules: [],
  reasons: ["Sell simulation explicitly failed"]
};

// GREEN targets the $15k-$40k 10x sweet spot (2026-07-20 re-cut).
const GREEN_FDV = "22000";

describe("classifyAlertLevel — GREEN (go)", () => {
  it("fires when eligible + all GREEN gates hold", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({ estimatedFdvUsd: GREEN_FDV, uniqueBuyers1h: 60 }),
      ELIGIBLE,
      makeScore(th.greenMinScore)
    );
    expect(level).toBe("GREEN");
  });

  it("falls to YELLOW when score is one below greenMinScore", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({ estimatedFdvUsd: GREEN_FDV, uniqueBuyers1h: 60 }),
      ELIGIBLE,
      makeScore(th.greenMinScore - 1)
    );
    expect(level).toBe("YELLOW");
  });

  it("falls to YELLOW when buyers are below greenMinUniqueBuyers", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({
        estimatedFdvUsd: GREEN_FDV,
        uniqueBuyers1h: th.greenMinUniqueBuyers - 1
      }),
      ELIGIBLE,
      makeScore(90)
    );
    expect(level).toBe("YELLOW");
  });

  it("falls to YELLOW when adjusted top-10 is at/above 4000 bps", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({
        estimatedFdvUsd: GREEN_FDV,
        uniqueBuyers1h: 60,
        adjustedTop10PctBps: 4000
      }),
      ELIGIBLE,
      makeScore(90)
    );
    expect(level).toBe("YELLOW");
  });

  it("treats a NULL adjusted top-10 as satisfied (missing ≠ fail; sim PASS still required)", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({
        estimatedFdvUsd: GREEN_FDV,
        uniqueBuyers1h: 60,
        adjustedTop10PctBps: null
      }),
      ELIGIBLE,
      makeScore(90)
    );
    expect(level).toBe("GREEN");
  });

  it("falls to YELLOW when simulation is not an affirmative PASS", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({
        estimatedFdvUsd: GREEN_FDV,
        uniqueBuyers1h: 60,
        simulationStatus: "UNKNOWN"
      }),
      ELIGIBLE,
      makeScore(90)
    );
    expect(level).toBe("YELLOW");
  });

  it("falls to YELLOW above the $40k GREEN max (the low-10x zone is not 'go')", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({
        estimatedFdvUsd: String(th.greenMaxFdvUsd + 1),
        uniqueBuyers1h: 60
      }),
      ELIGIBLE,
      makeScore(90)
    );
    expect(level).toBe("YELLOW");
  });
});

describe("classifyAlertLevel — YELLOW (research candidate)", () => {
  it("fires at yellowMinScore when eligible + FDV/liquidity ok", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({ estimatedFdvUsd: "50000", uniqueBuyers1h: 40 }),
      ELIGIBLE,
      makeScore(th.yellowMinScore)
    );
    expect(level).toBe("YELLOW");
  });

  it("does not fire one below yellowMinScore (drops to RED when in early-watch band)", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({ estimatedFdvUsd: "25000", uniqueBuyers1h: 40 }),
      ELIGIBLE,
      makeScore(th.yellowMinScore - 1)
    );
    expect(level).toBe("RED");
  });

  it("does not fire below the total-liquidity floor (drops to RED on quote depth)", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({
        estimatedFdvUsd: "25000",
        totalLiquidityUsd: String(th.yellowMinLiquidityUsd - 1),
        uniqueBuyers1h: 40
      }),
      ELIGIBLE,
      makeScore(th.yellowMinScore)
    );
    expect(level).toBe("RED");
  });

  it("a young null-sim $25k runner is YELLOW, not blocked", () => {
    // The headline 2026-07-20 posture: UNKNOWN sim reaches the research
    // tier (flagged); only GREEN demands the affirmative PASS.
    const level = classifyAlertLevel(
      eligibleFeatures({
        estimatedFdvUsd: "25000",
        tokenAgeMinutes: 8,
        simulationStatus: "UNKNOWN",
        effectiveSellLossBps: null,
        uniqueBuyers1h: 40
      }),
      ELIGIBLE,
      makeScore(75)
    );
    expect(level).toBe("YELLOW");
  });

  it("does not reach YELLOW/GREEN for a high score when INELIGIBLE", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({ estimatedFdvUsd: "70000", uniqueBuyers1h: 60 }),
      INELIGIBLE,
      makeScore(95)
    );
    expect(level).not.toBe("YELLOW");
    expect(level).not.toBe("GREEN");
    // FDV 70k sits inside the widened RED early-watch band [10k,100k] and
    // the fixture has no known critical failure → RED, not GRAY.
    expect(level).toBe("RED");
  });
});

describe("classifyAlertLevel — RED (early watch, no eligibility required)", () => {
  it("fires on partial live data (null deployer, UNKNOWN sim) below the score gates", () => {
    const features = partialLiveFeatures();
    const eligibility = evaluateEligibility(features);
    // Partial live data is eligible under the 2026-07-20 contract (flags,
    // not failures) — but a low score keeps it out of YELLOW/GREEN.
    expect(eligibility.eligible).toBe(true);
    const level = classifyAlertLevel(features, eligibility, makeScore(10));
    expect(level).toBe("RED");
  });

  it("respects the FDV band edges", () => {
    const base = { quoteLiquidityUsd: "12000", uniqueBuyers1h: 20 };
    expect(
      classifyAlertLevel(
        partialLiveFeatures({ ...base, estimatedFdvUsd: String(th.redMinFdvUsd) }),
        INELIGIBLE,
        makeScore(0)
      )
    ).toBe("RED");
    expect(
      classifyAlertLevel(
        partialLiveFeatures({
          ...base,
          estimatedFdvUsd: String(th.redMinFdvUsd - 1)
        }),
        INELIGIBLE,
        makeScore(0)
      )
    ).toBe("GRAY");
    expect(
      classifyAlertLevel(
        partialLiveFeatures({ ...base, estimatedFdvUsd: String(th.redMaxFdvUsd) }),
        INELIGIBLE,
        makeScore(0)
      )
    ).toBe("RED");
    expect(
      classifyAlertLevel(
        partialLiveFeatures({
          ...base,
          estimatedFdvUsd: String(th.redMaxFdvUsd + 1)
        }),
        INELIGIBLE,
        makeScore(0)
      )
    ).toBe("GRAY");
  });

  it("gates on QUOTE liquidity, not total", () => {
    // Quote below the floor → GRAY even with deep total liquidity.
    expect(
      classifyAlertLevel(
        partialLiveFeatures({
          estimatedFdvUsd: "25000",
          quoteLiquidityUsd: String(th.redMinLiquidityUsd - 1),
          totalLiquidityUsd: "50000",
          uniqueBuyers1h: 20
        }),
        INELIGIBLE,
        makeScore(0)
      )
    ).toBe("GRAY");
    // Quote at the floor → RED even with a thin total figure.
    expect(
      classifyAlertLevel(
        partialLiveFeatures({
          estimatedFdvUsd: "25000",
          quoteLiquidityUsd: String(th.redMinLiquidityUsd),
          totalLiquidityUsd: "3000",
          uniqueBuyers1h: 20
        }),
        INELIGIBLE,
        makeScore(0)
      )
    ).toBe("RED");
  });

  it("respects the buyer edge", () => {
    expect(
      classifyAlertLevel(
        partialLiveFeatures({
          estimatedFdvUsd: "25000",
          uniqueBuyers1h: th.redMinUniqueBuyers - 1
        }),
        INELIGIBLE,
        makeScore(0)
      )
    ).toBe("GRAY");
    expect(
      classifyAlertLevel(
        partialLiveFeatures({
          estimatedFdvUsd: "25000",
          uniqueBuyers1h: th.redMinUniqueBuyers
        }),
        INELIGIBLE,
        makeScore(0)
      )
    ).toBe("RED");
  });

  it("is blocked by a known critical failure, but not by unknown risk data", () => {
    const criticalPerm = classifyAlertLevel(
      partialLiveFeatures({
        estimatedFdvUsd: "25000",
        uniqueBuyers1h: 20,
        criticalPermissionPresent: true
      }),
      INELIGIBLE,
      makeScore(0)
    );
    expect(criticalPerm).toBe("GRAY");

    const riskFail = classifyAlertLevel(
      partialLiveFeatures({
        estimatedFdvUsd: "25000",
        uniqueBuyers1h: 20,
        riskStatus: "FAIL"
      }),
      INELIGIBLE,
      makeScore(0)
    );
    expect(riskFail).toBe("GRAY");

    // UNKNOWN risk status (the partial-live default) does not block RED.
    const riskUnknown = classifyAlertLevel(
      partialLiveFeatures({ estimatedFdvUsd: "25000", uniqueBuyers1h: 20 }),
      INELIGIBLE,
      makeScore(0)
    );
    expect(riskUnknown).toBe("RED");
  });
});

describe("classifyAlertLevel — GRAY", () => {
  it("returns GRAY when FDV is unavailable", () => {
    const level = classifyAlertLevel(
      partialLiveFeatures({ estimatedFdvUsd: null }),
      INELIGIBLE,
      makeScore(0)
    );
    expect(level).toBe("GRAY");
  });
});

describe("classifyAlertLevel — invalidation cap (liquidity collapse / simulation regression)", () => {
  it("caps at GRAY when liquidityCollapsed is true even with a GREEN-qualifying score", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({
        estimatedFdvUsd: GREEN_FDV,
        uniqueBuyers1h: 60,
        liquidityCollapsed: true
      }),
      ELIGIBLE,
      makeScore(95)
    );
    expect(level).toBe("GRAY");
  });

  it("caps at GRAY when simulationRegressed is true even with a GREEN-qualifying score", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({
        estimatedFdvUsd: GREEN_FDV,
        uniqueBuyers1h: 60,
        simulationRegressed: true
      }),
      ELIGIBLE,
      makeScore(95)
    );
    expect(level).toBe("GRAY");
  });

  it("does not cap GREEN when both invalidation flags are false/null", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({
        estimatedFdvUsd: GREEN_FDV,
        uniqueBuyers1h: 60,
        liquidityCollapsed: false,
        simulationRegressed: null
      }),
      ELIGIBLE,
      makeScore(95)
    );
    expect(level).toBe("GREEN");
  });
});

describe("classifyAlertLevel — 10x-zone band edges (2026-07-20)", () => {
  it("classifies GREEN at both GREEN window edges ($15k and $40k)", () => {
    for (const fdv of [th.greenMinFdvUsd, th.greenMaxFdvUsd]) {
      const level = classifyAlertLevel(
        eligibleFeatures({ estimatedFdvUsd: String(fdv), uniqueBuyers1h: 60 }),
        ELIGIBLE,
        makeScore(th.greenMinScore)
      );
      expect(level).toBe("GREEN");
    }
  });

  it("classifies YELLOW exactly at the $15k YELLOW min with a sub-GREEN score", () => {
    const level = classifyAlertLevel(
      eligibleFeatures({ estimatedFdvUsd: String(th.yellowMinFdvUsd), uniqueBuyers1h: 40 }),
      ELIGIBLE,
      makeScore(th.yellowMinScore)
    );
    expect(level).toBe("YELLOW");
  });

  it("classifies YELLOW exactly at the $60k YELLOW max and RED above it", () => {
    const atMax = classifyAlertLevel(
      eligibleFeatures({ estimatedFdvUsd: String(th.yellowMaxFdvUsd), uniqueBuyers1h: 40 }),
      ELIGIBLE,
      makeScore(th.yellowMinScore)
    );
    expect(atMax).toBe("YELLOW");

    // Above the YELLOW max the candidate is still inside the RED watch band.
    const aboveMax = classifyAlertLevel(
      eligibleFeatures({
        estimatedFdvUsd: String(th.yellowMaxFdvUsd + 1),
        uniqueBuyers1h: 40
      }),
      ELIGIBLE,
      makeScore(th.yellowMinScore)
    );
    expect(aboveMax).toBe("RED");
  });

  it("classifies RED exactly at the $10k RED min without high scores", () => {
    const level = classifyAlertLevel(
      partialLiveFeatures({ estimatedFdvUsd: String(th.redMinFdvUsd) }),
      INELIGIBLE,
      makeScore(0)
    );
    expect(level).toBe("RED");
  });
});

describe("2026-07-20 model behavior — the ≥10x median profile", () => {
  // The winners' median entry vector from the labeled population: quote
  // $5.8k, total $14k, 57 buyers/1h, 20m buy/(sell+1) ratio 3, FDV $22k,
  // sim UNKNOWN (76% of ≥10x winners had null/UNKNOWN sim at entry).
  const medianTenXProfile = () =>
    eligibleFeatures({
      estimatedFdvUsd: "22000",
      quoteLiquidityUsd: "5800",
      totalLiquidityUsd: "14000",
      tokenAgeMinutes: 10,
      uniqueBuyers1h: 57,
      uniqueBuyers20m: 15,
      buyCount20m: 30,
      sellCount20m: 9,
      quoteBuyVolumeRaw20m: "3000000000000000000",
      quoteSellVolumeRaw20m: "1000000000000000000",
      simulationStatus: "UNKNOWN",
      effectiveSellLossBps: null,
      riskStatus: "UNKNOWN"
    });

  it("is eligible (flagged) and scores into the YELLOW-deliverable range", () => {
    const features = medianTenXProfile();
    const eligibility = evaluateEligibility(features);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.reasons).toContain("flag: sim status UNKNOWN");

    const score = scoreOpportunity(features, eligibility);
    // liquidityDepth 6+8 (quote tier + 26% ratio) + buyerBreadth 25 +
    // buyFlow 20 + lowCapTilt 20 = 79 ≥ the 70 delivery floor.
    expect(score.score).toBe(79);

    const level = classifyAlertLevel(features, eligibility, score);
    expect(level).toBe("YELLOW");
  });

  it("the same vector with an explicit sim FAIL is rejected", () => {
    const features = medianTenXProfile();
    const failed = evaluateEligibility({ ...features, simulationStatus: "FAIL" });
    expect(failed.eligible).toBe(false);
    expect(failed.failedRules).toContain("sellSimulationPass");

    const score = scoreOpportunity(
      { ...features, simulationStatus: "FAIL" },
      failed
    );
    const level = classifyAlertLevel(
      { ...features, simulationStatus: "FAIL" },
      failed,
      score
    );
    expect(level).not.toBe("YELLOW");
    expect(level).not.toBe("GREEN");
  });
});
