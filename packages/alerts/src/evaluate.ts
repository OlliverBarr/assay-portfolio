import type { AlertLevel } from "@assay/scoring";
import type { AlertSentRow } from "@assay/database";

import type { AlertContext } from "./types.js";

/** Emission gating: cooldown dedup, a minimum-score floor, and a material-improvement bar for re-alerts. */
export interface AlertGateConfig {
  /** Minimum gap before re-emitting at the same or a lower level, in ms. */
  readonly cooldownMs: number;
  /** Alerts scoring below this are tracked but never delivered. 0 disables. */
  readonly minScore: number;
  /**
   * A same/lower-level re-alert must ALSO score at least this many points
   * above the last alert — "materially new evidence" per the scoring model,
   * not the mere passage of a cooldown. 0 restores cooldown-only re-alerts.
   */
  readonly reAlertMinScoreDelta: number;
  /**
   * Additional delivery floor applied ONLY to RED-level (early watch)
   * alerts; the effective RED floor is `max(minScore, minScoreRed)`.
   * RED is non-actionable by definition, and most delivered REDs
   * re-alerted as YELLOW within the hour (live 2026-07-12: 13 of ~58
   * alerted tokens paged twice) — so only exceptional early-watch
   * candidates should page. 0 or omitted falls back to `minScore`.
   */
  readonly minScoreRed?: number;
}

/** Verdict from {@link evaluateAlert}: whether to emit, and why. */
export interface AlertDecision {
  readonly emit: boolean;
  /** Machine-stable, human-readable explanation of the emit/suppress call. */
  readonly reason: string;
}

/**
 * Ordinal severity of each level; higher fires over lower. Stoplight order:
 * RED (early watch) < YELLOW (research) < GREEN (go). Historical rows use
 * the same vocabulary since migration 0014_stoplight_levels.
 */
const LEVEL_RANK: Record<AlertLevel, number> = {
  GRAY: 0,
  RED: 1,
  YELLOW: 2,
  GREEN: 3
};

/**
 * Decide whether an alert should be emitted, given the most recent alert
 * persisted for the same token (or `undefined` when none exists) and,
 * optionally, the most recent DELIVERED alert for a same-named sibling
 * token (a different address whose normalized name matches — the caller
 * scopes the lookup to its cooldown window). Pure and deterministic — the
 * caller supplies `now`. Does not touch the database.
 *
 * Rules, in order:
 *  - GRAY never emits.
 *  - Score below `minScore` never emits (still scored and persisted
 *    upstream); RED-level alerts use `max(minScore, minScoreRed)`.
 *  - A same-named sibling delivered within the caller's window suppresses
 *    anything at or below the sibling's level (live 2026-07-12: four
 *    distinct "Robin World" contracts alerted within 11 seconds — copycat
 *    launch waves pass per-token dedup as independent first alerts). An
 *    alert OUTRANKING the sibling still delivers: the strongest launch of
 *    a wave must not be hidden by its weaker predecessors.
 *  - No prior alert → emit (first alert).
 *  - Level increased vs. the last alert → emit immediately (escalation).
 *  - Same or lower level → emit only once the cooldown has elapsed AND the
 *    score improved by at least `reAlertMinScoreDelta` since the last alert
 *    (live 2026-07-12: cooldown-only re-fires re-sent an unchanged
 *    research-tier 68 every 30 minutes for a token camping in the band).
 */
export function evaluateAlert(
  ctx: AlertContext,
  latestAlert: AlertSentRow | undefined,
  cfg: AlertGateConfig,
  now: Date,
  latestNameSibling?: AlertSentRow
): AlertDecision {
  if (ctx.level === "GRAY") {
    return { emit: false, reason: "level-gray-never-emits" };
  }

  const minScore =
    ctx.level === "RED"
      ? Math.max(cfg.minScore, cfg.minScoreRed ?? 0)
      : cfg.minScore;
  if (ctx.score.score < minScore) {
    return {
      emit: false,
      reason: `below-min-score:${ctx.score.score}<${minScore}`
    };
  }

  if (latestNameSibling !== undefined) {
    const siblingRank = LEVEL_RANK[latestNameSibling.alertLevel as AlertLevel] ?? 0;
    if (LEVEL_RANK[ctx.level] <= siblingRank) {
      return {
        emit: false,
        reason: `duplicate-name:${latestNameSibling.alertLevel}@${latestNameSibling.tokenAddress}`
      };
    }
  }

  if (latestAlert === undefined) {
    return { emit: true, reason: "first-alert" };
  }

  const currentRank = LEVEL_RANK[ctx.level];
  const lastRank = LEVEL_RANK[latestAlert.alertLevel as AlertLevel] ?? 0;

  if (currentRank > lastRank) {
    return {
      emit: true,
      reason: `level-increase:${latestAlert.alertLevel}->${ctx.level}`
    };
  }

  const elapsedMs = now.getTime() - latestAlert.sentAt.getTime();
  if (elapsedMs < cfg.cooldownMs) {
    return { emit: false, reason: "within-cooldown" };
  }

  const scoreDelta = ctx.score.score - latestAlert.score;
  if (scoreDelta < cfg.reAlertMinScoreDelta) {
    return {
      emit: false,
      reason: `no-material-improvement:${ctx.score.score}<${latestAlert.score}+${cfg.reAlertMinScoreDelta}`
    };
  }

  const kind = currentRank === lastRank ? "same-level" : "de-escalation";
  return { emit: true, reason: `cooldown-elapsed:${kind}:score+${scoreDelta}` };
}
