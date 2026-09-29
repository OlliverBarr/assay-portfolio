/** Distinct top-level risk verdicts. UNKNOWN/ERROR/STALE are never PASS. */
export type RiskStatus = "PASS" | "FAIL" | "UNKNOWN" | "ERROR" | "STALE";

/** Per-leg or per-simulation tradeability verdict. */
export type LegStatus = "PASS" | "FAIL" | "UNKNOWN";

/** Contract source verification, from the explorer index. */
export type VerificationStatus = "VERIFIED" | "UNVERIFIED" | "UNKNOWN";

/**
 * Evidence-based permission state. Absence of a matching selector is ABSENT,
 * not "safe"; a contract we could not read is UNKNOWN; a proxy whose logic we
 * did not resolve is NOT_APPLICABLE for its own bytecode.
 */
export type PermissionState =
  | "PRESENT"
  | "ABSENT"
  | "UNKNOWN"
  | "NOT_APPLICABLE"
  | "ANALYSIS_FAILED";

/** Privileged capability categories detected from runtime bytecode. */
export type PermissionKind =
  | "mint"
  | "blacklist"
  | "pause"
  | "transferTax"
  | "ownership"
  | "upgradeAdmin";
