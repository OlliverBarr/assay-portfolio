import { getAddress, type Address } from "viem";

import { RetryExhaustedError, type ChainConfig } from "@assay/chain";
import type { PoolInsert, PoolSnapshotInsert, TokenInsert } from "@assay/database";

import type { Erc20Transfer, HolderReader } from "../src/reader.js";

export const TEST_CHAIN_ID = 4242;

export function addr(byte: string): Address {
  return getAddress(`0x${byte.repeat(20)}`);
}

export const ZERO = getAddress("0x0000000000000000000000000000000000000000");
export const BURN = getAddress("0x000000000000000000000000000000000000dEaD");
export const QUOTE = addr("aa");
export const BASE = addr("cc");
export const BASE2 = addr("ce");
export const POOL = addr("dd");
export const POOL2 = addr("de");
export const HOLDER_A = addr("a1");
export const HOLDER_B = addr("b2");
export const HOLDER_C = addr("c3");

export const TEST_CONFIG: ChainConfig = {
  chainId: TEST_CHAIN_ID,
  rpcUrls: ["http://127.0.0.1:8545"],
  factories: [],
  quoteAssets: []
};

export function poolInsert(overrides: Partial<PoolInsert> = {}): PoolInsert {
  return {
    chainId: TEST_CHAIN_ID,
    poolAddress: POOL,
    factoryAddress: addr("f2"),
    dex: "uniswap",
    factoryKind: "uniswap-v2",
    token0Address: BASE,
    token1Address: QUOTE,
    quoteTokenAddress: QUOTE,
    baseTokenAddress: BASE,
    createdAtBlock: 100n,
    createdTxHash: `0x${"ab".repeat(32)}`,
    createdLogIndex: 0,
    ...overrides
  };
}

export function tokenInsert(
  address: Address,
  totalSupply: string | null,
  overrides: Partial<TokenInsert> = {}
): TokenInsert {
  return {
    chainId: TEST_CHAIN_ID,
    address,
    firstSeenBlock: 1n,
    decimals: 18,
    totalSupply,
    ...overrides
  };
}

export function transfer(
  from: Address,
  to: Address,
  valueRaw: bigint,
  block?: bigint
): RangedTransfer {
  return block === undefined ? { from, to, valueRaw } : { from, to, valueRaw, block };
}

export function snapshotInsert(
  poolAddress: Address,
  capturedAt: Date,
  overrides: Partial<PoolSnapshotInsert> = {}
): PoolSnapshotInsert {
  return {
    chainId: TEST_CHAIN_ID,
    poolAddress,
    blockNumber: 1n,
    capturedAt,
    calculationMethod: "v2-reserves",
    ...overrides
  };
}

/** A transfer optionally tagged with the block it occurred in, so the fake
 * reader can honor `fromBlock`/`toBlock` for incremental-scan tests. A
 * transfer with no block is always returned, regardless of the requested
 * range (legacy fixtures that don't care about ranges keep working). */
export type RangedTransfer = Erc20Transfer & { readonly block?: bigint };

export interface FakeHolderReaderState {
  blockNumber?: bigint;
  /** Transfers per token, keyed by lowercased address. */
  transfersByToken?: Record<string, RangedTransfer[]>;
  /** Tokens whose log read throws an infra RetryExhaustedError. */
  infraFailTokens?: readonly string[];
  /** Tokens whose log read throws a non-infra error. */
  errorTokens?: readonly string[];
  /** When true, getBlockNumber throws RetryExhaustedError. */
  blockNumberInfraFails?: boolean;
  /** Deployer per token, keyed by lowercased address; missing = explorer miss. */
  deployerByToken?: Record<string, Address>;
}

/** One `getErc20TransferLogs` call, in call order. */
export interface LogCall {
  readonly token: string;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

/** Deterministic {@link HolderReader} driven by in-memory maps. */
export class FakeHolderReader implements HolderReader {
  constructor(private readonly state: FakeHolderReaderState = {}) {}

  getBlockNumber(): Promise<bigint> {
    if (this.state.blockNumberInfraFails === true) {
      return Promise.reject(
        new RetryExhaustedError("getBlockNumber", 4, new Error("rpc down"))
      );
    }
    return Promise.resolve(this.state.blockNumber ?? 1000n);
  }

  /** Every `getErc20TransferLogs` call this instance received, in order. */
  readonly logCalls: LogCall[] = [];

  getErc20TransferLogs(
    token: Address,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<Erc20Transfer[]> {
    const key = token.toLowerCase();
    this.logCalls.push({ token: key, fromBlock, toBlock });
    if (this.state.infraFailTokens?.includes(key) === true) {
      return Promise.reject(
        new RetryExhaustedError(
          `getErc20TransferLogs ${token}`,
          4,
          new Error("rpc down")
        )
      );
    }
    if (this.state.errorTokens?.includes(key) === true) {
      return Promise.reject(new TypeError("hostile token log stream"));
    }
    const all = this.state.transfersByToken?.[key] ?? [];
    const inRange = all.filter(
      ({ block }) => block === undefined || (block >= fromBlock && block <= toBlock)
    );
    return Promise.resolve(
      inRange.map(({ from, to, valueRaw }) => ({ from, to, valueRaw }))
    );
  }

  /** Explorer creation lookups issued, in call order (lowercased tokens). */
  readonly creationLookups: string[] = [];

  fetchContractCreation(address: Address): Promise<Address | null> {
    const key = address.toLowerCase();
    this.creationLookups.push(key);
    return Promise.resolve(this.state.deployerByToken?.[key] ?? null);
  }
}
