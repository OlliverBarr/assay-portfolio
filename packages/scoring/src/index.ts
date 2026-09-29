export {
  DEFAULT_ALERT_THRESHOLDS,
  DEFAULT_ELIGIBILITY_CONFIG,
  DEFAULT_SIGNAL_CONFIG,
  type AlertLevel,
  type AlertThresholds,
  type CandidateFeatures,
  type EligibilityConfig,
  type EligibilityResult,
  type RiskStatus,
  type ScoreComponents,
  type ScoreResult,
  type SignalConfig,
  type SimulationStatus,
  type SlippagePoint,
  type VerificationStatus
} from "./types.js";
export { evaluateEligibility } from "./eligibility.js";
export { scoreOpportunity } from "./score.js";
export { classifyAlertLevel } from "./alert-level.js";
