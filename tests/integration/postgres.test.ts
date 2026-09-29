import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  advanceProcessedBlock,
  createDatabase,
  getCursor,
  initializeCursor,
  recordObservedBlock,
  type DatabaseHandle
} from "../../packages/database/src/index.js";
const testDatabaseUrl = process.env["ASSAY_TEST_DATABASE_URL"];
const describePostgres = testDatabaseUrl === undefined ? describe.skip : describe;

describePostgres("PostgreSQL persistence", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = createDatabase(testDatabaseUrl!);
    await handle.applyMigrations();
  });

  afterAll(async () => {
    await handle.close();
  });

  it("applies migrations and keeps the cursor watermarks monotonic", async () => {
    const chainId = 9_999;
    await initializeCursor(handle.db, chainId, 100n);
    await recordObservedBlock(handle.db, chainId, 105n);
    await recordObservedBlock(handle.db, chainId, 103n);
    await advanceProcessedBlock(handle.db, chainId, 104n);
    await advanceProcessedBlock(handle.db, chainId, 102n);

    await expect(getCursor(handle.db, chainId)).resolves.toMatchObject({
      chainId,
      latestObservedBlock: 105n,
      latestProcessedBlock: 104n
    });
  });
});
