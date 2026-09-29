# Assay — Agent Context

## Project purpose

This repository implements a research and monitoring system for newly created token pairs on Robinhood Chain.

The system should:

1. Detect relevant pools directly from on-chain factory events.
2. Begin monitoring tokens before they enter the target valuation range.
3. Calculate estimated FDV, price, liquidity, and market activity.
4. reject structurally unsafe or untradeable tokens.
5. Measure ownership distribution, buyer diversity, liquidity quality, and momentum.
6. Alert when a token enters approximately $50,000–$90,000 estimated FDV and satisfies deterministic eligibility rules.
7. Support manual research and execution rather than autonomous trading.

The central product objective is:

> Detect every relevant Robinhood Chain launch, preserve accurate historical snapshots, and surface explainable candidates entering the target valuation range.

## Current scope

The initial implementation is intentionally narrow:

* Robinhood Chain only.
* EVM-compatible tooling.
* Start with the dominant verified DEX deployment.
* Start with pools paired against trusted quote assets.
* Track candidates from approximately $10,000 FDV.
* Primary alert zone: $15,000–$60,000 FDV (YELLOW research tier).
* Target go zone: $15,000–$40,000 FDV (GREEN; measured 10x sweet spot, 2026-07-20).
* Manual trade execution only.
* Telegram alerts before building a polished dashboard.

Do not expand to multiple chains, automated trading, social scraping, or broad AI analysis until the basic ingestion and snapshot pipeline is reliable.

## Product principles

### Reliability before sophistication

A simple scanner that never misses a pool is more valuable than a sophisticated scoring model built on incomplete ingestion.

Prioritize, in order:

1. Complete event ingestion.
2. Restart safety.
3. Correct price and liquidity calculations.
4. Accurate historical snapshots.
5. Deterministic safety checks.
6. Explainable scoring.
7. Wallet intelligence.
8. Social and narrative analysis.
9. UI polish.

### Deterministic systems before LLM judgments

Use code and explicit rules for:

* Event decoding.
* Price calculations.
* FDV calculations.
* Liquidity calculations.
* Contract permission detection.
* Buy and sell simulations.
* Ownership concentration.
* Wallet clustering.
* Eligibility.
* Scoring.

LLMs may later assist with:

* Summarizing a candidate.
* Classifying project narratives.
* Reading documentation.
* Extracting structured project information.
* Explaining why an alert fired.

An LLM must never be the authoritative judge of contract safety, tradeability, or financial calculations.

### Explainability

Every eligibility decision and score must preserve its component inputs and reasons.

Bad:

```json
{
  "score": 78
}
```

Good:

```json
{
  "eligible": true,
  "score": 78,
  "components": {
    "liquidityQuality": 24,
    "organicBuying": 15,
    "holderGrowth": 10,
    "ownershipDistribution": 11,
    "walletQuality": 8,
    "contractTransparency": 10
  },
  "positiveReasons": [
    "Quote liquidity increased over the last 30 minutes",
    "Buyer funding sources are diverse",
    "Adjusted top-ten ownership is below threshold"
  ],
  "riskReasons": [
    "Token is less than one hour old",
    "Deployer history is not yet resolved"
  ]
}
```

## Domain terminology

### Estimated FDV

For early tokens, reliable circulating supply generally cannot be inferred. Use:

```text
estimated FDV = current token price × reported total supply
```

Name this field `estimatedFdvUsd`, not `marketCap`.

### Quote liquidity

The USD value of the trusted quote asset in the pool.

This matters because the token-side balance can be inflated by an arbitrary token valuation.

### Total liquidity

The approximate combined USD value of both sides of the pool.

### Adjusted ownership concentration

Ownership percentages after excluding known non-economic holders such as:

* Pool contracts.
* Zero address.
* Burn addresses.
* Verified lockers.
* Verified vesting contracts.
* Canonical bridge contracts.

Do not exclude an address merely because it has a familiar-looking name or bytecode.

### Organic buyer

A buyer that does not appear obviously controlled by the deployer or coordinated with a cluster of nominally independent buyers.

This is probabilistic and must be presented as a signal, not a proven identity claim.

## Pipeline

The intended pipeline is:

```text
Block cursor
    ↓
Factory event discovery
    ↓
Pool normalization
    ↓
Token metadata
    ↓
Price / FDV / liquidity calculation
    ↓
Periodic market snapshots
    ↓
Contract and tradeability checks
    ↓
Holder and wallet analysis
    ↓
Eligibility rules
    ↓
Opportunity scoring
    ↓
Telegram alert
    ↓
Advisory judgment brief (LLM, strictly after alert delivery)
```

Each stage should be independently testable.

## Core packages

Use package boundaries approximately as follows:

### `packages/chain`

Responsibilities:

* Robinhood Chain configuration.
* RPC clients.
* Block-range reads.
* Event ABIs.
* Contract reads.
* Retry and RPC error handling.
* Chain-specific addresses.

This package must not contain product scoring logic.

### `packages/discovery`

Responsibilities:

* Factory event polling.
* Block cursor management.
* Pool creation decoding.
* Idempotent pool insertion.
* Backfill and restart behavior.

### `packages/enrichment`

Responsibilities:

* Token metadata.
* Quote-asset normalization.
* Pool state reads.
* Price calculations.
* FDV calculations.
* Liquidity calculations.
* Market snapshot generation.

### `packages/risk-engine`

Responsibilities:

* Contract verification metadata.
* Proxy detection.
* Privileged permission detection.
* Buy, transfer, and sell simulations.
* LP ownership analysis.
* Holder concentration.
* Risk reason generation.

### `packages/scoring`

Responsibilities:

* Eligibility rules.
* Opportunity scoring.
* Alert-level classification.
* Explainable score components.

### `packages/alerts`

Responsibilities:

* Alert formatting.
* Telegram delivery.
* Alert deduplication.
* Links to explorer, chart, and internal candidate view.

### `packages/judgment`

Responsibilities:

* Evidence-bundle assembly as of alert time (append-only reconstruction).
* Field provenance tagging and untrusted-string fencing.
* Typed, read-only history tools with audited call traces.
* Machine-checked evidence citations against snapshot row ids.
* Versioned prompt registry.
* Realized-outcome taxonomy and judge eval scoring.

The judgment layer is advisory-only. It runs strictly downstream of
`alerts_sent`, never gates or delays an alert, and its output must cite
verifiable rows. It must never perform financial calculations itself.

### `packages/database`

Responsibilities:

* Database schema.
* Queries and repositories.
* Transactions.
* Migrations.
* Shared database types.

Application packages should depend on these modules rather than duplicating domain logic.

## Initial technical stack

Unless the repository already establishes another choice, prefer:

* TypeScript.
* Node.js.
* `viem` for EVM interaction.
* PostgreSQL.
* Drizzle ORM.
* Fastify for the API.
* Redis and BullMQ only when scheduling requirements justify them.
* Simple cron or worker loops during the first implementation.
* Next.js only after alerts work reliably.
* Vitest for unit and integration tests.

Do not introduce infrastructure merely because it may be useful later.

## Data-model expectations

The initial persistent entities should include:

* Chain cursor.
* Tokens.
* Pools.
* Quote assets.
* Pool snapshots.
* Token risks.
* Trade simulations.
* Holders.
* Wallet funding relationships.
* Token eligibility results.
* Token score results.
* Alerts sent.
* Judgment briefs, tool-call traces, and citation checks.
* Prompt registry and judge eval runs.

Historical snapshots and prior scores should be append-only where practical.

Do not overwrite all historical market state with only the latest value.

## Discovery requirements

The discovery process must:

* Poll block ranges rather than depending exclusively on WebSockets.
* Persist the final successfully processed block.
* Resume from the persisted cursor after restart.
* Use idempotent inserts.
* Handle duplicate logs.
* Handle short RPC failures.
* Chunk large backfills.
* Avoid advancing the cursor when a range has only partially processed.
* distinguish latest observed block from latest safely processed block.

Never silently skip an event to keep the worker running.

## Quote-asset policy

Only calculate candidate valuations from pools containing an explicitly allow-listed quote asset.

Examples may include:

* WETH.
* Canonical USDC.
* Other verified canonical stablecoins.

Addresses must be verified and stored in chain configuration or the quote-assets table.

Do not infer a token is legitimate because its symbol is `USDC`, `WETH`, or similar.

When neither pool asset is allow-listed, store the pool if useful for completeness but do not treat its implied valuation as trusted.

## Numerical correctness

For all financial and token calculations:

* Respect token decimals.
* Avoid JavaScript `number` for raw on-chain integer values.
* Use `bigint` for raw contract values.
* Use a documented decimal library for derived decimal calculations.
* Record calculation method and timestamp.
* Preserve source block number.
* Avoid float equality comparisons.
* Add fixtures for tokens with 6, 8, 9, and 18 decimals.
* Explicitly handle zero liquidity and malformed metadata.
* Treat reverted token metadata calls as normal adversarial input.

For concentrated-liquidity pools, derive price from pool state rather than naïvely dividing token balances.

## Risk policy

A token must not become actionable merely because some risk data is unavailable.

Classify safety results distinctly:

* `PASS`
* `FAIL`
* `UNKNOWN`
* `ERROR`
* `STALE`

`UNKNOWN`, `ERROR`, and `STALE` are not equivalent to `PASS`.

Tradeability checks should attempt to model:

1. Buying through the real route.
2. Transferring the purchased token.
3. Selling through the real route.
4. Effective buy loss.
5. Effective sell loss.
6. Revert conditions.

All simulations must record the block number and route used.

## Initial eligibility rules

Revised 2026-07-20 (data-grounded model rebuild; docs/scoring-model.md holds
the authoritative contract and change-protocol entry). A token is eligible
only when approximately all of the following hold:

* Estimated FDV is between $10,000 and $100,000.
* Total liquidity is at least $5,000.
* Quote liquidity is at least $2,500.
* Valuation comes from a trusted quote-asset pool.
* Sell simulation has not explicitly FAILED. Missing or UNKNOWN sim data is
  flagged, not failed: 76% of measured ≥10x winners had no sim at entry and
  none had an explicit FAIL. The GREEN (go) alert tier still requires an
  affirmative sim PASS.
* Known effective sell loss is no more than 8% (an unknown loss is flagged,
  not failed).
* No critical privileged contract permission has been detected.
* Quote liquidity has not collapsed from its observed peak.

The age floor defaults to 0 minutes (env-tunable; the old 20-minute floor
excluded most runners). Unique buyers (15), deployer ownership (8%), and
adjusted top-ten ownership (45%) are advisory quality rules that never gate
eligibility.

These are initial product assumptions, not eternal truths. Any change must update the scoring documentation and tests.

## Opportunity score

The score is out of 100 (rebuilt 2026-07-20 from the labeled
token_performance population; see docs/scoring-model.md for the
change-protocol entry; every component reads only entry features that are
both well-covered and discriminating):

```text
Liquidity depth            35
Buyer breadth              25
Buy flow                   20
Low-cap tilt               20
                          ----
                           100
```

Holder, ownership, deployer, sim, and buy-shape signals are advisory
reasons only (under 35% entry coverage); each rejoins the score when real
coverage exists. Price structure and project evidence likewise rejoin when
real price-history and web-evidence signals exist; none may be carried as
constant placeholder points.

Do not assign score points without retaining the underlying values and explanation.

Eligibility is a separate gate from opportunity score. A high score must not override an eligibility failure.

## Alert levels

Stoplight semantics (2026-07-11; was Gray/Yellow/Orange/Red): red = stop
(too early to act), yellow = caution (research), green = go. Escalation
order: Gray < Red < Yellow < Green. Bands re-cut 2026-07-20 to the measured
10x zone (docs/scoring-model.md).

### Gray

Stored only. Enrichment incomplete or token outside watch conditions.

### Red

Early watch candidate ("seen, too early to act"), generally:

* Estimated FDV around $10,000–$100,000.
* At least $2,500 QUOTE liquidity.
* No known critical failure (unknown risk data does not block).
* At least 5 unique buyers.

### Yellow

Research candidate (the young-runner tier), generally:

* Estimated FDV around $15,000–$60,000.
* At least $8,000 total liquidity.
* Eligible.
* Score at least 65.
* Sell simulation may be UNKNOWN (flagged).

### Green

High-priority manual review (the measured 10x sweet spot), generally:

* Estimated FDV around $15,000–$40,000.
* Score at least 80.
* At least 20 unique buyers.
* Recent sell simulation affirmatively passes.
* Adjusted top-ten ownership below 40% when known (null treated as
  satisfied and surfaced; see scoring-model.md for this documented
  exception).

Alert thresholds must be configurable.

## Testing expectations

Every material feature should include tests.

At minimum, test:

* Event decoding.
* Cursor restart behavior.
* Duplicate log handling.
* Quote-asset normalization.
* Token decimal handling.
* V2-style price calculations.
* Concentrated-liquidity price calculations when implemented.
* FDV calculations.
* Liquidity calculations.
* Reverted metadata calls.
* Eligibility boundary conditions.
* Score component boundaries.
* Alert deduplication.
* RPC retry behavior.
* Stale risk data.

Prefer deterministic fixtures based on captured on-chain state over fragile live-network tests.

Live integration tests should be opt-in and clearly marked.

## Engineering workflow

Before modifying code:

1. Read `docs/current-status.md`.
2. Read the relevant domain documentation.
3. Inspect the existing implementation and tests.
4. Identify the smallest coherent change.
5. State any assumption that affects architecture or financial calculations.

While modifying code:

1. Keep domain logic out of UI and transport layers.
2. Prefer explicit types and named domain values.
3. Add or update tests with the implementation.
4. Avoid speculative abstractions.
5. Preserve historical data and idempotency.
6. Return structured errors rather than swallowing exceptions.

After modifying code:

1. Run relevant tests.
2. Run type checking.
3. Run linting if configured.
4. Explain what changed.
5. Identify unresolved assumptions or data-source gaps.
6. Update `docs/current-status.md` when the project state materially changes.
7. Update `docs/decisions.md` when making a meaningful architectural decision.

## Task completion standard

A task is not complete merely because code was written.

A task is complete when:

* The intended behavior is implemented.
* The relevant tests pass.
* Failure behavior is understood.
* The implementation is restart-safe where applicable.
* Domain calculations are documented.
* New configuration is represented in `.env.example`.
* No secret or private key is committed.
* The current-status document remains accurate.

## Security

Never:

* Commit private keys, seed phrases, API tokens, or webhook secrets.
* Place signing keys in client-side code.
* Log secrets.
* Build autonomous trade execution unless explicitly approved as a separate project milestone.
* Assume external token contracts behave according to ERC-20 norms.
* Trust token symbols, names, websites, or unverified source code.

Treat every newly deployed token and external contract as adversarial input.

## What not to build yet

Unless the current project status explicitly advances scope, do not prioritize:

* Automated buying or selling.
* Cross-chain support.
* Full social-media scraping.
* AI-based contract safety decisions.
* Complex microservice deployment.
* Kubernetes.
* A polished dashboard.
* Mobile applications.
* Backtesting claims based on incomplete historical data.
* “Smart wallet” rankings without realized and liquidity-adjusted performance.

## Documentation map

Read these files when relevant:

* `docs/project-context.md`: product and domain context.
* `docs/architecture.md`: system components and data flow.
* `docs/data-sources.md`: chain addresses, APIs, event signatures, and reliability notes.
* `docs/scoring-model.md`: formulas, eligibility, scoring, and alerts.
* `docs/execution-methodology.md`: human research and execution process. **Operator-private — gitignored, untracked, not part of the public repo.**
* `docs/decisions.md`: architectural decision history.
* `docs/current-status.md`: completed work, active issues, and next milestone.
* `docs/history.md`: append-only development log, dated milestone narratives.

When documentation conflicts with executable tests or current implementation, identify the conflict rather than silently choosing one.
