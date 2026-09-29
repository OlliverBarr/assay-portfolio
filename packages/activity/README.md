# @assay/activity

Swap-event ingestion for already-discovered trusted-quote Robinhood Chain pools.

Responsibilities:

- Select trusted-quote pools from `@assay/database`.
- Fetch V2/V3 swap logs in bounded block chunks.
- Decode Uniswap V2 and V3 swap event shapes from `@assay/chain` ABI exports.
- Normalize token direction using stored pool metadata, not symbols.
- Persist append-only normalized swap rows idempotently on `(chain_id, transaction_hash, log_index)`.
- Persist append-only rolling activity snapshots for 20-minute and 1-hour windows.
- Halt loudly with `ActivityHaltError` on bounded RPC retry exhaustion; the cursor does not advance for failed chunks.

## Side classification

Amounts are normalized as signed pool deltas: positive means the token entered the pool, negative means it left the pool.

For trusted-quote pools:

- `BUY`: base token delta is negative and quote token delta is positive.
- `SELL`: base token delta is positive and quote token delta is negative.
- `UNKNOWN`: zero, same-direction, missing, or otherwise ambiguous movement.

V2 raw event amounts are converted to deltas as `amountIn - amountOut`. V3 `amount0`/`amount1` are already pool deltas.

## Buyer identity assumption

For this milestone, BUY recipient is treated as the buyer:

- V2 BUY: `to`.
- V3 BUY: `recipient`.

Routers may be recipients in some flows. Raw `sender` and `recipient` are stored so later router-aware attribution can improve this approximation.

## Raw-volume policy

`quote_amount_raw` is the absolute trusted quote-token amount moved for the swap side. Rolling quote volumes sum these raw integer strings exactly; no USD conversion happens in this package. USD conversion can later join against enrichment snapshots.

## Buy-shape signals (1h window)

Three pure signals derived from the 1h window's BUY swaps, aggregating per-buyer raw quote spend with bigint arithmetic throughout (only the final bps ratio is a JS number):

- `buySizeGiniBps` — Gini coefficient of per-buyer 1h spend totals, in bps. `0` = every buyer spent the same amount, `10000` = one buyer holds all volume. Fewer than 2 distinct buyers → `null` (concentration is undefined).
- `buySizeEntropyBps` — Shannon entropy of per-buyer spend shares, normalized by `log(buyerCount)`, in bps of that max. `1` buyer → `null`. A *dominant* buyer among several co-buyers is not `null` — it surfaces as a low (near-zero) bps value, since entropy is only undefined for a literal lone buyer.
- `repeatedSizeBuyPctBps` — share of 1h BUY events whose exact `quote_amount_raw` recurs 2+ times in the window, in bps. Flags bot-like repeated buy sizing. `0` buys → `null`.

Buyer identity for these signals is the same field used for unique-buyer counting (BUY recipient, lowercased) — see "Buyer identity assumption" above.

## Cursor semantics

`activity_cursor` keeps `latest_observed_block` separate from `latest_processed_block`. A chunk commits swap rows, activity snapshots, and cursor advance in one transaction. A crash or `ActivityHaltError` resumes from `latest_processed_block + 1`; duplicate logs are safe because swap rows are unique by canonical log identity.

The activity target is capped at the discovery cursor's processed block so swap ingestion does not scan blocks whose pool-creation events have not been safely discovered yet.
