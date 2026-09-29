import {
  getCohortPercentiles,
  getDeployerLaunchStats,
  getEarlyBuyerRetention,
  getLatestActivitySnapshot,
  getLatestHolderSnapshot,
  getLatestPoolSnapshot,
  getLatestTokenRiskForPool,
  getLatestTradeSimulation,
  getLiquidityTrajectory,
  getSimulationRegression,
  getTokensByAddresses,
  type Db,
  type PoolRow
} from "@assay/database";
import type {
  CandidateFeatures,
  RiskStatus,
  SimulationStatus,
  VerificationStatus
} from "@assay/scoring";

/** Privileged capabilities that, if present, are an automatic risk failure. */
const CRITICAL_PERMISSIONS: Record<string, true> = {
  mint: true,
  blacklist: true,
  pause: true,
  upgradeAdmin: true
};

/**
 * Canonical critical-permission derivation over a risk row's findings.
 * Shared by the live candidate assembly and the performance pass's stored
 * entry features so replayed gate decisions use the same convention.
 */
export function hasCriticalPermission(
  findings: readonly { readonly kind: string; readonly state: string }[]
): boolean {
  for (const finding of findings) {
    if (finding.state === "PRESENT" && CRITICAL_PERMISSIONS[finding.kind] === true) {
      return true;
    }
  }
  return false;
}

/** Tunables for the derived candidate signals. Env-overridable via worker tuning. */
export interface CandidateSignalOptions {
  /** Latest quote liquidity below this fraction of observed peak = LP pull. */
  readonly liquidityCollapseFractionBps: number;
  /** "Early buyer" window measured from the pool's first stored swap. */
  readonly retentionWindowMinutes: number;
  /** Cohort percentiles are withheld below this many same-age peers. */
  readonly cohortMinSize: number;
}

export const DEFAULT_CANDIDATE_SIGNAL_OPTIONS: CandidateSignalOptions = {
  liquidityCollapseFractionBps: 2_000,
  retentionWindowMinutes: 60,
  cohortMinSize: 8
};

/**
 * Cheap pre-gate on the alertable FDV envelope. A pool whose latest snapshot
 * has no FDV or sits outside the envelope classifies GRAY no matter what the
 * other signals say, so assembling the full battery (trajectory, retention,
 * cohort percentiles, deployer history) for it is pure waste — at ~16k
 * active pools that waste turned the scoring pass into tens of minutes.
 */
export interface CandidateFdvGate {
  readonly minFdvUsd: number;
  readonly maxFdvUsd: number;
}

/** Coarse USD threshold read; mirrors parseUsdNumber in @assay/scoring. */
function parseUsdNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/** stillHolding/earlyBuyers in bps; null when there are no early buyers yet. */
function retentionBps(
  retention: { earlyBuyers: number; stillHolding: number } | undefined
): number | null {
  if (retention === undefined || retention.earlyBuyers === 0) return null;
  return Math.round((retention.stillHolding / retention.earlyBuyers) * 10_000);
}

/**
 * Assemble the normalized candidate feature vector for one trusted-quote pool
 * from the latest enrichment snapshot, activity snapshot, risk verdict, and
 * holder snapshot, plus the derived trajectory/provenance/cohort signals.
 * Returns null when there is no enrichment snapshot yet — a token we cannot
 * value is not a candidate. Missing signal data is represented as explicit
 * nulls/UNKNOWN, never silently treated as passing.
 */
export async function assembleCandidate(
  db: Db,
  pool: PoolRow,
  now: Date,
  signals: CandidateSignalOptions = DEFAULT_CANDIDATE_SIGNAL_OPTIONS,
  gate?: CandidateFdvGate
): Promise<CandidateFeatures | null> {
  const tokenAddress = pool.baseTokenAddress;
  if (tokenAddress === null) return null;

  const snapshot = await getLatestPoolSnapshot(db, pool.chainId, pool.poolAddress);
  if (snapshot === undefined) return null;

  if (gate !== undefined) {
    const fdv = parseUsdNumber(snapshot.estimatedFdvUsd);
    if (fdv === null || fdv < gate.minFdvUsd || fdv > gate.maxFdvUsd) {
      return null;
    }
  }

  const ageMs = now.getTime() - pool.discoveredAt.getTime();
  const tokenAgeMinutes = Math.max(0, Math.floor(ageMs / 60_000));

  // Independent DB reads; batched so a pass over many pools stays bounded.
  const [
    activity,
    risk,
    holders,
    trajectory,
    latestSimulation,
    regression,
    retention,
    cohort,
    [tokenRow]
  ] = await Promise.all([
    getLatestActivitySnapshot(db, pool.chainId, pool.poolAddress),
    getLatestTokenRiskForPool(db, pool.chainId, pool.poolAddress),
    getLatestHolderSnapshot(db, pool.chainId, tokenAddress),
    getLiquidityTrajectory(db, pool.chainId, pool.poolAddress),
    getLatestTradeSimulation(db, pool.chainId, tokenAddress),
    getSimulationRegression(db, pool.chainId, tokenAddress),
    getEarlyBuyerRetention(
      db,
      pool.chainId,
      pool.poolAddress,
      tokenAddress,
      signals.retentionWindowMinutes
    ),
    getCohortPercentiles(
      db,
      pool.chainId,
      pool.poolAddress,
      tokenAgeMinutes,
      signals.cohortMinSize
    ),
    getTokensByAddresses(db, pool.chainId, [tokenAddress])
  ]);

  const criticalPermissionPresent =
    risk !== undefined && hasCriticalPermission(risk.permissionFindings);

  // Collapse: latest quote liquidity fell below the configured fraction of
  // observed peak — i.e. drawdown beyond (10000 - fraction) bps.
  const liquidityCollapsed =
    trajectory === undefined
      ? null
      : trajectory.drawdownBps > 10_000 - signals.liquidityCollapseFractionBps;

  // Deployer provenance only counts when the creator is actually RESOLVED;
  // UNKNOWN is retryable ignorance, never a neutral zero.
  const deployerAddress =
    tokenRow !== undefined && tokenRow.deployerStatus === "RESOLVED"
      ? tokenRow.deployerAddress
      : null;
  const deployerStats =
    deployerAddress === null
      ? undefined
      : await getDeployerLaunchStats(db, pool.chainId, deployerAddress, tokenAddress);

  return {
    chainId: pool.chainId,
    tokenAddress,
    poolAddress: pool.poolAddress,
    blockNumber: snapshot.blockNumber,
    capturedAt: now,
    tokenAgeMinutes,

    priceUsd: snapshot.priceUsd,
    estimatedFdvUsd: snapshot.estimatedFdvUsd,
    quoteLiquidityUsd: snapshot.quoteLiquidityUsd,
    totalLiquidityUsd: snapshot.totalLiquidityUsd,

    uniqueBuyers20m: activity?.uniqueBuyers20m ?? 0,
    uniqueBuyers1h: activity?.uniqueBuyers1h ?? 0,
    buyCount20m: activity?.buyCount20m ?? 0,
    sellCount20m: activity?.sellCount20m ?? 0,
    quoteBuyVolumeRaw20m: activity?.quoteBuyVolumeRaw20m ?? "0",
    quoteSellVolumeRaw20m: activity?.quoteSellVolumeRaw20m ?? "0",
    hasActivity: activity !== undefined,

    riskStatus: (risk?.status ?? "UNKNOWN") as RiskStatus,
    simulationStatus: (risk?.simulationStatus ?? "UNKNOWN") as SimulationStatus,
    effectiveSellLossBps: risk?.effectiveSellLossBps ?? null,
    criticalPermissionPresent,
    isProxy: risk?.isProxy ?? null,
    verificationStatus: (risk?.verificationStatus ?? "UNKNOWN") as VerificationStatus,
    hasRisk: risk !== undefined,

    holderCount: holders?.holderCount ?? null,
    adjustedHolderCount: holders?.adjustedHolderCount ?? null,
    largestHolderPctBps: holders?.largestHolderPctBps ?? null,
    adjustedTop10PctBps: holders?.adjustedTop10PctBps ?? null,
    deployerPctBps: holders?.deployerPctBps ?? null,
    holderClusterScoreBps: holders?.holderClusterScoreBps ?? null,

    peakQuoteLiquidityUsd: trajectory?.peakQuoteLiquidityUsd ?? null,
    liquidityDrawdownBps: trajectory?.drawdownBps ?? null,
    minutesAbove80PctPeakLiquidity: trajectory?.minutesAbove80PctPeak ?? null,
    liquidityCollapsed,

    sellSlippageCurve: latestSimulation?.slippageCurve ?? null,
    simulationRegressed: regression?.regressed ?? null,

    floatBps: holders?.floatBps ?? null,
    supplyInPoolBps: holders?.supplyInPoolBps ?? null,

    deployerTokenCount: deployerStats?.tokenCount ?? null,
    deployerPriorSurvived: deployerStats?.survived ?? null,
    deployerPriorDied: deployerStats?.died ?? null,

    buySizeGiniBps: activity?.buySizeGiniBps ?? null,
    buySizeEntropyBps: activity?.buySizeEntropyBps ?? null,
    repeatedSizeBuyPctBps: activity?.repeatedSizeBuyPctBps ?? null,

    earlyBuyerRetentionBps: retentionBps(retention),

    cohortSize: cohort?.cohortSize ?? null,
    cohortBuyerPercentileBps: cohort?.buyerPercentileBps ?? null,
    cohortNetInflowPercentileBps: cohort?.netInflowPercentileBps ?? null
  };
}
