import type { AlertLevel } from "@assay/scoring";

import type { AlertContext } from "./types.js";

/** Static per-level glyphs for message headers (shared with /score replies). */
export const LEVEL_GLYPH: Record<AlertLevel, string> = {
  GRAY: "⚪",
  RED: "🔴",
  YELLOW: "🟡",
  GREEN: "🟢"
};

/** Number of leading positive component reasons to surface in a message. */
const MAX_POSITIVE_REASONS = 3;
/** Number of leading risk reasons to surface in a message. */
const MAX_RISK_REASONS = 3;
/** Caps on attacker-controlled metadata rendered into the header. */
const MAX_NAME_CHARS = 64;
const MAX_SYMBOL_CHARS = 16;

/**
 * Escape a string for Telegram HTML parse mode. The transport sends
 * `parse_mode: "HTML"` (needed for tap-to-copy `<code>` addresses), so EVERY
 * dynamic value in EVERY message must pass through this or Telegram rejects
 * the send with a 400 — worse for token names, which are attacker-controlled
 * on-chain metadata and could otherwise inject working markup.
 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Render a USD decimal-string field for display only. `Number(...)` here is a
 * coarse human-facing format, never money movement; nulls read as "unknown".
 */
function formatUsd(value: string | null): string {
  if (value === null) return "unknown";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "unknown";
  return `$${Math.round(parsed).toLocaleString("en-US")}`;
}

/**
 * Header identity: `Name (SYMBOL)` from untrusted on-chain metadata, escaped
 * and length-capped; falls back to the token address when both are missing.
 */
function headerIdentity(ctx: AlertContext): string {
  const name = ctx.tokenName?.trim().slice(0, MAX_NAME_CHARS) ?? "";
  const symbol = ctx.tokenSymbol?.trim().slice(0, MAX_SYMBOL_CHARS) ?? "";
  if (name === "" && symbol === "") return ctx.features.tokenAddress;
  if (name === "") return escapeHtml(symbol);
  if (symbol === "") return escapeHtml(name);
  return `${escapeHtml(name)} (${escapeHtml(symbol)})`;
}

/**
 * Turn an {@link AlertContext} into a concise, deterministic multi-line
 * Telegram-HTML message. Pure: same context in, same string out. Includes
 * the level glyph (glyph only — the color IS the level; operator feedback
 * 2026-07-12), token name, tap-to-copy contract address, FDV, liquidity,
 * unique buyers, score with its top positive component reasons, risk
 * reasons, and a chart link when one is provided. The pool address is
 * deliberately NOT displayed (operator feedback 2026-07-12: noise) — the
 * chart link still encodes it for dexscreener.
 */
export function formatAlert(ctx: AlertContext): string {
  const { features, score, level } = ctx;
  const lines: string[] = [];

  lines.push(`${LEVEL_GLYPH[level]} ${headerIdentity(ctx)}`);
  lines.push(`CA: <code>${features.tokenAddress}</code>`);
  lines.push(
    `FDV: ${formatUsd(features.estimatedFdvUsd)} · ` +
      `Liquidity: ${formatUsd(features.totalLiquidityUsd)}`
  );
  lines.push(
    `Unique buyers (1h): ${features.uniqueBuyers1h} · ` +
      `(20m): ${features.uniqueBuyers20m}`
  );
  lines.push(`Score: ${score.score}/100`);

  const positives = score.positiveReasons.slice(0, MAX_POSITIVE_REASONS);
  for (const reason of positives) {
    lines.push(`+ ${escapeHtml(reason)}`);
  }

  const risks = score.riskReasons.slice(0, MAX_RISK_REASONS);
  for (const reason of risks) {
    lines.push(`⚠ ${escapeHtml(reason)}`);
  }

  if (ctx.chartUrl !== undefined) {
    lines.push(`Chart: ${ctx.chartUrl}`);
  }

  return lines.join("\n");
}
