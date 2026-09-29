import {
  getLatestAlert,
  getLatestDeliveredAlertBySimilarName,
  getTokensByAddresses,
  getLatestScoreResultAt,
  insertAlertSent,
  insertEligibilityResult,
  insertScoreResult,
  listBandTrustedQuotePools,
  listTrustedQuotePools,
  type FdvBandCriteria,
  type Db
} from "@assay/database";
import {
  classifyAlertLevel,
  evaluateEligibility,
  scoreOpportunity,
  type AlertLevel,
  type AlertThresholds,
  type CandidateFeatures,
  type EligibilityConfig
} from "@assay/scoring";
import {
  evaluateAlert,
  formatAlert,
  type AlertContext,
  type AlertTransport
} from "@assay/alerts";
import type { ChainConfig } from "@assay/chain";

import { assembleCandidate, type CandidateSignalOptions } from "./candidate.js";

export interface ScoringPassOptions {
  readonly db: Db;
  readonly config: ChainConfig;
  readonly transport: AlertTransport;
  /** "telegram" | "dry-run" — recorded on emitted alerts. */
  readonly transportName: string;
  readonly alertCooldownMs: number;
  /** Alerts scoring below this are stored but not delivered. 0 disables. */
  readonly alertMinScore: number;
  /** Extra RED-only delivery floor; effective is max with alertMinScore. */
  readonly alertMinScoreRed: number;
  /** Same/lower-level re-alerts need this much score improvement. 0 disables. */
  readonly reAlertMinScoreDelta: number;
  /** Eligibility rule thresholds (band-dependent gates come from worker tuning). */
  readonly eligibilityConfig: EligibilityConfig;
  /** Alert tier bands/gates (band-dependent gates come from worker tuning). */
  readonly alertThresholds: AlertThresholds;
  /**
   * Suppress delivery when a DIFFERENT token with the same normalized name
   * delivered within this window, unless the new alert outranks the
   * sibling's level (copycat launch waves, 2026-07-12). 0 disables.
   */
  readonly duplicateNameCooldownMs: number;
  /**
   * Chart URL base (e.g. `https://dexscreener.com/robinhood`); the pool
   * address is appended. Unset -> alerts carry no chart link.
   */
  readonly chartUrlBase?: string;
  readonly signal?: AbortSignal;
  readonly poolLimit?: number;
  readonly now?: () => Date;
  /** Tunables for the derived candidate signals; defaults apply when unset. */
  readonly signals?: CandidateSignalOptions;
  /**
   * Scope selection to a band of trusted-quote pools by latest-snapshot FDV
   * (`listBandTrustedQuotePools`) instead of sweeping the full trusted
   * population. Any pool that can classify above GRAY has an in-band FDV
   * and is therefore in the band by construction — iterating the full
   * trusted population only burns per-pool queries on pools that must
   * classify GRAY. Also passed to `assembleCandidate` as its FDV gate, so
   * an out-of-band pool that slips through selection is still rejected.
   */
  readonly band?: FdvBandCriteria;
  /**
   * Minimum interval between shadow-log persists for the same token's GRAY
   * classifications. Default 1h. See the shadow-logging note on
   * `runScoringPass` for why GRAY is persisted at all.
   */
  readonly shadowIntervalMs?: number;
}

export interface ScoringPassResult {
  readonly chainId: number;
  readonly poolsEvaluated: number;
  readonly candidates: number;
  readonly alertsEmitted: number;
  readonly red: number;
  readonly yellow: number;
  readonly green: number;
  /** GRAY candidates persisted this pass under the shadow-log throttle. */
  readonly shadowLogged: number;
  readonly poolErrors: { poolAddress: string; message: string }[];
  readonly stopped: boolean;
}

function chartUrl(
  chartUrlBase: string | undefined,
  poolAddress: string
): string | undefined {
  if (chartUrlBase === undefined || chartUrlBase === "") return undefined;
  return `${chartUrlBase.replace(/\/+$/, "")}/${poolAddress}`;
}

/**
 * jsonb-safe copy of the feature vector: JSON.stringify (drizzle's jsonb
 * mapping) throws on bigint, and Dates should persist as ISO strings rather
 * than driver-dependent renderings. This bug hid until the first real
 * candidates existed — every persist then failed (production 2026-07-12).
 */
function jsonSafeFeatures(features: CandidateFeatures): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(features)) {
    if (typeof value === "bigint") out[key] = value.toString();
    else if (value instanceof Date) out[key] = value.toISOString();
    else out[key] = value;
  }
  return out;
}

/**
 * Default shadow-log throttle: at most one GRAY persist per token per hour.
 * Calibrating RED/YELLOW/GREEN thresholds needs the counterfactual —
 * the band population that never cleared a tier — but persisting every
 * GRAY classification on every pass (often sub-minute cadence) would
 * dominate the eligibility/score tables with redundant rows for tokens
 * whose signals haven't moved. This throttle keeps one fresh sample per
 * token per interval without losing the non-alerted population.
 */
const DEFAULT_SHADOW_INTERVAL_MS = 3_600_000;

/**
 * One scoring/alert pass over trusted-quote pools: assemble each candidate,
 * evaluate eligibility, score it, classify an alert level, and — for anything
 * above GRAY — persist the eligibility + score history and emit a
 * deduplicated alert every pass (no throttle). GRAY candidates never alert,
 * but ARE persisted under a shadow-log throttle (`shadowIntervalMs`,
 * default 1h): threshold calibration needs the counterfactual, non-alerted
 * band population, and persisting only what alerts bakes selection bias
 * into any later analysis of the eligibility/score history. Per-pool
 * failures are collected; the pass never lets one bad token starve the
 * rest. A failed alert delivery is recorded, not fatal.
 */
export async function runScoringPass(
  options: ScoringPassOptions
): Promise<ScoringPassResult> {
  const { db, config, transport } = options;
  const now = options.now ?? (() => new Date());
  const shadowIntervalMs = options.shadowIntervalMs ?? DEFAULT_SHADOW_INTERVAL_MS;
  const pools =
    options.band === undefined
      ? await listTrustedQuotePools(db, config.chainId, options.poolLimit)
      : await listBandTrustedQuotePools(
          db,
          config.chainId,
          options.band,
          options.poolLimit
        );

  let poolsEvaluated = 0;
  let candidates = 0;
  let alertsEmitted = 0;
  let shadowLogged = 0;
  const byLevel: Record<AlertLevel, number> = {
    GRAY: 0,
    RED: 0,
    YELLOW: 0,
    GREEN: 0
  };
  const poolErrors: { poolAddress: string; message: string }[] = [];
  let stopped = false;
  for (const pool of pools) {
    if (options.signal?.aborted === true) {
      stopped = true;
      break;
    }
    try {
      const passNow = now();
      const features = await assembleCandidate(
        db,
        pool,
        passNow,
        options.signals,
        options.band
      );
      if (features === null) continue;
      poolsEvaluated += 1;

      const eligibility = evaluateEligibility(features, options.eligibilityConfig);
      const score = scoreOpportunity(features, eligibility);
      const level = classifyAlertLevel(
        features,
        eligibility,
        score,
        options.alertThresholds
      );
      byLevel[level] += 1;

      const persistEligibilityAndScore = (): Promise<void> =>
        db.transaction(async (tx) => {
          await insertEligibilityResult(tx, {
            chainId: pool.chainId,
            tokenAddress: features.tokenAddress,
            poolAddress: pool.poolAddress,
            blockNumber: features.blockNumber,
            eligible: eligibility.eligible,
            failedRules: eligibility.failedRules,
            reasons: eligibility.reasons,
            features: jsonSafeFeatures(features)
          });
          await insertScoreResult(tx, {
            chainId: pool.chainId,
            tokenAddress: features.tokenAddress,
            poolAddress: pool.poolAddress,
            blockNumber: features.blockNumber,
            eligible: eligibility.eligible,
            score: score.score,
            components: score.components as unknown as Record<string, unknown>,
            alertLevel: level,
            positiveReasons: score.positiveReasons,
            riskReasons: score.riskReasons
          });
        });

      if (level === "GRAY") {
        // Shadow-log: same rows a real candidate gets, throttled per token
        // so an unmoving GRAY classification doesn't flood the tables.
        // Never alerts, regardless of the throttle outcome (see doc above).
        // Liveness gate: a pool with zero buyers in the last hour carries no
        // calibration signal this hour — and the band accumulates dead pools
        // whose final FDV froze in-band forever (live 2026-07-12: 3,233 band
        // pools, only 146 with a buyer in the hour). It re-enters the shadow
        // log the hour it trades again.
        if (features.uniqueBuyers1h === 0) continue;
        const latestScoredAt = await getLatestScoreResultAt(
          db,
          pool.chainId,
          features.tokenAddress
        );
        const dueForShadowLog =
          latestScoredAt === undefined ||
          passNow.getTime() - latestScoredAt.getTime() >= shadowIntervalMs;
        if (dueForShadowLog) {
          await persistEligibilityAndScore();
          shadowLogged += 1;
        }
        continue;
      }
      candidates += 1;

      await persistEligibilityAndScore();

      // Token name/symbol for the message header: attacker-controlled
      // metadata, escaped by the formatter. Fetched only for the rare
      // non-GRAY candidates — never on the shadow path.
      const [tokenRow] = await getTokensByAddresses(db, pool.chainId, [
        features.tokenAddress
      ]);
      const poolChartUrl = chartUrl(options.chartUrlBase, pool.poolAddress);
      const ctx: AlertContext = {
        features,
        eligibility,
        score,
        level,
        tokenName: tokenRow?.name ?? null,
        tokenSymbol: tokenRow?.symbol ?? null,
        ...(poolChartUrl === undefined ? {} : { chartUrl: poolChartUrl })
      };
      const latestAlert = await getLatestAlert(
        db,
        pool.chainId,
        features.tokenAddress
      );
      const tokenName = tokenRow?.name ?? null;
      const latestNameSibling =
        options.duplicateNameCooldownMs > 0 && tokenName !== null
          ? await getLatestDeliveredAlertBySimilarName(
              db,
              pool.chainId,
              tokenName,
              features.tokenAddress,
              new Date(passNow.getTime() - options.duplicateNameCooldownMs)
            )
          : undefined;
      const decision = evaluateAlert(
        ctx,
        latestAlert,
        {
          cooldownMs: options.alertCooldownMs,
          minScore: options.alertMinScore,
          minScoreRed: options.alertMinScoreRed,
          reAlertMinScoreDelta: options.reAlertMinScoreDelta
        },
        passNow,
        latestNameSibling
      );
      if (!decision.emit) continue;

      let delivered = true;
      try {
        await transport.send(formatAlert(ctx));
      } catch {
        delivered = false;
      }
      await insertAlertSent(db, {
        chainId: pool.chainId,
        tokenAddress: features.tokenAddress,
        poolAddress: pool.poolAddress,
        alertLevel: level,
        score: score.score,
        reason: decision.reason,
        transport: options.transportName,
        delivered
      });
      if (delivered) alertsEmitted += 1;
    } catch (error) {
      poolErrors.push({
        poolAddress: pool.poolAddress,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    chainId: config.chainId,
    poolsEvaluated,
    candidates,
    alertsEmitted,
    red: byLevel.RED,
    yellow: byLevel.YELLOW,
    green: byLevel.GREEN,
    shadowLogged,
    poolErrors,
    stopped
  };
}
