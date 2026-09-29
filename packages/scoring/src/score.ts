import { parseUsdNumber } from "./numeric.js";
import {
  DEFAULT_SIGNAL_CONFIG,
  type CandidateFeatures,
  type EligibilityResult,
  type ScoreComponents,
  type ScoreResult,
  type SignalConfig,
  type SlippagePoint
} from "./types.js";

interface ComponentResult {
  readonly points: number;
  readonly positive: string[];
  readonly risk: string[];
}

/**
 * Data-grounded scale (2026-07-20, docs/scoring-model.md "Change log"):
 *
 * - Four components, each built ONLY from features that are both
 *   well-covered and discriminating at entry in the labeled
 *   `token_performance` population (horizon 72h, $10k-$100k band, N=9,260):
 *   liquidityDepth 35, buyerBreadth 25, buyFlow 20, lowCapTilt 20.
 * - Holder, ownership, deployer-history, sim, and buy-shape signals are
 *   under 35% covered on fresh launches (see
 *   docs/reweight-preregistration-2026-07.md); they carry ZERO points and
 *   surface only as advisory positive/risk reasons.
 * - Nulls in the buyer/flow features score 0, never a penalty: ~30-50% of
 *   rows lack them at entry, and penalizing a coverage gap would re-create
 *   the trap where the gate rejected candidates for missing data.
 */

/**
 * Parse a raw integer string strictly. Malformed input returns null, never
 * a silent 0n, which would let a corrupted sell-volume read as bullish
 * "net inflow" downstream.
 */
function parseRawBigint(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Liquidity depth (0-35): trusted quote-side depth (0-20), quote/FDV ratio
 * (0-8), and the sell-slippage curve (0-7). Total (token-side-inclusive)
 * liquidity is deliberately NOT scored: the token side is valued by the
 * token's own price, so it is trivially inflatable; the quote side is what
 * an exit actually realizes. Among ≥10x winners the median quote liquidity
 * at entry was $5.8k vs a loser median in the dust range.
 */
function scoreLiquidityDepth(
  features: CandidateFeatures,
  config: SignalConfig
): ComponentResult {
  const positive: string[] = [];
  const risk: string[] = [];
  let points = 0;

  // Quote depth (0-20), tiered above the $2.5k eligibility floor.
  const quote = parseUsdNumber(features.quoteLiquidityUsd);
  if (quote === null) {
    risk.push("Quote liquidity is unavailable");
  } else if (quote >= 30_000) {
    points += 20;
    positive.push("Deep quote-side liquidity");
  } else if (quote >= 20_000) {
    points += 16;
    positive.push("Deep quote-side liquidity");
  } else if (quote >= 10_000) {
    points += 10;
    positive.push("Healthy quote-side liquidity");
  } else if (quote >= 5_000) {
    points += 6;
  } else if (quote >= 2_500) {
    points += 2;
  } else if (quote > 0) {
    risk.push("Quote liquidity is thin for the band");
  } else {
    risk.push("Quote liquidity is effectively zero");
  }

  // Quote-liquidity/FDV ratio (0-8): exit depth relative to valuation.
  const fdv = parseUsdNumber(features.estimatedFdvUsd);
  if (quote !== null && fdv !== null && fdv > 0) {
    const ratioBps = Math.floor((quote / fdv) * 10_000);
    if (ratioBps >= 2_000) {
      points += 8;
      positive.push("Quote liquidity-to-FDV ratio above 20%");
    } else if (ratioBps >= 1_500) {
      points += 6;
      positive.push("Quote liquidity-to-FDV ratio above 15%");
    } else if (ratioBps >= 1_000) {
      points += 4;
    } else if (ratioBps >= 500) {
      points += 2;
    } else {
      risk.push("Quote liquidity is thin relative to FDV");
    }
  }

  // Sell-slippage curve (0-7, penalty down to -5).
  const curve = scoreSellSlippageCurve(features.sellSlippageCurve, config);
  points += curve.points;
  positive.push(...curve.positive);
  risk.push(...curve.risk);

  return { points: Math.max(0, Math.min(points, 35)), positive, risk };
}

/**
 * Sell-slippage curve contribution to liquidityDepth: reward a flat,
 * bounded curve across probed notionals and penalize steep growth between
 * them (a widening loss with size is an early tell of thin real depth).
 */
function scoreSellSlippageCurve(
  curve: readonly SlippagePoint[] | null,
  config: SignalConfig
): ComponentResult {
  const positive: string[] = [];
  const risk: string[] = [];
  let points = 0;

  if (curve === null || curve.length === 0) {
    return { points, positive, risk };
  }

  const knownLosses = curve
    .map((point) => point.lossBps)
    .filter((loss): loss is number => loss !== null);

  if (knownLosses.length < curve.length) {
    risk.push("Sell-slippage curve includes a reverted probe at a larger size");
  }
  if (knownLosses.length === 0) {
    return { points, positive, risk };
  }

  const maxLoss = Math.max(...knownLosses);
  if (maxLoss <= config.slippageCurveFlatMaxBps) {
    points += config.slippageCurveFlatBonusPoints;
    positive.push("Sell-slippage stays flat and bounded across probed sizes");
  }

  if (knownLosses.length > 1) {
    const growth = knownLosses[knownLosses.length - 1]! - knownLosses[0]!;
    if (growth >= config.slippageCurveSteepGrowthBps) {
      points -= config.slippageCurveSteepPenaltyPoints;
      risk.push("Sell-slippage grows steeply as probe size increases");
    }
  }

  return { points, positive, risk };
}

/**
 * Buyer breadth (0-25): unique buyers over 1h (0-15) and 20m (0-10).
 * The [15,30) 1h bucket carried a 17.4% ≥10x rate vs the 1.7% base; buckets
 * above and below both discriminate. A missing/zero window earns 0 points,
 * never a penalty (~30-50% of rows lack activity data at entry).
 */
function scoreBuyerBreadth(
  features: CandidateFeatures,
  config: SignalConfig
): ComponentResult {
  const positive: string[] = [];
  const risk: string[] = [];
  let points = 0;

  const buyers1h = features.uniqueBuyers1h;
  if (buyers1h >= config.buyers1hStrongThreshold) {
    points += 15;
    positive.push("Strong unique-buyer count over the last hour");
  } else if (buyers1h >= config.buyers1hHighThreshold) {
    points += 13;
    positive.push("Solid unique-buyer count over the last hour");
  } else if (buyers1h >= config.buyers1hModerateThreshold) {
    points += 8;
  } else if (buyers1h >= 1) {
    points += 3;
  } else {
    risk.push("No unique buyers in the last hour");
  }

  const buyers20m = features.uniqueBuyers20m;
  if (buyers20m >= config.buyers20mHighThreshold) {
    points += 10;
    positive.push("Broad fresh buyer participation in the last 20 minutes");
  } else if (buyers20m >= config.buyers20mModerateThreshold) {
    points += 6;
  } else if (buyers20m >= 1) {
    points += 3;
  }

  return { points: Math.max(0, Math.min(points, 25)), positive, risk };
}

/**
 * Buy flow (0-20): the 20m buy/(sell+1) count ratio (0-15) plus a strict
 * net-quote-inflow bonus (+5). The ratio's ≥3 bucket carried a 33.8% ≥10x
 * rate among quote-liquidity survivors, the strongest single lift measured.
 *
 * Flow points require the 20m window to clear `flowFloorMinBuys20m` AND
 * `flowFloorMinUniqueBuyers20m`: a handful of dust buys, or one wallet
 * hammering the pool, must not read as organic inflow. Volume parsing is
 * strict: a malformed volume string withholds the inflow bonus rather than
 * reading as 0n.
 */
function scoreBuyFlow(
  features: CandidateFeatures,
  config: SignalConfig
): ComponentResult {
  const positive: string[] = [];
  const risk: string[] = [];
  let points = 0;

  const flowHasSubstance =
    features.buyCount20m >= config.flowFloorMinBuys20m &&
    features.uniqueBuyers20m >= config.flowFloorMinUniqueBuyers20m;

  if (flowHasSubstance) {
    const ratio = features.buyCount20m / (features.sellCount20m + 1);
    if (ratio >= config.buyFlowRatioStrong) {
      points += 15;
      positive.push("Buys strongly outpace sells");
    } else if (ratio >= config.buyFlowRatioHigh) {
      points += 10;
      positive.push("Buys outpace sells");
    } else if (ratio >= config.buyFlowRatioPositive) {
      points += 6;
    } else {
      risk.push("Sells outpace buys");
    }

    const buyVol = parseRawBigint(features.quoteBuyVolumeRaw20m);
    const sellVol = parseRawBigint(features.quoteSellVolumeRaw20m);
    if (buyVol === null || sellVol === null) {
      risk.push("Quote flow volumes are unreadable; net-inflow bonus withheld");
    } else if (buyVol > sellVol) {
      points += 5;
      positive.push("Positive net quote inflow");
    } else if (sellVol > buyVol) {
      risk.push("Net quote outflow over the last 20 minutes");
    }
  } else if (features.buyCount20m > 0 || features.sellCount20m > 0) {
    risk.push("Recent 20m flow is too thin to score (dust guard)");
  }

  return { points: Math.max(0, Math.min(points, 20)), positive, risk };
}

/**
 * Low-cap tilt (0-20): entry-FDV zone tilt toward the measured 10x sweet
 * spot. ≥10x rate by entry FDV among quote-liquidity survivors:
 * $15-40k → 8-10%, $40-60k → 5.5%, $10-15k → 3.7%, $60-100k → 5.6%.
 * The tilt targets the 10x product goal specifically; for any-2x the lift
 * is monotone upward in FDV.
 */
function scoreLowCapTilt(
  features: CandidateFeatures,
  config: SignalConfig
): ComponentResult {
  const positive: string[] = [];
  const risk: string[] = [];

  const fdv = parseUsdNumber(features.estimatedFdvUsd);
  if (fdv === null) {
    risk.push("Estimated FDV is unavailable");
    return { points: 0, positive, risk };
  }

  let points = 0;
  if (fdv >= config.lowCapSweetMinUsd && fdv <= config.lowCapSweetMaxUsd) {
    points = 20;
    positive.push("Entry FDV is in the measured 10x sweet spot");
  } else if (fdv > config.lowCapSweetMaxUsd && fdv <= config.lowCapMidMaxUsd) {
    points = 12;
  } else if (fdv >= config.lowCapDustMinUsd && fdv < config.lowCapSweetMinUsd) {
    points = 10;
  } else if (fdv > config.lowCapMidMaxUsd && fdv <= config.lowCapBandMaxUsd) {
    points = 6;
  }

  return { points, positive, risk };
}

/**
 * Advisory reasons (0 points, always): fold the unscored safety, ownership,
 * deployer, holder, and buy-shape values into positive/risk reasons so the
 * record stays explainable. These signals are under 35% covered at entry
 * (docs/reweight-preregistration-2026-07.md), so they must not move the
 * score, but when present they are exactly what the operator researches.
 */
function advisoryReasons(
  features: CandidateFeatures,
  config: SignalConfig
): ComponentResult {
  const positive: string[] = [];
  const risk: string[] = [];

  // Safety surfacing (GREEN separately requires affirmative sim PASS).
  if (features.simulationStatus === "PASS") {
    positive.push("Trade simulation passes through the real route");
  } else {
    risk.push(`Sell simulation is not confirmed (status ${features.simulationStatus})`);
  }
  if (features.criticalPermissionPresent) {
    risk.push("A critical privileged permission is present");
  }
  if (features.isProxy === true) {
    risk.push("Contract is a proxy; logic can change");
  }
  if (features.verificationStatus === "VERIFIED") {
    positive.push("Contract source is verified");
  } else if (features.verificationStatus === "UNVERIFIED") {
    risk.push("Contract source is not verified");
  }

  // Ownership/deployer surfacing (computed and shown, never scored).
  const deployer = features.deployerPctBps;
  if (deployer !== null) {
    if (deployer > 800) {
      risk.push(`Deployer holds a large share (${deployer} bps of supply)`);
    } else if (deployer <= 100) {
      positive.push("Deployer holds a negligible share");
    }
  }
  const top10 = features.adjustedTop10PctBps;
  if (top10 !== null) {
    if (top10 >= 6_000) {
      risk.push(`Adjusted top-10 ownership is highly concentrated (${top10} bps)`);
    } else if (top10 < 2_000) {
      positive.push("Adjusted top-10 ownership is well distributed");
    }
  }
  const largest = features.largestHolderPctBps;
  if (largest !== null && largest >= 3_000) {
    risk.push(`A single holder controls a large share (${largest} bps)`);
  }
  const holderCount = features.adjustedHolderCount ?? features.holderCount;
  if (holderCount !== null && holderCount > 0) {
    positive.push(`Adjusted holder count is ${holderCount}`);
  }

  // Buy-shape signatures (wash-trading tells).
  const gini = features.buySizeGiniBps;
  if (gini !== null && gini >= config.buySizeGiniHighBps) {
    risk.push(`Buy sizes are highly concentrated in one buyer (Gini ${gini} bps)`);
  }
  const entropy = features.buySizeEntropyBps;
  if (entropy !== null && entropy <= config.buySizeEntropyLowBps) {
    risk.push(`Buy-size entropy is low (${entropy} bps of max)`);
  }
  const repeatedSize = features.repeatedSizeBuyPctBps;
  if (repeatedSize !== null && repeatedSize >= config.repeatedSizeBuyHighPctBps) {
    risk.push(
      `A large share of buys repeat an identical quote size (${repeatedSize} bps)`
    );
  }

  return { points: 0, positive, risk };
}

/**
 * Produce the 0-100 opportunity score with its four explainable components
 * (liquidityDepth 35, buyerBreadth 25, buyFlow 20, lowCapTilt 20).
 *
 * The score is a pure function of the feature vector and is INDEPENDENT of
 * eligibility: a high score never overrides an eligibility failure and an
 * eligibility failure never lowers the number. Eligibility is folded in only
 * as an explanatory risk reason so the record stays self-describing.
 */
export function scoreOpportunity(
  features: CandidateFeatures,
  eligibility: EligibilityResult,
  config: SignalConfig = DEFAULT_SIGNAL_CONFIG
): ScoreResult {
  const parts = {
    liquidityDepth: scoreLiquidityDepth(features, config),
    buyerBreadth: scoreBuyerBreadth(features, config),
    buyFlow: scoreBuyFlow(features, config),
    lowCapTilt: scoreLowCapTilt(features, config)
  };

  const components: ScoreComponents = {
    liquidityDepth: parts.liquidityDepth.points,
    buyerBreadth: parts.buyerBreadth.points,
    buyFlow: parts.buyFlow.points,
    lowCapTilt: parts.lowCapTilt.points
  };

  const advisory = advisoryReasons(features, config);

  const positiveReasons: string[] = [];
  const riskReasons: string[] = [];
  for (const part of [...Object.values(parts), advisory]) {
    for (const reason of part.positive) positiveReasons.push(reason);
    for (const reason of part.risk) riskReasons.push(reason);
  }

  // Invalidation events are categorical, not scored, and don't always flow
  // through eligibility (simulationRegressed never gates it); surface them
  // explicitly here so a caller reading ScoreResult alone still sees why
  // classifyAlertLevel forces GRAY.
  if (features.liquidityCollapsed === true) {
    riskReasons.push("Liquidity has collapsed from its observed peak (invalidated)");
  }
  if (features.simulationRegressed === true) {
    riskReasons.push("Trade simulation regressed from a prior PASS to FAIL (invalidated)");
  }

  if (!eligibility.eligible && eligibility.failedRules.length > 0) {
    riskReasons.push(
      `Not eligible: ${eligibility.failedRules.join(", ")}`
    );
  }

  const total =
    components.liquidityDepth +
    components.buyerBreadth +
    components.buyFlow +
    components.lowCapTilt;

  const score = Math.max(0, Math.min(100, total));

  return { score, components, positiveReasons, riskReasons };
}
