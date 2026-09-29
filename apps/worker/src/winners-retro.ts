/**
 * Winners-retro v1, Slice B — pure logic only, no DB imports.
 *
 * Everything here is a deterministic function of its inputs: sustained-peak
 * computation from a snapshot series, coverage-tier attribution from a
 * first-failing-stage ladder, a defensive inverse of the jsonb feature
 * write-side transform, and Telegram-HTML digest rendering. Main's runner
 * (DB reads, shadow/replay assembly, persistence) composes these; keeping
 * them free of DB imports means every branch here is unit-testable with
 * plain fixtures, no real-postgres harness required.
 */

import { escapeHtml } from "@assay/alerts";
import type {
  CandidateFeatures,
  RiskStatus,
  SimulationStatus,
  VerificationStatus
} from "@assay/scoring";

import type { PerformanceEntryFeatures } from "./performance-pass.js";

// ---------------------------------------------------------------------------
// computeSustained
// ---------------------------------------------------------------------------

export interface SnapshotPoint {
  readonly capturedAt: Date;
  readonly estimatedFdvUsd: string | null;
  readonly quoteLiquidityUsd: string | null;
}

export interface SustainedResult {
  readonly sustainedMultipleBps: number;
  readonly wickMultipleBps: number;
  readonly exitQuoteLiquidityUsd: string | null;
  readonly minutesToSustainedPeak: number | null;
}

const BUCKET_MS = 15 * 60 * 1000;
/** A bucket needs a second reading to confirm the level held for the bucket's span, not just an instant. */
const MIN_SNAPSHOTS_PER_VALID_BUCKET = 2;

type ValuedSnapshotPoint = SnapshotPoint & { readonly estimatedFdvUsd: string };

/**
 * `wickMultipleBps` (the stored `token_performance.maxMultipleBps`) is the
 * single highest FDV reading ever observed — exactly what a wash-traded pump
 * looks like: one manufactured print, then gone. It is cheap for an adversary
 * to fake a single high tick (one self-trade) but expensive to hold a price
 * level for a full 15-minute window across >=2 independent enrichment
 * reads. So "sustained" buckets `points` from `entryAt` into 15-minute
 * windows, only trusts a window as evidence of a REAL level once it has
 * >=2 snapshots, and takes the bucket's `min` (not max) FDV — the worst
 * reading within the window still has to clear the bar. The sustained peak
 * is the highest such confirmed bucket value; a lone wick that never repeats
 * within its window contributes nothing. Exit liquidity is read off the
 * LAST snapshot in the peak bucket (closest to "if you tried to sell at the
 * sustained level, this is what was there"), and `minutesToSustainedPeak`
 * dates from that same snapshot — both null when no bucket is ever
 * confirmed, since there is nothing to report a peak moment for.
 */
export function computeSustained(
  points: readonly SnapshotPoint[],
  entryAt: Date,
  entryFdvUsd: string,
  wickMultipleBps: number
): SustainedResult {
  const entryFdv = Number(entryFdvUsd);
  const entryMs = entryAt.getTime();

  // A null-FDV snapshot (enrichment miss) confirms nothing — it neither
  // counts toward a bucket's >=2 threshold nor can it set the bucket min.
  const valued = points.filter(
    (point): point is ValuedSnapshotPoint =>
      point.estimatedFdvUsd !== null && point.capturedAt.getTime() >= entryMs
  );

  const buckets = new Map<number, ValuedSnapshotPoint[]>();
  for (const point of valued) {
    const index = Math.floor((point.capturedAt.getTime() - entryMs) / BUCKET_MS);
    const bucket = buckets.get(index);
    if (bucket === undefined) buckets.set(index, [point]);
    else bucket.push(point);
  }

  let sustainedPeakFdv: number | null = null;
  let peakBucket: ValuedSnapshotPoint[] | null = null;
  for (const bucket of buckets.values()) {
    if (bucket.length < MIN_SNAPSHOTS_PER_VALID_BUCKET) continue; // wick, not sustained
    const bucketValue = Math.min(...bucket.map((point) => Number(point.estimatedFdvUsd)));
    if (sustainedPeakFdv === null || bucketValue > sustainedPeakFdv) {
      sustainedPeakFdv = bucketValue;
      peakBucket = bucket;
    }
  }

  if (sustainedPeakFdv === null || peakBucket === null) {
    // No 15-minute window ever held >=2 valued readings: nothing here is
    // confirmed above a single-tick wick. Report zero sustained gain rather
    // than trust the unconfirmed wick multiple — this is the "T3 enriched
    // too late" signal at the source.
    return {
      sustainedMultipleBps: 0,
      wickMultipleBps,
      exitQuoteLiquidityUsd: null,
      minutesToSustainedPeak: null
    };
  }

  const sustainedMultipleBps = Math.floor((sustainedPeakFdv / entryFdv) * 10_000);
  const exitSnapshot = peakBucket.reduce((latest, point) =>
    point.capturedAt.getTime() > latest.capturedAt.getTime() ? point : latest
  );

  return {
    sustainedMultipleBps,
    wickMultipleBps,
    exitQuoteLiquidityUsd: exitSnapshot.quoteLiquidityUsd,
    minutesToSustainedPeak: Math.round((exitSnapshot.capturedAt.getTime() - entryMs) / 60_000)
  };
}

// ---------------------------------------------------------------------------
// attributeCoverageTier
// ---------------------------------------------------------------------------

export interface GateAttribution {
  readonly source: "shadow" | "replay" | "none";
  readonly eligible: boolean | null;
  readonly failedRules: readonly string[];
  readonly softFailedRules: readonly string[];
  readonly score: number | null;
  readonly alertLevel: string | null;
  readonly floor: number;
}

export interface TierInputs {
  readonly trustedQuote: boolean;
  readonly hadSnapshots: boolean;
  readonly attribution: GateAttribution;
  readonly alerted: boolean;
}

/** Canonical tier -> human label, shared by attribution and digest rendering. */
export const TIER_LABELS: Readonly<Record<number, string>> = {
  1: "undiscovered",
  2: "no-trusted-quote",
  3: "enriched-late",
  4: "signals-missing",
  5: "hard-gated",
  6: "below-floor",
  7: "caught"
};

/** Terminal rung of the ladder: an alerts_sent row exists, nothing upstream leaked. */
export const CAUGHT_TIER = 7;

/**
 * First-failing-stage ladder: walk the pipeline in the order a candidate
 * actually passes through it (discovery -> quote trust -> enrichment
 * timing -> signal availability -> hard gate -> score floor -> delivery),
 * and stop at the first stage that would have hidden this winner. T1 (never
 * discovered) is unreachable from here — every input is a `token_performance`
 * row, which by definition WAS discovered — but the label stays in the
 * ladder for completeness (census/reporting code keys off the same map).
 */
export function attributeCoverageTier(inputs: TierInputs): { tier: number; label: string } {
  if (!inputs.trustedQuote) return { tier: 2, label: TIER_LABELS[2]! };
  if (!inputs.hadSnapshots) return { tier: 3, label: TIER_LABELS[3]! };

  const { attribution } = inputs;
  if (attribution.source === "none") return { tier: 4, label: TIER_LABELS[4]! };
  if (attribution.eligible === false) return { tier: 5, label: TIER_LABELS[5]! };

  const belowFloor =
    attribution.eligible === true &&
    ((attribution.score !== null && attribution.score < attribution.floor) ||
      attribution.alertLevel === "GRAY");
  if (belowFloor) return { tier: 6, label: TIER_LABELS[6]! };

  // Every earlier gate cleared. `alerted` corroborates but does not gate
  // this branch — a pipeline that cleared T2..T6 should always have
  // alerted; if it somehow did not, there is no further rung to attribute
  // to, so this stays the ladder's terminal bucket.
  return { tier: CAUGHT_TIER, label: TIER_LABELS[CAUGHT_TIER]! };
}

// ---------------------------------------------------------------------------
// parseEntryFeatures / replayCandidateFeatures
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringOrNull(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNumberOrNull(record: Record<string, unknown>, key: string): number | null | undefined {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBooleanOrNull(record: Record<string, unknown>, key: string): boolean | null | undefined {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "boolean" ? value : undefined;
}

function readEnumOrNull<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: Readonly<Record<string, true>>
): T | null | undefined {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "string" && allowed[value] === true ? (value as T) : undefined;
}

const RISK_STATUSES: Readonly<Record<string, true>> = {
  PASS: true,
  FAIL: true,
  UNKNOWN: true,
  ERROR: true,
  STALE: true
};
const SIMULATION_STATUSES: Readonly<Record<string, true>> = { PASS: true, FAIL: true, UNKNOWN: true };
const VERIFICATION_STATUSES: Readonly<Record<string, true>> = {
  VERIFIED: true,
  UNVERIFIED: true,
  UNKNOWN: true
};

/**
 * Strict read-side inverse of `buildEntryFeatures` (performance-pass.ts) over
 * `token_performance.entryFeatures`. jsonb content is a hostile boundary
 * (schema drift, manual edits): EVERY key of `PerformanceEntryFeatures` must
 * be present with the right type or the whole parse returns `null` — never
 * replay eligibility/scoring over a vector with silently-defaulted gate
 * inputs. Rows written before the shape carried gate inputs (risk
 * permissions, 20m activity, holder detail) fail here by design and stay
 * tier 4: we cannot know, e.g., `criticalPermissionPresent` for them, and
 * guessing `false` could mint a "caught"/"below-floor" verdict for a token
 * the live gate would have refused.
 */
export function parseEntryFeatures(raw: unknown): PerformanceEntryFeatures | null {
  if (!isRecord(raw)) return null;

  const quoteLiquidityUsd = readStringOrNull(raw, "quoteLiquidityUsd");
  const totalLiquidityUsd = readStringOrNull(raw, "totalLiquidityUsd");
  const ageMinutesAtEntry = readNumber(raw, "ageMinutesAtEntry");

  const uniqueBuyers20m = readNumberOrNull(raw, "uniqueBuyers20m");
  const uniqueBuyers1h = readNumberOrNull(raw, "uniqueBuyers1h");
  const buyCount20m = readNumberOrNull(raw, "buyCount20m");
  const sellCount20m = readNumberOrNull(raw, "sellCount20m");
  const quoteBuyVolumeRaw20m = readStringOrNull(raw, "quoteBuyVolumeRaw20m");
  const quoteSellVolumeRaw20m = readStringOrNull(raw, "quoteSellVolumeRaw20m");
  const buySizeGiniBps = readNumberOrNull(raw, "buySizeGiniBps");
  const buySizeEntropyBps = readNumberOrNull(raw, "buySizeEntropyBps");
  const repeatedSizeBuyPctBps = readNumberOrNull(raw, "repeatedSizeBuyPctBps");

  const floatBps = readNumberOrNull(raw, "floatBps");
  const supplyInPoolBps = readNumberOrNull(raw, "supplyInPoolBps");
  const adjustedTop10PctBps = readNumberOrNull(raw, "adjustedTop10PctBps");
  const deployerPctBps = readNumberOrNull(raw, "deployerPctBps");
  const holderCount = readNumberOrNull(raw, "holderCount");
  const adjustedHolderCount = readNumberOrNull(raw, "adjustedHolderCount");
  const largestHolderPctBps = readNumberOrNull(raw, "largestHolderPctBps");
  const holderClusterScoreBps = readNumberOrNull(raw, "holderClusterScoreBps");

  const riskStatus = readEnumOrNull<RiskStatus>(raw, "riskStatus", RISK_STATUSES);
  const simulationStatus = readEnumOrNull<SimulationStatus>(
    raw,
    "simulationStatus",
    SIMULATION_STATUSES
  );
  const effectiveSellLossBps = readNumberOrNull(raw, "effectiveSellLossBps");
  const criticalPermissionPresent = readBooleanOrNull(raw, "criticalPermissionPresent");
  const isProxy = readBooleanOrNull(raw, "isProxy");
  const verificationStatus = readEnumOrNull<VerificationStatus>(
    raw,
    "verificationStatus",
    VERIFICATION_STATUSES
  );

  if (
    quoteLiquidityUsd === undefined ||
    totalLiquidityUsd === undefined ||
    ageMinutesAtEntry === undefined ||
    uniqueBuyers20m === undefined ||
    uniqueBuyers1h === undefined ||
    buyCount20m === undefined ||
    sellCount20m === undefined ||
    quoteBuyVolumeRaw20m === undefined ||
    quoteSellVolumeRaw20m === undefined ||
    buySizeGiniBps === undefined ||
    buySizeEntropyBps === undefined ||
    repeatedSizeBuyPctBps === undefined ||
    floatBps === undefined ||
    supplyInPoolBps === undefined ||
    adjustedTop10PctBps === undefined ||
    deployerPctBps === undefined ||
    holderCount === undefined ||
    adjustedHolderCount === undefined ||
    largestHolderPctBps === undefined ||
    holderClusterScoreBps === undefined ||
    riskStatus === undefined ||
    simulationStatus === undefined ||
    effectiveSellLossBps === undefined ||
    criticalPermissionPresent === undefined ||
    isProxy === undefined ||
    verificationStatus === undefined
  ) {
    return null;
  }

  return {
    quoteLiquidityUsd,
    totalLiquidityUsd,
    ageMinutesAtEntry,
    uniqueBuyers20m,
    uniqueBuyers1h,
    buyCount20m,
    sellCount20m,
    quoteBuyVolumeRaw20m,
    quoteSellVolumeRaw20m,
    buySizeGiniBps,
    buySizeEntropyBps,
    repeatedSizeBuyPctBps,
    floatBps,
    supplyInPoolBps,
    adjustedTop10PctBps,
    deployerPctBps,
    holderCount,
    adjustedHolderCount,
    largestHolderPctBps,
    holderClusterScoreBps,
    riskStatus,
    simulationStatus,
    effectiveSellLossBps,
    criticalPermissionPresent,
    isProxy,
    verificationStatus
  };
}

/** Identity + entry-snapshot fields the replay takes from the `token_performance` row itself. */
export interface ReplayEntryIdentity {
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly poolAddress: string;
  readonly entryBlock: bigint;
  readonly enteredAt: Date;
  readonly entryPriceUsd: string | null;
  readonly entryFdvUsd: string | null;
}

/**
 * Assemble the CandidateFeatures the eligibility/score/alert-level trio
 * would have seen at band entry, from a `token_performance` row and its
 * parsed entry features. Missing-source defaults mirror `assembleCandidate`
 * (candidate.ts) exactly — no activity row means 0 buyers/hasActivity false,
 * no risk row means UNKNOWN statuses — so a replayed gate decision matches
 * what the live pipeline would have decided in that state. Fields the
 * retro cannot honestly reconstruct as-of entry (liquidity trajectory,
 * slippage curve, deployer provenance, retention, cohort percentiles) are
 * null: all are nullable score-side signals, so their absence lowers the
 * replayed score conservatively and never flips a hard gate.
 */
export function replayCandidateFeatures(
  identity: ReplayEntryIdentity,
  entry: PerformanceEntryFeatures
): CandidateFeatures {
  return {
    chainId: identity.chainId,
    tokenAddress: identity.tokenAddress,
    poolAddress: identity.poolAddress,
    blockNumber: identity.entryBlock,
    capturedAt: identity.enteredAt,
    tokenAgeMinutes: entry.ageMinutesAtEntry,

    priceUsd: identity.entryPriceUsd,
    estimatedFdvUsd: identity.entryFdvUsd,
    quoteLiquidityUsd: entry.quoteLiquidityUsd,
    totalLiquidityUsd: entry.totalLiquidityUsd,

    uniqueBuyers20m: entry.uniqueBuyers20m ?? 0,
    uniqueBuyers1h: entry.uniqueBuyers1h ?? 0,
    buyCount20m: entry.buyCount20m ?? 0,
    sellCount20m: entry.sellCount20m ?? 0,
    quoteBuyVolumeRaw20m: entry.quoteBuyVolumeRaw20m ?? "0",
    quoteSellVolumeRaw20m: entry.quoteSellVolumeRaw20m ?? "0",
    hasActivity: entry.uniqueBuyers1h !== null,

    riskStatus: entry.riskStatus ?? "UNKNOWN",
    simulationStatus: entry.simulationStatus ?? "UNKNOWN",
    effectiveSellLossBps: entry.effectiveSellLossBps,
    criticalPermissionPresent: entry.criticalPermissionPresent ?? false,
    isProxy: entry.isProxy,
    verificationStatus: entry.verificationStatus ?? "UNKNOWN",
    hasRisk: entry.riskStatus !== null,

    holderCount: entry.holderCount,
    adjustedHolderCount: entry.adjustedHolderCount,
    largestHolderPctBps: entry.largestHolderPctBps,
    adjustedTop10PctBps: entry.adjustedTop10PctBps,
    deployerPctBps: entry.deployerPctBps,
    holderClusterScoreBps: entry.holderClusterScoreBps,

    peakQuoteLiquidityUsd: null,
    liquidityDrawdownBps: null,
    minutesAbove80PctPeakLiquidity: null,
    liquidityCollapsed: null,

    sellSlippageCurve: null,
    simulationRegressed: null,

    floatBps: entry.floatBps,
    supplyInPoolBps: entry.supplyInPoolBps,

    deployerTokenCount: null,
    deployerPriorSurvived: null,
    deployerPriorDied: null,

    buySizeGiniBps: entry.buySizeGiniBps,
    buySizeEntropyBps: entry.buySizeEntropyBps,
    repeatedSizeBuyPctBps: entry.repeatedSizeBuyPctBps,

    earlyBuyerRetentionBps: null,

    cohortSize: null,
    cohortBuyerPercentileBps: null,
    cohortNetInflowPercentileBps: null
  };
}

// ---------------------------------------------------------------------------
// formatWinnersDigest
// ---------------------------------------------------------------------------

export interface DigestItem {
  readonly tokenAddress: string;
  readonly tokenSymbol: string | null;
  readonly sustainedMultipleBps: number;
  readonly exitQuoteLiquidityUsd: string | null;
  readonly tier: number;
  readonly tierLabel: string;
  readonly detail: string;
  readonly provisional: boolean;
}

/** Untrusted on-chain symbol first (escaped), always followed by the permanent tap-to-copy address. */
function formatItemIdentity(item: DigestItem): string {
  const address = `<code>${item.tokenAddress}</code>`;
  const symbol = item.tokenSymbol?.trim();
  if (symbol === undefined || symbol === "") return address;
  return `${escapeHtml(symbol)} ${address}`;
}

function formatDigestItemLine(item: DigestItem): string {
  const identity = formatItemIdentity(item);
  // bps/10_000 -> multiplier-x, one decimal (10_000 bps convention == 1x, per performance-pass).
  const multiple = (item.sustainedMultipleBps / 10_000).toFixed(1);
  const provisionalTag = item.provisional ? " (provisional)" : "";
  const outcome =
    item.tier === CAUGHT_TIER
      ? "CAUGHT"
      : `LEAKED T${item.tier} ${escapeHtml(item.tierLabel)}: ${escapeHtml(item.detail)}`;
  return `• ${identity} ${multiple}x — ${outcome}${provisionalTag}`;
}

/**
 * Renders the event-driven digest sent only when a pass detects NEW winners
 * (the append-once table dedupes forever, so this never fires twice for the
 * same item). Every dynamic string passes through `escapeHtml` per Telegram
 * HTML parse-mode's requirement (token symbols/details are attacker-
 * controlled on-chain or gate-rule text); addresses render in `<code>` for
 * tap-to-copy. Deterministic given `args` — no clock reads, no randomness.
 */
export function formatWinnersDigest(args: {
  date: Date;
  items: readonly DigestItem[];
  untrustedPoolCount: number;
  tierTotals: ReadonlyMap<number, number>;
}): string {
  const { date, items, untrustedPoolCount, tierTotals } = args;
  const dateLabel = date.toISOString().slice(0, 10);

  const lines: string[] = [];
  lines.push(`📊 Winners retro — ${dateLabel} (n=${items.length} new; provisional 24h)`);
  lines.push("");

  if (items.length === 0) {
    lines.push("No new winners this pass.");
  } else {
    for (const item of items) lines.push(formatDigestItemLine(item));
  }
  lines.push("");

  lines.push(
    `👻 ${untrustedPoolCount} pools launched without a trusted quote (unvaluable, invisible)`
  );
  lines.push("");

  lines.push("Tier totals:");
  const sortedTiers = [...tierTotals.entries()].sort(([a], [b]) => a - b);
  if (sortedTiers.length === 0) {
    lines.push("(none)");
  } else {
    for (const [tier, count] of sortedTiers) {
      lines.push(`T${tier} ${escapeHtml(TIER_LABELS[tier] ?? "unknown")}: ${count}`);
    }
  }
  lines.push("");

  lines.push(`n=${items.length} small — anecdotes, not signal.`);
  return lines.join("\n");
}
