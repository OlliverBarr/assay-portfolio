/**
 * OPT-IN — assemble one token's candidate feature vector from persisted signals,
 * evaluate eligibility + score + alert level, and print the explainable result.
 * Reads only; sends no alert. Never part of `bun run test`.
 *
 *   bun run validate:candidate -- --token=0x...
 */
import { getAddress, type Address } from "viem";

import { loadChainConfigFromEnv } from "@assay/chain";
import { createDatabase, listTrustedQuotePoolsForToken } from "@assay/database";
import {
  classifyAlertLevel,
  evaluateEligibility,
  scoreOpportunity
} from "@assay/scoring";

import { assembleCandidate } from "./candidate.js";
import {
  alertThresholdsFromTuning,
  eligibilityConfigFromTuning,
  loadDatabaseUrlFromEnv,
  loadWorkerTuningFromEnv,
  WorkerConfigError
} from "./config.js";
import { createLogger } from "./log.js";

function parseTokenArg(): Address {
  const arg = process.argv.find((a) => a.startsWith("--token="));
  const raw = arg?.split("=")[1];
  if (raw === undefined || raw === "") {
    throw new WorkerConfigError("--token", "required, e.g. --token=0x...");
  }
  return getAddress(raw);
}

async function main(): Promise<void> {
  const logger = createLogger();
  const token = parseTokenArg();
  const env = process.env;
  const config = loadChainConfigFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);
  const tuning = loadWorkerTuningFromEnv(env);
  const eligibilityConfig = eligibilityConfigFromTuning(tuning);
  const alertThresholds = alertThresholdsFromTuning(tuning);

  const handle = createDatabase(databaseUrl);
  try {
    await handle.applyMigrations();
    const pools = await listTrustedQuotePoolsForToken(
      handle.db,
      config.chainId,
      token
    );
    const pool = pools[0];
    if (pool === undefined) {
      throw new WorkerConfigError(
        "--token",
        `no trusted-quote pool found for token ${token}`
      );
    }

    const features = await assembleCandidate(handle.db, pool, new Date());
    if (features === null) {
      logger.info("validate_candidate.no_features", {
        token,
        poolAddress: pool.poolAddress,
        note: "no enrichment snapshot yet — run enrich:once first"
      });
      return;
    }

    const eligibility = evaluateEligibility(features, eligibilityConfig);
    const score = scoreOpportunity(features, eligibility);
    const level = classifyAlertLevel(features, eligibility, score, alertThresholds);

    logger.info("validate_candidate.result", {
      token,
      poolAddress: pool.poolAddress,
      alertLevel: level,
      eligible: eligibility.eligible,
      failedRules: eligibility.failedRules,
      score: score.score,
      components: score.components,
      estimatedFdvUsd: features.estimatedFdvUsd,
      totalLiquidityUsd: features.totalLiquidityUsd,
      uniqueBuyers1h: features.uniqueBuyers1h,
      riskStatus: features.riskStatus,
      simulationStatus: features.simulationStatus,
      holderCount: features.holderCount,
      adjustedTop10PctBps: features.adjustedTop10PctBps,
      liquidityDrawdownBps: features.liquidityDrawdownBps,
      minutesAbove80PctPeakLiquidity: features.minutesAbove80PctPeakLiquidity,
      liquidityCollapsed: features.liquidityCollapsed,
      sellSlippageCurve: features.sellSlippageCurve,
      simulationRegressed: features.simulationRegressed,
      floatBps: features.floatBps,
      supplyInPoolBps: features.supplyInPoolBps,
      deployerTokenCount: features.deployerTokenCount,
      deployerPriorSurvived: features.deployerPriorSurvived,
      deployerPriorDied: features.deployerPriorDied,
      buySizeGiniBps: features.buySizeGiniBps,
      buySizeEntropyBps: features.buySizeEntropyBps,
      repeatedSizeBuyPctBps: features.repeatedSizeBuyPctBps,
      earlyBuyerRetentionBps: features.earlyBuyerRetentionBps,
      cohortSize: features.cohortSize,
      cohortBuyerPercentileBps: features.cohortBuyerPercentileBps,
      cohortNetInflowPercentileBps: features.cohortNetInflowPercentileBps,
      positiveReasons: score.positiveReasons,
      riskReasons: score.riskReasons
    });
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  createLogger().error("validate_candidate.crashed", { error });
  process.exit(1);
});
