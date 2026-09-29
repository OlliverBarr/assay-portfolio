# Eligibility and Scoring Model

## Status

This is the initial scoring model. It is a working hypothesis and must be evaluated against observed launches.

Any material threshold change should include:

* Rationale.
* Date.
* Before-and-after value.
* Expected effect.
* Test updates.
* Historical replay where feasible.

## Measurement freshness

A candidate decision may use data only when:

* Market snapshot is no older than 90 seconds.
* Sell simulation is no older than the configured simulation window.
* Holder data is no older than the configured holder-analysis window.
* Quote-asset USD price is no older than its configured maximum age.

Stale data must be labeled and should block the strongest alert level.

## Estimated FDV

```text
estimatedFdvUsd = tokenPriceUsd × totalSupplyNormalized
```

Requirements:

* Preserve total-supply source.
* Preserve source block.
* Normalize with token decimals.
* Flag supply calls that revert or return implausible values.
* Do not label this value market capitalization.

## Initial monitoring windows

```text
Begin candidate monitoring:  $10,000 estimated FDV
Primary alert zone:           $15,000–$60,000 estimated FDV (YELLOW research tier)
Target go zone:               $15,000–$40,000 estimated FDV (GREEN; the measured 10x sweet spot)
Upper tracking range:         $120,000 estimated FDV
```

These values must be configuration rather than constants scattered across the repository.

## Eligibility

Eligibility is tiered into HARD rules (gate `eligible`) and QUALITY rules
(advisory only, tracked separately). This is the canonical revision point for
both tiers per AGENTS.md.

Since the 2026-07-20 model rebuild (change-protocol entry below), hard rules
follow two distinct missing-data contracts:

* **Coverage-complete rules** keep missing-data-fails semantics: these values
  exist for every real candidate, so a null IS evidence of a problem.
* **Explicit-failure rules** reject only on affirmative evidence of danger.
  Missing, UNKNOWN, ERROR, or STALE safety data does NOT fail the rule; it is
  surfaced in `reasons` as a `flag:` entry, and the GREEN (go) alert tier
  separately requires an affirmative sim PASS. UNKNOWN is still never treated
  as PASS anywhere; it is routed to "eligible but flagged" for manual
  research instead of silent rejection.

### Hard rules (gate `eligible`)

| Requirement | Contract | Initial threshold |
| --- | --- | ---: |
| Minimum estimated FDV | coverage-complete | $10,000 |
| Maximum estimated FDV | coverage-complete | $100,000 |
| Minimum total liquidity | coverage-complete | $5,000 |
| Minimum quote liquidity | coverage-complete | $2,500 |
| Trusted quote asset | coverage-complete | Required |
| Minimum age | coverage-complete | 0 minutes (env `ELIGIBILITY_MIN_AGE_MINUTES`) |
| Maximum effective sell loss | explicit-failure | 8% when the loss is known; null is flagged |
| Recent sell simulation | explicit-failure | Rejects only status FAIL; UNKNOWN/null is flagged |
| Critical privileged permissions | explicit-failure | Rejects only a detected permission |
| Liquidity not collapsed | explicit-failure | Latest quote liquidity ≥ 20% of observed peak; unknown trajectory passes |

A failed hard requirement produces a structured rejection reason in
`failedRules`/`reasons` and makes the candidate `notEligible`.

### Quality rules (advisory only, never gate `eligible`)

| Requirement                        | Initial threshold |
| ----------------------------------- | ----------------: |
| Minimum unique buyers               |                15 |
| Maximum deployer ownership          |                8% |
| Maximum adjusted top-ten ownership  |               45% |

These three use missing-data-fails checks, but the failure lands in
`softFailedRules` (machine-stable keys) instead of `failedRules`, and its
reason string is prefixed `quality: ` in `reasons` rather than blocking the
candidate. `eligible === true` iff no HARD rule failed, independent of
`softFailedRules`.

### Rationale (2026-07-12 prod audit, extended 2026-07-20)

Ownership signals (deployer%, adjusted top-10%) come from holder snapshots
that lag pool acquisition; in production, holder snapshot coverage had ZERO
overlap with the scored candidate set, so missing-data-fails on these rules
made eligibility structurally impossible. Demoting `minUniqueBuyers`,
`maxDeployerPct`, and `maxAdjustedTop10Pct` to advisory removed that block
(2026-07-12).

The 2026-07-20 rebuild extended the same logic to the SAFETY rules, because
the safety simulation also lags pool discovery: in the labeled
`token_performance` population (horizon 72h, $10k-$100k band), 76% of the
156 ≥10x winners had a null/UNKNOWN sim at entry and ZERO had an explicit
FAIL; requiring affirmative PASS admitted only 24% of them. Rejecting only
explicit failure keeps every known honeypot out (all explicit-FAIL rows are
still rejected; verified in replay: 539/539) while no ≥10x winner is lost to
the sim, sell-loss, or age rules. The 20-minute age floor was dropped to 0
for the same reason: winners' median entry age was 10 minutes and the floor
excluded more than half of them. This is a deliberate reinterpretation of
the AGENTS.md rule that "a token must not become actionable merely because
risk data is unavailable": an UNKNOWN-sim candidate can reach the YELLOW
research tier (flagged), but GREEN keeps the affirmative-PASS requirement.

## Critical permission examples

Examples that can block eligibility include:

* Arbitrary minting.
* Blacklisting.
* Transfer pause.
* Configurable transfer allow-list.
* Owner-controlled sell restriction.
* Materially changeable transfer tax.
* Arbitrary seizure.
* Upgradeable implementation controlled by an unsafe administrator.
* External transfer hook controlled by a privileged account.

Detection must be evidence-based and allow nuanced results such as:

* Present.
* Absent.
* Unknown.
* Not applicable.
* Analysis failed.

## Implemented derived signals

These feed the score components below (never the eligibility gate, except the
collapse rule above). All are nullable; null keeps the component at its
conservative default. Tunables live in `SignalConfig`
(`packages/scoring/src/types.ts`) and worker env (`.env.example`).

* **Liquidity trajectory** (`pool_snapshots` series, forward-only from first
  observation): peak quote liquidity, drawdown from peak (bps), minutes held
  at ≥80% of peak, and the collapse flag. Time at peak is empirical
  LP-permanence evidence; a collapse invalidates the candidate.
* **Sell-slippage curve** (`trade_simulations.slippage_curve`): round-trip
  loss probed at ascending quote notionals (default $100/$500/$2k). Measures
  whether exit depth survives at size; a reverted probe is a null point.
* **Simulation regression**: a prior sell-simulation PASS followed by a
  latest FAIL (soft-rug-in-progress). Caps the alert level at GRAY.
* **Float ratio** (`token_holder_snapshots.float_bps`): tradeable share of
  supply after excluding non-economic holders and the resolved deployer
  (a ceiling when the deployer is unresolved). `supply_in_pool_bps` is the
  pool's own share.
* **Deployer serial-launch history**: other tokens by the same resolved
  deployer joined against survival outcomes. Serial-death deployers are
  penalized; a prior survivor is a modest positive; first-time is neutral.
* **Buy-size shape** (1h BUY window): per-buyer spend Gini, normalized
  Shannon entropy, and exact-duplicate-size share — wash/coordination
  signatures the raw buyer count cannot see.
* **Early-buyer retention**: share of first-window buyers still holding a
  nonzero balance.
* **Cohort percentiles**: buyer count and net quote inflow ranked against
  live pools of comparable age (withheld below a minimum cohort size), so
  traction is judged relative to the current launch regime rather than
  absolute guesses.

## Survival outcomes

Every observed pool is labeled `SURVIVED`/`DIED` at configured horizons
(default 24h and 72h) in the append-once `token_outcomes` table: SURVIVED
requires retaining ≥30% of peak quote liquidity and ≥$10,000 estimated FDV at
the horizon. Labels describe observed history only (ingestion-time snapshots)
and are the calibration dataset for future threshold revision — not a
backtesting claim.

## Realized-performance labels

Survival answers "did the rug-filter work"; performance answers "where do the
multipliers live". For **every** pool whose observed snapshot history first
crossed into the reference band (default $10,000–$100,000 estimated FDV —
config, not constant), the append-once `token_performance` table records, per
horizon (default 72h and 168h after band entry):

* Entry snapshot: time, block, price, FDV.
* `maxMultipleBps`: peak observed price ÷ entry price (10000 = 1.0x).
* `maxDrawdownBps`: worst drop below entry *before* the peak (pain before
  payoff).
* `minutesToPeak` and the number of observed snapshots in the window.
* `entryFeatures`: the signal vector as of entry (liquidity, buy-shape,
  float, concentration, risk status, …), reconstructed from the append-only
  history; fields are null when a source had no row yet.

Deliberately population-wide: labeling is **not conditioned on alerts,
eligibility, or scores**, so threshold tuning runs against the full
distribution rather than the system's own selections. Entry is the first
*observed* in-band snapshot — observation gaps are recorded, never inferred
across.

`bun run calibrate` buckets each entry feature into quartiles against the
realized multiple distribution (median, p75, share ≥2x, share ≥5x, median
drawdown). Threshold changes driven by this report must follow the change
protocol above **and** validate out-of-time: tune on one period, confirm on a
later one, never on the data that chose the parameters.

## Advisory judgment briefs

YELLOW/GREEN alerts (configurable minimum level) additionally receive an
LLM-generated research brief, strictly after the alert is committed and
delivered — the judgment layer never gates, delays, or alters an alert.

Briefs are deduplicated per token, not per alert (2026-07-11, fixing
repeat briefs for tokens re-alerting on score improvements): a token whose
latest COMPLETED brief is younger than `JUDGMENT_REBRIEF_COOLDOWN_MS`
(default 24h) is only briefed again when the new alert's level outranks the
previously-briefed one (e.g. YELLOW → GREEN). FAILED or citation-rejected
briefs never suppress — the operator never received those. Setting the
cooldown to 0 disables the per-token gate.

A brief is a structured object, never free prose:

* `thesis` — one falsifiable statement.
* `confidenceBps` — stated confidence, 0–10000, scored for calibration.
* `riskCalls` — exactly the top 3, ranked, each with a machine taxonomy tag
  (`RUG_LP_PULL`, `SELL_RESTRICTION`, `CONCENTRATION_DUMP`,
  `WASH_COORDINATION`, `NO_FOLLOW_THROUGH`, `OTHER`) and at least one
  evidence pointer.
* `disconfirming` — evidence against the thesis.
* `whatWouldChangeThisCall` — concrete observable invalidation events.
* `recommendation` — `RESEARCH` | `WATCH` | `PASS`, advisory only.

Every claim cites `{table, rowId, field, claimedValue}` into the append-only
snapshot tables. Citations are re-fetched and verified by code; a brief with
a fabricated load-bearing citation is persisted as
`REJECTED_FABRICATED_CITATION` and never delivered.

## Realized-outcome taxonomy

For judge evaluation, each labeled (pool, horizon) maps to one of four
labels derived from `token_performance` + `token_outcomes` (thresholds are
config, not constants):

| Label | Definition (initial) |
| --- | --- |
| `RUGGED` | `DIED` outcome at the horizon, or observed liquidity collapse |
| `BLED` | survived but `maxMultipleBps` < 11000 |
| `HELD_BAND` | `maxMultipleBps` in [11000, 20000) |
| `RUNNER` | `maxMultipleBps` ≥ 20000 within the horizon |

## Judge metrics

Reported per prompt version by `bun run judge:report`, always with sample
sizes and Wilson confidence intervals; headline numbers come from an
out-of-time period never used for prompt iteration:

* Brier score on the brief's implied probability of a positive outcome.
* Confidence calibration: stated `confidenceBps` vs realized hit rate.
* Per-risk-tag precision/recall against realized failure modes.
* Citation-fabrication rate (must trend to zero).
* Brief cost, latency, and tool-call counts.

Ground truth is always realized on-chain outcomes. No LLM-graded metric is
ever the critical measure. Replay reconstruction is as-of band entry; tools
that cannot be made as-of correct (cohort percentiles) are unavailable in
replay rather than silently leaking the present.

## Score

Only eligible tokens receive an actionable opportunity score.

### Scale recalibration (2026-07-11)

Change-protocol entry (rationale, before/after, expected effect):

**Rationale.** An audit of the original eight-component model found the
attainable ceiling was 79/100, not 100 (75 for a first-time deployer):
`priceStructure` could realistically award 5 of 10, `walletQuality` 7 of 15,
`holderGrowth` 11 of 15, and `projectEvidence` was a constant 1 of 5. At the
other end, ~25–30 points were unconditional table stakes (constants plus
points for merely clearing eligibility floors), so every in-band candidate
started near 30 and the informative range was compressed into roughly
50–79. RED (≥75) demanded 95% of the true ceiling and was effectively a dead
tier. Separately, the 20-minute flow fields were counted in BOTH
`organicBuying` and `priceStructure` — double weight on the single most
manipulable signal — and flow points had no dust floor, so wei-sized buys
could read as "positive net inflow".

**Change.**

| Component | Before (attainable) | After |
| --- | ---: | ---: |
| Liquidity quality | 20 (20) | 30 |
| Organic buying | 15 (15) | 20 |
| Holder growth | 15 (11) | 15 |
| Wallet quality | 15 (7) | 10 |
| Ownership distribution | 10 (10) | 15 |
| Contract transparency | 10 (10) | 10 |
| Price structure | 10 (5) | removed |
| Project evidence | 5 (1) | removed |
| **Total** | **100 (79)** | **100 (100)** |

`priceStructure` was removed because, after de-duplicating the flow inputs,
its only live signal was "a price exists"; it returns when a real
price-history signal (VWAP extension, consolidation structure) is
implemented. `projectEvidence` was removed because nothing is measured yet;
it returns with the web-facing existence checks on the roadmap. Both were
pure constants for every candidate — zero ranking information, negative
scale information.

Additional structural fixes in the same revision:

* The liquidity/FDV ratio now uses **quote** liquidity, not total: the
  token side of total liquidity is valued by the token's own price and is
  trivially inflatable. Total liquidity is no longer a score input at all
  (it remains an eligibility gate and an alert-band input).
* 20m flow points (count balance + volume balance) require the window to
  clear a dust floor (`flowFloorMinBuys20m`, `flowFloorMinUniqueBuyers20m`,
  both default 5). Below the floor no flow points are awarded and the
  reason is surfaced.
* Malformed raw volume strings now withhold flow-volume points with a risk
  reason instead of silently parsing to zero (which made a corrupted sell
  volume look like net inflow).
* Points start above the eligibility floors: quote liquidity at exactly the
  $10k eligibility minimum earns 1 depth point, not 4.

**Expected effect.** A barely-eligible candidate with no traction scores
~5–15 (previously ~30–45); the reference test fixture moves 66 → 55; a
best-case-everything candidate scores exactly 100 (regression-tested). The
YELLOW (65) and GREEN (75) score thresholds (ORANGE/RED at the time; renamed
to stoplight vocabulary the same day, see "Alert levels") are deliberately
retained: on the recalibrated scale they now sit at 65% and 75% of an
attainable range instead of 82% and 95% of an unreachable one, which makes
GREEN a live tier for genuinely exceptional candidates and slightly tightens
YELLOW for
thin-data candidates — aligned with the operator's request to surface fewer,
more compelling alerts.

**Validation.** Component boundaries, the 100-point ceiling, the dust
guard, and the malformed-volume path are unit-tested. Out-of-time
validation against realized outcomes (`bun run calibrate`) remains pending
on label accumulation, per this document's change protocol; threshold
revisions from that data must follow the same protocol.

### Focus band recalibration (2026-07-13)

Change-protocol entry (rationale, before/after, expected effect):

**Rationale.** Operator decision to replace the focus band: target valuation
moves from ~$40,000–$300,000 watch / $75,000–$250,000 eligibility /
$90,000–$225,000 research down to **$10,000–$100,000**. Ingestion and
enrichment needed zero changes — every pool is already ingested and every
trusted-quote pool of any size is already priced; the band only changes
which already-captured pools clear the eligibility/alert gates. Liquidity
and buyer floors are scaled down with an absolute tradeability floor rather
than held constant, since the old floors (calibrated for a $75k+ token)
would reject nearly everything in a $10k–$100k band. Safety and quality
caps (`minAgeMinutes`, `maxEffectiveSellLossBps`, `maxDeployerPctBps`,
`maxAdjustedTop10PctBps`, the 65/75 score gates) are deliberately
**unchanged**: low-FDV pairs are more adversarial, not less, so nothing
about a smaller band justifies loosening safety.

**Change — eligibility (hard rules):**

| Field | Before | After |
| --- | ---: | ---: |
| Minimum estimated FDV | $75,000 | $10,000 |
| Maximum estimated FDV | $250,000 | $100,000 |
| Minimum total liquidity | $20,000 | $5,000 |
| Minimum quote liquidity | $10,000 | $2,500 |
| Minimum unique buyers (quality) | 30 | 15 |

**Change — alert bands:**

| Field | Before | After |
| --- | ---: | ---: |
| RED min FDV | $40,000 | $10,000 |
| RED max FDV | $100,000 | $40,000 |
| RED min liquidity | $15,000 | $3,000 |
| RED min unique buyers | 15 | 8 |
| YELLOW min FDV | $90,000 | $40,000 |
| YELLOW max FDV | $225,000 | $100,000 |
| YELLOW min liquidity | $20,000 | $5,000 |
| GREEN min FDV | $100,000 | $50,000 |
| GREEN max FDV | $200,000 | $90,000 |
| GREEN min unique buyers | 50 | 25 |
| Watch min FDV (env `WATCH_MIN_FDV_USD`) | $40,000 | $10,000 |
| Watch max FDV (env `WATCH_MAX_FDV_USD`) | $300,000 | $120,000 |

Watch max stays a superset above the eligibility max (120k > 100k eligibility
ceiling), mirroring the old 300k-vs-250k headroom, so a pool hovering at the
top of GREEN is not dropped from scoring/active selection between ticks.

**Change — `scoreLiquidityQuality` quote-depth tiers (0–10 pts,
`packages/scoring/src/score.ts`):**

| Quote liquidity | Before | After |
| --- | ---: | ---: |
| ≥ | $100,000 → 10 | $30,000 → 10 |
| ≥ | $50,000 → 8 | $20,000 → 8 |
| ≥ | $25,000 → 5 | $10,000 → 5 |
| ≥ | $15,000 → 3 | $5,000 → 3 |
| ≥ | $10,000 → 1 | $2,500 → 1 |

At the old band the top two tiers ($50k–$100k quote liquidity) exceeded the
entire new $10k–$100k band, leaving the 30-point `liquidityQuality`
component — the largest — with unattainable headroom, which violates the
2026-07-11 "every component maximum attainable" invariant and would have
depressed scores below the unchanged YELLOW(65)/GREEN(75) gates. This is the
only band-coupled absolute-USD constant in the score model; the
quote-liquidity-to-FDV ratio tiers are scale-invariant and unchanged. The
sub-floor (>0) risk reason changed from "below the eligibility floor" to
"Quote liquidity is thin for the band" (the old text hard-coded the prior
$10k eligibility assumption, which is now the new floor value itself).

**Configurability.** All eligibility and alert-band thresholds above are now
environment-configurable (`ELIGIBILITY_MIN_FDV_USD`,
`ELIGIBILITY_MAX_FDV_USD`, `ELIGIBILITY_MIN_TOTAL_LIQUIDITY_USD`,
`ELIGIBILITY_MIN_QUOTE_LIQUIDITY_USD`, `ELIGIBILITY_MIN_UNIQUE_BUYERS`,
`ALERT_RED_MIN_FDV_USD`, `ALERT_RED_MAX_FDV_USD`,
`ALERT_RED_MIN_LIQUIDITY_USD`, `ALERT_RED_MIN_UNIQUE_BUYERS`,
`ALERT_YELLOW_MIN_FDV_USD`, `ALERT_YELLOW_MAX_FDV_USD`,
`ALERT_YELLOW_MIN_LIQUIDITY_USD`, `ALERT_GREEN_MIN_FDV_USD`,
`ALERT_GREEN_MAX_FDV_USD`, `ALERT_GREEN_MIN_UNIQUE_BUYERS`), threaded through
every caller of the eligibility/scoring/alert-level trio (scoring pass,
winners-retro pass, `validate:candidate` CLI). This satisfies this
document's and the codebase's own stated invariant that these values must
stay configurable, which the prior hardcoded constants violated.

**Related env-only recalibrations (no code change):**
`RISK_SLIPPAGE_CURVE_NOTIONALS_USD` `500,2000,5000` → `100,500,2000` (a $5k
exit probe on a ~$5k-liquidity pool is meaningless at this band);
`PERFORMANCE_BAND_MIN_FDV_USD` $50,000 → $10,000 and
`PERFORMANCE_BAND_MAX_FDV_USD` $200,000 → $100,000, so the `token_performance`
calibration dataset labels the pools now alerted on. `OUTCOME_MIN_FDV_USD`
was already $10,000 and is unchanged.

**Expected effect.** Sub-$40,000 pools, previously never scored (scoring
selection is band-only), now enter the scoring band and can classify RED or
above. The candidate mix shifts materially earlier/smaller; alert volume and
composition should be monitored post-deploy.

**Validation.** These are initial engineering-chosen assumptions — a
tradeability floor scaled down with the band, not a backtested result. They
are pending out-of-time validation against `token_performance` /
`bun run calibrate` per this document's change protocol, and must not be
described as empirically validated until that validation runs.

### Component re-weight evaluation: shelved (2026-07-20)

Change-protocol entry for a change that deliberately did NOT ship.

A zero-sum re-weight of the six score components was pre-registered,
audited, and evaluated out-of-time against realized `token_performance`
labels (horizon 72h, current band, tune week 2026-07-06 vs confirm week
2026-07-13) using the new read-only counterfactual tool
(`bun run calibrate-sweep`, `apps/worker/src/calibrate-sweep.ts`). Full
commitment, audit tables, SQL, and results:
`docs/reweight-preregistration-2026-07.md`.

**Outcome: no weight change.** Three independent pre-registered grounds:

1. Entry-feature coverage: 9 of 13 calibration features are below 60%
   non-null in at least one period; only liquidityQuality's driving
   features survive, leaving 0 of 20 candidate shift pairs valid.
2. Reachable ceiling is zero: of 481 realizable 2x winners, none are
   eligible with a replay score in 55-74 (458 are blocked by the
   eligibility gate itself), in either period.
3. Structural floor: the maximum replayed score across the 4,861-row
   population is 55; all eligible non-GRAY rows classify RED (effective
   floor 70), so no re-weight of the replay-reconstructable budget can
   move any row across any delivery floor.

Weights are not the current lever; the winner mass sits behind the
eligibility gate and entry-time signal coverage (holder/risk enrichment
lag). Unlock conditions for a future attempt are recorded in the
pre-registration doc, section 10. Weights, tiers, and caps below remain
exactly as set by the 2026-07-11 recalibration.

### Data-grounded model rebuild (2026-07-20)

Change-protocol entry (rationale, before/after, expected effect,
validation). This entry covers the eligibility contract above, the
four-component score below, and the alert-tier bands below, which shipped
together.

**Rationale.** The re-weight evaluation above found the winner mass sits
behind the eligibility gate and entry-time coverage, not the weights. A
from-scratch analysis of the labeled population (local prod snapshot
restored 2026-07-20; `token_performance`, horizon 72h, $10k-$100k band;
N=9,260 labeled pools, 156 at ≥10x) found three structural defects:

1. The safety gate discarded 76% of ≥10x winners on MISSING data, not
   danger (sim null/UNKNOWN at entry); 0 of 156 had an explicit sim FAIL.
2. The tiers pointed at the wrong FDV zone: the ≥10x rate peaks at
   $15-40k entry FDV (8-10% among quote-liquidity survivors) while GREEN
   targeted $50-90k (~5.5%) and $15-40k was RED (undelivered by default).
3. Only liquidity, buyers, buy-flow, and entry FDV are both well-covered
   (100% / ~50-68%) and discriminating at entry; holder, ownership,
   deployer, sim, and buy-shape signals are under 35% covered on fresh
   launches (see `docs/reweight-preregistration-2026-07.md`).

**Change: eligibility.** Safety rules moved to the explicit-failure
contract (see the Eligibility section): sim rejects only on FAIL, sell
loss only when known and above the cap, and the 20-minute age floor
dropped to 0 (`ELIGIBILITY_MIN_AGE_MINUTES`; winners' median entry age is
10 minutes).

**Change: score.** Six components replaced by four, each built only from
covered, discriminating entry features (details in the component sections
below): liquidityDepth 35, buyerBreadth 25, buyFlow 20, lowCapTilt 20.
The unscored holder/ownership/deployer/sim/buy-shape values remain
computed and surfaced as advisory positive/risk reasons; they carry zero
points until coverage improves. Nulls in buyer/flow features score 0 and
never penalize.

**Change: alert tiers.** GREEN re-cut to the measured 10x sweet spot
($15k-$40k, score ≥80, ≥20 buyers, affirmative sim PASS); YELLOW is the
young-runner research tier ($15k-$60k, score ≥65, total liquidity ≥$8k;
sim may be UNKNOWN, flagged); RED widens to the whole band ($10k-$100k)
and now gates on QUOTE liquidity (≥$2.5k) with ≥5 buyers, rejecting only
known critical failure. One deliberate risk-policy exception: GREEN's
adjusted-top-10 cap applies only when the value is KNOWN; a null value is
treated as satisfied (consistent with missing≠fail), so a GREEN can fire
with unknown ownership provided sim affirmatively PASSes. The operator
sees the null surfaced in the scorecard and reasons.

**Expected effect (measured on the labeled replay, real code path).**
≥10x winner eligibility rises from 7.5% (old gate, same vectors) to 86.5%;
every remaining rejection is the retained $2.5k quote-liquidity floor
(18 winners; the floor's own retention is 86%) or a detected critical
permission (2), never missing sim data. All 539 explicit-FAIL honeypots
in the parsed population remain rejected. At the delivery floor
(`ALERT_MIN_SCORE=80`), the delivered set is ~11/day equivalent with 68%
of deliveries going on to ≥10x (vs 1.7% base rate) and 89% to ≥2x.

**Provenance.** The 68%-of-deliveries-to-≥10x and 7.5%-to-86.5% eligibility
figures above were measured by replaying the shipped eligibility and
`scoreOpportunity` path over the `token_performance` labeled population from
the local restored-prod snapshot described in
`docs/reweight-preregistration-2026-07.md` section 0 (a data-only `pg_dump`
of prod restored 2026-07-20 into the local `radar-pg` container), horizon
72h, band $10k-$100k. This was an ad-hoc measurement, not a committed
script: `apps/worker/src/calibrate.ts` and `calibrate-sweep.ts` produce
related distributions (multi-bucket calibration, sweep recall) but not
these exact precision-at-floor figures. The snapshot is prod-only and
gitignored, so the numbers cannot be regenerated from committed data; the
living reproducible equivalent is the dashboard precision panel backed by
`getScorePrecision` (`packages/database/src/analytics.ts`), which
recomputes the score-to-outcome precision curve over current data.

**Validation.** Unit and boundary tests cover every component tier, the
missing-vs-explicit eligibility contract, the tier bands, and a behavior
test encoding the ≥10x median profile (quote $5.8k, 57 buyers/1h, flow
ratio 3, FDV $22k, sim UNKNOWN → eligible, YELLOW; same vector with sim
FAIL → rejected). The thresholds themselves are ENGINEERING-CHOSEN on the
tune data (like the 2026-07-13 band lowering): the confirm window in the
snapshot is thin (99 rows, one ≥10x), so per this document's change
protocol the model is deployed for label collection and must be re-run
out-of-time (tune/confirm split) once ≥2 weeks of fresh horizon-72 labels
accumulate under the new regime before being described as validated.

### Liquidity depth: 0-35

Inputs (all quote-side; total liquidity is deliberately not scored, the
token side is valued by the token's own price and is trivially inflatable):

* Quote-side depth, tiered above the eligibility floor (0-20; breakpoints
  $2.5k/$5k/$10k/$20k/$30k). Quote liquidity is the dominant single
  filter: losers' median quote liquidity is dust, ≥10x winners' median is
  $5.8k.
* Quote-liquidity-to-FDV ratio, exit depth relative to valuation (0-8).
* Sell-slippage curve: flat and bounded across probed notionals (0-7);
  steep growth with size subtracts; a reverted probe at a larger size is
  flagged as a risk reason.

### Buyer breadth: 0-25

Inputs:

* Unique buyers over the last hour (0-15: ≥30 → 15, ≥15 → 13, ≥5 → 8,
  ≥1 → 3). The [15,30) bucket carried a 17.4% ≥10x rate vs the 1.7% base.
* Unique buyers over the last 20 minutes (0-10: ≥15 → 10, ≥5 → 6, ≥1 → 3).

Null or zero windows earn 0 points and never penalize: 30-50% of rows lack
activity data at entry, and penalizing a coverage gap would re-create the
missing-data trap the 2026-07-20 rebuild removed.

### Buy flow: 0-20

Inputs, both gated by the dust floor (`flowFloorMinBuys20m`,
`flowFloorMinUniqueBuyers20m`, default 5/5):

* 20m buy/(sell+1) count ratio (0-15: ≥3 → 15, ≥1.5 → 10, ≥1 → 6). The ≥3
  bucket carried a 33.8% ≥10x rate among quote-liquidity survivors, the
  strongest single lift measured.
* Net-quote-inflow bonus (+5) on a strict volume excess. Malformed raw
  volume strings withhold the bonus with a risk reason instead of parsing
  to zero.

### Low-cap tilt: 0-20

Entry-FDV zone tilt toward the measured 10x sweet spot: $15-40k → 20,
$40-60k → 12, $10-15k → 10, $60-100k → 6, outside the band → 0. The tilt
targets the 10x product goal specifically; for plain 2x the FDV lift is
monotone upward, so if the goal shifts to "any 2x runner" raise the
sweet-spot ceiling rather than reading this as a universal small-cap
preference.

### Advisory signals (computed and shown, never scored)

The holder, ownership, deployer-history, contract-transparency, sim,
buy-shape, retention, and cohort signals remain measured and surface as
positive/risk reasons on every score record (e.g. "deployer holds X bps",
"sim status UNKNOWN", "top-10 concentration Y bps"). They carry no points
because their entry-time coverage is under 35% on fresh launches; each
rejoins the score when real coverage exists, per the change protocol.
`priceStructure` and `projectEvidence` likewise return only when real
price-history and web-evidence signals exist; they must not be carried as
constant placeholder points.

## Alert levels

Stoplight semantics since 2026-07-11 (was GRAY/YELLOW/ORANGE/RED; historical
rows were relabeled in migration `0014_stoplight_levels`, so one vocabulary
exists everywhere): RED = stop (seen, too early to act), YELLOW = caution
(research candidate), GREEN = go (high-priority manual review). Escalation
order is GRAY < RED < YELLOW < GREEN.

An observed liquidity collapse or a sell-simulation regression caps the level
at Gray regardless of score, with the cap reason surfaced on the score record.

### Gray

Stored only. Out of band, invalidated, or enrichment incomplete.

### Red (early watch)

Seen and tracked; too early to act. Eligibility NOT required:

* Estimated FDV approximately $10,000–$100,000 (the whole band).
* QUOTE liquidity at least $2,500 (2026-07-20: was total liquidity; quote
  is the dominant filter and the token side is inflatable).
* At least 5 unique buyers.
* No KNOWN critical failure: a detected critical permission or an explicit
  risk FAIL blocks; null/UNKNOWN risk data does not.

### Yellow (research candidate)

Manual research; the young-runner tier:

* Estimated FDV approximately $15,000–$60,000.
* Total liquidity at least $8,000.
* Eligible.
* Score at least 65.
* Sell simulation may be UNKNOWN (surfaced as a flag; explicit FAILs never
  reach this tier because eligibility rejects them).

### Green (go)

High-priority manual review; the measured 10x sweet spot:

* Estimated FDV approximately $15,000–$40,000.
* Eligible.
* Score at least 80.
* At least 20 unique buyers.
* Recent sell simulation affirmatively PASSes (the safety guard that
  distinguishes GREEN from YELLOW).
* Adjusted top-ten ownership below 40% WHEN the value is known; a null
  value is treated as satisfied (missing≠fail; the unknown is surfaced in
  the scorecard). This is a deliberate, documented risk-policy exception.
* Required measurements are fresh.

## Alert deduplication

Do not emit repeated alerts for every snapshot.

An alert may be emitted when:

* Alert level increases.
* Candidate re-enters a level after a material invalidation.
* A major risk status changes.
* A major score component changes beyond configured thresholds.
* A configured cooldown expires and materially new evidence exists — as
  implemented (2026-07-12): a same/lower-level re-alert requires BOTH the
  cooldown (`ALERT_COOLDOWN_MS`) AND a score improvement of at least
  `ALERT_REALERT_MIN_SCORE_DELTA` (default 10 points) over the last alert.
  Level escalations bypass both. Suppressions carry the machine-stable
  reason `no-material-improvement:<score><last>+<delta>`.

Dedup is per token address; copycat launch waves (distinct contracts
sharing a name — observed live 2026-07-12: four "Robin World" tokens
alerting within 11 seconds, each as its own first alert) are additionally
suppressed at delivery: when a DIFFERENT token whose normalized name
(lowercased, stripped to `[a-z0-9]`) matches has already delivered within
`ALERT_DUPLICATE_NAME_COOLDOWN_MS` (default 6h; 0 disables), a new alert
delivers only if its level outranks the delivered sibling's — the
strongest launch of a wave still surfaces. Suppressed candidates are still
scored and persisted, with the machine-stable reason
`duplicate-name:<level>@<siblingToken>`. Token names are attacker-
controlled; a spammer can defeat this by varying names, at the cost of the
copycat branding that motivates the wave.

Every alert should include the reason it was emitted.

## Delivery score floor

Alerts are only delivered when the opportunity score meets the configured
minimum (`ALERT_MIN_SCORE`, default 80 on the 2026-07-20 four-component
scale). Candidates below the
floor are still classified, scored, and persisted on every pass — only
Telegram delivery is suppressed, with a machine-stable reason
(`below-min-score:<score><floor>`). Setting the floor to 0 disables the
gate.

Floor history (delivery gate, not an eligibility/scoring change — tuned
against observed volume per the `.env.example` query):

* 2026-07-11 — 50 → 60, alongside the score recalibration, targeting
  single-digit deliveries/day.
* 2026-07-12 — 60 → 75, operator-requested quiet data-collection week.
  Live 10h window delivered 80 alerts at floor 60, 10 at 70, 2 at 75;
  75 ≈ 5/day of only genuinely strong candidates (GREEN-threshold scores,
  whatever their tier). Revisit after the week's calibration labels
  accumulate.
* 2026-07-20 — 75 → 68 globally, with `ALERT_MIN_SCORE_RED` explicitly
  pinned at 75 so effective RED delivery stayed exactly where it was
  (max(75, 70) = 75 before, max(68, 75) = 75 after). Grounds: the
  pre-registered component re-weight evaluation (see the change-log entry
  above and `docs/reweight-preregistration-2026-07.md`) found weights are
  not the lever, while a shadow-decision counterfactual on the correct
  population for a delivery-floor question (`token_score_results`, live
  full-signal scores, joined to `token_performance` 72h labels;
  2026-07-12 to 07-20 window) measured what floor 75 suppressed: 203
  eligible YELLOW tokens with max score 68-74 versus 14 delivered, of
  which 79 hit 2x within 72h (54 of those before their realized peak) and
  41 hit 5x (26 before peak); roughly 27% of the extras are
  before-peak 2x even when every unlabeled token is counted as a loser.
  Within-band score is barely rank-ordering (winners are denser at 68-70
  than 71-74), so the floor value is a call-volume choice, not a
  precision one: expect roughly 8-25 extra deliveries/day depending on
  launch tempo. Eligibility and classification thresholds are untouched;
  this is delivery only. Revisit with the volume query below after a week
  of operation.
* 2026-07-20 (later the same day) — 68 → 80 on the NEW four-component
  scale, which is not comparable to the old one (the 68 above was an
  old-scale value). Measured on the labeled horizon-72 replay of the new
  model: floor 70 delivered ~138/day equivalent, floor 75 ~23/day at 45%
  ≥10x precision, floor 80 ~11/day at 68% ≥10x precision (vs the 1.7%
  base rate). 80 is the precision-tilted operating point the operator
  chose (~5-10/day); the first-week live-volume ritual tunes it ±5
  before any component weight moves.
  Correction (2026-07-21): the "~11/day equivalent" and "~138/day" figures
  above were replay-derived on `token_performance` (the labeled winner-study
  set), not a live-volume measurement, and are not reliable delivery-volume
  estimates. Superseded by the token_score_results / alerts_sent method
  below.
* 2026-07-21: investigated, NO change (stays 80). Operator reported an
  alert flood following the 2026-07-20 model rebuild deploy. Prod config
  verified correct: `ALERT_MIN_SCORE=80`, `ALERT_MIN_SCORE_RED=75` in the
  prod `.env` and in the running worker's environment, so the flood was
  not config drift. Composition of the 30h window around the deploy (19
  delivered, all distinct tokens, dedup healthy): 4 sub-80 deliveries
  (scores 68-72) sent before the deploy under the old 68 floor; an
  8-alert backlog burst in the ~90s after the worker restart (00:40 UTC,
  the documented restart-burst pattern, discounted); then 7 deliveries in
  the next 3h (scores 80-86, mass at 80-82), a ~2-3/hr tail that may be
  the new score re-rating the existing watch population as snapshots
  refresh rather than steady state. Floor sweep on the labeled replay
  (`calibrate-sweep`, baseline weights, caught = unique tokens clearing
  delivery, tune/confirm out-of-time): floor 80 caught 12/7 (10/7 of them
  2x winners), floor 85 caught 1/0 (1/0 winners), floor 90 caught 0/0.
  Raising to 85 would discard 16 of the 17 caught winners to silence a
  possibly transient flood, so the floor stays at 80. Pre-registered
  trigger: re-run the volume query below on a burst-free 24h window; if
  deliveries/day still exceeds ~10, raise to 85 (the lowest measured step
  meeting the target) accepting the recorded winner cost, and never
  higher. Note the replay-vs-live tempo gap (replay ~1/day caught at 80
  over the 19-day window vs ~2-3/hr live post-deploy): if the 24h
  measurement confirms the high tempo, diagnose the prod score
  distribution before treating 85 as settled.

RED-level (early watch) alerts carry an additional floor
(`ALERT_MIN_SCORE_RED`, default 70; effective RED floor is the max of the
two, so it is inert while the global floor is at or above it; 0 falls back
to `ALERT_MIN_SCORE`). Added 2026-07-12: with the global
floor at 60, most delivered REDs re-alerted as YELLOW within the hour (13
of ~58 alerted tokens in a 9h window paged twice), so the non-actionable
early-watch tier now pages only for exceptional candidates. YELLOW/GREEN
delivery is unaffected, and RED candidates below the floor are still
classified, scored, and persisted — an escalation to YELLOW later delivers
normally as a first alert.

Tune against observed volume: two tracks, both required before any floor
change, never one alone.

**Live truth (current floor only):**

```sql
SELECT date_trunc('day', sent_at) AS day, count(*)
FROM alerts_sent WHERE delivered GROUP BY 1 ORDER BY 1;
```

**Counterfactual (any candidate floor):**

```sh
bun run floor:volume -- --days=7 --floors=<f1,f2,f3>
```

Reads `token_score_results` (every scoring pass, not the labeled winner-study
set), the correct population for a delivery-volume question. Pass
`--burst-discard-until=<deploy instant>` after any model redeploy to drop the
post-deploy re-score burst from the window.

Preconditions, stated as hard rules:

* Never decide a floor off less than 24h of burst-free data.
* Always discard the post-deploy re-score burst before reading volume.
* `calibrate-sweep`'s `caught` is winner-recall on the labeled
  `token_performance` winner-study set; it is not a volume estimate and must
  not be read as one.
