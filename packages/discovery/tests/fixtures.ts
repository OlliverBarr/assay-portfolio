import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
  type Hex
} from "viem";

import {
  uniswapV2PairCreatedEvent,
  uniswapV3PoolCreatedEvent,
  type ChainConfig,
  type FactoryDescriptor,
  type FactoryLogSource,
  type GetLogsParams,
  type QuoteAssetConfig,
  type RawFactoryLog
} from "@assay/chain";

/** Deterministic address from a single repeated byte. */
export function addr(byte: string): Address {
  return getAddress(`0x${byte.repeat(20)}`);
}

export const V2_FACTORY: FactoryDescriptor = {
  dex: "uniswap",
  kind: "uniswap-v2",
  address: addr("f2"),
  deploymentBlock: 100n
};

export const V3_FACTORY: FactoryDescriptor = {
  dex: "uniswap",
  kind: "uniswap-v3",
  address: addr("f3"),
  deploymentBlock: 100n
};

export const WETH: QuoteAssetConfig = {
  address: addr("aa"),
  symbol: "WETH",
  decimals: 18
};

export const USDC: QuoteAssetConfig = {
  address: addr("bb"),
  symbol: "USDC",
  decimals: 6
};

export const TEST_CHAIN_ID = 4242;

export const TEST_CONFIG: ChainConfig = {
  chainId: TEST_CHAIN_ID,
  rpcUrls: ["http://127.0.0.1:8545"],
  factories: [V2_FACTORY, V3_FACTORY],
  quoteAssets: [WETH, USDC]
};

export function txHash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

export interface V2LogParams {
  token0: Address;
  token1: Address;
  pair: Address;
  blockNumber: bigint;
  logIndex?: number;
  allPairsLength?: bigint;
}

/** Narrow viem's encodeEventTopics result: fixtures always fill every indexed arg. */
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

/** Build a realistic PairCreated log via real ABI encoding. */
export function makeV2Log(params: V2LogParams): RawFactoryLog {
  const topics = asTopics(
    encodeEventTopics({
      abi: [uniswapV2PairCreatedEvent],
      args: { token0: params.token0, token1: params.token1 }
    })
  );
  const data = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [params.pair, params.allPairsLength ?? 1n]
  );
  return {
    address: V2_FACTORY.address,
    blockNumber: params.blockNumber,
    transactionHash: txHash(Number(params.blockNumber)),
    logIndex: params.logIndex ?? 0,
    topics,
    data
  };
}

export interface V3LogParams {
  token0: Address;
  token1: Address;
  pool: Address;
  fee?: number;
  tickSpacing?: number;
  blockNumber: bigint;
  logIndex?: number;
}

/** Build a realistic PoolCreated log via real ABI encoding. */
export function makeV3Log(params: V3LogParams): RawFactoryLog {
  const topics = asTopics(
    encodeEventTopics({
      abi: [uniswapV3PoolCreatedEvent],
      args: {
        token0: params.token0,
        token1: params.token1,
        fee: params.fee ?? 3000
      }
    })
  );
  const data = encodeAbiParameters(
    [{ type: "int24" }, { type: "address" }],
    [params.tickSpacing ?? 60, params.pool]
  );
  return {
    address: V3_FACTORY.address,
    blockNumber: params.blockNumber,
    transactionHash: txHash(Number(params.blockNumber)),
    logIndex: params.logIndex ?? 0,
    topics,
    data
  };
}

/** Error the fake source throws; tests mark it retryable explicitly. */
export class FakeTransientError extends Error {
  override readonly name = "FakeTransientError";
}

/**
 * Deterministic in-memory {@link FactoryLogSource}. Serves fixture logs by
 * block range, records every request, and injects failures on demand.
 */
export class FakeLogSource implements FactoryLogSource {
  readonly calls: GetLogsParams[] = [];
  /** Persistent failure predicate; throws for every matching request. */
  failWhen: ((params: GetLogsParams) => boolean) | null = null;
  /** One-shot failure budget: fail this many requests, then succeed. */
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
    const wanted = new Set(params.topics);
    return Promise.resolve(
      this.logs.filter(
        (log) =>
          log.blockNumber >= params.fromBlock &&
          log.blockNumber <= params.toBlock &&
          log.topics[0] !== undefined &&
          wanted.has(log.topics[0])
      )
    );
  }

  getLatestBlockNumber(): Promise<bigint> {
    return Promise.resolve(this.latestBlock);
  }
}

/** Retry options that treat FakeTransientError as retryable and never sleep. */
export const TEST_RETRY = {
  attempts: 3,
  baseDelayMs: 0,
  maxDelayMs: 0,
  isRetryable: (error: unknown): boolean =>
    error instanceof FakeTransientError,
  sleep: (): Promise<void> => Promise.resolve()
};
