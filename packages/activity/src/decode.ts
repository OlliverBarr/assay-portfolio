import {
  decodeEventLog,
  getAddress,
  type Address,
  type Hex
} from "viem";

import {
  uniswapV2SwapEvent,
  uniswapV2SwapTopic,
  uniswapV3SwapEvent,
  uniswapV3SwapTopic,
  type RawFactoryLog
} from "@assay/chain";
import type { PoolRow } from "@assay/database";

import { SwapDecodeError } from "./errors.js";

export interface DecodedSwapEvent {
  readonly pool: PoolRow;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly sender: Address;
  readonly recipient: Address;
  /** Signed pool delta: positive entered pool, negative left pool. */
  readonly token0DeltaRaw: bigint;
  /** Signed pool delta: positive entered pool, negative left pool. */
  readonly token1DeltaRaw: bigint;
}

/** Decode one raw pool swap log without applying product-specific side logic. */
export function decodeSwapLog(log: RawFactoryLog, pool: PoolRow): DecodedSwapEvent {
  const topic0 = log.topics[0];
  const context = { blockNumber: log.blockNumber, logIndex: log.logIndex };

  try {
    if (pool.factoryKind === "uniswap-v2") {
      if (topic0 !== uniswapV2SwapTopic) {
        throw new SwapDecodeError(
          `unexpected topic0 ${topic0 ?? "<none>"} for uniswap-v2 pool ${pool.poolAddress}`,
          context
        );
      }
      const decoded = decodeEventLog({
        abi: [uniswapV2SwapEvent],
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data
      });
      return {
        pool,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        sender: getAddress(decoded.args.sender),
        recipient: getAddress(decoded.args.to),
        token0DeltaRaw: decoded.args.amount0In - decoded.args.amount0Out,
        token1DeltaRaw: decoded.args.amount1In - decoded.args.amount1Out
      };
    }

    if (pool.factoryKind !== "uniswap-v3") {
      throw new SwapDecodeError(
        `unsupported pool kind ${pool.factoryKind} for pool ${pool.poolAddress}`,
        context
      );
    }
    if (topic0 !== uniswapV3SwapTopic) {
      throw new SwapDecodeError(
        `unexpected topic0 ${topic0 ?? "<none>"} for uniswap-v3 pool ${pool.poolAddress}`,
        context
      );
    }
    const decoded = decodeEventLog({
      abi: [uniswapV3SwapEvent],
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data
    });
    return {
      pool,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      sender: getAddress(decoded.args.sender),
      recipient: getAddress(decoded.args.recipient),
      token0DeltaRaw: decoded.args.amount0,
      token1DeltaRaw: decoded.args.amount1
    };
  } catch (error) {
    if (error instanceof SwapDecodeError) throw error;
    throw new SwapDecodeError(`failed to decode ${pool.factoryKind} swap log`, {
      ...context,
      cause: error
    });
  }
}
