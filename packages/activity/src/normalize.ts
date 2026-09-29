import type { PoolSwapEventInsert } from "@assay/database";

import type { DecodedSwapEvent } from "./decode.js";

export type SwapSide = "BUY" | "SELL" | "UNKNOWN";

export interface NormalizedSwapEvent {
  readonly chainId: number;
  readonly poolAddress: string;
  readonly factoryKind: string;
  readonly blockNumber: bigint;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly sender: string;
  readonly recipient: string;
  readonly token0AmountRaw: bigint;
  readonly token1AmountRaw: bigint;
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
  readonly side: SwapSide;
  readonly quoteTokenAddress: string;
  readonly baseTokenAddress: string;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function classifySide(baseDeltaRaw: bigint, quoteDeltaRaw: bigint): SwapSide {
  if (baseDeltaRaw < 0n && quoteDeltaRaw > 0n) return "BUY";
  if (baseDeltaRaw > 0n && quoteDeltaRaw < 0n) return "SELL";
  return "UNKNOWN";
}

/**
 * Normalize token direction for a trusted-quote pool. Returns null when the
 * pool has no trusted quote/base side, so activity ingestion can skip it
 * instead of inferring legitimacy from symbols.
 */
export function normalizeSwapEvent(
  event: DecodedSwapEvent
): NormalizedSwapEvent | null {
  const { pool } = event;
  if (pool.quoteTokenAddress === null || pool.baseTokenAddress === null) {
    return null;
  }

  const baseDeltaRaw =
    pool.baseTokenAddress === pool.token0Address
      ? event.token0DeltaRaw
      : event.token1DeltaRaw;
  const quoteDeltaRaw =
    pool.quoteTokenAddress === pool.token0Address
      ? event.token0DeltaRaw
      : event.token1DeltaRaw;

  return {
    chainId: pool.chainId,
    poolAddress: pool.poolAddress,
    factoryKind: pool.factoryKind,
    blockNumber: event.blockNumber,
    transactionHash: event.transactionHash,
    logIndex: event.logIndex,
    sender: event.sender,
    recipient: event.recipient,
    token0AmountRaw: event.token0DeltaRaw,
    token1AmountRaw: event.token1DeltaRaw,
    baseAmountRaw: abs(baseDeltaRaw),
    quoteAmountRaw: abs(quoteDeltaRaw),
    side: classifySide(baseDeltaRaw, quoteDeltaRaw),
    quoteTokenAddress: pool.quoteTokenAddress,
    baseTokenAddress: pool.baseTokenAddress
  };
}

export function toPoolSwapEventInsert(
  event: NormalizedSwapEvent,
  observedAt?: Date
): PoolSwapEventInsert {
  return {
    chainId: event.chainId,
    poolAddress: event.poolAddress,
    factoryKind: event.factoryKind,
    blockNumber: event.blockNumber,
    transactionHash: event.transactionHash,
    logIndex: event.logIndex,
    sender: event.sender,
    recipient: event.recipient,
    token0AmountRaw: event.token0AmountRaw.toString(),
    token1AmountRaw: event.token1AmountRaw.toString(),
    baseAmountRaw: event.baseAmountRaw.toString(),
    quoteAmountRaw: event.quoteAmountRaw.toString(),
    side: event.side,
    quoteTokenAddress: event.quoteTokenAddress,
    baseTokenAddress: event.baseTokenAddress,
    ...(observedAt === undefined ? {} : { observedAt })
  };
}
