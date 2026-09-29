# Current Status

Last updated: 2026-09-29

## Portfolio status

Assay is a completed research prototype with a documented July 2026 production
trial. The production stack is intentionally paused. This repository contains
source code, tests, fictional demo data, and sanitized evidence artifacts. It
does not contain the production database, credentials, Telegram recipients, or
deployment host details.

The project is not a live service. Do not interpret historical measurements as
current coverage, expected performance, or an investment recommendation.

## Demonstrated behavior

- Factory-event discovery with a two-watermark, restart-safe cursor.
- Append-only pricing, liquidity, activity, risk, holder, score, and alert
  history.
- Deterministic eligibility and opportunity scoring with stored reasons.
- Telegram delivery with opt-in self-service subscriptions disabled by default.
- Advisory LLM briefs that run after alert delivery and require machine-checked
  citations.
- A local Fastify dashboard and a credential-free, fictional PGlite demo.
- PostgreSQL migration and cursor-watermark integration coverage in CI.

## Historical evidence

The final July 2026 production snapshot included 9,260 labeled 72-hour
$10,000–$100,000 FDV band entrants and 156 realized >=10x outcomes. The
2026-07-20 model rebuild used those rows to define four score components:
liquidity depth, buyer breadth, buy flow, and low-cap tilt.

These figures are in-sample. They are useful for explaining the system design,
but they do not validate future performance. The original production database
is intentionally private and is not required for the public demo.

## Known limits

- The model has not received an out-of-time validation run.
- The final production discovery backfill had not reached chain head when the
  stack was paused.
- Enrichment reads current pool state. It does not reconstruct pre-observation
  market history.
- Activity windows use ingestion-time timestamps and are unsuitable for
  historical backtesting claims.
- Contract verification depends on Blockscout availability. An unavailable
  explorer produces `UNKNOWN`, not `VERIFIED`.
- Funding-lineage clustering and social or narrative signals are not
  implemented.
- The dashboard has no authentication and must remain bound to localhost.

## Public-release controls

- `.env`, private runbooks, backups, TODO notes, and local agent configuration
  are ignored.
- Docker images and GitHub Actions are pinned to immutable revisions.
- CI runs type checking, linting, tests, a real PostgreSQL integration test,
  dependency auditing, Docker build validation, and a full-history secret scan.
- Production backups use owner-only permissions. Encrypt them before any
  off-host transfer.
