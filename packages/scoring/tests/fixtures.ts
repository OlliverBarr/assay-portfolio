import type { CandidateFeatures } from "../src/index.js";

/**
 * A candidate that PASSES every eligibility rule. Individual tests override one
 * field at a time to probe a single rule boundary. Holder/deployer/sim fields
 * are populated here (unlike MVP live data) so the "all rules pass" baseline is
 * reachable; reduced-scope behavior is exercised by explicit null/UNKNOWN
 * overrides in the tests that need it.
 */
export function eligibleFeatures(
  overrides: Partial<CandidateFeatures> = {}
): CandidateFeatures {
  return {
    chainId: 4242,
    tokenAddress: "0xtoken",
    poolAddress: "0xpool",
    blockNumber: 1_000n,
    capturedAt: new Date("2026-07-10T12:00:00.000Z"),
    tokenAgeMinutes: 30,

    priceUsd: "0.001",
    estimatedFdvUsd: "50000",
    quoteLiquidityUsd: "20000",
    totalLiquidityUsd: "30000",

    uniqueBuyers20m: 40,
    uniqueBuyers1h: 60,
    buyCount20m: 80,
    sellCount20m: 20,
    quoteBuyVolumeRaw20m: "3000000000000000000",
    quoteSellVolumeRaw20m: "1000000000000000000",
    hasActivity: true,

    riskStatus: "PASS",
    simulationStatus: "PASS",
    effectiveSellLossBps: 200,
    criticalPermissionPresent: false,
    isProxy: false,
    verificationStatus: "VERIFIED",
    hasRisk: true,

    holderCount: 300,
    adjustedHolderCount: 250,
    largestHolderPctBps: 800,
    adjustedTop10PctBps: 2_500,
    deployerPctBps: 300,
    holderClusterScoreBps: 100,

    peakQuoteLiquidityUsd: null,
    liquidityDrawdownBps: null,
    minutesAbove80PctPeakLiquidity: null,
    liquidityCollapsed: null,

    sellSlippageCurve: null,
    simulationRegressed: null,

    floatBps: null,
    supplyInPoolBps: null,

    deployerTokenCount: null,
    deployerPriorSurvived: null,
    deployerPriorDied: null,

    buySizeGiniBps: null,
    buySizeEntropyBps: null,
    repeatedSizeBuyPctBps: null,

    earlyBuyerRetentionBps: null,

    cohortSize: null,
    cohortBuyerPercentileBps: null,
    cohortNetInflowPercentileBps: null,

    ...overrides
  };
}

/**
 * A candidate reflecting current MVP live data: enrichment + activity present,
 * but deployer ownership null and simulation UNKNOWN, holders not yet computed.
 * FDV/liquidity/buyers sit in the RED early-watch band.
 */
export function partialLiveFeatures(
  overrides: Partial<CandidateFeatures> = {}
): CandidateFeatures {
  return eligibleFeatures({
    estimatedFdvUsd: "25000",
    quoteLiquidityUsd: "12000",
    totalLiquidityUsd: "18000",
    uniqueBuyers20m: 8,
    uniqueBuyers1h: 10,
    simulationStatus: "UNKNOWN",
    effectiveSellLossBps: null,
    deployerPctBps: null,
    holderCount: null,
    adjustedHolderCount: null,
    largestHolderPctBps: null,
    adjustedTop10PctBps: null,
    holderClusterScoreBps: null,
    riskStatus: "UNKNOWN",
    ...overrides
  });
}
