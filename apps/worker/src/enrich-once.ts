import {
  createChainPublicClient,
  loadChainConfigFromEnv
} from "@assay/chain";
import { createDatabase, upsertQuoteAssets } from "@assay/database";
import { runEnrichmentPass } from "@assay/enrichment";

import {
  loadDatabaseUrlFromEnv,
  loadWorkerTuningFromEnv,
  WorkerConfigError
} from "./config.js";
import { createLogger } from "./log.js";

const QUOTE_ASSET_VERIFICATION_SOURCE = "docs/data-sources.md";

function parseLimit(argv: readonly string[]): number | undefined {
  const index = argv.indexOf("--limit");
  if (index === -1) return undefined;
  const raw = argv[index + 1];
  if (raw === undefined) {
    throw new WorkerConfigError("--limit", "value is required");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkerConfigError("--limit", `"${raw}" is not a positive integer`);
  }
  return value;
}

async function main(): Promise<void> {
  const logger = createLogger();
  const env = process.env;
  const config = loadChainConfigFromEnv(env);
  const tuning = loadWorkerTuningFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);
  const poolLimit = parseLimit(process.argv.slice(2));

  const handle = createDatabase(databaseUrl);
  try {
    await handle.applyMigrations();
    await upsertQuoteAssets(
      handle.db,
      config.quoteAssets.map((asset) => ({
        chainId: config.chainId,
        address: asset.address,
        symbol: asset.symbol,
        decimals: asset.decimals,
        verificationSource: QUOTE_ASSET_VERIFICATION_SOURCE
      }))
    );

    const client = createChainPublicClient(config);
    const result = await runEnrichmentPass({
      db: handle.db,
      reader: client,
      config,
      concurrency: tuning.enrichmentConcurrency,
      ...(poolLimit === undefined ? {} : { poolLimit })
    });
    logger.info("enrich_once.pass", {
      chainId: result.chainId,
      blockNumber: result.blockNumber,
      poolsSelected: result.poolsSelected,
      snapshotsInserted: result.snapshotsInserted,
      metadataRefreshed: result.metadataRefreshed,
      poolErrors: result.poolErrors.length,
      anchorPoolAddress: result.anchorPoolAddress,
      stopped: result.stopped
    });
    if (result.poolErrors.length > 0) {
      logger.error("enrich_once.pool_errors", { poolErrors: result.poolErrors });
    }
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  const logger = createLogger();
  logger.error("enrich_once.crashed", { error });
  process.exit(1);
});
