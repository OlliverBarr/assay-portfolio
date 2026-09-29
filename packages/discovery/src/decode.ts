import {
  decodeEventLog,
  getAddress,
  type Address,
  type Hex
} from "viem";

import {
  uniswapV2PairCreatedEvent,
  uniswapV2PairCreatedTopic,
  uniswapV3PoolCreatedEvent,
  uniswapV3PoolCreatedTopic,
  type FactoryDescriptor,
  type RawFactoryLog
} from "@assay/chain";

import { PoolDecodeError } from "./errors.js";

/** A decoded, factory-agnostic pool-creation event. */
export interface PoolCreationEvent {
  readonly factory: FactoryDescriptor;
  readonly poolAddress: Address;
  readonly token0: Address;
  readonly token1: Address;
  /** V3 fee tier (hundredths of a bip); null for V2. */
  readonly feePpm: number | null;
  /** V3 tick spacing; null for V2. */
  readonly tickSpacing: number | null;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

/**
 * Decode a raw factory log into a {@link PoolCreationEvent}.
 *
 * Any mismatch — unknown topic0, malformed data — throws
 * {@link PoolDecodeError}. Discovery never silently drops a log from a
 * watched factory.
 */
export function decodePoolCreationLog(
  log: RawFactoryLog,
  factory: FactoryDescriptor
): PoolCreationEvent {
  const topic0 = log.topics[0];
  const context = { blockNumber: log.blockNumber, logIndex: log.logIndex };

  try {
    if (factory.kind === "uniswap-v2") {
      if (topic0 !== uniswapV2PairCreatedTopic) {
        throw new PoolDecodeError(
          `unexpected topic0 ${topic0 ?? "<none>"} for uniswap-v2 factory ${factory.address}`,
          context
        );
      }
      const decoded = decodeEventLog({
        abi: [uniswapV2PairCreatedEvent],
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data
      });
      return {
        factory,
        poolAddress: getAddress(decoded.args.pair),
        token0: getAddress(decoded.args.token0),
        token1: getAddress(decoded.args.token1),
        feePpm: null,
        tickSpacing: null,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex
      };
    }

    if (topic0 !== uniswapV3PoolCreatedTopic) {
      throw new PoolDecodeError(
        `unexpected topic0 ${topic0 ?? "<none>"} for uniswap-v3 factory ${factory.address}`,
        context
      );
    }
    const decoded = decodeEventLog({
      abi: [uniswapV3PoolCreatedEvent],
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data
    });
    return {
      factory,
      poolAddress: getAddress(decoded.args.pool),
      token0: getAddress(decoded.args.token0),
      token1: getAddress(decoded.args.token1),
      feePpm: decoded.args.fee,
      tickSpacing: decoded.args.tickSpacing,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex
    };
  } catch (error) {
    if (error instanceof PoolDecodeError) throw error;
    throw new PoolDecodeError(
      `failed to decode ${factory.kind} pool-creation log`,
      { ...context, cause: error }
    );
  }
}
