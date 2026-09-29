import { describe, expect, it } from "vitest";

import { classifyRealizedOutcome } from "../src/taxonomy.js";
import { DEFAULT_TAXONOMY_CONFIG, type RealizedOutcomeInput } from "../src/types.js";

function outcome(overrides: Partial<RealizedOutcomeInput> = {}): RealizedOutcomeInput {
  return {
    maxMultipleBps: 15_000,
    died: false,
    liquidityCollapsed: false,
    ...overrides
  };
}

describe("classifyRealizedOutcome — RUGGED dominance", () => {
  it("labels a died token RUGGED regardless of a high multiple", () => {
    expect(
      classifyRealizedOutcome(outcome({ died: true, maxMultipleBps: 50_000 }))
    ).toBe("RUGGED");
  });

  it("labels a liquidity collapse RUGGED regardless of a high multiple", () => {
    expect(
      classifyRealizedOutcome(
        outcome({ liquidityCollapsed: true, maxMultipleBps: 50_000 })
      )
    ).toBe("RUGGED");
  });

  it("labels both died and collapsed RUGGED", () => {
    expect(
      classifyRealizedOutcome(outcome({ died: true, liquidityCollapsed: true }))
    ).toBe("RUGGED");
  });
});

describe("classifyRealizedOutcome — band boundaries", () => {
  const { bledMaxMultipleBps, runnerMinMultipleBps } = DEFAULT_TAXONOMY_CONFIG;

  it("is BLED just below the bled-max boundary", () => {
    expect(
      classifyRealizedOutcome(outcome({ maxMultipleBps: bledMaxMultipleBps - 1 }))
    ).toBe("BLED");
  });

  it("is HELD_BAND exactly at the bled-max boundary (not < bledMax)", () => {
    expect(
      classifyRealizedOutcome(outcome({ maxMultipleBps: bledMaxMultipleBps }))
    ).toBe("HELD_BAND");
  });

  it("is HELD_BAND just below the runner-min boundary", () => {
    expect(
      classifyRealizedOutcome(outcome({ maxMultipleBps: runnerMinMultipleBps - 1 }))
    ).toBe("HELD_BAND");
  });

  it("is RUNNER exactly at the runner-min boundary (>= runnerMin)", () => {
    expect(
      classifyRealizedOutcome(outcome({ maxMultipleBps: runnerMinMultipleBps }))
    ).toBe("RUNNER");
  });

  it("is RUNNER well above the runner-min boundary", () => {
    expect(
      classifyRealizedOutcome(outcome({ maxMultipleBps: runnerMinMultipleBps * 2 }))
    ).toBe("RUNNER");
  });

  it("respects a custom config's boundaries", () => {
    const config = { bledMaxMultipleBps: 5_000, runnerMinMultipleBps: 8_000 };
    expect(classifyRealizedOutcome(outcome({ maxMultipleBps: 5_000 }), config)).toBe(
      "HELD_BAND"
    );
    expect(classifyRealizedOutcome(outcome({ maxMultipleBps: 8_000 }), config)).toBe(
      "RUNNER"
    );
    expect(classifyRealizedOutcome(outcome({ maxMultipleBps: 4_999 }), config)).toBe(
      "BLED"
    );
  });
});
