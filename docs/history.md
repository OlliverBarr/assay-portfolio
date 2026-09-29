This is the append-only development log: dated milestone narratives kept newest-first, as a
faithful record of how the system was built and operated (including incidents). It grows only
by appending new dated entries; nothing here is edited after the fact. The current snapshot
(what works today, what's next, known blockers) lives in `docs/current-status.md`.

# Development History

Last updated: 2026-07-21

## Current milestone

**MVP alert pipeline complete.** The full AGENTS.md funnel now runs end to end:
discovery -> enrichment -> activity -> risk -> holders -> eligibility ->
opportunity score -> alert. Candidates are assembled from the latest per-signal
snapshots, gated by deterministic eligibility, scored 0-100 with explainable
components, classified GRAY/RED/YELLOW/GREEN (stoplight tiers since
2026-07-11: red = early watch, yellow = research, green = go), and delivered
as deduplicated Telegram alerts (dry-run until a bot token is set). An
advisory LLM judgment layer (2026-07-11) now turns each YELLOW/GREEN alert
into an evidence-cited,
machine-verified research brief with a replay/eval harness — strictly
downstream of alert delivery, OFF unless LLM credentials are configured.

Foundations (all live-validated against Robinhood Chain mainnet):

- Discovery: V2/V3 factory ingestion, restart-safe cursor, explorer-verified.
- Enrichment: metadata, V2/V3 pricing, USDG/WETH anchoring, FDV, liquidity,
  append-only snapshots.
- Activity: swap ingestion, BUY/SELL/UNKNOWN, rolling buyer/flow windows.
- Risk: verification, proxy + privileged-permission detection, tradeability
  simulation, explainable PASS/FAIL/UNKNOWN/ERROR verdicts.
- Holders: enumeration + adjusted concentration snapshots.
- Scoring/alerts: eligibility gate, opportunity score, alert-level classifier,
  Telegram/dry-run delivery with cooldown dedup and a configurable delivery
  score floor (`ALERT_MIN_SCORE`, default 80 on the 2026-07-20 four-component
  scale; sub-floor candidates are still scored and persisted, never
  delivered).

Critical path complete (2026-07-11): trade simulation is live (verified V2
router / V3 QuoterV2 addresses, round-trip loss measurement) and deployer
provenance is implemented (Blockscout contract-creator resolution +
`deployerPctBps`). All 11 eligibility inputs are now computable, so
YELLOW/GREEN tiers (ORANGE/RED pre-stoplight-rename) are gated only by real
market conditions and continuous
worker operation — not by missing implementation.

Signals batch complete (2026-07-11): eight derived signals landed in one
contract-first parallel batch (see decisions.md) — liquidity trajectory +
LP-pull invalidation, sell-slippage curve at size, simulation regression,
float ratio, deployer serial-launch history, buy-size shape, early-buyer
retention, cohort percentiles, and the `token_outcomes` survival labeler
(the calibration dataset for future threshold revision). All feed the score,
never the gate (single exception: `liquidityNotCollapsed`).

RPC cost model fixed (2026-07-11): active-set scheduling (full cadence only
for young or watch-band pools; idle lane re-values the rest every 6h),
multicall batching (verified one `aggregate3` per concurrent read burst), and
incremental holder scans (`tokens.holder_scan_block` cursor, migration
`0007_active_set`). Projected steady-state burn ~50–90M CU/month (~$25–45 on
Alchemy pay-as-you-go) instead of scaling with all-time pool count.

Deployment + feedback scaffolding complete (2026-07-11): Dockerfile +
docker-compose (postgres/worker/deadman, restart policies, live-validated
build and healthcheck), Telegram dead-man heartbeat (live-fired), pg_dump
backup script with rotation, `DEPLOY.md` runbook, `operator_decisions`
(migration `0008_operator`) with `bun run decide` CLI, `bun run feedback`
three-quadrant report (system-hit/operator-miss, bad-entry, system-miss),
and a full `docs/execution-methodology.md` operator runbook.

**Production is LIVE (2026-07-11):** a 4GB VPS (see docs/ops-private.md,
untracked) with 3G swap added after an OOM incident on the original 2GB size
(see DEPLOY.md memory note), Alchemy dedicated RPC, docker compose (postgres/worker/
deadman), SSH-only firewall, daily pg_dump cron. Backfill reached chain head
within minutes on the dedicated RPC (~61.7k pools; the chain launches
~8–16k trusted-quote pools/day); snapshots flowing; dead-man verified
end-to-end. Alerts deliver to a shared Telegram group; dead-man infra pages
go to a separate operator chat (`DEADMAN_CHAT_ID`); the operator wallet is
registered for automatic entry/exit detection.

Population-wide performance labeling complete (2026-07-11): migration
`0009_performance` + `token_performance` — for EVERY pool whose observed
history first crossed the reference band (default $50k–$200k FDV), realized
`maxMultipleBps`/`maxDrawdownBps`/`minutesToPeak` per horizon (72h/168h)
plus the reconstructed entry-time feature vector, deliberately NOT
conditioned on alerts (see decisions.md, anti-self-fulfilling calibration).
`bun run calibrate` buckets entry features against realized multiples.

Operator trade detection (2026-07-11): `OPERATOR_WALLET_ADDRESSES` (optional
env) auto-detects the operator's entries/exits from ingested swaps; the
feedback report merges detected BUYs with recorded decisions, so manual
`decide` is only needed for intent (PASSED reasons, WATCHING) or non-watched
wallets.

Self-service Telegram subscriptions (2026-07-11): adding the bot to any chat
subscribes it to alerts (migration `0010_subscriptions`, `subscriptions`
loop as sole getUpdates consumer, fan-out delivery with per-chat isolation
and 403 auto-unsubscribe); optional `TELEGRAM_JOIN_CODE` gates activation
behind `/join <code>`. Open by default per operator choice. Test suite is
now hermetic (CLI entrypoints guarded by `import.meta.main` — previously
test imports opened real DB connections).

Judgment layer LIVE in production (2026-07-12): OpenAI credentials set
(`gpt-4.1-mini` via the OpenAI-compatible client), `judgment.pass` polling
every 30s for YELLOW/GREEN alerts. Enabling surfaced and fixed two latent
bugs, both verified with a live `validate:judgment` probe (COMPLETED,
13/13 citations): the brief response schema now sets root
`additionalProperties: false` (OpenAI strict structured outputs 400s
otherwise), and the evidence render now labels market-series fields with
exact citable property names (`estimatedFdvUsd`/`quoteLiquidityUsd` — the
old `fdvUsd`/`quoteLiqUsd` aliases made the citation checker reject honest
briefs with FIELD_NOT_FOUND). Delivery score floor also live: since deploy,
31 sub-50 candidates scored/persisted, zero delivered. The server now
tracks the `assay` repo directly (deploy key moved from the retired
predecessor repo; update = `git pull && docker compose up -d --build`).

Band-priority scheduling + tiered eligibility (2026-07-12, four parallel
subagents + Main; see decisions.md): a production audit found the funnel
structurally unable to surface anything — holder/deployer features NULL on
100% of candidates (holders budget smeared over ~14k pools, zero overlap
with scored tokens), sim UNKNOWN on 70%, score ceiling 45 < the 65
research-tier threshold (ORANGE at the time; YELLOW post-rename).
Fixes: `FdvBandCriteria` band-first bounded selection for holders/risk/
scoring (SQL-side staleness, newest-first, backlog lane for young pools;
`HOLDERS_BAND_LIMIT`/`HOLDERS_BACKLOG_LIMIT`/`RISK_BATCH_LIMIT`), scoring
selection band-only, eligibility tiered (safety rules stay hard; unique-
buyers/deployer/top-10 demoted to advisory `softFailedRules` shaping the
score), throttled GRAY shadow-logging (`SCORING_SHADOW_INTERVAL_MS`) to
build the calibration dataset. Two live-found rollout fixes: bare `Date`
params in raw `sql` fragments crash postgres-js though PGlite tolerates
them (serialize explicitly), and dead pools whose final FDV froze in-band
bloated the band to 3.2k pools — shadow-logging is gated on hourly buyer
liveness (146 live at audit). Verified live post-deploy: ownership/sim
features present on candidates, first eligible candidates ever, max score
67, first research-tier alert delivered (score 71, holder coverage 0 → 194
band
tokens in the first 12 minutes). 653 tests.

Winners retro v1 (2026-07-12, three parallel subagents + Main; design brief
in session artifacts): hourly funnel leak-attribution over realized winners.
`token_performance` gained a provisional 24h horizon (default now 24/72/168);
every wick>=5x band-crosser is evaluated once (append-once
`winner_retro_items`, migration `0013_winners_retro`) — sustained
15-min-bucket multiple + exit quote liquidity refine the wick, the 7-tier
coverage ladder attributes the FIRST failing pipeline stage (T2 census counts
structurally-invisible untrusted-quote launches), gate attribution prefers
as-of shadow rows with pure-replay fallback. Event-driven HTML digest to the
ops chat (`WINNERS_RETRO_CHAT_ID` -> `DEADMAN_CHAT_ID` -> main) fires only on
NEW qualifying winners (>=5x sustained, >=$15k exit liq; env-tunable);
`bun run retro:winners` is the weekly deep-dive. Hypothesis generator only —
threshold changes still require the scoring-model.md change protocol with
out-of-time validation (operator ritual + v2 roadmap in
docs/execution-methodology.md §7). 684 tests.

**Production incident RESOLVED (2026-07-11):** the worker crash-looped on
`MAX_PARAMETERS_EXCEEDED` (~60s after every restart) and the dead-man
correctly paged snapshot staleness. Root cause: active-set youth was
measured by `discovered_at`, so the backfill stamped all ~62k historical
pools as "young" — the full-cadence lane degenerated to the entire
population (hours-long enrichment passes overnight, starving fresh
launches), and once discovery pushed the count past 65,533 the one-param-
per-pool token lookup exceeded the postgres.js bind cap. Fixed (commit
`00a499d`, see decisions.md): youth is now `created_at_block` vs a
timestamp-binary-searched cutoff (`findBlockNumberByTimestamp`, cached
5min); every population-scaled query/insert is chunked (30k params / 2k
rows); due-for-outcome/performance first-snapshot scans aggregate in SQL.
Production `.env` sets `ACTIVE_POOL_MAX_AGE_HOURS=24` (~11k-pool active
set vs ~35k at 72h). Verified live post-deploy: zero crashes, snapshot age
<1s, 306 snapshots in 5min, dead-man `stale:false`. 457 tests.

VIRTUAL quote-asset expansion (2026-07-12, three parallel subagents; see
decisions.md): VIRTUAL (`0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31`) joins
WETH/USDG/USDC as a trusted quote asset, confirmed canonical by Virtuals
Protocol's own whitepaper (docs/data-sources.md) and empirically dominant —
3,156 discovered pools already pair against it. VIRTUAL classifies last in
preference order, so an existing VIRTUAL/WETH pool still quotes WETH.
VIRTUAL/USD resolves at read time through the deeper of the VIRTUAL/USDG or
VIRTUAL/WETH pool (chained through `wethUsdWad` on the WETH side), gated by
a $50k anchor-depth floor — below it, VIRTUAL-quoted pools fall back to the
existing null `no-usd-anchor` snapshot rather than price off a drained
pool. `renormalizeUntrustedPools` (packages/database), a generic idempotent
startup reconcile rather than a one-off migration, backfilled ~3,156
pre-existing VIRTUAL-quoted pools whose quote side had been null and will
pick up any future allow-list addition automatically. USDC remains
correctly un-listed — still absent from both Circle's and Robinhood's own
canonical token registries. Verified live post-deploy: 3,164 pools
renormalized at boot, untrusted census 3,316 → 163, VIRTUAL-quoted pools
snapshotting USD values (first agent token at $174k FDV now visible to the
funnel). Same batch, operator-requested message polish: research briefs
lead with the escaped token name, and pool addresses no longer render in
any Telegram message (the chart URL still encodes the pool). 697 tests.

Score recalibration (2026-07-11; see decisions.md and the change-protocol
entry in docs/scoring-model.md): the 0–100 opportunity score is now six
components whose maxima are all attainable (liquidity 30, organic buying
20, holders 15, ownership 15, wallet 10, transparency 10) — the old scale's
true ceiling was 79 with ~25–30 unconditional baseline points, so scores
compressed into 50–79 and the top tier (RED then, GREEN now) was
structurally dead. `priceStructure` and
`projectEvidence` removed until real signals exist; liq/FDV ratio now uses
quote (not token-side-inflatable total) liquidity; 20m flow is counted
once (was double-counted with priceStructure), dust-guarded (min 5 buys +
5 unique 20m buyers), and strict-parsed (malformed volume withholds points
instead of silently reading as 0n inflow). The 65/75 tier thresholds kept —
now 65%/75% of an attainable range. `ALERT_MIN_SCORE` default 50 → 60
(operator request: ~5–10 compelling deliveries/day; first-week volume
should be checked and the floor tuned ±5). jsonb components need no
migration; historical rows keep the old eight-key vector. 710 tests.

Stoplight tiers + brief dedup (2026-07-11; see decisions.md): alert levels
renamed to stoplight logic — GREEN (go; was RED), YELLOW (research; was
ORANGE), RED (early watch; was YELLOW), GRAY unchanged — with migration
`0014_stoplight_levels` relabeling all historical rows so one vocabulary
exists everywhere (mapping smoke-verified against seeded legacy rows).
`JUDGMENT_MIN_ALERT_LEVEL` now takes RED|YELLOW|GREEN (default YELLOW); an
explicit legacy value in prod `.env` hard-fails at startup (DEPLOY.md
upgrade note). Also fixed the operator-reported repeat research briefs:
brief dedup was per-alert, so every re-alert re-briefed the token —
`listAlertsNeedingBrief` now suppresses per token via
`JUDGMENT_REBRIEF_COOLDOWN_MS` (default 24h; level escalations bypass;
FAILED/REJECTED briefs never suppress; 0 disables). 716 tests.

Recalibration + stoplight DEPLOYED to production (2026-07-12, commit
`baa39bc`): prod `.env` floor updated 50 → 60, `git pull` + compose rebuild,
zero crash/halt events, dead-man `stale:false`. Live-verified: migration
0014 relabeled all rows (`alerts_sent` 65 RED + 26 YELLOW, zero legacy
strings), new-scale scores flowing (top of book 73/72/71 YELLOW within
minutes of restart), judgment loop briefing under the per-token gate. One
brief came back REJECTED_FABRICATED_CITATION on the first pass — the
citation checker blocking delivery as designed; watch whether rejections
recur (`bun run judge:report`) before suspecting the renamed evidence
fields.

Alert-noise batch (2026-07-12; see decisions.md, two entries): a post-deploy
audit of `alerts_sent` confirmed the delta gate holds (zero same-level
repeats without +10). Two residual noise sources fixed at the delivery
layer (never eligibility/scoring):

- Escalation pairs — 13 of ~58 alerted tokens in 9h paged RED then YELLOW
  20–40min apart. RED (non-actionable early watch) now carries its own
  delivery floor `ALERT_MIN_SCORE_RED` (default 70, effective floor is max
  with `ALERT_MIN_SCORE`, 0 disables; operator-selected over dropping RED
  delivery). Winners-retro T6 attribution mirrors the level-aware floor.
- Copycat waves — operator-reported "robinworld ×5 in 15min" was four
  DISTINCT same-named contracts, each a legitimate per-token first alert
  (launch-farm spam). New duplicate-name delivery cooldown
  (`ALERT_DUPLICATE_NAME_COOLDOWN_MS`, default 6h): a same-named sibling
  delivers only if it outranks the delivered one; the wave replays to 1
  ping combined with the RED floor.

Suppressed candidates in both cases stay scored/persisted; a later
escalation delivers normally. Alert headers are now glyph + token name
only (`🟡 Token (SYM)` — the color IS the level). 731 tests.

Quiet-week floor (2026-07-12, operator request before a week of unattended
data collection): `ALERT_MIN_SCORE` 60 → 75, default + prod `.env`
(applied live via env-only container recreate; the RED-floor/name-dedup
code deployed with the hygiene rebuild later that day). Chosen from live
volume: the prior 10h delivered 80 alerts at floor 60, 10 at 70, 2 at 75 —
75 ≈ ~5/day, only GREEN-threshold scores whatever the tier. Everything
below the floor is still scored and persisted, so the week's calibration
labels accumulate at full breadth regardless. `ALERT_MIN_SCORE_RED` (70)
is inert while the global floor exceeds it.

Performance-labeling starvation fixed (2026-07-12; see decisions.md):
pre-check-in audit found `token_performance` frozen at 13 rows
(`labeled:0 skipped:200` hourly) — the due-batch was permanently occupied
by the 200 oldest never-band pools, which the pass skips without
persisting anything. `getPoolsDueForPerformance` now requires an elapsed
in-band priced snapshot via SQL EXISTS, so only real band entrants (1,746
of 76,771 pools at audit) enter the due-set. Without this, `calibrate` and
the winners retro would have had a near-empty dataset at the week
check-in. 732 tests.

Portfolio release hygiene (2026-09-29): the public portfolio repository is
published from a new root commit, separate from private deployment history.
It contains no production host identifiers, credentials, recipient data, or
operator runbooks. Full-history secret scanning and dependency auditing run in
CI before merge.

Tool-call citations fixed — the 53% brief rejection rate was a contract
bug, not fabrication (2026-07-12; see decisions.md): 110 of 128 failed
citations were the model citing history-tool outputs it had no citable
anchor for (every `functions.*` pointer failed structurally) or
tool-computed field names against `pool_snapshots` rows. Fix: the engine
labels every tool message with `callRef: "judgment_tool_calls:<seq>"`,
`checkCitations` resolves those pointers against the audited in-memory
trace (never re-executing time-sensitive tools), migration `0015` persists
the tool result body for replay-time re-verification, jsonb-array claims
(riskReasons) verify on exact single-element membership, and the prompt's
evidence section now names exactly two citable source kinds — the template
hash mints a new prompt version at startup, keeping eval slices
per-version comparable. DEPLOYED 2026-07-13 (commit `24c2a55`): migration
0015 applied, prompt v2 minted, live `validate:judgment` probe COMPLETED
13/13 citations (using `deployerHistory` + `baseRateForPattern` — the two
always-failing tools pre-fix). 742 tests.

First replay eval batch (2026-07-13, same night): `bun run judge:replay
--horizon=24` generated 46 REPLAY briefs under prompt v2 (~6.5k tokens
each), the first-ever population on the replay path. Measured against the
v1 LIVE baseline via `judge:report`: fabrication-rejection rate 50.0%
(Wilson 33.6–66.4) → **17.4%** (Wilson 9.1–30.7) — non-overlapping
intervals, real improvement — and median tool calls per brief doubled
3 → 6 (research is now citable instead of punishable). Cross-version tag
metrics are population-confounded (LIVE = alert-gated tokens, REPLAY =
random band entrants); compare within-mode only. Residual rejections are
one clean class: ~22 of 25 failed citations cite bundle-HEADER metadata
(`createdAtBlock`, `totalSupply`, `dex`, `deployerStatus`) that render.ts
shows without table:id refs because `pools`/`tokens` are mutable and
deliberately non-citable — same contract-contradiction family as the tool
gap, one layer up (see Next). Also surfaced: stated confidence pins at
5000bps regardless of evidence (realized 24% in the 50–60 bucket), so
Brier sits at ~0.25 — calibration is the top quality frontier for any
trained model.

Focus band lowered to $10k–$100k (2026-07-13; see decisions.md and the
change-protocol entry in docs/scoring-model.md): operator decision to
replace the ~$40k–$300k watch / $75k–$250k eligibility / $90k–$225k research
band with $10k–$100k, since ingestion and enrichment already capture and
price every trusted-quote pool at any size — only the eligibility/alert
gates needed to move. New defaults: eligibility FDV $10k–$100k (liquidity
$5k total / $2.5k quote, 15 unique buyers), alert RED $10k–$40k ($3k
liquidity, 8 buyers), YELLOW $40k–$100k ($5k liquidity), GREEN $50k–$90k
(25 buyers), watch band $10k–$120k (kept above the eligibility ceiling for
the same headroom reason as the old 300k-vs-250k gap). Safety caps
(min age, max sell loss, max deployer%, max top-10%) and the 65/75 score
gates are unchanged on purpose — a smaller FDV band is not a safer one.
`scoreLiquidityQuality`'s quote-depth tiers (the only band-coupled score
constant) were rescaled from $10k/$15k/$25k/$50k/$100k to
$2.5k/$5k/$10k/$20k/$30k so the 30-point liquidityQuality ceiling stays
attainable inside the new band (old top tiers exceeded the whole band).
All fifteen eligibility/alert thresholds are now env-configurable
(`ELIGIBILITY_*`, `ALERT_RED_*`/`ALERT_YELLOW_*`/`ALERT_GREEN_*`) and
threaded through every caller of the eligibility/scoring/alert-level trio
(scoring pass, winners-retro pass, `validate:candidate` CLI), closing a
prior violation of types.ts's own "must stay configurable" invariant.
`RISK_SLIPPAGE_CURVE_NOTIONALS_USD` moved 500/2000/5000 → 100/500/2000 and
`PERFORMANCE_BAND_MIN/MAX_FDV_USD` moved $50k/$200k → $10k/$100k so the
calibration dataset labels the pools now alerted on. These are initial
engineering-chosen assumptions, not backtested — pending out-of-time
validation against `token_performance`/`bun run calibrate` once labels
accumulate in the new band, per the scoring-model.md change protocol.
DEPLOYED to production same day (commit `a0f435d`): prod `.env` had two
stale explicit overrides that would have silently pinned the old values —
`RISK_SLIPPAGE_CURVE_NOTIONALS_USD=500,2000,5000` and
`PERFORMANCE_BAND_MIN/MAX_FDV_USD=50000/200000` — fixed, and all seventeen
band keys (`WATCH_*`, `ELIGIBILITY_*`, `ALERT_RED_*`/`ALERT_YELLOW_*`/
`ALERT_GREEN_*`, plus the two above) pinned explicitly per the
`ALERT_MIN_SCORE` convention (pre-change backup at `.env.bak-20260713`);
`git pull` + compose rebuild, postgres untouched. Verified live
post-deploy: `worker.started` reports `watchFdvBandUsd 10000-120000` and
`performanceBandUsd 10000-100000`, zero crash/halt events, and the first
10 minutes of scoring passes produced 20 RED candidates at $10.6k–$37.6k
FDV — sub-$40k pools scored above GRAY for the first time ever — plus 3
YELLOW at $53k–$93k. Delivery remains gated by `ALERT_MIN_SCORE=75`
(effective RED floor max(75, 70)), so the feed only pages on
GREEN-threshold scores whatever the tier.
Quote-asset allow-list expansion (capturing non-trusted-quote launches) was
explicitly scoped out — it is a separate `packages/chain`/`packages/database`
effort, not a band question.

Alchemy CU-exhaustion incident — crash-loop fixed (2026-07-13; see
decisions.md): the compute-unit balance hit zero and the worker
crash-looped (~10s restart cycle) for the outage instead of backing off —
enrichment was the only loop wired `isRecoverable: () => null`, and
Alchemy's capacity errors (JSON-RPC code `429` "Monthly capacity limit
exceeded" on an HTTP 200, and `-32001` → viem `ResourceNotFoundRpcError`
"Unable to complete request at this time", both captured from prod logs)
were not classified transient, so no `RetryExhaustedError` ever formed.
Fixed both: new `EnrichmentHaltError` wraps the pass-level head-block and
anchor reads (uniform with discovery/activity/risk/holders halts) and the
worker loop now logs `enrichment.halted` + backs off 4× the poll interval;
`isTransientRpcError` now treats both observed capacity signatures as
transient. Auth failures (401/403) deliberately stay fatal — a bad key
must page, not silently loop. Data impact: discovery + swap ingestion
auto-backfilled from cursors once credits returned (zero action);
enrichment/holder snapshots during the outage window are a permanent gap
(live point-in-time reads; archive-replay reconstruction documented as
on-demand contingency only). A commented "Low-CU profile" block in
`.env.example` documents the burn-reduction overrides
(`ACTIVE_POOL_MAX_AGE_HOURS=12` is the dominant lever; freshness
tradeoffs annotated per key) for the operator to apply to the prod `.env`.
753 tests. DEPLOYED same day (commit `3fc8236`, 2026-07-14 UTC): `git
pull` + compose rebuild; worker `Up` with `restarts=0` and zero
crash/halt events post-deploy. The low-burn profile was applied to the
prod `.env` in the same recreate (pre-change backup `.env.bak-20260714`;
all seven keys echoed back in `worker.started`). Observed effect: activity
scan cycle ~33s → ~73s and enrichment/holders pass rates cut ~33% as
expected, but the age lever underdelivered — `activePools` only fell
12,762 → 10,838 (~15%), because since the 07-13 band lowering the active
set is dominated by watch-band pools ($10k–$120k), not young ones. Most
of the CU savings therefore come from the interval stretches; if the
Alchemy dashboard still shows insufficient CU/day drop, the next real
lever is the watch band itself (`WATCH_*`) — a product gate, operator
decision only. Known freshness costs while the profile is active:
YELLOW/GREEN alert latency up to ~30 min worse (holders staleness 30m is
the binding term), sub-$10k pools crossing into band after age 12h are
seen up to ~12h late (idle lane), and `token_performance` peaks for
winners that run above the $120k watch ceiling get sampled on the 12h
idle lane (peak underestimation bias in the calibration set).

Band-lane quote-liquidity floor (2026-07-14; see decisions.md): post-top-up
the Alchemy dashboard showed CU burn near DOUBLE the pre-band-move rate,
dominated by `eth_getLogs`, despite the low-CU profile. Diagnosis: the
$10k FDV floor admitted a large dust tail into the watch band (estimated
FDV is nominal, price x supply), and every never-scanned band entrant
triggered a cold holder scan walking its FULL transfer history from pool
creation in 2,000-block chunks, 300 pools per holders pass; the holders
and risk band lanes are FDV-scoped, so no low-CU knob bounded them. Fix:
`BAND_LANE_MIN_QUOTE_LIQUIDITY_USD` (default $500, 0 disables) now gates
the holders/risk BAND lanes on latest-snapshot quote liquidity. Nothing
alertable is lost (eligibility needs $2.5k quote); labeling, pricing,
scoring, shadow-logging untouched, so the calibration set keeps its
population (sub-floor entrants just carry null holder features). Also
`HOLDERS_SCAN_CHUNK_BLOCKS` (default 2,000) is now env-tunable; the
low-CU profile suggests 10,000 (5x fewer calls per cold scan) plus
`HOLDERS_BAND_LIMIT=100` while the cold backlog drains. Raising
`WATCH_MIN_FDV_USD` to $20k was considered and kept in reserve as a pure
env lever: it cuts the low-cap entrants the product targets and dust
clears any FDV bar anyway. 756 tests. DEPLOYED same day (commits
`7568f97` + `2760003`): prod `.env` backup `.env.bak-20260714-floor`,
keys `BAND_LANE_MIN_QUOTE_LIQUIDITY_USD=500`,
`HOLDERS_SCAN_CHUNK_BLOCKS=10000`, `HOLDERS_BAND_LIMIT=100` (backlog
drain cap; restore 300 once the dashboard hump clears); all three
verified in the running container (first two echoed in `worker.started`,
third via container env). The rebuild surfaced a disk-full failure:
`backups/` (2.8G of pg dumps) was inside the docker build context and
baked into every worker image; `.dockerignore` now excludes it
(`2760003`), and pruning build cache + dangling images freed ~7G
(disk 78% -> 68%). Worker up post-deploy, zero crash/halt events.
Alchemy account still unfunded at deploy time; RPC loops back off until
credits return (expected). Operator follow-ups: fund Alchemy, run the
dust-sizing query (count band pools above/below the floor), re-check the
dashboard getLogs series ~24h after credits land.

Winners-retro replay path revived (2026-07-15; see decisions.md): the
first weekly retro reported T4 signals-missing as the dominant leak tier
(33 of 76 winners) with T7 caught = 1. Production forensics on radar-1
showed the outage windows explained none of it (entries are defined by
observed snapshots, so downtime displaces entries rather than creating
T4s); the real cause was a write/read shape mismatch: `buildEntryFeatures`
(performance-pass) stores a compact 15-field vector, but the retro's
replay parser validated against the full `CandidateFeatures` shape, so
EVERY replay parse failed and any winner without a shadow decision within
±2h of band entry collapsed into T4 — the replay branch was unreachable
in production, hidden by tests seeding the shape production never writes,
behind an untyped jsonb boundary. Fix: `PerformanceEntryFeatures` now
carries every eligibility-gate input (20m activity, risk permissions via
the shared `hasCriticalPermission` helper, holder detail);
`parseEntryFeatures` is its strict read-side inverse; and
`replayCandidateFeatures` rebuilds the entry-time `CandidateFeatures`
(identity/price from the `token_performance` row, missing-source defaults
mirroring `assembleCandidate` exactly; retroactively-unreconstructable
signals stay null and only lower the replayed score, never a gate). A
jsonb round-trip contract test now pins the write/read shapes together.
Known limits: rows labeled with the legacy shape parse to null by design
(guessing `criticalPermissionPresent` could fabricate a verdict) and stay
T4 — expect T4 to drop to ~0 and honest T5/T6 attribution only for
winners labeled AFTER deploy; and replayed scores are conservatively
biased low versus live (nulled trajectory/cohort signals), which slightly
overfills T6 relative to T7 on replay-sourced rows. 763 tests.

**Production incident RESOLVED (2026-07-16): oversized getLogs response
crash loop** (see decisions.md). The worker crash-looped every ~6 minutes
for 4.7h (46 restarts, `pool_snapshots` frozen at 22:06 UTC, dead-man
correctly paging STALE with 30-min reminders) while Alchemy credits were
untouched: a dense swap stretch from block 11602049 pushed the activity
pass's 2000-block getLogs response over viem's 10 MiB
`maxResponseBodySize` cap, and `ResponseBodyTooLargeError` was neither
transient (correct), halt-wrapped, nor recoverable, so `Promise.all`
exited the process with the activity cursor pinned at the poison range.
Retro digests kept delivering between reminders because fast DB-only
loops finished passes inside each crash window; enrichment over the 21k
active pools never did (every pass died `stopped:true`, 0 snapshots).
Emergency mitigation live the same night: `ACTIVITY_CHUNK_SIZE` 2000 →
250 to clear the poison stretch, then 1000 for catch-up (worker
recovered, dead-man `stale:false`, cursor advancing). Durable fix:
`fetchLogsBisectingOversized` (packages/chain) recursively halves a
block range whose response overflows the cap (sequential halves,
block-order concatenation, wrapped-cause detection; a still-oversized
single block rethrows loudly), wired into `createRpcLogSource`
(discovery + activity) and the holders transfer scan. 770 tests.
DEPLOYED 2026-07-17 (commit `cb39679`): git pull + compose rebuild on
radar-1, `ACTIVITY_CHUNK_SIZE` reverted 1000 → 2000 (chunk size is a
pure throughput knob again). Live-verified post-deploy: zero
crashes/halts, dead-man `stale:false`, snapshot age <1s, activity
draining the outage backlog at ~2,000 blocks/min (~3x chain rate,
~2h to head).

**Production incident RESOLVED (2026-07-19): disk-full postgres PANIC**
(see decisions.md). The root disk hit 100% (38G), postgres died mid-
checkpoint (`PANIC: could not write to file
"pg_logical/replorigin_checkpoint.tmp": No space left on device`) and
stuck in a crash-recovery loop, the worker crash-looped on
`PostgresError` every ~60s for ~12h, and the dead-man correctly paged
"database read failed" (its own DB read failing, per the DEPLOY.md
troubleshooting table). Root cause: `scripts/backup.sh` age-based
retention (14 days) no longer fit the disk — each nightly pg_dump is a
FULL dump whose size tracks DB growth (217M on 07-12 -> 2.8G on 07-19
compressed), so `backups/` reached 12G beside the 17G database.
Rotation itself was working; the retention policy was structurally
unbounded in bytes. Recovery: deleted all but the two newest dumps
(each is a complete restore point; freed ~6.7G), postgres finished
crash recovery cleanly on its next restart-loop attempt, worker came
up, discovery drained the ~437k-block backlog in minutes, snapshots
resumed, dead-man sent the recovery page (15:37 UTC). Durable fix:
backup.sh retention is now count-based — keep the
`BACKUP_RETENTION_COUNT` (default 2) newest dumps — bounding backup
disk use by construction regardless of dump growth; hotfixed onto
radar-1 directly (same content, so the next `git pull` is clean).
**Open runway risk:** the DB itself grows ~2G/day (pool_snapshots
8.6G, pool_swap_events 6.0G of 17G total) and the disk had ~5G free
post-recovery — without a bigger disk or a snapshot/swap-event
retention decision, the disk fills again within roughly a week. See
Next.

On-demand Telegram scorecards (2026-07-19): pasting a token contract
address into any ACTIVE-subscribed chat (or sending `/score 0x...`) now
returns an explainable scorecard: level glyph, score with all six
components, eligibility failures and quality flags, FDV/liquidity/age,
buyers, sim/risk statuses, top-10 concentration, and a snapshot-age
"Data:" line. Same code path as the live scoring pass
(`assembleCandidate` -> eligibility -> score -> level, worker-tuned
config), persisted signals only; a chat message can never spend RPC
credits, and out-of-band tokens render as GRAY instead of being hidden
(no FDV band gate on lookups). Handled inside the existing
subscriptions loop (`score-request.ts`; ACTIVE chats only, canned
failure reply + collected update error on builder crash), backed by a
new bounded `listTrustedQuotePoolsForToken` query that
`validate:candidate` now reuses instead of sweeping all trusted pools.
Same batch: private chats gained an activation path. Groups activate
via my_chat_member on add, but Telegram fires no such event for DMs, so
/score in a DM was structurally unreachable. `/start` is now an alias
of `/join`, and with no join code configured either command activates
a non-ACTIVE chat directly (code-gated behavior unchanged: PENDING +
hint until the correct `/join <code>`). DMing the bot `/start` then
`/score 0x...` works out of the box. 788 tests.

**Next:**
- **URGENT — disk runway (days, not weeks):** radar-1's 38G disk was at
  ~86% after the 2026-07-19 recovery with the DB growing ~2G/day
  (pool_snapshots 8.6G + pool_swap_events 6.0G of 17G). Operator
  decision needed before ~2026-07-24: resize the Hetzner volume (no
  product tradeoff), or define a retention/rollup policy for old
  snapshot/swap rows (product tradeoff: AGENTS.md wants append-only
  history; never touch chain_cursor/activity_cursor). Off-site backup
  copy (below) would also stop backups competing with the DB for the
  same disk.
- **REMIND OPERATOR (2026-07-21, first session): post-rebuild deploy checks.**
  Surface this unprompted at the start of the session. The 2026-07-20
  model rebuild deployed to radar-1 at 2026-07-21 00:39 UTC (commit
  68c1714; prod `.env` tier/floor keys updated, timestamped `.env.bak-*`
  on the box).
  1. **Confirm the scoring loop is cycling.** At sign-off (~45 min after
     restart) the first `scoring.pass` completion event had NOT yet
     fired; the pass was verifiably making forward progress (85 pools,
     85 rows, max 1 row/pool, queries cycling in seconds, zero
     crashed/halted/error lines), consistent with a long first sweep of
     the due backlog. Check `docker compose logs worker | grep
     scoring.pass`: expect regular completions. If still none, the pass
     is structurally outrunning its 60s cadence under the widened RED
     tier (more non-GRAY candidates persist per pass) and needs
     investigation, not waiting.
  2. **First-day alert volume vs the ~5-10/day precision tilt.** Run the
     alerts_sent per-day query (scoring-model.md, Delivery score floor)
     and tune `ALERT_MIN_SCORE` (currently 80) ±5, floor first, never
     weights. Discount the restart burst: 8 delivered in the first
     minutes (2 GREEN, 6 YELLOW) was backlog, not steady state.
- **REMIND OPERATOR (~2026-07-15/16, first session after Alchemy funding):**
  once the dashboard getLogs hump from the cold-scan backlog clears,
  restore `HOLDERS_BAND_LIMIT=300` in the prod `.env` (env-only
  `docker compose up -d`, no rebuild). Full checklist incl. the
  dust-sizing SQL lives in the operator's untracked root `TODO.md`.
  Surface this unprompted at the start of the session.
- Week check-in (~2026-07-19): pooled `bun run retro:winners` +
  `bun run calibrate` + `bun run feedback` + `bun run judge:report`, then
  at most ONE change-protocol investigation per the
  formula-change checklist (docs/execution-methodology.md). Floor 75 and
  all four commands live-verified working 2026-07-12; `token_performance`
  starvation fixed the same day. **Formula re-weighting caveats
  (2026-07-19):** (a) the baseline week contains THREE ingestion gaps —
  Jul 13–14 (Alchemy CU exhaustion), Jul 16 (~4.7h getLogs crash loop),
  Jul 19 03:17–15:37 UTC (disk-full incident) — enrichment/holder
  snapshots in those windows are permanent gaps, so `maxMultipleBps`/
  `minutesToPeak` are biased LOW for any pool whose peak fell inside one,
  and band entries during a gap are displaced to the first post-recovery
  snapshot; population quartiles absorb this, individual recent winner
  multiples are lower bounds. Record the three gaps in the
  scoring-model.md change-protocol entry so the before/after comparison
  isn't misread. (b) Resize the radar-1 disk (URGENT item above) BEFORE
  deploying the re-weight: the out-of-time validation window needs clean
  post-change label collection, and at ~2G/day the disk fills ~Jul 24,
  mid-window; the rebuild itself also eats into the 5G free.
  Two low-CU-profile checks added to the agenda (2026-07-13):
  1. Alchemy dashboard CU/day — if headroom is comfortable, restore
     `HOLDERS_STALENESS_MS=900000` FIRST (the alert-latency-critical
     knob, cheap relative to the enrichment set), then
     `ACTIVE_POOL_MAX_AGE_HOURS=24`; leave the interval stretches last.
  2. `bun run feedback` — late entries on fast movers are the signal the
     holders-staleness stretch is costing alert latency; if seen, restore
     `HOLDERS_STALENESS_MS=900000` immediately rather than waiting for
     the check-in.
- Bundle-header citations — close the residual ~17% brief rejection rate:
  pool/token metadata in the evidence header renders without table:id refs
  (mutable tables, deliberately non-citable), so the model attributes
  those fields to snapshot rows and gets rejected. Fix pattern proven by
  the callRef work: verify against what the model was shown — persist the
  assembled bundle (or tag header fields with their as-of snapshot refs
  where one exists) and resolve a virtual header source in
  `checkCitations`. Trigger: none — design ready, ~22 of 25 residual
  failures.
- Accumulate calibration labels toward out-of-time threshold validation,
  and design the funding-lineage clustering whitelist (bridge/CEX
  funders) — ongoing, no external trigger.
- Judgment-model training loop (RL-as-a-service, e.g. Prime Intellect;
  assessed 2026-07-12): wrap the replay harness as an RL environment —
  episode = as-of evidence bundle for a labeled band entrant, reward =
  machine-verified citations + realized-outcome scoring (Brier/calibration/
  per-risk-tag P/R) + canary penalties; serve any trained adapter through an
  OpenAI-compatible endpoint so the judgment loop swaps models by env var.
  Staged, by data sufficiency (live counts 2026-07-13: 1,399 labeled
  band entrants accruing ~1.1k/day, 13 realized ≥5x winners, briefs
  35 COMPLETED / 40 REJECTED_FABRICATED_CITATION — a 53% fabrication-
  rejection baseline for gpt-4.1-mini):
  1. Eval benchmark: run `judgment_eval_runs` (currently zero) over the
     labeled episodes; benchmark small open models vs gpt-4.1-mini on
     fabrication rate + Brier — trigger: none, data sufficient now.
  2. SFT/LoRA v1 — trigger: ~10k episodes + ~100 winners (~2026-07-20+).
  3. RL with out-of-time validation per the scoring-model.md change
     protocol — trigger: ≥4 weeks of labels spanning distinct market
     regimes (~2026-08-10 earliest); regime diversity, not volume, is
     the binding constraint.
- Web-facing project-evidence existence checks — trigger: one clean
  reliability week.
- Uniswap V4 ingestion (PoolManager
  `0x8366a39cc670b4001a1121b8f6a443a643e40951`; live-measured ~7k
  `Initialize` events/day) — trigger: VIRTUAL expansion proves stable in
  production and a hooks safety story is designed.
- Canonical USDC — trigger: Circle or Robinhood lists a chain-4663 USDC
  address.
- External uptime heartbeat (healthchecks.io cron ping; catches box-down
  failure, since the in-process dead-man dies with the box) — trigger:
  operator supplies the ping URL.
- Off-site nightly backup copy (pg_dump backups currently live on the same
  disk as the data) — trigger: none — ready to schedule.

## Completed

- Chain constants verified from primary sources (docs/data-sources.md).
- `@assay/chain`, `@assay/database`, `@assay/discovery` (see decisions.md).
- `@assay/enrichment`: adversarial token metadata reads, WAD fixed-point price
  math, USDG/WETH USD anchoring, V2 reserve pricing, V3 `slot0.sqrtPriceX96`
  pricing, FDV/liquidity calculations, append-only `pool_snapshots`, and
  per-pool error tolerance.
- `@assay/activity`: V2/V3 swap decoding, trusted-quote base/quote
  normalization, BUY/SELL/UNKNOWN side classification, idempotent append-only
  `pool_swap_events`, restart-safe `activity_cursor`, and append-only
  `pool_activity_snapshots` for 20-minute and 1-hour buyer/flow windows.
- `@assay/risk-engine`: explorer verification classification, proxy detection
  (EIP-1967/beacon/legacy slots), bytecode privileged-permission detection
  (mint/blacklist/pause/transferTax/ownership/upgradeAdmin), route-quote
  tradeability simulation, explainable `assessRisk` verdicts, read-time
  `STALE` labeling, restart-safe staleness-based selection, append-only
  `token_risks` + `trade_simulations`, and `RiskHaltError` on RPC exhaustion.
- `@assay/holders`: ERC-20 Transfer-log holder enumeration, pure balance
  netting + adjusted concentration in basis points (excluding pool/zero/burn),
  append-only `token_holder_snapshots` + `token_holders`, restart-safe
  selection, `HolderHaltError` on RPC exhaustion.
- `@assay/scoring`: deterministic `evaluateEligibility` (all 11 rules),
  `scoreOpportunity` (explainable 0-100 components), `classifyAlertLevel`
  (GRAY/RED/YELLOW/GREEN stoplight); pure, config-driven, missing data never passes.
- `@assay/alerts`: `formatAlert`, cooldown-based `evaluateAlert` dedup,
  dry-run + Telegram transports (`AlertDeliveryError` on non-OK).
- `@assay/worker`: entrypoint applying migrations, seeding quote assets, and
  running six loops (discovery, enrichment, activity, risk, holders,
  scoring/alerts) with structured JSON logging, classified halt-backoff, and
  graceful shutdown at safe boundaries; env-driven tuning with hard-fail
  validation; candidate assembly joining the latest per-signal snapshots.
- Opt-in live scripts: `validate:range`, `validate:swaps`, `validate:risk`,
  `validate:candidate` (assemble+score+level, no send), `validate:telegram`
  (send one test alert), and `enrich:once` bounded smoke.
- Trade simulation live: verified UniswapV2Router02 + QuoterV2 addresses
  (docs/data-sources.md), quote-based round-trip probe with sell-leg spot
  baseline so `effectiveSellLossBps` is always measured on success.
- Deployer provenance: migration `0005_deployer` (tokens.deployer_address /
  deployer_status / deployer_checked_at), Blockscout `getcontractcreation`
  with bounded retry, lazy hourly-paced resolution in the holders pass,
  `deployerPctBps` on the same adjusted denominator as `adjustedTop10PctBps`,
  opt-in `validate:deployer` script.
- Test suite: 457 tests across chain, database, discovery, enrichment,
  activity, risk-engine, holders, scoring, alerts, and worker.
- Signals batch (2026-07-11), contract-first via six parallel subagents:
  - `@assay/database`: migration `0006_signals` (buy-shape columns, float
    columns, `slippage_curve` jsonb, `token_outcomes` table) + trajectory/
    regression/retention/deployer-stats/cohort-percentile/outcome queries.
  - `@assay/risk-engine`: sell-slippage curve at configurable notionals
    (default $500/$2k/$5k), additive to the single-probe eligibility input.
  - `@assay/activity`: per-buyer spend Gini/entropy/repeated-size for the 1h
    BUY window, bigint-exact.
  - `@assay/holders`: `floatBps` (deployer-aware ceiling semantics) +
    `supplyInPoolBps`.
  - `@assay/scoring`: `SignalConfig`, `liquidityNotCollapsed` rule, GRAY
    invalidation caps, component upgrades consuming all new inputs; a
    null-vector candidate scores identically to the pre-signals baseline.
  - `apps/worker`: `outcome-pass.ts` survival labeler loop (24h/72h),
    candidate assembly wiring for every new feature, env tuning
    (`OUTCOME_*`, `LIQUIDITY_COLLAPSE_FRACTION_BPS`,
    `RETENTION_WINDOW_MINUTES`, `COHORT_MIN_SIZE`,
    `RISK_SLIPPAGE_CURVE_NOTIONALS_USD`).
- Cost-model batch (2026-07-11), Main + two parallel subagents:
  - `@assay/database`: `ActivePoolCriteria`, `listActiveTrustedQuotePools`,
    `listIdleTrustedQuotePoolsDue`, active-scoped
    `listTrustedQuotePoolsNeedingRisk`, `listTokenHolders`,
    `updateTokenHolderScanBlock`, migration `0007_active_set`.
  - `@assay/chain`: viem chain definition with bytecode-verified Multicall3 +
    `batch.multicall` (16ms window) — concurrent reads coalesce into single
    `aggregate3` calls (wire-verified).
  - `@assay/enrichment`: two-lane selection (`selection` option; active +
    stalest-first idle batch), `activePools`/`idlePools` on the pass result.
  - `@assay/risk-engine`: optional `active` scoping of staleness selection.
  - `@assay/holders`: incremental Transfer-log scans via per-token cursor,
    cursor advanced atomically with balances + snapshot; active-set
    selection option.
  - `apps/worker`: env tuning (`ACTIVE_POOL_MAX_AGE_HOURS`,
    `WATCH_MIN/MAX_FDV_USD`, `ENRICHMENT_IDLE_REFRESH_MS`,
    `ENRICHMENT_IDLE_BATCH_LIMIT`), per-pass criteria wiring.
- Scaffolding batch (2026-07-11), three parallel subagents + Main:
  - Deploy kit: `Dockerfile` (oven/bun:1.3, non-root), `docker-compose.yml`
    (postgres 16 + worker + deadman, healthchecks, restart policies,
    container-side `DATABASE_URL` override), `scripts/backup.sh` (pg_dump +
    14-day rotation, live-tested), `DEPLOY.md` runbook — docker build,
    compose config, postgres healthcheck, and backup all validated live.
  - `apps/worker/src/deadman.ts`: snapshot-age heartbeat with
    stale/remind/recover state machine; DB failure counts as stale; dry-run
    without Telegram; live-fired a real Telegram alert on first run.
  - `@assay/database`: migration `0008_operator` (`operator_decisions`),
    `insertOperatorDecision`/`listOperatorDecisions`/`listAlertsSent`/
    `listTokenOutcomes`/`getLatestSnapshotCapturedAt`.
  - `apps/worker/src/decide.ts` (record ENTERED/PASSED/WATCHING/EXITED with
    reason/size/price) and `feedback.ts` (alerts × decisions × outcomes
    three-quadrant report, pure classification functions unit-tested) —
    both live-smoked against the scratch DB.
  - `docs/execution-methodology.md`: full operator runbook (trigger table,
    kill-speed research checklist tagged PAYLOAD/MANUAL, operator-owned
    position rules, decision-recording contract, weekly feedback ritual,
    hard rules).

## Phase 1 acceptance test — PASSED live 2026-07-10

Environment: public RPC `rpc.mainnet.chain.robinhood.com`, chunk size 2000,
PostgreSQL 16 (Docker, port 5433), chain head ~6,416,613.

1. Run 1: worker backfilled from block 8930; SIGINT after ~40s stopped
   gracefully at chunk boundary 824,929 (408 chunks, 904 pools, exit 0).
2. Run 2: resumed automatically; SIGKILL (hard crash) mid-pass left the
   cursor at chunk boundary 1,546,929 with 3,681 pools, zero duplicates.
3. Run 3: resumed at exactly block 1,546,930 (logged
   `scannedFromBlock: 1546930`) — no gap, no re-scan; reached 2,132,929.
4. Duplicates: `count(*) = count(distinct pool_address)` = 4,982.
5. Explorer match: independent scratch re-scan of 8930–200,000 found 518
   pools; Blockscout reported identical per-factory counts (V2 10/10,
   V3 508/508), which also match the worker database for that subrange.

## Enrichment smoke — PASSED live 2026-07-10

Environment: public RPC `rpc.mainnet.chain.robinhood.com`, PostgreSQL 16
(Docker `radar-pg`, port 5433), `ENRICHMENT_CONCURRENCY=2`, limit 10.

Command:

```sh
bun run enrich:once -- --limit 10
```

Result:

- Chain head read: block 6,442,637.
- Pools selected: 10.
- Snapshots inserted: 10.
- Metadata refreshed: 10.
- Pool errors: 0.
- WETH/USDG anchor pool:
  `0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a`.
- Sample snapshot rows included non-null `price_usd`, `estimated_fdv_usd`,
  `quote_liquidity_usd`, and `total_liquidity_usd` values.


## Swap activity implementation — VERIFIED deterministic 2026-07-10

Verification:

```sh
bun run typecheck
bun run test
bun run lint
```

Result:

- `bun run typecheck`: passed.
- `bun run test`: passed, 12 files, 87 tests.
- `bun run lint`: passed.
- Live `bun run validate:swaps` — PASSED 2026-07-11 against the public RPC +
  Blockscout, PostgreSQL 16 (Docker `radar-pg`, port 5433). Pool
  `0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a` (V3 WETH/USDG), blocks
  6,495,800–6,496,300: RPC swap count 18 == Blockscout 18 (`match: true`),
  decoded 10 BUY / 8 SELL / 0 UNKNOWN.

## Risk engine implementation — VERIFIED deterministic 2026-07-10

Verification:

```sh
bun run typecheck
bun run test
bun run lint
```

Result:

- `bun run typecheck`: passed.
- `bun run test`: passed, 14 files, 121 tests.
- `bun run lint`: passed.
- Live `bun run validate:risk` — PASSED 2026-07-11 against the public RPC +
  Blockscout + Docker `radar-pg`. Token
  `0x8a36AaB432cB2926c6f05F8761800eaE0Cdbd010` (V3 pool
  `0x12aaA064cdBD87858e4670D3A571ba8003eF4b5F`) at block 6,497,004: live
  bytecode + EIP-1967 slot reads gave `isProxy: false`, all six permission
  checks `ABSENT`; verification `UNKNOWN` (no verified source); simulation
  disabled (no router/quoter configured) so the overall verdict is a safe
  `UNKNOWN` — never a false PASS. Migrations `0002_activity` and `0003_risk`
  applied cleanly to the pre-existing database.

## MVP alert pipeline — VERIFIED 2026-07-11

Built contract-first, then three packages (holders, scoring, alerts) in
parallel via subagents, then integrated + live-smoked.

- `bun run typecheck`: passed.
- `bun run test`: passed, 23 files, 213 tests (holders 22, scoring 53,
  alerts 17 added).
- `bun run lint`: passed.
- Live `bun run validate:telegram` — PASSED 2026-07-11: real message delivered
  to the configured chat via `createTelegramTransport` (Telegram Bot API).
- Live `bun run validate:candidate` — PASSED 2026-07-11 against the public RPC +
  Docker `radar-pg`. Token `0x6399E2Bd8af62C0ac13f55613C3469b67332a6Fd`
  (FDV $88,423, liquidity $27,006): candidate assembled from the live enrichment
  snapshot, scored 21 with explainable components, eligibility `false` naming
  exactly the missing inputs (`minUniqueBuyers`, `maxEffectiveSellLoss`,
  `maxDeployerPct`, `maxAdjustedTop10Pct`, `sellSimulationPass`), alert level
  `GRAY` — the gate correctly withholds on incomplete data. Migration
  `0004_mvp` applied cleanly to the pre-existing database.

## Critical-path unlock (simulation + deployer) — VERIFIED live 2026-07-11

Built as two parallel subagent branches, then integrated and live-smoked
end to end on token `0x6399E2Bd8af62C0ac13f55613C3469b67332a6Fd`
(V3 pool `0x08A9BAfc1E4b70302F752D9ee8bF53cAd8dF939A`), public RPC +
Docker `radar-pg`:

- `bun run typecheck` / `bun run test` (25 files, 241 tests) /
  `bun run lint`: all passed.
- `validate:risk`: `simulator: enabled`, `simulationStatus: PASS`,
  `effectiveSellLossBps: 199` (≈ 2x the pool's 1% fee tier — sane
  round-trip floor). A V2 pool measured 59 bps ≈ 2x30 bps. Blocks
  6,528,721–6,541,017.
- `validate:deployer`: first attempt correctly recorded `UNKNOWN` when
  Blockscout 500'd (never a guess); paced retry then `RESOLVED`
  `0x30B0A6c97Cf015495e022219bA0F9a3787c90177`, `deployerPctBps: 0`,
  353 holders, adjusted top-ten 25.12% — proving the
  UNKNOWN -> RESOLVED transition live.
- `validate:candidate`: assembles honestly from persisted state only; the
  `validate:*` scripts are read-only probes, so signal persistence (and
  therefore YELLOW/GREEN) requires the worker loops running.
- Env gotcha: shells that exported the old empty `RISK_*` vars override
  Bun's `.env` autoload — `unset` them or start a fresh shell.

## Signals batch — VERIFIED 2026-07-11

- `bun run typecheck` / `bun run test` (28 files, 339 tests) /
  `bun run lint`: all passed.
- Live `bun run validate:candidate` — PASSED against Docker `radar-pg`
  (`launch_radar`): migration `0006_signals` applied cleanly to the
  pre-existing database; token `0x6399E2Bd8af62C0ac13f55613C3469b67332a6Fd`
  assembled with real trajectory values (`liquidityDrawdownBps: 346`,
  `minutesAbove80PctPeakLiquidity: ~89`, `liquidityCollapsed: false`, new
  positive reason "Quote liquidity is near its observed peak"); all
  not-yet-persisted signals correctly null with conservative scoring and a
  GRAY withhold.
- Deferred by decision: funding-lineage clustering (needs the bridge/CEX
  funder whitelist designed carefully) and web-fetch community checks
  (bidirectional contract-link consistency) — see decisions.md.

## Advisory judgment layer — VERIFIED 2026-07-11

`@assay/judgment` + a tenth worker loop: for every YELLOW/GREEN alert
(configurable), an LLM turns the as-of evidence into a structured research
brief — thesis, exactly three tagged risk calls, disconfirming evidence,
confidence, "what would change this call" — delivered as a follow-up
Telegram message. Strictly advisory by dataflow: the loop consumes
already-committed `alerts_sent` rows, so the LLM can never gate, delay, or
alter an alert (see decisions.md 2026-07-11).

Built contract-first (frozen `types.ts` + migration `0011_judgment` +
repository signatures), then five parallel subagents (DB repositories,
parser/citations/taxonomy, bundle/rendering, typed toolkit, LLM
client/engine) and a second wave of three (worker loop + delivery + config,
replay/report CLIs, injection canary suite).

- Machine-checked citations: every claim carries `{table, rowId, field,
  claimedValue}` into the append-only tables; a pure checker re-fetches and
  verifies each pointer; a load-bearing fabrication persists the brief as
  `REJECTED_FABRICATED_CITATION` and never delivers. Fabrication rate is a
  queryable metric (`judgment_citations` keeps every failed check).
- Typed history tools, never free SQL: comparable launches (k-NN over
  `token_performance.entryFeatures`), population base rates, deployer
  history, liquidity trajectory + slippage curve (pure over the bundle's
  as-of series), cohort percentiles (live-only; reports itself unavailable
  in replay), market series, cited-row fetch. Args are numerics/enums only —
  attacker strings cannot reach a query by construction. Every call is
  audited in `judgment_tool_calls` (args, row ids, sha-256 digest).
- Adversarial-input discipline: provenance-tagged bundle fields, fenced
  untrusted strings with an explicit preamble, and a 13-test canary suite
  (fence-break, fake tool-call JSON, RTL/zero-width, jailbreak phrases)
  asserting clean-vs-poisoned bundles produce identical renders outside the
  fence and identical tool traces.
- Eval loop: `bun run judge:replay` reconstructs bundles as of historical
  band entries (`token_performance.enteredAt`, same as-of reads as the
  performance labeler, look-ahead guard) and generates REPLAY briefs;
  `bun run judge:report` scores briefs against realized outcomes
  (RUGGED/BLED/HELD_BAND/RUNNER taxonomy): Brier, confidence-decile
  calibration, per-risk-tag precision/recall (unmeasurable tags reported
  honestly as unmeasured), fabrication rate — all with Wilson intervals,
  sliced per hashed prompt version (`prompt_registry`), with `--from/--to`
  out-of-time slicing; `--write` persists `judgment_eval_runs/items`.
- Config: OFF unless both `LLM_API_KEY` + `JUDGMENT_MODEL` are set (partial
  config is a hard error); OpenAI-compatible endpoint via
  `LLM_API_BASE_URL`; `validate:judgment` is the read-only live probe.

Verification: `bun run typecheck` / `bun run lint` passed; `bun run test`
61 files, 609 tests (152 added). End-to-end smoke on the scratch DB
(`radar-pg`, real postgres driver + migrations 0009–0011 applied to the
pre-existing database): seeded one historical band entry, `judge:replay
--dry-run` generated a REPLAY brief against a real pool with 4/4 citations
machine-verified, `judge:report` produced the full sliced report (Brier,
calibration bucket, per-tag rows, Wilson bounds), prompt v1 registered by
hash, re-run correctly idempotent (0 candidates). Smoke rows cleaned up.

Next for the judgment layer: accumulate live YELLOW/GREEN briefs in
production, run the first real out-of-time replay cohort once
`token_performance` has enough labeled band entries, and iterate prompt v2
against a frozen period.

## Alert-silence incident — RESOLVED 2026-07-12 (first alerts LIVE)

Zero alerts had fired since go-live despite healthy ingestion. Unwinding it
surfaced a five-layer chain, fixed root-to-leaf over one session (full
detail in decisions.md, 2026-07-11/12). **Resolution confirmed live: the
first 16 YELLOW alerts fired and delivered to Telegram on 2026-07-12,
with eligibility + score history persisted for every candidate.**

1. **Activity backfill starved the funnel.** Discovery was at block ~7.24M
   while the activity cursor was at ~1.74M — fresh launches had null buyer
   metrics, min-buyers rules could never pass, everything classified GRAY.
   Resolution: deliberate, documented fast-forward of `activity_cursor` to
   ~100k blocks behind discovery.
2. **Activity ingestion didn't scale to head.** Per-chunk work loaded every
   trusted pool ever discovered (~62k) and rebuilt every pool's snapshot
   from its full swap history — the pass stalled outright at head (141%
   CPU, zero commits). Fixed with active-set chunk selection, swap-touched
   snapshots + a bounded refresh lane, and windowed event reads. Verified
   live: 145k blocks / 300k swaps ingested in minutes, then steady ~90s
   passes at head.
3. **Scoring iterated the full population** (~72k pools) and ran the heavy
   signal battery for every snapshot-bearing pool. Fixed with active-set
   scoping plus a cheap FDV-envelope gate before the battery.
4. **Cohort percentiles streamed the entire append-only activity-snapshot
   table (1.4M rows) per candidate.** Rewritten as SQL `DISTINCT ON` over
   a live freshness window (default 60min) with a new
   `(chain_id, captured_at)` index (migration 0012). Scoring passes went
   from unbounded-hours to minutes.
5. **Candidate persistence was broken since the MVP:** the features jsonb
   contained a bigint (`blockNumber`) and every above-GRAY insert threw
   `Do not know how to serialize a BigInt` — unreachable until real
   candidates existed, and invisible because per-pool errors were logged
   as a count only. Fixed with a jsonb-safe serializer; the first pool
   error message is now surfaced on every `scoring.pass` log line; an
   end-to-end funnel regression test (seed → score → persist → deliver,
   mutation-verified against this exact bug) now guards the class.

Also fixed en route: one worker crash (20:09Z) on an unguarded external
JSON body — typed recoverable `TelegramApiError` + guarded explorer-body
parse, with regression tests. The 17:13Z dead-man page was real and
correct: the stack was redeployed at 17:13 after ~50 minutes of worker
downtime; recovery message followed at 17:15. Suite: 631 tests.

## Score re-weight evaluation — SHELVED by pre-registered protocol 2026-07-20

A zero-sum re-weight of the six score components was taken through the full
change protocol (pre-registration, coverage + realizability audit, out-of-time
tune/confirm split on realized `token_performance` labels) and deliberately
not shipped. Three independent pre-registered grounds: 9 of 13 calibration
features are under 60% non-null in at least one period (only liquidityQuality
survives, so 0 of 20 candidate shift pairs were valid); the reachable ceiling
is zero (of 481 realizable 2x winners, 458 are blocked by the eligibility
gate, none sit eligible at replay score 55-74); and the max replayed score
population-wide is 55, below every delivery floor. Weights are not the
current lever; the gate (T5) and entry-time signal coverage are.

Shipped alongside the negative result:

- `apps/worker/src/calibrate-sweep.ts` (`bun run calibrate-sweep`): read-only,
  band-filtered calibrate + counterfactual weight-sweep tool. Replays rows
  through the real `scoreOpportunity` (fidelity check: 0 mismatches over
  4,861 rows), reports per-period delta-caught/delta-admitted, feature lift,
  reachable-ceiling counts, and exits non-zero with "SAMPLE TOO SMALL" when a
  period has under 30 reachable winners.
- `docs/reweight-preregistration-2026-07.md`: full commitment, audit tables,
  SQL, results, and the unlock conditions for a future attempt.
- `docs/scoring-model.md`: change-log entry "Component re-weight evaluation:
  shelved (2026-07-20)".

## Delivery floor lowered 75 -> 68 — LIVE on prod 2026-07-20

Follow-on from the shelved re-weight: the operator's floor-lowering plan had
been gated on "a better formula first", which the re-weight evaluation showed
cannot happen on current data, while the floor itself measured as the live
lever. Counterfactual on the correct population for a delivery question
(live shadow decisions in `token_score_results`, full signals, joined to
`token_performance` 72h labels; 2026-07-12 to 07-20): floor 75 suppressed
203 eligible YELLOW tokens scoring 68-74 (versus 14 delivered), of which 79
hit 2x within 72h, 54 of those before their realized peak (realizable, not
hindsight), and 41 hit 5x (26 before peak). Only 3 of the 203 DIED at 72h.

Applied on radar-1 (`.env`, pre-change restore point `.env.bak-20260720`,
worker recreated and verified healthy): `ALERT_MIN_SCORE=68`,
`ALERT_MIN_SCORE_RED=75` (pinned so effective RED delivery stays at 75,
unchanged; the pin matters because RED's floor is the max of the two and
would otherwise have dropped to 70). Eligibility and classification
thresholds untouched; delivery only. Expected volume: roughly 8-25 extra
deliveries/day depending on launch tempo; revisit against the
`alerts_sent` volume query after a week. `.env.example` and the
`docs/scoring-model.md` floor history carry the change-protocol entry.

## Pass-latency root cause — pool_snapshots latest-snapshot index LIVE 2026-07-20

Investigating "slow RPC" reports found the RPC healthy (see Blockers below)
and the real bottleneck in the database: the band-lane pool selection
(`bandPoolCondition`, repositories.ts) probes every pool with a correlated
`max(s2.id)` over `pool_snapshots`, whose only index was
`(chain_id, pool_address, captured_at)`. At prod scale (28.5M snapshot rows,
188k pools) that walked each pool's full snapshot history: the selection
query ran 10+ minutes, five lanes ran it concurrently, and every
enrichment/activity/risk/holders/scoring pass serialized behind it
(observed ~40-minute score-write bursts over the preceding 48h; the pattern
predates 2026-07-20 and was unrelated to that day's floor change).

Fix: migration `0016_pool_snapshots_latest_idx` adds
`pool_snapshots (chain_id, pool_address, id)`; built on prod with
`CREATE INDEX CONCURRENTLY` (14m51s, no write lock, migration no-ops at next
deploy). EXPLAIN ANALYZE confirms the `max(id)` lookup is now an index-only
backward descent; the selection query dropped from 10+ minutes to ~45s warm
(13x). Remaining cost is the per-pool probe structure itself (188k subplan
executions at 0.25ms each): the next lever, if pass latency still matters,
is driving the selection from the snapshot side (`DISTINCT ON` over the new
index) or maintaining a latest-snapshot-per-pool table on the enrichment
write path. Both are repositories.ts code changes with tests, deliberately
not done as part of this diagnosis.

## Data-grounded model rebuild — VERIFIED on labeled replay 2026-07-20 (deployed for label collection)

Follow-on from the shelved re-weight ("weights are not the lever"): the
gate, score, and tiers were rebuilt from scratch against the labeled
population (local `radar-pg` snapshot, `token_performance` horizon 72h,
$10k-$100k band, N=9,260, 156 ≥10x). Operator decisions: relax YELLOW /
guard GREEN, precision-tilted volume. Full change-protocol entry:
docs/scoring-model.md "Data-grounded model rebuild (2026-07-20)".

- Eligibility: safety rules now reject only on explicit failure (sim FAIL,
  known sell loss over cap, detected critical permission); missing/UNKNOWN
  safety data is flagged, not failed. Age floor 0
  (`ELIGIBILITY_MIN_AGE_MINUTES`).
- Score: four components from covered entry features: liquidityDepth 35,
  buyerBreadth 25, buyFlow 20, lowCapTilt 20. Unscored signals stay as
  advisory reasons. Components jsonb, no migration; historical six-key rows
  tolerated on read.
- Tiers: GREEN $15k-40k + score ≥80 + sim PASS (null top-10 treated as
  satisfied, documented exception); YELLOW $15k-60k + score ≥65 + total liq
  ≥$8k; RED whole band on QUOTE liq ≥$2.5k + ≥5 buyers.
- Delivery floor `ALERT_MIN_SCORE=80` (new scale): measured ~11/day
  equivalent at 68% ≥10x precision (floor 70 would deliver ~138/day).
- Verified: typecheck + full suite green (310 tests, incl. new boundary and
  ≥10x-median-profile behavior tests); real-code replay over the snapshot
  shows ≥10x winner eligibility 7.5% → 86.5% (remaining rejections are the
  retained $2.5k quote floor + 2 detected critical permissions, zero
  sim/age losses) and all 539 explicit-FAIL honeypots still rejected;
  `bun run calibrate-sweep` (updated to the four components, no held
  constant) reproduces live totals at W=R.
- NOT yet out-of-time validated: confirm window too thin (99 rows, one
  ≥10x). Re-run tune/confirm per the change protocol after ≥2 weeks of
  fresh labels under the new regime; until then the model is
  engineering-chosen, deployed for label collection.

## Alert-flood investigation: floor stays 80 (2026-07-21)

Operator reported a flood of Telegram calls after the model-rebuild deploy.
Root-cause check on prod: `ALERT_MIN_SCORE=80` / `ALERT_MIN_SCORE_RED=75`
confirmed in both `.env` and the running worker environment, so this was
NOT config drift. The 30h window decomposes into 4 pre-deploy sub-80
deliveries (old 68 floor), an 8-alert restart backlog burst (~90s after
worker recreate, documented pattern), and a ~2-3/hr post-burst tail
(scores 80-86, all distinct tokens, dedup healthy). Floor sweep on the
labeled replay: 85 would have caught 1 token (vs 19 at 80, 17 of them 2x
winners), 90 catches zero, so raising the floor trades a possibly
transient flood for losing ~94% of caught winners. Decision: NO floor
change; pre-registered trigger recorded in docs/scoring-model.md floor
history (re-measure a burst-free 24h of `alerts_sent`; only if still over
~10/day, step to 85). Open diagnostic: replay tempo (~1/day caught at 80)
vs live post-deploy tempo (~2-3/hr) is unexplained until the 24h
measurement lands; part of the tail is plausibly the new score re-rating
the existing watch population as snapshots refresh. New standing report:
`bun run calibrate:died` (died-cohort commonality, advisory
hypothesis-generator; see scoring-model change protocol before acting on
its output).

## Methodology codification: floor:volume ritual + hardened CLI flags (2026-07-21)

Codified the alert-flood and died-cohort session lessons so they cannot
recur (see decisions.md 2026-07-21 entry):

- New `bun run floor:volume` (apps/worker/src/floor-volume.ts): counterfactual
  deliveries/day per candidate floor from `token_score_results` (the correct
  population for volume questions), distinct qualifying tokens per UTC day
  before cooldown dedup, with `--burst-discard-until` for post-deploy
  re-score bursts. Backed by new `listTokenScoreResultsSince` in
  `@assay/database` (with repository test).
- Shared hardened CLI parser (apps/worker/src/cli-flags.ts): `readFlag` now
  accepts both `--flag=value` and `--flag value`, and `assertKnownFlags`
  turns unknown flags and stray positionals into loud WorkerConfigError
  failures. Cut over calibrate-sweep, judge-replay, judge-report, and
  calibrate-died; this fixes the session's silent no-op where
  `--floor 85` fell back to the default floor without warning.
- docs/scoring-model.md floor ritual is now two-track (live `alerts_sent`
  truth for the current floor, `floor:volume` counterfactual for candidates)
  with hard preconditions: 24h minimum of burst-free data, always discard
  the post-deploy burst, and `calibrate-sweep`'s `caught` is winner recall,
  never a volume estimate. The 2026-07-20 replay-derived volume figures
  carry a correction line.
- docs/execution-methodology.md §6 gains the died-cohort prior correction:
  high quote liquidity and token age are not rug-safety (observation bias);
  the rug-catching lever is entry-time coverage of sim / permission /
  holder data.

Verified: typecheck + full suite green (63 files, 785 tests, including new
cli-flags and score-results tests); live smoke of the space-form flag fix,
unknown-flag hard failure, and an end-to-end seeded `floor:volume` run
(monotonic totals across floors, burst discard, `--help` without DB).

## RPC-credit outage: crash-loop root cause fixed, briefs quieted (2026-07-21)

Alchemy credits ran out ~12:27 UTC (operator will top up later). Two
follow-on problems found and addressed:

- **Worker crash loop (358 restarts, RetryExhaustedError every ~35s).**
  Root cause: the shared active-set cutoff read (`activeMinCreatedBlock`,
  head block + timestamp binary search in main.ts) runs inside the
  enrichment / activity / risk / holders runOnce closures BEFORE the pass
  functions, so its RPC failures were never wrapped in a pass-specific
  halt error and escaped every `isRecoverable` classifier, crashing the
  whole process. Fixed in repo: new `ActiveSetCutoffError` (loop.ts) is
  thrown by the cutoff read and classified recoverable (halt, back off,
  retry) by all four loops; 4 new loop tests. NOT yet deployed to prod:
  deploy is `git pull` + rebuild on radar-1 after this lands in the repo.
  Until then the prod crash loop continues, which is survivable (docker
  restart policy; deadman pages go to the private `DEADMAN_CHAT_ID`), and
  the worker self-recovers when credits return.
- **Group-chat spam (operator report).** In the 36h before the outage the
  shared alert chat received ~43 delivered alerts plus 35 full LLM
  judgment briefs (delivery=SENT, default `JUDGMENT_MIN_ALERT_LEVEL`
  YELLOW). Stopgap applied LIVE on prod: `JUDGMENT_MIN_ALERT_LEVEL=GREEN`
  in `/opt/launch-radar/.env` + worker recreate (verified in
  `worker.started`), so briefs now accompany only GREEN (go-tier) alerts.
  Alert floor deliberately left at 80: the pre-registered floor trigger
  requires 24h of burst-free data (only ~11.5h existed when the RPC died)
  and the 2026-07-20 floor entry records 80 as the operator's chosen
  precision point. If post-top-up volume is still too chatty, the lever is
  `ALERT_MIN_SCORE=85` (one env line) decided via the `bun run
  floor:volume` ritual once 24h of burst-free data exists.

## Blockers / unknowns

- Alchemy credits exhausted (2026-07-21, ~12:27 UTC): all RPC-dependent
  loops are down until the operator tops up. Ingestion has a gap from that
  instant; trajectory/cohort features spanning the gap will be thin, and
  the first post-recovery scoring pass may emit a restart-style alert
  burst (documented pattern).
- ~~Production RPC provider not selected~~ Resolved: prod runs a dedicated
  Alchemy endpoint (in place since at least 2026-07-13 per `.env` backups;
  load-tested unthrottled on 2026-07-20: 30 concurrent `eth_blockNumber` and
  20 concurrent 2k-block `eth_getLogs` all 200, zero rate-limit strings in
  worker logs). The API key that was surfaced in a diagnostic session on
  2026-07-20 was rotated as part of publish preparation; the exposed value
  is dead and the server's `.env` carries the replacement.
- Uniswap V4 (PoolManager singleton, `Initialize` events) is live on the chain
  but not ingested — needs a scope decision before V4 pool coverage.
- Full discovery backfill to head has not been run to completion (acceptance
  runs covered blocks 8,930–2,132,929 of ~6.4M); resume safety makes finishing
  it a matter of leaving the worker running.
- Enrichment is current-state only. Historical price/liquidity backfill is not
  implemented and should not be inferred from the snapshot loop.
- Activity windows use swap `observed_at` timestamps from ingestion time. This
  is suitable for live monitoring but not historical backtesting claims.
- Contract verification depends on the Blockscout `getsourcecode` API; an
  unreachable explorer yields `UNKNOWN`, not `VERIFIED`.
- YELLOW/GREEN alerts now require only real market conditions (>= 30 unique
  buyers, liquidity, age) plus the worker running continuously so risk and
  holder snapshots persist — the `validate:*` scripts are read-only probes
  and do not populate candidate inputs.
- Blockscout `getcontractcreation` is intermittently broken (~75-80%
  measured 500 rate, 5-15s per call). Handled with bounded retry + hourly
  re-ask; deployer stays `UNKNOWN` (never guessed) until it answers.
- Holder scans are now incremental (per-token `holder_scan_block` cursor),
  so only a token's FIRST scan walks from pool creation; an old pool entering
  the watch band still pays that one-time full walk on the rate-limited
  public RPC. A dedicated provider makes this a non-issue.
- Wallet quality now uses deployer serial-launch history, but that history is
  only meaningful once `token_outcomes` accumulates labels (worker must run
  continuously for >= 24h/72h horizons). Funding-lineage clustering
  (`holderClusterScoreBps`) and social/narrative signals remain unimplemented;
  their score contributions stay at conservative defaults.
- Trajectory/cohort/retention signals are forward-only from first observation;
  a token discovered late has an irrecoverable early-life gap (feature is null,
  never inferred).

## Known technical debt

- Live-run scratch database: Docker container `radar-pg` (port 5433) holds
  acceptance and enrichment-smoke data; disposable.
- `tests/setup.ts` polyfills `Promise.withResolvers` because vitest runs under
  Node 16 locally; remove when the toolchain moves to Node ≥ 22.

## Do not work on yet

- Dashboard.
- Social scraping.
- Automated trading.
- Wallet profitability scoring.
