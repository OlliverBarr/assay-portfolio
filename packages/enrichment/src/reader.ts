import type { Address } from "viem";

import { withRetry, type RetryOptions } from "@assay/chain";

/**
 * Minimal chain-read surface for enrichment. `PublicClient` satisfies it
 * structurally; tests substitute deterministic fakes. Every method may
 * throw — callers own classification.
 */
export interface ChainReader {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  getBlockNumber(): Promise<bigint>;
}

const v2PoolAbi = [
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" }
    ]
  }
] as const;

const v3PoolAbi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" }
    ]
  }
] as const;

const balanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }]
  }
] as const;

export interface V2Reserves {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
}

/** Retrying state reads used by the enrichment pass. */
export interface PoolStateReader {
  getV2Reserves(pool: Address): Promise<V2Reserves>;
  getSqrtPriceX96(pool: Address): Promise<bigint>;
  getBalanceOf(token: Address, holder: Address): Promise<bigint>;
  getBlockNumber(): Promise<bigint>;
}

export function createPoolStateReader(
  reader: ChainReader,
  retry?: Partial<RetryOptions>
): PoolStateReader {
  return {
    async getV2Reserves(pool) {
      const result = (await withRetry(
        `getReserves ${pool}`,
        () =>
          reader.readContract({
            address: pool,
            abi: v2PoolAbi,
            functionName: "getReserves"
          }),
        retry
      )) as readonly [bigint, bigint, number];
      return { reserve0: result[0], reserve1: result[1] };
    },
    async getSqrtPriceX96(pool) {
      const result = (await withRetry(
        `slot0 ${pool}`,
        () =>
          reader.readContract({
            address: pool,
            abi: v3PoolAbi,
            functionName: "slot0"
          }),
        retry
      )) as readonly [bigint, ...unknown[]];
      return result[0];
    },
    async getBalanceOf(token, holder) {
      return (await withRetry(
        `balanceOf ${token}`,
        () =>
          reader.readContract({
            address: token,
            abi: balanceOfAbi,
            functionName: "balanceOf",
            args: [holder]
          }),
        retry
      )) as bigint;
    },
    async getBlockNumber() {
      return withRetry("getBlockNumber", () => reader.getBlockNumber(), retry);
    }
  };
}
