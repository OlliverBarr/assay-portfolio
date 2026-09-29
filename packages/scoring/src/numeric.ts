/**
 * Coarse USD gating helpers. Enrichment exposes USD amounts as decimal strings
 * (or null when uncomputable). Eligibility and alerting compare those against
 * dollar bands, so we parse with `Number()` — this is deliberately lossy and is
 * ONLY valid for threshold gating, never for money movement (that stays bigint
 * / basis points). A null or unparseable value yields null so the caller can
 * treat missing data as a rule failure rather than a silent pass.
 */
export function parseUsdNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}
