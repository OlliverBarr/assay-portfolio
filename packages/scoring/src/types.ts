/**
 * Shared candidate/eligibility/score contract for the MVP alert pipeline.
 *
 * `CandidateFeatures` is the single normalized input vector assembled by the
 * worker from the latest enrichment snapshot, activity snapshot, risk verdict,
 * and holder snapshot. Eligibility, scoring, and alerting all consume it.
 * Fields that a not-yet-implemented signal cannot provide are explicitly
 * nullable — a null is "unknown", never silently treated as safe/passing.
 */

export type RiskStatus = "PASS" | "FAIL" | "UNKNOWN" | "ERROR" | "STALE";
export type SimulationStatus = "PASS" | "FAIL" | "UNKNOWN";
export type VerificationStatus = "VERIFIED" | "UNVERIFIED" | "UNKNOWN";
/**
 * Alert tiers, stoplight semantics (renamed 2026-07-11; was
 * GRAY/YELLOW/ORANGE/RED):
 *
 * - GRAY   — stored only, no light (out of band, invalidated, or enrichment
 *            incomplete).
 * - RED    — stop: seen and tracked, too early to act (early watch; was
 *            YELLOW).
 * - YELLOW — caution: eligible research candidate (was ORANGE).
 * - GREEN  — go: high-priority manual review in the target zone (was RED).
 *
 * Ordinal escalation: GRAY < RED < YELLOW < GREEN. Historical DB rows were
 * relabeled in migration 0014_stoplight_levels — one vocabulary everywhere.
 */
export type AlertLevel = "GRAY" | "RED" | "YELLOW" | "GREEN";

/** One probed exit size on the sell-slippage curve. */
export interface SlippagePoint {
  /** Quote notional probed, USD decimal string. */
  readonly notionalUsd: string;
  /** Round-trip loss at this notional, bps; null when the leg reverted. */
  readonly lossBps: number | null;
}

export interface CandidateFeatures {
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly poolAddress: string;
  readonly blockNumber: bigint;
  readonly capturedAt: Date;
  /** Minutes since pool creation. */
  readonly tokenAgeMinutes: number;

  // --- Enrichment (USD as decimal strings; null when uncomputable) ---
  readonly priceUsd: string | null;
  readonly estimatedFdvUsd: string | null;
  readonly quoteLiquidityUsd: string | null;
  readonly totalLiquidityUsd: string | null;

  // --- Activity (raw quote volumes as integer strings) ---
  readonly uniqueBuyers20m: number;
  readonly uniqueBuyers1h: number;
  readonly buyCount20m: number;
  readonly sellCount20m: number;
  readonly quoteBuyVolumeRaw20m: string;
  readonly quoteSellVolumeRaw20m: string;
  /** True when at least one activity snapshot existed to read. */
  readonly hasActivity: boolean;

  // --- Risk ---
  readonly riskStatus: RiskStatus;
  readonly simulationStatus: SimulationStatus;
  readonly effectiveSellLossBps: number | null;
  readonly criticalPermissionPresent: boolean;
  readonly isProxy: boolean | null;
  readonly verificationStatus: VerificationStatus;
  /** True when a risk verdict existed to read. */
  readonly hasRisk: boolean;

  // --- Holders (null until the holders milestone provides them) ---
  readonly holderCount: number | null;
  readonly adjustedHolderCount: number | null;
  readonly largestHolderPctBps: number | null;
  readonly adjustedTop10PctBps: number | null;
  readonly deployerPctBps: number | null;
  readonly holderClusterScoreBps: number | null;

  // --- Liquidity trajectory (pool_snapshots series; forward from first observation) ---
  readonly peakQuoteLiquidityUsd: string | null;
  /** Drawdown of latest quote liquidity from observed peak; 0 = at peak. */
  readonly liquidityDrawdownBps: number | null;
  readonly minutesAbove80PctPeakLiquidity: number | null;
  /** True when latest quote liquidity fell below the collapse fraction of peak (LP pull). */
  readonly liquidityCollapsed: boolean | null;

  // --- Exit realism (trade_simulations) ---
  /** Round-trip loss probed at ascending quote notionals; null until simulated. */
  readonly sellSlippageCurve: readonly SlippagePoint[] | null;
  /** True when a prior simulation PASSed and the latest is FAIL (soft-rug-in-progress). */
  readonly simulationRegressed: boolean | null;

  // --- Supply structure (token_holder_snapshots) ---
  /** Tradeable share of total supply, bps (excludes non-economic holders + resolved deployer). */
  readonly floatBps: number | null;
  readonly supplyInPoolBps: number | null;

  // --- Deployer provenance (tokens self-join + token_outcomes) ---
  /** Other tokens deployed by the same resolved deployer on this chain. */
  readonly deployerTokenCount: number | null;
  readonly deployerPriorSurvived: number | null;
  readonly deployerPriorDied: number | null;

  // --- Buy-shape (1h window of BUY swaps, per-buyer quote spend) ---
  /** Gini of per-buyer spend: 0 = equal, 10000 = one buyer is all volume. */
  readonly buySizeGiniBps: number | null;
  /** Shannon entropy of per-buyer spend shares as share of max entropy, bps. */
  readonly buySizeEntropyBps: number | null;
  /** Share of 1h buys whose exact raw quote size appears at least twice, bps. */
  readonly repeatedSizeBuyPctBps: number | null;

  // --- Retention ---
  /** Share of first-window buyers still holding a nonzero balance, bps. */
  readonly earlyBuyerRetentionBps: number | null;

  // --- Cohort-relative (live pools of comparable age) ---
  readonly cohortSize: number | null;
  /** Share of cohort with uniqueBuyers1h <= this token's, bps. */
  readonly cohortBuyerPercentileBps: number | null;
  /** Share of cohort with 1h net quote inflow <= this token's, bps. */
  readonly cohortNetInflowPercentileBps: number | null;
}

export interface EligibilityResult {
  readonly eligible: boolean;
  /** Machine-stable keys of the HARD rules that failed (gate `eligible`). */
  readonly failedRules: string[];
  /**
   * Machine-stable keys of the QUALITY (advisory) rules that failed —
   * includes missing-data cases. Never gates `eligible`; the score
   * components already consume the same raw feature values directly.
   */
  readonly softFailedRules: readonly string[];
  /** Human-readable rejection/acceptance reasons; quality-rule entries are prefixed `quality: `. */
  readonly reasons: string[];
}

/**
 * The four explainable score components (out of 100 total).
 *
 * Rebuilt 2026-07-20 from the labeled `token_performance` population (see
 * docs/scoring-model.md "Change log"): only liquidity depth, buyer breadth,
 * 20m buy flow, and entry FDV are both well-covered (100% / ~50-68%) and
 * discriminating at entry. Holder, ownership, deployer, sim, and buy-shape
 * signals are under 35% covered on fresh launches and carry no score points;
 * they surface as advisory reasons and explicit-fail gates only.
 */
export interface ScoreComponents {
  readonly liquidityDepth: number; // 0-35
  readonly buyerBreadth: number; // 0-25
  readonly buyFlow: number; // 0-20
  readonly lowCapTilt: number; // 0-20
}

export interface ScoreResult {
  readonly score: number; // 0-100
  readonly components: ScoreComponents;
  readonly positiveReasons: string[];
  readonly riskReasons: string[];
}

/**
 * Tunable thresholds. Defaults come from AGENTS.md / docs/scoring-model.md and
 * MUST stay configurable (never hardcoded across the codebase).
 */
export interface EligibilityConfig {
  readonly minFdvUsd: number;
  readonly maxFdvUsd: number;
  readonly minTotalLiquidityUsd: number;
  readonly minQuoteLiquidityUsd: number;
  readonly minAgeMinutes: number;
  readonly minUniqueBuyers: number;
  readonly maxEffectiveSellLossBps: number;
  readonly maxDeployerPctBps: number;
  readonly maxAdjustedTop10PctBps: number;
}

// $10k–$100k focus band (2026-07-13, see docs/scoring-model.md change
// protocol). Liquidity/buyer floors scale with the band. minAgeMinutes is 0
// (2026-07-20): the old 20-minute floor excluded >50% of ≥10x winners
// (median age at entry 10 min); the key survives so an env override can
// reintroduce a small floor without a code change.
export const DEFAULT_ELIGIBILITY_CONFIG: EligibilityConfig = {
  minFdvUsd: 10_000,
  maxFdvUsd: 100_000,
  minTotalLiquidityUsd: 5_000,
  minQuoteLiquidityUsd: 2_500,
  minAgeMinutes: 0,
  minUniqueBuyers: 15,
  maxEffectiveSellLossBps: 800,
  maxDeployerPctBps: 800,
  maxAdjustedTop10PctBps: 4_500
};

export interface AlertThresholds {
  /**
   * RED (early watch) gates. `redMinLiquidityUsd` gates on QUOTE liquidity
   * (2026-07-20; previously total): quote depth is the dominant filter — the
   * token side is inflatable by the token's own price.
   */
  readonly redMinFdvUsd: number;
  readonly redMaxFdvUsd: number;
  readonly redMinLiquidityUsd: number;
  readonly redMinUniqueBuyers: number;
  /** YELLOW (research candidate) gates; liquidity is TOTAL liquidity. */
  readonly yellowMinFdvUsd: number;
  readonly yellowMaxFdvUsd: number;
  readonly yellowMinLiquidityUsd: number;
  readonly yellowMinScore: number;
  /** GREEN (go) gates. */
  readonly greenMinFdvUsd: number;
  readonly greenMaxFdvUsd: number;
  readonly greenMinScore: number;
  readonly greenMinUniqueBuyers: number;
  readonly greenMaxAdjustedTop10PctBps: number;
}

// Tier bands re-cut 2026-07-20 to the measured 10x zone: ≥10x rate by entry
// FDV peaks at $15–40k (8–10%) vs $40–100k (~5.5%). GREEN targets the sweet
// spot; YELLOW extends to $60k; RED watches the whole band on quote-liq.
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  redMinFdvUsd: 10_000,
  redMaxFdvUsd: 100_000,
  redMinLiquidityUsd: 2_500,
  redMinUniqueBuyers: 5,
  yellowMinFdvUsd: 15_000,
  yellowMaxFdvUsd: 60_000,
  yellowMinLiquidityUsd: 8_000,
  yellowMinScore: 65,
  greenMinFdvUsd: 15_000,
  greenMaxFdvUsd: 40_000,
  greenMinScore: 80,
  greenMinUniqueBuyers: 20,
  greenMaxAdjustedTop10PctBps: 4_000
};

/**
 * Tunables for the four score components plus the advisory buy-shape flags.
 * Deliberately kept separate from `EligibilityConfig`: none of these gate
 * eligibility (the sole exception, `liquidityCollapsed`, is a boolean
 * invalidation event with no threshold to tune) — they only shape score
 * components, advisory reasons, and the alert-level GRAY cap.
 */
export interface SignalConfig {
  /**
   * Mirrors the upstream collapse threshold (latest quote liquidity < this
   * fraction of peak → `liquidityCollapsed = true`). Scoring/eligibility
   * consume the precomputed boolean, not this fraction directly; it is kept
   * here so the threshold has one documented, discoverable default.
   */
  readonly liquidityCollapseFractionBps: number;

  // --- liquidityDepth (0-35): slippage-curve sub-score (0-7) ---
  readonly slippageCurveFlatMaxBps: number;
  readonly slippageCurveFlatBonusPoints: number;
  readonly slippageCurveSteepGrowthBps: number;
  readonly slippageCurveSteepPenaltyPoints: number;

  // --- buyerBreadth (0-25): uniqueBuyers1h tier (15/13/8, 3 for ≥1) +
  //     uniqueBuyers20m tier (10/6, 3 for ≥1). Null/zero → 0, never a penalty.
  readonly buyers1hStrongThreshold: number;
  readonly buyers1hHighThreshold: number;
  readonly buyers1hModerateThreshold: number;
  readonly buyers20mHighThreshold: number;
  readonly buyers20mModerateThreshold: number;

  // --- buyFlow (0-20): 20m buy/(sell+1) count-ratio tier (15/10/6) +
  //     net-quote-inflow bonus (+5), both dust-guarded. ---
  /**
   * Dust guard: 20m flow points (ratio and inflow bonus) are only awarded
   * when the window has at least this many buys AND this many unique
   * buyers. Below the floor the flow is real but too thin to mean
   * anything — a couple of wei-sized buys must not read as "net inflow".
   */
  readonly flowFloorMinBuys20m: number;
  readonly flowFloorMinUniqueBuyers20m: number;
  readonly buyFlowRatioStrong: number;
  readonly buyFlowRatioHigh: number;
  readonly buyFlowRatioPositive: number;

  // --- lowCapTilt (0-20): entry-FDV zone tilt toward the measured 10x
  //     sweet spot ($15–40k → 20, $40–60k → 12, $10–15k → 10, $60k–band max → 6).
  readonly lowCapDustMinUsd: number;
  readonly lowCapSweetMinUsd: number;
  readonly lowCapSweetMaxUsd: number;
  readonly lowCapMidMaxUsd: number;
  /** Mirrors the eligibility band max; above it the tilt is 0, not 6. */
  readonly lowCapBandMaxUsd: number;

  // --- Advisory buy-shape flags (unscored; <35% coverage at entry) ---
  readonly buySizeGiniHighBps: number;
  readonly buySizeEntropyLowBps: number;
  readonly repeatedSizeBuyHighPctBps: number;
}

export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  liquidityCollapseFractionBps: 2_000,

  slippageCurveFlatMaxBps: 300,
  slippageCurveFlatBonusPoints: 7,
  slippageCurveSteepGrowthBps: 500,
  slippageCurveSteepPenaltyPoints: 5,

  buyers1hStrongThreshold: 30,
  buyers1hHighThreshold: 15,
  buyers1hModerateThreshold: 5,
  buyers20mHighThreshold: 15,
  buyers20mModerateThreshold: 5,

  flowFloorMinBuys20m: 5,
  flowFloorMinUniqueBuyers20m: 5,
  buyFlowRatioStrong: 3,
  buyFlowRatioHigh: 1.5,
  buyFlowRatioPositive: 1,

  lowCapDustMinUsd: 10_000,
  lowCapSweetMinUsd: 15_000,
  lowCapSweetMaxUsd: 40_000,
  lowCapMidMaxUsd: 60_000,
  lowCapBandMaxUsd: 100_000,

  buySizeGiniHighBps: 7_000,
  buySizeEntropyLowBps: 3_000,
  repeatedSizeBuyHighPctBps: 4_000
};
