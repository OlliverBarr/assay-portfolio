/**
 * OPT-IN LIVE VALIDATION — hits the real RPC and Blockscout. Never part of
 * `bun run test`.
 *
 * Scans a fixed historical block range into a scratch PGlite database using
 * the production discovery pass, prints discovered pools, and cross-checks
 * per-factory event counts against the Blockscout logs API.
 *
 * Usage:
 *   bun apps/worker/src/validate-range.ts --from=9486 --to=12000
 */
import {
  createChainPublicClient,
  createRpcLogSource,
  loadChainConfigFromEnv,
  poolCreationTopicByKind,
  type FactoryLogSource
} from "@assay/chain";
import { listPools } from "@assay/database";
import { createTestDatabase } from "@assay/database/testing";
import { runDiscoveryPass } from "@assay/discovery";

import { WorkerConfigError } from "./config.js";
import { createLogger } from "./log.js";

function parseBlockArg(name: string): bigint {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  const raw = arg?.split("=")[1];
  if (raw === undefined || raw === "") {
    throw new WorkerConfigError(`--${name}`, "required, e.g. --from=9486");
  }
  const value = BigInt(raw);
  if (value < 0n) throw new WorkerConfigError(`--${name}`, "must be >= 0");
  return value;
}

interface BlockscoutLogsResponse {
  status: string;
  message: string;
  result: unknown[] | string;
}

/** Blockscout caps getLogs responses at this many entries. */
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
  // The instance 500s on ranges it considers too wide — split and retry.
  if (response.status >= 500) return "split";
  if (!response.ok) {
    throw new Error(`explorer returned HTTP ${response.status} for ${url}`);
  }
  const body = (await response.json()) as BlockscoutLogsResponse;
  if (!Array.isArray(body.result)) {
    // Blockscout reports "No logs found" with status 0.
    if (body.message.toLowerCase().includes("no logs")) return 0;
    throw new Error(`explorer error: ${body.message} (${String(body.result)})`);
  }
  // At the cap the window may be truncated; split to get exact counts.
  if (body.result.length >= EXPLORER_RESULT_CAP) return "split";
  return body.result.length;
}

/**
 * Exact explorer log count over [fromBlock, toBlock], recursively halving
 * windows the explorer refuses (HTTP 5xx) or truncates (result cap).
 */
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
    throw new Error(
      `explorer cannot enumerate logs for single block ${fromBlock}`
    );
  }
  const mid = fromBlock + (toBlock - fromBlock) / 2n;
  const [left, right] = [
    await fetchExplorerLogCount(explorerUrl, address, topic0, fromBlock, mid),
    await fetchExplorerLogCount(explorerUrl, address, topic0, mid + 1n, toBlock)
  ];
  return left + right;
}

async function main(): Promise<void> {
  const logger = createLogger();
  const fromBlock = parseBlockArg("from");
  const toBlock = parseBlockArg("to");
  if (toBlock < fromBlock) {
    throw new WorkerConfigError("--to", "must be >= --from");
  }

  const env = process.env;
  const config = loadChainConfigFromEnv(env);
  const explorerUrl = env["ROBINHOOD_CHAIN_EXPLORER_URL"]?.trim();
  if (explorerUrl === undefined || explorerUrl === "") {
    throw new WorkerConfigError("ROBINHOOD_CHAIN_EXPLORER_URL", "required");
  }

  // Clamp the scan to [fromBlock, toBlock]: deployment blocks bound the
  // cursor start; a wrapped head bounds the end.
  const rangeConfig = {
    ...config,
    factories: config.factories.map((factory) => ({
      ...factory,
      deploymentBlock:
        factory.deploymentBlock > fromBlock ? factory.deploymentBlock : fromBlock
    }))
  };
  const client = createChainPublicClient(config);
  const rpcSource = createRpcLogSource(client);
  const boundedSource: FactoryLogSource = {
    getLogs: (params) => rpcSource.getLogs(params),
    getLatestBlockNumber: () => Promise.resolve(toBlock)
  };

  const handle = await createTestDatabase();
  try {
    const result = await runDiscoveryPass({
      db: handle.db,
      logSource: boundedSource,
      config: rangeConfig,
      chunkSize: 500n // gentle on the rate-limited public RPC
    });
    logger.info("validate.pass", { ...result });

    const pools = await listPools(handle.db, config.chainId);
    for (const pool of pools) {
      logger.info("validate.pool", {
        poolAddress: pool.poolAddress,
        factoryKind: pool.factoryKind,
        token0: pool.token0Address,
        token1: pool.token1Address,
        quoteToken: pool.quoteTokenAddress,
        block: pool.createdAtBlock,
        tx: pool.createdTxHash
      });
    }

    // Cross-check each factory against the explorer's own index.
    let mismatched = false;
    for (const factory of rangeConfig.factories) {
      const explorerCount = await fetchExplorerLogCount(
        explorerUrl,
        factory.address,
        poolCreationTopicByKind[factory.kind],
        factory.deploymentBlock,
        toBlock
      );
      const dbCount = pools.filter(
        (pool) => pool.factoryAddress === factory.address
      ).length;
      const match = explorerCount === dbCount;
      if (!match) mismatched = true;
      logger.info("validate.explorer_check", {
        factory: `${factory.kind}@${factory.address}`,
        explorerCount,
        dbCount,
        match
      });
    }

    if (mismatched) {
      logger.error("validate.mismatch", { fromBlock, toBlock });
      process.exitCode = 1;
    } else {
      logger.info("validate.ok", { fromBlock, toBlock, pools: pools.length });
    }
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  createLogger().error("validate.crashed", { error });
  process.exit(1);
});
