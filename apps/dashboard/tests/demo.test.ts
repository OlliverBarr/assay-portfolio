import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabaseHandle } from "@assay/database/testing";

import { buildDashboardApp } from "../src/app.js";
import { seedDemoData } from "../src/demo.js";

describe("dashboard demo", () => {
  let handle: TestDatabaseHandle;

  beforeEach(async () => {
    handle = await createTestDatabase();
    await seedDemoData(handle.db, new Date("2026-07-23T04:32:20.000Z"));
  });

  afterEach(async () => {
    await handle.close();
  });

  it("exposes a fictional candidate through the normal dashboard API", async () => {
    const app = buildDashboardApp({ db: handle.db, chainId: 4663 });
    try {
      const funnel = await app.inject({ method: "GET", url: "/api/funnel" });
      const alerts = await app.inject({ method: "GET", url: "/api/alerts" });

      expect(funnel.json()).toMatchObject({
        pools: 1,
        trustedQuotePools: 1,
        alertedTokens: { GREEN: 1 }
      });
      expect(alerts.json()).toEqual([
        expect.objectContaining({
          name: "Demo Token",
          symbol: "DEMO",
          alertLevel: "GREEN",
          transport: "dry-run"
        })
      ]);
    } finally {
      await app.close();
    }
  });
});
