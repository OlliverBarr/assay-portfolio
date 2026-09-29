/**
 * Raised when the enrichment pass cannot safely continue because chain
 * infrastructure (not a hostile token) is failing after bounded retries. The
 * worker logs and backs off; selection is idempotent, so the pass simply
 * re-reads the pending pools next time.
 */
export class EnrichmentHaltError extends Error {
  override readonly name = "EnrichmentHaltError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
  }
}
