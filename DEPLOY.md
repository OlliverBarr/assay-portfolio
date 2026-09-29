# Deploy — Assay

Terse runbook for a fresh Ubuntu 24.04 VPS (tested on a 4GB VPS). Everything here assumes
`docker` + `docker compose` (the plugin, invoked as `docker compose`, not the
standalone `docker-compose`).

## 1. Server prep

```bash
# As root (or via sudo) on a fresh Ubuntu 24.04 host.
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker "$USER"   # log out/in (or `newgrp docker`) for this to take effect
```

**Memory: 4GB minimum, and add swap regardless.** `bun install` inside
`docker build` briefly needs more memory than the steady-state stack; on a
swapless box a rebuild while postgres/worker/deadman are running can OOM-
thrash the whole machine into SSH-unreachability (observed live on a 2GB
instance — recovery required a power cycle). The swapfile makes rebuilds
boring:

```bash
fallocate -l 3G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo "/swapfile none swap sw 0 0" >> /etc/fstab
```

Open no other ports. Postgres and the worker's internal traffic stay on the
compose-internal Docker network; nothing but SSH needs to reach this box from
the internet.

## 2. Clone and configure

```bash
git clone <repo-url> /opt/assay
cd /opt/assay
cp .env.example .env
```

Edit `.env` and fill in the required values (see `.env.example` for the full,
documented list — everything below is required unless noted):

- `ROBINHOOD_CHAIN_ID`, `ROBINHOOD_CHAIN_RPC_URL` — use a dedicated provider
  (e.g. an Alchemy `robinhood-mainnet.g.alchemy.com` URL with your API key),
  not the public rate-limited RPC. `ROBINHOOD_CHAIN_EXPLORER_URL` is optional
  but enables deployer/verification checks.
- `UNISWAP_V2_FACTORY_ADDRESS` / `_START_BLOCK`, `UNISWAP_V3_FACTORY_ADDRESS`
  / `_START_BLOCK` — verified factory addresses and deployment blocks.
- `QUOTE_ASSET_WETH_ADDRESS`, `QUOTE_ASSET_USDG_ADDRESS` (and optionally
  `QUOTE_ASSET_USDC_ADDRESS`) — allow-listed quote assets.
- `DATABASE_URL` — **host-side value only.** `.env.example` ships
  `postgres://postgres:postgres@localhost:5432/launch_radar`, used only by
  local/non-Docker tooling (e.g. running a migration script directly on the
  host). Inside `docker compose`, `worker` and `deadman` always get
  `DATABASE_URL` rewritten to `postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/launch_radar`
  (see `docker-compose.yml`) — the host-side value never leaks into the
  containers unchanged.
- `POSTGRES_PASSWORD` — `.env.example` leaves this compose-specific value
  empty. Set a unique random value. Compose uses it for PostgreSQL and for the
  in-network worker and deadman `DATABASE_URL` values.
- `RISK_V2_ROUTER_ADDRESS`, `RISK_V3_QUOTER_ADDRESS` — tradeability-simulation
  routes; leave empty only if you intend to run without live sell simulation.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — leave both empty to run in
  dry-run (alerts and dead-man pages are logged, not sent). Set both to go
  live; see `.env.example` for how to obtain them.
- Everything else in `.env.example` (poll intervals, staleness windows,
  scoring thresholds) has a sane default — override only if you know you
  want to.

Dead-man tuning (optional; defaults shown) also goes in `.env`:
`DEADMAN_CHECK_INTERVAL_MS` (60000), `DEADMAN_MAX_SNAPSHOT_AGE_MS` (600000),
`DEADMAN_REMIND_INTERVAL_MS` (1800000), and `DEADMAN_CHAT_ID` — an optional
separate Telegram chat for infra pages so a shared alert group doesn't see
ops noise.

Two more optional-but-recommended settings:

- `OPERATOR_WALLET_ADDRESSES` — your trading wallet(s), comma-separated.
  Enables automatic entry/exit detection in `bun run feedback`; without it,
  entries must be recorded manually via `bun run decide`.
- `PERFORMANCE_BAND_MIN_FDV_USD` / `PERFORMANCE_BAND_MAX_FDV_USD` (default
  $10k–$100k) — the reference band whose first crossing defines a performance
  label. Align it with your actual research range.
- `TELEGRAM_JOIN_CODE` — self-service subscriptions are disabled by default.
  Set a non-empty code to let a new chat subscribe with `/join <code>`. To
  revoke an existing subscriber, delete its row from `telegram_subscriptions`.
  The worker is the sole `getUpdates` consumer. Do not call that endpoint from
  another client.

`.env` is gitignored on purpose: it never gets committed, so it is the one
file you must provision by hand after cloning. `bun.lock` is tracked in
git, so a fresh clone on the server already has it; the Docker image
installs with `--frozen-lockfile` for a reproducible build.

## 3. Start the stack

```bash
docker compose up -d --build
```

This builds the worker image, starts Postgres (with a health check gating
the app containers), then starts `worker` and `deadman`. Migrations apply
automatically on worker startup — no separate migrate step.

## 4. Verify

```bash
docker compose ps
docker compose logs -f worker
```

A healthy startup looks like one `worker.started` line followed by repeating
`discovery.pass` / `enrichment.pass` / `activity.pass` / `risk.idle` /
`holders.idle` / `scoring.pass` / `outcomes.pass` JSON lines, each with
`"stopped":false` and no `*.crashed` or `*.halted` events. `docker compose
logs -f deadman` should show periodic `deadman.check` lines with
`"stale":false` once the worker has caught up.

**Backfill expectation:** discovery has to scan from each factory's
deployment block to the current chain head before enrichment/activity have
anything fresh to work with. Expect this to take **hours**, not minutes, on
first boot (scaled by `DISCOVERY_CHUNK_SIZE` / RPC throughput) — snapshots,
and therefore alerts, will be sparse until the cursor is near head. Alert
tiers need sustained operation on top of that: **YELLOW/GREEN verdicts require
at least 24h of continuous running** (cohort percentiles, retention windows,
and outcome labeling all need a real time series to be meaningful — a
freshly-backfilled pool has no history to score against).

**Upgrading across 2026-07-11 (stoplight rename):** migration
`0014_stoplight_levels` relabels historical alert rows automatically at
startup (RED→GREEN, ORANGE→YELLOW, YELLOW→RED). If the production `.env`
sets `JUDGMENT_MIN_ALERT_LEVEL` explicitly, update its value to the new
vocabulary (`ORANGE` → `YELLOW`, `RED` → `GREEN`) — the old names now fail
config validation at startup (a deliberate hard error, caught immediately
by the crash loop + dead-man, never a silently wrong filter).

## 5. Backups

```bash
crontab -e
# add a nightly entry that runs the backup script from the deploy directory:
# <minute> <hour> * * * cd /opt/assay && ./scripts/backup.sh
```

`scripts/backup.sh` dumps `launch_radar` via `docker compose exec`, gzips it
into `backups/`, and keeps only the `BACKUP_RETENTION_COUNT` (default 2)
newest dumps. It applies `umask 077`, creates the directory with mode 700, and
creates owner-only dump files. Retention is count-based on purpose: each dump
is a full restore point and dump size tracks DB growth, so "keep N newest"
bounds disk use no matter how large dumps get. Encrypt each dump before any
off-host transfer. Keep the decryption key outside the database host.

## 6. Updating

```bash
cd /opt/assay
git pull
docker compose up -d --build
```

Migrations auto-apply on worker startup (idempotent — safe to run against an
already-migrated database) and every service is restart-safe by design
(discovery/activity resume from their persisted cursors, enrichment/risk/
holders re-select whatever is due, dead-man state resets to "unknown" and
re-alerts if actually stale). No manual downtime steps required; a rolling
`up -d --build` is enough.

## 7. Troubleshooting

**Dead-man fired ("STALE" alert or `docker compose logs deadman` shows
`"stale":true`):**
1. `docker compose ps` — is `worker` even running, or restarting?
2. `docker compose logs --tail 200 worker` — look for a `*.crashed` or
   `*.halted` event just before snapshots stopped.
3. If the worker looks healthy but snapshots are still stale, check RPC
   connectivity (next item) and Postgres health (`docker compose ps postgres`
   should show `healthy`).
4. The dead-man's own `deadman.db_read_failed` events mean *it* can't reach
   Postgres either — check the `postgres` container and the network, not the
   worker.

**RPC 429s / rate limiting:** worker logs show repeated `*.halted` events
with a rate-limit-shaped error, or discovery/activity/risk/holders progress
stalls. Increase `DISCOVERY_POLL_INTERVAL_MS`, `ACTIVITY_POLL_INTERVAL_MS`,
and/or reduce `ENRICHMENT_CONCURRENCY`, or upgrade your RPC plan — the public
Robinhood Chain RPC is not viable for production, use a dedicated provider.

**Disk growth:** `pool_snapshots`, `pool_activity_snapshots`, and
`pool_swap_events` are append-only by design (historical accuracy). Watch
volume size with `docker system df -v`. There is currently no automatic
retention/rollup for these tables — if disk becomes a concern, prune old
rows manually (see query below) or grow the volume; do not delete
`chain_cursor` / `activity_cursor` rows, which would force a re-backfill.

**Handy `psql` queries** (via `docker compose exec postgres psql -U postgres
launch_radar`):

```sql
-- Is discovery caught up?
select chain_id, latest_observed_block from chain_cursor;

-- Most recent snapshot per pool (what the dead-man watches).
select max(captured_at) from pool_snapshots;

-- Table sizes, largest first.
select relname, pg_size_pretty(pg_total_relation_size(relid))
from pg_catalog.pg_statio_user_tables
order by pg_total_relation_size(relid) desc;

-- Recent alerts.
select * from alerts_sent order by sent_at desc limit 20;
```
