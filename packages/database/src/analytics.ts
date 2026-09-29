/**
 * Read-only SQL aggregations for the analytics dashboard. Every function is
 * a pure query over existing tables: no writes, no derived-state caching.
 * Aggregation happens SQL-side; TS only folds already-small result sets.
 *
 * Cross-driver rule (see repositories.ts:999): only primitives (number,
 * string, boolean) may be interpolated into `sql` fragments. Dates are
 * rendered to strings SQL-side via to_char so PGlite (tests) and
 * postgres-js (production) return identical JSON-safe payloads; no `Date`
 * and no `bigint` ever leaves this module.
 */
import { and, desc, eq, sql } from "drizzle-orm";

import type { Db } from "./client.js";
import {
  alertsSent,
  judgmentBriefs,
  pools,
  tokenEligibilityResults,
  tokenOutcomes,
  tokenPerformance,
  tokens
} from "./schema.js";

/**
 * Numeric entry-time feature keys available for quartile analysis.
 *
 * Deliberately duplicated from apps/worker/src/calibrate.ts
 * (CALIBRATION_CONFIG.featureKeys); packages must never import from apps.
 * Keep the two lists in sync by hand; calibrate.ts carries the matching
 * cross-reference comment.
 */
export const ANALYTICS_FEATURE_KEYS = [
  "quoteLiquidityUsd",
  "totalLiquidityUsd",
  "ageMinutesAtEntry",
  "uniqueBuyers1h",
  "buySizeGiniBps",
  "buySizeEntropyBps",
  "repeatedSizeBuyPctBps",
  "floatBps",
  "supplyInPoolBps",
  "adjustedTop10PctBps",
  "deployerPctBps",
  "adjustedHolderCount",
  "effectiveSellLossBps"
] as const;

export type AnalyticsFeatureKey = (typeof ANALYTICS_FEATURE_KEYS)[number];

/**
 * How long after band entry a score still counts as "known at entry" for
 * the precision curve. Single source of truth; widen here (and note it in
 * the dashboard caption) if the scoring loop's cadence proves 15 minutes
 * unrealistically tight against production data.
 */
export const ANALYTICS_SCORE_AS_OF_GRACE_MINUTES = 15;

/** Score floors evaluated by the precision curve; 0 = all-scored baseline. */
export const PRECISION_SCORE_FLOORS = [
  0, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95
] as const;

/** Realized-outcome horizon used by the recent-alerts panel. */
export const ANALYTICS_REALIZED_HORIZON_HOURS = 72;

const MULTIPLE_2X_BPS = 20_000;
const MULTIPLE_5X_BPS = 50_000;
const MULTIPLE_10X_BPS = 100_000;

export interface FunnelSummary {
  pools: number;
  trustedQuotePools: number;
  bandEntrantPools: number;
  eligibleTokens: number;
  alertedTokens: { RED: number; YELLOW: number; GREEN: number };
}

/**
 * Pipeline funnel: discovered pools → trusted-quote pools → band entrants →
 * ever-eligible tokens → ever-alerted tokens per level.
 *
 * Caveat: stages come from different tables with different grains (pools
 * vs. distinct tokens), so this is a narrative funnel, not a strict
 * subset chain; a token alerted twice at one level still counts once.
 */
export async function getFunnelSummary(
  db: Db,
  chainId: number
): Promise<FunnelSummary> {
  const [poolCounts] = await db
    .select({
      pools: sql`count(*)`.mapWith(Number),
      trustedQuotePools: sql`count(*) filter (where ${pools.quoteTokenAddress} is not null)`.mapWith(
        Number
      )
    })
    .from(pools)
    .where(eq(pools.chainId, chainId));

  const [bandEntrants] = await db
    .select({
      n: sql`count(distinct ${tokenPerformance.poolAddress})`.mapWith(Number)
    })
    .from(tokenPerformance)
    .where(eq(tokenPerformance.chainId, chainId));

  const [eligible] = await db
    .select({
      n: sql`count(distinct ${tokenEligibilityResults.tokenAddress})`.mapWith(
        Number
      )
    })
    .from(tokenEligibilityResults)
    .where(
      and(
        eq(tokenEligibilityResults.chainId, chainId),
        eq(tokenEligibilityResults.eligible, true)
      )
    );

  const alertRows = await db
    .select({
      alertLevel: alertsSent.alertLevel,
      n: sql`count(distinct ${alertsSent.tokenAddress})`.mapWith(Number)
    })
    .from(alertsSent)
    .where(eq(alertsSent.chainId, chainId))
    .groupBy(alertsSent.alertLevel);

  const alertedTokens = { RED: 0, YELLOW: 0, GREEN: 0 };
  for (const row of alertRows) {
    if (row.alertLevel === "RED") alertedTokens.RED = row.n;
    else if (row.alertLevel === "YELLOW") alertedTokens.YELLOW = row.n;
    else if (row.alertLevel === "GREEN") alertedTokens.GREEN = row.n;
  }

  return {
    pools: poolCounts?.pools ?? 0,
    trustedQuotePools: poolCounts?.trustedQuotePools ?? 0,
    bandEntrantPools: bandEntrants?.n ?? 0,
    eligibleTokens: eligible?.n ?? 0,
    alertedTokens
  };
}

export interface LaunchCadencePoint {
  day: string;
  pools: number;
  trustedQuotePools: number;
}

/**
 * Pools discovered per day over the trailing `days` window, with the
 * trusted-quote subset.
 *
 * Caveat: bucketed by `discovered_at` (when the scanner saw the pool), not
 * on-chain creation time; a backfill shows up as a discovery-day spike.
 */
export async function getLaunchCadence(
  db: Db,
  chainId: number,
  days: number
): Promise<LaunchCadencePoint[]> {
  const boundedDays = Math.max(1, Math.trunc(days));
  return db
    .select({
      day: sql`to_char(date_trunc('day', ${pools.discoveredAt}), 'YYYY-MM-DD')`.mapWith(
        String
      ),
      pools: sql`count(*)`.mapWith(Number),
      trustedQuotePools: sql`count(*) filter (where ${pools.quoteTokenAddress} is not null)`.mapWith(
        Number
      )
    })
    .from(pools)
    .where(
      and(
        eq(pools.chainId, chainId),
        sql`${pools.discoveredAt} >= now() - make_interval(days => ${boundedDays}::int)`
      )
    )
    .groupBy(sql`date_trunc('day', ${pools.discoveredAt})`)
    .orderBy(sql`date_trunc('day', ${pools.discoveredAt})`);
}

export interface ScoreOutcomePair {
  score: number;
  maxMultipleBps: number;
}

export interface PrecisionPoint {
  floor: number;
  n: number;
  share2x: number;
  share5x: number;
  share10x: number;
}

export interface PrecisionCurve {
  horizonHours: number;
  scored: number;
  unscored: number;
  points: PrecisionPoint[];
}

/**
 * Pure fold of (as-of score, realized multiple) pairs into per-floor hit
 * shares. Shares are fractions 0..1; a floor with n = 0 reports all shares
 * as 0, never NaN. Exported for direct unit testing (calibrate.ts
 * precedent: fetch rows, pure-function the math).
 */
export function foldPrecisionCurve(
  pairs: readonly ScoreOutcomePair[],
  floors: readonly number[]
): PrecisionPoint[] {
  return floors.map((floor) => {
    let n = 0;
    let hit2x = 0;
    let hit5x = 0;
    let hit10x = 0;
    for (const pair of pairs) {
      if (pair.score < floor) continue;
      n += 1;
      if (pair.maxMultipleBps >= MULTIPLE_2X_BPS) hit2x += 1;
      if (pair.maxMultipleBps >= MULTIPLE_5X_BPS) hit5x += 1;
      if (pair.maxMultipleBps >= MULTIPLE_10X_BPS) hit10x += 1;
    }
    return {
      floor,
      n,
      share2x: n === 0 ? 0 : hit2x / n,
      share5x: n === 0 ? 0 : hit5x / n,
      share10x: n === 0 ? 0 : hit10x / n
    };
  });
}

/**
 * Score → realized-outcome precision curve over the full band-entrant
 * population (`token_performance`), NOT conditioned on alerts.
 *
 * The "as-of" score is the latest `token_score_results.score` known at most
 * {@link ANALYTICS_SCORE_AS_OF_GRACE_MINUTES} minutes after band entry;
 * rows without one count into `unscored` and are excluded from the curve.
 */
export async function getScorePrecision(
  db: Db,
  chainId: number,
  horizonHours: number
): Promise<PrecisionCurve> {
  const horizon = Math.trunc(horizonHours);
  // Correlated columns are literal qualified identifiers on purpose:
  // Drizzle strips table qualification from columns interpolated into the
  // SELECT projection of a join-free query, which would let the subquery's
  // own chain_id/token_address shadow the correlation into a tautology
  // (verified against drizzle-orm 0.36 via toSQL()). The outer FROM renders
  // unaliased, so the literal table name is deterministic.
  const asOfScore = sql`(
    select s.score from token_score_results s
    where s.chain_id = token_performance.chain_id
      and s.token_address = token_performance.token_address
      and s.scored_at <= token_performance.entered_at
        + make_interval(mins => ${ANALYTICS_SCORE_AS_OF_GRACE_MINUTES}::int)
    order by s.scored_at desc, s.id desc
    limit 1
  )`.mapWith(Number);

  const rows = await db
    .select({
      score: asOfScore,
      maxMultipleBps: tokenPerformance.maxMultipleBps
    })
    .from(tokenPerformance)
    .where(
      and(
        eq(tokenPerformance.chainId, chainId),
        eq(tokenPerformance.horizonHours, horizon)
      )
    );

  const pairs: ScoreOutcomePair[] = [];
  for (const row of rows) {
    if (row.score === null) continue;
    pairs.push({ score: row.score, maxMultipleBps: row.maxMultipleBps });
  }

  return {
    horizonHours: horizon,
    scored: pairs.length,
    unscored: rows.length - pairs.length,
    points: foldPrecisionCurve(pairs, PRECISION_SCORE_FLOORS)
  };
}

export interface FeatureQuartileBucket {
  bucket: 1 | 2 | 3 | 4;
  n: number;
  minValue: number;
  maxValue: number;
  medianMultipleBps: number;
  share5x: number;
}

export interface FeatureQuartiles {
  feature: AnalyticsFeatureKey;
  horizonHours: number;
  nullRows: number;
  buckets: FeatureQuartileBucket[];
}

/**
 * Realized outcomes bucketed by quartile of one entry-time feature over the
 * band-entrant population at `horizonHours`.
 *
 * Caveat: entry-feature coverage varies wildly by feature (many are null
 * for most rows; the 2026-07-20 rebuild demoted them for exactly that
 * reason). Rows whose feature is missing or non-numeric are reported in
 * `nullRows` and excluded from every bucket; quartile cuts are over the
 * numeric subset only.
 */
export async function getFeatureQuartiles(
  db: Db,
  chainId: number,
  horizonHours: number,
  feature: AnalyticsFeatureKey
): Promise<FeatureQuartiles> {
  const horizon = Math.trunc(horizonHours);
  const q = db
    .select({
      value: sql`((${tokenPerformance.entryFeatures}->>${feature})::float8)`.as(
        "value"
      ),
      bucket: sql`ntile(4) over (order by ((${tokenPerformance.entryFeatures}->>${feature})::float8))`.as(
        "bucket"
      ),
      multipleBps: tokenPerformance.maxMultipleBps
    })
    .from(tokenPerformance)
    .where(
      and(
        eq(tokenPerformance.chainId, chainId),
        eq(tokenPerformance.horizonHours, horizon),
        sql`${tokenPerformance.entryFeatures}->>${feature} is not null`,
        sql`${tokenPerformance.entryFeatures}->>${feature} ~ '^-?[0-9.]+$'`
      )
    )
    .as("q");

  const bucketRows = await db
    .select({
      bucket: sql`${q.bucket}`.mapWith(Number),
      n: sql`count(*)`.mapWith(Number),
      minValue: sql`min(${q.value})`.mapWith(Number),
      maxValue: sql`max(${q.value})`.mapWith(Number),
      medianMultipleBps: sql`percentile_cont(0.5) within group (order by ${q.multipleBps})`.mapWith(
        Number
      ),
      share5x: sql`avg((${q.multipleBps} >= ${MULTIPLE_5X_BPS})::int)::float8`.mapWith(
        Number
      )
    })
    .from(q)
    .groupBy(q.bucket)
    .orderBy(q.bucket);

  const [totals] = await db
    .select({ n: sql`count(*)`.mapWith(Number) })
    .from(tokenPerformance)
    .where(
      and(
        eq(tokenPerformance.chainId, chainId),
        eq(tokenPerformance.horizonHours, horizon)
      )
    );

  const buckets: FeatureQuartileBucket[] = bucketRows
    .filter((row) => row.bucket >= 1 && row.bucket <= 4)
    .map((row) => ({
      bucket: row.bucket as 1 | 2 | 3 | 4,
      n: row.n,
      minValue: row.minValue,
      maxValue: row.maxValue,
      medianMultipleBps: row.medianMultipleBps,
      share5x: row.share5x
    }));

  const quartiled = buckets.reduce((sum, bucket) => sum + bucket.n, 0);
  return {
    feature,
    horizonHours: horizon,
    nullRows: (totals?.n ?? 0) - quartiled,
    buckets
  };
}

export interface SurvivalPoint {
  horizonHours: number;
  survived: number;
  died: number;
}

/**
 * SURVIVED/DIED label counts per horizon from `token_outcomes`.
 *
 * Caveat: labels are append-once per (pool, horizon) and only exist once
 * observed history reaches the horizon; recent pools are absent, so this
 * lags reality by up to the longest horizon.
 */
export async function getSurvivalByHorizon(
  db: Db,
  chainId: number
): Promise<SurvivalPoint[]> {
  return db
    .select({
      horizonHours: tokenOutcomes.horizonHours,
      survived: sql`count(*) filter (where ${tokenOutcomes.outcome} = 'SURVIVED')`.mapWith(
        Number
      ),
      died: sql`count(*) filter (where ${tokenOutcomes.outcome} = 'DIED')`.mapWith(
        Number
      )
    })
    .from(tokenOutcomes)
    .where(eq(tokenOutcomes.chainId, chainId))
    .groupBy(tokenOutcomes.horizonHours)
    .orderBy(tokenOutcomes.horizonHours);
}

export interface RecentAlertRow {
  sentAt: string;
  alertLevel: string;
  score: number;
  tokenAddress: string;
  name: string | null;
  symbol: string | null;
  delivered: boolean;
  transport: string;
  maxMultipleBps: number | null;
  maxDrawdownBps: number | null;
}

/**
 * Most recent alerts (newest first, `limit` clamped to 1..200) joined with
 * token metadata and the realized {@link ANALYTICS_REALIZED_HORIZON_HOURS}h
 * outcome where a performance label exists.
 *
 * Caveat: realized columns are null until the token's entry-to-horizon
 * window has elapsed and been labeled; null means "unlabeled", not "flat".
 * Token name/symbol are adversarial input; render as text only.
 */
export async function getRecentAlertOutcomes(
  db: Db,
  chainId: number,
  limit: number
): Promise<RecentAlertRow[]> {
  const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const realizedMultiple = sql`(
    select p.max_multiple_bps from token_performance p
    where p.chain_id = alerts_sent.chain_id
      and p.token_address = alerts_sent.token_address
      and p.horizon_hours = ${ANALYTICS_REALIZED_HORIZON_HOURS}
    order by p.entered_at desc, p.id desc
    limit 1
  )`.mapWith(Number);
  const realizedDrawdown = sql`(
    select p.max_drawdown_bps from token_performance p
    where p.chain_id = alerts_sent.chain_id
      and p.token_address = alerts_sent.token_address
      and p.horizon_hours = ${ANALYTICS_REALIZED_HORIZON_HOURS}
    order by p.entered_at desc, p.id desc
    limit 1
  )`.mapWith(Number);

  return db
    .select({
      sentAt: sql`to_char(${alertsSent.sentAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.mapWith(
        String
      ),
      alertLevel: alertsSent.alertLevel,
      score: alertsSent.score,
      tokenAddress: alertsSent.tokenAddress,
      name: tokens.name,
      symbol: tokens.symbol,
      delivered: alertsSent.delivered,
      transport: alertsSent.transport,
      maxMultipleBps: realizedMultiple,
      maxDrawdownBps: realizedDrawdown
    })
    .from(alertsSent)
    .leftJoin(
      tokens,
      and(
        eq(tokens.chainId, alertsSent.chainId),
        eq(tokens.address, alertsSent.tokenAddress)
      )
    )
    .where(eq(alertsSent.chainId, chainId))
    .orderBy(desc(alertsSent.sentAt), desc(alertsSent.id))
    .limit(boundedLimit);
}

export interface JudgmentVersionSummary {
  promptVersion: number;
  completed: number;
  rejectedFabricated: number;
  failed: number;
  avgConfidenceBps: number | null;
}

export interface JudgmentWeekPoint {
  week: string;
  completed: number;
  rejectedFabricated: number;
  failed: number;
}

export interface JudgmentQuality {
  versions: JudgmentVersionSummary[];
  weekly: JudgmentWeekPoint[];
}

/**
 * Judgment-brief quality: status mix per prompt version and per ISO week.
 *
 * Caveat: LIVE briefs only; REPLAY rows are evaluation reruns and would
 * double-count. `avgConfidenceBps` averages COMPLETED briefs only and is
 * null for versions with none.
 */
export async function getJudgmentQuality(
  db: Db,
  chainId: number
): Promise<JudgmentQuality> {
  const liveOnly = and(
    eq(judgmentBriefs.chainId, chainId),
    eq(judgmentBriefs.mode, "LIVE")
  );

  const versions = await db
    .select({
      promptVersion: judgmentBriefs.promptVersion,
      completed: sql`count(*) filter (where ${judgmentBriefs.status} = 'COMPLETED')`.mapWith(
        Number
      ),
      rejectedFabricated: sql`count(*) filter (where ${judgmentBriefs.status} = 'REJECTED_FABRICATED_CITATION')`.mapWith(
        Number
      ),
      failed: sql`count(*) filter (where ${judgmentBriefs.status} = 'FAILED')`.mapWith(
        Number
      ),
      avgConfidenceBps: sql`avg(${judgmentBriefs.confidenceBps}) filter (where ${judgmentBriefs.status} = 'COMPLETED')`.mapWith(
        Number
      )
    })
    .from(judgmentBriefs)
    .where(liveOnly)
    .groupBy(judgmentBriefs.promptVersion)
    .orderBy(judgmentBriefs.promptVersion);

  const weekly = await db
    .select({
      week: sql`to_char(date_trunc('week', ${judgmentBriefs.createdAt}), 'YYYY-MM-DD')`.mapWith(
        String
      ),
      completed: sql`count(*) filter (where ${judgmentBriefs.status} = 'COMPLETED')`.mapWith(
        Number
      ),
      rejectedFabricated: sql`count(*) filter (where ${judgmentBriefs.status} = 'REJECTED_FABRICATED_CITATION')`.mapWith(
        Number
      ),
      failed: sql`count(*) filter (where ${judgmentBriefs.status} = 'FAILED')`.mapWith(
        Number
      )
    })
    .from(judgmentBriefs)
    .where(liveOnly)
    .groupBy(sql`date_trunc('week', ${judgmentBriefs.createdAt})`)
    .orderBy(sql`date_trunc('week', ${judgmentBriefs.createdAt})`);

  return { versions, weekly };
}
