# @assay/holders

Holder-distribution measurement for discovered trusted-quote tokens.

Responsibilities:

- Enumerate a token's holders by scanning ERC-20 `Transfer` logs (chunked, via
  `withRetry`) — from the pool's creation block on the first scan, or only the
  delta since the last scan afterward (see Incremental scan below).
- Net transfers into current balances (`computeBalances`, pure).
- Compute concentration (`computeConcentration`, pure): holder count, largest
  holder, top-10, and **adjusted** variants that exclude non-economic holders —
  the pool address, the zero address, and the canonical `0x…dEaD` burn — by
  address identity, never by name.
- Resolve the token deployer (contract creator) from the Blockscout
  `getcontractcreation` API, persist it on `tokens`
  (`deployer_address`/`deployer_status`/`deployer_checked_at`), and compute
  `deployerPctBps` — the deployer's share of the **adjusted** circulating
  supply, the same denominator as `adjustedTop10PctBps`.
- Persist append-only `token_holder_snapshots` and upsert current
  `token_holders` balances, including `floatBps` (real-float ratio) and
  `supplyInPoolBps` (share of supply sitting in the pool).

## Numeric policy

Balances are `bigint` raw units. Concentration is stored as **integer basis
points** (bps, 0–10000) of circulating supply — never floats. Metrics are
decimal-agnostic (verified for 6/8/9/18-decimal tokens) because they are ratios
of raw balances.

## Restart-safety

`runHolderPass` selects pools via two independently bounded lanes, band lane
first: `selection.band`/`selection.bandLimit` picks trusted-quote pools
currently valued inside the watch band with a missing/stale holder snapshot —
the alert-relevant surface — and `selection.backlog` (optional) tops up with
young pre-band pools within its own separate limit, so backlog scanning can
never eat into the band lane's budget. A pool matching both lanes is scanned
once. Staleness and band membership are both evaluated in SQL. Selection is
idempotent, so a crash re-selects pending pools. Persistent RPC failure
raises `HolderHaltError` (worker backs off); a hostile token whose log read
throws a non-infra error is recorded and skipped without starving the rest.
The abort signal stops the pass at a pool boundary.

## Incremental scan

`tokens.holder_scan_block` is the per-token cursor: null means the token has
never been scanned, so the pass walks `Transfer` logs from the pool's creation
block to head and computes balances from scratch (no seed — seeding on top of
a full replay would double-count). Once set, the pass fetches only
`[holder_scan_block + 1, head]`, seeds balances from the stored `token_holders`
rows (`listTokenHolders`; a holder absent from that seed is `0`), and nets the
delta on top (`computeBalances(transfers, seed)`). Only the addresses the
delta actually touched are re-upserted — a holder who sells out entirely nets
to `0` and is dropped from the computed balance map, but is still written as a
`0` row so their stale positive balance never lingers. If the cursor is
already at or past head (another pool sharing the same base token already
advanced it this pass, or nothing has moved since the last scan), the log
fetch is skipped entirely and the snapshot is recomputed from the stored
balances alone — this is the whole point: RPC cost scales with launch
activity, not with the all-time pool count. The balance upsert, the new
snapshot, and the cursor advance to `head` all commit in one transaction, so a
crash never leaves the cursor ahead of the persisted balances.

## Deployer provenance

The explorer is adversarial input: a missing/garbage/non-OK answer resolves to
`UNKNOWN` (null deployer), never a guess. `deployer_status` is null until the
first attempt, so unknown and unattempted stay distinguishable;
`deployer_checked_at` paces retries (an UNKNOWN token is re-asked at most once
per retry window, never hammered). A resolved deployer that is itself an
excluded non-economic address yields a null `deployerPctBps`; a resolved
deployer holding nothing yields `0`.

## Float and pool share

`floatBps = (totalSupply − Σ excluded-holder balances − deployerBalance) /
totalSupply`, in bps, clamped to `[0, 10000]`. The deployer term is
subtracted only when the deployer is resolved **and** is not already one of
the excluded addresses (never double-subtracted). When the deployer is
unresolved the term is omitted entirely, so the value is a **ceiling** on the
true float — it can only get lower once the deployer resolves. Unlike
`deployerPctBps`, the denominator is raw `totalSupply`, not the adjusted
circulating supply. `supplyInPoolBps` is the pool's share of `totalSupply`,
reusing the pool address already declared in the exclusion set. Both are
`null` when `totalSupply` is `0`.

## Scope note

`holderClusterScoreBps` is persisted as `null` this milestone — wallet-cluster
graphing is a later enhancement. A null is UNKNOWN and never counts as a
passing distribution.
