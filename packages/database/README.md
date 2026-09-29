# @assay/database

Drizzle ORM schema, generated SQL migrations, and repositories for the pipeline, organized by domain under `src/repositories/` (cursors, pools, snapshots, risk, holders, scoring, alerts, features, outcomes, judgment, winners-retro):

- `chain_cursor` with observed vs. safely-processed watermarks.
- `tokens` with refreshable metadata columns.
- `pools` discovered from factory events.
- `quote_assets` seeded from verified configuration.
- `pool_snapshots` append-only enrichment history.

Exports:

- `@assay/database` — production client (postgres-js), migrations, schema, and
  repositories.
- `@assay/database/testing` — in-memory or file-backed PGlite database with the
  real migrations applied; test-only. Caveat: PGlite is not the production
  driver — postgres-js rejects bare `Date` params inside raw `sql` fragments
  that PGlite tolerates (crash-looped live 2026-07-12), so serialize
  explicitly (`.toISOString()`) in raw SQL; typed column comparisons are safe.

Regenerate migrations after schema changes:

```sh
cd packages/database && bunx drizzle-kit generate --name <change>
```
