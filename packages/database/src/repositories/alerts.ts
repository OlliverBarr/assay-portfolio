import {
  and,
  desc,
  eq,
  gte,
  lte,
  ne,
  sql
} from "drizzle-orm";
import type { Db } from "../client.js";
import {
  alertsSent,
  tokens
} from "../schema.js";

export type AlertSentInsert = typeof alertsSent.$inferInsert;

export type AlertSentRow = typeof alertsSent.$inferSelect;

/** Append a sent-alert record. */
export async function insertAlertSent(
  db: Db,
  row: AlertSentInsert
): Promise<AlertSentRow> {
  const [inserted] = await db.insert(alertsSent).values(row).returning();
  if (inserted === undefined) {
    throw new Error("insertAlertSent returned no row");
  }
  return inserted;
}

/** Most recent alert emitted for a token, or undefined. Drives dedup. */
export async function getLatestAlert(
  db: Db,
  chainId: number,
  tokenAddress: string
): Promise<AlertSentRow | undefined> {
  const rows = await db
    .select()
    .from(alertsSent)
    .where(
      and(
        eq(alertsSent.chainId, chainId),
        eq(alertsSent.tokenAddress, tokenAddress)
      )
    )
    .orderBy(desc(alertsSent.sentAt), desc(alertsSent.id))
    .limit(1);
  return rows[0];
}

/**
 * Most recent DELIVERED alert since `since` for a DIFFERENT token whose
 * normalized name (lowercased, stripped to `[a-z0-9]` — "Robin World",
 * "robinworld", and "ROBIN-WORLD " all collapse to "robinworld") matches
 * `name`, or undefined. Drives the duplicate-name
 * delivery cooldown: copycat launch waves (observed live 2026-07-12 — four
 * distinct "Robin World" contracts alerting within 11 seconds) each pass
 * the per-token dedup as their own first alert, so sibling suppression has
 * to look across token addresses by name. Only delivered rows count — a
 * sibling the operator never received must not suppress anything.
 * Undelivered rows are unaffected either way (suppressed candidates never
 * insert alert rows). An empty normalized name never matches.
 */
export async function getLatestDeliveredAlertBySimilarName(
  db: Db,
  chainId: number,
  name: string,
  excludeTokenAddress: string,
  since: Date
): Promise<AlertSentRow | undefined> {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (normalized === "") return undefined;
  const rows = await db
    .select({ alert: alertsSent })
    .from(alertsSent)
    .innerJoin(
      tokens,
      and(
        eq(tokens.chainId, alertsSent.chainId),
        eq(tokens.address, alertsSent.tokenAddress)
      )
    )
    .where(
      and(
        eq(alertsSent.chainId, chainId),
        eq(alertsSent.delivered, true),
        ne(alertsSent.tokenAddress, excludeTokenAddress),
        gte(alertsSent.sentAt, since),
        sql`regexp_replace(lower(${tokens.name}), '[^a-z0-9]+', '', 'g') = ${normalized}`
      )
    )
    .orderBy(desc(alertsSent.sentAt), desc(alertsSent.id))
    .limit(1);
  return rows[0]?.alert;
}

/** Every alert emitted for a chain, newest first. */
export async function listAlertsSent(
  db: Db,
  chainId: number
): Promise<AlertSentRow[]> {
  return db
    .select()
    .from(alertsSent)
    .where(eq(alertsSent.chainId, chainId))
    .orderBy(desc(alertsSent.sentAt), desc(alertsSent.id));
}

/** True when any alert was sent for the token at or before `by`. */
export async function hasAlertBefore(
  db: Db,
  chainId: number,
  tokenAddress: string,
  by: Date
): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(alertsSent)
    .where(
      and(
        eq(alertsSent.chainId, chainId),
        eq(alertsSent.tokenAddress, tokenAddress),
        lte(alertsSent.sentAt, by)
      )
    )
    .limit(1);
  return rows.length > 0;
}
