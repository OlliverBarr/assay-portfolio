import {
  and,
  desc,
  eq,
  lte,
  sql
} from "drizzle-orm";
import type { Db } from "../client.js";
import {
  tokenHolderSnapshots,
  tokenHolders,
  tokens
} from "../schema.js";
import { chunked, INSERT_CHUNK_SIZE } from "./shared.js";

export type TokenHolderInsert = typeof tokenHolders.$inferInsert;

export type TokenHolderRow = typeof tokenHolders.$inferSelect;

export type TokenHolderSnapshotInsert = typeof tokenHolderSnapshots.$inferInsert;

export type TokenHolderSnapshotRow = typeof tokenHolderSnapshots.$inferSelect;

/** Upsert latest holder balances for a token. */
export async function upsertTokenHolders(
  db: Db,
  rows: readonly TokenHolderInsert[]
): Promise<void> {
  if (rows.length === 0) return;
  // Chunked: large tokens carry tens of thousands of holders. Callers wrap
  // this in a transaction with the scan-cursor update, so chunking here
  // never weakens that atomicity.
  for (const batch of chunked(rows, INSERT_CHUNK_SIZE)) {
    await db
      .insert(tokenHolders)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          tokenHolders.chainId,
          tokenHolders.tokenAddress,
          tokenHolders.holderAddress
        ],
        set: {
          balanceRaw: sql`excluded.balance_raw`,
          updatedBlock: sql`excluded.updated_block`
        }
      });
  }
}

/** Latest known balances for every recorded holder of a token. */
export async function listTokenHolders(
  db: Db,
  chainId: number,
  tokenAddress: string
): Promise<TokenHolderRow[]> {
  return db
    .select()
    .from(tokenHolders)
    .where(
      and(
        eq(tokenHolders.chainId, chainId),
        eq(tokenHolders.tokenAddress, tokenAddress)
      )
    );
}

/**
 * Advance a token's incremental holder-scan cursor. Must be called in the
 * same transaction as the balance upsert + snapshot insert so a crash never
 * leaves the cursor ahead of the persisted balances.
 */
export async function updateTokenHolderScanBlock(
  db: Db,
  chainId: number,
  address: string,
  holderScanBlock: bigint
): Promise<void> {
  await db
    .update(tokens)
    .set({ holderScanBlock })
    .where(and(eq(tokens.chainId, chainId), eq(tokens.address, address)));
}

/** Append a holder-distribution snapshot. */
export async function insertTokenHolderSnapshot(
  db: Db,
  row: TokenHolderSnapshotInsert
): Promise<TokenHolderSnapshotRow> {
  const [inserted] = await db
    .insert(tokenHolderSnapshots)
    .values(row)
    .returning();
  if (inserted === undefined) {
    throw new Error("insertTokenHolderSnapshot returned no row");
  }
  return inserted;
}

/** Latest holder snapshot for a token, or undefined. */
export async function getLatestHolderSnapshot(
  db: Db,
  chainId: number,
  tokenAddress: string
): Promise<TokenHolderSnapshotRow | undefined> {
  const rows = await db
    .select()
    .from(tokenHolderSnapshots)
    .where(
      and(
        eq(tokenHolderSnapshots.chainId, chainId),
        eq(tokenHolderSnapshots.tokenAddress, tokenAddress)
      )
    )
    .orderBy(desc(tokenHolderSnapshots.capturedAt), desc(tokenHolderSnapshots.id))
    .limit(1);
  return rows[0];
}

/**
 * Latest holder snapshot for a token at or before `at`, or undefined. Backs
 * historical entry-feature reconstruction on an append-only table.
 */
export async function getHolderSnapshotAt(
  db: Db,
  chainId: number,
  tokenAddress: string,
  at: Date
): Promise<TokenHolderSnapshotRow | undefined> {
  const rows = await db
    .select()
    .from(tokenHolderSnapshots)
    .where(
      and(
        eq(tokenHolderSnapshots.chainId, chainId),
        eq(tokenHolderSnapshots.tokenAddress, tokenAddress),
        lte(tokenHolderSnapshots.capturedAt, at)
      )
    )
    .orderBy(desc(tokenHolderSnapshots.capturedAt), desc(tokenHolderSnapshots.id))
    .limit(1);
  return rows[0];
}
