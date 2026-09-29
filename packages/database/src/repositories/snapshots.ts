import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lte,
  or,
  sql
} from "drizzle-orm";
import type { Db } from "../client.js";
import {
  poolActivitySnapshots,
  poolSnapshots,
  poolSwapEvents
} from "../schema.js";
import { chunked, ADDRESS_CHUNK_SIZE, INSERT_CHUNK_SIZE } from "./shared.js";

export type PoolSnapshotInsert = typeof poolSnapshots.$inferInsert;

export type PoolSnapshotRow = typeof poolSnapshots.$inferSelect;

export type PoolSwapEventInsert = typeof poolSwapEvents.$inferInsert;

export type PoolSwapEventRow = typeof poolSwapEvents.$inferSelect;

export type PoolActivitySnapshotInsert =
  typeof poolActivitySnapshots.$inferInsert;

export type PoolActivitySnapshotRow = typeof poolActivitySnapshots.$inferSelect;

/** Append snapshots. Never updates existing rows — history is the product. */
export async function insertPoolSnapshots(
  db: Db,
  rows: readonly PoolSnapshotInsert[]
): Promise<number> {
  if (rows.length === 0) return 0;
  let count = 0;
  for (const batch of chunked(rows, INSERT_CHUNK_SIZE)) {
    const inserted = await db
      .insert(poolSnapshots)
      .values(batch)
      .returning({ id: poolSnapshots.id });
    count += inserted.length;
  }
  return count;
}

/** Snapshots for one pool, oldest first. */
export async function listPoolSnapshots(
  db: Db,
  chainId: number,
  poolAddress: string
): Promise<PoolSnapshotRow[]> {
  return db
    .select()
    .from(poolSnapshots)
    .where(
      and(
        eq(poolSnapshots.chainId, chainId),
        eq(poolSnapshots.poolAddress, poolAddress)
      )
    )
    .orderBy(poolSnapshots.id);
}

function dedupeSwapRows(
  rows: readonly PoolSwapEventInsert[]
): PoolSwapEventInsert[] {
  const unique = new Map<string, PoolSwapEventInsert>();
  for (const row of rows) {
    const key = `${row.chainId}:${row.transactionHash}:${row.logIndex}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

/**
 * Insert normalized swap events idempotently. Duplicate log identities are
 * ignored both inside the submitted batch and against already-stored rows.
 */
export async function insertPoolSwapEvents(
  db: Db,
  rows: readonly PoolSwapEventInsert[]
): Promise<number> {
  const uniqueRows = dedupeSwapRows(rows);
  if (uniqueRows.length === 0) return 0;
  let count = 0;
  for (const batch of chunked(uniqueRows, INSERT_CHUNK_SIZE)) {
    const inserted = await db
      .insert(poolSwapEvents)
      .values(batch)
      .onConflictDoNothing({
        target: [
          poolSwapEvents.chainId,
          poolSwapEvents.transactionHash,
          poolSwapEvents.logIndex
        ]
      })
      .returning({ id: poolSwapEvents.id });
    count += inserted.length;
  }
  return count;
}

/** Swap events for one pool, oldest first. */
export async function listPoolSwapEvents(
  db: Db,
  chainId: number,
  poolAddress: string
): Promise<PoolSwapEventRow[]> {
  return db
    .select()
    .from(poolSwapEvents)
    .where(
      and(
        eq(poolSwapEvents.chainId, chainId),
        eq(poolSwapEvents.poolAddress, poolAddress)
      )
    )
    .orderBy(poolSwapEvents.blockNumber, poolSwapEvents.logIndex);
}

/**
 * Swap events observed at/after `since` for any of `poolAddresses`, address-
 * chunked (postgres caps bind parameters at 65,534 — see ADDRESS_CHUNK_SIZE)
 * but merged and ordered as a single result set by `observedAt` ascending.
 * Replaces per-pool full-history reads when the activity pass rebuilds
 * rolling-window snapshots for the active set: cost scales with the active
 * pool count and window size, not with lifetime swap history.
 */
export async function listPoolSwapEventsSince(
  db: Db,
  chainId: number,
  poolAddresses: readonly string[],
  since: Date
): Promise<PoolSwapEventRow[]> {
  if (poolAddresses.length === 0) return [];
  const results: PoolSwapEventRow[] = [];
  for (const batch of chunked(poolAddresses, ADDRESS_CHUNK_SIZE)) {
    const rows = await db
      .select()
      .from(poolSwapEvents)
      .where(
        and(
          eq(poolSwapEvents.chainId, chainId),
          inArray(poolSwapEvents.poolAddress, batch),
          gte(poolSwapEvents.observedAt, since)
        )
      );
    results.push(...rows);
  }
  results.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  return results;
}

/** One on-chain trade attributable to a watched (operator) wallet. */
export interface WalletSwap {
  readonly tokenAddress: string;
  readonly poolAddress: string;
  /** "BUY" | "SELL" */
  readonly side: string;
  readonly observedAt: Date;
}

/**
 * BUY/SELL swaps whose recipient or sender matches any watched wallet
 * (case-insensitive). Drives automatic operator entry/exit detection in the
 * feedback report — the operator executes on-chain, so their trades are
 * already in `pool_swap_events` and never need manual declaration.
 */
export async function listSwapsByWallets(
  db: Db,
  chainId: number,
  wallets: readonly string[]
): Promise<WalletSwap[]> {
  if (wallets.length === 0) return [];
  const lowered = wallets.map((wallet) => wallet.toLowerCase());
  return db
    .select({
      tokenAddress: poolSwapEvents.baseTokenAddress,
      poolAddress: poolSwapEvents.poolAddress,
      side: poolSwapEvents.side,
      observedAt: poolSwapEvents.observedAt
    })
    .from(poolSwapEvents)
    .where(
      and(
        eq(poolSwapEvents.chainId, chainId),
        inArray(poolSwapEvents.side, ["BUY", "SELL"]),
        or(
          inArray(sql`lower(${poolSwapEvents.recipient})`, lowered),
          inArray(sql`lower(${poolSwapEvents.sender})`, lowered)
        )
      )
    )
    .orderBy(poolSwapEvents.blockNumber, poolSwapEvents.logIndex);
}

/** Append activity snapshots. Never updates existing rows. */
export async function insertPoolActivitySnapshots(
  db: Db,
  rows: readonly PoolActivitySnapshotInsert[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(poolActivitySnapshots)
    .values([...rows])
    .returning({ id: poolActivitySnapshots.id });
  return inserted.length;
}

/** Activity snapshots for one pool, oldest first. */
export async function listPoolActivitySnapshots(
  db: Db,
  chainId: number,
  poolAddress: string
): Promise<PoolActivitySnapshotRow[]> {
  return db
    .select()
    .from(poolActivitySnapshots)
    .where(
      and(
        eq(poolActivitySnapshots.chainId, chainId),
        eq(poolActivitySnapshots.poolAddress, poolAddress)
      )
    )
    .orderBy(poolActivitySnapshots.id);
}

/** Latest market snapshot for a pool, or undefined. */
export async function getLatestPoolSnapshot(
  db: Db,
  chainId: number,
  poolAddress: string
): Promise<PoolSnapshotRow | undefined> {
  const rows = await db
    .select()
    .from(poolSnapshots)
    .where(
      and(
        eq(poolSnapshots.chainId, chainId),
        eq(poolSnapshots.poolAddress, poolAddress)
      )
    )
    .orderBy(desc(poolSnapshots.capturedAt), desc(poolSnapshots.id))
    .limit(1);
  return rows[0];
}

/** Latest activity snapshot for a pool, or undefined. */
export async function getLatestActivitySnapshot(
  db: Db,
  chainId: number,
  poolAddress: string
): Promise<PoolActivitySnapshotRow | undefined> {
  const rows = await db
    .select()
    .from(poolActivitySnapshots)
    .where(
      and(
        eq(poolActivitySnapshots.chainId, chainId),
        eq(poolActivitySnapshots.poolAddress, poolAddress)
      )
    )
    .orderBy(desc(poolActivitySnapshots.capturedAt), desc(poolActivitySnapshots.id))
    .limit(1);
  return rows[0];
}

/**
 * Most recent `pool_snapshots.captured_at` across every pool on a chain, or
 * undefined when none exist yet. Drives the dead-man heartbeat: ingestion is
 * considered stalled once this falls too far behind "now".
 */
export async function getLatestSnapshotCapturedAt(
  db: Db,
  chainId: number
): Promise<Date | undefined> {
  const rows = await db
    .select({ capturedAt: poolSnapshots.capturedAt })
    .from(poolSnapshots)
    .where(eq(poolSnapshots.chainId, chainId))
    .orderBy(desc(poolSnapshots.capturedAt))
    .limit(1);
  return rows[0]?.capturedAt;
}

/**
 * Latest activity snapshot for a pool at or before `at`, or undefined. Backs
 * historical entry-feature reconstruction on an append-only table.
 */
export async function getActivitySnapshotAt(
  db: Db,
  chainId: number,
  poolAddress: string,
  at: Date
): Promise<PoolActivitySnapshotRow | undefined> {
  const rows = await db
    .select()
    .from(poolActivitySnapshots)
    .where(
      and(
        eq(poolActivitySnapshots.chainId, chainId),
        eq(poolActivitySnapshots.poolAddress, poolAddress),
        lte(poolActivitySnapshots.capturedAt, at)
      )
    )
    .orderBy(desc(poolActivitySnapshots.capturedAt), desc(poolActivitySnapshots.id))
    .limit(1);
  return rows[0];
}
