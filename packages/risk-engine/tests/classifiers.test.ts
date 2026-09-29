import { describe, expect, it } from "vitest";
import { toFunctionSelector, type Hex } from "viem";

import {
  assessRisk,
  classifyProxy,
  classifySimulation,
  classifyVerification,
  detectPermissions,
  effectiveRiskStatus,
  type PermissionFinding
} from "../src/index.js";
import { addr, codeWith, rawSim } from "./fixtures.js";

const MINT = toFunctionSelector("mint(address,uint256)");
const PAUSE = toFunctionSelector("pause()");
const IMPL_SLOT_VALUE =
  "0x000000000000000000000000cccccccccccccccccccccccccccccccccccccccc" as Hex;

function findingFor(
  findings: PermissionFinding[],
  kind: PermissionFinding["kind"]
): PermissionFinding {
  const found = findings.find((f) => f.kind === kind);
  if (found === undefined) throw new Error(`missing finding ${kind}`);
  return found;
}

describe("classifyProxy", () => {
  it("detects an EIP-1967 proxy and resolves the implementation", () => {
    const report = classifyProxy({
      implementation: IMPL_SLOT_VALUE,
      beacon: null,
      legacy: null
    });
    expect(report.isProxy).toBe(true);
    expect(report.kind).toBe("eip1967");
    expect(report.implementation).toBe(addr("cc"));
  });

  it("treats an all-zero slot as not a proxy", () => {
    const report = classifyProxy({
      implementation: `0x${"0".repeat(64)}`,
      beacon: null,
      legacy: null
    });
    expect(report.isProxy).toBe(false);
    expect(report.implementation).toBeNull();
  });

  it("flags a beacon proxy without a resolvable implementation", () => {
    const report = classifyProxy({
      implementation: null,
      beacon: IMPL_SLOT_VALUE,
      legacy: null
    });
    expect(report.isProxy).toBe(true);
    expect(report.kind).toBe("beacon");
    expect(report.implementation).toBeNull();
  });
});

describe("detectPermissions", () => {
  it("marks a capability PRESENT when its selector is in bytecode", () => {
    const findings = detectPermissions(codeWith([MINT]));
    const mint = findingFor(findings, "mint");
    expect(mint.state).toBe("PRESENT");
    expect(mint.matchedSelectors).toContain(MINT.toLowerCase());
  });

  it("marks a capability ABSENT when bytecode lacks its selector", () => {
    const findings = detectPermissions(codeWith([MINT]));
    expect(findingFor(findings, "pause").state).toBe("ABSENT");
  });

  it("marks every capability UNKNOWN when bytecode is unavailable", () => {
    for (const finding of detectPermissions(null)) {
      expect(finding.state).toBe("UNKNOWN");
    }
    for (const finding of detectPermissions("0x")) {
      expect(finding.state).toBe("UNKNOWN");
    }
  });
});

describe("classifyVerification", () => {
  it("is UNKNOWN when the explorer had no answer", () => {
    expect(classifyVerification(null).status).toBe("UNKNOWN");
  });

  it("is UNVERIFIED for the explorer's unverified sentinel", () => {
    const result = classifyVerification({
      ABI: "Contract source code not verified"
    });
    expect(result.status).toBe("UNVERIFIED");
  });

  it("is VERIFIED with proxy metadata when source is present", () => {
    const result = classifyVerification({
      ABI: "[{\"type\":\"function\"}]",
      Proxy: "1",
      Implementation: addr("cc")
    });
    expect(result.status).toBe("VERIFIED");
    expect(result.isProxy).toBe(true);
    expect(result.implementation).toBe(addr("cc"));
  });
});

describe("classifySimulation", () => {
  it("passes a clean round trip and computes sell loss", () => {
    const result = classifySimulation(rawSim());
    expect(result.status).toBe("PASS");
    expect(result.buyStatus).toBe("PASS");
    expect(result.sellStatus).toBe("PASS");
    expect(result.effectiveSellLossBps).toBe(100); // 1% of 1e6
  });

  it("fails when the sell leg reverts", () => {
    const result = classifySimulation(rawSim({ sellReverted: true }));
    expect(result.status).toBe("FAIL");
    expect(result.sellStatus).toBe("FAIL");
    expect(result.reasons.join(" ")).toContain("Sell");
  });

  it("fails when sell loss meets the untradeable threshold", () => {
    const result = classifySimulation(
      rawSim({ sellQuoteOutRaw: 100_000n }), // 90% loss vs 1e6 spot
      { maxSellLossBps: 5_000 }
    );
    expect(result.status).toBe("FAIL");
    expect(result.effectiveSellLossBps).toBe(9_000);
  });

  it("is UNKNOWN when outputs are missing without a revert", () => {
    const result = classifySimulation(
      rawSim({ buyBaseOutRaw: null, sellQuoteOutRaw: null })
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.buyStatus).toBe("UNKNOWN");
  });
});

describe("assessRisk status precedence", () => {
  const cleanProxy = { isProxy: false, kind: "none" as const, implementation: null };
  const verified = {
    status: "VERIFIED" as const,
    isProxy: false,
    implementation: null
  };
  const absentPerms = detectPermissions(codeWith([]));

  it("PASSES only with a passing sim and no critical permission", () => {
    const result = assessRisk({
      verification: verified,
      proxy: cleanProxy,
      permissions: absentPerms,
      simulation: classifySimulation(rawSim())
    });
    expect(result.status).toBe("PASS");
  });

  it("FAILS when a critical permission is present, even if sim passes", () => {
    const result = assessRisk({
      verification: verified,
      proxy: cleanProxy,
      permissions: detectPermissions(codeWith([PAUSE])),
      simulation: classifySimulation(rawSim())
    });
    expect(result.status).toBe("FAIL");
  });

  it("is UNKNOWN when no simulation was performed", () => {
    const result = assessRisk({
      verification: verified,
      proxy: cleanProxy,
      permissions: absentPerms,
      simulation: null
    });
    expect(result.status).toBe("UNKNOWN");
  });

  it("never PASSES when critical-permission analysis is unknown", () => {
    const result = assessRisk({
      verification: verified,
      proxy: cleanProxy,
      permissions: detectPermissions(null),
      simulation: classifySimulation(rawSim())
    });
    expect(result.status).toBe("UNKNOWN");
  });

  it("FAILS when the simulation fails and no permission is critical", () => {
    const result = assessRisk({
      verification: verified,
      proxy: cleanProxy,
      permissions: absentPerms,
      simulation: classifySimulation(rawSim({ sellReverted: true }))
    });
    expect(result.status).toBe("FAIL");
  });
});

describe("effectiveRiskStatus staleness", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");
  const maxAgeMs = 60 * 60 * 1000;

  it("keeps a fresh verdict", () => {
    const assessedAt = new Date(now.getTime() - 10 * 60 * 1000);
    expect(effectiveRiskStatus("PASS", assessedAt, now, maxAgeMs)).toBe("PASS");
  });

  it("marks an old verdict STALE", () => {
    const assessedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    expect(effectiveRiskStatus("PASS", assessedAt, now, maxAgeMs)).toBe("STALE");
  });

  it("preserves ERROR regardless of age", () => {
    const assessedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    expect(effectiveRiskStatus("ERROR", assessedAt, now, maxAgeMs)).toBe("ERROR");
  });
});
