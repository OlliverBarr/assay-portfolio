# @assay/discovery

Factory event discovery: decodes Uniswap V2/V3 pool-creation logs,
classifies the trusted quote side against the configured allow-list, and
runs restart-safe polling passes.

Invariant: each chunk's tokens, pools, and cursor advance commit in one
transaction. A crash resumes at `latestProcessedBlock + 1` with no gaps;
re-scans are idempotent. On persistent RPC failure the pass halts with
`DiscoveryHaltError` — it never skips a range.
