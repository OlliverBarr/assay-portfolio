import type { PermissionFinding } from "./permissions.js";
import type { ProxyReport } from "./proxy.js";
import type { SimulationClassification } from "./simulate.js";
import type { PermissionKind, RiskStatus } from "./types.js";
import type { VerificationMetadata } from "./verification.js";

/** Permissions that, when present, make a token FAIL outright. */
const CRITICAL_PERMISSIONS: Record<PermissionKind, boolean> = {
  mint: true,
  blacklist: true,
  pause: true,
  upgradeAdmin: true,
  transferTax: false,
  ownership: false
};

export interface RiskComponentsInput {
  readonly verification: VerificationMetadata;
  readonly proxy: ProxyReport;
  readonly permissions: readonly PermissionFinding[];
  /** Null when no route simulator was configured — treated as UNKNOWN. */
  readonly simulation: SimulationClassification | null;
}

export interface RiskAssessment {
  readonly status: RiskStatus;
  readonly riskReasons: string[];
  readonly positiveReasons: string[];
}

/**
 * Combine the deterministic components into a single explainable verdict.
 *
 * PASS requires an actionable positive: a passing sell simulation and no
 * critical permission and no unknown critical signal. A present critical
 * permission or a failing simulation is FAIL. Any missing critical signal is
 * UNKNOWN — never silently upgraded to PASS. ERROR/STALE are applied elsewhere
 * (read-time staleness, or a caught analysis error in the pass).
 */
export function assessRisk(input: RiskComponentsInput): RiskAssessment {
  const riskReasons: string[] = [];
  const positiveReasons: string[] = [];

  if (input.verification.status === "VERIFIED") {
    positiveReasons.push("Contract source is verified");
  } else if (input.verification.status === "UNVERIFIED") {
    riskReasons.push("Contract source is not verified");
  } else {
    riskReasons.push("Contract verification status is unknown");
  }

  if (input.proxy.isProxy) {
    riskReasons.push(
      `Contract is a proxy (${input.proxy.kind}); logic can change`
    );
  }

  let criticalPresent = false;
  let criticalUnknown = false;
  for (const finding of input.permissions) {
    const isCritical = CRITICAL_PERMISSIONS[finding.kind];
    if (finding.state === "PRESENT") {
      if (isCritical) {
        criticalPresent = true;
        riskReasons.push(`Critical privileged capability present: ${finding.kind}`);
      } else if (finding.kind === "transferTax") {
        riskReasons.push("Adjustable transfer-tax capability present");
      } else if (finding.kind === "ownership") {
        riskReasons.push("Owner-controlled administrative functions present");
      }
    } else if (
      isCritical &&
      (finding.state === "UNKNOWN" || finding.state === "ANALYSIS_FAILED")
    ) {
      criticalUnknown = true;
      riskReasons.push(`Privileged-permission analysis incomplete: ${finding.kind}`);
    }
  }

  const simStatus = input.simulation?.status ?? "UNKNOWN";
  if (input.simulation === null) {
    riskReasons.push("Trade simulation was not performed");
  } else {
    for (const reason of input.simulation.reasons) riskReasons.push(reason);
    if (simStatus === "PASS") {
      positiveReasons.push("Buy and sell simulate successfully through the real route");
    }
  }

  let status: RiskStatus;
  if (criticalPresent || simStatus === "FAIL") {
    status = "FAIL";
  } else if (criticalUnknown || simStatus === "UNKNOWN") {
    status = "UNKNOWN";
  } else {
    status = "PASS";
  }

  return { status, riskReasons, positiveReasons };
}

/**
 * Read-time staleness: a verdict older than `maxAgeMs` is reported STALE
 * regardless of its stored value, so a consumer never trusts a decision made
 * against long-gone chain state. ERROR is preserved (a stale error is still an
 * error to resolve).
 */
export function effectiveRiskStatus(
  storedStatus: RiskStatus,
  assessedAt: Date,
  now: Date,
  maxAgeMs: number
): RiskStatus {
  if (storedStatus === "ERROR") return "ERROR";
  const ageMs = now.getTime() - assessedAt.getTime();
  return ageMs > maxAgeMs ? "STALE" : storedStatus;
}
