import {
  and,
  asc,
  desc,
  eq,
  gte,
} from "drizzle-orm";
import type { Db } from "../client.js";
import {
  tokenEligibilityResults,
  tokenScoreResults
} from "../schema.js";

export type TokenEligibilityResultInsert =
  typeof tokenEligibilityResults.$inferInsert;

export type TokenEligibilityResultRow =
  typeof tokenEligibilityResults.$inferSelect;

export type TokenScoreResultInsert = typeof tokenScoreResults.$inferInsert;

export type TokenScoreResultRow = typeof tokenScoreResults.$inferSelect;

/**
 * Shadow-log throttle: `scored_at` of the newest score row for a token, or
 * undefined when the token has never been scored.
 */
export async function getLatestScoreResultAt(
  db: Db,
  chainId: number,
  tokenAddress: string
): Promise<Date | undefined> {
  const rows = await db
    .select({ scoredAt: tokenScoreResults.scoredAt })
    .from(tokenScoreResults)
    .where(
      and(
        eq(tokenScoreResults.chainId, chainId),
        eq(tokenScoreResults.tokenAddress, tokenAddress)
      )
    )
    .orderBy(desc(tokenScoreResults.scoredAt))
    .limit(1);
  return rows[0]?.scoredAt;
}

/**
 * Every `token_score_results` row for a chain at/after `since`, ascending by
 * `scoredAt`. Every scoring pass writes one row here regardless of eligibility
 * or alert level, so this is the correct population for delivery-volume
 * questions; the labeled `token_performance` set is a curated winner-study
 * subset and structurally under-predicts live volume.
 */
export async function listTokenScoreResultsSince(
  db: Db,
  chainId: number,
  since: Date
): Promise<TokenScoreResultRow[]> {
  return db
    .select()
    .from(tokenScoreResults)
    .where(
      and(
        eq(tokenScoreResults.chainId, chainId),
        gte(tokenScoreResults.scoredAt, since)
      )
    )
    .orderBy(asc(tokenScoreResults.scoredAt));
}

/** Append an eligibility decision. Never updated — history is the product. */
export async function insertEligibilityResult(
  db: Db,
  row: TokenEligibilityResultInsert
): Promise<TokenEligibilityResultRow> {
  const [inserted] = await db
    .insert(tokenEligibilityResults)
    .values(row)
    .returning();
  if (inserted === undefined) {
    throw new Error("insertEligibilityResult returned no row");
  }
  return inserted;
}

/** Append an opportunity score. */
export async function insertScoreResult(
  db: Db,
  row: TokenScoreResultInsert
): Promise<TokenScoreResultRow> {
  const [inserted] = await db
    .insert(tokenScoreResults)
    .values(row)
    .returning();
  if (inserted === undefined) {
    throw new Error("insertScoreResult returned no row");
  }
  return inserted;
}
