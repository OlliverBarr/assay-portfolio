# @assay/enrichment

Trusted-quote pool enrichment for the launch radar.

Responsibilities:

- Read adversarial token metadata (`name`, `symbol`, `decimals`,
  `totalSupply`) without defaulting missing required fields.
- Calculate V2 prices from reserves and V3 prices from `slot0.sqrtPriceX96`.
- Anchor USD values deterministically: USDG = $1, WETH/USD from the deepest
  WETH/USDG pool at read time, and VIRTUAL/USD chained through the deeper of
  its USDG- or WETH-paired pool — gated by a $50k anchor-depth floor
  (circuit breaker; anchor reads are live each pass, so depth, not
  staleness, is the failure mode).
- Append pool snapshots with `priceUsd`, `estimatedFdvUsd`,
  `quoteLiquidityUsd`, `totalLiquidityUsd`, and explicit null reasons.
- Continue past per-pool failures and report them in the pass result.

Numeric policy:

- Raw on-chain values stay `bigint`.
- Derived financial values use WAD fixed-point (`10^18`) and are persisted as
  decimal strings into PostgreSQL `numeric(60,18)` columns.
- JS `number` is not used for raw token amounts, prices, FDV, or liquidity.

Non-goals:

- No swap ingestion.
- No risk checks or simulations.
- No scoring or alerts.
- No V4 PoolManager ingestion.
