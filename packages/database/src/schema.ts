import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";

/**
 * Block cursor per chain.
 *
 * `latestObservedBlock` is the newest chain head the worker has seen;
 * `latestProcessedBlock` is the newest block whose factory logs are fully
 * persisted. They are distinct on purpose: the cursor only advances inside
 * the same transaction that commits the range's pools, so a crash can never
 * leave a gap.
 */
export const chainCursor = pgTable("chain_cursor", {
  chainId: integer("chain_id").primaryKey(),
  latestObservedBlock: bigint("latest_observed_block", {
    mode: "bigint"
  }).notNull(),
  latestProcessedBlock: bigint("latest_processed_block", {
    mode: "bigint"
  }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
});

/**
 * Restart-safe cursor for swap/activity ingestion. Separate from discovery so
 * factory ingestion and pool swap ingestion can advance independently while
 * preserving the same two-watermark invariant.
 */
export const activityCursor = pgTable("activity_cursor", {
  chainId: integer("chain_id").primaryKey(),
  latestObservedBlock: bigint("latest_observed_block", {
    mode: "bigint"
  }).notNull(),
  latestProcessedBlock: bigint("latest_processed_block", {
    mode: "bigint"
  }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
});

/**
 * Tokens observed as a side of any discovered pool.
 *
 * Metadata columns are refreshed in place (append-only applies to
 * snapshots, not metadata); `metadataBlock` records the read block.
 */
export const tokens = pgTable(
  "tokens",
  {
    chainId: integer("chain_id").notNull(),
    /** EIP-55 checksummed address. */
    address: text("address").notNull(),
    firstSeenBlock: bigint("first_seen_block", { mode: "bigint" }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    name: text("name"),
    symbol: text("symbol"),
    decimals: integer("decimals"),
    /** uint256 as decimal string; never a JS number. */
    totalSupply: numeric("total_supply", { precision: 78, scale: 0 }),
    /** "PASS" | "ERROR" — ERROR means adversarial/unreadable metadata. */
    metadataStatus: text("metadata_status"),
    metadataBlock: bigint("metadata_block", { mode: "bigint" }),
    /** EIP-55 checksummed contract creator; null until resolved. */
    deployerAddress: text("deployer_address"),
    /**
     * "RESOLVED" | "UNKNOWN" — UNKNOWN means the explorer had no answer
     * (retryable). Null means resolution was never attempted.
     */
    deployerStatus: text("deployer_status"),
    /** When deployer resolution was last attempted; paces explorer retries. */
    deployerCheckedAt: timestamp("deployer_checked_at", { withTimezone: true }),
    /**
     * Last block whose ERC-20 Transfer logs were folded into `token_holders`.
     * Null = never incrementally scanned (next scan walks from pool creation
     * and replaces balances from scratch); set = next scan applies only the
     * delta from this block forward onto the stored balances.
     */
    holderScanBlock: bigint("holder_scan_block", { mode: "bigint" })
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.address] })
  })
);

/** Allow-listed quote assets. Only these anchor trusted valuations. */
export const quoteAssets = pgTable(
  "quote_assets",
  {
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    symbol: text("symbol").notNull(),
    decimals: integer("decimals").notNull(),
    verificationSource: text("verification_source").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.address] })
  })
);

/**
 * Discovered pools, append-only. The (chainId, poolAddress) key makes
 * duplicate log delivery and re-scans idempotent.
 */
export const pools = pgTable(
  "pools",
  {
    chainId: integer("chain_id").notNull(),
    poolAddress: text("pool_address").notNull(),
    factoryAddress: text("factory_address").notNull(),
    dex: text("dex").notNull(),
    /** "uniswap-v2" | "uniswap-v3" — mirrors chain FactoryKind. */
    factoryKind: text("factory_kind").notNull(),
    token0Address: text("token0_address").notNull(),
    token1Address: text("token1_address").notNull(),
    /** V3 fee tier in hundredths of a bip; null for V2. */
    feePpm: integer("fee_ppm"),
    /** V3 tick spacing; null for V2. */
    tickSpacing: integer("tick_spacing"),
    /** Allow-listed side at discovery time; null when neither side is trusted. */
    quoteTokenAddress: text("quote_token_address"),
    baseTokenAddress: text("base_token_address"),
    createdAtBlock: bigint("created_at_block", { mode: "bigint" }).notNull(),
    createdTxHash: text("created_tx_hash").notNull(),
    createdLogIndex: integer("created_log_index").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.poolAddress] })
  })
);

/**
 * Periodic market snapshots for trusted-quote pools. Append-only: rows are
 * never updated or deleted; history is the product.
 *
 * USD values are WAD-scaled decimals persisted as numeric(60,18) strings.
 * Null value + `nullReason` means "could not be computed", which is
 * deliberately distinct from zero.
 */
export const poolSnapshots = pgTable(
  "pool_snapshots",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    poolAddress: text("pool_address").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** "v2-reserves" | "v3-slot0" */
    calculationMethod: text("calculation_method").notNull(),
    /** USD price of the base token. */
    priceUsd: numeric("price_usd", { precision: 60, scale: 18 }),
    /** priceUsd x reported total supply. */
    estimatedFdvUsd: numeric("estimated_fdv_usd", { precision: 60, scale: 18 }),
    /** USD value of the trusted quote side only. */
    quoteLiquidityUsd: numeric("quote_liquidity_usd", {
      precision: 60,
      scale: 18
    }),
    /** Approximate combined USD value of both sides. */
    totalLiquidityUsd: numeric("total_liquidity_usd", {
      precision: 60,
      scale: 18
    }),
    /** WETH/USDG pool that anchored the USD conversion, when one was used. */
    anchorPoolAddress: text("anchor_pool_address"),
    /** Why value columns are null: "zero-liquidity" | "no-usd-anchor" | ... */
    nullReason: text("null_reason")
  },
  (table) => ({
    poolIdx: index("pool_snapshots_pool_idx").on(
      table.chainId,
      table.poolAddress,
      table.capturedAt
    ),
    /**
     * Serves the latest-snapshot-per-pool correlated max(id) in the
     * band-lane pool selection (repositories.ts); without it that lookup
     * scans each pool's full snapshot history (10+ min at prod scale).
     */
    latestIdx: index("pool_snapshots_latest_idx").on(
      table.chainId,
      table.poolAddress,
      table.id
    )
  })
);

/**
 * Normalized swap logs for trusted-quote pools. Append-only and idempotent on
 * the canonical log identity so rescans and duplicate RPC delivery are safe.
 *
 * `token0AmountRaw` and `token1AmountRaw` are signed pool deltas as decimal
 * strings: positive means the token entered the pool, negative means it left.
 * `baseAmountRaw` and `quoteAmountRaw` are absolute traded amounts used by
 * rolling activity aggregation.
 */
export const poolSwapEvents = pgTable(
  "pool_swap_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    poolAddress: text("pool_address").notNull(),
    factoryKind: text("factory_kind").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    transactionHash: text("transaction_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    sender: text("sender").notNull(),
    recipient: text("recipient").notNull(),
    token0AmountRaw: numeric("token0_amount_raw", {
      precision: 78,
      scale: 0
    }).notNull(),
    token1AmountRaw: numeric("token1_amount_raw", {
      precision: 78,
      scale: 0
    }).notNull(),
    baseAmountRaw: numeric("base_amount_raw", {
      precision: 78,
      scale: 0
    }).notNull(),
    quoteAmountRaw: numeric("quote_amount_raw", {
      precision: 78,
      scale: 0
    }).notNull(),
    /** "BUY" | "SELL" | "UNKNOWN" */
    side: text("side").notNull(),
    quoteTokenAddress: text("quote_token_address").notNull(),
    baseTokenAddress: text("base_token_address").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => ({
    logUid: uniqueIndex("pool_swap_events_log_uid").on(
      table.chainId,
      table.transactionHash,
      table.logIndex
    ),
    poolObservedIdx: index("pool_swap_events_pool_observed_idx").on(
      table.chainId,
      table.poolAddress,
      table.observedAt
    )
  })
);

/**
 * Rolling activity measurements derived from stored swap events. Append-only:
 * snapshots are never updated in place because historical context matters.
 */
export const poolActivitySnapshots = pgTable(
  "pool_activity_snapshots",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    poolAddress: text("pool_address").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    uniqueBuyers20m: integer("unique_buyers_20m").notNull(),
    uniqueBuyers1h: integer("unique_buyers_1h").notNull(),
    buyCount20m: integer("buy_count_20m").notNull(),
    sellCount20m: integer("sell_count_20m").notNull(),
    quoteBuyVolumeRaw20m: numeric("quote_buy_volume_raw_20m", {
      precision: 78,
      scale: 0
    }).notNull(),
    quoteSellVolumeRaw20m: numeric("quote_sell_volume_raw_20m", {
      precision: 78,
      scale: 0
    }).notNull(),
    quoteBuyVolumeRaw1h: numeric("quote_buy_volume_raw_1h", {
      precision: 78,
      scale: 0
    }).notNull(),
    quoteSellVolumeRaw1h: numeric("quote_sell_volume_raw_1h", {
      precision: 78,
      scale: 0
    }).notNull(),
    /** Gini coefficient over per-buyer 1h quote spend, bps. 0/1 buyers -> null. */
    buySizeGiniBps: integer("buy_size_gini_bps"),
    /** Shannon entropy of per-buyer spend shares / log(buyerCount), bps. */
    buySizeEntropyBps: integer("buy_size_entropy_bps"),
    /** Share of 1h BUY events with an exact-duplicate quote size, bps. */
    repeatedSizeBuyPctBps: integer("repeated_size_buy_pct_bps")
  },
  (table) => ({
    poolIdx: index("pool_activity_snapshots_pool_idx").on(
      table.chainId,
      table.poolAddress,
      table.capturedAt
    ),
    /**
     * Serves freshness-cutoff scans (cohort percentiles): the table is
     * append-only and grows without bound, but "live" reads only ever want
     * the most recent minutes.
     */
    timeIdx: index("pool_activity_snapshots_time_idx").on(
      table.chainId,
      table.capturedAt
    )
  })
);

/**
 * One privileged-permission finding for a token. `state` is deliberately
 * nuanced (never a bare boolean): absence of evidence is not evidence of
 * safety. `matchedSelectors` records the bytecode evidence behind PRESENT.
 */
export interface PermissionFindingRecord {
  readonly kind: string;
  readonly state:
    | "PRESENT"
    | "ABSENT"
    | "UNKNOWN"
    | "NOT_APPLICABLE"
    | "ANALYSIS_FAILED";
  readonly matchedSelectors: readonly string[];
}

/**
 * Append-only contract-safety + tradeability results for trusted-quote tokens.
 *
 * Never updated in place: each assessment is a new row keyed by block, so a
 * later re-check preserves the prior verdict. `status` is the distinct
 * top-level risk classification; UNKNOWN/ERROR are never equivalent to PASS.
 * STALE is applied by the reader when a row is too old, not stored here.
 */
export const tokenRisks = pgTable(
  "token_risks",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    /** Trusted-quote pool whose route the tradeability sim used. */
    poolAddress: text("pool_address").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    assessedAt: timestamp("assessed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** "PASS" | "FAIL" | "UNKNOWN" | "ERROR" */
    status: text("status").notNull(),
    /** "VERIFIED" | "UNVERIFIED" | "UNKNOWN" */
    verificationStatus: text("verification_status").notNull(),
    isProxy: boolean("is_proxy"),
    implementationAddress: text("implementation_address"),
    permissionFindings: jsonb("permission_findings")
      .$type<PermissionFindingRecord[]>()
      .notNull(),
    /** "PASS" | "FAIL" | "UNKNOWN" */
    simulationStatus: text("simulation_status").notNull(),
    effectiveBuyLossBps: integer("effective_buy_loss_bps"),
    effectiveSellLossBps: integer("effective_sell_loss_bps"),
    riskReasons: jsonb("risk_reasons").$type<string[]>().notNull(),
    positiveReasons: jsonb("positive_reasons").$type<string[]>().notNull(),
    /** Why the verdict lacked data, distinct from a clean result. */
    nullReason: text("null_reason")
  },
  (table) => ({
    tokenIdx: index("token_risks_token_idx").on(
      table.chainId,
      table.tokenAddress,
      table.assessedAt
    ),
    poolIdx: index("token_risks_pool_idx").on(
      table.chainId,
      table.poolAddress,
      table.assessedAt
    )
  })
);

/**
 * One probed sell-side notional and its round-trip loss, from the risk
 * engine's slippage curve. `lossBps` is null when the leg reverted.
 */
export interface SlippagePoint {
  readonly notionalUsd: string;
  readonly lossBps: number | null;
}

/**
 * Append-only buy/transfer/sell route simulations. Every row records the route
 * and block it ran against so a verdict is always reproducible; raw token
 * amounts stay integer strings, never floats.
 */
export const tradeSimulations = pgTable(
  "trade_simulations",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    poolAddress: text("pool_address").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    simulatedAt: timestamp("simulated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Route used, e.g. "uniswap-v2" | "uniswap-v3". */
    route: text("route").notNull(),
    /** "PASS" | "FAIL" | "UNKNOWN" per leg. */
    buyStatus: text("buy_status").notNull(),
    transferStatus: text("transfer_status").notNull(),
    sellStatus: text("sell_status").notNull(),
    buyQuoteInRaw: numeric("buy_quote_in_raw", { precision: 78, scale: 0 }),
    buyBaseOutRaw: numeric("buy_base_out_raw", { precision: 78, scale: 0 }),
    spotBaseOutRaw: numeric("spot_base_out_raw", { precision: 78, scale: 0 }),
    sellBaseInRaw: numeric("sell_base_in_raw", { precision: 78, scale: 0 }),
    sellQuoteOutRaw: numeric("sell_quote_out_raw", { precision: 78, scale: 0 }),
    spotQuoteOutRaw: numeric("spot_quote_out_raw", { precision: 78, scale: 0 }),
    effectiveBuyLossBps: integer("effective_buy_loss_bps"),
    effectiveSellLossBps: integer("effective_sell_loss_bps"),
    /** Round-trip probe loss in bps per notional; null leg means a revert. */
    slippageCurve: jsonb("slippage_curve").$type<SlippagePoint[]>(),
    revertReason: text("revert_reason"),
    /** "PASS" | "FAIL" | "UNKNOWN" overall for this simulation. */
    status: text("status").notNull()
  },
  (table) => ({
    tokenIdx: index("trade_simulations_token_idx").on(
      table.chainId,
      table.tokenAddress,
      table.simulatedAt
    )
  })
);

/** One excluded (non-economic) holder and why it was excluded. */
export interface HolderExclusionRecord {
  readonly address: string;
  readonly reason: string;
}

/** Latest known balance per holder for a token. Upserted, not append-only. */
export const tokenHolders = pgTable(
  "token_holders",
  {
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    holderAddress: text("holder_address").notNull(),
    balanceRaw: numeric("balance_raw", { precision: 78, scale: 0 }).notNull(),
    updatedBlock: bigint("updated_block", { mode: "bigint" }).notNull()
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.chainId, table.tokenAddress, table.holderAddress]
    })
  })
);

/**
 * Append-only holder-distribution snapshot. Concentration is stored in basis
 * points (integer, exact) rather than float percentages. "Adjusted" values
 * exclude non-economic holders (pool, zero, burn, lockers).
 */
export const tokenHolderSnapshots = pgTable(
  "token_holder_snapshots",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    holderCount: integer("holder_count").notNull(),
    adjustedHolderCount: integer("adjusted_holder_count").notNull(),
    largestHolderPctBps: integer("largest_holder_pct_bps").notNull(),
    top10PctBps: integer("top10_pct_bps").notNull(),
    adjustedTop10PctBps: integer("adjusted_top10_pct_bps").notNull(),
    /** Null when the deployer is unresolved or itself a non-economic holder. */
    deployerPctBps: integer("deployer_pct_bps"),
    /** 0-10000 clustering risk score; null when not computed. */
    holderClusterScoreBps: integer("holder_cluster_score_bps"),
    /**
     * (totalSupply - excluded balances - deployer) / totalSupply, bps.
     * Ceiling estimate when the deployer is unresolved (deployer term
     * omitted). Null when totalSupply is 0.
     */
    floatBps: integer("float_bps"),
    /** poolBalance / totalSupply, bps. */
    supplyInPoolBps: integer("supply_in_pool_bps"),
    excluded: jsonb("excluded").$type<HolderExclusionRecord[]>().notNull()
  },
  (table) => ({
    tokenIdx: index("token_holder_snapshots_token_idx").on(
      table.chainId,
      table.tokenAddress,
      table.capturedAt
    )
  })
);

/**
 * Append-only eligibility decisions. `failedRules` are machine keys, `reasons`
 * are human-readable, and `features` preserves the exact input vector so the
 * decision is fully explainable after the fact.
 */
export const tokenEligibilityResults = pgTable(
  "token_eligibility_results",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    poolAddress: text("pool_address").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    eligible: boolean("eligible").notNull(),
    failedRules: jsonb("failed_rules").$type<string[]>().notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull(),
    features: jsonb("features").notNull()
  },
  (table) => ({
    tokenIdx: index("token_eligibility_results_token_idx").on(
      table.chainId,
      table.tokenAddress,
      table.evaluatedAt
    )
  })
);

/** Append-only opportunity scores with explainable components. */
export const tokenScoreResults = pgTable(
  "token_score_results",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    poolAddress: text("pool_address").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    scoredAt: timestamp("scored_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    eligible: boolean("eligible").notNull(),
    score: integer("score").notNull(),
    components: jsonb("components").notNull(),
    /** "GRAY" | "RED" | "YELLOW" | "GREEN" (stoplight; see migration 0014) */
    alertLevel: text("alert_level").notNull(),
    positiveReasons: jsonb("positive_reasons").$type<string[]>().notNull(),
    riskReasons: jsonb("risk_reasons").$type<string[]>().notNull()
  },
  (table) => ({
    tokenIdx: index("token_score_results_token_idx").on(
      table.chainId,
      table.tokenAddress,
      table.scoredAt
    )
  })
);

/** Append-only record of emitted alerts, for delivery audit and dedup. */
export const alertsSent = pgTable(
  "alerts_sent",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    poolAddress: text("pool_address").notNull(),
    /** "RED" | "YELLOW" | "GREEN" (stoplight; see migration 0014) */
    alertLevel: text("alert_level").notNull(),
    score: integer("score").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Why this alert was emitted (level increase, cooldown, etc.). */
    reason: text("reason").notNull(),
    /** "telegram" | "dry-run" */
    transport: text("transport").notNull(),
    delivered: boolean("delivered").notNull()
  },
  (table) => ({
    tokenIdx: index("alerts_sent_token_idx").on(
      table.chainId,
      table.tokenAddress,
      table.sentAt
    )
  })
);

/**
 * Survival label for a (pool, horizon) pair, computed once observed history
 * reaches the horizon. Append-once: an existing (chainId, poolAddress,
 * horizonHours) row is never relabeled — `details` preserves the exact
 * inputs behind the verdict.
 */
export const tokenOutcomes = pgTable(
  "token_outcomes",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    poolAddress: text("pool_address").notNull(),
    horizonHours: integer("horizon_hours").notNull(),
    /** "SURVIVED" | "DIED" */
    outcome: text("outcome").notNull(),
    peakQuoteLiquidityUsd: numeric("peak_quote_liquidity_usd", {
      precision: 60,
      scale: 18
    }),
    quoteLiquidityAtHorizonUsd: numeric("quote_liquidity_at_horizon_usd", {
      precision: 60,
      scale: 18
    }),
    estimatedFdvAtHorizonUsd: numeric("estimated_fdv_at_horizon_usd", {
      precision: 60,
      scale: 18
    }),
    firstObservedAt: timestamp("first_observed_at", {
      withTimezone: true
    }).notNull(),
    labeledAt: timestamp("labeled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Free-form explanation inputs (peak/at-horizon values, thresholds used). */
    details: jsonb("details").notNull()
  },
  (table) => ({
    poolHorizonUid: uniqueIndex("token_outcomes_pool_horizon_uid").on(
      table.chainId,
      table.poolAddress,
      table.horizonHours
    )
  })
);

/**
 * Manual operator trade decisions, append-only. Recorded via `decide.ts`
 * regardless of whether the system alerted — the feedback report joins this
 * against `alerts_sent` and `token_outcomes` to find where the system and
 * the operator disagreed.
 */
export const operatorDecisions = pgTable(
  "operator_decisions",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    poolAddress: text("pool_address"),
    /** "ENTERED" | "PASSED" | "WATCHING" | "EXITED" */
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    sizeUsd: numeric("size_usd", { precision: 60, scale: 18 }),
    priceUsd: numeric("price_usd", { precision: 60, scale: 18 }),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => ({
    tokenIdx: index("operator_decisions_token_idx").on(
      table.chainId,
      table.tokenAddress,
      table.recordedAt
    )
  })
);

/**
 * Population-wide realized-performance label for a (pool, horizon) pair,
 * computed once the entry-to-horizon window has fully elapsed. Deliberately
 * NOT gated on alerts, eligibility, or scores — every pool whose observed
 * snapshot history crossed into the configured FDV band qualifies, so
 * thresholds can be calibrated against the full population. Append-once: an
 * existing (chainId, poolAddress, horizonHours) row is never relabeled —
 * `entryFeatures` and `details` preserve the exact inputs behind the verdict.
 */
export const tokenPerformance = pgTable(
  "token_performance",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    poolAddress: text("pool_address").notNull(),
    horizonHours: integer("horizon_hours").notNull(),
    bandMinFdvUsd: numeric("band_min_fdv_usd", {
      precision: 60,
      scale: 18
    }).notNull(),
    bandMaxFdvUsd: numeric("band_max_fdv_usd", {
      precision: 60,
      scale: 18
    }).notNull(),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
    entryBlock: bigint("entry_block", { mode: "bigint" }).notNull(),
    entryPriceUsd: numeric("entry_price_usd", {
      precision: 60,
      scale: 18
    }).notNull(),
    entryFdvUsd: numeric("entry_fdv_usd", {
      precision: 60,
      scale: 18
    }).notNull(),
    maxMultipleBps: integer("max_multiple_bps").notNull(),
    maxDrawdownBps: integer("max_drawdown_bps").notNull(),
    minutesToPeak: integer("minutes_to_peak").notNull(),
    snapshotsInWindow: integer("snapshots_in_window").notNull(),
    entryFeatures: jsonb("entry_features").notNull(),
    labeledAt: timestamp("labeled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    details: jsonb("details").notNull()
  },
  (table) => ({
    poolHorizonUid: uniqueIndex("token_performance_pool_horizon_uid").on(
      table.chainId,
      table.poolAddress,
      table.horizonHours
    )
  })
);

/**
 * Telegram chats subscribed to launch alerts, self-service via bot
 * membership. `chatId` is stored as text — Telegram chat ids exceed
 * 2^53 and would lose precision as a JS number. `status` is
 * "ACTIVE" | "PENDING" | "REMOVED": PENDING only exists when a join code is
 * configured and the chat hasn't confirmed yet; REMOVED means the bot was
 * kicked or left. `addedAt` is preserved across re-adds; `updatedAt` bumps
 * on every status change.
 */
export const telegramSubscriptions = pgTable("telegram_subscriptions", {
  chatId: text("chat_id").primaryKey(),
  title: text("title"),
  status: text("status").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
});

/**
 * Restart-safe cursor for the single Telegram `getUpdates` consumer.
 * Singleton row, `id` is always 1.
 */
export const telegramCursor = pgTable("telegram_cursor", {
  id: integer("id").primaryKey(),
  lastUpdateId: bigint("last_update_id", { mode: "bigint" }).notNull()
});

/**
 * Versioned, content-hashed prompt templates for the judgment layer. A
 * template edit always lands as a new (name, version) row — eval reports are
 * sliced by prompt version, so a silent in-place edit would corrupt every
 * comparison. `templateHash` guards against drift between code and registry.
 */
export const promptRegistry = pgTable(
  "prompt_registry",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    templateHash: text("template_hash").notNull(),
    template: text("template").notNull(),
    changelog: text("changelog").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => ({
    nameVersionUid: uniqueIndex("prompt_registry_name_version_uid").on(
      table.name,
      table.version
    )
  })
);

/**
 * One advisory LLM research brief per alert (LIVE) or per replayed historical
 * band entry (REPLAY). Append-once: a brief is inserted only with its final
 * status — a crash mid-generation simply re-attempts on the next pass, and
 * the unique alert id makes that idempotent. `alertId` is null for REPLAY
 * rows, which instead carry `evalRunId`. The judgment layer is advisory
 * only: rows here never influence eligibility, scoring, or alert levels.
 */
export const judgmentBriefs = pgTable(
  "judgment_briefs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    poolAddress: text("pool_address").notNull(),
    /** "LIVE" | "REPLAY" */
    mode: text("mode").notNull(),
    /** alerts_sent.id; null for REPLAY briefs. */
    alertId: bigint("alert_id", { mode: "bigint" }),
    /** judgment_eval_runs.id; null for LIVE briefs. */
    evalRunId: bigint("eval_run_id", { mode: "bigint" }),
    /** Evidence-bundle freeze time; nothing after this instant was visible. */
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    promptName: text("prompt_name").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    templateHash: text("template_hash").notNull(),
    model: text("model").notNull(),
    /** "COMPLETED" | "FAILED" | "REJECTED_FABRICATED_CITATION" */
    status: text("status").notNull(),
    thesis: text("thesis"),
    confidenceBps: integer("confidence_bps"),
    /** "RESEARCH" | "WATCH" | "PASS" — advisory only. */
    recommendation: text("recommendation"),
    /** RiskCall[] including evidence pointers. */
    riskCalls: jsonb("risk_calls"),
    disconfirming: jsonb("disconfirming"),
    whatWouldChange: jsonb("what_would_change"),
    citationsTotal: integer("citations_total"),
    citationsVerified: integer("citations_verified"),
    /** "SENT" | "SEND_FAILED" | "SKIPPED" — follow-up message delivery. */
    delivery: text("delivery"),
    costUsd: numeric("cost_usd", { precision: 20, scale: 8 }),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    latencyMs: integer("latency_ms"),
    /** Failure detail for FAILED / REJECTED rows. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => ({
    alertUid: uniqueIndex("judgment_briefs_alert_uid").on(table.alertId),
    tokenIdx: index("judgment_briefs_token_idx").on(
      table.chainId,
      table.tokenAddress,
      table.createdAt
    ),
    evalRunIdx: index("judgment_briefs_eval_run_idx").on(table.evalRunId)
  })
);

/**
 * Replayable audit trace of every history-tool call a brief made. Tool
 * arguments are addresses/numerics/enums only — never attacker-controlled
 * strings — and `resultRowIds` + `resultDigest` make a rerun against the
 * same append-only history byte-comparable.
 */
export const judgmentToolCalls = pgTable(
  "judgment_tool_calls",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    briefId: bigint("brief_id", { mode: "bigint" }).notNull(),
    seq: integer("seq").notNull(),
    toolName: text("tool_name").notNull(),
    args: jsonb("args").notNull(),
    resultRowIds: jsonb("result_row_ids"),
    resultDigest: text("result_digest"),
    /** Full result body the LLM received; citation source for replays. */
    result: jsonb("result"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => ({
    briefSeqUid: uniqueIndex("judgment_tool_calls_brief_seq_uid").on(
      table.briefId,
      table.seq
    )
  })
);

/**
 * Machine-checked evidence citations, one row per claim pointer. `verified`
 * false with `actualValue` preserved is the fabrication audit trail — the
 * fabrication rate must be queryable forever, including for rejected briefs.
 */
export const judgmentCitations = pgTable(
  "judgment_citations",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    briefId: bigint("brief_id", { mode: "bigint" }).notNull(),
    /** Which brief clause cited this (e.g. "riskCalls[0]", "thesis"). */
    claimKey: text("claim_key").notNull(),
    /** Whitelisted append-only table name. */
    citedTable: text("cited_table").notNull(),
    citedRowId: bigint("cited_row_id", { mode: "bigint" }).notNull(),
    citedField: text("cited_field").notNull(),
    claimedValue: text("claimed_value").notNull(),
    verified: boolean("verified").notNull(),
    /** The row's real value when verification failed; null when verified. */
    actualValue: text("actual_value"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => ({
    briefIdx: index("judgment_citations_brief_idx").on(table.briefId)
  })
);

/**
 * One frozen judge-evaluation run: a prompt version replayed over a fixed
 * historical period. `report` stores the full scored output (Brier,
 * calibration, per-risk precision/recall) so a published number is always
 * reproducible from its run row.
 */
export const judgmentEvalRuns = pgTable(
  "judgment_eval_runs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    promptName: text("prompt_name").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    horizonHours: integer("horizon_hours").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    briefsTotal: integer("briefs_total").notNull(),
    report: jsonb("report").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => ({
    promptIdx: index("judgment_eval_runs_prompt_idx").on(
      table.promptName,
      table.promptVersion
    )
  })
);

/**
 * Per-brief scoring detail inside an eval run: the realized label the brief
 * was judged against and its derived scores. Append-only with the run.
 */
export const judgmentEvalItems = pgTable(
  "judgment_eval_items",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    runId: bigint("run_id", { mode: "bigint" }).notNull(),
    briefId: bigint("brief_id", { mode: "bigint" }).notNull(),
    poolAddress: text("pool_address").notNull(),
    /** "RUGGED" | "BLED" | "HELD_BAND" | "RUNNER" */
    realizedLabel: text("realized_label").notNull(),
    realizedMaxMultipleBps: integer("realized_max_multiple_bps").notNull(),
    /** Implied P(positive outcome) in bps, derived from the brief. */
    predictedHitBps: integer("predicted_hit_bps").notNull(),
    realizedHit: boolean("realized_hit").notNull(),
    /** Brier contribution in micro-units (1e6 = 1.0), integer-exact. */
    brierMicro: integer("brier_micro").notNull(),
    /** Per-risk-tag realization detail. */
    riskMatches: jsonb("risk_matches").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => ({
    runBriefUid: uniqueIndex("judgment_eval_items_run_brief_uid").on(
      table.runId,
      table.briefId
    )
  })
);

/**
 * Winners-retro leak-attribution result for one realized big winner
 * (band-crosser whose `token_performance.maxMultipleBps` cleared the wick
 * bar and whose pure-function sustained refinement held the bar too).
 * Append-once: an existing (chainId, poolAddress, horizonHours) row is
 * never relabeled or re-attributed — winners-retro is a hypothesis
 * generator, not a live optimizer, so its verdicts must stay stable once
 * emitted (a restart re-running the same pass must never double-count or
 * flip a prior attribution). `coverageTier`/`tierLabel` are the first
 * pipeline stage (lowest tier number wins) that failed to surface the
 * winner, per the 7-tier ladder (T1 never discovered .. T7 caught).
 * `gateAttribution` carries the machine-stable + human-readable inputs
 * behind that call:
 *   { source: "shadow" | "replay" | "none",
 *     eligible: boolean | null, failedRules: string[],
 *     softFailedRules: string[], score: number | null,
 *     alertLevel: string | null, floor: number }
 * "shadow" means it came from the logged token_eligibility_results /
 * token_score_results rows nearest entry; "replay" means those rows were
 * missing and evaluateEligibility/scoreOpportunity were re-run over the
 * stored entryFeatures; "none" means neither was possible (T4). `provisional`
 * mirrors the 24h horizon's `token_performance` label — always true for
 * horizonHours = 24 until the 72h/168h refinements land.
 */
export const winnerRetroItems = pgTable(
  "winner_retro_items",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    poolAddress: text("pool_address").notNull(),
    horizonHours: integer("horizon_hours").notNull(),
    entryAt: timestamp("entry_at", { withTimezone: true }).notNull(),
    entryFdvUsd: numeric("entry_fdv_usd", {
      precision: 60,
      scale: 18
    }).notNull(),
    wickMultipleBps: integer("wick_multiple_bps").notNull(),
    sustainedMultipleBps: integer("sustained_multiple_bps").notNull(),
    exitQuoteLiquidityUsd: numeric("exit_quote_liquidity_usd", {
      precision: 60,
      scale: 18
    }),
    minutesToSustainedPeak: integer("minutes_to_sustained_peak"),
    provisional: boolean("provisional").notNull(),
    coverageTier: integer("coverage_tier").notNull(),
    tierLabel: text("tier_label").notNull(),
    alerted: boolean("alerted").notNull(),
    gateAttribution: jsonb("gate_attribution").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => ({
    poolHorizonUid: uniqueIndex("winner_retro_items_pool_horizon_uid").on(
      table.chainId,
      table.poolAddress,
      table.horizonHours
    )
  })
);
