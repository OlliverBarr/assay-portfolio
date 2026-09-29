import {
  DEFAULT_TAXONOMY_CONFIG,
  type RealizedLabel,
  type RealizedOutcomeInput,
  type TaxonomyConfig
} from "./types.js";

/**
 * Judge ground truth for one token's realized outcome, independent of and
 * never fed back into the deterministic alert pipeline.
 *
 * Precedence (checked in order, first match wins):
 * 1. RUGGED — the token died or its quote liquidity collapsed. This
 *    dominates the multiple: a token that spiked then rugged is not a
 *    RUNNER.
 * 2. RUNNER — survived and reached at least `runnerMinMultipleBps`.
 * 3. BLED — survived but never exceeded `bledMaxMultipleBps`.
 * 4. HELD_BAND — survived, in between the two bands (inclusive of the
 *    `bledMaxMultipleBps` boundary itself, exclusive of `runnerMinMultipleBps`).
 */
export function classifyRealizedOutcome(
  input: RealizedOutcomeInput,
  config: TaxonomyConfig = DEFAULT_TAXONOMY_CONFIG
): RealizedLabel {
  if (input.died || input.liquidityCollapsed) return "RUGGED";
  if (input.maxMultipleBps >= config.runnerMinMultipleBps) return "RUNNER";
  if (input.maxMultipleBps < config.bledMaxMultipleBps) return "BLED";
  return "HELD_BAND";
}
