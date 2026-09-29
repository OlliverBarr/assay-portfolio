# Watchdog notes — Assay (Robinhood Chain launch monitor)

You are reviewing a TypeScript monorepo that ingests on-chain events, values token
pools, runs deterministic safety/eligibility checks, scores opportunities, and sends
Telegram alerts. Domain rules live in `AGENTS.md`; every item below is a real invariant
or a class of bug that has already reached production here. Prefer `concern`/`blocker`
only for these; stay silent otherwise.

## Ingestion & restart safety
- Any loop that does RPC MUST classify provider exhaustion as a typed recoverable
  `*HaltError` (log + backoff), never let it propagate. `isRecoverable: () => null` on an
  RPC-touching loop in `apps/worker/src/main.ts` / `loop.ts` is the CU crash-loop bug
  (2026-07-13). Auth failures (HTTP 401/403) must stay FATAL — never classified transient
  in `packages/chain/src/retry.ts`.
- The chain/activity cursor MUST NOT advance on a partially-processed range: the processed
  watermark advances only inside the txn that commits the range. `advanceProcessedBlock` /
  `advanceActivityProcessedBlock` (`packages/database/src/repositories.ts`) guard with
  `lt(latestProcessedBlock, toBlock)` and MUST share the transaction with the pool/swap
  inserts. Flag a cursor advance outside that txn or without the guard, and any confusion of
  `latestObservedBlock` vs `latestProcessedBlock` (`chainCursor`, `packages/database/src/schema.ts`).
- Pool "age"/active-set membership MUST come from creation block/time, never `discovered_at`
  (backfill stamps all historical pools "just discovered" → the 2026-07-11
  `MAX_PARAMETERS_EXCEEDED` crash-loop).
- Inserts MUST be idempotent `ON CONFLICT DO NOTHING` on the canonical log identity:
  `insertPools` (chainId, poolAddress), `insertTokens` (chainId, address), `insertPoolSwapEvents`
  (chainId, transactionHash, logIndex). Flag a conflict target that doesn't match log identity
  (duplicates bypass the constraint); never silently skip an event to keep a worker alive.

## Scale — bounded selection, never full-population
- Any pass iterating pools MUST use active-set / `FdvBandCriteria`-bounded selection
  (`listActiveTrustedQuotePools`, band-first selection), never `listTrustedQuotePools`/
  all-time scans or per-chunk loads of every pool. This class recurred four times in the
  2026-07-12 alert-silence incident. Flag new queries lacking a LIMIT/band/active filter,
  and any per-candidate stream of an append-only table (`pool_snapshots`,
  `activity_snapshots`; 1.4M+ rows).
- Batch inserts MUST chunk under the postgres bind-parameter cap; flag
  `insert(...).values(arr)` where `arr` scales with pool count (`MAX_PARAMETERS_EXCEEDED`).

## Numerical correctness
- Raw on-chain integers stay `bigint` end to end. Flag `Number(...)`, `parseFloat`, or float
  `*`/`/` on a raw balance/reserve/supply, and float `==`/`===`. Derived decimals use the
  WAD fixed-point helpers in `packages/enrichment/src/fixed.ts` (`WAD`, `mulDiv`, `pow10`,
  `formatWad`, `MAX_USD_WAD`), not floats.
- Token decimals MUST be respected in every price/FDV/liquidity calc; V3 price derives from
  pool state (slot0 / sqrtPriceX96), never naive balance division.
- Zero liquidity and reverted/malformed metadata are normal adversarial input → a typed
  `SnapshotNullReason` (`packages/enrichment/src/pass.ts`), never a throw or a silent `0n`
  that reads as real data. Flag a new metric that treats missing/malformed as 0 instead of
  withholding the value.

## Persistence & DB
- Anything written to a jsonb column MUST be jsonb-safe — no raw `bigint` (throws
  `Do not know how to serialize a BigInt`; latent candidate-persistence bug). Flag bigint
  fields (`blockNumber`, reserves) placed into `features`/`components`/jsonb without the safe
  serializer.
- Snapshots, scores, eligibility, and market history are APPEND-ONLY — never UPDATE a
  historical row to the latest value; INSERT a new one. Flag `update(...)` on those tables.
- Raw `sql` fragments: PGlite (tests) tolerates params postgres-js (prod) rejects — bare
  `Date` params pass tests, crash prod (2026-07-12). Flag non-primitive params in
  `` sql`…` `` fragments; a green suite does NOT prove the query runs in prod.

## Risk / eligibility / scoring
- Risk verdict `RiskStatus` `UNKNOWN`/`ERROR`/`STALE` is NEVER equivalent to `PASS`.
  Verdicts combine in `assessRisk()` (`packages/risk-engine/src/assess.ts`) and age out via
  `effectiveRiskStatus()` (`packages/risk-engine/src/pass.ts`). Flag aggregation that
  defaults missing/unknown to pass or `?? "PASS"`, or a silent STALE→PASS downgrade.
- Eligibility (`evaluateEligibility()`, `packages/scoring/src/eligibility.ts`) is a two-tier
  gate SEPARATE from the score: HARD rules set `eligible`; QUALITY rules are advisory
  (`softFailedRules`) and only shape the score. Missing data MUST fail the HARD rule, never
  pass. `scoreOpportunity()` (`packages/scoring/src/score.ts`) is pure — six components
  computed regardless of eligibility; a high score must never flip `eligible`, and
  eligibility must not read the score. `classifyAlertLevel()`
  (`packages/scoring/src/alert-level.ts`): GREEN/YELLOW require `eligibility.eligible === true`,
  RED does not (early watch), and the invalidation cap (`liquidityCollapsed ||
  simulationRegressed`) forces GRAY regardless of score. Flag any leak across these.
- Every score point MUST retain its component input + reason: `ScoreResult`
  (`packages/scoring/src/types.ts`) carries `components` + `positiveReasons`/`riskReasons` —
  never a bare `{ score: N }`. Flag a component that adds points without the underlying
  value/reason.
- Trade sims (`classifySimulation()`, `packages/risk-engine/src/simulate.ts`) MUST record
  route + block number + `effectiveSellLossBps`; a reverted leg is FAIL and a null output is
  UNKNOWN, never PASS. `trade_simulations` is append-only.
- Eligibility/alert thresholds are env-configurable (`ELIGIBILITY_*`,
  `ALERT_RED/YELLOW/GREEN_*`) threaded through every caller (scoring pass, winners-retro,
  validate CLI). Flag a caller riding module-default constants instead of the tuning-built
  config objects (stale-override bug, 2026-07-13).

## Adversarial input
- Every external token contract AND every external HTTP body (Telegram, explorer/Blockscout)
  is adversarial. Guard JSON parses with typed recoverable errors (worker-crash class,
  2026-07-12). Never trust a token symbol/name/verified-source to establish safety or quote
  status; only allow-listed quote-asset addresses classify a pool's valuation.

## Judgment layer (advisory-only)
- The LLM judgment layer (`runJudgmentPass`, `apps/worker/src/judgment-pass.ts`) runs
  strictly downstream of `alerts_sent`: it never gates, delays, or edits an alert, never
  performs financial calculations, and every claim must cite a machine-verified row
  (`packages/judgment/src/citations.ts`; fabrication → `REJECTED_FABRICATED_CITATION`, not
  delivered). Citations may only target the `CitableTable` allowlist (`packages/judgment/src/types.ts`)
  — append-only tables (`pool_snapshots`, `trade_simulations`, …); mutable `tokens`/`pools`/
  `token_holders` are deliberately non-citable. Tool args are numbers/enums/whitelisted names
  only; attacker-controlled token name/symbol is typed `UntrustedString` and MUST NOT reach a
  tool argument or escape its fence. Flag judgment output feeding back into
  eligibility/score/alert, any financial math inside judgment, a citation against a mutable
  table, or an `UntrustedString` reaching a query/tool arg.

## Secrets & privacy
- Never commit keys/tokens/webhook secrets or the production IP/host, and never log secrets.
  `docs/execution-methodology.md` and `docs/ops-private.md` are gitignored operator-private.
  Flag a secret/host string entering a tracked file or an example, or secret values in logs.
