import type { Address } from "viem";

import {
  RetryExhaustedError,
  eip1967BeaconSlot,
  eip1967ImplementationSlot,
  legacyImplementationSlot,
  type ChainConfig
} from "@assay/chain";
import {
  insertTokenRisk,
  insertTradeSimulation,
  listBandTrustedQuotePoolsNeedingRisk,
  listTrustedQuotePoolsNeedingRisk,
  type ActivePoolCriteria,
  type Db,
  type FdvBandCriteria,
  type PoolRow,
  type TokenRiskInsert,
  type TradeSimulationInsert
} from "@assay/database";

import { assessRisk } from "./assess.js";
import { RiskHaltError } from "./errors.js";
import { detectPermissions, type PermissionFinding } from "./permissions.js";
import { classifyProxy, type ProxyReport } from "./proxy.js";
import type { RiskReader } from "./reader.js";
import {
  classifySimulation,
  DEFAULT_SIMULATION_THRESHOLDS,
  type RawRouteSimulation,
  type SimulationClassification,
  type SimulationThresholds
} from "./simulate.js";
import type { RouteSimulator } from "./simulator.js";
import type { RiskStatus } from "./types.js";
import {
  classifyVerification,
  type VerificationMetadata
} from "./verification.js";

/** Default re-assessment window: a verdict older than this is re-checked. */
const DEFAULT_STALENESS_MS = 6 * 60 * 60 * 1000;

export interface RiskPassOptions {
  readonly db: Db;
  readonly reader: RiskReader;
  readonly config: ChainConfig;
  /** Optional route simulator; without it tradeability stays UNKNOWN. */
  readonly simulator?: RouteSimulator;
  readonly thresholds?: SimulationThresholds;
  /** Stops between pools — already-committed verdicts stay committed. */
  readonly signal?: AbortSignal;
  /** Cap the number of pools assessed per pass, across BOTH lanes combined. */
  readonly poolLimit?: number;
  /** Re-assess pools whose latest verdict is older than this. */
  readonly stalenessMs?: number;
  /** Injectable clock for deterministic selection/tests. */
  readonly now?: () => Date;
  /**
   * Band lane: trusted-quote pools whose latest FDV sits inside this band,
   * selected first (newest-created first) up to `poolLimit`. This is the
   * alert-relevant lane (2026-07-12 audit — unbounded, unscoped selection
   * starved band entrants of fresh risk verdicts).
   */
  readonly band?: FdvBandCriteria;
  /**
   * Band-lane quote-liquidity floor in USD (0 disables). Dust pools carry
   * arbitrary nominal FDV but no real quote capital; below the floor they
   * cannot pass eligibility, so band-lane simulation budget skips them.
   * They remain reachable through the backlog lane's staleness sweep.
   */
  readonly bandMinQuoteLiquidityUsd?: number;
  /**
   * Staleness-backlog lane: fills whatever `poolLimit` remainder the band
   * lane didn't use, via the legacy active-set-scoped query. When `band` is
   * absent, this is instead used directly as the legacy `active` scope so
   * opt-in callers keep their existing behavior.
   */
  readonly backlog?: ActivePoolCriteria;
}

export interface RiskPoolError {
  readonly poolAddress: string;
  readonly message: string;
}

export interface RiskPassResult {
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly poolsSelected: number;
  readonly assessed: number;
  readonly passed: number;
  readonly failed: number;
  readonly unknown: number;
  readonly errored: number;
  readonly poolErrors: RiskPoolError[];
  readonly stopped: boolean;
}

interface PoolAssessment {
  readonly risk: TokenRiskInsert;
  readonly simulation: TradeSimulationInsert;
}

/** Rich, human-readable assessment of one pool's token — no persistence. */
export interface PoolRiskAssessment {
  readonly status: RiskStatus;
  readonly verification: VerificationMetadata;
  readonly proxy: ProxyReport;
  readonly permissions: PermissionFinding[];
  readonly simulation: SimulationClassification | null;
  readonly rawSimulation: RawRouteSimulation | null;
  readonly riskReasons: string[];
  readonly positiveReasons: string[];
}

export interface AssessPoolRiskOptions {
  readonly simulator?: RouteSimulator;
  readonly thresholds?: SimulationThresholds;
}

function simulationInsert(
  pool: PoolRow,
  blockNumber: bigint,
  raw: RawRouteSimulation | null,
  classified: SimulationClassification | null
): TradeSimulationInsert {
  return {
    chainId: pool.chainId,
    tokenAddress: pool.baseTokenAddress as string,
    poolAddress: pool.poolAddress,
    blockNumber,
    route: raw?.route ?? pool.factoryKind,
    buyStatus: classified?.buyStatus ?? "UNKNOWN",
    transferStatus: classified?.transferStatus ?? "UNKNOWN",
    sellStatus: classified?.sellStatus ?? "UNKNOWN",
    buyQuoteInRaw: raw?.buyQuoteInRaw?.toString() ?? null,
    buyBaseOutRaw: raw?.buyBaseOutRaw?.toString() ?? null,
    spotBaseOutRaw: raw?.spotBaseOutRaw?.toString() ?? null,
    sellBaseInRaw: raw?.sellBaseInRaw?.toString() ?? null,
    sellQuoteOutRaw: raw?.sellQuoteOutRaw?.toString() ?? null,
    spotQuoteOutRaw: raw?.spotQuoteOutRaw?.toString() ?? null,
    slippageCurve: raw?.slippageCurve ? [...raw.slippageCurve] : null,
    effectiveBuyLossBps: classified?.effectiveBuyLossBps ?? null,
    effectiveSellLossBps: classified?.effectiveSellLossBps ?? null,
    revertReason: null,
    status: classified?.status ?? "UNKNOWN"
  };
}

/**
 * Run the full deterministic assessment for one pool's base token. Reads
 * bytecode + proxy slots + verification, detects permissions on the analyzed
 * logic contract, and (when a simulator is supplied) classifies a route probe.
 * Chain-read failures propagate to the caller for halt/error handling.
 */
export async function assessPoolRisk(
  reader: RiskReader,
  pool: PoolRow,
  blockNumber: bigint,
  options: AssessPoolRiskOptions = {}
): Promise<PoolRiskAssessment> {
  const tokenAddress = pool.baseTokenAddress as Address;

  const tokenCode = await reader.getCode(tokenAddress);
  const implSlot = await reader.getStorageAt(
    tokenAddress,
    eip1967ImplementationSlot
  );
  const beaconSlot = await reader.getStorageAt(tokenAddress, eip1967BeaconSlot);
  const legacySlot = await reader.getStorageAt(
    tokenAddress,
    legacyImplementationSlot
  );

  const proxy = classifyProxy({
    implementation: implSlot,
    beacon: beaconSlot,
    legacy: legacySlot
  });

  // Analyze the logic contract when this is a resolvable proxy; a beacon proxy
  // hides its logic address, so its permissions stay UNKNOWN rather than a
  // false ABSENT read of the thin proxy bytecode.
  let codeToAnalyze = tokenCode;
  if (proxy.isProxy) {
    codeToAnalyze =
      proxy.implementation === null
        ? null
        : await reader.getCode(proxy.implementation);
  }
  const permissions = detectPermissions(codeToAnalyze);

  const verificationRaw = await reader.fetchContractVerification(tokenAddress);
  const verification = classifyVerification(verificationRaw);

  let rawSimulation: RawRouteSimulation | null = null;
  let simulation: SimulationClassification | null = null;
  if (options.simulator !== undefined) {
    rawSimulation = await options.simulator.simulate(pool);
    simulation = classifySimulation(
      rawSimulation,
      options.thresholds ?? DEFAULT_SIMULATION_THRESHOLDS
    );
  }

  const assessment = assessRisk({ verification, proxy, permissions, simulation });

  return {
    status: assessment.status,
    verification,
    proxy,
    permissions,
    simulation,
    rawSimulation,
    riskReasons: assessment.riskReasons,
    positiveReasons: assessment.positiveReasons
  };
}

function toInserts(
  pool: PoolRow,
  blockNumber: bigint,
  assessment: PoolRiskAssessment
): PoolAssessment {
  const risk: TokenRiskInsert = {
    chainId: pool.chainId,
    tokenAddress: pool.baseTokenAddress as string,
    poolAddress: pool.poolAddress,
    blockNumber,
    status: assessment.status,
    verificationStatus: assessment.verification.status,
    isProxy: assessment.proxy.isProxy,
    implementationAddress: assessment.proxy.implementation,
    permissionFindings: assessment.permissions.map((finding) => ({
      kind: finding.kind,
      state: finding.state,
      matchedSelectors: [...finding.matchedSelectors]
    })),
    simulationStatus: assessment.simulation?.status ?? "UNKNOWN",
    effectiveBuyLossBps: assessment.simulation?.effectiveBuyLossBps ?? null,
    effectiveSellLossBps: assessment.simulation?.effectiveSellLossBps ?? null,
    riskReasons: assessment.riskReasons,
    positiveReasons: assessment.positiveReasons,
    nullReason: assessment.status === "UNKNOWN" ? "incomplete-analysis" : null
  };
  return {
    risk,
    simulation: simulationInsert(
      pool,
      blockNumber,
      assessment.rawSimulation,
      assessment.simulation
    )
  };
}

function errorAssessment(
  pool: PoolRow,
  blockNumber: bigint,
  message: string
): PoolAssessment {
  return {
    risk: {
      chainId: pool.chainId,
      tokenAddress: pool.baseTokenAddress as string,
      poolAddress: pool.poolAddress,
      blockNumber,
      status: "ERROR",
      verificationStatus: "UNKNOWN",
      isProxy: null,
      implementationAddress: null,
      permissionFindings: [],
      simulationStatus: "UNKNOWN",
      effectiveBuyLossBps: null,
      effectiveSellLossBps: null,
      riskReasons: [`Risk analysis failed: ${message}`],
      positiveReasons: [],
      nullReason: "analysis-error"
    },
    simulation: simulationInsert(pool, blockNumber, null, null)
  };
}

/**
 * Two-lane pool selection: the band lane (alert-relevant FDV window) runs
 * first, newest-created first, up to `poolLimit`; whatever remainder is left
 * gets filled from the staleness backlog lane, scoped by `backlog`.
 * Deduped by pool address, band lane taking priority. Without `band`, this
 * degrades to the legacy behavior: a single staleness sweep scoped by
 * `backlog` as its active-set criteria (or unscoped when both are absent).
 */
async function selectPools(
  db: Db,
  chainId: number,
  staleBefore: Date,
  options: Pick<
    RiskPassOptions,
    "band" | "backlog" | "poolLimit" | "bandMinQuoteLiquidityUsd"
  >
): Promise<PoolRow[]> {
  const { band, backlog, poolLimit, bandMinQuoteLiquidityUsd } = options;
  if (band === undefined) {
    return listTrustedQuotePoolsNeedingRisk(
      db,
      chainId,
      staleBefore,
      poolLimit,
      backlog
    );
  }

  const bandPools = await listBandTrustedQuotePoolsNeedingRisk(
    db,
    chainId,
    band,
    staleBefore,
    poolLimit ?? Number.MAX_SAFE_INTEGER,
    bandMinQuoteLiquidityUsd ?? 0
  );

  const remainder =
    poolLimit === undefined
      ? undefined
      : Math.max(0, poolLimit - bandPools.length);
  if (backlog === undefined || remainder === 0) return bandPools;

  const backlogPools = await listTrustedQuotePoolsNeedingRisk(
    db,
    chainId,
    staleBefore,
    remainder,
    backlog
  );
  const bandAddresses = new Set(bandPools.map((pool) => pool.poolAddress));
  return [
    ...bandPools,
    ...backlogPools.filter((pool) => !bandAddresses.has(pool.poolAddress))
  ];
}

/**
 * Assess every trusted-quote pool whose verdict is missing or stale.
 *
 * Infra failure (RetryExhaustedError from a chain read) halts the pass with a
 * RiskHaltError so the worker backs off; selection is idempotent, so pending
 * pools are re-assessed next pass. A hostile token that makes a non-infra read
 * throw is recorded as an ERROR verdict and does not starve the rest.
 */
export async function runRiskPass(
  options: RiskPassOptions
): Promise<RiskPassResult> {
  const { db, reader, config } = options;
  const now = options.now ?? (() => new Date());
  const stalenessMs = options.stalenessMs ?? DEFAULT_STALENESS_MS;

  let blockNumber: bigint;
  try {
    blockNumber = await reader.getBlockNumber();
  } catch (error) {
    if (error instanceof RetryExhaustedError) {
      throw new RiskHaltError("chain head read failed", { cause: error });
    }
    throw error;
  }

  const staleBefore = new Date(now().getTime() - stalenessMs);
  const pools = await selectPools(db, config.chainId, staleBefore, options);

  let assessed = 0;
  let passed = 0;
  let failed = 0;
  let unknown = 0;
  let errored = 0;
  let stopped = false;
  const poolErrors: RiskPoolError[] = [];

  for (const pool of pools) {
    if (options.signal?.aborted === true) {
      stopped = true;
      break;
    }
    let assessment: PoolAssessment;
    try {
      const rich = await assessPoolRisk(reader, pool, blockNumber, {
        ...(options.simulator === undefined
          ? {}
          : { simulator: options.simulator }),
        ...(options.thresholds === undefined
          ? {}
          : { thresholds: options.thresholds })
      });
      assessment = toInserts(pool, blockNumber, rich);
    } catch (error) {
      if (error instanceof RetryExhaustedError) {
        throw new RiskHaltError("chain read failed during risk assessment", {
          cause: error
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      poolErrors.push({ poolAddress: pool.poolAddress, message });
      assessment = errorAssessment(pool, blockNumber, message);
    }

    await db.transaction(async (tx) => {
      await insertTokenRisk(tx, assessment.risk);
      await insertTradeSimulation(tx, assessment.simulation);
    });

    assessed += 1;
    switch (assessment.risk.status) {
      case "PASS":
        passed += 1;
        break;
      case "FAIL":
        failed += 1;
        break;
      case "ERROR":
        errored += 1;
        break;
      default:
        unknown += 1;
    }
  }

  return {
    chainId: config.chainId,
    blockNumber,
    poolsSelected: pools.length,
    assessed,
    passed,
    failed,
    unknown,
    errored,
    poolErrors,
    stopped
  };
}
