import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
  type Hex
} from "viem";

import {
  uniswapV2SwapEvent,
  uniswapV3SwapEvent,
  type ChainConfig,
  type FactoryLogSource,
  type GetLogsParams,
  type RawFactoryLog
} from "@assay/chain";
import type { PoolInsert, PoolRow } from "@assay/database";

export const TEST_CHAIN_ID = 4242;

export function addr(byte: string): Address {
  return getAddress(`0x${byte.repeat(20)}`);
}

export function txHash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

export const WETH = { address: addr("aa"), symbol: "WETH", decimals: 18 };
export const USDC = { address: addr("bb"), symbol: "USDC", decimals: 6 };
export const BASE = addr("cc");
export const POOL = addr("dd");

export const TEST_CONFIG: ChainConfig = {
  chainId: TEST_CHAIN_ID,
  rpcUrls: ["http://127.0.0.1:8545"],
  factories: [
    {
      dex: "uniswap",
      kind: "uniswap-v2",
      address: addr("f2"),
      deploymentBlock: 100n
    },
    {
      dex: "uniswap",
      kind: "uniswap-v3",
      address: addr("f3"),
      deploymentBlock: 100n
    }
  ],
  quoteAssets: [WETH, USDC]
};

export function poolFixture(overrides: Partial<PoolInsert> = {}): PoolInsert {
  return {
    chainId: TEST_CHAIN_ID,
    poolAddress: POOL,
    factoryAddress: addr("f2"),
    dex: "uniswap",
    factoryKind: "uniswap-v2",
    token0Address: BASE,
    token1Address: WETH.address,
    quoteTokenAddress: WETH.address,
    baseTokenAddress: BASE,
    createdAtBlock: 100n,
    createdTxHash: txHash(1),
    createdLogIndex: 0,
    ...overrides
  };
}

export function poolRow(overrides: Partial<PoolRow> = {}): PoolRow {
  const insert = poolFixture(overrides);
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

function asTopics(
  encoded: readonly (Hex | readonly Hex[] | null)[]
): Hex[] {
  return encoded.map((topic) => {
    if (topic === null || Array.isArray(topic)) {
      throw new Error("fixture produced a null or list topic");
    }
    return topic as Hex;
  });
}

export interface V2SwapParams {
  pool?: Address;
  sender?: Address;
  to?: Address;
  amount0In?: bigint;
  amount1In?: bigint;
  amount0Out?: bigint;
  amount1Out?: bigint;
  blockNumber?: bigint;
  logIndex?: number;
  tx?: number;
}

export function makeV2SwapLog(params: V2SwapParams = {}): RawFactoryLog {
  const sender = params.sender ?? addr("11");
  const to = params.to ?? addr("22");
  const topics = asTopics(
    encodeEventTopics({
      abi: [uniswapV2SwapEvent],
      args: { sender, to }
    })
  );
  const data = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" }
    ],
    [
      params.amount0In ?? 0n,
      params.amount1In ?? 0n,
      params.amount0Out ?? 0n,
      params.amount1Out ?? 0n
    ]
  );
  const blockNumber = params.blockNumber ?? 101n;
  return {
    address: params.pool ?? POOL,
    blockNumber,
    transactionHash: txHash(params.tx ?? Number(blockNumber)),
    logIndex: params.logIndex ?? 0,
    topics,
    data
  };
}

export interface V3SwapParams {
  pool?: Address;
  sender?: Address;
  recipient?: Address;
  amount0?: bigint;
  amount1?: bigint;
  blockNumber?: bigint;
  logIndex?: number;
  tx?: number;
}

export function makeV3SwapLog(params: V3SwapParams = {}): RawFactoryLog {
  const sender = params.sender ?? addr("33");
  const recipient = params.recipient ?? addr("44");
  const topics = asTopics(
    encodeEventTopics({
      abi: [uniswapV3SwapEvent],
      args: { sender, recipient }
    })
  );
  const data = encodeAbiParameters(
    [
      { type: "int256" },
      { type: "int256" },
      { type: "uint160" },
      { type: "uint128" },
      { type: "int24" }
    ],
    [
      params.amount0 ?? 0n,
      params.amount1 ?? 0n,
      2n ** 96n,
      1_000_000n,
      0
    ]
  );
  const blockNumber = params.blockNumber ?? 101n;
  return {
    address: params.pool ?? POOL,
    blockNumber,
    transactionHash: txHash(params.tx ?? Number(blockNumber)),
    logIndex: params.logIndex ?? 0,
    topics,
    data
  };
}

export class FakeTransientError extends Error {
  override readonly name = "FakeTransientError";
}

export class FakeLogSource implements FactoryLogSource {
  readonly calls: GetLogsParams[] = [];
  failWhen: ((params: GetLogsParams) => boolean) | null = null;
  transientFailuresRemaining = 0;

  constructor(
    private readonly logs: readonly RawFactoryLog[],
    public latestBlock: bigint
  ) {}

  getLogs(params: GetLogsParams): Promise<RawFactoryLog[]> {
    this.calls.push(params);
    if (this.transientFailuresRemaining > 0) {
      this.transientFailuresRemaining -= 1;
      return Promise.reject(new FakeTransientError("injected transient failure"));
    }
    if (this.failWhen?.(params) === true) {
      return Promise.reject(new FakeTransientError("injected persistent failure"));
    }
    const addresses = new Set(params.addresses.map((address) => address.toLowerCase()));
    const topics = new Set(params.topics);
    return Promise.resolve(
      this.logs.filter(
        (log) =>
          log.blockNumber >= params.fromBlock &&
          log.blockNumber <= params.toBlock &&
          addresses.has(log.address.toLowerCase()) &&
          log.topics[0] !== undefined &&
          topics.has(log.topics[0])
      )
    );
  }

  getLatestBlockNumber(): Promise<bigint> {
    return Promise.resolve(this.latestBlock);
  }
}

export const TEST_RETRY = {
  attempts: 3,
  baseDelayMs: 0,
  maxDelayMs: 0,
  isRetryable: (error: unknown): boolean => error instanceof FakeTransientError,
  sleep: (): Promise<void> => Promise.resolve()
};
