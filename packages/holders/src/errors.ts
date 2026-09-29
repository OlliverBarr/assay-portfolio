/**
 * Raised when the holder pass cannot safely continue because chain
 * infrastructure (not a hostile token) is failing after bounded retries. The
 * worker logs and backs off; selection is idempotent, so the pass simply
 * re-scans the pending pools next time.
 */
export class HolderHaltError extends Error {
  override readonly name = "HolderHaltError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
  }
}
