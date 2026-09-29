/**
 * OPT-IN LIVE VALIDATION — hits the real RPC, configured DB, and Blockscout.
 * Never part of `bun run test`.
 *
 * Runs the holders-pass path (transfer scan -> balance netting -> deployer
 * resolution -> concentration) for one token and prints the resolved deployer
 * plus the computed deployerPctBps. Read-only: no pipeline tables are mutated.
 *
 * Usage:
 *   bun run validate:deployer -- --token=0x... [--chunk=4000000]
 *
 * `--chunk` widens the per-getLogs block span for a faster one-off scan on
 * providers that tolerate large address-filtered ranges.
 */
import { getAddress, type Address } from "viem";

import { createChainPublicClient, loadChainConfigFromEnv } from "@assay/chain";
import { createDatabase, listTrustedQuotePools } from "@assay/database";
import {
  computeBalances,
  computeConcentration,
  createHolderReader
} from "@assay/holders";

import { loadDatabaseUrlFromEnv, WorkerConfigError } from "./config.js";
import { createLogger } from "./log.js";

function parseTokenArg(): Address {
  const arg = process.argv.find((a) => a.startsWith("--token="));
  const raw = arg?.split("=")[1];
  if (raw === undefined || raw === "") {
    throw new WorkerConfigError("--token", "required, e.g. --token=0x...");
  }
  return getAddress(raw);
}

function parseChunkArg(): bigint | undefined {
  const raw = process.argv
    .find((a) => a.startsWith("--chunk="))
    ?.split("=")[1];
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw) || BigInt(raw) < 1n) {
    throw new WorkerConfigError("--chunk", "must be a positive integer");
  }
  return BigInt(raw);
}

async function main(): Promise<void> {
  const logger = createLogger();
  const token = parseTokenArg();
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
    const pools = await listTrustedQuotePools(handle.db, config.chainId);
    const pool = pools.find(
      (candidate) =>
        candidate.baseTokenAddress?.toLowerCase() === token.toLowerCase()
    );
    if (pool === undefined) {
      throw new WorkerConfigError(
        "--token",
        `no trusted-quote pool found for token ${token}`
      );
    }

    const client = createChainPublicClient(config);
    const chunkSize = parseChunkArg();
    const reader = createHolderReader(client, {
      explorerUrl,
      ...(chunkSize === undefined ? {} : { chunkSize })
    });
    const blockNumber = await reader.getBlockNumber();
    const deployer = await reader.fetchContractCreation(token);
    const transfers = await reader.getErc20TransferLogs(
      token,
      pool.createdAtBlock,
      blockNumber
    );
    const balances = computeBalances(transfers);
    const concentration = computeConcentration(balances, {
      totalSupply: 0n,
      excluded: [{ address: pool.poolAddress, reason: "pool-address" }],
      deployer
    });

    logger.info("validate_deployer.result", {
      token,
      poolAddress: pool.poolAddress,
      route: pool.factoryKind,
      scannedFromBlock: pool.createdAtBlock,
      blockNumber,
      transferCount: transfers.length,
      deployerAddress: deployer,
      deployerStatus: deployer === null ? "UNKNOWN" : "RESOLVED",
      deployerPctBps: concentration.deployerPctBps,
      holderCount: concentration.holderCount,
      adjustedHolderCount: concentration.adjustedHolderCount,
      adjustedTop10PctBps: concentration.adjustedTop10PctBps,
      excluded: concentration.excluded
    });
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  createLogger().error("validate_deployer.crashed", { error });
  process.exit(1);
});
