/**
 * OPT-IN LIVE VALIDATION — hits the real RPC, configured DB, and Blockscout.
 * Never part of `bun run test`.
 *
 * Usage:
 *   bun run validate:risk -- --token=0x...
 */
import { getAddress, type Address } from "viem";

import { createChainPublicClient, loadChainConfigFromEnv } from "@assay/chain";
import { createDatabase, listTrustedQuotePools } from "@assay/database";
import {
  assessPoolRisk,
  createQuoteRouteSimulator,
  createRiskReader,
  type RouteSimulator
} from "@assay/risk-engine";

import {
  loadDatabaseUrlFromEnv,
  loadRiskSimulatorConfigFromEnv,
  loadWorkerTuningFromEnv,
  WorkerConfigError
} from "./config.js";
import { createLogger } from "./log.js";

function parseTokenArg(): Address {
  const arg = process.argv.find((a) => a.startsWith("--token="));
  const raw = arg?.split("=")[1];
  if (raw === undefined || raw === "") {
    throw new WorkerConfigError("--token", "required, e.g. --token=0x...");
  }
  return getAddress(raw);
}

async function main(): Promise<void> {
  const logger = createLogger();
  const token = parseTokenArg();
  const env = process.env;
  const config = loadChainConfigFromEnv(env);
  const tuning = loadWorkerTuningFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);
  const explorerUrl = env["ROBINHOOD_CHAIN_EXPLORER_URL"]?.trim();

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
    const riskReader = createRiskReader(client, {
      ...(explorerUrl === undefined || explorerUrl === ""
        ? {}
        : { explorerUrl })
    });
    const simulatorConfig = loadRiskSimulatorConfigFromEnv(env);
    const simulator: RouteSimulator | undefined =
      simulatorConfig.v2Router === undefined &&
      simulatorConfig.v3Quoter === undefined
        ? undefined
        : createQuoteRouteSimulator(client, simulatorConfig);

    const blockNumber = await riskReader.getBlockNumber();
    const assessment = await assessPoolRisk(riskReader, pool, blockNumber, {
      thresholds: { maxSellLossBps: tuning.riskMaxSellLossBps },
      ...(simulator === undefined ? {} : { simulator })
    });

    logger.info("validate_risk.result", {
      token,
      poolAddress: pool.poolAddress,
      route: pool.factoryKind,
      blockNumber,
      simulator: simulator === undefined ? "disabled" : "enabled",
      status: assessment.status,
      verificationStatus: assessment.verification.status,
      isProxy: assessment.proxy.isProxy,
      implementation: assessment.proxy.implementation,
      permissions: assessment.permissions.map(
        (finding) => `${finding.kind}:${finding.state}`
      ),
      simulationStatus: assessment.simulation?.status ?? "UNKNOWN",
      effectiveSellLossBps: assessment.simulation?.effectiveSellLossBps ?? null,
      riskReasons: assessment.riskReasons,
      positiveReasons: assessment.positiveReasons
    });
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  createLogger().error("validate_risk.crashed", { error });
  process.exit(1);
});
