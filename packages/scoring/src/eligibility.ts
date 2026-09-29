import { parseUsdNumber } from "./numeric.js";
import {
  DEFAULT_ELIGIBILITY_CONFIG,
  type CandidateFeatures,
  type EligibilityConfig,
  type EligibilityResult
} from "./types.js";

/**
 * Apply the deterministic eligibility gate from docs/scoring-model.md to a
 * candidate feature vector. Rules are tiered:
 *
 * - HARD rules gate `eligible` directly. They split into two contracts:
 *   - Coverage-complete rules (fdvBand, minTotalLiquidity, minQuoteLiquidity,
 *     trustedQuotePresent) keep missing-data-fails semantics: these values
 *     exist for every real candidate, so a null IS evidence of a problem.
 *   - Explicit-failure rules (sellSimulationPass, maxEffectiveSellLoss,
 *     noCriticalPermission, liquidityNotCollapsed) fail ONLY on affirmative
 *     evidence of danger: sim status FAIL, a known sell loss above the cap,
 *     a detected critical permission, an observed liquidity collapse.
 *     Missing/UNKNOWN/ERROR/STALE data does NOT fail; it is surfaced in
 *     `reasons` as a `flag:` entry instead.
 * - QUALITY rules (minUniqueBuyers, maxDeployerPct, maxAdjustedTop10Pct) are
 *   advisory only: a failure (including missing data) lands in
 *   `softFailedRules` with a `quality:`-prefixed reason and never flips
 *   `eligible`.
 *
 * Rationale (2026-07-20 model rebuild, docs/scoring-model.md change log):
 * safety simulation lags pool discovery. Of the 156 ≥10x winners in the
 * labeled population, 76% had a null/UNKNOWN sim at entry and ZERO had an
 * explicit FAIL; requiring affirmative PASS admitted only 24% of them while
 * an explicit-failure gate admits 99% and still rejects every one of the
 * 550 explicit-FAIL honeypots. UNKNOWN is not PASS: it is routed to
 * "eligible but flagged" for manual research, and the GREEN (go) alert tier
 * separately requires affirmative sim PASS (see classifyAlertLevel).
 *
 * minAgeMinutes defaults to 0 (the old 20-minute floor excluded >50% of
 * ≥10x winners); the check remains so an env override can restore a floor.
 *
 * Every requirement is checked independently and any failure is recorded
 * with a machine-stable key (`failedRules` or `softFailedRules`) plus a
 * human-readable reason (`reasons`).
 *
 * USD comparisons parse the decimal-string fields with `Number()` for coarse
 * dollar-band gating only.
 */
export function evaluateEligibility(
  features: CandidateFeatures,
  config: EligibilityConfig = DEFAULT_ELIGIBILITY_CONFIG
): EligibilityResult {
  const failedRules: string[] = [];
  const softFailedRules: string[] = [];
  const reasons: string[] = [];
  const fail = (rule: string, reason: string): void => {
    failedRules.push(rule);
    reasons.push(reason);
  };
  const failQuality = (rule: string, reason: string): void => {
    softFailedRules.push(rule);
    reasons.push(`quality: ${reason}`);
  };

  // --- FDV band ---
  const fdv = parseUsdNumber(features.estimatedFdvUsd);
  if (fdv === null) {
    fail("fdvBand", "Estimated FDV is unavailable");
  } else if (fdv < config.minFdvUsd) {
    fail(
      "fdvBand",
      `Estimated FDV $${fdv} is below the minimum $${config.minFdvUsd}`
    );
  } else if (fdv > config.maxFdvUsd) {
    fail(
      "fdvBand",
      `Estimated FDV $${fdv} is above the maximum $${config.maxFdvUsd}`
    );
  }

  // --- Total liquidity ---
  const totalLiquidity = parseUsdNumber(features.totalLiquidityUsd);
  if (totalLiquidity === null) {
    fail("minTotalLiquidity", "Total liquidity is unavailable");
  } else if (totalLiquidity < config.minTotalLiquidityUsd) {
    fail(
      "minTotalLiquidity",
      `Total liquidity $${totalLiquidity} is below the minimum $${config.minTotalLiquidityUsd}`
    );
  }

  // --- Quote liquidity ---
  const quoteLiquidity = parseUsdNumber(features.quoteLiquidityUsd);
  if (quoteLiquidity === null) {
    fail("minQuoteLiquidity", "Quote liquidity is unavailable");
  } else if (quoteLiquidity < config.minQuoteLiquidityUsd) {
    fail(
      "minQuoteLiquidity",
      `Quote liquidity $${quoteLiquidity} is below the minimum $${config.minQuoteLiquidityUsd}`
    );
  }

  // --- Liquidity collapse (LP-pull invalidation) ---
  // Deliberate exception to the "missing data fails its rule" convention used
  // by every other check in this gate: collapse is an invalidation *event*,
  // not a min/max threshold on a value we expect to have. An unknown
  // trajectory (`null`, e.g. a token first observed too recently for a
  // meaningful peak) is NOT evidence of collapse, so it must not fail here.
  if (features.liquidityCollapsed === true) {
    fail(
      "liquidityNotCollapsed",
      "Quote liquidity has collapsed from its observed peak (possible LP pull)"
    );
  }

  // --- Age (default floor 0; env-tunable, see doc-comment) ---
  if (features.tokenAgeMinutes < config.minAgeMinutes) {
    fail(
      "minAge",
      `Token age ${features.tokenAgeMinutes}m is below the minimum ${config.minAgeMinutes}m`
    );
  }

  // --- Unique buyers (quality: advisory, does not gate eligibility) ---
  if (features.uniqueBuyers1h < config.minUniqueBuyers) {
    failQuality(
      "minUniqueBuyers",
      `Unique buyers ${features.uniqueBuyers1h} is below the minimum ${config.minUniqueBuyers}`
    );
  }

  // --- Effective sell loss (explicit-failure rule: null is flagged, not failed) ---
  if (features.effectiveSellLossBps === null) {
    reasons.push("flag: effective sell loss unknown");
  } else if (features.effectiveSellLossBps > config.maxEffectiveSellLossBps) {
    fail(
      "maxEffectiveSellLoss",
      `Effective sell loss ${features.effectiveSellLossBps}bps exceeds the maximum ${config.maxEffectiveSellLossBps}bps`
    );
  }

  // --- Deployer ownership (quality: advisory, does not gate eligibility) ---
  if (features.deployerPctBps === null) {
    failQuality("maxDeployerPct", "Deployer ownership is unavailable");
  } else if (features.deployerPctBps > config.maxDeployerPctBps) {
    failQuality(
      "maxDeployerPct",
      `Deployer ownership ${features.deployerPctBps}bps exceeds the maximum ${config.maxDeployerPctBps}bps`
    );
  }

  // --- Adjusted top-10 ownership (quality: advisory, does not gate eligibility) ---
  if (features.adjustedTop10PctBps === null) {
    failQuality("maxAdjustedTop10Pct", "Adjusted top-10 ownership is unavailable");
  } else if (features.adjustedTop10PctBps > config.maxAdjustedTop10PctBps) {
    failQuality(
      "maxAdjustedTop10Pct",
      `Adjusted top-10 ownership ${features.adjustedTop10PctBps}bps exceeds the maximum ${config.maxAdjustedTop10PctBps}bps`
    );
  }

  // --- Trusted quote asset present ---
  if (features.poolAddress.length === 0) {
    fail("trustedQuotePresent", "No trusted-quote pool address is present");
  }

  // --- Sell simulation (explicit-failure rule: only status FAIL rejects) ---
  if (features.simulationStatus === "FAIL") {
    fail("sellSimulationPass", "Sell simulation explicitly failed (honeypot signature)");
  } else if (features.simulationStatus !== "PASS") {
    reasons.push(`flag: sim status ${features.simulationStatus}`);
  }

  // --- No critical privileged permission ---
  if (features.criticalPermissionPresent) {
    fail("noCriticalPermission", "A critical privileged permission is present");
  }

  const eligible = failedRules.length === 0;
  if (eligible) reasons.push("All eligibility requirements are satisfied");

  return { eligible, failedRules, softFailedRules, reasons };
}
