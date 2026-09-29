# @assay/chain

Robinhood Chain access primitives: chain configuration from environment,
viem public client, factory event ABIs (Uniswap V2 `PairCreated`, V3
`PoolCreated`), a raw log-source abstraction, and bounded retry with
transient-RPC-error classification. Log-range fetches recursively bisect
when a response overflows viem's 10 MiB body cap
(`fetchLogsBisectingOversized`), so chunk sizes are throughput knobs, not
correctness cliffs (2026-07-16 incident, see docs/decisions.md).

No product logic lives here — decoding, persistence, and scoring belong to
downstream packages.
