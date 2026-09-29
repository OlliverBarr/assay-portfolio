# Score re-weight pre-registration: 2026-07-20

Track B of the score-reweight-calibration plan (`local://score-reweight-calibration-plan.md`,
Step 2). This document commits every analysis choice, the population, the
out-of-time split, the ship criterion, and the full candidate-move space
*before* any counterfactual sweep output exists. Steps 3 (feature-lift,
candidate ranking on tune) and 4 (out-of-time confirm) run after this
commitment and must not change anything written here.

## 0. Data provenance

Live counts below are read from `token_performance` / `token_outcomes` in the
local `radar-pg` container (`localhost:5433`, database `launch_radar`), a
data-only `pg_dump` snapshot of prod (radar-1, Hetzner VPS), restored
2026-07-20. `token_performance` = 26,660 rows total, 25,008 at the current
band (`band_min_fdv_usd = 10000 AND band_max_fdv_usd = 100000`). These are
larger than the plan's stated 26,537 / 24,885: the plan's numbers were read
earlier the same day and the table has grown since (append-only, continuous
ingestion). This document reports its own live counts throughout, not the
plan's, per instruction. `token_score_results` and `alerts_sent` were not
restored (not needed for Track B; the sweep population is `token_performance`
only, per the plan's anti-self-fulfilling discipline).

## 1. Committed analysis constants

These do not change after this document is written, regardless of what Step 3
or Step 4 find.

* **Horizon:** 72 hours (`token_performance.horizon_hours = 72`).
* **Primary winner label:** `max_multiple_bps >= 20000` (2x), chosen for
  statistical power.
* **Secondary winner label:** `max_multiple_bps >= 50000` (5x).
* **Population filter**, all three conditions:
  1. Current band: `band_min_fdv_usd = 10000 AND band_max_fdv_usd = 100000`
     (per-row columns, not a global constant; every current-band row already
     satisfies this in the restored snapshot, see Appendix A row-accounting).
  2. `horizon_hours = 72`.
  3. Strict-parseable `entry_features` (exact predicate below, Appendix C).

## 2. Out-of-time split

Per `docs/execution-methodology.md` section 7 ("Out-of-time validation,
always. Tune on one period, confirm on a later one. A threshold chosen and
validated on the same data is a story, not a finding.") and the
`docs/scoring-model.md` change protocol:

* **Tune period:** `entered_at` in `[2026-07-06, 2026-07-13)`.
* **Confirm period:** `entered_at` in `[2026-07-13, 2026-07-20)`, strictly
  later than tune.

Row counts (current band, horizon 72, before the parse filter): tune 7,487,
confirm 1,773. After strict-parseable filtering: tune 3,088 (41.2% of tune
survives parsing, the rest is legacy-shape `entry_features` predating the
2026-07-15 feature-vector change), confirm 1,773 (100.0% survives, confirm is
entirely new-shape). These populations, and only these, are what Step 3 and
Step 4 run against.

## 3. Reconstructable component budget (recap, from the plan)

The sweep re-weights only the reconstructable sub-budget `R_i` of five
components; `walletQuality` is excluded (see section 7). `heldPoints` for
`walletQuality` and the `F_i` sub-budgets below are frozen at their current
tier values and never move in this re-weight.

| Component | `R_i` | `F_i` (held fixed) | `nominal_i` |
| --- | ---: | ---: | ---: |
| liquidityQuality | 18 | 12 (trajectory 7 + slippage 5) | 30 |
| organicBuying | 14 | 6 (retention 3 + cohort net-inflow 3) | 20 |
| holderGrowth | 12 | 3 (cohort buyer percentile 3) | 15 |
| ownershipDistribution | 15 | 0 | 15 |
| contractTransparency | 10 | 0 | 10 |
| walletQuality | 0 (excluded) | 10 (deployer history, constant) | 10 |

`ΣR = 69`.

## 4. Coverage audit and dropped components

Per-period, per-feature non-null coverage over the 13
`CALIBRATION_CONFIG.featureKeys` (`apps/worker/src/calibrate.ts:22-36`), on
the strict-parseable current-band horizon-72 population. Full query in
Appendix A.

| Feature | tune (N=3,088) | confirm (N=1,773) | Flag (<60% either period) |
| --- | ---: | ---: | :---: |
| quoteLiquidityUsd | 100.0% | 100.0% | |
| totalLiquidityUsd | 100.0% | 100.0% | |
| ageMinutesAtEntry | 100.0% | 100.0% | |
| uniqueBuyers1h | 99.0% | 90.5% | |
| buySizeGiniBps | 25.2% | 53.4% | FLAG |
| buySizeEntropyBps | 25.2% | 53.4% | FLAG |
| repeatedSizeBuyPctBps | 26.2% | 55.9% | FLAG |
| floatBps | 1.9% | 6.7% | FLAG |
| supplyInPoolBps | 1.9% | 6.7% | FLAG |
| adjustedTop10PctBps | 16.7% | 35.7% | FLAG |
| deployerPctBps | 15.6% | 32.4% | FLAG |
| adjustedHolderCount | 16.7% | 35.7% | FLAG |
| effectiveSellLossBps | 7.9% | 17.4% | FLAG |

Nine of thirteen features are flagged. Only the liquidity-depth pair and
`uniqueBuyers1h`/`ageMinutesAtEntry` clear the bar in both periods.

**Component mapping and drop decision** (mapping as specified for this
audit; a component is dropped if any mapped feature is flagged):

| Component | Mapped features | Any flagged? | Verdict |
| --- | --- | :---: | --- |
| liquidityQuality | quoteLiquidityUsd, totalLiquidityUsd | No | **SURVIVES** |
| organicBuying | uniqueBuyers1h, buySizeGiniBps, buySizeEntropyBps, repeatedSizeBuyPctBps | Yes (gini, entropy, repeated) | **DROPPED** |
| holderGrowth | adjustedHolderCount | Yes | **DROPPED** |
| ownershipDistribution | adjustedTop10PctBps, deployerPctBps, floatBps, supplyInPoolBps | Yes (all four) | **DROPPED** |
| contractTransparency | effectiveSellLossBps (proxy; see note) | Yes | **DROPPED** |

Note on the `contractTransparency` proxy: none of `contractTransparency`'s
actual scored inputs (`verificationStatus`, `isProxy`,
`criticalPermissionPresent`, `simulationStatus`) are in
`CALIBRATION_CONFIG.featureKeys`, so `effectiveSellLossBps` stands in as an
approximate coverage proxy per this audit's instructions. A direct
supplementary check of the real inputs confirms the proxy's conclusion
rather than softening it: `verificationStatus`/`isProxy`/
`criticalPermissionPresent`/`simulationStatus` are 19.9% non-null in tune and
26.4% in confirm (all four move together, same underlying risk-pass row).
`contractTransparency` would be dropped on its true inputs regardless of the
proxy.

Note on `organicBuying`: the component's *positive* point-generating inputs
that are not in `CALIBRATION_CONFIG.featureKeys` (`uniqueBuyers20m`,
`buyCount20m`, `sellCount20m`, `quoteBuyVolumeRaw20m`,
`quoteSellVolumeRaw20m`, the 20-minute flow fields worth 7 of `organicBuying`'s
14-point `R` budget) are in fact well covered: 99.0% (tune) / 90.5% (confirm),
identical to `uniqueBuyers1h`'s coverage (all six fields are written together
by the same activity-pass row). The drop is driven entirely by the three
buy-shape *penalty* modifiers (gini, entropy, repeated-size), which are
mapped to this component per this audit's instructions and are flagged. This
matters for score fidelity even though it is a penalty, not a budget input:
when gini/entropy/repeated are null, `scoreOrganicBuying` applies no penalty
(null-safe by design), so 45-75% of rows in this population get organic-buying
points with the wash/coordination check silently skipped, not confirmed
clean. That is exactly the "can't tell weak signal from missing signal"
condition the coverage bar exists to catch, so the drop stands as instructed.
Recorded here for whoever revisits this: if a future pre-registration wants
to isolate a re-weight to strictly `organicBuying`'s positive `R` sub-budget
(buyers + 20m flow, excluding the gini/entropy/repeated penalty path), that
would be a materially different, narrower move than "re-weight
`organicBuying`" as scored today, and would need its own pre-registration.

**Headline finding:** only `liquidityQuality` clears the coverage bar in this
snapshot. `organicBuying`, `holderGrowth`, `ownershipDistribution`, and
`contractTransparency` are all dropped. This is a data-coverage fact about
current `entry_features` (holder-snapshot- and sell-simulation-derived
signals lag pool-entry time, consistent with the ZERO-holder-coverage finding
already on record in `docs/scoring-model.md`'s 2026-07-12 eligibility
rationale), not a claim about the components' true predictive value.

## 5. Candidate move space

A candidate move is a single zero-sum 5-point shift between two of the five
reconstructable components, `from` losing 5, `to` gaining 5, constrained to
`R_from - 5 >= 5` (the `from` component keeps a nonzero, non-trivial budget).
All five components satisfy this constraint on their own (`18-5=13`,
`14-5=9`, `12-5=7`, `15-5=10`, `10-5=5`), so the unconstrained space is every
ordered pair among the five, 5x4 = 20 pairs. Applying the section 4 coverage
gate (both `from` and `to` must survive) collapses it:

| # | from | to | from status | to status | Valid for sweep |
| ---: | --- | --- | --- | --- | :---: |
| 1 | liquidityQuality | organicBuying | SURVIVES | DROPPED | No |
| 2 | liquidityQuality | holderGrowth | SURVIVES | DROPPED | No |
| 3 | liquidityQuality | ownershipDistribution | SURVIVES | DROPPED | No |
| 4 | liquidityQuality | contractTransparency | SURVIVES | DROPPED | No |
| 5 | organicBuying | liquidityQuality | DROPPED | SURVIVES | No |
| 6 | organicBuying | holderGrowth | DROPPED | DROPPED | No |
| 7 | organicBuying | ownershipDistribution | DROPPED | DROPPED | No |
| 8 | organicBuying | contractTransparency | DROPPED | DROPPED | No |
| 9 | holderGrowth | liquidityQuality | DROPPED | SURVIVES | No |
| 10 | holderGrowth | organicBuying | DROPPED | DROPPED | No |
| 11 | holderGrowth | ownershipDistribution | DROPPED | DROPPED | No |
| 12 | holderGrowth | contractTransparency | DROPPED | DROPPED | No |
| 13 | ownershipDistribution | liquidityQuality | DROPPED | SURVIVES | No |
| 14 | ownershipDistribution | organicBuying | DROPPED | DROPPED | No |
| 15 | ownershipDistribution | holderGrowth | DROPPED | DROPPED | No |
| 16 | ownershipDistribution | contractTransparency | DROPPED | DROPPED | No |
| 17 | contractTransparency | liquidityQuality | DROPPED | SURVIVES | No |
| 18 | contractTransparency | organicBuying | DROPPED | DROPPED | No |
| 19 | contractTransparency | holderGrowth | DROPPED | DROPPED | No |
| 20 | contractTransparency | ownershipDistribution | DROPPED | DROPPED | No |

**0 of 20 candidate pairs currently clear the coverage gate.** A valid move
needs two surviving components (a place to take points from, a place to give
them to); this snapshot leaves exactly one (`liquidityQuality`), which cannot
pair with itself. Per the plan's own contingency language ("Keep collecting
is a legitimate, expected endpoint"), the coverage state recorded above,
alone, is grounds for `do not ship` if it still holds when Step 3 runs (see
section 7). This is not this document overriding Step 3/4; it is what those
steps will find if entry_features coverage for holder-snapshot- and
sell-simulation-derived signals has not materially improved by the time they
run. If coverage improves before Step 3 (e.g. holder/risk enrichment catches
up on a later slice), re-run section 4's queries against the then-current
tune/confirm windows before trusting this table.

## 6. Ship criterion (verbatim from the plan)

Ship the single best candidate move only if, in order:

1. On the **tune** period, it raises `Δcaught` without worsening
   `Δadmitted-losers`.
2. It **holds on confirm** (same sign, admitted not worse) when re-run
   unmodified on the confirm period.
3. The extra catches are **not concentrated** in un-holdable
   (`max_drawdown_bps >= 6000`, i.e. 60%+ pre-peak drawdown), instant-peak
   (`minutes_to_peak < 30`), or coarse-sampled (`snapshots_in_window < 6`)
   winners (realizability cross-checks, section 8).

## 7. Do-not-ship clause

If no candidate move passes all three ship-criterion legs (including, as an
immediate structural case, if the coverage gate in section 5 leaves zero
valid pairs to even test), the negative result is recorded in this document
and nothing ships: no `score.ts` edit, no weight change, no partial move.
"Weights are not the lever, right now" is a legitimate, complete outcome of
this protocol, not a failure to find one. Given section 5's current state
(0/20 pairs clear coverage), the expected outcome of Steps 3-4, unless
coverage changes materially, is exactly this: **do not ship**, and the
scoring-model.md entry (if any) states that the reweight was pre-registered,
audited, and shelved on data-coverage grounds, pointing back at the gate
(T5) / floor / signal-coverage work the plan's own framing already
identifies as the dominant levers.

## 8. Realizability cross-tabs (reject filters for Step 4)

Same population as sections 4-5 (current band, horizon 72, strict-parseable),
pooled across tune + confirm (`entered_at` in `[2026-07-06, 2026-07-20)`),
split by winner label. `max_drawdown_bps` is stored as a positive magnitude
(worst pre-peak drop below entry, 0 = no drawdown, 10000 = round-trip to
zero; confirmed via `min/max/avg` sanity query in Appendix B), so
"un-holdable" is `max_drawdown_bps >= 6000` (60%+ drop before the peak that
produced the multiple).

| Winner set | N | Un-holdable (drawdown >= 60%) | Instant-peak (<30min) | Slow-peak (>=30min) | Coarse-sampled (<6 snapshots) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2x (`max_multiple_bps >= 20000`) | 481 | 15 (3.1%) | 65 (13.5%) | 416 (86.5%) | 0 (0.0%) |
| 5x (`max_multiple_bps >= 50000`) | 236 | 8 (3.4%) | 6 (2.5%) | 230 (97.5%) | 0 (0.0%) |

Per-period breakdown:

| Period | Winner set | N | Un-holdable | Instant-peak |
| --- | --- | ---: | ---: | ---: |
| tune | 2x | 199 | 3 | 35 |
| tune | 5x | 86 | 1 | 3 |
| confirm | 2x | 282 | 12 | 30 |
| confirm | 5x | 150 | 7 | 3 |

Reading: realizable winners in this population are overwhelmingly holdable
(96.6-96.9% under the 60%-drawdown bar) and slow-forming (86.5% of 2x, 97.5%
of 5x peak at or after 30 minutes). Coarse sampling (idle-lane 6h-resolution
peaks) does not appear in this population at all (0 rows below 6 snapshots
in either winner set); the plan's idle-lane caveat evidently affects a
different slice of the data than the current-band, strict-parseable,
horizon-72 winners audited here. These baseline shares are the reference
point Step 4 checks a candidate move's *extra* catches against: if a move's
newly-caught winners skew materially above these background rates on any of
the three filters, reject the move per section 6, leg 3.

## 9. walletQuality exclusion

`walletQuality` is excluded from the sweep entirely, not merely
low-coverage. In `replayCandidateFeatures`
(`apps/worker/src/winners-retro.ts:432-434`), `deployerTokenCount`,
`deployerPriorSurvived`, and `deployerPriorDied` are unconditionally null
(the retro cannot reconstruct deployer serial-launch history as of band-entry
time), which makes `scoreWalletQuality` (`packages/scoring/src/score.ts:369-379`)
always take the "unresolved deployer" branch and return the constant 3 points
for every replayed row. A constant carries zero discriminating information in
this dataset: it cannot be shown to correlate with winners or losers because
it never varies. Re-weighting `walletQuality` on this data would be tuning on
an artifact, not a finding. Per the plan's contingency, unlocking this
requires capturing deployer history into `PerformanceEntryFeatures` first (a
separate performance-pass change, out of scope here), so it stays fixed as
`heldPoints = 3` in every replayed row's total, unrelated to `ΣR`.

## 10. Results (2026-07-20, recorded after Steps 3-4 ran)

Steps 3 and 4 ran the same day via the Track-A tool
(`apps/worker/src/calibrate-sweep.ts`, `bun run calibrate-sweep`), against the
same snapshot as sections 4-8. Coverage had not changed between this
document's commitment and the run, so section 5's table stood as written.

Tool fidelity: PASS, 0 mismatches over all 4,861 filtered rows
(`score'(R)` equals the live `scoreOpportunity` score exactly at baseline
weights, so every number below is produced by the real scorer, not a fork).
Population accounting: 26,660 rows total, 4,861 filtered in (skips: 17,400
wrong horizon, 0 wrong band, 4,399 legacy-shape unparseable); tune N=3,088
(199 2x winners, 86 5x), confirm N=1,773 (282 2x, 150 5x).

Outcome: **do not ship**, on three independent, pre-registered grounds.

1. **Coverage gate (section 5):** 0 of 20 candidate pairs valid; only
   `liquidityQuality` survives, and a zero-sum move needs two surviving
   components. There was nothing eligible to tune.
2. **Reachable ceiling is zero.** Among 2x winners (N=481 across both
   periods): 0 already caught, 0 reachable (eligible with baseline replay
   score in 55-74), 458 gate-blocked (ineligible or GRAY), 23 below 55.
   Among 5x winners (N=236): 0 / 0 / 226 / 10. Per period the reachable
   class is 0 (tune) and 0 (confirm), far under the pre-registered minimum
   of 30; the tool printed `SAMPLE TOO SMALL - DO NOT SHIP` and exited
   non-zero.
3. **No move can produce a positive delta.** Only 185 of 4,861 rows are
   eligible at all (dominant hard-gate failures: sell-loss 4,320, sell-sim
   4,316, min-age 3,665, quote-liquidity 3,591, total-liquidity 3,429); all
   54 eligible non-GRAY rows classify RED, whose effective delivery floor is
   max(75, ALERT_MIN_SCORE_RED=70); and the maximum replayed score across
   the entire population is 55, below even yellowMinScore=65. Delta-caught
   is identically 0 for every `ΣW = 69` re-weight at floors 75 and 65, in both
   periods (verified by sweep runs at baseline and shifted weights).

Step-3 feature-lift on the tune period, for the record: `uniqueBuyers1h`
shows the only clean quartile separation among well-covered features (share
at least 2x: 24.9% in q4 vs 0.0-0.7% in q1-q3). `effectiveSellLossBps` q1
shows strong lift (44.3% at least 2x) but at 7.9% coverage it is exactly the
"missing vs weak" ambiguity the coverage bar exists to catch. The buy-shape
features (gini/entropy/repeated) lift mainly through their null-vs-present
split, i.e. having activity data at all correlates with winning, which is a
coverage artifact, not a tier signal. Everything else is flat or micro-N
(float/supply quartiles have 14-15 rows each).

Interpretation: component weights are not the lever on current evidence. The
replay population structurally cannot cross the delivery floors (grounds 3),
and the winner mass sits behind the eligibility gate (T5: 458 of 481 2x
winners), consistent with the winners-retro census the plan already cited.
The levers this protocol points back at are the gate, the delivery floor,
and entry-time signal coverage, all out of scope for this change.

What would unlock a future re-weight attempt, in order of bindingness:

1. Entry-time holder/risk coverage at or above 60% in both periods of a
   fresh out-of-time split (holder-snapshot and sell-sim enrichment
   currently lag band entry; coverage is improving week over week per
   section 4 but is not there).
2. A non-trivial reachable class: at least 30 eligible winners per period
   scoring 55-74 in replay. Today that class is empty.
3. For any `walletQuality` move: deployer history captured into
   `PerformanceEntryFeatures` first (section 9).

Per section 7, nothing ships: no `score.ts` edit, no weight change. The
`docs/scoring-model.md` change log records this evaluation as pre-registered,
audited, and shelved on the grounds above.

## Appendix A: coverage audit SQL

Strict-parseable predicate (see Appendix C for derivation):

```sql
entry_features ?& ARRAY[
  'quoteLiquidityUsd','totalLiquidityUsd','ageMinutesAtEntry',
  'uniqueBuyers20m','uniqueBuyers1h','buyCount20m','sellCount20m',
  'quoteBuyVolumeRaw20m','quoteSellVolumeRaw20m',
  'buySizeGiniBps','buySizeEntropyBps','repeatedSizeBuyPctBps',
  'floatBps','supplyInPoolBps','adjustedTop10PctBps','deployerPctBps',
  'holderCount','adjustedHolderCount','largestHolderPctBps','holderClusterScoreBps',
  'riskStatus','simulationStatus','effectiveSellLossBps',
  'criticalPermissionPresent','isProxy','verificationStatus'
]
AND entry_features->>'ageMinutesAtEntry' IS NOT NULL
```

Per-feature coverage query (repeated once per period, once per feature key):

```sql
SELECT
  count(*)::int AS total,
  count(*) FILTER (WHERE entry_features->>'<featureKey>' IS NOT NULL)::int AS nonnull
FROM token_performance
WHERE horizon_hours = 72
  AND band_min_fdv_usd = 10000 AND band_max_fdv_usd = 100000
  AND entered_at >= '<period_start>' AND entered_at < '<period_end>'
  AND <strict-parseable predicate above>;
```

Row-accounting (pre-parse-filter, current band + horizon 72):

```sql
SELECT count(*)::int AS n FROM token_performance
WHERE horizon_hours = 72 AND band_min_fdv_usd = 10000 AND band_max_fdv_usd = 100000
  AND entered_at >= '<period_start>' AND entered_at < '<period_end>';
-- tune: 7487, confirm: 1773
```

## Appendix B: realizability audit SQL

```sql
SELECT
  count(*)::int AS n,
  count(*) FILTER (WHERE max_drawdown_bps >= 6000)::int AS unholdable_drawdown,
  count(*) FILTER (WHERE minutes_to_peak IS NOT NULL AND minutes_to_peak < 30)::int AS instant_peak,
  count(*) FILTER (WHERE minutes_to_peak IS NOT NULL AND minutes_to_peak >= 30)::int AS slow_peak,
  count(*) FILTER (WHERE snapshots_in_window < 6)::int AS coarse_sampled
FROM token_performance
WHERE horizon_hours = 72
  AND band_min_fdv_usd = 10000 AND band_max_fdv_usd = 100000
  AND entered_at >= '2026-07-06' AND entered_at < '2026-07-20'
  AND <strict-parseable predicate>
  AND max_multiple_bps >= <20000 | 50000>;
```

Sign-convention sanity check (`max_drawdown_bps` is a positive magnitude, 0
to 10000, confirmed against the full horizon-72 population):

```sql
SELECT min(max_drawdown_bps), max(max_drawdown_bps), avg(max_drawdown_bps)::int
FROM token_performance WHERE horizon_hours = 72;
-- min 0, max 10000, avg 292
```

## Appendix C: strict-parseable predicate derivation

`parseEntryFeatures` (`apps/worker/src/winners-retro.ts:256-356`) requires
every one of 26 keys of `PerformanceEntryFeatures` to be present in the raw
`entry_features` JSON object and to type-check; if any single key is
`undefined` (absent from the object, not merely `null`), the whole parse
returns `null`. `ageMinutesAtEntry` additionally uses `readNumber` (not
`readNumberOrNull`), so it must be an actual finite number, `null` fails it
too; every other field tolerates an explicit JSON `null` value as long as the
key exists. The predicate above (`?&` over all 26 keys, plus a non-null check
on `ageMinutesAtEntry`) approximates this by key-presence rather than full
per-value type validation (the jsonb `?&` operator cannot express "this key,
if present, must be a string/number/one of these enum values"). This is an
approximation, not an exact re-implementation, but it was validated against
`parseEntryFeatures`'s intent: it isolates the pre/post 2026-07-15
feature-vector shape change cleanly (rows missing the post-2026-07-15 keys
entirely, e.g. `uniqueBuyers20m`/`verificationStatus`, are exactly the rows
this predicate excludes: 4,399 of 7,487 tune-period band+horizon-72 rows fail
both the key-presence check and the `uniqueBuyers20m`/`verificationStatus`
presence check identically), and the resulting counts (tune 3,088, confirm
1,773) land within one row of the plan's own stated 3,088 / "all new-shape"
figures, the expected drift from continuous ingestion between when the plan
was written and when this document's queries ran.
