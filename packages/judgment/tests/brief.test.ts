import { describe, expect, it } from "vitest";

import { BRIEF_RESPONSE_SCHEMA, parseBriefPayload } from "../src/brief.js";
import type { EvidencePointer, JudgmentBriefPayload, RiskCall } from "../src/types.js";

function evidencePointer(overrides: Partial<EvidencePointer> = {}): EvidencePointer {
  return {
    table: "pool_snapshots",
    rowId: "1",
    field: "priceUsd",
    claimedValue: "1.23",
    ...overrides
  };
}

function riskCallInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    risk: "Deployer controls a large share of supply",
    tag: "CONCENTRATION_DUMP",
    severity: "HIGH",
    evidence: [evidencePointer()],
    ...overrides
  };
}

function validRaw(): Record<string, unknown> {
  return {
    thesis: "Organic buy pressure with no immediate red flags.",
    thesisEvidence: [evidencePointer()],
    confidenceBps: 6_500,
    riskCalls: [
      riskCallInput(),
      riskCallInput({ tag: "SELL_RESTRICTION", severity: "MEDIUM" }),
      riskCallInput({ tag: "WASH_COORDINATION", severity: "LOW" })
    ],
    disconfirming: [
      { claim: "Some buys look coordinated", evidence: [evidencePointer()] }
    ],
    whatWouldChangeThisCall: [
      "Quote liquidity drops below $5,000",
      "Deployer wallet moves more than 10% of supply"
    ],
    recommendation: "WATCH"
  };
}

describe("parseBriefPayload — malformed input", () => {
  it("rejects text that is not valid JSON", () => {
    const result = parseBriefPayload("not json{");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^INVALID_JSON:/);
  });

  it("rejects a JSON array (not an object)", () => {
    const result = parseBriefPayload("[]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^INVALID_SHAPE:/);
  });

  it("rejects the wrong number of riskCalls", () => {
    const raw = validRaw();
    raw["riskCalls"] = [riskCallInput(), riskCallInput()];
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^RISK_CALLS_COUNT:/);
  });

  it("rejects a riskCall with no evidence pointers", () => {
    const raw = validRaw();
    const riskCalls = raw["riskCalls"] as Array<Record<string, unknown>>;
    riskCalls[0] = riskCallInput({ evidence: [] });
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^RISK_CALL_EVIDENCE_EMPTY:/);
  });

  it("rejects a riskCall with an invalid tag", () => {
    const raw = validRaw();
    const riskCalls = raw["riskCalls"] as Array<Record<string, unknown>>;
    riskCalls[0] = riskCallInput({ tag: "NOT_A_REAL_TAG" });
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^RISK_CALL_TAG_INVALID:/);
  });

  it("rejects an out-of-range confidenceBps (above 10000)", () => {
    const raw = validRaw();
    raw["confidenceBps"] = 10_001;
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^CONFIDENCE_OUT_OF_RANGE:/);
  });

  it("rejects a negative confidenceBps", () => {
    const raw = validRaw();
    raw["confidenceBps"] = -1;
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^CONFIDENCE_OUT_OF_RANGE:/);
  });

  it("rejects a non-integer confidenceBps", () => {
    const raw = validRaw();
    raw["confidenceBps"] = 55.5;
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^CONFIDENCE_OUT_OF_RANGE:/);
  });

  it("rejects an evidence pointer with a non-string field", () => {
    const raw = validRaw();
    raw["thesisEvidence"] = [evidencePointer({ rowId: 1 as unknown as string })];
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^EVIDENCE_POINTER_INVALID:/);
  });

  it("rejects a missing thesis", () => {
    const raw = validRaw();
    delete raw["thesis"];
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^THESIS_INVALID:/);
  });

  it("rejects a thesis over 600 characters", () => {
    const raw = validRaw();
    raw["thesis"] = "x".repeat(601);
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^THESIS_TOO_LONG:/);
  });

  it("rejects an invalid recommendation", () => {
    const raw = validRaw();
    raw["recommendation"] = "BUY";
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^RECOMMENDATION_INVALID:/);
  });

  it("rejects more than 8 whatWouldChangeThisCall items", () => {
    const raw = validRaw();
    raw["whatWouldChangeThisCall"] = Array.from({ length: 9 }, (_, i) => `event ${i}`);
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^STRING_ARRAY_TOO_LONG:/);
  });
});

describe("parseBriefPayload — valid input", () => {
  it("parses a full valid payload", () => {
    const raw = validRaw();
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload: JudgmentBriefPayload = result.payload;
    expect(payload.thesis).toBe(raw["thesis"]);
    expect(payload.confidenceBps).toBe(6_500);
    expect(payload.riskCalls).toHaveLength(3);
    expect(payload.riskCalls.map((c: RiskCall) => c.tag)).toEqual([
      "CONCENTRATION_DUMP",
      "SELL_RESTRICTION",
      "WASH_COORDINATION"
    ]);
    expect(payload.disconfirming).toHaveLength(1);
    expect(payload.whatWouldChangeThisCall).toHaveLength(2);
    expect(payload.recommendation).toBe("WATCH");
    expect(payload.thesisEvidence[0]).toEqual(evidencePointer());
  });

  it("tolerates unknown extra top-level keys", () => {
    const raw = validRaw();
    raw["someFutureField"] = "ignored";
    const result = parseBriefPayload(JSON.stringify(raw));
    expect(result.ok).toBe(true);
  });
});

describe("BRIEF_RESPONSE_SCHEMA", () => {
  it("pins riskCalls to exactly 3 strict entries", () => {
    const properties = BRIEF_RESPONSE_SCHEMA["properties"] as Record<string, unknown>;
    const riskCallsSchema = properties["riskCalls"] as Record<string, unknown>;
    expect(riskCallsSchema["minItems"]).toBe(3);
    expect(riskCallsSchema["maxItems"]).toBe(3);
    const items = riskCallsSchema["items"] as Record<string, unknown>;
    expect(items["additionalProperties"]).toBe(false);
    expect(items["required"]).toEqual(["risk", "tag", "severity", "evidence"]);
    const itemProperties = items["properties"] as Record<string, unknown>;
    const evidence = itemProperties["evidence"] as Record<string, unknown>;
    expect(evidence["minItems"]).toBe(1);
  });

  it("is strict at the root: OpenAI structured outputs requires additionalProperties:false and a full required list", () => {
    expect(BRIEF_RESPONSE_SCHEMA["additionalProperties"]).toBe(false);
    const properties = BRIEF_RESPONSE_SCHEMA["properties"] as Record<string, unknown>;
    expect((BRIEF_RESPONSE_SCHEMA["required"] as string[]).sort()).toEqual(
      Object.keys(properties).sort()
    );
  });
});
