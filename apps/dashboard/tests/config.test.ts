import { describe, expect, it } from "vitest";

import {
  DashboardConfigError,
  loadDashboardConfigFromEnv
} from "../src/config.js";

const VALID_CHAIN_ENV = {
  ROBINHOOD_CHAIN_ID: "6363",
  ROBINHOOD_CHAIN_RPC_URL: "http://localhost:0"
};

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ...VALID_CHAIN_ENV,
    DATABASE_URL: "postgres://user:pass@localhost:5432/launch_radar",
    ...overrides
  };
}

describe("loadDashboardConfigFromEnv", () => {
  it("applies host/port defaults and reads the chain id", () => {
    const config = loadDashboardConfigFromEnv(validEnv());

    expect(config).toEqual({
      databaseUrl: "postgres://user:pass@localhost:5432/launch_radar",
      chainId: 6363,
      host: "127.0.0.1",
      port: 4600
    });
  });

  it("throws DashboardConfigError on field DATABASE_URL when unset", () => {
    const env = validEnv({ DATABASE_URL: undefined });

    try {
      loadDashboardConfigFromEnv(env);
      expect.unreachable("expected loadDashboardConfigFromEnv to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardConfigError);
      expect((error as DashboardConfigError).field).toBe("DATABASE_URL");
    }
  });

  it("rejects a port above 65535", () => {
    expect(() =>
      loadDashboardConfigFromEnv(validEnv({ DASHBOARD_PORT: "70000" }))
    ).toThrow(DashboardConfigError);
  });

  it("rejects a non-numeric port", () => {
    expect(() =>
      loadDashboardConfigFromEnv(validEnv({ DASHBOARD_PORT: "abc" }))
    ).toThrow(DashboardConfigError);
  });

  it("respects an explicit port", () => {
    const config = loadDashboardConfigFromEnv(validEnv({ DASHBOARD_PORT: "8080" }));
    expect(config.port).toBe(8080);
  });

  it("respects an explicit host", () => {
    const config = loadDashboardConfigFromEnv(validEnv({ DASHBOARD_HOST: "0.0.0.0" }));
    expect(config.host).toBe("0.0.0.0");
  });
});
