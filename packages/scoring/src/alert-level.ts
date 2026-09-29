import { parseUsdNumber } from "./numeric.js";
import {
  DEFAULT_ALERT_THRESHOLDS,
  type AlertLevel,
  type AlertThresholds,
  type CandidateFeatures,
  type EligibilityResult,
  type ScoreResult
} from "./types.js";

/**
 * Classify the alert tier from features, eligibility, score, and thresholds.
 *
 * Stoplight semantics, checked strongest-first
 * (GREEN → YELLOW → RED → GRAY); the first satisfied tier wins.
 * Bands re-cut 2026-07-20 to the measured 10x zone (docs/scoring-model.md):
 *
 * - GREEN (go) targets the $15-40k sweet spot and is the safety-guarded
 *   tier: it requires eligibility, an affirmative sim PASS, and the
 *   adjusted-top-10 cap WHEN the value is known (null is treated as
 *   satisfied, consistent with the missing≠fail contract; the operator
 *   still sees "sim PASS + unknown ownership" in the reasons).
 * - YELLOW (research) is the young-runner tier: eligibility + score + FDV
 *   in $15-60k + total liquidity. Sim may be UNKNOWN (flagged, not
 *   blocking); the eligibility gate already rejected explicit FAILs.
 * - RED (early watch) does NOT require eligibility. It gates on QUOTE
 *   liquidity (the dominant filter) and rejects only known critical
 *   failure: a detected critical permission or an explicit risk FAIL.
 *   Null/UNKNOWN risk data does not block RED.
 */
export function classifyAlertLevel(
  features: CandidateFeatures,
  eligibility: EligibilityResult,
  score: ScoreResult,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS
): AlertLevel {
  // --- Invalidation cap ---
  // A liquidity-pull or a simulation regression (prior PASS, now FAIL) means
  // the candidate is no longer the thing that was scored; cap at GRAY
  // regardless of score. The reason is surfaced in `score.riskReasons`
  // (`scoreOpportunity` pushes it there), not here, so it survives even when
  // the caller only looks at the score record.
  if (features.liquidityCollapsed === true || features.simulationRegressed === true) {
    return "GRAY";
  }

  const fdv = parseUsdNumber(features.estimatedFdvUsd);
  const totalLiquidity = parseUsdNumber(features.totalLiquidityUsd);
  const quoteLiquidity = parseUsdNumber(features.quoteLiquidityUsd);
  const buyers = features.uniqueBuyers1h;

  // --- GREEN (go: high-priority manual review) ---
  const greenFdvOk =
    fdv !== null && fdv >= thresholds.greenMinFdvUsd && fdv <= thresholds.greenMaxFdvUsd;
  const greenTop10Ok =
    features.adjustedTop10PctBps === null ||
    features.adjustedTop10PctBps < thresholds.greenMaxAdjustedTop10PctBps;
  if (
    eligibility.eligible &&
    score.score >= thresholds.greenMinScore &&
    buyers >= thresholds.greenMinUniqueBuyers &&
    greenTop10Ok &&
    features.simulationStatus === "PASS" &&
    greenFdvOk
  ) {
    return "GREEN";
  }

  // --- YELLOW (caution: eligible research candidate) ---
  const yellowFdvOk =
    fdv !== null &&
    fdv >= thresholds.yellowMinFdvUsd &&
    fdv <= thresholds.yellowMaxFdvUsd;
  const yellowLiquidityOk =
    totalLiquidity !== null && totalLiquidity >= thresholds.yellowMinLiquidityUsd;
  if (
    eligibility.eligible &&
    score.score >= thresholds.yellowMinScore &&
    yellowFdvOk &&
    yellowLiquidityOk
  ) {
    return "YELLOW";
  }

  // --- RED (stop: early watch; eligibility NOT required) ---
  const redFdvOk =
    fdv !== null &&
    fdv >= thresholds.redMinFdvUsd &&
    fdv <= thresholds.redMaxFdvUsd;
  const redLiquidityOk =
    quoteLiquidity !== null && quoteLiquidity >= thresholds.redMinLiquidityUsd;
  const noKnownCriticalFailure =
    features.criticalPermissionPresent !== true && features.riskStatus !== "FAIL";
  if (
    redFdvOk &&
    redLiquidityOk &&
    buyers >= thresholds.redMinUniqueBuyers &&
    noKnownCriticalFailure
  ) {
    return "RED";
  }

  return "GRAY";
}
