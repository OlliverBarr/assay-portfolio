import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  lte,
  ne,
  notExists,
  sql
} from "drizzle-orm";
import type { Db } from "../client.js";
import {
  operatorDecisions,
  poolSnapshots,
  pools,
  tokenOutcomes,
  tokenPerformance,
  tokens
} from "../schema.js";
import { chunked, ADDRESS_CHUNK_SIZE } from "./shared.js";
import type { PoolRow } from "./pools.js";

export type TokenOutcomeInsert = typeof tokenOutcomes.$inferInsert;

export type TokenOutcomeRow = typeof tokenOutcomes.$inferSelect;

export type OperatorDecisionInsert = typeof operatorDecisions.$inferInsert;

export type OperatorDecisionRow = typeof operatorDecisions.$inferSelect;

export type TokenPerformanceInsert = typeof tokenPerformance.$inferInsert;

export type TokenPerformanceRow = typeof tokenPerformance.$inferSelect;

/**
 * Append a survival label. Idempotent on the unique (chainId, poolAddress,
 * horizonHours) key — an existing label is never overwritten.
 */
export async function insertTokenOutcome(
  db: Db,
  row: TokenOutcomeInsert
): Promise<void> {
  await db
    .insert(tokenOutcomes)
    .values(row)
    .onConflictDoNothing({
      target: [
        tokenOutcomes.chainId,
        tokenOutcomes.poolAddress,
        tokenOutcomes.horizonHours
      ]
    });
}

/** Survival labels for one token across all horizons, oldest first. */
export async function getTokenOutcomes(
  db: Db,
  chainId: number,
  tokenAddress: string
): Promise<TokenOutcomeRow[]> {
  return db
    .select()
    .from(tokenOutcomes)
    .where(
      and(
        eq(tokenOutcomes.chainId, chainId),
        eq(tokenOutcomes.tokenAddress, tokenAddress)
      )
    )
    .orderBy(tokenOutcomes.horizonHours, tokenOutcomes.id);
}

/**
 * Earliest snapshot time per pool, aggregated in SQL. The naive alternative
 * (streaming every snapshot row and keeping the first per pool) transfers
 * the whole append-only table on every labeling pass.
 */
async function firstSnapshotCapturedAt(
  db: Db,
  chainId: number
): Promise<Map<string, Date>> {
  const rows = await db
    .select({
      poolAddress: poolSnapshots.poolAddress,
      firstCapturedAt: sql`min(${poolSnapshots.capturedAt})`.mapWith(
        (value: string | Date) =>
          value instanceof Date ? value : new Date(value)
      )
    })
    .from(poolSnapshots)
    .where(eq(poolSnapshots.chainId, chainId))
    .groupBy(poolSnapshots.poolAddress);
  return new Map(rows.map((row) => [row.poolAddress, row.firstCapturedAt]));
}

/**
 * Pool rows for the given addresses, globally ordered by (createdAtBlock,
 * createdLogIndex) and capped at `limit`. Address lists here scale with
 * table population, so the lookup is chunked; each chunk keeps its own
 * top-`limit` (a superset of the global top-`limit`), then the merged rows
 * are re-sorted and truncated.
 */
async function listPoolsByAddressesOrdered(
  db: Db,
  chainId: number,
  addresses: readonly string[],
  limit: number
): Promise<PoolRow[]> {
  const collected: PoolRow[] = [];
  for (const batch of chunked(addresses, ADDRESS_CHUNK_SIZE)) {
    const rows = await db
      .select()
      .from(pools)
      .where(and(eq(pools.chainId, chainId), inArray(pools.poolAddress, batch)))
      .orderBy(pools.createdAtBlock, pools.createdLogIndex)
      .limit(limit);
    collected.push(...rows);
  }
  collected.sort((a, b) => {
    if (a.createdAtBlock !== b.createdAtBlock) {
      return a.createdAtBlock < b.createdAtBlock ? -1 : 1;
    }
    return a.createdLogIndex - b.createdLogIndex;
  });
  return collected.slice(0, limit);
}

/**
 * Pools whose FIRST stored `pool_snapshots` row is at least `horizonHours`
 * old and which have no `token_outcomes` row for that horizon yet. Drives
 * restart-safe outcome labeling: a crash mid-pass simply leaves due pools
 * selectable next pass, and labeled pools drop out permanently.
 */
export async function getPoolsDueForOutcome(
  db: Db,
  chainId: number,
  horizonHours: number,
  limit: number
): Promise<PoolRow[]> {
  const firstCapturedAtByPool = await firstSnapshotCapturedAt(db, chainId);
  if (firstCapturedAtByPool.size === 0) return [];

  const labeled = await db
    .select({ poolAddress: tokenOutcomes.poolAddress })
    .from(tokenOutcomes)
    .where(
      and(
        eq(tokenOutcomes.chainId, chainId),
        eq(tokenOutcomes.horizonHours, horizonHours)
      )
    );
  const labeledSet = new Set(labeled.map((row) => row.poolAddress));

  const horizonMs = horizonHours * 60 * 60 * 1000;
  const now = Date.now();
  const dueAddresses = [...firstCapturedAtByPool.entries()]
    .filter(
      ([poolAddr, firstCapturedAt]) =>
        !labeledSet.has(poolAddr) && now - firstCapturedAt.getTime() >= horizonMs
    )
    .map(([poolAddr]) => poolAddr);
  if (dueAddresses.length === 0) return [];

  return listPoolsByAddressesOrdered(db, chainId, dueAddresses, limit);
}

/**
 * Append a manual operator trade decision. Never updated — the feedback
 * report depends on the full history, including decisions later reversed
 * (e.g. ENTERED followed by EXITED).
 */
export async function insertOperatorDecision(
  db: Db,
  row: OperatorDecisionInsert
): Promise<OperatorDecisionRow> {
  const [inserted] = await db
    .insert(operatorDecisions)
    .values(row)
    .returning();
  if (inserted === undefined) {
    throw new Error("insertOperatorDecision returned no row");
  }
  return inserted;
}

/**
 * Operator decisions for a chain, newest first. Narrows to one token when
 * `tokenAddress` is given.
 */
export async function listOperatorDecisions(
  db: Db,
  chainId: number,
  tokenAddress?: string
): Promise<OperatorDecisionRow[]> {
  return db
    .select()
    .from(operatorDecisions)
    .where(
      tokenAddress === undefined
        ? eq(operatorDecisions.chainId, chainId)
        : and(
            eq(operatorDecisions.chainId, chainId),
            eq(operatorDecisions.tokenAddress, tokenAddress)
          )
    )
    .orderBy(desc(operatorDecisions.recordedAt), desc(operatorDecisions.id));
}

/**
 * Every survival outcome recorded for a chain, across all tokens and
 * horizons. Backs the operator-feedback report, which needs the full
 * outcome set per token rather than one token at a time.
 */
export async function listTokenOutcomes(
  db: Db,
  chainId: number
): Promise<TokenOutcomeRow[]> {
  return db
    .select()
    .from(tokenOutcomes)
    .where(eq(tokenOutcomes.chainId, chainId))
    .orderBy(
      tokenOutcomes.tokenAddress,
      tokenOutcomes.horizonHours,
      tokenOutcomes.id
    );
}

/**
 * Append a realized-performance label. Idempotent on the unique (chainId,
 * poolAddress, horizonHours) key — an existing label is never overwritten.
 */
export async function insertTokenPerformance(
  db: Db,
  row: TokenPerformanceInsert
): Promise<void> {
  await db
    .insert(tokenPerformance)
    .values(row)
    .onConflictDoNothing({
      target: [
        tokenPerformance.chainId,
        tokenPerformance.poolAddress,
        tokenPerformance.horizonHours
      ]
    });
}

/**
 * Every realized-performance label recorded for a chain, across all tokens
 * and horizons.
 */
export async function listTokenPerformance(
  db: Db,
  chainId: number
): Promise<TokenPerformanceRow[]> {
  return db
    .select()
    .from(tokenPerformance)
    .where(eq(tokenPerformance.chainId, chainId))
    .orderBy(
      tokenPerformance.tokenAddress,
      tokenPerformance.horizonHours,
      tokenPerformance.id
    );
}

/**
 * Pools due for a `token_performance` label at `horizonHours`: at least one
 * snapshot INSIDE the configured FDV band, priced, and old enough that the
 * horizon window from that snapshot has fully elapsed — and no
 * `token_performance` row for this horizon yet. Band membership is a SQL
 * precondition on purpose: the labeling pass persists nothing for a pool
 * that never entered the band, so a coarse "has old snapshots" filter let
 * the 200 oldest never-band pools occupy every batch forever and starve
 * every real band entrant behind them (live 2026-07-12: 13 labels total on
 * a chain with 1,746 band-entrant pools, `labeled:0 skipped:200` every
 * pass). The EXISTS bound also implies the window has elapsed: the first
 * priced in-band snapshot is at or before any matching one. The TS pass
 * remains the precise authority on entry selection; a boundary disagreement
 * with its lossy USD parsing only re-skips that pool, never the batch.
 */
export async function getPoolsDueForPerformance(
  db: Db,
  chainId: number,
  horizonHours: number,
  limit: number,
  band: { minFdvUsd: number; maxFdvUsd: number }
): Promise<PoolRow[]> {
  const windowElapsedCutoff = new Date(Date.now() - horizonHours * 60 * 60 * 1000);

  const bandEntrySnapshot = db
    .select({ one: sql`1` })
    .from(poolSnapshots)
    .where(
      and(
        eq(poolSnapshots.chainId, pools.chainId),
        eq(poolSnapshots.poolAddress, pools.poolAddress),
        lte(poolSnapshots.capturedAt, windowElapsedCutoff),
        isNotNull(poolSnapshots.priceUsd),
        sql`${poolSnapshots.estimatedFdvUsd} >= ${band.minFdvUsd.toString()}::numeric`,
        sql`${poolSnapshots.estimatedFdvUsd} <= ${band.maxFdvUsd.toString()}::numeric`
      )
    );

  const alreadyLabeled = db
    .select({ one: sql`1` })
    .from(tokenPerformance)
    .where(
      and(
        eq(tokenPerformance.chainId, pools.chainId),
        eq(tokenPerformance.poolAddress, pools.poolAddress),
        eq(tokenPerformance.horizonHours, horizonHours)
      )
    );

  return db
    .select()
    .from(pools)
    .where(
      and(eq(pools.chainId, chainId), exists(bandEntrySnapshot), notExists(alreadyLabeled))
    )
    .orderBy(pools.createdAtBlock, pools.createdLogIndex)
    .limit(limit);
}

/**
 * Every outcome row for tokens deployed by `deployerAddress` (deployer
 * resolution must be RESOLVED, not just present, since UNKNOWN is a
 * retryable placeholder), excluding `excludeTokenAddress`. Callers as-of
 * filter on the returned `labeledAt`.
 */
export async function listTokenOutcomesByDeployer(
  db: Db,
  chainId: number,
  deployerAddress: string,
  excludeTokenAddress: string
): Promise<TokenOutcomeRow[]> {
  return db
    .select({
      id: tokenOutcomes.id,
      chainId: tokenOutcomes.chainId,
      tokenAddress: tokenOutcomes.tokenAddress,
      poolAddress: tokenOutcomes.poolAddress,
      horizonHours: tokenOutcomes.horizonHours,
      outcome: tokenOutcomes.outcome,
      peakQuoteLiquidityUsd: tokenOutcomes.peakQuoteLiquidityUsd,
      quoteLiquidityAtHorizonUsd: tokenOutcomes.quoteLiquidityAtHorizonUsd,
      estimatedFdvAtHorizonUsd: tokenOutcomes.estimatedFdvAtHorizonUsd,
      firstObservedAt: tokenOutcomes.firstObservedAt,
      labeledAt: tokenOutcomes.labeledAt,
      details: tokenOutcomes.details
    })
    .from(tokenOutcomes)
    .innerJoin(
      tokens,
      and(
        eq(tokens.chainId, tokenOutcomes.chainId),
        eq(tokens.address, tokenOutcomes.tokenAddress)
      )
    )
    .where(
      and(
        eq(tokenOutcomes.chainId, chainId),
        eq(tokens.deployerAddress, deployerAddress),
        eq(tokens.deployerStatus, "RESOLVED"),
        ne(tokenOutcomes.tokenAddress, excludeTokenAddress)
      )
    )
    .orderBy(desc(tokenOutcomes.labeledAt), desc(tokenOutcomes.id));
}
