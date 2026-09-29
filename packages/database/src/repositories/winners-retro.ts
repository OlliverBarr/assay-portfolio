import {
  and,
  count,
  desc,
  eq,
  gte,
  isNull,
  lte,
  notExists,
  sql
} from "drizzle-orm";
import type { Db } from "../client.js";
import {
  pools,
  tokenEligibilityResults,
  tokenPerformance,
  tokenScoreResults,
  winnerRetroItems
} from "../schema.js";
import { chunked, INSERT_CHUNK_SIZE } from "./shared.js";
import type { TokenPerformanceRow } from "./outcomes.js";

export type WinnerRetroItemInsert = typeof winnerRetroItems.$inferInsert;

export type WinnerRetroItemRow = typeof winnerRetroItems.$inferSelect;

/**
 * Band-crossing `token_performance` rows above the wick multiple bar that
 * have no `winner_retro_items` row yet for their (pool, horizon) pair —
 * i.e. winners not yet autopsied. Ordered `labeledAt` ascending so a
 * bounded pass works oldest-first and eventually drains the backlog.
 */
export async function listWinnerCandidatePerformance(
  db: Db,
  chainId: number,
  minMultipleBps: number,
  limit: number
): Promise<TokenPerformanceRow[]> {
  const alreadyRetroed = db
    .select({ one: sql`1` })
    .from(winnerRetroItems)
    .where(
      and(
        eq(winnerRetroItems.chainId, tokenPerformance.chainId),
        eq(winnerRetroItems.poolAddress, tokenPerformance.poolAddress),
        eq(winnerRetroItems.horizonHours, tokenPerformance.horizonHours)
      )
    );
  return db
    .select()
    .from(tokenPerformance)
    .where(
      and(
        eq(tokenPerformance.chainId, chainId),
        gte(tokenPerformance.maxMultipleBps, minMultipleBps),
        notExists(alreadyRetroed)
      )
    )
    .orderBy(tokenPerformance.labeledAt, tokenPerformance.id)
    .limit(limit);
}

/**
 * Append leak-attribution verdicts. Idempotent on the (chainId,
 * poolAddress, horizonHours) unique key — a restart replaying the same
 * pass never relabels or double-counts a winner. Returns only the rows
 * actually inserted (Postgres RETURNING reports nothing for a row skipped
 * by ON CONFLICT DO NOTHING), which is exactly the "new winners" set the
 * event-driven digest fires on.
 */
export async function insertWinnerRetroItems(
  db: Db,
  items: WinnerRetroItemInsert[]
): Promise<WinnerRetroItemRow[]> {
  if (items.length === 0) return [];
  const inserted: WinnerRetroItemRow[] = [];
  for (const batch of chunked(items, INSERT_CHUNK_SIZE)) {
    const rows = await db
      .insert(winnerRetroItems)
      .values(batch)
      .onConflictDoNothing({
        target: [
          winnerRetroItems.chainId,
          winnerRetroItems.poolAddress,
          winnerRetroItems.horizonHours
        ]
      })
      .returning();
    inserted.push(...rows);
  }
  return inserted;
}

/**
 * Recorded winner-retro items for a chain, newest first. `opts.since`
 * filters on `detectedAt` (when this process found the winner, not when it
 * entered the band); `opts.limit` bounds the CLI/digest deep-dive.
 */
export async function listWinnerRetroItems(
  db: Db,
  chainId: number,
  opts?: { since?: Date; limit?: number }
): Promise<WinnerRetroItemRow[]> {
  const conditions = [eq(winnerRetroItems.chainId, chainId)];
  if (opts?.since !== undefined) {
    conditions.push(gte(winnerRetroItems.detectedAt, opts.since));
  }
  const query = db
    .select()
    .from(winnerRetroItems)
    .where(and(...conditions))
    .orderBy(desc(winnerRetroItems.detectedAt), desc(winnerRetroItems.id));
  return opts?.limit === undefined ? query : query.limit(opts.limit);
}

/**
 * Tier-2 census: pools discovered (first observed on-chain) at or after
 * `since` whose quote side was never trusted (`quoteTokenAddress` null),
 * which makes them structurally invisible to the rest of the pipeline — no
 * FDV can ever be computed for them, so they can never reach
 * `token_performance` and are quantified here instead. `discoveredAt` is
 * the closest stored analog to "created": pools carry a creation block
 * number, not a block timestamp.
 */
export async function countUntrustedPoolsCreatedSince(
  db: Db,
  chainId: number,
  since: Date
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        isNull(pools.quoteTokenAddress),
        gte(pools.discoveredAt, since)
      )
    );
  return rows[0]?.value ?? 0;
}

/** The joined shadow eligibility+score pairing returned by `getShadowDecisionAsOf`. */
export interface ShadowDecision {
  readonly eligible: boolean;
  readonly failedRules: string[];
  readonly softFailedRules: string[];
  readonly score: number;
  readonly alertLevel: string;
  readonly features: unknown;
}

/**
 * The logged shadow decision nearest `at`, for winners-retro's
 * attribution-source preference (as-of shadow rows preferred over
 * pure-function replay). Pairing rule: take the `token_eligibility_results`
 * row nearest at-or-before `at` within `windowMs` (the throttled shadow-log
 * write closest to the winner's entry), then pair it with the
 * `token_score_results` row for the same token nearest that row's own
 * `evaluatedAt` by absolute time distance — `scoring-pass.ts` writes both
 * rows back-to-back inside one transaction, so `scoredAt` normally lands a
 * few milliseconds after `evaluatedAt`, but pairing by distance rather than
 * assumed ordering keeps the join correct even if that changes. Returns
 * undefined when either half of the pair is missing: no eligibility row in
 * window, or the token was never scored at all — the caller falls back to
 * pure-function replay in that case.
 *
 * `softFailedRules` is always `[]` here: `token_eligibility_results` does
 * not persist that column (only `failedRules`/`reasons`/`features` are
 * written), so the shadow path cannot recover it — only the replay
 * fallback (which re-runs `evaluateEligibility` over `features`) can.
 */
export async function getShadowDecisionAsOf(
  db: Db,
  chainId: number,
  tokenAddress: string,
  at: Date,
  windowMs: number
): Promise<ShadowDecision | undefined> {
  const windowStart = new Date(at.getTime() - windowMs);
  const eligibilityRows = await db
    .select()
    .from(tokenEligibilityResults)
    .where(
      and(
        eq(tokenEligibilityResults.chainId, chainId),
        eq(tokenEligibilityResults.tokenAddress, tokenAddress),
        lte(tokenEligibilityResults.evaluatedAt, at),
        gte(tokenEligibilityResults.evaluatedAt, windowStart)
      )
    )
    .orderBy(
      desc(tokenEligibilityResults.evaluatedAt),
      desc(tokenEligibilityResults.id)
    )
    .limit(1);
  const eligibility = eligibilityRows[0];
  if (eligibility === undefined) return undefined;

  // Nearest-by-distance join: raw sql fragment, so the pivot instant is
  // serialized explicitly rather than passed as a bare Date (postgres-js
  // rejects a bare Date param inside a raw fragment; see README caveat).
  const evaluatedAtIso = eligibility.evaluatedAt.toISOString();
  const scoreRows = await db
    .select()
    .from(tokenScoreResults)
    .where(
      and(
        eq(tokenScoreResults.chainId, chainId),
        eq(tokenScoreResults.tokenAddress, tokenAddress)
      )
    )
    .orderBy(
      sql`abs(extract(epoch from (${tokenScoreResults.scoredAt} - ${evaluatedAtIso}::timestamptz)))`,
      desc(tokenScoreResults.id)
    )
    .limit(1);
  const score = scoreRows[0];
  if (score === undefined) return undefined;

  return {
    eligible: eligibility.eligible,
    failedRules: eligibility.failedRules,
    softFailedRules: [],
    score: score.score,
    alertLevel: score.alertLevel,
    features: eligibility.features
  };
}
