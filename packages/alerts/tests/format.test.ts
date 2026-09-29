import { describe, expect, it } from "vitest";

import { formatAlert } from "../src/index.js";
import { makeContext, makeFeatures } from "./fixtures.js";

describe("formatAlert", () => {
  it("renders the glyph header with the token name and tap-to-copy addresses", () => {
    const text = formatAlert(makeContext("GREEN"));
    const lines = text.split("\n");
    expect(lines[0]).toBe("🟢 Fixture Token (FIX)");
    expect(text).toContain(
      "CA: <code>0xToKeN0000000000000000000000000000000001</code>"
    );
    // Pool address deliberately not displayed (only the chart URL carries it).
    expect(text).not.toContain("0xPooL0000000000000000000000000000000000a1");
  });

  it("falls back to the token address in the header when name and symbol are missing", () => {
    const text = formatAlert(
      makeContext("GREEN", { tokenName: null, tokenSymbol: null })
    );
    expect(text.split("\n")[0]).toContain(
      "0xToKeN0000000000000000000000000000000001"
    );
  });

  it("escapes hostile HTML in the attacker-controlled token name", () => {
    const text = formatAlert(
      makeContext("GREEN", { tokenName: '<b onclick="x">Evil & Co</b>' })
    );
    expect(text).not.toContain("<b");
    expect(text).toContain("&lt;b onclick=\"x\"&gt;Evil &amp; Co&lt;/b&gt;");
  });

  it("includes FDV, liquidity, unique buyers, and score", () => {
    const text = formatAlert(makeContext("YELLOW"));
    expect(text).toContain("FDV: $123,456");
    expect(text).toContain("Liquidity: $45,000");
    expect(text).toContain("Unique buyers (1h): 52");
    expect(text).toContain("Score: 78/100");
  });

  it("surfaces the top positive component reasons and risk reasons", () => {
    const text = formatAlert(makeContext("YELLOW"));
    expect(text).toContain("+ deep quote liquidity");
    expect(text).toContain("+ strong organic buying");
    expect(text).toContain("+ healthy holder distribution");
    // capped at three positives — the trailing one is dropped.
    expect(text).not.toContain("trailing extra reason");
    expect(text).toContain("⚠ deployer ownership unknown");
    expect(text).toContain("⚠ sell simulation not PASS");
  });

  it("varies the header glyph by level and never spells the level out", () => {
    expect(formatAlert(makeContext("RED")).split("\n")[0]).toBe(
      "🔴 Fixture Token (FIX)"
    );
    expect(formatAlert(makeContext("YELLOW")).split("\n")[0]).toBe(
      "🟡 Fixture Token (FIX)"
    );
    expect(formatAlert(makeContext("GREEN")).split("\n")[0]).toBe(
      "🟢 Fixture Token (FIX)"
    );
  });

  it("appends a chart link only when provided", () => {
    const without = formatAlert(makeContext("YELLOW"));
    expect(without).not.toContain("Chart:");

    const withUrl = formatAlert(
      makeContext("YELLOW", {
        chartUrl: "https://dexscreener.com/robinhood/0xabc"
      })
    );
    expect(withUrl).toContain(
      "Chart: https://dexscreener.com/robinhood/0xabc"
    );
  });

  it("shows 'unknown' for null USD fields", () => {
    const text = formatAlert(
      makeContext("YELLOW", {
        features: makeFeatures({
          estimatedFdvUsd: null,
          totalLiquidityUsd: null
        })
      })
    );
    expect(text).toContain("FDV: unknown");
    expect(text).toContain("Liquidity: unknown");
  });
});
