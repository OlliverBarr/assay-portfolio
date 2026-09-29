import { describe, expect, it } from "vitest";

import { decodeSwapLog, normalizeSwapEvent, SwapDecodeError } from "../src/index.js";
import {
  BASE,
  WETH,
  addr,
  makeV2SwapLog,
  makeV3SwapLog,
  poolRow
} from "./fixtures.js";

const BUYER = addr("12");
const SELLER = addr("13");

describe("swap decode and normalization", () => {
  it("decodes and classifies a V2 BUY", () => {
    const pool = poolRow();
    const decoded = decodeSwapLog(
      makeV2SwapLog({ amount0Out: 5n, amount1In: 100n, to: BUYER }),
      pool
    );
    const normalized = normalizeSwapEvent(decoded);

    expect(decoded).toMatchObject({
      sender: addr("11"),
      recipient: BUYER,
      token0DeltaRaw: -5n,
      token1DeltaRaw: 100n
    });
    expect(normalized).toMatchObject({
      side: "BUY",
      recipient: BUYER,
      baseAmountRaw: 5n,
      quoteAmountRaw: 100n
    });
  });

  it("decodes and classifies a V2 SELL", () => {
    const pool = poolRow();
    const normalized = normalizeSwapEvent(
      decodeSwapLog(
        makeV2SwapLog({ amount0In: 7n, amount1Out: 90n, sender: SELLER }),
        pool
      )
    );

    expect(normalized).toMatchObject({
      side: "SELL",
      sender: SELLER,
      baseAmountRaw: 7n,
      quoteAmountRaw: 90n
    });
  });

  it("classifies a zero or ambiguous V2 swap as UNKNOWN", () => {
    const normalized = normalizeSwapEvent(decodeSwapLog(makeV2SwapLog(), poolRow()));

    expect(normalized?.side).toBe("UNKNOWN");
    expect(normalized?.baseAmountRaw).toBe(0n);
    expect(normalized?.quoteAmountRaw).toBe(0n);
  });

  it("decodes and classifies a V3 BUY", () => {
    const pool = poolRow({ factoryKind: "uniswap-v3" });
    const normalized = normalizeSwapEvent(
      decodeSwapLog(
        makeV3SwapLog({ amount0: -11n, amount1: 200n, recipient: BUYER }),
        pool
      )
    );

    expect(normalized).toMatchObject({
      side: "BUY",
      recipient: BUYER,
      token0AmountRaw: -11n,
      token1AmountRaw: 200n,
      baseAmountRaw: 11n,
      quoteAmountRaw: 200n
    });
  });

  it("decodes and classifies a V3 SELL", () => {
    const pool = poolRow({ factoryKind: "uniswap-v3" });
    const normalized = normalizeSwapEvent(
      decodeSwapLog(
        makeV3SwapLog({ amount0: 13n, amount1: -210n, sender: SELLER }),
        pool
      )
    );

    expect(normalized).toMatchObject({
      side: "SELL",
      sender: SELLER,
      baseAmountRaw: 13n,
      quoteAmountRaw: 210n
    });
  });

  it("classifies a zero or ambiguous V3 swap as UNKNOWN", () => {
    const pool = poolRow({ factoryKind: "uniswap-v3" });
    const normalized = normalizeSwapEvent(decodeSwapLog(makeV3SwapLog(), pool));

    expect(normalized?.side).toBe("UNKNOWN");
  });

  it("preserves structured decode errors for malformed logs", () => {
    const malformed = { ...makeV2SwapLog(), data: "0x00" as const };
    let caught: unknown;
    try {
      decodeSwapLog(malformed, poolRow());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SwapDecodeError);
    expect((caught as SwapDecodeError).blockNumber).toBe(malformed.blockNumber);
    expect((caught as SwapDecodeError).cause).toBeDefined();
  });

  it("normalizes when quote token is token0", () => {
    const pool = poolRow({
      token0Address: WETH.address,
      token1Address: BASE,
      quoteTokenAddress: WETH.address,
      baseTokenAddress: BASE
    });
    const normalized = normalizeSwapEvent(
      decodeSwapLog(makeV2SwapLog({ amount0In: 50n, amount1Out: 3n }), pool)
    );

    expect(normalized).toMatchObject({
      side: "BUY",
      baseAmountRaw: 3n,
      quoteAmountRaw: 50n
    });
  });

  it("normalizes when quote token is token1", () => {
    const normalized = normalizeSwapEvent(
      decodeSwapLog(makeV2SwapLog({ amount0Out: 3n, amount1In: 50n }), poolRow())
    );

    expect(normalized).toMatchObject({
      side: "BUY",
      baseAmountRaw: 3n,
      quoteAmountRaw: 50n
    });
  });

  it("skips pools without a trusted quote side", () => {
    const pool = poolRow({ quoteTokenAddress: null, baseTokenAddress: null });
    const normalized = normalizeSwapEvent(decodeSwapLog(makeV2SwapLog(), pool));

    expect(normalized).toBeNull();
  });
});
