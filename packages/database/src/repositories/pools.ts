import {
  and,
  eq,
  inArray,
  isNull,
  or,
  sql
} from "drizzle-orm";
import type { Db } from "../client.js";
import {
  pools,
  quoteAssets,
  tokens
} from "../schema.js";
import { chunked, ADDRESS_CHUNK_SIZE, INSERT_CHUNK_SIZE } from "./shared.js";

export type PoolInsert = typeof pools.$inferInsert;

export type TokenInsert = typeof tokens.$inferInsert;

export type QuoteAssetInsert = typeof quoteAssets.$inferInsert;

export type PoolRow = typeof pools.$inferSelect;

export type TokenRow = typeof tokens.$inferSelect;

/**
 * Insert pools idempotently. Duplicate (chainId, poolAddress) rows are
 * ignored so replayed logs and overlapping scans are safe.
 * Returns the number of rows actually inserted.
 */
export async function insertPools(
  db: Db,
  rows: readonly PoolInsert[]
): Promise<number> {
  if (rows.length === 0) return 0;
  // Chunked: a backfill or catch-up burst can carry tens of thousands of
  // rows; idempotent onConflictDoNothing keeps partial progress restart-safe.
  let count = 0;
  for (const batch of chunked(rows, INSERT_CHUNK_SIZE)) {
    const inserted = await db
      .insert(pools)
      .values(batch)
      .onConflictDoNothing({ target: [pools.chainId, pools.poolAddress] })
      .returning({ poolAddress: pools.poolAddress });
    count += inserted.length;
  }
  return count;
}

/** Insert tokens idempotently, preserving the original first-seen block. */
export async function insertTokens(
  db: Db,
  rows: readonly TokenInsert[]
): Promise<number> {
  if (rows.length === 0) return 0;
  let count = 0;
  for (const batch of chunked(rows, INSERT_CHUNK_SIZE)) {
    const inserted = await db
      .insert(tokens)
      .values(batch)
      .onConflictDoNothing({ target: [tokens.chainId, tokens.address] })
      .returning({ address: tokens.address });
    count += inserted.length;
  }
  return count;
}

/** Upsert allow-listed quote assets from verified configuration. */
export async function upsertQuoteAssets(
  db: Db,
  rows: readonly QuoteAssetInsert[]
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(quoteAssets)
    .values([...rows])
    .onConflictDoUpdate({
      target: [quoteAssets.chainId, quoteAssets.address],
      set: {
        symbol: sql`excluded.symbol`,
        decimals: sql`excluded.decimals`,
        verificationSource: sql`excluded.verification_source`
      }
    });
}

/**
 * Startup reconcile: backfill quote/base sides for pools discovered before
 * an asset joined the trusted-quote allow-list. A hardcoded migration would
 * freeze the allow-list at the moment it was written; this walks the SAME
 * config the worker seeds on boot, so a future allow-list addition (new env
 * var, no code change) backfills its historical pools for free on the next
 * startup. One UPDATE per asset, in config order: a null-quote pool by
 * definition contains no already-listed asset (an earlier pass would have
 * claimed it), so ordering only matters among assets added in the same
 * release, and even then just picks which side wins for a pool pairing two
 * new assets together. Idempotent by construction — `quote_token_address IS
 * NULL` narrows every UPDATE to untouched rows, so re-running after the set
 * is fully backfilled is a guaranteed no-op.
 */
export async function renormalizeUntrustedPools(
  db: Db,
  chainId: number,
  quoteAssets: readonly { address: string }[]
): Promise<number> {
  let total = 0;
  for (const asset of quoteAssets) {
    const updated = await db
      .update(pools)
      .set({
        quoteTokenAddress: asset.address,
        baseTokenAddress: sql`case when ${pools.token0Address} = ${asset.address} then ${pools.token1Address} else ${pools.token0Address} end`
      })
      .where(
        and(
          eq(pools.chainId, chainId),
          isNull(pools.quoteTokenAddress),
          or(
            eq(pools.token0Address, asset.address),
            eq(pools.token1Address, asset.address)
          )
        )
      )
      .returning({ poolAddress: pools.poolAddress });
    total += updated.length;
  }
  return total;
}

/** All pools for a chain, ordered by creation block then log index. */
export async function listPools(db: Db, chainId: number): Promise<PoolRow[]> {
  return db
    .select()
    .from(pools)
    .where(eq(pools.chainId, chainId))
    .orderBy(pools.createdAtBlock, pools.createdLogIndex);
}

/** One pool by primary key. */
export async function getPool(
  db: Db,
  chainId: number,
  poolAddress: string
): Promise<PoolRow | undefined> {
  const rows = await db
    .select()
    .from(pools)
    .where(and(eq(pools.chainId, chainId), eq(pools.poolAddress, poolAddress)))
    .limit(1);
  return rows[0];
}

/** Pools whose two sides are exactly the given pair, in either order. */
export async function listPoolsByPair(
  db: Db,
  chainId: number,
  tokenA: string,
  tokenB: string
): Promise<PoolRow[]> {
  return db
    .select()
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        or(
          and(
            eq(pools.token0Address, tokenA),
            eq(pools.token1Address, tokenB)
          ),
          and(
            eq(pools.token0Address, tokenB),
            eq(pools.token1Address, tokenA)
          )
        )
      )
    );
}

/** Token rows for the given addresses. */
export async function getTokensByAddresses(
  db: Db,
  chainId: number,
  addresses: readonly string[]
): Promise<TokenRow[]> {
  if (addresses.length === 0) return [];
  // Chunked: enrichment passes one address per selected pool.
  const results: TokenRow[] = [];
  for (const batch of chunked(addresses, ADDRESS_CHUNK_SIZE)) {
    const rows = await db
      .select()
      .from(tokens)
      .where(and(eq(tokens.chainId, chainId), inArray(tokens.address, batch)));
    results.push(...rows);
  }
  return results;
}

export interface TokenMetadataUpdate {
  readonly name: string | null;
  readonly symbol: string | null;
  readonly decimals: number | null;
  /** uint256 as decimal string. */
  readonly totalSupply: string | null;
  readonly metadataStatus: "PASS" | "ERROR";
  readonly metadataBlock: bigint;
}

/** Refresh a token's metadata in place, recording the read block. */
export async function updateTokenMetadata(
  db: Db,
  chainId: number,
  address: string,
  update: TokenMetadataUpdate
): Promise<void> {
  await db
    .update(tokens)
    .set(update)
    .where(and(eq(tokens.chainId, chainId), eq(tokens.address, address)));
}

export interface TokenDeployerUpdate {
  /** EIP-55 checksummed creator address; null when the explorer had no answer. */
  readonly deployerAddress: string | null;
  /** "RESOLVED" | "UNKNOWN" — UNKNOWN is retryable, never a verdict. */
  readonly deployerStatus: "RESOLVED" | "UNKNOWN";
  /** When this resolution attempt happened; paces explorer retries. */
  readonly deployerCheckedAt: Date;
}

/** Record a deployer-resolution attempt for a token in place. Idempotent. */
export async function updateTokenDeployer(
  db: Db,
  chainId: number,
  address: string,
  update: TokenDeployerUpdate
): Promise<void> {
  await db
    .update(tokens)
    .set(update)
    .where(and(eq(tokens.chainId, chainId), eq(tokens.address, address)));
}
