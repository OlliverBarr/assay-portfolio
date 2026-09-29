import { loadChainConfigFromEnv, type EnvSource } from "@assay/chain";

/** Raised when dashboard-level configuration is missing or malformed. */
export class DashboardConfigError extends Error {
  override readonly name = "DashboardConfigError";
  readonly field: string;

  constructor(field: string, message: string) {
    super(`Invalid dashboard configuration for "${field}": ${message}`);
    this.field = field;
  }
}

export interface DashboardConfig {
  readonly databaseUrl: string;
  readonly chainId: number;
  readonly host: string;
  readonly port: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4600;

function loadDatabaseUrl(env: EnvSource): string {
  const url = env["DATABASE_URL"]?.trim();
  if (url === undefined || url === "") {
    throw new DashboardConfigError("DATABASE_URL", "value is required");
  }
  return url;
}

function loadHost(env: EnvSource): string {
  const raw = env["DASHBOARD_HOST"]?.trim();
  return raw === undefined || raw === "" ? DEFAULT_HOST : raw;
}

function loadPort(env: EnvSource): number {
  const raw = env["DASHBOARD_PORT"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new DashboardConfigError(
      "DASHBOARD_PORT",
      `"${raw}" is not an integer between 1 and 65535`
    );
  }
  return value;
}

/**
 * Build the dashboard's configuration from environment variables.
 * DATABASE_URL is required; the chain id is sourced through @assay/chain's
 * loader so the dashboard reads the same ROBINHOOD_CHAIN_ID as the worker.
 * Host/port fall back to a localhost-only default: the dashboard has no
 * auth and is meant to stay off the public network (see .env.example).
 */
export function loadDashboardConfigFromEnv(env: EnvSource): DashboardConfig {
  const databaseUrl = loadDatabaseUrl(env);
  const { chainId } = loadChainConfigFromEnv(env);
  const host = loadHost(env);
  const port = loadPort(env);
  return { databaseUrl, chainId, host, port };
}
