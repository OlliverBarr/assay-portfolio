import { describe, expect, it } from "vitest";
import {
  HttpRequestError,
  ResourceNotFoundRpcError,
  RpcRequestError,
  TimeoutError
} from "viem";

import {
  RetryExhaustedError,
  isTransientRpcError,
  withRetry
} from "../src/index.js";

class TransientError extends Error {}
class PermanentError extends Error {}

const testOptions = {
  attempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 150,
  isRetryable: (error: unknown) => error instanceof TransientError
};

describe("withRetry", () => {
  it("returns the first success without extra attempts", async () => {
    let calls = 0;
    const result = await withRetry(
      "op",
      () => {
        calls += 1;
        return Promise.resolve(42);
      },
      { ...testOptions, sleep: () => Promise.resolve() }
    );
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it("retries transient failures with capped exponential backoff", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(
      "op",
      () => {
        calls += 1;
        if (calls < 3) return Promise.reject(new TransientError("flaky"));
        return Promise.resolve("ok");
      },
      {
        ...testOptions,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        }
      }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    // base 100, then 200 capped at maxDelayMs 150.
    expect(delays).toEqual([100, 150]);
  });

  it("throws RetryExhaustedError with the last error as cause", async () => {
    let calls = 0;
    const failing = () => {
      calls += 1;
      return Promise.reject(new TransientError(`attempt ${calls}`));
    };
    const promise = withRetry("getLogs 1-10", failing, {
      ...testOptions,
      sleep: () => Promise.resolve()
    });
    await expect(promise).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(calls).toBe(3);
    try {
      await withRetry("getLogs 1-10", failing, {
        ...testOptions,
        sleep: () => Promise.resolve()
      });
    } catch (error) {
      const exhausted = error as RetryExhaustedError;
      expect(exhausted.attempts).toBe(3);
      expect(exhausted.operation).toBe("getLogs 1-10");
      expect(exhausted.cause).toBeInstanceOf(TransientError);
    }
  });

  it("propagates non-retryable errors immediately", async () => {
    let calls = 0;
    await expect(
      withRetry(
        "op",
        () => {
          calls += 1;
          return Promise.reject(new PermanentError("bad address"));
        },
        { ...testOptions, sleep: () => Promise.resolve() }
      )
    ).rejects.toBeInstanceOf(PermanentError);
    expect(calls).toBe(1);
  });
});

describe("isTransientRpcError", () => {
  const url = "https://rpc.example.com";

  it("treats timeouts and 5xx/429 responses as transient", () => {
    expect(isTransientRpcError(new TimeoutError({ body: {}, url }))).toBe(true);
    expect(
      isTransientRpcError(new HttpRequestError({ url, status: 429 }))
    ).toBe(true);
    expect(
      isTransientRpcError(new HttpRequestError({ url, status: 503 }))
    ).toBe(true);
    // Network-level failure without a status.
    expect(isTransientRpcError(new HttpRequestError({ url }))).toBe(true);
  });

  it("treats Alchemy capacity exhaustion as transient (observed 2026-07-13)", () => {
    // Alchemy returns its throttle code inside the JSON-RPC error body.
    const capacity = new RpcRequestError({
      body: { method: "eth_blockNumber" },
      error: { code: 429, message: "Monthly capacity limit exceeded." },
      url
    });
    expect(isTransientRpcError(capacity)).toBe(true);
    // viem maps JSON-RPC -32001 ("Unable to complete request at this time")
    // to this named class before it reaches the retry layer.
    const shed = new RpcRequestError({
      body: { method: "eth_getLogs" },
      error: { code: -32001, message: "Unable to complete request at this time." },
      url
    });
    expect(isTransientRpcError(new ResourceNotFoundRpcError(shed))).toBe(true);
  });

  it("keeps auth failures permanent — a bad key must surface, not loop", () => {
    expect(
      isTransientRpcError(new HttpRequestError({ url, status: 401 }))
    ).toBe(false);
    expect(
      isTransientRpcError(new HttpRequestError({ url, status: 403 }))
    ).toBe(false);
    // Unrecognized JSON-RPC codes stay permanent too.
    expect(
      isTransientRpcError(
        new RpcRequestError({
          body: {},
          error: { code: -32600, message: "invalid request" },
          url
        })
      )
    ).toBe(false);
  });

  it("treats client errors and unknown errors as permanent", () => {
    expect(
      isTransientRpcError(new HttpRequestError({ url, status: 400 }))
    ).toBe(false);
    expect(isTransientRpcError(new Error("decode failed"))).toBe(false);
  });
});
