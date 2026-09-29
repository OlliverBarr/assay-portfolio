import {
  and,
  desc,
  eq,
  inArray,
  notExists,
  sql
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../client.js";
import {
  alertsSent,
  judgmentBriefs,
  judgmentCitations,
  judgmentEvalItems,
  judgmentEvalRuns,
  judgmentToolCalls,
  poolActivitySnapshots,
  poolSnapshots,
  promptRegistry,
  tokenHolderSnapshots,
  tokenOutcomes,
  tokenPerformance,
  tokenRisks,
  tradeSimulations
} from "../schema.js";
import { chunked, INSERT_CHUNK_SIZE } from "./shared.js";
import type { AlertSentRow } from "./alerts.js";

export type PromptRegistryRow = typeof promptRegistry.$inferSelect;
export type JudgmentBriefInsert = typeof judgmentBriefs.$inferInsert;
export type JudgmentBriefRow = typeof judgmentBriefs.$inferSelect;
export type JudgmentToolCallInsert = typeof judgmentToolCalls.$inferInsert;
export type JudgmentCitationInsert = typeof judgmentCitations.$inferInsert;
export type JudgmentEvalRunInsert = typeof judgmentEvalRuns.$inferInsert;
export type JudgmentEvalRunRow = typeof judgmentEvalRuns.$inferSelect;
export type JudgmentEvalItemInsert = typeof judgmentEvalItems.$inferInsert;

/** Whitelist for getCitedRow; keep in sync with judgment CITABLE_TABLES. */
export const JUDGMENT_CITABLE_TABLES = [
  "pool_snapshots",
  "pool_activity_snapshots",
  "token_holder_snapshots",
  "token_risks",
  "trade_simulations",
  "token_outcomes",
  "token_performance"
] as const;

/**
 * Ordinal tier rank for SQL-side comparisons (stoplight vocabulary; all
 * stored rows use it since migration 0014_stoplight_levels).
 */
function alertLevelRankSql(column: unknown): SQL {
  return sql`CASE ${column} WHEN 'GREEN' THEN 3 WHEN 'YELLOW' THEN 2 WHEN 'RED' THEN 1 ELSE 0 END`;
}

/**
 * LIVE alerts (level in `levels`) with no `judgment_briefs` row yet, oldest
 * first — the judgment worker's backlog. Excludes already-briefed alerts via
 * `notExists` so a restart never re-briefs (the alert-id unique index makes
 * a race here harmless anyway, but this keeps the query itself idempotent).
 *
 * `rebriefCooldownMs > 0` additionally suppresses REPEAT briefs per token:
 * an alert is skipped when the same (chain, token) already has a COMPLETED
 * LIVE brief created within the cooldown before this alert fired, UNLESS
 * this alert's level outranks the previously-briefed alert's level (an
 * escalation earns a fresh brief). FAILED / REJECTED briefs never suppress —
 * the operator never received those. 0 disables the per-token gate (every
 * alert briefs, the pre-0014-era behavior that produced repeat briefs for
 * tokens re-alerting on score improvements).
 */
export async function listAlertsNeedingBrief(
  db: Db,
  chainId: number,
  levels: readonly string[],
  limit: number,
  rebriefCooldownMs = 0
): Promise<AlertSentRow[]> {
  const alreadyBriefed = db
    .select({ one: sql`1` })
    .from(judgmentBriefs)
    .where(eq(judgmentBriefs.alertId, alertsSent.id));

  const conditions = [
    eq(alertsSent.chainId, chainId),
    inArray(alertsSent.alertLevel, [...levels]),
    notExists(alreadyBriefed)
  ];

  if (rebriefCooldownMs > 0) {
    const priorAlert = alias(alertsSent, "prior_briefed_alert");
    const cooldownSeconds = Math.floor(rebriefCooldownMs / 1000);
    const recentSameTokenBrief = db
      .select({ one: sql`1` })
      .from(judgmentBriefs)
      .innerJoin(priorAlert, eq(priorAlert.id, judgmentBriefs.alertId))
      .where(
        and(
          eq(judgmentBriefs.chainId, alertsSent.chainId),
          eq(judgmentBriefs.tokenAddress, alertsSent.tokenAddress),
          eq(judgmentBriefs.mode, "LIVE"),
          eq(judgmentBriefs.status, "COMPLETED"),
          sql`${judgmentBriefs.createdAt} > ${alertsSent.sentAt} - make_interval(secs => ${cooldownSeconds})`,
          sql`${alertLevelRankSql(priorAlert.alertLevel)} >= ${alertLevelRankSql(alertsSent.alertLevel)}`
        )
      );
    conditions.push(notExists(recentSameTokenBrief));
  }

  return db
    .select()
    .from(alertsSent)
    .where(and(...conditions))
    .orderBy(alertsSent.sentAt, alertsSent.id)
    .limit(limit);
}

/**
 * Insert a final brief. Idempotent on `alertId` via the unique index: a
 * concurrent or retried generation for the same alert silently loses,
 * returning undefined. REPLAY rows carry `alertId: null`, and Postgres
 * unique indexes never collide on NULL, so every REPLAY brief always
 * inserts regardless of how many share the same eval run.
 */
export async function insertJudgmentBrief(
  db: Db,
  row: JudgmentBriefInsert
): Promise<JudgmentBriefRow | undefined> {
  const [inserted] = await db
    .insert(judgmentBriefs)
    .values(row)
    .onConflictDoNothing({ target: judgmentBriefs.alertId })
    .returning();
  return inserted;
}

/** Records the follow-up delivery outcome ("SENT" | "SEND_FAILED" | "SKIPPED") on an already-inserted brief. */
export async function updateJudgmentBriefDelivery(
  db: Db,
  id: bigint,
  delivery: string
): Promise<void> {
  await db
    .update(judgmentBriefs)
    .set({ delivery })
    .where(eq(judgmentBriefs.id, id));
}

/** Persist the audited tool-call trace for a brief. Idempotent on (briefId, seq). */
export async function insertJudgmentToolCalls(
  db: Db,
  rows: readonly JudgmentToolCallInsert[]
): Promise<void> {
  for (const batch of chunked(rows, INSERT_CHUNK_SIZE)) {
    await db
      .insert(judgmentToolCalls)
      .values(batch)
      .onConflictDoNothing({
        target: [judgmentToolCalls.briefId, judgmentToolCalls.seq]
      });
  }
}

/**
 * Persist per-claim citation verification results. Not deduplicated: a
 * single claim can legitimately cite the same (table, rowId) more than once
 * under different claim keys, and the fabrication audit trail must keep
 * every check, verified or not.
 */
export async function insertJudgmentCitations(
  db: Db,
  rows: readonly JudgmentCitationInsert[]
): Promise<void> {
  for (const batch of chunked(rows, INSERT_CHUNK_SIZE)) {
    await db.insert(judgmentCitations).values(batch);
  }
}

/** The brief for one alert, or undefined when none has been generated. */
export async function getJudgmentBriefByAlert(
  db: Db,
  alertId: bigint
): Promise<JudgmentBriefRow | undefined> {
  const rows = await db
    .select()
    .from(judgmentBriefs)
    .where(eq(judgmentBriefs.alertId, alertId))
    .limit(1);
  return rows[0];
}

/** Briefs for a chain, newest first, with optional equality filters. */
export async function listJudgmentBriefs(
  db: Db,
  chainId: number,
  filter?: {
    mode?: string;
    status?: string;
    promptName?: string;
    promptVersion?: number;
    evalRunId?: bigint;
  }
): Promise<JudgmentBriefRow[]> {
  const conditions = [eq(judgmentBriefs.chainId, chainId)];
  if (filter?.mode !== undefined) {
    conditions.push(eq(judgmentBriefs.mode, filter.mode));
  }
  if (filter?.status !== undefined) {
    conditions.push(eq(judgmentBriefs.status, filter.status));
  }
  if (filter?.promptName !== undefined) {
    conditions.push(eq(judgmentBriefs.promptName, filter.promptName));
  }
  if (filter?.promptVersion !== undefined) {
    conditions.push(eq(judgmentBriefs.promptVersion, filter.promptVersion));
  }
  if (filter?.evalRunId !== undefined) {
    conditions.push(eq(judgmentBriefs.evalRunId, filter.evalRunId));
  }
  return db
    .select()
    .from(judgmentBriefs)
    .where(and(...conditions))
    .orderBy(desc(judgmentBriefs.createdAt), desc(judgmentBriefs.id));
}

/** A brief's tool-call trace in execution order. */
export async function listJudgmentToolCalls(
  db: Db,
  briefId: bigint
): Promise<(typeof judgmentToolCalls.$inferSelect)[]> {
  return db
    .select()
    .from(judgmentToolCalls)
    .where(eq(judgmentToolCalls.briefId, briefId))
    .orderBy(judgmentToolCalls.seq);
}

/** A brief's citation checks in insertion order. */
export async function listJudgmentCitations(
  db: Db,
  briefId: bigint
): Promise<(typeof judgmentCitations.$inferSelect)[]> {
  return db
    .select()
    .from(judgmentCitations)
    .where(eq(judgmentCitations.briefId, briefId))
    .orderBy(judgmentCitations.id);
}

/** Highest-version prompt row for `name`, or undefined if never registered. */
export async function getLatestPrompt(
  db: Db,
  name: string
): Promise<PromptRegistryRow | undefined> {
  const rows = await db
    .select()
    .from(promptRegistry)
    .where(eq(promptRegistry.name, name))
    .orderBy(desc(promptRegistry.version))
    .limit(1);
  return rows[0];
}

/** One exact (name, version) prompt row. */
export async function getPrompt(
  db: Db,
  name: string,
  version: number
): Promise<PromptRegistryRow | undefined> {
  const rows = await db
    .select()
    .from(promptRegistry)
    .where(
      and(eq(promptRegistry.name, name), eq(promptRegistry.version, version))
    )
    .limit(1);
  return rows[0];
}

/**
 * Reuse the latest row when its `templateHash` already matches (a code
 * redeploy of an unchanged template must never mint a new version and
 * fragment eval history); otherwise insert `latest.version + 1`. Races
 * against a concurrent writer are resolved by the (name, version) unique
 * index: `onConflictDoNothing` makes the losing insert a no-op instead of
 * throwing, so the loser just re-reads the winner's row and retries the
 * hash check once more rather than parsing a driver-specific error code.
 */
export async function getOrCreatePrompt(
  db: Db,
  args: {
    name: string;
    template: string;
    templateHash: string;
    changelog: string;
  }
): Promise<PromptRegistryRow> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await getLatestPrompt(db, args.name);
    if (latest !== undefined && latest.templateHash === args.templateHash) {
      return latest;
    }
    const nextVersion = latest === undefined ? 1 : latest.version + 1;
    const [inserted] = await db
      .insert(promptRegistry)
      .values({
        name: args.name,
        version: nextVersion,
        templateHash: args.templateHash,
        template: args.template,
        changelog: args.changelog
      })
      .onConflictDoNothing({
        target: [promptRegistry.name, promptRegistry.version]
      })
      .returning();
    if (inserted !== undefined) return inserted;
    // Lost the race for `nextVersion` to a concurrent writer; loop once more
    // to re-read the winner and either reuse it (hash match) or take the
    // next free version.
  }
  throw new Error(
    `getOrCreatePrompt: could not create prompt "${args.name}" after retry (concurrent writer contention)`
  );
}

/**
 * Typed select-by-id dispatch over `JUDGMENT_CITABLE_TABLES`. Never throws
 * on a bad table name — an LLM-supplied citation is adversarial input, and
 * "no such row" is exactly how a fabricated citation should fail.
 */
export async function getCitedRow(
  db: Db,
  table: string,
  rowId: bigint
): Promise<Record<string, unknown> | undefined> {
  switch (table) {
    case "pool_snapshots": {
      const rows = await db
        .select()
        .from(poolSnapshots)
        .where(eq(poolSnapshots.id, rowId))
        .limit(1);
      return rows[0];
    }
    case "pool_activity_snapshots": {
      const rows = await db
        .select()
        .from(poolActivitySnapshots)
        .where(eq(poolActivitySnapshots.id, rowId))
        .limit(1);
      return rows[0];
    }
    case "token_holder_snapshots": {
      const rows = await db
        .select()
        .from(tokenHolderSnapshots)
        .where(eq(tokenHolderSnapshots.id, rowId))
        .limit(1);
      return rows[0];
    }
    case "token_risks": {
      const rows = await db
        .select()
        .from(tokenRisks)
        .where(eq(tokenRisks.id, rowId))
        .limit(1);
      return rows[0];
    }
    case "trade_simulations": {
      const rows = await db
        .select()
        .from(tradeSimulations)
        .where(eq(tradeSimulations.id, rowId))
        .limit(1);
      return rows[0];
    }
    case "token_outcomes": {
      const rows = await db
        .select()
        .from(tokenOutcomes)
        .where(eq(tokenOutcomes.id, rowId))
        .limit(1);
      return rows[0];
    }
    case "token_performance": {
      const rows = await db
        .select()
        .from(tokenPerformance)
        .where(eq(tokenPerformance.id, rowId))
        .limit(1);
      return rows[0];
    }
    default:
      return undefined;
  }
}

/** Freeze one eval run's scored report. */
export async function insertJudgmentEvalRun(
  db: Db,
  row: JudgmentEvalRunInsert
): Promise<JudgmentEvalRunRow> {
  const [inserted] = await db.insert(judgmentEvalRuns).values(row).returning();
  if (inserted === undefined) {
    throw new Error("insertJudgmentEvalRun returned no row");
  }
  return inserted;
}

/** Per-brief scoring detail for an eval run. Idempotent on (runId, briefId). */
export async function insertJudgmentEvalItems(
  db: Db,
  rows: readonly JudgmentEvalItemInsert[]
): Promise<void> {
  for (const batch of chunked(rows, INSERT_CHUNK_SIZE)) {
    await db
      .insert(judgmentEvalItems)
      .values(batch)
      .onConflictDoNothing({
        target: [judgmentEvalItems.runId, judgmentEvalItems.briefId]
      });
  }
}

/** Eval runs for a chain, newest first. */
export async function listJudgmentEvalRuns(
  db: Db,
  chainId: number
): Promise<JudgmentEvalRunRow[]> {
  return db
    .select()
    .from(judgmentEvalRuns)
    .where(eq(judgmentEvalRuns.chainId, chainId))
    .orderBy(desc(judgmentEvalRuns.createdAt), desc(judgmentEvalRuns.id));
}
