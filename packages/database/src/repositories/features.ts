import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lte,
  ne,
} from "drizzle-orm";
import type { Db } from "../client.js";
import {
  poolActivitySnapshots,
  poolSnapshots,
  poolSwapEvents,
  pools,
  tokenHolders,
  tokenOutcomes,
  tokens,
  tradeSimulations
} from "../schema.js";
import { chunked, ADDRESS_CHUNK_SIZE } from "./shared.js";
import { getLatestActivitySnapshot } from "./snapshots.js";

export interface LiquidityTrajectory {
  readonly peakQuoteLiquidityUsd: string;
  readonly latestQuoteLiquidityUsd: string;
  readonly drawdownBps: number;
  readonly minutesAbove80PctPeak: number;
  readonly snapshotCount: number;
  readonly firstCapturedAt: Date;
}

/**
 * Liquidity trajectory across a pool's `pool_snapshots` history: peak,
 * current drawdown from that peak, and minutes spent at/above 80% of peak.
 *
 * `minutesAbove80PctPeak` sums the wall-clock gap between each consecutive
 * pair of valued snapshots whose EARLIER endpoint sat at or above 80% of the
 * eventual peak — every gap is attributed to the liquidity level actually
 * observed going into it (forward-only; never interpolated or inferred from
 * a later snapshot). The open-ended gap after the final snapshot has no
 * known duration yet and contributes nothing.
 *
 * Snapshots with a null `quoteLiquidityUsd` (a `nullReason` was recorded)
 * are excluded from the peak/drawdown/duration math but still count toward
 * `snapshotCount`. Returns undefined when the pool has no snapshots at all,
 * or none with a usable liquidity value.
 */
export async function getLiquidityTrajectory(
  db: Db,
  chainId: number,
  poolAddress: string
): Promise<LiquidityTrajectory | undefined> {
  const rows = await db
    .select({
      capturedAt: poolSnapshots.capturedAt,
      quoteLiquidityUsd: poolSnapshots.quoteLiquidityUsd
    })
    .from(poolSnapshots)
    .where(
      and(
        eq(poolSnapshots.chainId, chainId),
        eq(poolSnapshots.poolAddress, poolAddress)
      )
    )
    .orderBy(poolSnapshots.capturedAt, poolSnapshots.id);
  if (rows.length === 0) return undefined;

  const valued = rows
    .filter(
      (row): row is { capturedAt: Date; quoteLiquidityUsd: string } =>
        row.quoteLiquidityUsd !== null
    )
    .map((row) => ({
      capturedAt: row.capturedAt,
      raw: row.quoteLiquidityUsd,
      value: Number(row.quoteLiquidityUsd)
    }));
  if (valued.length === 0) return undefined;

  let peak = valued[0]!;
  for (const row of valued) {
    if (row.value > peak.value) peak = row;
  }
  const latest = valued[valued.length - 1]!;
  const drawdownBps =
    peak.value <= 0
      ? 0
      : Math.round(((peak.value - latest.value) / peak.value) * 10000);

  const threshold = peak.value * 0.8;
  let minutesAbove80PctPeak = 0;
  for (let i = 0; i < valued.length - 1; i++) {
    const current = valued[i]!;
    const next = valued[i + 1]!;
    if (current.value >= threshold) {
      minutesAbove80PctPeak +=
        (next.capturedAt.getTime() - current.capturedAt.getTime()) / 60_000;
    }
  }

  return {
    peakQuoteLiquidityUsd: peak.raw,
    latestQuoteLiquidityUsd: latest.raw,
    drawdownBps,
    minutesAbove80PctPeak,
    snapshotCount: rows.length,
    firstCapturedAt: rows[0]!.capturedAt
  };
}

export interface SimulationRegression {
  readonly latestStatus: string;
  readonly priorPassCount: number;
  readonly regressed: boolean;
}

/**
 * Whether the most recent trade simulation for a token regressed relative
 * to simulation history: an earlier PASS exists but the latest run is FAIL.
 */
export async function getSimulationRegression(
  db: Db,
  chainId: number,
  tokenAddress: string
): Promise<SimulationRegression | undefined> {
  const rows = await db
    .select({ status: tradeSimulations.status })
    .from(tradeSimulations)
    .where(
      and(
        eq(tradeSimulations.chainId, chainId),
        eq(tradeSimulations.tokenAddress, tokenAddress)
      )
    )
    .orderBy(tradeSimulations.simulatedAt, tradeSimulations.id);
  if (rows.length === 0) return undefined;

  const latestStatus = rows[rows.length - 1]!.status;
  const priorPassCount = rows
    .slice(0, -1)
    .filter((row) => row.status === "PASS").length;
  return {
    latestStatus,
    priorPassCount,
    regressed: priorPassCount > 0 && latestStatus === "FAIL"
  };
}

export interface EarlyBuyerRetention {
  readonly earlyBuyers: number;
  readonly stillHolding: number;
}

/**
 * Distinct BUY recipients within `windowMinutes` of the pool's first stored
 * swap, and how many of those addresses still hold a positive balance of
 * `tokenAddress`. Undefined when the pool has no stored swaps.
 */
export async function getEarlyBuyerRetention(
  db: Db,
  chainId: number,
  poolAddress: string,
  tokenAddress: string,
  windowMinutes: number
): Promise<EarlyBuyerRetention | undefined> {
  const [first] = await db
    .select({ observedAt: poolSwapEvents.observedAt })
    .from(poolSwapEvents)
    .where(
      and(
        eq(poolSwapEvents.chainId, chainId),
        eq(poolSwapEvents.poolAddress, poolAddress)
      )
    )
    .orderBy(poolSwapEvents.observedAt, poolSwapEvents.id)
    .limit(1);
  if (first === undefined) return undefined;

  const windowEnd = new Date(
    first.observedAt.getTime() + windowMinutes * 60_000
  );
  const buyers = await db
    .selectDistinct({ recipient: poolSwapEvents.recipient })
    .from(poolSwapEvents)
    .where(
      and(
        eq(poolSwapEvents.chainId, chainId),
        eq(poolSwapEvents.poolAddress, poolAddress),
        eq(poolSwapEvents.side, "BUY"),
        gte(poolSwapEvents.observedAt, first.observedAt),
        lte(poolSwapEvents.observedAt, windowEnd)
      )
    );
  const earlyBuyers = buyers.length;
  if (earlyBuyers === 0) return { earlyBuyers: 0, stillHolding: 0 };

  const addresses = buyers.map((row) => row.recipient);
  // Chunked: a hot pool's early-buyer set is unbounded.
  const holders: { balanceRaw: string }[] = [];
  for (const batch of chunked(addresses, ADDRESS_CHUNK_SIZE)) {
    const rows = await db
      .select({ balanceRaw: tokenHolders.balanceRaw })
      .from(tokenHolders)
      .where(
        and(
          eq(tokenHolders.chainId, chainId),
          eq(tokenHolders.tokenAddress, tokenAddress),
          inArray(tokenHolders.holderAddress, batch)
        )
      );
    holders.push(...rows);
  }
  // Raw balances stay integer strings end-to-end; compare via bigint, never
  // a JS float, to avoid precision loss on uint256-scale values.
  const stillHolding = holders.filter(
    (row) => BigInt(row.balanceRaw) > 0n
  ).length;
  return { earlyBuyers, stillHolding };
}

export interface DeployerLaunchStats {
  readonly tokenCount: number;
  readonly survived: number;
  readonly died: number;
}

/**
 * Prior launch history for a deployer, excluding the candidate token itself.
 * `died` only counts tokens with a DIED outcome AND no SURVIVED outcome at
 * any horizon, so a token that eventually recovered never double-counts.
 */
export async function getDeployerLaunchStats(
  db: Db,
  chainId: number,
  deployerAddress: string,
  excludeTokenAddress: string
): Promise<DeployerLaunchStats> {
  const otherTokens = await db
    .select({ address: tokens.address })
    .from(tokens)
    .where(
      and(
        eq(tokens.chainId, chainId),
        eq(tokens.deployerAddress, deployerAddress),
        ne(tokens.address, excludeTokenAddress)
      )
    );
  const tokenCount = otherTokens.length;
  if (tokenCount === 0) return { tokenCount: 0, survived: 0, died: 0 };

  const addresses = otherTokens.map((row) => row.address);
  // Chunked: serial deployers can have an unbounded launch history.
  const outcomeRows: { tokenAddress: string; outcome: string }[] = [];
  for (const batch of chunked(addresses, ADDRESS_CHUNK_SIZE)) {
    const rows = await db
      .selectDistinct({
        tokenAddress: tokenOutcomes.tokenAddress,
        outcome: tokenOutcomes.outcome
      })
      .from(tokenOutcomes)
      .where(
        and(
          eq(tokenOutcomes.chainId, chainId),
          inArray(tokenOutcomes.tokenAddress, batch)
        )
      );
    outcomeRows.push(...rows);
  }

  const survivedTokens = new Set<string>();
  for (const row of outcomeRows) {
    if (row.outcome === "SURVIVED") survivedTokens.add(row.tokenAddress);
  }
  const diedTokens = new Set<string>();
  for (const row of outcomeRows) {
    if (row.outcome === "DIED" && !survivedTokens.has(row.tokenAddress)) {
      diedTokens.add(row.tokenAddress);
    }
  }

  return {
    tokenCount,
    survived: survivedTokens.size,
    died: diedTokens.size
  };
}

export interface CohortPercentiles {
  readonly cohortSize: number;
  readonly buyerPercentileBps: number;
  readonly netInflowPercentileBps: number;
}

/**
 * Same-chain, same-age-band peers (age in [0.5x, 2x] of `ageMinutes`, each
 * measured as its LATEST activity snapshot's `capturedAt` minus the pool's
 * `discoveredAt`), and where the candidate ranks among them on 1h unique
 * buyers and 1h net quote inflow. Percentile = share of peers with value
 * <= the candidate's, in bps. The candidate pool itself is excluded from
 * the cohort. Undefined when the candidate has no activity snapshot, or the
 * peer cohort is smaller than `minCohort`.
 *
 * Peers are restricted to pools whose latest snapshot is younger than
 * `freshnessMs` (default 60 minutes): the cohort compares LIVE pools, and —
 * just as important — the append-only snapshot table grows without bound,
 * so the latest-per-pool scan must stay anchored to a recent time window
 * (streaming the full table per candidate is what stalled the scoring pass
 * in production, 2026-07-11). DISTINCT ON + the age band run in SQL; only
 * the final cohort reaches the client.
 */
export async function getCohortPercentiles(
  db: Db,
  chainId: number,
  poolAddress: string,
  ageMinutes: number,
  minCohort: number,
  freshnessMs = 60 * 60 * 1000
): Promise<CohortPercentiles | undefined> {
  const candidate = await getLatestActivitySnapshot(db, chainId, poolAddress);
  if (candidate === undefined) return undefined;
  const candidateNetInflow =
    BigInt(candidate.quoteBuyVolumeRaw1h) -
    BigInt(candidate.quoteSellVolumeRaw1h);

  const freshCutoff = new Date(Date.now() - freshnessMs);
  const latest = await db
    .selectDistinctOn([poolActivitySnapshots.poolAddress], {
      poolAddress: poolActivitySnapshots.poolAddress,
      capturedAt: poolActivitySnapshots.capturedAt,
      uniqueBuyers1h: poolActivitySnapshots.uniqueBuyers1h,
      quoteBuyVolumeRaw1h: poolActivitySnapshots.quoteBuyVolumeRaw1h,
      quoteSellVolumeRaw1h: poolActivitySnapshots.quoteSellVolumeRaw1h,
      discoveredAt: pools.discoveredAt
    })
    .from(poolActivitySnapshots)
    .innerJoin(
      pools,
      and(
        eq(pools.chainId, poolActivitySnapshots.chainId),
        eq(pools.poolAddress, poolActivitySnapshots.poolAddress)
      )
    )
    .where(
      and(
        eq(poolActivitySnapshots.chainId, chainId),
        ne(poolActivitySnapshots.poolAddress, poolAddress),
        gte(poolActivitySnapshots.capturedAt, freshCutoff)
      )
    )
    .orderBy(
      poolActivitySnapshots.poolAddress,
      desc(poolActivitySnapshots.capturedAt),
      desc(poolActivitySnapshots.id)
    );

  const minAge = ageMinutes * 0.5;
  const maxAge = ageMinutes * 2;
  const cohort = latest.filter((row) => {
    const age = (row.capturedAt.getTime() - row.discoveredAt.getTime()) / 60_000;
    return age >= minAge && age <= maxAge;
  });

  const cohortSize = cohort.length;
  if (cohortSize < minCohort) return undefined;

  const buyersLte = cohort.filter(
    (row) => row.uniqueBuyers1h <= candidate.uniqueBuyers1h
  ).length;
  const inflowLte = cohort.filter((row) => {
    const inflow =
      BigInt(row.quoteBuyVolumeRaw1h) - BigInt(row.quoteSellVolumeRaw1h);
    return inflow <= candidateNetInflow;
  }).length;

  return {
    cohortSize,
    buyerPercentileBps: Math.round((buyersLte / cohortSize) * 10000),
    netInflowPercentileBps: Math.round((inflowLte / cohortSize) * 10000)
  };
}
