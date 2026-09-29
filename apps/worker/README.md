# @assay/worker

Worker process for Robinhood Chain monitoring.

It applies database migrations, seeds allow-listed quote assets, and runs ten
coordinated poll loops against the same chain client and PostgreSQL database:

1. Discovery: restart-safe factory-log ingestion for V2/V3 pool creation.
2. Enrichment: token metadata plus price/FDV/liquidity snapshots for
   trusted-quote pools.
3. Activity: restart-safe V2/V3 swap ingestion plus rolling buyer/flow
   snapshots for trusted-quote pools.
4. Risk: contract-safety + tradeability assessment for trusted-quote tokens
   (proxy/permission detection, optional route simulation) producing
   append-only `PASS/FAIL/UNKNOWN/ERROR` verdicts.
5. Holders: holder enumeration + adjusted concentration snapshots, band lane
   first (watch-band pools), then a bounded backlog of young pools.
6. Scoring/alerts: assemble each watch-band candidate from the latest
   enrichment, activity, risk, and holder signals; evaluate the tiered
   eligibility gate; score (0-100); classify an alert level
   (GRAY/RED/YELLOW/GREEN stoplight); emit a deduplicated Telegram alert for anything
   above GRAY that clears the `ALERT_MIN_SCORE` delivery floor; and
   shadow-log GRAY candidates (throttled, buyer-live only) for calibration.
7. Outcomes: SURVIVED/DIED labels at fixed horizons per pool.
8. Performance: realized max-multiple/drawdown labels per band entry,
   alert-independent.
9. Subscriptions: Telegram self-service chat subscription sync.
10. Judgment: advisory, citation-verified LLM research briefs for
    YELLOW/GREEN alerts, strictly after delivery, deduplicated per token
    (re-brief cooldown; level escalations bypass).

```sh
bun run worker           # requires .env (see .env.example)
bun run enrich:once -- --limit 10
bun run validate:swaps -- --pool=<pool> --from=<block> --to=<block>
bun run validate:risk  -- --token=<token>
bun run validate:candidate -- --token=<token>   # assemble+score+level, no send
bun run validate:telegram                        # send one test alert
```

Alerts run in DRY-RUN (logged) until `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
are set; then they deliver to Telegram with no code change. While a hard
safety signal is unavailable (e.g. sell simulation UNKNOWN without verified
router/quoter addresses), the eligibility gate correctly withholds
YELLOW/GREEN — by design, never a fabricated pass.

Behavior:

- Malformed configuration stops the worker at startup.
- Discovery `DiscoveryHaltError`, activity `ActivityHaltError`, and risk
  `RiskHaltError` (RPC down after bounded retries) are logged and retried with
  backoff; cursors/selection stay at the last committed point.
- Enrichment records per-pool failures in the pass result and continues; risk
  records a hostile token as an `ERROR` verdict and continues. Unknown
  pass-level failures crash the process rather than retrying blindly.
- SIGINT/SIGTERM abort all loops. Discovery, activity, and risk stop at their
  next safe boundary; enrichment stops between pools. The database closes only
  after in-flight work settles. A second signal force-exits.
- Logs are JSON lines on stdout/stderr, with bigint values serialized as
  decimal strings.

## Live validation (opt-in, never part of `bun run test`)

```sh
bun run validate:range -- --from=8930 --to=200000
```

Scans a fixed historical range into a scratch in-memory database using the
production discovery pass and cross-checks per-factory pool-creation counts
against the Blockscout logs API (adaptively splitting ranges the explorer
refuses or truncates). Exits non-zero on mismatch.

## Swap validation (opt-in, never part of `bun run test`)

```sh
bun run validate:swaps -- --pool=0x... --from=123 --to=456
```

Uses the configured database for pool metadata, scans that pool/topic over the
fixed range through RPC, cross-checks the count against Blockscout, prints
decoded BUY/SELL/UNKNOWN counts, and exits non-zero on mismatch. The command
does not mutate pipeline tables.

## Risk validation (opt-in, never part of `bun run test`)

```sh
bun run validate:risk -- --token=0x...
```

Runs one real risk assessment for the token's trusted-quote pool against the
configured database + RPC (+ Blockscout for verification) and prints the
explainable verdict: status, proxy, permission findings, simulation, and
reasons. Tradeability simulation runs only when `RISK_V2_ROUTER_ADDRESS` /
`RISK_V3_QUOTER_ADDRESS` are configured; otherwise the simulation stays UNKNOWN
(never a fabricated PASS).

## Enrichment smoke (opt-in, never part of `bun run test`)

```sh
bun run enrich:once -- --limit 10
```

Runs a single enrichment pass against the configured `DATABASE_URL` and current
chain state, after applying migrations and seeding quote assets. `--limit` caps
the selected trusted-quote pools so public-RPC smoke tests stay small.
