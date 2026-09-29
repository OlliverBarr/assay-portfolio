/**
 * Winners-retro pass: enumerate realized big winners among band-crossers
 * (from the alert-independent `token_performance` labeler), refine each with
 * the sustained/liquidity-adjusted definition, attribute the FIRST pipeline
 * stage that failed to surface it, persist append-once, and send an
 * event-driven digest when NEW qualifying winners appear.
 *
 * Every evaluated candidate is persisted — including non-qualifying ones
 * (wick without sustain, thin exit liquidity). The append-once unique key is
 * what closes a (pool, horizon) after its first evaluation; recording only
 * qualifiers would make the candidate anti-join re-fetch and re-compute the
 * same near-misses every pass forever. The digest and CLI surface only rows
 * that clear both bars.
 *
 * Hypothesis generator, never an optimizer: the digest drives the weekly
 * ritual in docs/execution-methodology.md, and threshold changes go through
 * the docs/scoring-model.md change protocol with out-of-time validation.
 */
import {
  countUntrustedPoolsCreatedSince,
  getPool,
  getShadowDecisionAsOf,
  getTokensByAddresses,
  hasAlertBefore,
  insertWinnerRetroItems,
  listPoolSnapshots,
  listWinnerCandidatePerformance,
  listWinnerRetroItems,
  type Db,
  type TokenPerformanceRow,
  type WinnerRetroItemInsert,
  type WinnerRetroItemRow
} from "@assay/database";
import {
  classifyAlertLevel,
  evaluateEligibility,
  scoreOpportunity,
  type AlertThresholds,
  type EligibilityConfig
} from "@assay/scoring";
import type { AlertTransport } from "@assay/alerts";

import {
  attributeCoverageTier,
  computeSustained,
  formatWinnersDigest,
  parseEntryFeatures,
  replayCandidateFeatures,
  type DigestItem,
  type GateAttribution,
  type SnapshotPoint
} from "./winners-retro.js";

/** Shadow rows further than this from band entry don't describe the entry decision. */
const SHADOW_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Candidates evaluated per pass; the anti-join drains the backlog across passes. */
const DEFAULT_CANDIDATE_LIMIT = 200;
/** Tier-2 census lookback for the digest line. */
const CENSUS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface WinnersRetroPassOptions {
  readonly db: Db;
  readonly chainId: number;
  /** Digest sink — the ops-chat Telegram transport (or dry-run). */
  readonly transport: AlertTransport;
  /** Wick-multiple floor (bps) pre-filtering candidates in SQL. */
  readonly minMultipleBps: number;
  /** Sustained winners below this exit quote liquidity don't qualify. */
  readonly minExitLiquidityUsd: number;
  /** Delivery floor used for tier-6 (below-floor) attribution. */
  readonly alertMinScore: number;
  /** Extra RED-only delivery floor; effective is max with alertMinScore. */
  readonly alertMinScoreRed: number;
  /** Eligibility rule thresholds — must mirror the live scoring pass. */
  readonly eligibilityConfig: EligibilityConfig;
  /** Alert tier bands/gates — must mirror the live scoring pass. */
  readonly alertThresholds: AlertThresholds;
  readonly candidateLimit?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface WinnersRetroPassResult {
  readonly chainId: number;
  readonly candidates: number;
  readonly evaluated: number;
  /** Newly persisted rows that clear BOTH qualifying bars. */
  readonly newWinners: number;
  readonly digestSent: boolean;
  readonly poolErrors: { poolAddress: string; message: string }[];
  readonly stopped: boolean;
}

/** Both qualifying bars: sustained multiple and executable exit liquidity. */
function qualifies(
  row: Pick<WinnerRetroItemRow, "sustainedMultipleBps" | "exitQuoteLiquidityUsd">,
  minMultipleBps: number,
  minExitLiquidityUsd: number
): boolean {
  if (row.sustainedMultipleBps < minMultipleBps) return false;
  if (row.exitQuoteLiquidityUsd === null) return false;
  const exitLiquidity = Number(row.exitQuoteLiquidityUsd);
  return Number.isFinite(exitLiquidity) && exitLiquidity >= minExitLiquidityUsd;
}

/**
 * Effective delivery floor for a level: RED-level alerts carry an
 * additional floor (max with the global one) — mirror of the live gate in
 * `@assay/alerts` `evaluateAlert`, so T6 attribution replays what delivery
 * would actually have done.
 */
function effectiveFloor(
  alertLevel: string | null,
  floors: { alertMinScore: number; alertMinScoreRed: number }
): number {
  return alertLevel === "RED"
    ? Math.max(floors.alertMinScore, floors.alertMinScoreRed)
    : floors.alertMinScore;
}

/**
 * Gate attribution for one candidate: prefer the as-of shadow decision (what
 * the pipeline actually computed near entry); fall back to a pure replay of
 * the eligibility/score functions over the stored entry feature vector; when
 * neither exists the signals themselves were missing (tier 4).
 */
async function attributeGate(
  db: Db,
  candidate: TokenPerformanceRow,
  floors: { alertMinScore: number; alertMinScoreRed: number },
  eligibilityConfig: EligibilityConfig,
  alertThresholds: AlertThresholds
): Promise<GateAttribution> {
  // `getShadowDecisionAsOf` looks at/before its anchor; shadow rows are
  // written by the scoring cadence shortly AFTER band entry, so anchor at
  // entry+window and search back 2x — i.e. [entry - w, entry + w].
  const shadow = await getShadowDecisionAsOf(
    db,
    candidate.chainId,
    candidate.tokenAddress,
    new Date(candidate.enteredAt.getTime() + SHADOW_WINDOW_MS),
    SHADOW_WINDOW_MS * 2
  );
  if (shadow !== undefined) {
    return {
      source: "shadow",
      eligible: shadow.eligible,
      failedRules: shadow.failedRules,
      softFailedRules: shadow.softFailedRules,
      score: shadow.score,
      alertLevel: shadow.alertLevel,
      floor: effectiveFloor(shadow.alertLevel, floors)
    };
  }

  const entry = parseEntryFeatures(candidate.entryFeatures);
  if (entry === null) {
    return {
      source: "none",
      eligible: null,
      failedRules: [],
      softFailedRules: [],
      score: null,
      alertLevel: null,
      floor: floors.alertMinScore
    };
  }
  const features = replayCandidateFeatures(candidate, entry);
  const eligibility = evaluateEligibility(features, eligibilityConfig);
  const score = scoreOpportunity(features, eligibility);
  const level = classifyAlertLevel(features, eligibility, score, alertThresholds);
  return {
    source: "replay",
    eligible: eligibility.eligible,
    failedRules: eligibility.failedRules,
    softFailedRules: eligibility.softFailedRules,
    score: score.score,
    alertLevel: level,
    floor: effectiveFloor(level, floors)
  };
}

/** Human detail for the digest line, from the attribution the tier keyed on. */
function attributionDetail(tier: number, attribution: GateAttribution): string {
  if (tier === 5) return `hard gate: ${attribution.failedRules.join(", ")}`;
  if (tier === 6) {
    const score = attribution.score ?? 0;
    return attribution.alertLevel === "GRAY"
      ? `classified GRAY (score ${score})`
      : `score ${score} < floor ${attribution.floor}`;
  }
  if (tier === 4) return "no decision near entry and entry features unusable";
  if (tier === 3) return "no snapshots before the sustained peak";
  return "";
}

export async function runWinnersRetroPass(
  options: WinnersRetroPassOptions
): Promise<WinnersRetroPassResult> {
  const { db, chainId } = options;
  const now = options.now ?? (() => new Date());
  const candidates = await listWinnerCandidatePerformance(
    db,
    chainId,
    options.minMultipleBps,
    options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT
  );

  const items: WinnerRetroItemInsert[] = [];
  // Attributions computed THIS pass, keyed (pool, horizon) — the digest reads
  // these instead of blind-casting the persisted jsonb back into a shape.
  const attributionByKey = new Map<string, GateAttribution>();
  const poolErrors: { poolAddress: string; message: string }[] = [];
  let stopped = false;

  for (const candidate of candidates) {
    if (options.signal?.aborted === true) {
      stopped = true;
      break;
    }
    try {
      const pool = await getPool(db, chainId, candidate.poolAddress);
      const snapshots = await listPoolSnapshots(db, chainId, candidate.poolAddress);
      const windowEndMs =
        candidate.enteredAt.getTime() + candidate.horizonHours * 60 * 60 * 1000;
      const points: SnapshotPoint[] = snapshots
        .filter(
          (row) =>
            row.capturedAt.getTime() >= candidate.enteredAt.getTime() &&
            row.capturedAt.getTime() <= windowEndMs
        )
        .map((row) => ({
          capturedAt: row.capturedAt,
          estimatedFdvUsd: row.estimatedFdvUsd,
          quoteLiquidityUsd: row.quoteLiquidityUsd
        }));

      const sustained = computeSustained(
        points,
        candidate.enteredAt,
        candidate.entryFdvUsd,
        candidate.maxMultipleBps
      );
      const attribution = await attributeGate(
        db,
        candidate,
        {
          alertMinScore: options.alertMinScore,
          alertMinScoreRed: options.alertMinScoreRed
        },
        options.eligibilityConfig,
        options.alertThresholds
      );
      const alerted = await hasAlertBefore(
        db,
        chainId,
        candidate.tokenAddress,
        new Date(windowEndMs)
      );
      const tier = attributeCoverageTier({
        trustedQuote: pool?.quoteTokenAddress != null,
        hadSnapshots: points.length > 0,
        attribution,
        alerted
      });

      items.push({
        chainId,
        tokenAddress: candidate.tokenAddress,
        poolAddress: candidate.poolAddress,
        horizonHours: candidate.horizonHours,
        entryAt: candidate.enteredAt,
        entryFdvUsd: candidate.entryFdvUsd,
        wickMultipleBps: candidate.maxMultipleBps,
        sustainedMultipleBps: sustained.sustainedMultipleBps,
        exitQuoteLiquidityUsd: sustained.exitQuoteLiquidityUsd,
        minutesToSustainedPeak: sustained.minutesToSustainedPeak,
        // 24h labels are interim by definition; 72h/168h are matured.
        provisional: candidate.horizonHours < 72,
        coverageTier: tier.tier,
        tierLabel: tier.label,
        alerted,
        gateAttribution: attribution
      });
      attributionByKey.set(
        `${candidate.poolAddress}:${candidate.horizonHours}`,
        attribution
      );
    } catch (error) {
      poolErrors.push({
        poolAddress: candidate.poolAddress,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const inserted = await insertWinnerRetroItems(db, items);
  const newWinners = inserted.filter((row) =>
    qualifies(row, options.minMultipleBps, options.minExitLiquidityUsd)
  );

  let digestSent = false;
  if (newWinners.length > 0) {
    const tokens = await getTokensByAddresses(
      db,
      chainId,
      newWinners.map((row) => row.tokenAddress)
    );
    const symbolByAddress = new Map(
      tokens.map((token) => [token.address, token.symbol] as const)
    );

    const digestItems: DigestItem[] = newWinners.map((row) => {
      // Present by construction: every inserted row was built this pass.
      const attribution = attributionByKey.get(
        `${row.poolAddress}:${row.horizonHours}`
      );
      return {
        tokenAddress: row.tokenAddress,
        tokenSymbol: symbolByAddress.get(row.tokenAddress) ?? null,
        sustainedMultipleBps: row.sustainedMultipleBps,
        exitQuoteLiquidityUsd: row.exitQuoteLiquidityUsd,
        tier: row.coverageTier,
        tierLabel: row.tierLabel,
        detail:
          attribution === undefined
            ? ""
            : attributionDetail(row.coverageTier, attribution),
        provisional: row.provisional
      };
    });

    // Running totals over QUALIFYING items only — the denominator the
    // operator sees must match the winner definition, not the evaluation set.
    const allItems = await listWinnerRetroItems(db, chainId);
    const tierTotals = new Map<number, number>();
    for (const row of allItems) {
      if (!qualifies(row, options.minMultipleBps, options.minExitLiquidityUsd)) continue;
      tierTotals.set(row.coverageTier, (tierTotals.get(row.coverageTier) ?? 0) + 1);
    }
    const untrustedPoolCount = await countUntrustedPoolsCreatedSince(
      db,
      chainId,
      new Date(now().getTime() - CENSUS_LOOKBACK_MS)
    );

    // Digest failure must not fail the pass: items are already persisted
    // (append-once), so a Telegram outage costs one digest, never data.
    try {
      await options.transport.send(
        formatWinnersDigest({
          date: now(),
          items: digestItems,
          untrustedPoolCount,
          tierTotals
        })
      );
      digestSent = true;
    } catch {
      digestSent = false;
    }
  }

  return {
    chainId,
    candidates: candidates.length,
    evaluated: items.length,
    newWinners: newWinners.length,
    digestSent,
    poolErrors,
    stopped
  };
}
