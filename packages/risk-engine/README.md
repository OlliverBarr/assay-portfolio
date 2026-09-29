# @assay/risk-engine

Deterministic contract-safety and tradeability assessment for discovered
trusted-quote tokens. Produces explainable `PASS / FAIL / UNKNOWN / ERROR`
verdicts (with read-time `STALE`) that the eligibility gate will later consume.
No LLM ever decides safety here.

## Status taxonomy

Distinct and never collapsed:

- `PASS` — a passing sell simulation, no critical permission, no missing
  critical signal.
- `FAIL` — a present critical permission, or a failing/untradeable simulation.
- `UNKNOWN` — a required signal is missing (no simulator, unreadable bytecode,
  beacon-proxy logic not resolved). Never upgraded to PASS.
- `ERROR` — analysis threw on a hostile/non-infra read; recorded, not fatal.
- `STALE` — applied at read time (`effectiveRiskStatus`) when a verdict is older
  than the configured max age. Not stored; derived.

`UNKNOWN`, `ERROR`, and `STALE` are never equivalent to `PASS`. Missing data
never makes a token safe.

## Components (all deterministic, all explainable)

1. **Verification** (`classifyVerification`) — verified source + proxy hint from
   the explorer. A missing explorer answer is `UNKNOWN`, never `VERIFIED`.
2. **Proxy** (`classifyProxy`) — EIP-1967 / beacon / legacy implementation slots
   read from storage. A set implementation slot means logic (and permissions)
   can change.
3. **Permissions** (`detectPermissions`) — privileged-capability detection from
   the analyzed runtime bytecode by 4-byte selector evidence: `mint`,
   `blacklist`, `pause`, `transferTax`, `ownership`, `upgradeAdmin`. States are
   `PRESENT / ABSENT / UNKNOWN / NOT_APPLICABLE / ANALYSIS_FAILED`. This is a
   heuristic, reported as evidence — `ABSENT` is not proof of safety. For a
   resolvable proxy the logic contract's bytecode is analyzed; a beacon proxy's
   logic is not resolvable from storage, so permissions stay `UNKNOWN`.
4. **Simulation** (`classifySimulation`) — a buy -> transfer -> sell route probe.
   Reverts are `FAIL`; excessive sell loss (>= `maxSellLossBps`) is `FAIL`;
   missing outputs are `UNKNOWN`. Effective loss is basis-point shortfall vs the
   pool spot amount.

`assessRisk` combines them: FAIL on a critical permission or failing sim,
UNKNOWN on any missing critical signal, PASS only with a passing sim and no
critical permission.

## Critical permissions

Present `mint`, `blacklist`, `pause`, or `upgradeAdmin` force `FAIL`.
`transferTax` and `ownership` are recorded as risk reasons but do not, alone,
fail a token (a bounded tax or a soon-renounced owner can be legitimate).

## Simulation policy and the archive/quoter caveat

`createQuoteRouteSimulator` probes buy/sell via router `getAmountsOut`
(V2) / QuoterV2 `quoteExactInputSingle` (V3). Reverts are the strong
untradeable/honeypot signal. Precise per-leg loss requires pairing quotes with a
spot oracle and is left null for now (`spot*` = null); reverts and output
presence still gate the verdict.

On top of the single eligibility probe, the same simulator runs an
independent buy -> sell round trip at each of a configurable ascending USD
notional vector (`slippageCurveNotionalsUsd`, default $500 / $2,000 /
$5,000), producing a `slippageCurve: SlippagePoint[]` (`{ notionalUsd,
lossBps }`, ascending). Each notional is converted to raw quote units using
the same anchoring as the single probe: `probeQuoteInRaw` raw units are
treated as $1. A reverted leg at one notional only nulls that point's
`lossBps` — it never aborts the rest of the curve. The curve is additive and
persisted alongside the existing fields on the same `trade_simulations` row;
it does not change `effectiveSellLossBps` or any status.

The probe requires **verified router/quoter addresses**, which are not yet
confirmed for Robinhood Chain (see `docs/data-sources.md`). Without them the
worker runs risk with simulation `UNKNOWN` — which, by design, can never produce
a false `PASS`. Full buy/transfer/sell execution simulation (eth_call state
overrides) is deferred; the public RPC is non-archive, but current-head
simulation does not require archive state.

## Selection and restart-safety

Risk is assessed per trusted-quote pool through two lanes: the band lane
(`listBandTrustedQuotePoolsNeedingRisk`) serves pools whose latest snapshot
FDV sits inside the watch band first, newest-created first, then the
staleness backlog (`listTrustedQuotePoolsNeedingRisk`) fills the remaining
`poolLimit` budget — alert-relevant pools can never be starved by the sweep
(2026-07-12 audit). Both select pools whose latest verdict is missing or
older than the staleness window; selection is idempotent, so a crash
mid-pass simply re-selects the pending pools. Persistent RPC failure raises
`RiskHaltError` and the worker backs off without losing coverage. Results
are append-only in `token_risks` and `trade_simulations`, each row recording
its block and route.
