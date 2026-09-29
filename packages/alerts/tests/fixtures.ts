import type {
  AlertLevel,
  CandidateFeatures,
  EligibilityResult,
  ScoreResult
} from "@assay/scoring";
import type { AlertSentRow } from "@assay/database";

import type { AlertContext } from "../src/index.js";

export function makeFeatures(
  overrides: Partial<CandidateFeatures> = {}
): CandidateFeatures {
  return {
    chainId: 8453,
    tokenAddress: "0xToKeN0000000000000000000000000000000001",
    poolAddress: "0xPooL0000000000000000000000000000000000a1",
    blockNumber: 123n,
    capturedAt: new Date("2026-07-10T00:00:00Z"),
    tokenAgeMinutes: 45,
    priceUsd: "0.0012",
    estimatedFdvUsd: "123456",
    quoteLiquidityUsd: "18000",
    totalLiquidityUsd: "45000",
    uniqueBuyers20m: 22,
    uniqueBuyers1h: 52,
    buyCount20m: 40,
    sellCount20m: 8,
    quoteBuyVolumeRaw20m: "1000000",
    quoteSellVolumeRaw20m: "200000",
    hasActivity: true,
    riskStatus: "PASS",
    simulationStatus: "UNKNOWN",
    effectiveSellLossBps: null,
    criticalPermissionPresent: false,
    isProxy: false,
    verificationStatus: "VERIFIED",
    hasRisk: true,
    holderCount: 120,
    adjustedHolderCount: 110,
    largestHolderPctBps: 900,
    adjustedTop10PctBps: 3200,
    deployerPctBps: null,
    holderClusterScoreBps: null,
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

export function makeEligibility(
  overrides: Partial<EligibilityResult> = {}
): EligibilityResult {
  return {
    eligible: false,
    failedRules: ["deployerPct", "sellSimulation"],
    softFailedRules: [],
    reasons: ["deployer ownership unknown", "sell simulation not PASS"],
    ...overrides
  };
}

export function makeScore(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    score: 78,
    components: {
      liquidityDepth: 26,
      buyerBreadth: 17,
      buyFlow: 15,
      lowCapTilt: 20
    },
    positiveReasons: [
      "deep quote liquidity",
      "strong organic buying",
      "healthy holder distribution",
      "trailing extra reason"
    ],
    riskReasons: ["deployer ownership unknown", "sell simulation not PASS"],
    ...overrides
  };
}

export function makeContext(
  level: AlertLevel,
  overrides: Partial<AlertContext> = {}
): AlertContext {
  return {
    features: makeFeatures(),
    eligibility: makeEligibility(),
    score: makeScore(),
    level,
    tokenName: "Fixture Token",
    tokenSymbol: "FIX",
    ...overrides
  };
}

export function makeAlertRow(
  overrides: Partial<AlertSentRow> = {}
): AlertSentRow {
  return {
    id: 1n,
    chainId: 8453,
    tokenAddress: "0xToKeN0000000000000000000000000000000001",
    poolAddress: "0xPooL0000000000000000000000000000000000a1",
    alertLevel: "RED",
    score: 60,
    sentAt: new Date("2026-07-10T00:00:00Z"),
    reason: "first-alert",
    transport: "dry-run",
    delivered: true,
    ...overrides
  };
}
