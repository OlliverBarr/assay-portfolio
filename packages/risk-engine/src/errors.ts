/**
 * Raised when the risk pass cannot safely continue because chain
 * infrastructure (not a hostile token) is failing after bounded retries. The
 * worker logs and backs off; selection is idempotent, so the pass simply
 * re-assesses the pending pools next time.
 */
export class RiskHaltError extends Error {
  override readonly name = "RiskHaltError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
  }
}
