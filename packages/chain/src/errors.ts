/**
 * Structured error types for chain access.
 *
 * Every error carries enough context to explain what failed without
 * consumers needing to parse message strings.
 */

/** Raised when chain configuration is missing or malformed. */
export class ChainConfigError extends Error {
  override readonly name = "ChainConfigError";
  readonly field: string;

  constructor(field: string, message: string) {
    super(`Invalid chain configuration for "${field}": ${message}`);
    this.field = field;
  }
}

/** Raised when a bounded retry loop exhausts all attempts. */
export class RetryExhaustedError extends Error {
  override readonly name = "RetryExhaustedError";
  readonly attempts: number;
  readonly operation: string;

  constructor(operation: string, attempts: number, cause: unknown) {
    super(`Operation "${operation}" failed after ${attempts} attempt(s)`, {
      cause
    });
    this.attempts = attempts;
    this.operation = operation;
  }
}
