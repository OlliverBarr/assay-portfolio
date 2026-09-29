import { describe, expect, it } from "vitest";

import {
  DEFAULT_ELIGIBILITY_CONFIG,
  evaluateEligibility
} from "../src/index.js";
import { eligibleFeatures, partialLiveFeatures } from "./fixtures.js";

const cfg = DEFAULT_ELIGIBILITY_CONFIG;

describe("evaluateEligibility — baseline", () => {
  it("is eligible when every rule passes", () => {
    const result = evaluateEligibility(eligibleFeatures());
    expect(result.eligible).toBe(true);
    expect(result.failedRules).toEqual([]);
    expect(result.softFailedRules).toEqual([]);
    expect(result.reasons).toContain("All eligibility requirements are satisfied");
  });
});

describe("evaluateEligibility — FDV band boundaries", () => {
  it("passes exactly at the minimum", () => {
    const r = evaluateEligibility(
      eligibleFeatures({ estimatedFdvUsd: String(cfg.minFdvUsd) })
    );
    expect(r.failedRules).not.toContain("fdvBand");
  });

  it("fails just below the minimum", () => {
    const r = evaluateEligibility(
      eligibleFeatures({ estimatedFdvUsd: String(cfg.minFdvUsd - 1) })
    );
    expect(r.failedRules).toContain("fdvBand");
    expect(r.eligible).toBe(false);
  });

  it("passes exactly at the maximum", () => {
    const r = evaluateEligibility(
      eligibleFeatures({ estimatedFdvUsd: String(cfg.maxFdvUsd) })
    );
    expect(r.failedRules).not.toContain("fdvBand");
  });

  it("fails just above the maximum", () => {
    const r = evaluateEligibility(
      eligibleFeatures({ estimatedFdvUsd: String(cfg.maxFdvUsd + 1) })
    );
    expect(r.failedRules).toContain("fdvBand");
  });

  it("fails when FDV is null", () => {
    const r = evaluateEligibility(eligibleFeatures({ estimatedFdvUsd: null }));
    expect(r.failedRules).toContain("fdvBand");
  });
});

describe("evaluateEligibility — liquidity boundaries", () => {
  it("total liquidity passes at the minimum and fails just below", () => {
    expect(
      evaluateEligibility(
        eligibleFeatures({ totalLiquidityUsd: String(cfg.minTotalLiquidityUsd) })
      ).failedRules
    ).not.toContain("minTotalLiquidity");
    expect(
      evaluateEligibility(
        eligibleFeatures({ totalLiquidityUsd: String(cfg.minTotalLiquidityUsd - 1) })
      ).failedRules
    ).toContain("minTotalLiquidity");
  });

  it("quote liquidity passes at the minimum and fails just below", () => {
    expect(
      evaluateEligibility(
        eligibleFeatures({ quoteLiquidityUsd: String(cfg.minQuoteLiquidityUsd) })
      ).failedRules
    ).not.toContain("minQuoteLiquidity");
    expect(
      evaluateEligibility(
        eligibleFeatures({ quoteLiquidityUsd: String(cfg.minQuoteLiquidityUsd - 1) })
      ).failedRules
    ).toContain("minQuoteLiquidity");
  });

  it("fails each liquidity rule when its USD field is null", () => {
    expect(
      evaluateEligibility(eligibleFeatures({ totalLiquidityUsd: null })).failedRules
    ).toContain("minTotalLiquidity");
    expect(
      evaluateEligibility(eligibleFeatures({ quoteLiquidityUsd: null })).failedRules
    ).toContain("minQuoteLiquidity");
  });
});

describe("evaluateEligibility — age boundary", () => {
  it("default floor is 0: a brand-new token passes", () => {
    expect(
      evaluateEligibility(eligibleFeatures({ tokenAgeMinutes: 0 })).failedRules
    ).not.toContain("minAge");
  });

  it("an explicit config floor still gates below it", () => {
    const withFloor = { ...cfg, minAgeMinutes: 20 };
    expect(
      evaluateEligibility(
        eligibleFeatures({ tokenAgeMinutes: 19 }),
        withFloor
      ).failedRules
    ).toContain("minAge");
    expect(
      evaluateEligibility(
        eligibleFeatures({ tokenAgeMinutes: 20 }),
        withFloor
      ).failedRules
    ).not.toContain("minAge");
  });
});

describe("evaluateEligibility — unique buyers boundary (quality, advisory)", () => {
  it("passes at the minimum and fails just below without affecting eligible", () => {
    expect(
      evaluateEligibility(
        eligibleFeatures({ uniqueBuyers1h: cfg.minUniqueBuyers })
      ).softFailedRules
    ).not.toContain("minUniqueBuyers");
    const r = evaluateEligibility(
      eligibleFeatures({ uniqueBuyers1h: cfg.minUniqueBuyers - 1 })
    );
    expect(r.softFailedRules).toContain("minUniqueBuyers");
    expect(r.failedRules).not.toContain("minUniqueBuyers");
    expect(r.eligible).toBe(true);
    expect(r.reasons.some((reason) => reason.startsWith("quality: ") && reason.includes("Unique buyers"))).toBe(true);
  });
});

describe("evaluateEligibility — deployer ownership boundary (quality, advisory)", () => {
  it("passes at the maximum and fails just above without affecting eligible", () => {
    expect(
      evaluateEligibility(
        eligibleFeatures({ deployerPctBps: cfg.maxDeployerPctBps })
      ).softFailedRules
    ).not.toContain("maxDeployerPct");
    const r = evaluateEligibility(
      eligibleFeatures({ deployerPctBps: cfg.maxDeployerPctBps + 1 })
    );
    expect(r.softFailedRules).toContain("maxDeployerPct");
    expect(r.failedRules).not.toContain("maxDeployerPct");
    expect(r.eligible).toBe(true);
  });

  it("soft-fails on null deployer ownership (MVP reduced scope) without affecting eligible", () => {
    const r = evaluateEligibility(eligibleFeatures({ deployerPctBps: null }));
    expect(r.softFailedRules).toContain("maxDeployerPct");
    expect(r.failedRules).not.toContain("maxDeployerPct");
    expect(r.eligible).toBe(true);
    expect(
      r.reasons.some(
        (reason) => reason === "quality: Deployer ownership is unavailable"
      )
    ).toBe(true);
  });
});

describe("evaluateEligibility — adjusted top-10 boundary (quality, advisory)", () => {
  it("passes at the maximum and fails just above without affecting eligible", () => {
    expect(
      evaluateEligibility(
        eligibleFeatures({ adjustedTop10PctBps: cfg.maxAdjustedTop10PctBps })
      ).softFailedRules
    ).not.toContain("maxAdjustedTop10Pct");
    const r = evaluateEligibility(
      eligibleFeatures({ adjustedTop10PctBps: cfg.maxAdjustedTop10PctBps + 1 })
    );
    expect(r.softFailedRules).toContain("maxAdjustedTop10Pct");
    expect(r.failedRules).not.toContain("maxAdjustedTop10Pct");
    expect(r.eligible).toBe(true);
  });

  it("soft-fails when adjusted top-10 is null without affecting eligible", () => {
    const r = evaluateEligibility(eligibleFeatures({ adjustedTop10PctBps: null }));
    expect(r.softFailedRules).toContain("maxAdjustedTop10Pct");
    expect(r.failedRules).not.toContain("maxAdjustedTop10Pct");
    expect(r.eligible).toBe(true);
  });

  it("a candidate failing only quality rules is eligible", () => {
    const r = evaluateEligibility(
      eligibleFeatures({
        uniqueBuyers1h: cfg.minUniqueBuyers - 1,
        deployerPctBps: null,
        adjustedTop10PctBps: cfg.maxAdjustedTop10PctBps + 1
      })
    );
    expect(r.failedRules).toEqual([]);
    expect(r.softFailedRules).toEqual(
      expect.arrayContaining([
        "minUniqueBuyers",
        "maxDeployerPct",
        "maxAdjustedTop10Pct"
      ])
    );
    expect(r.eligible).toBe(true);
  });

  it("a candidate failing a hard rule is not eligible even with clean quality rules", () => {
    const r = evaluateEligibility(
      eligibleFeatures({ totalLiquidityUsd: String(cfg.minTotalLiquidityUsd - 1) })
    );
    expect(r.softFailedRules).toEqual([]);
    expect(r.failedRules).toContain("minTotalLiquidity");
    expect(r.eligible).toBe(false);
  });
});

describe("evaluateEligibility — trusted quote / simulation / permissions", () => {
  it("fails when no pool address is present", () => {
    expect(
      evaluateEligibility(eligibleFeatures({ poolAddress: "" })).failedRules
    ).toContain("trustedQuotePresent");
  });

  it("rejects only an explicit sim FAIL; UNKNOWN is eligible but flagged", () => {
    expect(
      evaluateEligibility(eligibleFeatures({ simulationStatus: "PASS" })).failedRules
    ).not.toContain("sellSimulationPass");
    const unknown = evaluateEligibility(
      eligibleFeatures({ simulationStatus: "UNKNOWN" })
    );
    expect(unknown.failedRules).not.toContain("sellSimulationPass");
    expect(unknown.eligible).toBe(true);
    expect(unknown.reasons).toContain("flag: sim status UNKNOWN");
    expect(
      evaluateEligibility(eligibleFeatures({ simulationStatus: "FAIL" })).failedRules
    ).toContain("sellSimulationPass");
  });

  it("flags a null effective sell loss instead of failing; a known excess loss fails hard", () => {
    const unknownLoss = evaluateEligibility(
      eligibleFeatures({ effectiveSellLossBps: null })
    );
    expect(unknownLoss.failedRules).not.toContain("maxEffectiveSellLoss");
    expect(unknownLoss.eligible).toBe(true);
    expect(unknownLoss.reasons).toContain("flag: effective sell loss unknown");
    expect(
      evaluateEligibility(
        eligibleFeatures({ effectiveSellLossBps: cfg.maxEffectiveSellLossBps + 1 })
      ).failedRules
    ).toContain("maxEffectiveSellLoss");
    expect(
      evaluateEligibility(
        eligibleFeatures({ effectiveSellLossBps: cfg.maxEffectiveSellLossBps })
      ).failedRules
    ).not.toContain("maxEffectiveSellLoss");
  });

  it("fails when a critical permission is present", () => {
    expect(
      evaluateEligibility(
        eligibleFeatures({ criticalPermissionPresent: true })
      ).failedRules
    ).toContain("noCriticalPermission");
  });
});

describe("evaluateEligibility — missing safety data is flagged, not failed", () => {
  it("partial live data (sim UNKNOWN, null sell loss) is eligible with flags; quality issues stay advisory", () => {
    const result = evaluateEligibility(partialLiveFeatures());
    // 2026-07-20 contract: 76% of ≥10x winners had null/UNKNOWN sim at
    // entry and 0 had FAIL — missing safety data must not gate eligibility.
    expect(result.eligible).toBe(true);
    expect(result.failedRules).toEqual([]);
    expect(result.reasons).toContain("flag: sim status UNKNOWN");
    expect(result.reasons).toContain("flag: effective sell loss unknown");
    expect(result.softFailedRules).toEqual(
      expect.arrayContaining([
        "maxDeployerPct",
        "maxAdjustedTop10Pct",
        "minUniqueBuyers"
      ])
    );
    const qualityReasons = result.reasons.filter((reason) =>
      reason.startsWith("quality: ")
    );
    expect(qualityReasons.length).toBe(result.softFailedRules.length);
  });

  it("an explicit sim FAIL (honeypot signature) is still rejected", () => {
    const result = evaluateEligibility(
      partialLiveFeatures({ simulationStatus: "FAIL" })
    );
    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain("sellSimulationPass");
  });
});

describe("evaluateEligibility — liquidity collapse (invalidation, not a threshold)", () => {
  it("fails when liquidityCollapsed is true", () => {
    const r = evaluateEligibility(eligibleFeatures({ liquidityCollapsed: true }));
    expect(r.failedRules).toContain("liquidityNotCollapsed");
    expect(r.eligible).toBe(false);
  });

  it("passes when liquidityCollapsed is false", () => {
    const r = evaluateEligibility(eligibleFeatures({ liquidityCollapsed: false }));
    expect(r.failedRules).not.toContain("liquidityNotCollapsed");
  });

  it("passes when liquidityCollapsed is null — an unknown trajectory is not a collapse", () => {
    const r = evaluateEligibility(eligibleFeatures({ liquidityCollapsed: null }));
    expect(r.failedRules).not.toContain("liquidityNotCollapsed");
    expect(r.eligible).toBe(true);
  });
});
