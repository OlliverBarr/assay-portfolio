import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import type { Db } from "./client.js";
import { migrationsFolder } from "./migrate.js";
import * as schema from "./schema.js";

export interface TestDatabaseHandle {
  readonly db: Db;
  close(): Promise<void>;
}

/**
 * PGlite PostgreSQL with the real migrations applied.
 *
 * In-memory by default (deterministic, isolated per call — the unit-test
 * path). Pass `dataDir` for file-backed persistence across process
 * restarts, used by opt-in live validation tooling. Never a production
 * dependency path.
 */
export async function createTestDatabase(
  dataDir?: string
): Promise<TestDatabaseHandle> {
  const pglite = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
  const db = drizzle(pglite, { schema });
  await migrate(db, { migrationsFolder });
  return {
    db,
    close: async () => {
      await pglite.close();
    }
  };
}
