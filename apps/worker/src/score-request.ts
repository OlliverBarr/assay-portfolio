import {
  getTokensByAddresses,
  listTrustedQuotePoolsForToken,
  type Db,
  type PoolRow
} from "@assay/database";
import {
  classifyAlertLevel,
  evaluateEligibility,
  scoreOpportunity,
  type AlertThresholds,
  type CandidateFeatures,
  type EligibilityConfig,
  type EligibilityResult,
  type ScoreResult
} from "@assay/scoring";
import { LEVEL_GLYPH } from "@assay/alerts";

import {
  assembleCandidate,
  DEFAULT_CANDIDATE_SIGNAL_OPTIONS,
  type CandidateSignalOptions
} from "./candidate.js";

/** Exact EVM address; checksum is NOT enforced (lookups are case-insensitive). */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** `/score`, optionally `@botname`-suffixed, optionally followed by one argument. */
const SCORE_COMMAND_RE = /^\/score(?:@\S+)?(?:[ \t]+(.*))?$/i;

/** Caps on attacker-controlled metadata rendered into the header (mirrors @assay/alerts). */
const MAX_NAME_CHARS = 64;
const MAX_SYMBOL_CHARS = 16;
/** Reason caps, mirroring alert formatting. */
const MAX_POSITIVE_REASONS = 3;
const MAX_RISK_REASONS = 3;

export const SCORE_USAGE_TEXT =
  "Usage: /score 0x<token contract address>, or paste the token contract address as a message on its own.";
export const SCORE_FAILED_TEXT =
  "Scoring failed: the worker hit an internal error. Try again shortly.";

/**
 * An on-demand scoring request parsed from a chat message. `undefined` when
 * the message is not a score request at all; `kind: "usage"` when it is a
 * `/score` command with a missing or malformed address.
 */
export type ScoreRequest =
  | { readonly kind: "score"; readonly tokenAddress: string }
  | { readonly kind: "usage" };

export function parseScoreRequest(text: string): ScoreRequest | undefined {
  const trimmed = text.trim();
  if (ADDRESS_RE.test(trimmed)) {
    return { kind: "score", tokenAddress: trimmed.toLowerCase() };
  }
  const match = SCORE_COMMAND_RE.exec(trimmed);
  if (match === null) return undefined;
  const arg = (match[1] ?? "").trim();
  if (!ADDRESS_RE.test(arg)) return { kind: "usage" };
  return { kind: "score", tokenAddress: arg.toLowerCase() };
}

export interface ScorecardOptions {
  readonly db: Db;
  readonly chainId: number;
  readonly eligibilityConfig: EligibilityConfig;
  readonly alertThresholds: AlertThresholds;
  /** Tunables for the derived candidate signals; defaults apply when unset. */
  readonly signals?: CandidateSignalOptions;
  readonly now?: () => Date;
}

interface ScoredCandidate {
  readonly pool: PoolRow;
  readonly features: CandidateFeatures;
  readonly eligibility: EligibilityResult;
  readonly score: ScoreResult;
}

/** Coarse human-facing USD render; never money movement (mirrors @assay/alerts). */
function formatUsd(value: string | null): string {
  if (value === null) return "unknown";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "unknown";
  return `$${Math.round(parsed).toLocaleString("en-US")}`;
}

/** Whole minutes → "34m" / "5.2h" / "3.1d". */
function formatAge(minutes: number): string {
  if (minutes < 90) return `${Math.max(0, Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/** Basis points → "32.5%"; null reads as "unknown". */
function formatBps(value: number | null): string {
  if (value === null) return "unknown";
  return `${(value / 100).toFixed(1)}%`;
}

/**
 * `Name (SYMBOL)` from untrusted on-chain metadata, length-capped. Plain
 * text (the subscriptions transport sends no parse_mode), so there is no
 * markup to escape; falls back to the token address when both are missing.
 */
function identity(
  name: string | null,
  symbol: string | null,
  tokenAddress: string
): string {
  const cappedName = name?.trim().slice(0, MAX_NAME_CHARS) ?? "";
  const cappedSymbol = symbol?.trim().slice(0, MAX_SYMBOL_CHARS) ?? "";
  if (cappedName === "" && cappedSymbol === "") return tokenAddress;
  if (cappedName === "") return cappedSymbol;
  if (cappedSymbol === "") return cappedName;
  return `${cappedName} (${cappedSymbol})`;
}

/**
 * Build the on-demand scorecard reply for one pasted token address.
 *
 * Reads ONLY persisted signals: the same `assembleCandidate` →
 * `evaluateEligibility` → `scoreOpportunity` → `classifyAlertLevel` path the
 * live scoring pass runs, with no FDV band gate so out-of-band tokens still
 * render (as GRAY) instead of vanishing. Never touches RPC: a chat message
 * must not be able to spend chain credits, and staleness is surfaced
 * honestly via the snapshot-age line instead of hidden behind a refresh.
 *
 * When the token has several trusted-quote pools, every pool (bounded by the
 * query limit) is assembled and the highest-scoring one renders.
 */
export async function buildScorecard(
  options: ScorecardOptions,
  tokenAddress: string
): Promise<string> {
  const { db, chainId } = options;
  const now = options.now ?? (() => new Date());
  const signals = options.signals ?? DEFAULT_CANDIDATE_SIGNAL_OPTIONS;

  const pools = await listTrustedQuotePoolsForToken(db, chainId, tokenAddress);
  if (pools.length === 0) {
    return (
      `No trusted-quote pool found for ${tokenAddress}.\n` +
      "Either the token has not launched against an allow-listed quote " +
      "asset, or discovery has not ingested it yet."
    );
  }

  const requestedAt = now();
  let best: ScoredCandidate | undefined;
  for (const pool of pools) {
    const features = await assembleCandidate(db, pool, requestedAt, signals);
    if (features === null) continue;
    const eligibility = evaluateEligibility(features, options.eligibilityConfig);
    const score = scoreOpportunity(features, eligibility);
    if (best === undefined || score.score > best.score.score) {
      best = { pool, features, eligibility, score };
    }
  }
  if (best === undefined) {
    return (
      `Token ${tokenAddress} is discovered (${pools.length} trusted-quote ` +
      `pool${pools.length === 1 ? "" : "s"}) but has no market snapshot ` +
      "yet; enrichment has not priced it. Try again in a few minutes."
    );
  }

  const { features, eligibility, score } = best;
  const level = classifyAlertLevel(
    features,
    eligibility,
    score,
    options.alertThresholds
  );
  const [tokenRow] = await getTokensByAddresses(db, chainId, [
    features.tokenAddress
  ]);

  const lines: string[] = [];
  lines.push(
    `${LEVEL_GLYPH[level]} ${identity(
      tokenRow?.name ?? null,
      tokenRow?.symbol ?? null,
      features.tokenAddress
    )} · ${level}`
  );
  lines.push(
    `Score ${score.score}/100 · ${
      eligibility.eligible ? "ELIGIBLE" : "NOT ELIGIBLE"
    }`
  );
  const c = score.components;
  lines.push(
    `Components: liquidity ${c.liquidityDepth}/35 · buyers ${c.buyerBreadth}/25 · ` +
      `flow ${c.buyFlow}/20 · lowcap ${c.lowCapTilt}/20`
  );
  lines.push(
    `FDV ${formatUsd(features.estimatedFdvUsd)} · ` +
      `Liq ${formatUsd(features.totalLiquidityUsd)} ` +
      `(quote ${formatUsd(features.quoteLiquidityUsd)}) · ` +
      `Age ${formatAge(features.tokenAgeMinutes)}`
  );
  lines.push(
    `Buyers 1h ${features.uniqueBuyers1h} (20m ${features.uniqueBuyers20m}) · ` +
      `Sim ${features.simulationStatus} · Risk ${features.riskStatus} · ` +
      `Top10 ${formatBps(features.adjustedTop10PctBps)}`
  );
  if (eligibility.failedRules.length > 0) {
    lines.push(`Failed: ${eligibility.failedRules.join(", ")}`);
  }
  if (eligibility.softFailedRules.length > 0) {
    lines.push(`Quality flags: ${eligibility.softFailedRules.join(", ")}`);
  }
  for (const reason of score.positiveReasons.slice(0, MAX_POSITIVE_REASONS)) {
    lines.push(`+ ${reason}`);
  }
  for (const reason of score.riskReasons.slice(0, MAX_RISK_REASONS)) {
    lines.push(`! ${reason}`);
  }

  const snapshotAgeMinutes =
    (requestedAt.getTime() - features.capturedAt.getTime()) / 60_000;
  const poolNote =
    pools.length > 1 ? ` · best of ${pools.length} pools` : "";
  lines.push(
    `Data: snapshot ${formatAge(snapshotAgeMinutes)} old · ` +
      `block ${features.blockNumber}${poolNote}`
  );
  lines.push(features.tokenAddress);
  return lines.join("\n");
}
