import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { migrationsFolder } from "./migrate.js";

import * as schema from "./schema.js";

/**
 * Driver-agnostic database handle. Both the postgres-js production driver
 * and the PGlite test driver satisfy this type, as do transactions — every
 * repository function accepts either.
 */
export type Db = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export interface DatabaseHandle {
  readonly db: Db;
  /** Apply all pending SQL migrations. Idempotent; safe on every startup. */
  applyMigrations(): Promise<void>;
  close(): Promise<void>;
}

/** Production database connection over postgres-js. */
export function createDatabase(connectionString: string): DatabaseHandle {
  const sql = postgres(connectionString, { max: 5 });
  const db = drizzle(sql, { schema });
  return {
    db,
    applyMigrations: async () => {
      await migrate(db, { migrationsFolder });
    },
    close: async () => {
      await sql.end();
    }
  };
}
