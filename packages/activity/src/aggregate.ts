import type {
  PoolActivitySnapshotInsert,
  PoolRow,
  PoolSwapEventRow
} from "@assay/database";

import {
  computeBuySizeEntropyBps,
  computeBuySizeGiniBps,
  computeRepeatedSizeBuyPctBps,
  type BuyShapeEvent
} from "./buy-shape.js";

const TWENTY_MINUTES_MS = 20 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
/**
 * The widest rolling window any snapshot metric reads. Callers fetching
 * events for `buildActivitySnapshot` need exactly this much history and no
 * more — loading a pool's full swap history is the population-scaling bug
 * that stalled the activity loop in production (2026-07-11).
 */
export const ACTIVITY_MAX_WINDOW_MS: number = ONE_HOUR_MS;

interface WindowMetrics {
  readonly uniqueBuyers: number;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly quoteBuyVolumeRaw: bigint;
  readonly quoteSellVolumeRaw: bigint;
  readonly buyEvents: readonly BuyShapeEvent[];
}

function metricsForWindow(
  events: readonly PoolSwapEventRow[],
  capturedAt: Date,
  windowMs: number
): WindowMetrics {
  const cutoffMs = capturedAt.getTime() - windowMs;
  const buyers = new Set<string>();
  const buyEvents: BuyShapeEvent[] = [];
  let buyCount = 0;
  let sellCount = 0;
  let quoteBuyVolumeRaw = 0n;
  let quoteSellVolumeRaw = 0n;

  for (const event of events) {
    const observedMs = event.observedAt.getTime();
    if (observedMs < cutoffMs || observedMs > capturedAt.getTime()) continue;
    if (event.side === "BUY") {
      buyCount += 1;
      const buyer = event.recipient.toLowerCase();
      const quoteAmountRaw = BigInt(event.quoteAmountRaw);
      buyers.add(buyer);
      buyEvents.push({ buyer, quoteAmountRaw });
      quoteBuyVolumeRaw += quoteAmountRaw;
    } else if (event.side === "SELL") {
      sellCount += 1;
      quoteSellVolumeRaw += BigInt(event.quoteAmountRaw);
    }
  }

  return {
    uniqueBuyers: buyers.size,
    buyCount,
    sellCount,
    quoteBuyVolumeRaw,
    quoteSellVolumeRaw,
    buyEvents
  };
}

export function buildActivitySnapshot(
  pool: PoolRow,
  blockNumber: bigint,
  events: readonly PoolSwapEventRow[],
  capturedAt: Date
): PoolActivitySnapshotInsert {
  const twentyMinute = metricsForWindow(events, capturedAt, TWENTY_MINUTES_MS);
  const oneHour = metricsForWindow(events, capturedAt, ONE_HOUR_MS);

  return {
    chainId: pool.chainId,
    poolAddress: pool.poolAddress,
    blockNumber,
    capturedAt,
    uniqueBuyers20m: twentyMinute.uniqueBuyers,
    uniqueBuyers1h: oneHour.uniqueBuyers,
    buyCount20m: twentyMinute.buyCount,
    sellCount20m: twentyMinute.sellCount,
    quoteBuyVolumeRaw20m: twentyMinute.quoteBuyVolumeRaw.toString(),
    quoteSellVolumeRaw20m: twentyMinute.quoteSellVolumeRaw.toString(),
    quoteBuyVolumeRaw1h: oneHour.quoteBuyVolumeRaw.toString(),
    quoteSellVolumeRaw1h: oneHour.quoteSellVolumeRaw.toString(),
    buySizeGiniBps: computeBuySizeGiniBps(oneHour.buyEvents),
    buySizeEntropyBps: computeBuySizeEntropyBps(oneHour.buyEvents),
    repeatedSizeBuyPctBps: computeRepeatedSizeBuyPctBps(oneHour.buyEvents)
  };
}
