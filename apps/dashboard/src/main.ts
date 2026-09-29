/**
 * Read-only analytics dashboard entrypoint:
 *
 *   bun apps/dashboard/src/main.ts
 *
 * Never applies migrations: those are the worker's responsibility, and a
 * read-only consumer racing them on startup would be a bug.
 */
import { createDatabase } from "@assay/database";

import { buildDashboardApp } from "./app.js";
import { loadDashboardConfigFromEnv } from "./config.js";

/** Minimal structured logger: one JSON object per line on stdout/stderr. */
type LogFields = Record<string, unknown>;

interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  return value;
}

function line(level: "info" | "error", event: string, fields?: LogFields): string {
  return JSON.stringify(
    { ts: new Date().toISOString(), level, event, ...fields },
    replacer
  );
}

function createLogger(): Logger {
  return {
    info: (event, fields) => {
      process.stdout.write(`${line("info", event, fields)}\n`);
    },
    error: (event, fields) => {
      process.stderr.write(`${line("error", event, fields)}\n`);
    }
  };
}

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadDashboardConfigFromEnv(process.env);
  const handle = createDatabase(config.databaseUrl);
  const app = buildDashboardApp({ db: handle.db, chainId: config.chainId });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.error("dashboard.force_exit", { signal });
      process.exit(130);
    }
    shuttingDown = true;
    logger.info("dashboard.stopping", { signal });
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  logger.info("dashboard.started", {
    host: config.host,
    port: config.port,
    chainId: config.chainId
  });
}

// Run only when executed directly; importing buildDashboardApp/config for
// tests must never open a database connection or bind a port.
if (import.meta.main) {
  main().catch((error: unknown) => {
    createLogger().error("dashboard.crashed", { error });
    process.exit(1);
  });
}
