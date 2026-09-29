import { describe, expect, it } from "vitest";

import { classifyQuoteSide } from "../src/normalize.js";
import { USDC, WETH, addr } from "./fixtures.js";

describe("classifyQuoteSide", () => {
  const quoteAssets = [WETH, USDC];

  it("identifies the quote side when token0 is allow-listed", () => {
    const result = classifyQuoteSide(
      { token0: WETH.address, token1: addr("cc") },
      quoteAssets
    );
    expect(result.quoteToken).toBe(WETH);
    expect(result.baseTokenAddress).toBe(addr("cc"));
  });

  it("identifies the quote side when token1 is allow-listed", () => {
    const result = classifyQuoteSide(
      { token0: addr("cc"), token1: USDC.address },
      quoteAssets
    );
    expect(result.quoteToken).toBe(USDC);
    expect(result.baseTokenAddress).toBe(addr("cc"));
  });

  it("prefers the earlier configured asset when both sides qualify", () => {
    const result = classifyQuoteSide(
      { token0: USDC.address, token1: WETH.address },
      quoteAssets
    );
    expect(result.quoteToken).toBe(WETH);
    expect(result.baseTokenAddress).toBe(USDC.address);
  });

  it("returns null for pools with no trusted side", () => {
    const result = classifyQuoteSide(
      { token0: addr("cc"), token1: addr("dd") },
      quoteAssets
    );
    expect(result.quoteToken).toBeNull();
    expect(result.baseTokenAddress).toBeNull();
  });

  it("never trusts symbol lookalikes outside the allow-list", () => {
    // An adversarial token could reuse the WETH symbol; only the address matters.
    const fakeWeth = { address: addr("99"), symbol: "WETH", decimals: 18 };
    const result = classifyQuoteSide(
      { token0: fakeWeth.address, token1: addr("cc") },
      quoteAssets
    );
    expect(result.quoteToken).toBeNull();
  });
});
