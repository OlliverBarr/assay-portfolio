# @assay/judgment

Advisory LLM research-briefing layer. Runs strictly downstream of alert
delivery: it reads already-committed `alerts_sent` rows and produces a
follow-up brief; it never gates, delays, or alters an alert.

## Advisory-only contract

- The worker's judgment loop (`apps/worker/src/judgment-pass.ts:1-11`) picks
  up LIVE alerts at or above a configured minimum level that have no brief
  yet. The alert is already committed and delivered before this loop ever
  runs, so a bad or slow LLM call can only affect the follow-up brief, never
  the alert itself.
- A brief is a post-delivery follow-up message sent over the same transport
  (`apps/worker/src/judgment-pass.ts:334-348`): only a `COMPLETED` brief with
  a payload and citation report is sent; on delivery failure the brief row
  is marked `SEND_FAILED` and nothing is retried inline.
- `FAILED` and `REJECTED_FABRICATED_CITATION` briefs are persisted for the
  audit trail but are never delivered: any status short of `COMPLETED`
  routes to `updateJudgmentBriefDelivery(db, brief.id, "SKIPPED")`
  (`judgment-pass.ts:334-345`).
- No scoring, eligibility, or trading decisions happen in this package: an
  alert's score and level are read from the bundle as already computed
  upstream by `@assay/scoring`. The toolkit does compute descriptive
  statistics (percentiles, standardized z-score distances) over historical,
  already-realized outcomes for LLM base-rate context, but nothing here
  prices a trade or moves money.

## Citation verification

Every brief claim cites an append-only row as `(table, rowId, field,
value)`. The allowed tables are a fixed allowlist, deliberately excluding
mutable tables like `tokens`/`pools`/`token_holders` (`src/types.ts:29-42`):
`pool_snapshots`, `pool_activity_snapshots`, `token_holder_snapshots`,
`token_risks`, `trade_simulations`, `token_outcomes`, `token_performance`.
Citations are re-fetched and compared against the live row within a numeric
tolerance (`DEFAULT_CITATION_TOLERANCE`, 100 bps). If verification fails for
any load-bearing claim (thesis or a risk call), `generateBrief` returns
status `REJECTED_FABRICATED_CITATION` instead of `COMPLETED`
(`src/engine.ts:171-172`), and that brief is recorded but never sent.

## Untrusted-string fencing

Attacker-controlled token metadata (name, symbol) is typed as
`UntrustedString` and rendered only through `fenceUntrusted`
(`src/render.ts:38-50`): control characters are stripped, backticks are
removed, any `</untrusted` close-tag attempt is escaped, and the content is
capped at 128 bytes. Every fenced block is preceded by `UNTRUSTED_PREAMBLE`
(`src/render.ts:18-23`), which labels the block as data only, never
instructions or a basis for tool selection. These strings can never reach a
tool argument or the system prompt (`src/render.ts:5-16`).

## Provenance and reproducibility

`assembleEvidenceBundle` (`src/bundle.ts:22-32,106-220`) reconstructs every
bundle field as of a fixed `asOf` timestamp using `<= asOf` reads against
append-only history, so the same code path serves a live brief (`asOf` =
alert `sentAt`) and a historical replay brief without branching. Before the
bundle is returned, `assertNoLookahead` (`src/bundle.ts:222-271`) checks
every row's own timestamp column against `asOf` and throws a
`JudgmentBundleError` (stage `LOOKAHEAD`) if anything postdates it. Prompts
are versioned and hash-registered (`getOrCreatePrompt`), and every tool call
the LLM makes is audited into `judgment_tool_calls`.

## Exports

The barrel `src/index.ts` re-exports `types`, `citations`, `brief`,
`taxonomy`, `bundle`, `render`, `tools`, `llm`, `engine`, and
`prompts/brief-v1`. Main entry points:

- `createJudgmentToolkit` (`src/tools.ts`): builds the fixed, read-only
  history toolkit for one evidence bundle.
- `assembleEvidenceBundle` (`src/bundle.ts`): as-of evidence assembly.
- `generateBrief` (`src/engine.ts`): drives the bounded LLM/tool loop,
  parses and citation-checks the result, and never throws.

## Pipeline position

Strictly after `alerts_sent`: see `docs/architecture.md` ("The judgment
loop is strictly downstream of `alerts_sent`") for the end-to-end
sequencing.
