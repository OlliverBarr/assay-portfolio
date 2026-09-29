/**
 * OPT-IN LIVE VALIDATION — hits the real RPC, configured DB, and Blockscout.
 * Never part of `bun run test`.
 *
 * Usage:
 *   bun run validate:swaps -- --pool=0x... --from=123 --to=456
 */
import { getAddress, type Address, type Hex } from "viem";

import {
  createChainPublicClient,
  createRpcLogSource,
  loadChainConfigFromEnv,
  swapTopicByKind
} from "@assay/chain";
import { createDatabase, getPool, type PoolRow } from "@assay/database";
import { decodeSwapLog, normalizeSwapEvent } from "@assay/activity";

import { loadDatabaseUrlFromEnv, WorkerConfigError } from "./config.js";
import { createLogger } from "./log.js";

function parseBlockArg(name: string): bigint {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  const raw = arg?.split("=")[1];
  if (raw === undefined || raw === "") {
    throw new WorkerConfigError(`--${name}`, "required, e.g. --from=1000");
  }
  const value = BigInt(raw);
  if (value < 0n) throw new WorkerConfigError(`--${name}`, "must be >= 0");
  return value;
}

function parsePoolArg(): Address {
  const arg = process.argv.find((a) => a.startsWith("--pool="));
  const raw = arg?.split("=")[1];
  if (raw === undefined || raw === "") {
    throw new WorkerConfigError("--pool", "required, e.g. --pool=0x...");
  }
  return getAddress(raw);
}

interface BlockscoutLogsResponse {
  status: string;
  message: string;
  result: unknown[] | string;
}

const EXPLORER_RESULT_CAP = 1_000;

async function fetchExplorerWindow(
  explorerUrl: string,
  address: string,
  topic0: string,
  fromBlock: bigint,
  toBlock: bigint
): Promise<number | "split"> {
  const url =
    `${explorerUrl}/api?module=logs&action=getLogs` +
    `&fromBlock=${fromBlock}&toBlock=${toBlock}` +
    `&address=${address}&topic0=${topic0}`;
  const response = await fetch(url);
  if (response.status >= 500) return "split";
  if (!response.ok) {
    throw new Error(`explorer returned HTTP ${response.status} for ${url}`);
  }
  const body = (await response.json()) as BlockscoutLogsResponse;
  if (!Array.isArray(body.result)) {
    if (body.message.toLowerCase().includes("no logs")) return 0;
    throw new Error(`explorer error: ${body.message} (${String(body.result)})`);
  }
  if (body.result.length >= EXPLORER_RESULT_CAP) return "split";
  return body.result.length;
}

async function fetchExplorerLogCount(
  explorerUrl: string,
  address: string,
  topic0: string,
  fromBlock: bigint,
  toBlock: bigint
): Promise<number> {
  const result = await fetchExplorerWindow(
    explorerUrl,
    address,
    topic0,
    fromBlock,
    toBlock
  );
  if (result !== "split") return result;
  if (fromBlock === toBlock) {
    throw new Error(`explorer cannot enumerate logs for single block ${fromBlock}`);
  }
  const mid = fromBlock + (toBlock - fromBlock) / 2n;
  const left = await fetchExplorerLogCount(
    explorerUrl,
    address,
    topic0,
    fromBlock,
    mid
  );
  const right = await fetchExplorerLogCount(
    explorerUrl,
    address,
    topic0,
    mid + 1n,
    toBlock
  );
  return left + right;
}

function topicForPool(pool: PoolRow): Hex {
  if (pool.factoryKind !== "uniswap-v2" && pool.factoryKind !== "uniswap-v3") {
    throw new WorkerConfigError("pool", `unsupported factory kind ${pool.factoryKind}`);
  }
  return swapTopicByKind[pool.factoryKind];
}

async function main(): Promise<void> {
  const logger = createLogger();
  const poolAddress = parsePoolArg();
  const fromBlock = parseBlockArg("from");
  const toBlock = parseBlockArg("to");
  if (toBlock < fromBlock) {
    throw new WorkerConfigError("--to", "must be >= --from");
  }

  const env = process.env;
  const config = loadChainConfigFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);
  const explorerUrl = env["ROBINHOOD_CHAIN_EXPLORER_URL"]?.trim();
  if (explorerUrl === undefined || explorerUrl === "") {
    throw new WorkerConfigError("ROBINHOOD_CHAIN_EXPLORER_URL", "required");
  }

  const handle = createDatabase(databaseUrl);
  try {
    await handle.applyMigrations();
    const pool = await getPool(handle.db, config.chainId, poolAddress);
    if (pool === undefined) {
      throw new WorkerConfigError("--pool", `pool ${poolAddress} not found in database`);
    }
    if (pool.quoteTokenAddress === null || pool.baseTokenAddress === null) {
      throw new WorkerConfigError("--pool", "pool is not a trusted-quote pool");
    }

    const topic0 = topicForPool(pool);
    const client = createChainPublicClient(config);
    const logSource = createRpcLogSource(client);
    const logs = await logSource.getLogs({
      addresses: [poolAddress],
      topics: [topic0],
      fromBlock,
      toBlock
    });

    let buyCount = 0;
    let sellCount = 0;
    let unknownCount = 0;
    for (const log of logs) {
      const normalized = normalizeSwapEvent(decodeSwapLog(log, pool));
      if (normalized?.side === "BUY") buyCount += 1;
      else if (normalized?.side === "SELL") sellCount += 1;
      else unknownCount += 1;
    }

    const explorerCount = await fetchExplorerLogCount(
      explorerUrl,
      poolAddress,
      topic0,
      fromBlock,
      toBlock
    );
    const match = logs.length === explorerCount;
    logger.info("validate_swaps.result", {
      poolAddress,
      fromBlock,
      toBlock,
      rpcCount: logs.length,
      explorerCount,
      buyCount,
      sellCount,
      unknownCount,
      match
    });
    if (!match) {
      logger.error("validate_swaps.mismatch", {
        poolAddress,
        rpcCount: logs.length,
        explorerCount
      });
      process.exitCode = 1;
    }
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  createLogger().error("validate_swaps.crashed", { error });
  process.exit(1);
});
