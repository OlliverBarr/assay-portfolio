import type {
  AlertLevel,
  CandidateFeatures,
  EligibilityResult,
  ScoreResult
} from "@assay/scoring";

/**
 * Everything the delivery layer needs to render and deduplicate one alert.
 * Assembled by the worker from the shared candidate contract plus the derived
 * eligibility verdict, score, and classified level. Purely a value object —
 * formatting and dedup are pure functions over it.
 */
export interface AlertContext {
  readonly features: CandidateFeatures;
  readonly eligibility: EligibilityResult;
  readonly score: ScoreResult;
  readonly level: AlertLevel;
  /** On-chain token name — UNTRUSTED attacker-controlled metadata; the
   * formatter escapes and length-caps it. Null when metadata is missing. */
  readonly tokenName: string | null;
  /** On-chain token symbol — same trust caveat as {@link tokenName}. */
  readonly tokenSymbol: string | null;
  /** Chart URL for the pool (e.g. dexscreener), when the worker can build one. */
  readonly chartUrl?: string;
}

/**
 * A sink that delivers a rendered alert message somewhere (Telegram, a log,
 * a test spy). Implementations either resolve on success or reject with an
 * {@link AlertDeliveryError}.
 */
export interface AlertTransport {
  send(text: string): Promise<void>;
}
