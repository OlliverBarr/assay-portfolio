import { fileURLToPath } from "node:url";

/**
 * Absolute path to the generated SQL migrations folder. Shared by the
 * production migrator and the PGlite test harness so both apply the exact
 * same DDL.
 */
export const migrationsFolder: string = fileURLToPath(
  new URL("../migrations", import.meta.url)
);
