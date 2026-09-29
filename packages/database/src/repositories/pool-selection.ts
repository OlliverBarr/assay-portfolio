import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  lte,
  not,
  notExists,
  or,
  sql
} from "drizzle-orm";
import type { Db } from "../client.js";
import {
  poolActivitySnapshots,
  poolSnapshots,
  pools,
  tokenRisks
} from "../schema.js";
import type { PoolRow } from "./pools.js";

/** Pools whose valuation is anchored by an allow-listed quote asset. */
export async function listTrustedQuotePools(
  db: Db,
  chainId: number,
  limit?: number
): Promise<PoolRow[]> {
  const query = db
    .select()
    .from(pools)
    .where(and(eq(pools.chainId, chainId), isNotNull(pools.quoteTokenAddress)))
    .orderBy(pools.createdAtBlock, pools.createdLogIndex);
  return limit === undefined ? query : query.limit(limit);
}

/**
 * Trusted-quote pools for one base token, case-insensitive, newest first.
 * Serves on-demand lookups (Telegram /score, validate:candidate) without
 * sweeping the full trusted population; bounded because launch farms
 * occasionally spawn many pools for one token.
 */
export async function listTrustedQuotePoolsForToken(
  db: Db,
  chainId: number,
  baseTokenAddress: string,
  limit = 5
): Promise<PoolRow[]> {
  return db
    .select()
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        isNotNull(pools.quoteTokenAddress),
        sql`lower(${pools.baseTokenAddress}) = ${baseTokenAddress.toLowerCase()}`
      )
    )
    .orderBy(desc(pools.createdAtBlock), desc(pools.createdLogIndex))
    .limit(limit);
}

/** Trusted-quote pools created no later than `blockNumber`. */
export async function listTrustedQuotePoolsCreatedBefore(
  db: Db,
  chainId: number,
  blockNumber: bigint
): Promise<PoolRow[]> {
  return db
    .select()
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        isNotNull(pools.quoteTokenAddress),
        isNotNull(pools.baseTokenAddress),
        lte(pools.createdAtBlock, blockNumber)
      )
    )
    .orderBy(pools.createdAtBlock, pools.createdLogIndex);
}

/**
 * The "active set": pools worth full-cadence signal refresh. A pool is active
 * when it was created on-chain recently OR its latest snapshot values it
 * inside the configured watch band. Everything else is idle and refreshed on
 * a slow lane (listIdleTrustedQuotePoolsDue), so RPC cost scales with launch
 * activity rather than with the all-time pool count.
 *
 * Youth is measured by on-chain creation block, never by `discovered_at`:
 * ingestion time reflects when WE inserted the row, so a backfill or a
 * downtime catch-up would stamp the entire historical population as "young"
 * and put it on the full-cadence lane (observed live 2026-07-11: a ~62k-pool
 * backfill made every pool active and crashed the worker on the postgres
 * 65,534-bind-parameter cap).
 */
export interface ActivePoolCriteria {
  readonly now: Date;
  /** Pools created on-chain at or after this block are always active. */
  readonly activeMinCreatedBlock: bigint;
  /** Latest-snapshot estimated-FDV band that keeps an older pool active. */
  readonly watchMinFdvUsd: number;
  readonly watchMaxFdvUsd: number;
}

/** SQL condition for membership in the active set. */
function activePoolCondition(criteria: ActivePoolCriteria) {
  return or(
    gte(pools.createdAtBlock, criteria.activeMinCreatedBlock),
    // Latest snapshot (by id) has an FDV inside the watch band. Null FDV
    // (unpriceable) never keeps a pool active.
    sql`exists (
      select 1 from pool_snapshots s
      where s.chain_id = ${pools.chainId}
        and s.pool_address = ${pools.poolAddress}
        and s.id = (
          select max(s2.id) from pool_snapshots s2
          where s2.chain_id = ${pools.chainId}
            and s2.pool_address = ${pools.poolAddress}
        )
        and s.estimated_fdv_usd is not null
        and s.estimated_fdv_usd >= ${criteria.watchMinFdvUsd}
        and s.estimated_fdv_usd <= ${criteria.watchMaxFdvUsd}
    )`
  );
}

/** Trusted-quote pools in the active set (recent or watch-band valued). */
export async function listActiveTrustedQuotePools(
  db: Db,
  chainId: number,
  criteria: ActivePoolCriteria,
  limit?: number
): Promise<PoolRow[]> {
  const query = db
    .select()
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        isNotNull(pools.quoteTokenAddress),
        activePoolCondition(criteria)
      )
    )
    .orderBy(pools.createdAtBlock, pools.createdLogIndex);
  return limit === undefined ? query : query.limit(limit);
}

/**
 * Idle-lane refresh: trusted-quote pools OUTSIDE the active set whose latest
 * snapshot is older than `idleCutoff` (or that have no snapshot at all),
 * stalest first. This keeps re-detection alive — a dormant pool pumping back
 * into the watch band is re-valued within one idle interval and thereby
 * promotes itself into the active set.
 */
export async function listIdleTrustedQuotePoolsDue(
  db: Db,
  chainId: number,
  criteria: ActivePoolCriteria,
  idleCutoff: Date,
  limit: number
): Promise<PoolRow[]> {
  const fresh = db
    .select({ one: sql`1` })
    .from(poolSnapshots)
    .where(
      and(
        eq(poolSnapshots.chainId, pools.chainId),
        eq(poolSnapshots.poolAddress, pools.poolAddress),
        gte(poolSnapshots.capturedAt, idleCutoff)
      )
    );
  return db
    .select()
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        isNotNull(pools.quoteTokenAddress),
        not(activePoolCondition(criteria) ?? sql`false`),
        notExists(fresh)
      )
    )
    .orderBy(
      sql`(
        select max(s.captured_at) from pool_snapshots s
        where s.chain_id = ${pools.chainId}
          and s.pool_address = ${pools.poolAddress}
      ) asc nulls first`
    )
    .limit(limit);
}

/**
 * Active-set trusted-quote pools created on-chain no later than
 * `blockNumber`. Same active semantics as `listActiveTrustedQuotePools`
 * (recent-by-block OR watch-band FDV); used by the activity pass so
 * per-chunk swap-ingestion work scales with launch activity rather than
 * with the all-time pool count.
 */
export async function listActiveTrustedQuotePoolsCreatedBefore(
  db: Db,
  chainId: number,
  blockNumber: bigint,
  criteria: ActivePoolCriteria
): Promise<PoolRow[]> {
  return db
    .select()
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        isNotNull(pools.quoteTokenAddress),
        lte(pools.createdAtBlock, blockNumber),
        activePoolCondition(criteria)
      )
    )
    .orderBy(pools.createdAtBlock, pools.createdLogIndex);
}

/**
 * Trusted-quote pools with no risk assessment newer than `staleBefore`.
 * Drives restart-safe risk selection: a crash mid-pass simply leaves the
 * unassessed pools selectable next pass, and already-assessed pools drop out
 * until their result goes stale. Idempotent by construction.
 */
export async function listTrustedQuotePoolsNeedingRisk(
  db: Db,
  chainId: number,
  staleBefore: Date,
  limit?: number,
  active?: ActivePoolCriteria
): Promise<PoolRow[]> {
  const recent = db
    .select({ one: sql`1` })
    .from(tokenRisks)
    .where(
      and(
        eq(tokenRisks.chainId, pools.chainId),
        eq(tokenRisks.poolAddress, pools.poolAddress),
        gte(tokenRisks.assessedAt, staleBefore)
      )
    );
  const conditions = [
    eq(pools.chainId, chainId),
    isNotNull(pools.quoteTokenAddress),
    isNotNull(pools.baseTokenAddress),
    notExists(recent)
  ];
  // Scoped to the active set when criteria are given: risk data for pools
  // outside the watch band is worthless, and re-assessing every token forever
  // makes RPC cost scale with all-time pool count.
  if (active !== undefined) {
    const condition = activePoolCondition(active);
    if (condition !== undefined) conditions.push(condition);
  }
  const query = db
    .select()
    .from(pools)
    .where(and(...conditions))
    // Newest first: fresh launches are the alert-relevant ones (2026-07-12
    // audit — oldest-first served band entrants last).
    .orderBy(desc(pools.createdAtBlock), desc(pools.createdLogIndex));
  return limit === undefined ? query : query.limit(limit);
}

/**
 * Latest-snapshot FDV band used to prioritize expensive signal acquisition
 * (holders, risk, scoring) toward pools the product can actually alert on.
 * Unlike {@link ActivePoolCriteria} this deliberately has NO "young pool"
 * arm: youth alone must not spend holder/risk budget (2026-07-12 audit:
 * staleness sweeps over ~14k young pools starved every band token of
 * ownership data, making eligibility structurally impossible).
 */
export interface FdvBandCriteria {
  readonly minFdvUsd: number;
  readonly maxFdvUsd: number;
}

/**
 * SQL condition: the pool's latest snapshot FDV lies inside the band and,
 * when `minQuoteLiquidityUsd` > 0, the same snapshot carries at least that
 * much trusted-quote liquidity. The floor exists for the expensive signal
 * lanes (holders, risk): estimated FDV is nominal (price x total supply, so
 * a dust pool can report any FDV), while quote liquidity cannot be faked
 * without capital. Pools below the floor can never pass eligibility (which
 * requires far more quote liquidity), so skipping their transfer-log and
 * simulation spend loses nothing alertable (2026-07-14 getLogs incident).
 */
function bandPoolCondition(band: FdvBandCriteria, minQuoteLiquidityUsd = 0) {
  const liquidityFloor =
    minQuoteLiquidityUsd > 0
      ? sql` and s.quote_liquidity_usd is not null
      and s.quote_liquidity_usd >= ${minQuoteLiquidityUsd}`
      : sql``;
  return sql`exists (
    select 1 from pool_snapshots s
    where s.chain_id = ${pools.chainId}
      and s.pool_address = ${pools.poolAddress}
      and s.id = (
        select max(s2.id) from pool_snapshots s2
        where s2.chain_id = ${pools.chainId}
          and s2.pool_address = ${pools.poolAddress}
      )
      and s.estimated_fdv_usd is not null
      and s.estimated_fdv_usd >= ${band.minFdvUsd}
      and s.estimated_fdv_usd <= ${band.maxFdvUsd}${liquidityFloor}
  )`;
}

/**
 * SQL condition: the pool's base token has no holder snapshot at/after
 * `staleBefore`. The Date is serialized explicitly — a raw `sql` fragment
 * has no column type to map through, and the production postgres.js driver
 * rejects bare Date params there (crash-looped live 2026-07-12; the PGlite
 * test harness tolerates them, so tests cannot catch this).
 */
function holderSnapshotStaleCondition(staleBefore: Date) {
  const fresh = sql`
    select 1 from token_holder_snapshots h
    where h.chain_id = ${pools.chainId}
      and h.token_address = ${pools.baseTokenAddress}
      and h.captured_at >= ${staleBefore.toISOString()}
  `;
  return sql`not exists (${fresh})`;
}

/**
 * Band lane for the holders pass: trusted-quote pools valued inside the band
 * whose base token's holder snapshot is missing or stale. Newest-created
 * first — fresh band entrants are the most alert-relevant. Always bounded.
 * `minQuoteLiquidityUsd` > 0 additionally requires that much quote-side
 * liquidity on the latest snapshot (see {@link bandPoolCondition}).
 */
export async function listBandTrustedQuotePoolsNeedingHolders(
  db: Db,
  chainId: number,
  band: FdvBandCriteria,
  staleBefore: Date,
  limit: number,
  minQuoteLiquidityUsd = 0
): Promise<PoolRow[]> {
  return db
    .select()
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        isNotNull(pools.quoteTokenAddress),
        isNotNull(pools.baseTokenAddress),
        bandPoolCondition(band, minQuoteLiquidityUsd),
        holderSnapshotStaleCondition(staleBefore)
      )
    )
    .orderBy(desc(pools.createdAtBlock), desc(pools.createdLogIndex))
    .limit(limit);
}

/**
 * Backlog lane for the holders pass: young pools (pre-band warmup) with a
 * missing/stale holder snapshot, newest first, bounded. Runs strictly after
 * the band lane so it can never starve it.
 */
export async function listYoungTrustedQuotePoolsNeedingHolders(
  db: Db,
  chainId: number,
  minCreatedBlock: bigint,
  staleBefore: Date,
  limit: number
): Promise<PoolRow[]> {
  return db
    .select()
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        isNotNull(pools.quoteTokenAddress),
        isNotNull(pools.baseTokenAddress),
        gte(pools.createdAtBlock, minCreatedBlock),
        holderSnapshotStaleCondition(staleBefore)
      )
    )
    .orderBy(desc(pools.createdAtBlock), desc(pools.createdLogIndex))
    .limit(limit);
}

/**
 * Band lane for the risk pass: band-valued trusted-quote pools whose latest
 * risk verdict is missing or older than `staleBefore`. Newest-created first,
 * bounded. The staleness-swept remainder goes through
 * {@link listTrustedQuotePoolsNeedingRisk} as the backlog lane.
 * `minQuoteLiquidityUsd` > 0 additionally requires that much quote-side
 * liquidity on the latest snapshot (see {@link bandPoolCondition}).
 */
export async function listBandTrustedQuotePoolsNeedingRisk(
  db: Db,
  chainId: number,
  band: FdvBandCriteria,
  staleBefore: Date,
  limit: number,
  minQuoteLiquidityUsd = 0
): Promise<PoolRow[]> {
  const recent = db
    .select({ one: sql`1` })
    .from(tokenRisks)
    .where(
      and(
        eq(tokenRisks.chainId, pools.chainId),
        eq(tokenRisks.poolAddress, pools.poolAddress),
        gte(tokenRisks.assessedAt, staleBefore)
      )
    );
  return db
    .select()
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        isNotNull(pools.quoteTokenAddress),
        isNotNull(pools.baseTokenAddress),
        bandPoolCondition(band, minQuoteLiquidityUsd),
        notExists(recent)
      )
    )
    .orderBy(desc(pools.createdAtBlock), desc(pools.createdLogIndex))
    .limit(limit);
}

/**
 * Scoring selection: trusted-quote pools currently valued inside the band.
 * Everything outside classifies GRAY by construction, so scoring never needs
 * the full active set (2026-07-12 audit: sweeping it made a scoring pass
 * take >20min against a 60s target cadence).
 */
export async function listBandTrustedQuotePools(
  db: Db,
  chainId: number,
  band: FdvBandCriteria,
  limit?: number
): Promise<PoolRow[]> {
  const query = db
    .select()
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        isNotNull(pools.quoteTokenAddress),
        bandPoolCondition(band)
      )
    )
    .orderBy(desc(pools.createdAtBlock), desc(pools.createdLogIndex));
  return limit === undefined ? query : query.limit(limit);
}

/**
 * The activity refresh lane: active-set trusted-quote pools created on-chain
 * no later than `blockNumber` whose latest `pool_activity_snapshots` row is
 * older than `staleBefore` (or that have none at all), stalest first,
 * limited. Follows the `listTrustedQuotePoolsNeedingRisk` /
 * `listIdleTrustedQuotePoolsDue` query shape. Decays rolling buyer windows
 * for pools that are still in the active set (young or watch-band) but
 * stopped trading, so a snapshot never freezes at its last-observed values.
 */
export async function listActiveTrustedQuotePoolsNeedingActivityRefresh(
  db: Db,
  chainId: number,
  blockNumber: bigint,
  criteria: ActivePoolCriteria,
  staleBefore: Date,
  limit: number
): Promise<PoolRow[]> {
  const fresh = db
    .select({ one: sql`1` })
    .from(poolActivitySnapshots)
    .where(
      and(
        eq(poolActivitySnapshots.chainId, pools.chainId),
        eq(poolActivitySnapshots.poolAddress, pools.poolAddress),
        gte(poolActivitySnapshots.capturedAt, staleBefore)
      )
    );
  return db
    .select()
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        isNotNull(pools.quoteTokenAddress),
        lte(pools.createdAtBlock, blockNumber),
        activePoolCondition(criteria),
        notExists(fresh)
      )
    )
    .orderBy(
      sql`(
        select max(s.captured_at) from pool_activity_snapshots s
        where s.chain_id = ${pools.chainId}
          and s.pool_address = ${pools.poolAddress}
      ) asc nulls first`
    )
    .limit(limit);
}
