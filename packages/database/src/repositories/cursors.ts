import {
  and,
  eq,
  lt,
  sql
} from "drizzle-orm";
import type { Db } from "../client.js";
import {
  activityCursor,
  chainCursor,
} from "../schema.js";

export type ChainCursorRow = typeof chainCursor.$inferSelect;

export type ActivityCursorRow = typeof activityCursor.$inferSelect;

/** Read the cursor for a chain; undefined when discovery has never run. */
export async function getCursor(
  db: Db,
  chainId: number
): Promise<ChainCursorRow | undefined> {
  const rows = await db
    .select()
    .from(chainCursor)
    .where(eq(chainCursor.chainId, chainId))
    .limit(1);
  return rows[0];
}

/**
 * Create the cursor if absent. `startBlock` is the last block considered
 * already processed (i.e. scanning begins at startBlock + 1). Idempotent.
 */
export async function initializeCursor(
  db: Db,
  chainId: number,
  startBlock: bigint
): Promise<void> {
  await db
    .insert(chainCursor)
    .values({
      chainId,
      latestObservedBlock: startBlock,
      latestProcessedBlock: startBlock
    })
    .onConflictDoNothing({ target: chainCursor.chainId });
}

/** Record the newest chain head seen. Never moves backwards. */
export async function recordObservedBlock(
  db: Db,
  chainId: number,
  block: bigint
): Promise<void> {
  await db
    .update(chainCursor)
    .set({
      latestObservedBlock: block,
      updatedAt: sql`now()`
    })
    .where(
      and(
        eq(chainCursor.chainId, chainId),
        lt(chainCursor.latestObservedBlock, block)
      )
    );
}

/**
 * Advance the safely-processed watermark to `toBlock`.
 *
 * MUST be called inside the same transaction that persists the range's
 * pools; the WHERE guard makes a stale or replayed advance a no-op instead
 * of moving the cursor backwards.
 */
export async function advanceProcessedBlock(
  db: Db,
  chainId: number,
  toBlock: bigint
): Promise<void> {
  await db
    .update(chainCursor)
    .set({
      latestProcessedBlock: toBlock,
      updatedAt: sql`now()`
    })
    .where(
      and(
        eq(chainCursor.chainId, chainId),
        lt(chainCursor.latestProcessedBlock, toBlock)
      )
    );
}

/** Read the activity cursor for a chain; undefined until swap ingestion runs. */
export async function getActivityCursor(
  db: Db,
  chainId: number
): Promise<ActivityCursorRow | undefined> {
  const rows = await db
    .select()
    .from(activityCursor)
    .where(eq(activityCursor.chainId, chainId))
    .limit(1);
  return rows[0];
}

/** Create the activity cursor if absent. Idempotent. */
export async function initializeActivityCursor(
  db: Db,
  chainId: number,
  startBlock: bigint
): Promise<void> {
  await db
    .insert(activityCursor)
    .values({
      chainId,
      latestObservedBlock: startBlock,
      latestProcessedBlock: startBlock
    })
    .onConflictDoNothing({ target: activityCursor.chainId });
}

/** Record the newest head observed by activity ingestion. Never moves backwards. */
export async function recordActivityObservedBlock(
  db: Db,
  chainId: number,
  block: bigint
): Promise<void> {
  await db
    .update(activityCursor)
    .set({
      latestObservedBlock: block,
      updatedAt: sql`now()`
    })
    .where(
      and(
        eq(activityCursor.chainId, chainId),
        lt(activityCursor.latestObservedBlock, block)
      )
    );
}

/** Advance the activity processed watermark. Must share the swap transaction. */
export async function advanceActivityProcessedBlock(
  db: Db,
  chainId: number,
  toBlock: bigint
): Promise<void> {
  await db
    .update(activityCursor)
    .set({
      latestProcessedBlock: toBlock,
      updatedAt: sql`now()`
    })
    .where(
      and(
        eq(activityCursor.chainId, chainId),
        lt(activityCursor.latestProcessedBlock, toBlock)
      )
    );
}
