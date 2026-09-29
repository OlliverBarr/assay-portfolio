/**
 * Record a manual operator trade decision, independent of whether the system
 * alerted. Append-only — a later EXITED is a new row, never an update. Feeds
 * `feedback.ts`, which joins these against `alerts_sent` and `token_outcomes`.
 *
 *   bun apps/worker/src/decide.ts -- --token=0x.. --action=entered \
 *     --reason="clean holders, organic buy pressure" \
 *     [--size-usd=500] [--price-usd=0.000123] [--pool=0x..]
 */
import { getAddress, type Address } from "viem";

import { loadChainConfigFromEnv } from "@assay/chain";
import { createDatabase, insertOperatorDecision } from "@assay/database";

import { loadDatabaseUrlFromEnv, WorkerConfigError } from "./config.js";
import { createLogger } from "./log.js";

const OPERATOR_ACTIONS = ["ENTERED", "PASSED", "WATCHING", "EXITED"] as const;
type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function parseTokenArg(): Address {
  const raw = parseArg("token");
  if (raw === undefined || raw === "") {
    throw new WorkerConfigError("--token", "required, e.g. --token=0x...");
  }
  return getAddress(raw);
}

function parseActionArg(): OperatorAction {
  const allowed = OPERATOR_ACTIONS.map((action) => action.toLowerCase()).join(
    ", "
  );
  const raw = parseArg("action");
  if (raw === undefined || raw === "") {
    throw new WorkerConfigError("--action", `required, one of: ${allowed}`);
  }
  const upper = raw.toUpperCase();
  const match = OPERATOR_ACTIONS.find((action) => action === upper);
  if (match === undefined) {
    throw new WorkerConfigError(
      "--action",
      `"${raw}" is not one of: ${allowed}`
    );
  }
  return match;
}

function parseReasonArg(): string {
  const raw = parseArg("reason")?.trim();
  if (raw === undefined || raw === "") {
    throw new WorkerConfigError(
      "--reason",
      'required, e.g. --reason="clean holders, organic buy pressure"'
    );
  }
  return raw;
}

function parseOptionalAddressArg(name: string): Address | undefined {
  const raw = parseArg(name);
  if (raw === undefined || raw === "") return undefined;
  return getAddress(raw);
}

function parseOptionalUsdArg(name: string): string | undefined {
  const raw = parseArg(name);
  if (raw === undefined || raw === "") return undefined;
  if (!Number.isFinite(Number(raw)) || Number(raw) < 0) {
    throw new WorkerConfigError(
      `--${name}`,
      `"${raw}" is not a non-negative number`
    );
  }
  return raw;
}

async function main(): Promise<void> {
  const logger = createLogger();
  const token = parseTokenArg();
  const action = parseActionArg();
  const reason = parseReasonArg();
  const poolAddress = parseOptionalAddressArg("pool");
  const sizeUsd = parseOptionalUsdArg("size-usd");
  const priceUsd = parseOptionalUsdArg("price-usd");

  const env = process.env;
  const config = loadChainConfigFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);

  const handle = createDatabase(databaseUrl);
  try {
    await handle.applyMigrations();
    const inserted = await insertOperatorDecision(handle.db, {
      chainId: config.chainId,
      tokenAddress: token,
      poolAddress: poolAddress ?? null,
      action,
      reason,
      sizeUsd: sizeUsd ?? null,
      priceUsd: priceUsd ?? null
    });
    logger.info("decide.recorded", {
      id: inserted.id,
      chainId: inserted.chainId,
      tokenAddress: inserted.tokenAddress,
      poolAddress: inserted.poolAddress,
      action: inserted.action,
      reason: inserted.reason,
      sizeUsd: inserted.sizeUsd,
      priceUsd: inserted.priceUsd,
      recordedAt: inserted.recordedAt
    });
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  createLogger().error("decide.crashed", { error });
  process.exit(1);
});
