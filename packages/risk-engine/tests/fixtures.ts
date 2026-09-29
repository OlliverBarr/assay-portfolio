import { getAddress, type Address, type Hex } from "viem";

import { RetryExhaustedError } from "@assay/chain";
import type { PoolInsert, PoolRow, PoolSnapshotInsert } from "@assay/database";

import type { RiskReader } from "../src/reader.js";
import type { RouteSimulator } from "../src/simulator.js";
import type { RawRouteSimulation } from "../src/simulate.js";
import type { ExplorerContractResult } from "../src/verification.js";

export const TEST_CHAIN_ID = 4242;

export function addr(byte: string): Address {
  return getAddress(`0x${byte.repeat(20)}`);
}

export const BASE = addr("cc");
export const QUOTE = addr("aa");
export const POOL = addr("dd");

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

/** Runtime bytecode containing the given 4-byte selectors as evidence. */
export function codeWith(selectors: readonly Hex[]): Hex {
  const body = selectors.map((s) => s.slice(2)).join("");
  return `0x60806040${body}`;
}

export function poolRow(overrides: Partial<PoolRow> = {}): PoolRow {
  const insert: PoolInsert = {
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
    createdLogIndex: 0
  };
  return {
    ...insert,
    feePpm: insert.feePpm ?? null,
    tickSpacing: insert.tickSpacing ?? null,
    quoteTokenAddress: insert.quoteTokenAddress ?? null,
    baseTokenAddress: insert.baseTokenAddress ?? null,
    discoveredAt: new Date(),
    ...overrides
  };
}

export interface FakeRiskReaderState {
  blockNumber?: bigint;
  code?: Record<string, Hex | null>;
  storage?: Record<string, Hex>;
  verification?: Record<string, ExplorerContractResult | null>;
  /** Addresses whose getCode throws an infra RetryExhaustedError. */
  infraFailAddresses?: readonly string[];
  /** Addresses whose getCode throws a non-infra error. */
  errorAddresses?: readonly string[];
  /** When true, getBlockNumber throws RetryExhaustedError. */
  blockNumberInfraFails?: boolean;
}

/** Deterministic {@link RiskReader} driven by in-memory maps. */
export class FakeRiskReader implements RiskReader {
  constructor(private readonly state: FakeRiskReaderState = {}) {}

  getBlockNumber(): Promise<bigint> {
    if (this.state.blockNumberInfraFails === true) {
      return Promise.reject(
        new RetryExhaustedError("getBlockNumber", 4, new Error("rpc down"))
      );
    }
    return Promise.resolve(this.state.blockNumber ?? 1000n);
  }

  getCode(address: Address): Promise<Hex | null> {
    const key = address.toLowerCase();
    if (this.state.infraFailAddresses?.includes(key) === true) {
      return Promise.reject(
        new RetryExhaustedError(`getCode ${address}`, 4, new Error("rpc down"))
      );
    }
    if (this.state.errorAddresses?.includes(key) === true) {
      return Promise.reject(new TypeError("hostile contract read"));
    }
    return Promise.resolve(this.state.code?.[key] ?? "0x");
  }

  getStorageAt(address: Address, slot: Hex): Promise<Hex | null> {
    const key = `${address.toLowerCase()}:${slot.toLowerCase()}`;
    return Promise.resolve(this.state.storage?.[key] ?? null);
  }

  fetchContractVerification(
    address: Address
  ): Promise<ExplorerContractResult | null> {
    return Promise.resolve(this.state.verification?.[address.toLowerCase()] ?? null);
  }
}

export function fakeSimulator(raw: RawRouteSimulation): RouteSimulator {
  return { simulate: () => Promise.resolve(raw) };
}

export function rawSim(
  overrides: Partial<RawRouteSimulation> = {}
): RawRouteSimulation {
  return {
    route: "uniswap-v2",
    buyReverted: false,
    transferReverted: false,
    sellReverted: false,
    buyQuoteInRaw: 1_000_000n,
    buyBaseOutRaw: 1_000n,
    spotBaseOutRaw: 1_000n,
    sellBaseInRaw: 1_000n,
    sellQuoteOutRaw: 990_000n,
    spotQuoteOutRaw: 1_000_000n,
    slippageCurve: null,
    ...overrides
  };
}
