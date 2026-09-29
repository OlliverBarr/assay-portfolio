# Architectural Decisions

## 2026-07-10 — Cursor semantics: two watermarks, transactional advance

The `chain_cursor` row stores `latest_observed_block` (newest head seen) and
`latest_processed_block` (newest block whose factory logs are fully
persisted) separately. The processed watermark advances only inside the same
database transaction that commits the range's pools and tokens, with a
`WHERE latest_processed_block < :to` guard so replays and races can never
move it backwards. A crash mid-pass resumes at `latest_processed_block + 1`;
pool inserts are `ON CONFLICT DO NOTHING` on `(chain_id, pool_address)`, so
overlap is idempotent rather than harmful.

Consequence: discovery never skips a range. Persistent RPC failure halts the
pass (`DiscoveryHaltError`) with the cursor at the last committed chunk.

## 2026-07-10 — Factory configuration is injectable, not hardcoded

Factory addresses, deployment blocks, and quote-asset addresses come from
environment configuration parsed by `@assay/chain` (`loadChainConfigFromEnv`).
Unset addresses omit the factory/asset; malformed values are hard errors.
This let implementation proceed while chain constants were still being
verified, and keeps address changes out of code.

Factory shape: `{ dex, kind, address, deploymentBlock }` where `kind`
("uniswap-v2" | "uniswap-v3") selects the event ABI. Uniswap V4 uses a
singleton PoolManager with a different event model (`Initialize`) and is
deliberately not part of Phase 1 discovery.

## 2026-07-10 — Quote assets: WETH + USDG, not USDC

Verification (docs/data-sources.md) showed Robinhood Chain has no
Circle-native USDC and the canonical bridged USDC is economically negligible
(~$493 total supply). The chain's designated stablecoin is USDG (Paxos
Global Dollar). The allow-list preference order is WETH, USDG, then USDC
(disabled by default). Only allow-listed addresses classify a pool's quote
side; symbols are never trusted.

## 2026-07-10 — PGlite for database tests

Tests run against in-memory PGlite with the same generated SQL migrations as
production (postgres-js), giving real PostgreSQL semantics — `ON CONFLICT`,
transactions — without a running server. Deterministic, isolated per test,
full-suite safe.

## 2026-07-10 — Retry policy: bounded, classified, loud on exhaustion

RPC calls go through `withRetry` (default 4 attempts, exponential backoff,
capped). Only classified-transient errors retry (timeouts, HTTP 429/5xx,
network-level failures, RPC codes -32005/-32603); everything else propagates
immediately. viem's transport-level retry is disabled so attempts are
bounded and observable in one place.

## 2026-07-10 — Worker loop: halt-retry vs crash, chunk-boundary shutdown

The worker loop distinguishes failure classes. `DiscoveryHaltError` (RPC
unavailable after bounded retries) is logged with its range and retried
after a backoff (default 4x the poll interval) — the cursor guarantees the
failed range is re-scanned, so retrying cannot lose events. Every other
error crashes the process: an unknown failure mode must be seen, not
retried blindly.

Graceful shutdown (SIGINT/SIGTERM) aborts at the next chunk boundary — the
transactionally safe point — rather than waiting for the whole pass, which
during an initial backfill would mean hours. `runDiscoveryPass` accepts an
`AbortSignal` and reports `stopped: true` with the last committed block.
A second signal force-exits. Validated live: SIGINT and SIGKILL both left
the cursor on an exact chunk boundary and the restart resumed at cursor+1.

## 2026-07-10 — Explorer cross-check with adaptive range splitting

`validate:range` verifies pipeline completeness against Blockscout's
Etherscan-compatible logs API. The instance rejects wide ranges (HTTP 500)
and truncates at 1,000 results, so the checker recursively halves any
window it cannot enumerate exactly. Counts are compared per factory over a
fixed block range against a fresh scratch scan using the production
discovery pass.

## 2026-07-10 — Enrichment numeric policy: WAD fixed-point, append-only snapshots

Raw on-chain integers remain `bigint`. Derived financial values (prices,
FDV, USD liquidity) use WAD fixed-point (`10^18`) and are persisted into
PostgreSQL `numeric(60,18)` columns as decimal strings. JS `number` is not
used for token amounts, prices, FDV, or liquidity.

`pool_snapshots` is append-only. Metadata columns on `tokens` may refresh in
place because metadata is descriptive current state; market snapshots are the
historical record.

Overflow is explicit: values above the configured WAD cap are stored as null
with `null_reason = 'overflow'`, not coerced or rounded into plausible-looking
numbers.

## 2026-07-10 — USD anchoring: USDG direct, WETH through deepest WETH/USDG pool

USDG is treated as exactly $1 for Robinhood Chain snapshots. WETH/USD is
derived at read time from the deepest discovered WETH/USDG trusted-quote pool,
where deepest means highest USDG-side balance. No external price API is used.

For USDG-quoted pools, USD conversion is direct. For WETH-quoted pools, the
snapshot records the WETH/USDG anchor pool address. If no anchor exists or the
anchor pool is empty, snapshots are still inserted with null value columns and
`null_reason = 'no-usd-anchor'` so downstream eligibility cannot confuse
missing data with zero.

This anchor can be manipulated in principle by creating a deeper WETH/USDG
pool, but both assets are allow-listed and depth represents real quote capital;
this is acceptable until a dedicated oracle/provider decision is made.

## 2026-07-10 — Pool pricing: V2 reserves, V3 slot0, balances only for liquidity

V2 prices come from `getReserves` with token-decimal adjustment. V3 prices
come from `slot0.sqrtPriceX96`; concentrated-liquidity pool token balances are
never used for price because they are not the active price. Token balances at
the pool address are used only to estimate quote-side and total liquidity.

Zero reserves, zero `sqrtPriceX96`, missing metadata, missing anchor, and
overflow all produce snapshots with explicit null reasons rather than thrown
pass-level failures.

## 2026-07-10 — Worker dual-loop semantics: discovery plus enrichment

At the enrichment milestone, the worker ran discovery and enrichment as two poll
loops in one process against the same chain client and database handle.
Discovery kept its classified halt/retry behavior for `DiscoveryHaltError`;
enrichment treated per-pool failures as data quality issues reported in the pass
result and continued with other pools. Unknown pass-level errors still crashed
the worker.

SIGINT/SIGTERM aborted both loops. Discovery stopped at chunk boundaries;
enrichment stopped between pools. The database closed only after in-flight work
settled. A second signal force-exited.

## 2026-07-10 — Swap activity: signed pool deltas, raw quote flow, dedicated cursor

Swap ingestion lives in `@assay/activity`, not `@assay/chain`. The chain package
exports only V2/V3 swap ABI items and topic selectors; product-specific
BUY/SELL/UNKNOWN classification is applied after joining logs to stored pool
metadata.

Normalized swap rows store token0/token1 amounts as signed pool deltas:
positive means the token entered the pool, negative means it left. V2 swaps are
converted from `amountIn - amountOut`; V3 `amount0`/`amount1` already use that
pool-delta convention.

For trusted-quote pools:

- `BUY`: base delta < 0 and quote delta > 0.
- `SELL`: base delta > 0 and quote delta < 0.
- `UNKNOWN`: zero, same-direction, missing, or otherwise ambiguous movement.

Buyer identity for this milestone is an approximation: V2 BUY uses `to`, and
V3 BUY uses `recipient`. Routers can be recipients, so `sender` and `recipient`
are both preserved for later router-aware attribution. Documentation and alerts
must not claim buyer identity is certain from this field alone.

`quote_amount_raw` is the absolute trusted quote-token amount moved for the
classified side. Activity snapshots sum raw integer quote amounts exactly and do
not convert to USD; USD conversion belongs later by joining enrichment
snapshots.

`activity_cursor` is separate from `chain_cursor` and keeps the same two
watermarks: `latest_observed_block` and `latest_processed_block`. Each chunk's
swap rows, activity snapshots, and processed-block advance commit in one
transaction. Persistent RPC exhaustion raises `ActivityHaltError` and leaves the
cursor unmoved for that failed range. Duplicate logs are idempotent via
`pool_swap_events(chain_id, transaction_hash, log_index)`.

The activity target is capped at the discovery cursor's processed block so swap
ingestion does not scan blocks whose pool-creation events are not yet safely
persisted. Rolling windows currently use swap `observed_at` ingestion
timestamps, which supports live monitoring but must not be used as evidence for
historical backtesting claims.

## 2026-07-10 — Worker triple-loop semantics: discovery, enrichment, activity

The worker now runs discovery, enrichment, and activity loops in one process
against the same database handle and chain client. Discovery and activity use
typed halt/retry errors (`DiscoveryHaltError`, `ActivityHaltError`) for bounded
RPC exhaustion; unknown errors still crash the process. SIGINT/SIGTERM aborts
all loops: discovery and activity stop at chunk boundaries, enrichment stops
between pools, and the database closes after in-flight work settles.

## 2026-07-10 — Risk engine: deterministic components, distinct statuses, never-false-PASS

Contract safety and tradeability live in `@assay/risk-engine`; `@assay/chain`
exposes only product-neutral primitives (EIP-1967/beacon/legacy slot constants,
`owner()` / router `getAmountsOut` / QuoterV2 ABIs). Classification is pure and
unit-tested; RPC-specific reads sit behind a `RiskReader` interface with fakes
in tests.

The top-level status is one of `PASS | FAIL | UNKNOWN | ERROR`, with `STALE`
applied at read time (`effectiveRiskStatus`). `UNKNOWN`, `ERROR`, and `STALE`
are never equivalent to `PASS`: missing data never makes a token safe. `PASS`
requires a passing sell simulation and no critical permission and no missing
critical signal. Present `mint`/`blacklist`/`pause`/`upgradeAdmin` force `FAIL`;
`transferTax`/`ownership` are risk reasons only.

Permission detection is a bytecode 4-byte-selector heuristic reported as
evidence — `ABSENT` is not proof of safety. For a resolvable proxy the logic
contract's bytecode is analyzed; a beacon proxy's logic is unresolved from
storage, so its permissions stay `UNKNOWN` rather than a false `ABSENT` read of
the thin proxy.

Tradeability simulation is quote-based (`getAmountsOut` / QuoterV2), gating on
reverts and output presence; precise per-leg loss (spot pairing) is left null
for now. It requires verified router/quoter addresses, which are not confirmed
for Robinhood Chain (docs/data-sources.md). Absent them, simulation is
`UNKNOWN`, which by construction cannot yield a false `PASS`. Full
buy/transfer/sell eth_call simulation with state overrides is deferred; it runs
at current head and does not require an archive node.

Risk selection is staleness-based, not a block cursor: `token_risks` /
`trade_simulations` are append-only per (token/pool, block), and
`listTrustedQuotePoolsNeedingRisk` picks pools whose latest verdict is missing
or older than the window. Selection is idempotent, so it is restart-safe without
a dedicated cursor; a hostile token that throws on a non-infra read is recorded
as an `ERROR` verdict, while infra exhaustion raises `RiskHaltError` for the
worker to back off. Verification comes from Blockscout `getsourcecode`; an
unreachable explorer is `UNKNOWN`.

## 2026-07-10 — Worker four-loop semantics: discovery, enrichment, activity, risk

The worker adds a fourth loop for risk on the shared DB handle and chain client.
Discovery, activity, and risk use typed halt/retry errors (`DiscoveryHaltError`,
`ActivityHaltError`, `RiskHaltError`) for bounded RPC exhaustion; unknown errors
crash the process. SIGINT/SIGTERM aborts all loops: discovery/activity stop at
chunk boundaries, risk stops between pools, enrichment stops between pools, and
the database closes after in-flight work settles.

## 2026-07-11 — MVP alert pipeline: contract-first parallel build

The remaining MVP (holders, eligibility/scoring, alerts) was built by fixing the
shared contract first — the DB tables plus `@assay/scoring`'s `CandidateFeatures`
/ `EligibilityResult` / `ScoreResult` / `AlertLevel` types — then implementing
the three packages in parallel (independent files, no cross-imports) and
integrating serially. `CandidateFeatures` is the single normalized input vector
the worker assembles from the latest enrichment, activity, risk, and holder
snapshots; eligibility, scoring, and alert classification are pure functions over
it. This kept the parallel work collision-free and the domain logic fully
unit-tested off deterministic fixtures.

## 2026-07-11 — Eligibility gates hard, missing data never passes; YELLOW is eligibility-free

Eligibility is a separate gate from the opportunity score (a high score never
overrides a failed gate). Every rule that lacks its input FAILS with a
structured reason — a null USD value, `UNKNOWN` simulation, or absent holder /
deployer metric is a rejection, never an assumed pass. Consequently, while trade
simulation is disabled and deployer provenance is unimplemented, no token is
strictly eligible, so ORANGE and RED (which require eligibility) do not fire.
YELLOW is deliberately eligibility-free — FDV band + liquidity + unique buyers +
no known critical failure — so the MVP still surfaces early watch candidates on
partial data without ever fabricating a pass. This behavior is intentional and
documented, not a stopgap.

## 2026-07-11 — Alerts: pluggable transport, dry-run default, cooldown dedup

Alert delivery is behind an `AlertTransport` interface. The worker uses the
Telegram transport when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set and a
dry-run (log) transport otherwise, so the pipeline runs safely with no
credentials and goes live with no code change. Partial Telegram config is a hard
error (a half-configured alerter would silently drop alerts). Dedup is pure and
cooldown-based (`evaluateAlert`): GRAY never emits; a level increase emits
immediately; the same or lower level re-emits only after the cooldown. The
worker persists every emitted alert (with delivery success) to `alerts_sent`; a
failed send is recorded, not fatal. Eligibility + score history is persisted
(append-only) only for candidates above GRAY, keeping the tables meaningful.

## 2026-07-11 — Worker six-loop semantics

The worker runs six loops on one DB handle + chain client: discovery,
enrichment, activity, risk, holders, and scoring/alerts. Discovery, activity,
risk, and holders use typed halt/retry errors for bounded RPC exhaustion; the
scoring/alert loop performs no direct RPC (reads persisted signals, sends
alerts) so it has no halt type — unknown errors crash, while per-pool and
delivery failures are handled inside the pass. SIGINT/SIGTERM aborts all loops
at their safe boundaries; the database closes after in-flight work settles.

## 2026-07-11 — Trade simulation: verified periphery + round-trip loss baseline

UniswapV2Router02 (`0x89e5DB8B5aA49aA85AC63f691524311AEB649eba`) and QuoterV2
(`0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`) were adopted only after both
the official Uniswap deployment pages and on-chain checks agreed: non-empty
bytecode, `router.factory()` returning the verified V2 factory (binding the
router to the right deployment), and real quote calls on live WETH/USDG
pools returning amounts consistent across V2 and V3 (~$1.78 vs ~$1.79 for
0.001 WETH).

The quote-based probe originally had no spot baseline for the sell leg, so
`effectiveSellLossBps` stayed null even on PASS and the
`maxEffectiveSellLoss` eligibility rule could never be satisfied. Decision:
the sell-leg baseline is the probe's own quote input — a frictionless round
trip returns what went in — making the measured loss a deterministic,
conservative round-trip shortfall. Live sanity: measured losses land on
theoretical fee floors (V2 59 bps ≈ 2x30 bps; V3 199 bps ≈ 2x1% tier).
Full buy/transfer/sell `eth_call` simulation remains deferred; the quote
probe cannot detect transfer-hook honeypots, which is why simulation PASS
is one eligibility input, not a safety verdict.

## 2026-07-11 — Deployer provenance: explorer-resolved, tri-state, same denominator

The deployer is the token contract's creator, resolved via Blockscout
`getcontractcreation` and treated as adversarial input: addresses are
checksummed and validated, garbage or non-OK responses yield no answer, and
the endpoint's measured ~75-80% intermittent 500 rate is absorbed by bounded
retry plus an hourly re-ask window. State is tri-state on the tokens table —
`deployer_status` null (never attempted) vs `UNKNOWN` (asked, unanswered,
retryable) vs `RESOLVED` — so restart never re-hammers the explorer and
unknown is never conflated with safe.

`deployerPctBps` is computed inside `computeConcentration` against the same
adjusted-circulating-supply denominator as `adjustedTop10PctBps`, so the two
ownership rules can never diverge on denominator choice. Null when
unresolved or when the deployer is an excluded non-economic address; a real
0 when resolved and holding nothing. Resolution is lazy in the holders pass
and per-token failures never halt the pass.

## 2026-07-11 — Signals batch: score inputs, not gate inputs (one exception)

Eight new signals landed in one contract-first parallel batch: liquidity
trajectory (peak/drawdown/time-above-80%-of-peak), LP-pull collapse detection,
size-aware sell-slippage curve, simulation regression (PASS→FAIL), real float
ratio + supply-in-pool, deployer serial-launch history, buy-size shape
(Gini/entropy/repeated-size), early-buyer retention, cohort-relative
percentiles, and a survival-outcome labeler.

All new signals feed the opportunity score only — none widen the eligibility
gate — with exactly one exception: `liquidityNotCollapsed` fails eligibility
iff latest quote liquidity fell below a configured fraction (default 20%) of
the observed peak. Rationale: the current gate thresholds are uncalibrated
guesses (chain is days old); adding required inputs would freeze the pipeline
until every new signal persists, while an observed LP pull is an invalidation
event, not a threshold. For the same reason `liquidityCollapsed: null` does
NOT fail the rule — a deliberate, documented exception to the
missing-data-never-passes convention (unknown trajectory ≠ observed collapse).
`liquidityCollapsed === true` or `simulationRegressed === true` additionally
caps the alert level at GRAY regardless of score.

Trajectory features are forward-only from first observation (ingestion-time
snapshots, non-archive RPC): a token observed late yields null, never an
inferred history. Deployer history joins `tokens.deployer_address` against
`token_outcomes` locally — no explorer dependency beyond the existing one-time
creator resolution.

## 2026-07-11 — Survival outcomes as the calibration dataset

`token_outcomes` labels every observed pool `SURVIVED`/`DIED` at configurable
horizons (default 24h/72h): SURVIVED iff the last snapshot within the horizon
window retains ≥30% of peak quote liquidity AND ≥$10k estimated FDV
(config, not constants). Labels are append-once per (chain, pool, horizon) —
`getPoolsDueForOutcome` excludes already-labeled pools and
`insertTokenOutcome` is `ON CONFLICT DO NOTHING`, so relabeling is
structurally impossible. The labels describe observed history only.

This table is the strategic keystone: it is the dataset against which every
guessed eligibility/score threshold can later be recalibrated, and the only
legitimate bootstrap for wallet-quality labels ("bought early in past
survivors") on a chain too young for realized-P&L reputation. Deployer
serial-launch stats consume it today; threshold replay is future work and
must not be claimed as backtesting (snapshots are forward-only).

## 2026-07-11 — Active-set scheduling + multicall batching (RPC cost model)

Before this change, three loops scaled RPC cost with the all-time pool count:
enrichment re-valued every trusted-quote pool every 60s with individual
`eth_call`s, risk re-assessed every token on staleness forever, and every
holder scan re-walked ERC-20 Transfer logs from pool creation. At the current
~5k discovered pools that projected to ~$700+/month on pay-as-you-go RPC —
before the backfill even finishes.

Fixes, in order of leverage:

1. **Active set** (`ActivePoolCriteria`, packages/database): a pool gets
   full-cadence refresh iff discovered within the last N hours (default 72)
   OR its latest snapshot's estimated FDV sits inside the watch band
   (default $40k–$300k). Enrichment adds an idle lane — non-active pools are
   re-valued when their latest snapshot is older than the idle interval
   (default 6h, stalest first, bounded batch) — which is also the
   re-detection mechanism: a dormant pool pumping back into the band is
   re-valued within one idle interval and promotes itself into the active
   set. Risk and holder scans are scoped to the active set outright; signal
   data for out-of-band pools is worthless. All knobs are env-tunable; the
   pass options are optional, so library callers and tests keep legacy
   behavior unless they opt in (the worker opts in).
2. **Multicall batching** (packages/chain): the viem client now carries a
   chain definition with the canonical Multicall3 (bytecode-verified on
   Robinhood Chain, docs/data-sources.md) and `batch.multicall` (16ms
   window), so concurrent `readContract`s coalesce into single `aggregate3`
   calls with per-sub-call failure isolation — verified on the wire: four
   concurrent reads produced exactly one `eth_call`. Adversarial metadata
   reverts stay isolated (allowFailure).
3. **Incremental holder scans** (packages/holders + migration
   `0007_active_set`): `tokens.holder_scan_block` cursors each token's
   Transfer-log walk. Null cursor → full walk computing balances from
   scratch; set cursor → fetch only the delta and fold it onto stored
   balances (zero-netted holders overwritten, not dropped). The cursor
   advances in the same transaction as the balance upsert + snapshot, so a
   crash can never leave it ahead of persisted state.

Projected steady-state burn drops to roughly 50–90M compute units/month
(~$25–45 on Alchemy pay-as-you-go), dominated by discovery/activity getLogs
cadence rather than pool count.

## 2026-07-11 — Population-wide performance labels (anti-self-fulfilling calibration)

Operator concern, accepted: a feedback loop built only from *alerted* tokens
is conditioned on the system's own selections — tuning against it risks
reinforcing whatever the current thresholds already believe. The survival
labeler was already population-wide, but binary liquidity survival is the
wrong target for R/R tuning: it grades the rug filter, not where multipliers
live.

`token_performance` (migration `0009_performance`) therefore labels **every**
pool whose observed history first crossed the reference band (default
$50k–$200k estimated FDV, the operator's stated hunting range) with realized
`maxMultipleBps` / `maxDrawdownBps` / `minutesToPeak` per horizon (72h/168h)
plus the reconstructed entry-time feature vector — regardless of whether the
token ever alerted or passed eligibility. Alerts cannot move these markets
(no autonomous buying), so the bias being eliminated is selection bias in the
dataset, not price impact. Entry is the first *observed* in-band snapshot;
idle-lane pools carry 6h snapshot resolution, so out-of-band trajectories are
coarse — a documented, accepted trade from the active-set cost model.

`bun run calibrate` reports per-feature quartiles against realized multiples.
Discipline codified in scoring-model.md: threshold changes must validate
out-of-time (tune on one period, confirm on a later one), one threshold at a
time, with the existing change protocol. The expected honest outcome is that
most signals are noise and a few carry everything — that is the finding that
makes the survivors trustworthy.

## 2026-07-11 — Operator entries detected on-chain, not declared

Manual `decide` recording of ENTERED/EXITED contradicted the point of
automatic labeling: the operator executes on-chain, and every trusted-pool
swap is already ingested. `OPERATOR_WALLET_ADDRESSES` (optional, worker env)
now drives `listSwapsByWallets`, and the feedback report treats a detected
BUY from a watched wallet exactly like a recorded ENTERED decision (merged,
never exclusive). The manual CLI remains for what the chain cannot record:
intent — chiefly PASSED-with-reason, which is what makes an operator-miss
gradeable. Detection matches swap sender/recipient; aggregator-routed trades
may not attribute, so the feedback summary surfaces `detectedTrades` for a
sanity check and manual records stay as the fallback.

## 2026-07-11 — Self-service Telegram subscriptions (add bot = get alerts)

Alert delivery was a single static chat id; sharing the feed meant editing
server env per chat. Now a `subscriptions` worker loop polls `getUpdates`
(sole consumer, DB-persisted `last_update_id` cursor, advance-after-persist)
for `my_chat_member` events: bot added → subscribed, bot kicked → removed
(`telegram_subscriptions`, migration `0010_subscriptions`; chat ids stored as
text — Telegram ids can exceed 2^53 and the API layer parses them to
exact-precision strings before JSON.parse). Alert delivery wraps the primary
static-chat transport in a fan-out: primary failure still propagates
(unchanged contract), per-subscription failures are isolated, and a
403-shaped failure (bot kicked/blocked) auto-marks the subscription REMOVED.

Open by default — anyone who adds the bot receives the feed, per the
operator's explicit choice. `TELEGRAM_JOIN_CODE` (optional) gates activation
behind a `/join <code>` handshake (add → PENDING → correct code → ACTIVE)
when the alpha-leak tradeoff changes. Dead-man infra pages never fan out.

Addendum (2026-07-19, shipped with the /score scorecards): the same open
posture now covers private chats. Groups activate via `my_chat_member` on
add, but Telegram fires no membership event for DMs, so /score in a DM was
structurally unreachable; `/start` (Telegram's first-contact command) is now
an alias of `/join`, and with no join code configured either command
activates the chat directly. Consequence: anyone who discovers the bot
username can DM `/start` and receive the full alert fan-out, exactly as
anyone could already add the bot to a group. Mitigation when the tradeoff
changes stays the same knob: set `TELEGRAM_JOIN_CODE` (existing ACTIVE
chats are never downgraded, so enabling it later is non-disruptive).

Incidental find while shipping: `feedback.ts`/`calibrate.ts` ran `main()` at
module top level, so importing them in tests opened a real DB connection —
green only while the local scratch Postgres happened to be up. CLI entry is
now guarded by Bun's `import.meta.main`; the suite is hermetic again.

## 2026-07-11 — Active-set youth is on-chain, and parameter counts never scale with population (production incident)

**Incident:** the production worker entered a crash-restart loop
(`MAX_PARAMETERS_EXCEEDED: Max number of parameters (65534) exceeded`),
snapshots went stale, and the dead-man fired. Root cause was a compound
design flaw in the cost-model batch:

1. `ActivePoolCriteria` measured pool youth by `discovered_at` — the row's
   ingestion time. The production backfill inserted the entire ~62k-pool
   history in one day, stamping every pool "young" and putting the all-time
   population on the full-cadence lane. Enrichment passes stretched to
   hours (starving fresh launches — the actual product) and the active-set
   cost model silently degenerated to scanning everything.
2. `getTokensByAddresses` bound one parameter per selected pool. When
   discovery pushed the trusted-quote count past 65,533, the postgres.js
   Int16 wire cap made the enrichment pass throw before its first snapshot,
   every ~60s, forever. The same latent bomb existed in the outcome/
   performance due-pool lookups and every unchunked bulk insert.

**Decision 1 — youth is measured in blocks.** `ActivePoolCriteria` now takes
`activeMinCreatedBlock`, compared against `pools.created_at_block`. The
worker resolves the cutoff by binary-searching block timestamps
(`findBlockNumberByTimestamp` in `@assay/chain`, O(log n) header reads,
cached 5 minutes — exact under variable block production, unlike
head-minus-constant extrapolation). Wall-clock ingestion time is never a
youth signal again: the same bug would otherwise recur after any extended
downtime catch-up.

**Decision 2 — chunk anything population-scaled.** All address-list queries
chunk at 30,000 parameters (postgres.js caps at 65,534; PGlite's serializer
rejects >32,767, and validation tooling runs on PGlite) and all bulk writes
chunk at 2,000 rows. Chunked idempotent writes stay restart-safe by the
same argument as crash-mid-pass; `upsertTokenHolders` chunks inside its
caller's transaction, preserving cursor atomicity. The due-for-outcome/
performance selection also aggregates first-snapshot times in SQL
(`min() group by`) instead of streaming the whole append-only snapshot
table into memory each pass.

**Tuning:** production `.env` sets `ACTIVE_POOL_MAX_AGE_HOURS=24` (code
default stays 72). Measured on-chain, 72h of launches on this chain is
~35k pools — multi-hour passes; 24h is ~11k. The watch band, not the youth
window, is what keeps maturing candidates on full cadence.

## 2026-07-11 — Judgment layer: advisory LLM briefs, strictly downstream of alerts

An LLM "judgment" layer turns the evidence behind an ORANGE/RED alert into a
structured research brief (thesis, top-3 tagged risk calls, disconfirming
evidence, confidence, "what would change this call"). Core decisions:

- **Advisory-only, enforced by dataflow.** The judgment loop consumes rows
  from `alerts_sent` *after* the deterministic scoring loop has committed and
  delivered the alert. The LLM cannot gate, delay, or mutate what surfaces;
  if the judgment subsystem is down, alerts fire unchanged. This is the
  AGENTS.md rule ("an LLM must never be the authoritative judge") made
  structural.
- **Briefer, not judge.** The deterministic layer decides what surfaces; the
  LLM argues over evidence; the human decides. The brief is delivered as a
  follow-up Telegram message through the existing fan-out transport — not by
  editing the alert message, and not inline (a failed brief degrades to
  silence, never a mutated alert). Reply-threading per chat was rejected for
  v1: fan-out produces one `message_id` per subscribed chat, and persisting
  per-chat ids buys little over a clearly-labeled follow-up.
- **Machine-checked citations.** Every claim in a brief carries evidence
  pointers `{table, rowId, field, claimedValue}` into the append-only
  snapshot tables (all bigserial PKs). A pure checker re-fetches each cited
  row and verifies the claimed value (tolerance band for numerics). A brief
  whose load-bearing citation fails verification is persisted as
  `REJECTED_FABRICATED_CITATION` and never delivered. Fabrication rate is a
  first-class metric.
- **Typed tools, never free SQL.** The judge queries history through a fixed
  toolkit (comparable launches via k-NN over `token_performance.entryFeatures`,
  population base rates, deployer history, liquidity trajectory, slippage at
  size, cohort percentiles, market series, cited-row fetch). Tool arguments
  are addresses/numerics/enums only — attacker-controlled strings (token
  name, symbol, website) cannot reach a query by construction. Every call is
  recorded in `judgment_tool_calls` (args, returned row ids, digest), so a
  brief has a replayable tool trace.
- **As-of discipline extends to tools.** Trajectory and slippage tools are
  pure over the bundle's `captured_at <= asOf` series; comparables and base
  rates filter labels to `labeled_at <= asOf`; cohort percentiles are
  live-only and report themselves unavailable during replay rather than
  leaking a present-day cohort into a historical brief.
- **Adversarial strings are fenced data.** Bundle fields carry provenance
  (`CHAIN_NUMERIC` / `CHAIN_DERIVED` / `ATTACKER_STRING`); attacker strings
  are length-capped, fenced, and prefixed with an explicit untrusted-data
  preamble. Injection canary fixtures (clean vs poisoned pair with identical
  numerics) are part of the deterministic test suite.
- **The eval loop is the point.** `token_performance` / `token_outcomes` are
  deliberately not conditioned on alerts, so they ground-truth the judge for
  free. A replay harness reconstructs bundles as of historical band entries
  (same `getXAt` reads the performance labeler uses), the realized outcome is
  classified RUGGED / BLED / HELD_BAND / RUNNER, and briefs are scored per
  prompt version: Brier score on the implied hit probability, per-risk-tag
  precision/recall, confidence calibration, fabrication rate. Prompts are
  versioned and hashed in `prompt_registry`; tuning follows the existing
  out-of-time rule — iterate on one period, report on a later untouched one.
  No LLM-graded metric anywhere on the critical path.
- **Cost model.** Only ORANGE/RED alerts are briefed (config: minimum level),
  a population of roughly single-to-low-double digits per day — one strong
  model per brief is negligible next to RPC spend. No cheap-triage LLM tier:
  the deterministic classifier already is the triage.

## 2026-07-11 — External API bodies are classified input, never crash vectors

Production crash (20:09Z): the worker died on `SyntaxError: JSON Parse
error: Unexpected EOF` — an external HTTP body (Telegram Bot API /
Blockscout class) parsed without a guard. Docker's restart policy recovered
it in under a second, but "unknown errors crash" was doing the wrong work
here: a truncated response from a third-party API is a *classifiable,
transient* failure, not an unknown failure mode that must be seen.

Fixes:

- `createTelegramUpdatesApi` now throws a typed `TelegramApiError` for all
  four failure shapes (network failure, non-OK status, malformed/truncated
  JSON body, not-ok envelope), and `runSubscriptionsLoop` classifies it as
  recoverable — log, back off, retry. Any other error still crashes.
- The risk engine's explorer verification fetch guards its JSON parse the
  same way the holders reader always did: a garbage body is a missing
  signal (verification `UNKNOWN`), never a thrown pass failure.

Rule going forward: every `response.json()` / `JSON.parse` on bytes that
crossed the network is wrapped and classified at the call site. The crash
discipline is reserved for our own invariants, not other people's servers.

## 2026-07-11 — Activity cursor deliberately fast-forwarded past the historical swap backfill

Observed live: discovery had reached block ~7,244,000 while activity was at
~1,743,000 — the swap backfill was ~5.5M blocks (days of wall clock) behind,
because swap-log scanning is far heavier than pool-creation scanning. The
funnel consequence: fresh launches had no swap rows, so `uniqueBuyers1h`
was null for exactly the pools that matter, the min-buyers rules could
never pass, every candidate stayed GRAY, and zero alerts had ever fired
despite ~66 pools meeting YELLOW's FDV/liquidity envelope in a single
6-hour window.

Decision: advance `activity_cursor.latest_processed_block` to just behind
the discovery cursor (a ~100k-block / few-hour tail) and let live ingestion
run from there, rather than wait days for a backfill of swaps in
long-dead pools.

This is an explicit operator action recorded here — not a silent skip. The
"never silently skip an event" rule protects against undetected gaps; this
gap is deliberate, bounded, and documented. Consequences accepted:

- `pool_swap_events` history for pools created before the fast-forward
  block starts at the fast-forward, so their buy-shape / retention /
  early-buyer signals are null (conservative defaults) and
  `token_performance.entryFeatures` for pre-cutover band entries lack
  activity fields.
- Survival/performance labels are unaffected (they read `pool_snapshots`).
- If full historical swap coverage is ever wanted, a one-off bounded
  backfill job can walk the skipped range without touching the live cursor.

## 2026-07-11 — Activity ingestion joins the active-set cost model (production stall)

After the cursor fast-forward, the activity pass stalled outright: per
2000-block chunk it loaded every trusted-quote pool ever discovered (~62k),
issued `getLogs` with the full address list, and rebuilt a rolling-window
snapshot for **every** pool — each one reading that pool's **entire** swap
history. Near the chain's origin the "pools created before this chunk" set
was tiny, so the design worked by accident; near head it is the whole
population inside one transaction (observed: 141% CPU, 2.7GB RSS, zero
commits in 10+ minutes). Same failure class as the enrichment active-set
incident.

Fix, mirroring the established enrichment/risk/holders pattern:

- **Active-scoped chunk selection** (`listActiveTrustedQuotePoolsCreatedBefore`):
  swap logs are fetched only for active pools (young by on-chain block, or
  latest FDV inside the watch band). Safe for the funnel by construction:
  the watch band contains every alertable FDV band, so any pool that could
  reach YELLOW/ORANGE/RED is active and therefore ingested.
- **Snapshots only for swap-touched pools** per chunk, plus a bounded
  **refresh lane** (`listActiveTrustedQuotePoolsNeedingActivityRefresh`,
  default 15min/400 pools per pass) so rolling buyer windows decay for
  active pools that stopped trading — including on fully-caught-up passes.
- **Windowed event reads** (`listPoolSwapEventsSince`, one multi-pool query
  bounded to `ACTIVITY_MAX_WINDOW_MS`): snapshot construction never reads a
  pool's full swap history again.
- **Cursor initialization** computes its full-population minimum only when
  the cursor is absent — it was silently re-loading all pools every pass.

Accepted consequence: swaps for pools outside the active set are not
ingested from here on (their last snapshot goes stale and is not refreshed).
Those pools cannot alert — alerting requires an in-band FDV, which would
make them active — so the omission never starves the funnel; it is the same
trade the enrichment idle lane already made. `poolsRefreshed` is reported on
every `activity.pass` log line for observability.

Addendum (same date): the scoring/alert pass had the same shape — it
iterated every trusted-quote pool (~72k) per pass, spending per-pool
candidate-assembly queries on pools that must classify GRAY. It now accepts
the same `ActivePoolCriteria` and evaluates only the active set; the
full-population path remains for tests and explicit tooling.

## 2026-07-12 — Cohort percentiles compare live pools; append-only reads need time anchors

`getCohortPercentiles` streamed the entire `pool_activity_snapshots` table
(1.4M rows and growing) to the client per candidate, then picked
latest-per-pool and age-filtered in TS. At ~1,100 in-band candidates per
scoring pass that was the difference between minutes and unbounded hours.

Rewritten: SQL `DISTINCT ON (pool_address)` restricted to snapshots younger
than a freshness window (default 60 minutes; parameterized), age band
applied over the reduced set, backed by a new `(chain_id, captured_at)`
index (migration `0012_activity_time_idx`). The freshness cutoff is a
semantic improvement, not just an optimization: the cohort was always
documented as "live pools of comparable age", and a pool whose last
snapshot is a day old is not live — its stale windows were polluting
percentiles.

General rule adopted: any read over an append-only table must be anchored —
by pool, by cursor, or by time window. Unanchored scans get slower forever
by construction.

## 2026-07-12 — jsonb payloads are serialized explicitly; per-item errors surface a message

The first real candidates exposed a latent MVP bug: `CandidateFeatures`
carries a bigint (`blockNumber`), drizzle's jsonb mapping JSON.stringifies,
and every above-GRAY persist threw `Do not know how to serialize a BigInt`.
The funnel produced candidates and delivered zero alerts, and the pass log
only carried a pool-error COUNT, so the failure was invisible.

- Persisted jsonb payloads go through an explicit serializer (bigint →
  string, Date → ISO) at the write site — never a bare type-cast of a
  domain object.
- Pass logs carry the first per-item error message, not just a count. A
  100%-failure mode must be readable off one log line.
- An end-to-end funnel regression test (seed pool/snapshot/activity →
  score → persist → deliver on PGlite) is mutation-verified against this
  exact bug and guards the whole silent-candidate class.

## 2026-07-12 — Expensive signals are scheduled by FDV band, not global staleness; quality rules leave the hard gate

A production audit (~1.5 days live) showed the funnel structurally unable to
surface anything: holder/deployer features were NULL on 89/89 candidate rows
(64 holder snapshots existed with zero overlap with the 36 scored tokens),
sell-sim was UNKNOWN on 62/89, the score ceiling was ~45 against an ORANGE
threshold of 65, and zero tokens were eligible — while ~2,000 pools had
already crossed $100k FDV. Root cause was scheduling, not thresholds: the
expensive passes (holders, risk, scoring) swept the whole ~14k-pool active
set by staleness in arbitrary or oldest-first order, unbounded, so the
scarcest signal budget was never aimed at band tokens. Band transit is slow
(median 40k→100k ≈ 9.5h), so coverage — not latency — was the binding
constraint.

- Selection for holders/risk/scoring is now band-first: a `FdvBandCriteria`
  (latest-snapshot FDV inside the watch band) drives a bounded band lane
  that always runs before a bounded backlog lane (young pools). SQL-side
  staleness replaces per-pool staleness queries. No queue table: idempotent
  DB selection IS the priority queue, and stays restart-safe by construction.
- Eligibility is tiered. Safety rules stay hard and missing-data-fails
  (sell sim, sell loss, permissions, liquidity, age, band, trusted quote,
  LP-pull). Quality rules (unique buyers, deployer %, adjusted top-10) move
  to advisory `softFailedRules` + `quality:` reasons and shape the score
  instead of gating it — with lagging acquisition, missing-data-fails on
  quality made eligibility impossible for every token regardless of merit.
- GRAY band candidates now persist their full feature vector + score on a
  throttle (default 1h/token): threshold calibration needs the
  counterfactual population, and alert-only persistence bakes in selection
  bias. Forward labels come from the existing alert-independent
  `token_performance` labeler.

## 2026-07-12 — VIRTUAL joins the trusted-quote allow-list

VIRTUAL (`0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31`) is added as a fourth
trusted quote asset, confirmed canonical by Virtuals Protocol's own
whitepaper contract-address page (not inferred from pool activity).
Empirics corroborate the paper source: 3,156 discovered pools already pair
against VIRTUAL, the deepest (VIRTUAL/WETH
`0xd95e8e2Cd04c207625C6F23c974d365a5F3A91D3`) holds ~$892k quote-side /
~$1.78M total liquidity, and price (~$0.64) is consistent across 4
independently-checked pools. VIRTUAL is Robinhood Chain's day-one AI-agent
launchpad currency — graduations alone seed roughly 42k VIRTUAL pools —
which is the actual justification: this is a volume decision, not a
stablecoin-parity one (docs/data-sources.md has the full trail, including
the harmless on-chain `totalSupply()` anomaly).

The allow-list preference order (`classifyQuoteSide`, config order) is
WETH, USDG, USDC, then VIRTUAL LAST. VIRTUAL only classifies a pool's quote
side when none of the other three is present — an existing VIRTUAL/WETH
pool keeps WETH as its quote, matching every row already in the database.

VIRTUAL/USD anchoring is chained, not independent: at every enrichment
pass, `resolveUsdAnchor` reads the deeper of the VIRTUAL/USDG and
VIRTUAL/WETH pools (USDG balance at $1, or WETH balance times the
already-resolved `wethUsdWad`) and prices VIRTUAL through whichever side is
deeper. This is a live read every pass — the same mechanism as WETH/USD,
one hop further — never a cached or staleness-checked price.

The circuit breaker is an anchor DEPTH FLOOR, not staleness: if the best
VIRTUAL anchor pool's quote-side USD depth is below `minAnchorDepthUsd`
(default $50k, `packages/enrichment/src/anchor.ts`), VIRTUAL/USD resolves
null and VIRTUAL-quoted pools get the existing `no-usd-anchor` null
snapshot rather than a price computed off a pool an attacker could drain to
manipulate. This mirrors the accepted WETH/USDG anchor-manipulation
tradeoff (2026-07-10 entry above) but adds an explicit floor because
VIRTUAL's anchor pools are newer and thinner than WETH/USDG.

Startup renormalization backfills existing rows rather than a one-off
migration: `renormalizeUntrustedPools(db, chainId, quoteAssets)`
(`packages/database`) runs at every worker startup after quote-asset
seeding and, for each configured asset in order, updates pools whose
`quote_token_address` is still null and whose token0/token1 matches that
asset. It backfilled ~3,156 pre-existing VIRTUAL-quoted pools that had been
sitting with a null quote side (discovered before VIRTUAL was
allow-listed). Being generic and idempotent — a null-quote pool cannot
already contain a listed asset, so ordering only matters among newly-added
assets in the same run — it requires no code change for the next
allow-list addition and is safe on every restart (a second run updates
zero rows).

USDC remains correctly un-allow-listed: still absent from both Circle's and
Robinhood's own canonical token registries as of 2026-07-12
(docs/data-sources.md). Revisit trigger: either registry lists a
chain-4663 USDC address.

## 2026-07-11 — Score recalibration: six attainable components, dedup'd flow, delivery floor 60

A formula audit found the 0–100 opportunity score was structurally
miscalibrated. The attainable ceiling was 79 (75 for a first-time
deployer): `priceStructure` could realistically award 5/10 (its only live
inputs were the 20m flow fields plus "a price exists"), `walletQuality`
7/15, `holderGrowth` 11/15, and `projectEvidence` was a constant 1/5.
Meanwhile ~25–30 points were unconditional table stakes, compressing every
in-band candidate into roughly 50–79 — the operator's observation that "the
first 50 points are a non-starter". RED (≥75) required 95% of the true
ceiling and had never fired. The 20m flow fields were also double-counted
(organicBuying AND priceStructure — 12 of 79 attainable points from the
single most manipulable signal), flow had no dust floor, and a malformed
volume string silently parsed to `0n`, making a corrupted sell volume read
as bullish net inflow.

Decision: rather than renormalizing thresholds against a broken scale,
rebuild the scale so 0–100 is real. Six components, each maximum attainable
from currently measured signals: liquidityQuality 30, organicBuying 20,
holderGrowth 15, ownershipDistribution 15, walletQuality 10,
contractTransparency 10. `priceStructure` and `projectEvidence` are removed
outright instead of carried as placeholder constants — a component that
awards identical points to every candidate has zero ranking information and
only shifts the scale; each returns when its real signal (price history,
web evidence) is implemented. The liq/FDV ratio input switched from total
to quote liquidity (the token side of total is valued by the token's own
price and trivially inflatable). Flow points are dust-guarded
(`flowFloorMinBuys20m`/`flowFloorMinUniqueBuyers20m`, default 5/5) and only
organicBuying reads the flow fields now. Volume parsing is strict: a
malformed string withholds flow-volume points with a risk reason.

Components are stored as jsonb, so the shape change needs no migration;
historical rows keep the eight-key vector and remain interpretable against
the scoring model in force when they were written (append-only history is
never rewritten).

ORANGE (65) / RED (75) score thresholds were deliberately KEPT: on the new
scale they sit at 65%/75% of an attainable range instead of 82%/95% of an
unreachable one — RED becomes a live tier, ORANGE tightens slightly for
thin-data candidates. `ALERT_MIN_SCORE` default moved 50 → 60 per operator
request to limit delivery to genuinely compelling candidates (~5–10/day
target): 60 on the new scale admits only top-quality YELLOWs plus all
ORANGE/RED. The floor is a quality gate, not a rate limiter — first-week
delivery volume should be checked against `alerts_sent` and the floor tuned
±5 (docs/scoring-model.md has the query). Out-of-time calibration of all
thresholds against realized outcomes remains the standing follow-up once
labels accumulate.

## 2026-07-11 — Stoplight alert tiers + per-token brief dedup

Operator-requested rename to stoplight logic: GREEN replaces RED (go —
high-priority review), YELLOW replaces ORANGE (caution — research
candidate), and the old early-watch YELLOW becomes RED (stop — seen, too
early to act). GRAY stays the no-light stored-only tier. All four tiers
were kept rather than collapsed: the level is the composition point where
eligibility × FDV band × score × invalidation become one actionable state
(the score alone is deliberately eligibility-independent), and it drives
four mechanisms — the GRAY invalidation cap, escalation-bypass dedup, the
judgment trigger, and retro/calibration slicing.

The rename is a semantic-preserving relabel, so migration
`0014_stoplight_levels` rewrites historical `alerts_sent` /
`token_score_results` rows to the new vocabulary in a single CASE statement
per table (mapping verified against seeded legacy rows). This is the one
deliberate touch of append-only history: leaving old strings in place would
make "YELLOW" mean two different tiers depending on row age, corrupting the
escalation-rank comparison in alert dedup and every level-keyed report.
Config renames follow suit (`AlertThresholds` red*/yellow*/green* keys,
`JUDGMENT_MIN_ALERT_LEVEL` accepts RED|YELLOW|GREEN, default YELLOW); an
explicit legacy env value hard-fails at startup rather than silently
filtering the wrong tiers (see DEPLOY.md upgrade note).

Same batch, production bug: repeat research briefs. Brief dedup was
per-alert (`judgment_briefs.alert_id` unique), but every legitimate
re-alert of the same token (cooldown + score-delta, or escalation) inserts
a new `alerts_sent` row — so a token camping in the band got a fresh LLM
brief every re-alert. `listAlertsNeedingBrief` now also suppresses per
token: an alert is skipped when its token already has a COMPLETED LIVE
brief created within `JUDGMENT_REBRIEF_COOLDOWN_MS` (default 24h), unless
the new alert's level outranks the briefed one — an escalation earns a
fresh brief immediately. FAILED / REJECTED_FABRICATED_CITATION briefs never
suppress (the operator never received them), and 0 disables the gate. The
suppression is SQL-side (EXISTS with a rank CASE), so the batch limit still
fills with briefable alerts.

## 2026-07-12 — RED-only delivery floor: escalation pairs are the residual repeat source

With the delta gate live, production `alerts_sent` showed zero same-level
repeats without a +10 score improvement — the 2026-07-12 dedup fix holds.
The residual "repeats" the operator still saw were escalation chains: 13 of
~58 alerted tokens in a 9h window paged twice, RED first (score crossed the
60 floor while still early-watch), then YELLOW 20–40 minutes later when
eligibility and the band landed. Escalations bypass cooldown by design —
the YELLOW is the actionable signal and must never be delayed — so the fix
targets the RED leg instead: RED is defined as non-actionable ("seen, too
early to act"), and a RED page that upgrades within the hour delivered no
information the YELLOW doesn't.

Decision (operator-selected over "stop delivering RED entirely"): a
RED-only delivery floor. `evaluateAlert` takes an optional `minScoreRed`;
the effective floor for RED-level alerts is `max(minScore, minScoreRed)`
(never lower than the global floor), YELLOW/GREEN keep `ALERT_MIN_SCORE`.
Default 70 (`ALERT_MIN_SCORE_RED`; 0 falls back to the global floor) —
chosen from the same 9h window, where it would have kept ~5 of 24 delivered
REDs, all high-conviction. Roughly half of delivered REDs never escalate,
which is why RED delivery survives at all: those are the standalone
watchlist pings. Suppressed REDs are still classified, scored, and
persisted; a later escalation delivers as a first alert.

The winners-retro tier-6 (below-floor) attribution mirrors the same
level-aware floor, so a RED-suppressed winner is honestly attributed to the
delivery floor rather than counted as caught.

Same batch, operator-requested format change: alert headers are now glyph +
token name only (`🟡 Token (SYM)`) — the color IS the level; the level word
was redundant.

## 2026-07-12 — Duplicate-name delivery cooldown: copycat waves defeat per-token dedup

Operator report ("robinworld about 5 times in 15 minutes as both red and
yellow") turned out not to be a gate bug: production `alerts_sent` showed
four DISTINCT "Robin World" contracts (plus 3× "robin house", 3× "Robinhood
Super Cycle") each alerting once as its own legitimate first alert — four
of them within 11 seconds. Serial same-name deployments are launch-farm
spam; per-token-address dedup is structurally blind to them, and they are
exactly the "one controller manufactured most of the activity" pattern the
core hypothesis wants excluded.

Decision: a delivery-level duplicate-name cooldown, same class as the
delivery score floor — never an eligibility or scoring change.
`getLatestDeliveredAlertBySimilarName` (packages/database) finds the most
recent DELIVERED alert within a window for a different token whose
normalized name matches (lowercase, stripped to `[a-z0-9]`; normalization
lives in one place, mirrored TS-side for the param and SQL-side via
`regexp_replace` for the column). `evaluateAlert` suppresses when the new
alert's level does not outrank the sibling's — so the strongest launch of
a wave still surfaces (RED sibling then YELLOW copy delivers; a third
identical RED does not), mirroring the escalation semantics of per-token
dedup. Only delivered siblings suppress (an alert the operator never saw
must not hide anything); suppressed candidates are still scored and
persisted, reason `duplicate-name:<level>@<siblingToken>`.
`ALERT_DUPLICATE_NAME_COOLDOWN_MS` default 6h; 0 disables.

Accepted limitations, deliberate: token names are attacker-controlled, so
a spammer can evade by varying names — but that surrenders the copycat
branding that motivates the wave. Conversely a genuinely independent
project reusing a recently-alerted name is suppressed unless it outranks
the sibling; it remains persisted and re-eligible after the window.
Combined with the RED-only floor shipped the same day, the observed
"Robin World" wave (4 delivered pings) replays to exactly 1.

## 2026-07-12 — Performance labeling starvation: band membership moved into the due-query

Pre-week-check-in audit found `token_performance` frozen at 13 rows while
`token_outcomes` (2,995) and GRAY shadows (4,985) flowed — with
`performance.pass` logging `labeled:0 skipped:200` every hour. Cause: the
due-filter was "first snapshot ≥ horizon old AND not yet labeled", batch
200, ordered oldest-first — but the pass persists nothing for a pool that
never entered the $50k–$200k band, so never-band pools stayed "due"
forever. On a chain where only 1,746 of 76,771 pools ever snapshotted
inside the band, the 200 oldest never-band pools permanently occupied
every batch and starved every real band entrant behind them. (Outcomes
never had this failure mode because it labels every considered pool; this
is the same starvation family the 2026-07-12 band-priority work fixed for
holders/risk.)

Fix: `getPoolsDueForPerformance` now preconditions in SQL on an actual
band entry — EXISTS a priced snapshot inside the configured band captured
at least `horizonHours` ago (which also implies the label window has
elapsed, since the true entry is at or before any matching snapshot) —
plus the existing NOT EXISTS per-horizon label check. Never-band pools
never enter the due-set, so nothing needs a sentinel row and
`token_performance` stays pure band-entry labels. The TS pass remains the
precise entry authority; a lossy-parse boundary disagreement re-skips one
pool, never the batch. Backlog math: ~1.7k due pools at 200/pass/hour
clears in under 9 hours per horizon.

## 2026-07-12 — Tool-call results are citable: the checker verifies the trace, never re-executes

A production audit of the first 76 briefs found a 53% rejection rate
(40 REJECTED_FABRICATED_CITATION) that was overwhelmingly NOT model
fabrication: of 128 failed citations, ~52 cited history-tool outputs
(`deployerHistory.tokenCount`, `baseRateForPattern.diedPct`, trajectory
drawdowns) under invented table names like `functions.deployerHistory`,
and ~58 cited tool-computed field names against `pool_snapshots` rows
(`currentQuoteLiquidityUsd` / `peakQuoteLiquidityUsd` /
`drawdownFromPeakBps` — the real column is `quoteLiquidityUsd`). Root
cause was a contract contradiction: the prompt required citing "every
factual claim" including tool output ("…or returned by a tool"), while
`CITABLE_TABLES` only resolves seven DB tables — derived tool values
(aggregates, drawdowns, base rates) exist on no row at all, so the model
structurally could not comply. Only a handful of failures (prose in the
field slot, one degenerate `token.name` pointer) were genuine junk.

Fix, three parts:

1. The engine labels every tool message with a citable ref by string
   splice — `{"callRef":"judgment_tool_calls:<seq>","result":<original
   bytes>}` — so `resultDigest` still hashes the inner payload unchanged,
   and the trace now carries `resultJson` verbatim.
2. `checkCitations` accepts the tool trace and resolves
   `judgment_tool_calls:<seq>` pointers against the exact top-level result
   keys the model was shown. It deliberately NEVER re-executes a tool:
   results are time-sensitive (`currentQuoteLiquidityUsd` reads the latest
   snapshot), so the only honest comparison is against the bytes the model
   actually received. Tool correctness itself stays a unit-test concern;
   the citation guarantee is "every number in a brief was produced by
   deterministic code and the model quoted it faithfully."
3. Migration `0015` persists the result body on `judgment_tool_calls`, so
   replay/eval re-verification of historical briefs compares against the
   audited payload, not a re-run.

Also loosened deterministically: a claim against a jsonb array column
(e.g. `token_risks.riskReasons`) now verifies against the full
serialization OR exactly one element — quoting a single risk reason is
honest, not fabricated (was 9 of the 128 failures). The prompt's evidence
section now names exactly two citable source kinds (evidence "table:id"
refs; tool callRefs) — the template hash change mints a new prompt version
in the registry at startup, so eval slices stay per-version comparable.
Rejection policy is unchanged: REJECT iff a load-bearing clause (thesis or
riskCall) fails. 742 tests.

## 2026-07-13 — Focus band replaced with $10k–$100k; band thresholds become worker config, not scoring constants

Operator decision: replace the ~$40k–$300k watch / $75k–$250k eligibility /
$90k–$225k research band with a $10k–$100k focus band, recalibrating the
band-proportional gates (liquidity floors, buyer counts, slippage probe
notionals) rather than holding them constant — the old floors, calibrated
for a $75k+ token, would reject nearly everything in the new band. Safety
caps (min age, max sell loss, max deployer %, max adjusted top-10 %) and
the 65/75 score gates are deliberately unchanged: smaller-FDV pairs are
more adversarial, not less, so a band move must never loosen safety.

Two architectural consequences beyond the numbers:

- **Eligibility and alert-tier thresholds moved from hardcoded scoring
  constants to `WorkerTuning`** (`ELIGIBILITY_*`, `ALERT_RED_*`/
  `ALERT_YELLOW_*`/`ALERT_GREEN_*` env keys), threaded explicitly through
  every caller of the eligibility/score/alert-level trio — scoring pass,
  winners-retro replay attribution, and the `validate:candidate` CLI. This
  closes a standing violation of types.ts's own "must stay configurable"
  invariant and makes future band tuning an env edit instead of a deploy.
  The standalone `ALERT_BANDS` table in alert-level.ts was folded into the
  `AlertThresholds` contract so a single object carries every tier gate.
  Callers may not ride the module defaults: a caller that did would
  silently diverge from the live pass under any env override, so the
  worker builds the two config objects once from tuning and passes them
  everywhere. Score gates and safety caps stay scoring-model constants
  with no env keys — they are not band parameters.
- **`scoreLiquidityQuality`'s quote-depth tiers are band-coupled and were
  rescaled** ($10k/$15k/$25k/$50k/$100k → $2.5k/$5k/$10k/$20k/$30k), the
  only absolute-USD constant among the six score components (everything
  else is ratio-, count-, or bps-based). Without this, the old top tiers
  exceeded the entire new band, leaving the 30-point liquidityQuality
  ceiling unattainable — violating the 2026-07-11 "every component maximum
  attainable" invariant and structurally suppressing YELLOW/GREEN. Tier
  breakpoints stay inline in score.ts (scoring-model internals under the
  change protocol), not env — they are model shape, not deployment tuning.

Ingestion and enrichment needed zero changes: every pool was already
ingested and every trusted-quote pool priced at any size, so the band only
moves which already-captured pools clear the gates. Capturing *more* pairs
(launches against non-allow-listed quote assets) is a quote-asset
allow-list question and was explicitly scoped out. The new threshold
values are engineering-chosen to tile the band, not backtested — they are
pending out-of-time validation against `token_performance`/`bun run
calibrate` (whose reference band moved with it, $50k–$200k → $10k–$100k)
once labels accumulate in the new band.

## 2026-07-13 — RPC capacity exhaustion is recoverable: enrichment halts uniformly, auth failures stay fatal

The Alchemy compute-unit balance hit zero and the worker crash-looped for
the whole outage instead of backing off. Two root causes, both fixed:

- **Enrichment was the only loop without a typed halt.** Discovery,
  activity, risk, and holders wrap `RetryExhaustedError` in a
  `*HaltError` their loop treats as recoverable; enrichment wired
  `isRecoverable: () => null`, so one exhausted head-block read rejected
  `Promise.all(loops)` and exited the process. New `EnrichmentHaltError`
  (mirrors `HolderHaltError`) wraps the two pass-level reads
  (`getBlockNumber`, `resolveUsdAnchor`) in `runEnrichmentPass`; the
  worker loop now logs `enrichment.halted` and backs off 4× the poll
  interval. Per-pool read errors were already caught into `poolErrors`
  and are unchanged.
- **Alchemy's capacity errors were not classified transient.** Production
  logs (2026-07-13 outage) show two signatures, neither HTTP-level:
  `RpcRequestError` with JSON-RPC error code `429` ("Monthly capacity
  limit exceeded", HTTP 200 body) and viem's `ResourceNotFoundRpcError`
  (JSON-RPC `-32001`, "Unable to complete request at this time").
  `isTransientRpcError` only covered HTTP 429/5xx and RPC codes
  -32005/-32603, so `withRetry` rethrew raw and no `RetryExhaustedError`
  (hence no halt) ever formed. Both observed signatures are now
  transient: code `429` added to `TRANSIENT_RPC_CODES`, and
  `ResourceNotFoundRpcError` accepted by instance (our workload reads
  only canonical state, so a genuine not-found is anomalous; bounded
  retries then a halt is right either way).

Decision rule: credit/capacity exhaustion self-heals on top-up →
transient, back off and resume. Authentication failure (HTTP 401/403)
needs a human → stays non-transient, hits `isRecoverable → null`, and
crashes the worker loudly by design.

Data consequence, accepted: discovery and swap ingestion auto-backfill
from persisted cursors, but enrichment/holder snapshots are live
point-in-time reads — an outage window is a permanent gap in those time
series. Reconstruction would need archive replay at historical blocks;
documented as an on-demand contingency, not built.

## 2026-07-14 — Band lanes gate on quote liquidity, not FDV alone: dust must not spend getLogs budget

After the 07-13 band lowering, Alchemy CU burn roughly doubled instead of
dropping, dominated by `eth_getLogs`. Root cause: the $10k floor admitted
a large tail of dust pools into the watch band. Band membership is decided
by estimated FDV, and estimated FDV is nominal (price x total supply), so
a pool with a few dollars of real capital can report any FDV. Each newly
in-band pool that had never been holder-scanned triggered a cold transfer
log walk from pool creation to head in 2,000-block chunks: hundreds to
thousands of getLogs calls per pool, drip-fed 300 per holders pass. The
low-CU profile could not help; its dominant lever
(`ACTIVE_POOL_MAX_AGE_HOURS`) bounds the enrichment active set, while the
holders/risk band lanes are FDV-scoped with no age or liquidity bound,
and with ~10k in-band pools those lanes run permanently saturated.

Decision: the expensive-signal band lanes (holders, risk) additionally
require the latest snapshot to carry a minimum of trusted-quote liquidity,
`BAND_LANE_MIN_QUOTE_LIQUIDITY_USD` (default $500, 0 disables). Rationale:

- **Quote liquidity is the honest band signal.** FDV can be faked by
  supply choice; quote-side capital cannot. This is the same reasoning
  that already makes quote liquidity (not total liquidity) the eligibility
  gate's load-bearing term.
- **Nothing alertable is lost.** Eligibility requires >= $2,500 quote
  liquidity, so a sub-$500 pool can never alert. If liquidity later
  arrives, the next enrichment snapshot lifts the pool over the floor and
  the lanes pick it up: the floor reads the LATEST snapshot, so entry and
  exit are automatic.
- **The training set keeps its labels.** `token_performance` labeling,
  enrichment pricing, scoring, and GRAY shadow-logging are untouched;
  every band entrant is still priced, snapshotted, and outcome-labeled.
  Sub-floor entrants lose only holder/risk-derived entry features (null),
  which `calibrate` already tolerates. The risk backlog lane (active-set
  staleness sweep) still reaches dust pools, so risk features keep
  accruing at backlog priority.
- **Deliberately NOT a floor on the watch band itself.** Raising
  `WATCH_MIN_FDV_USD` (e.g. to $20k) was considered and rejected as the
  primary fix: it amputates exactly the low-cap entrants the product
  exists to catch, shrinks the calibration population, and still admits
  dust (nominal FDV clears any FDV bar). It remains available as a pure
  env lever if measured burn stays too high.

Also made the holder scan chunk span configurable
(`HOLDERS_SCAN_CHUNK_BLOCKS`, default 2,000): cold walks cost calls
proportional to chain height / span, and transfer-sparse tokens tolerate
much wider spans. The low-CU profile documents 10,000 as the suggested
override, cutting cold-scan call count 5x.

## 2026-07-15 — Winners-retro replay reads the shape the performance pass writes; legacy rows honestly stay T4

Context: the first weekly winners retro attributed 33 of 76 realized ≥5x
winners to T4 "signals-missing" (T7 caught = 1). Production forensics
showed the tier was almost entirely an artifact: the retro's replay
fallback parsed `token_performance.entryFeatures` against the full
`CandidateFeatures` shape (the shadow-log format from scoring-pass's
`jsonSafeFeatures`), while the performance pass writes its own compact
`PerformanceEntryFeatures` vector. Both cross an untyped jsonb boundary,
so the compiler never saw the mismatch, and the only replay test seeded
the shape production never writes. Every replay parse returned null, so
every winner without a shadow decision within ±2h of band entry — shadow
logging is throttled, skips zero-buyer pools, and didn't exist for the
launch-day burst — fell through to T4.

Decision: the performance pass's stored entry vector is the replay
contract, and the retro reads THAT shape.

- `PerformanceEntryFeatures` now carries every eligibility-gate input:
  20m activity fields, `criticalPermissionPresent` (derived by the shared
  `hasCriticalPermission` helper so live assembly and stored features can
  never diverge on the convention), `isProxy`, `verificationStatus`, and
  full holder detail. All were already fetched by the pass and dropped.
- `parseEntryFeatures` is the strict read-side inverse: every key must be
  present with the right type or the parse fails. A jsonb round-trip
  contract test (`parseEntryFeatures(jsonRoundTrip(buildEntryFeatures(…)))`)
  pins the write and read sides together across files.
- `replayCandidateFeatures` rebuilds the entry-time `CandidateFeatures`:
  identity/price/block from the `token_performance` row itself,
  missing-source defaults copied from `assembleCandidate` (0 buyers /
  UNKNOWN statuses / no critical permission when the source row was
  absent) so a replayed decision equals what the live gate would have
  decided in that state. Signals that cannot be honestly reconstructed
  as-of entry (liquidity trajectory, slippage curve, deployer provenance,
  retention, cohort percentiles) stay null — all are nullable score-side
  inputs, so the replayed score is conservatively biased low (slightly
  overfilling T6 vs T7) and no hard gate is ever fabricated.
- Rows written with the legacy 15-field shape parse to null BY DESIGN and
  keep their T4 attribution: guessing `criticalPermissionPresent = false`
  for them could mint a "caught"/"below-floor" verdict for a token the
  live gate would have refused, and `winner_retro_items` is append-once
  precisely so verdicts never flip after emission.

Consequence for reading retro digests: T4 counts before 2026-07-15 are
not evidence about signal latency; from the first post-deploy labels
onward, T4 means literally "entry features unusable", leaked winners land
in T5/T6 with a named failing rule, and the weekly T5-rule census becomes
the input the formula recalibration was waiting on.

## 2026-07-16 — Oversized getLogs responses bisect the block range instead of crashing the worker

Production incident: the worker crash-looped every ~6 minutes for 4.7h
(46 restarts, snapshots frozen, dead-man correctly paging STALE) while
Alchemy credits were untouched. The activity pass's swap-log fetch
(2000-block chunks filtered on ~21k active pool addresses) hit a dense
swap stretch starting at block 11602049 whose response exceeded viem's
HTTP-transport body cap (`maxResponseBodySize`, default 10,485,760
bytes). viem cancels the body mid-stream and throws
`ResponseBodyTooLargeError`, and that error fell through every safety
net: `isTransientRpcError` does not classify it (correctly, retrying an
identical request cannot shrink the response), so no `RetryExhaustedError`
formed, so the activity pass never wrapped it in `ActivityHaltError`, so
`isRecoverable` returned null and `Promise.all(loops)` exited the
process. The activity cursor stayed pinned at the poison range (correct:
never skip events), making the crash deterministic on every restart.
In each ~6min cycle the fast DB-only loops (winners retro, judgment,
scoring) completed passes, so retro digests kept delivering between
dead-man reminders; enrichment over the 21k-pool active set needed
longer than the window and died mid-pass with zero snapshots every time.

Decision: an oversized response is a range-granularity problem, not a
retry or halt problem, so it is fixed at the fetch layer.
`fetchLogsBisectingOversized` (packages/chain) catches the error
(including wrapped in a viem cause chain), halves the block range,
fetches the halves sequentially (bisection must not multiply concurrent
RPC load exactly when responses are largest), and concatenates in block
order. Wired into both getLogs surfaces: `createRpcLogSource`
(discovery + activity) and the holders reader's transfer scan. A single
block that still overflows the cap rethrows and crashes loudly: that is
a genuine anomaly to see, not an event to skip. Chunk-size tuning
(`ACTIVITY_CHUNK_SIZE` et al.) thereby returns to being a pure
throughput knob with no correctness cliff; the emergency prod override
to 1000 (from 2000) can be reverted after this deploys.

Rejected alternatives: raising `maxResponseBodySize` (moves the cliff,
4GB host memory prefers bounded responses) and classifying the error
transient (retrying the same range deterministically re-fails).

## 2026-07-19 — Backup retention: count-based, not age-based

The 2026-07-19 production incident: the root disk hit 100%, postgres
PANICed mid-checkpoint (`No space left on device` writing
`pg_logical/replorigin_checkpoint.tmp`) and looped in crash recovery,
the worker crash-looped for ~12h, and the dead-man paged "database read
failed" (correct: its own read path was down too). The hog was
`backups/` at 12G: every nightly `pg_dump` is a FULL dump whose size
tracks database growth (217M -> 2.8G compressed in one week), so the
original "prune older than 14 days" policy was structurally unbounded
in bytes; rotation ran fine and still filled the disk.

Decision: `scripts/backup.sh` now keeps the `BACKUP_RETENTION_COUNT`
(default 2) newest dumps and deletes the rest after a successful dump.
Count-based retention bounds backup disk use by construction (N x
current dump size) no matter how fast dumps grow, and two full dumps
are two complete restore points — older fulls add recovery-point
granularity, not safety, and that granularity is what the disk cannot
afford. Pruning stays AFTER the dump under `set -e`, so a failed dump
never deletes existing restore points. Alternatives rejected: shorter
age window (same unbounded failure mode, just later) and a free-space
watermark (more machinery, still no bound on a single runaway dump).

Consequence: backups cap at roughly 2x the current dump size. The
remaining disk pressure is the database itself (~2G/day growth,
append-only pool_snapshots/pool_swap_events by design) — that is a
product data-retention decision tracked in current-status.md Next, not
something the backup script should paper over.

## 2026-07-20 — Model rebuilt from labeled data: explicit-failure safety gate, four covered-signal components, tiers on the 10x zone

The shelved pre-registered re-weight (see 2026-07-20 entry in
docs/history.md and docs/reweight-preregistration-2026-07.md) proved the
weights were not the lever: the winner mass sat behind the eligibility
gate and entry-time signal coverage. A from-scratch pass over the labeled
population (token_performance, horizon 72h, $10k-$100k band, N=9,260,
156 at >=10x) found the gate discarded 76% of >=10x winners on MISSING
sim data (0 of 156 had an explicit FAIL), the GREEN tier targeted the
lowest-10x FDV zone ($50-90k, ~5.5%) while the sweet spot is $15-40k
(8-10%), and only liquidity/buyers/flow/entry-FDV are both covered and
discriminating at entry.

Decision, taken with the operator: (1) safety rules reject only on
affirmative evidence (sim FAIL, known sell loss over cap, detected
critical permission); missing safety data routes to eligible-but-flagged
and the GREEN tier keeps the affirmative sim-PASS requirement, a
deliberate reinterpretation of the AGENTS.md "unavailable risk data must
not make a token actionable" rule, justified because this is a
manual-research alerting system and the operator vets rug risk before
executing. (2) The score is four components built only from covered
entry features (liquidityDepth 35, buyerBreadth 25, buyFlow 20,
lowCapTilt 20); under-covered signals are advisory reasons with zero
points, so coverage gaps can never silently rank candidates. (3) Tiers
re-cut to the measured 10x zone with RED gating on quote liquidity.
(4) Delivery floor 80 on the new scale, measured (~11/day at 68% >=10x
precision on replay) rather than assumed.

Consequence: replayed >=10x winner eligibility rises 7.5% -> 86.5% (the
residual is the retained $2.5k quote floor, which itself keeps 86% of
winners, plus detected critical permissions), while all 539 explicit-FAIL
honeypots stay rejected. The model is engineering-chosen on tune data:
the confirm window was too thin (99 rows, one >=10x), so it ships for
label collection and must pass the out-of-time tune/confirm re-run per
the scoring-model.md change protocol before being called validated. The
fallback if the operator wants stricter safety is reverting only the
sellSimulationPass/maxEffectiveSellLoss gate changes; the rest of the
rebuild stands independently.

## 2026-07-21 — Volume questions read token_score_results, not the labeled winner set

The labeled `token_performance` set is the winner-study population
(band+horizon-gated, deduped), and it structurally under-predicts live
delivery volume: the 2026-07-21 investigation found a three-way
disagreement at floor 80, ~1/day from `calibrate-sweep` on the labeled
replay, ~11/day from the 2026-07-20 rebuild doc (also replay-derived), and
~50/day from live `alerts_sent`. Floor and volume decisions read
`token_score_results` (every scoring pass, carrying `eligible` /
`alertLevel` / `score`) for counterfactual floors, or live `alerts_sent`
for the current floor, via `bun run floor:volume`. `calibrate-sweep` stays
for winner recall/precision only; its `caught` metric is not a volume
estimate.

The same session's died-cohort report adds an operator-prior correction:
among labeled band tokens, RUGGED outcomes concentrate in the high
quote-liquidity and older-at-entry buckets, not the low-liquidity ones.
This is an observation bias (you only see an LP pull where there was LP to
pull), so low liquidity is not itself a rug tell. The engineering lever for
catching rugs earlier is entry-time coverage of sim / permission / holder
data, not a low-liquidity gate or another correlation pass.
