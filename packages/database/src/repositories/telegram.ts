import {
  eq,
  sql
} from "drizzle-orm";
import type { Db } from "../client.js";
import {
  telegramCursor,
  telegramSubscriptions
} from "../schema.js";

export type TelegramSubscriptionRow = typeof telegramSubscriptions.$inferSelect;

/**
 * Upsert a Telegram chat's subscription status by `chatId`. Bumps
 * `updatedAt`; `addedAt` is set only on first insert and preserved across
 * every later status change (rejoin, kick, etc.).
 */
export async function upsertTelegramSubscription(
  db: Db,
  row: {
    chatId: string;
    title: string | null;
    status: "ACTIVE" | "PENDING" | "REMOVED";
  }
): Promise<void> {
  await db
    .insert(telegramSubscriptions)
    .values(row)
    .onConflictDoUpdate({
      target: telegramSubscriptions.chatId,
      set: {
        title: sql`excluded.title`,
        status: sql`excluded.status`,
        updatedAt: sql`now()`
      }
    });
}

/** One Telegram subscription by chat id. */
export async function getTelegramSubscription(
  db: Db,
  chatId: string
): Promise<TelegramSubscriptionRow | undefined> {
  const rows = await db
    .select()
    .from(telegramSubscriptions)
    .where(eq(telegramSubscriptions.chatId, chatId))
    .limit(1);
  return rows[0];
}

/** Every ACTIVE Telegram subscription, ordered by chat id. Fan-out target. */
export async function listActiveTelegramSubscriptions(
  db: Db
): Promise<TelegramSubscriptionRow[]> {
  return db
    .select()
    .from(telegramSubscriptions)
    .where(eq(telegramSubscriptions.status, "ACTIVE"))
    .orderBy(telegramSubscriptions.chatId);
}

/** The persisted `getUpdates` cursor; undefined before the first poll. */
export async function getTelegramCursor(db: Db): Promise<bigint | undefined> {
  const rows = await db
    .select({ lastUpdateId: telegramCursor.lastUpdateId })
    .from(telegramCursor)
    .where(eq(telegramCursor.id, 1))
    .limit(1);
  return rows[0]?.lastUpdateId;
}

/** Persist the `getUpdates` cursor. Singleton row (id = 1), upserted. */
export async function setTelegramCursor(
  db: Db,
  lastUpdateId: bigint
): Promise<void> {
  await db
    .insert(telegramCursor)
    .values({ id: 1, lastUpdateId })
    .onConflictDoUpdate({
      target: telegramCursor.id,
      set: { lastUpdateId: sql`excluded.last_update_id` }
    });
}
