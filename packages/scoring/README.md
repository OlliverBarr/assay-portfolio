# @assay/scoring

Pure, deterministic candidate evaluation. No I/O, no clock, no database —
same inputs, same verdict, forever replayable.

- `CandidateFeatures` — the normalized input vector the worker assembles from
  the latest per-signal snapshots (enrichment, activity, risk, holders,
  trajectory, provenance, cohort). Every not-yet-available signal is an
  explicit null: unknown is never treated as passing.
- `evaluateEligibility` — tiered gate. Nine HARD rules gate `eligible` (FDV
  band, liquidity floors, age, sell-simulation pass + loss cap, critical
  permissions, trusted quote, liquidity-not-collapsed); three QUALITY rules
  (buyers, deployer/top-10 ownership caps) are advisory — their failures,
  including missing data, land in `softFailedRules` with `quality: `-prefixed
  reasons and shape the score instead of blocking the candidate. Failures
  return machine-stable rule keys plus human-readable reasons either way.
- `scoreOpportunity` — explainable 0–100 across six capped components
  (liquidity quality 30, organic buying 20, holder growth 15, ownership 15,
  wallet quality 10, transparency 10 — every maximum attainable from
  currently measured signals; recalibrated 2026-07-11, see
  docs/scoring-model.md). Every point delta records a reason. Tunables live
  in `SignalConfig`.
- `classifyAlertLevel` — GRAY/RED/YELLOW/GREEN stoplight tiers (red = early
  watch, yellow = research, green = go), with hard GRAY caps on
  invalidation (liquidity collapse, sell-simulation regression). A high score
  never overrides an eligibility failure.

Thresholds are documented in `docs/scoring-model.md`; any change must follow
that file's change protocol (rationale, date, before/after, tests).
