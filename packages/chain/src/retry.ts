import { setTimeout as sleep } from "node:timers/promises";

import {
  HttpRequestError,
  ResourceNotFoundRpcError,
  RpcRequestError,
  TimeoutError
} from "viem";

import { RetryExhaustedError } from "./errors.js";

/**
 * JSON-RPC error codes considered transient.
 * -32005: limit exceeded / rate limited (common provider convention).
 * -32603: internal error.
 * 429: Alchemy returns its throttle/capacity code inside the JSON-RPC error
 *      body (HTTP 200), observed 2026-07-13 as "Monthly capacity limit
 *      exceeded" during CU exhaustion.
 */
const TRANSIENT_RPC_CODES: ReadonlySet<number> = new Set([-32005, -32603, 429]);

/**
 * Classify an error as a transient RPC failure worth retrying.
 * Anything unrecognized is treated as permanent — retrying a decode bug or
 * a misconfigured address only hides it.
 */
export function isTransientRpcError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (error instanceof HttpRequestError) {
    // No status = network-level failure (DNS, reset, timeout).
    if (error.status === undefined) return true;
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof RpcRequestError) {
    return TRANSIENT_RPC_CODES.has(error.code);
  }
  // viem maps JSON-RPC code -32001 to this named class. Alchemy sheds load
  // with -32001 "Unable to complete request at this time" when compute units
  // are exhausted (observed 2026-07-13). Our workload only reads canonical
  // state, so a genuine not-found is anomalous; bounded retries then a
  // RetryExhaustedError halt is the right behavior either way.
  if (error instanceof ResourceNotFoundRpcError) return true;
  return false;
}

export interface RetryOptions {
  /** Total attempts, including the first. Must be >= 1. */
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly isRetryable: (error: unknown) => boolean;
  /** Injectable for deterministic tests. */
  readonly sleep: (ms: number) => Promise<void>;
}

export const defaultRetryOptions: RetryOptions = {
  attempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  isRetryable: isTransientRpcError,
  sleep: async (ms) => {
    await sleep(ms);
  }
};

/**
 * Run `fn` with bounded retries and exponential backoff.
 *
 * Non-retryable errors propagate immediately. When all attempts fail,
 * throws {@link RetryExhaustedError} with the last error as `cause` so the
 * caller can halt loudly instead of skipping work.
 */
export async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T> {
  const opts: RetryOptions = { ...defaultRetryOptions, ...options };
  if (opts.attempts < 1) {
    throw new RangeError(`retry attempts must be >= 1, got ${opts.attempts}`);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!opts.isRetryable(error)) throw error;
      lastError = error;
      if (attempt < opts.attempts) {
        const delay = Math.min(
          opts.baseDelayMs * 2 ** (attempt - 1),
          opts.maxDelayMs
        );
        await opts.sleep(delay);
      }
    }
  }
  throw new RetryExhaustedError(operation, opts.attempts, lastError);
}
