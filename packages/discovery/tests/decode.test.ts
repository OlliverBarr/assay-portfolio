import { describe, expect, it } from "vitest";

import { decodePoolCreationLog } from "../src/decode.js";
import { PoolDecodeError } from "../src/errors.js";
import {
  V2_FACTORY,
  V3_FACTORY,
  addr,
  makeV2Log,
  makeV3Log
} from "./fixtures.js";

describe("decodePoolCreationLog", () => {
  it("decodes a V2 PairCreated log", () => {
    const log = makeV2Log({
      token0: addr("aa"),
      token1: addr("cc"),
      pair: addr("dd"),
      blockNumber: 123n,
      logIndex: 4
    });

    const event = decodePoolCreationLog(log, V2_FACTORY);

    expect(event).toMatchObject({
      factory: V2_FACTORY,
      poolAddress: addr("dd"),
      token0: addr("aa"),
      token1: addr("cc"),
      feePpm: null,
      tickSpacing: null,
      blockNumber: 123n,
      logIndex: 4
    });
  });

  it("decodes a V3 PoolCreated log including fee and tick spacing", () => {
    const log = makeV3Log({
      token0: addr("aa"),
      token1: addr("cc"),
      pool: addr("ee"),
      fee: 10_000,
      tickSpacing: 200,
      blockNumber: 456n
    });

    const event = decodePoolCreationLog(log, V3_FACTORY);

    expect(event).toMatchObject({
      poolAddress: addr("ee"),
      feePpm: 10_000,
      tickSpacing: 200,
      blockNumber: 456n
    });
  });

  it("rejects a log whose topic0 does not match the factory kind", () => {
    const v3Log = makeV3Log({
      token0: addr("aa"),
      token1: addr("cc"),
      pool: addr("ee"),
      blockNumber: 456n
    });
    // A V3 event attributed to a V2 factory must never decode silently.
    expect(() => decodePoolCreationLog(v3Log, V2_FACTORY)).toThrow(
      PoolDecodeError
    );
  });

  it("rejects malformed event data with the cause preserved", () => {
    const log = {
      ...makeV2Log({
        token0: addr("aa"),
        token1: addr("cc"),
        pair: addr("dd"),
        blockNumber: 123n
      }),
      data: "0x00" as const
    };
    let caught: unknown;
    try {
      decodePoolCreationLog(log, V2_FACTORY);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PoolDecodeError);
    expect((caught as PoolDecodeError).cause).toBeDefined();
    expect((caught as PoolDecodeError).blockNumber).toBe(123n);
  });
});
