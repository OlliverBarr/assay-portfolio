/**
 * Raised when an alert transport fails to deliver a message (e.g. the Telegram
 * Bot API returns a non-2xx response). The caller decides whether to retry or
 * record the failure; delivery is never silently swallowed.
 */
export class AlertDeliveryError extends Error {
  override readonly name = "AlertDeliveryError";

  /** HTTP status code of the failed response, when the failure was an HTTP one. */
  readonly status?: number;

  constructor(
    message: string,
    options?: { status?: number; cause?: unknown }
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}
