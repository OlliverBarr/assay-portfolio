# dashboard

Read-only analytics dashboard over the pipeline database. It never writes to
the database and never applies migrations (those stay the worker's
responsibility); it is off the alert path entirely, no RPC connections, no
role in delivering or gating alerts (`src/main.ts:1-8`, `src/app.ts:73-78`).

## Panels

Every route below is a thin Fastify handler that calls straight into a
`@assay/database` analytics function and returns its result; no business
logic lives in this app. All panels are population-wide aggregations, not
conditioned on what the system happened to alert on.

- `GET /api/funnel`: discovery-to-alert funnel summary, via
  `getFunnelSummary`.
- `GET /api/launches?days=`: daily launch cadence over a trailing window
  (1-90 days, default 30), via `getLaunchCadence`.
- `GET /api/precision?horizon=`: score-to-outcome precision curve at a
  fixed horizon (24h, 72h, or 168h), via `getScorePrecision`.
- `GET /api/quartiles?feature&horizon=`: quartile distribution of one
  entry-feature key at a horizon, via `getFeatureQuartiles`.
- `GET /api/survival`: survival rates by horizon, via
  `getSurvivalByHorizon`.
- `GET /api/alerts?limit=`: most recent alerts with their realized
  outcomes (1-200 rows, default 50), via `getRecentAlertOutcomes`.
- `GET /api/judgment`: judgment-brief quality summary, via
  `getJudgmentQuality`.

The app also serves its static UI (`index.html` and the vendored
`chart.umd.js`) from `/`; that is asset serving, not an analytics route.

## Run

```sh
bun run dashboard
```

This runs `bun apps/dashboard/src/main.ts` (see the `dashboard` script in
the root `package.json`). It requires `DATABASE_URL` in the environment,
the same variable the worker reads; it also reads `ROBINHOOD_CHAIN_ID`
through `@assay/chain`'s loader so it matches the worker's chain. It binds
`127.0.0.1:4600` by default; override with `DASHBOARD_HOST` /
`DASHBOARD_PORT`. There is no authentication, so keep it off the public
network.
