import {
  RISK_TAGS,
  type BriefRecommendation,
  type CitedClaim,
  type EvidencePointer,
  type JudgmentBriefPayload,
  type RiskCall,
  type RiskSeverity,
  type RiskTag
} from "./types.js";

/**
 * Strict parse+validate of the LLM's final JSON payload. Free text or any
 * schema violation is a FAILED generation, never best-effort-parsed or
 * coerced — a briefer that can't produce well-formed, fully-cited output is
 * not trustworthy enough to guess at. Every rejection names the exact rule
 * it violated so failures are triageable without re-reading the raw output.
 */
export type ParseBriefResult =
  | { readonly ok: true; readonly payload: JudgmentBriefPayload }
  | { readonly ok: false; readonly error: string };

const MAX_THESIS_CHARS = 600;
const MAX_LIST_ITEMS = 8;
const MAX_LIST_ITEM_CHARS = 400;
const REQUIRED_RISK_CALLS = 3;

const RISK_TAG_LOOKUP: Record<string, true> = Object.fromEntries(
  RISK_TAGS.map((tag) => [tag, true] as const)
);
const RISK_SEVERITY_LOOKUP: Record<string, true> = {
  LOW: true,
  MEDIUM: true,
  HIGH: true
};
const RECOMMENDATION_LOOKUP: Record<string, true> = {
  RESEARCH: true,
  WATCH: true,
  PASS: true
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Parses one EvidencePointer; every field must be a nonempty string. */
function parseEvidencePointer(
  value: unknown,
  path: string
): EvidencePointer | string {
  if (!isPlainObject(value)) {
    return `EVIDENCE_POINTER_INVALID: ${path} must be an object`;
  }
  const { table, rowId, field, claimedValue } = value;
  if (!isNonEmptyString(table)) {
    return `EVIDENCE_POINTER_INVALID: ${path}.table must be a nonempty string`;
  }
  if (!isNonEmptyString(rowId)) {
    return `EVIDENCE_POINTER_INVALID: ${path}.rowId must be a nonempty string`;
  }
  if (!isNonEmptyString(field)) {
    return `EVIDENCE_POINTER_INVALID: ${path}.field must be a nonempty string`;
  }
  if (!isNonEmptyString(claimedValue)) {
    return `EVIDENCE_POINTER_INVALID: ${path}.claimedValue must be a nonempty string`;
  }
  return { table, rowId, field, claimedValue };
}

function parseEvidenceArray(
  value: unknown,
  path: string
): readonly EvidencePointer[] | string {
  if (!Array.isArray(value)) {
    return `EVIDENCE_ARRAY_INVALID: ${path} must be an array`;
  }
  const pointers: EvidencePointer[] = [];
  for (let i = 0; i < value.length; i++) {
    const parsed = parseEvidencePointer(value[i], `${path}[${i}]`);
    if (typeof parsed === "string") return parsed;
    pointers.push(parsed);
  }
  return pointers;
}

function isRiskTag(value: unknown): value is RiskTag {
  return typeof value === "string" && RISK_TAG_LOOKUP[value] === true;
}

function isRiskSeverity(value: unknown): value is RiskSeverity {
  return typeof value === "string" && RISK_SEVERITY_LOOKUP[value] === true;
}

function parseRiskCall(value: unknown, index: number): RiskCall | string {
  const path = `riskCalls[${index}]`;
  if (!isPlainObject(value)) {
    return `RISK_CALL_INVALID: ${path} must be an object`;
  }
  const { risk, tag, severity, evidence } = value;
  if (!isNonEmptyString(risk)) {
    return `RISK_CALL_INVALID: ${path}.risk must be a nonempty string`;
  }
  if (!isRiskTag(tag)) {
    return `RISK_CALL_TAG_INVALID: ${path}.tag must be one of ${RISK_TAGS.join(", ")}`;
  }
  if (!isRiskSeverity(severity)) {
    return `RISK_CALL_SEVERITY_INVALID: ${path}.severity must be one of LOW, MEDIUM, HIGH`;
  }
  const parsedEvidence = parseEvidenceArray(evidence, `${path}.evidence`);
  if (typeof parsedEvidence === "string") return parsedEvidence;
  if (parsedEvidence.length === 0) {
    return `RISK_CALL_EVIDENCE_EMPTY: ${path}.evidence must contain at least one pointer`;
  }
  return { risk, tag, severity, evidence: parsedEvidence };
}

function parseRiskCalls(value: unknown): readonly RiskCall[] | string {
  if (!Array.isArray(value)) {
    return "RISK_CALLS_INVALID: riskCalls must be an array";
  }
  if (value.length !== REQUIRED_RISK_CALLS) {
    return `RISK_CALLS_COUNT: riskCalls must contain exactly ${REQUIRED_RISK_CALLS} entries`;
  }
  const calls: RiskCall[] = [];
  for (let i = 0; i < value.length; i++) {
    const parsed = parseRiskCall(value[i], i);
    if (typeof parsed === "string") return parsed;
    calls.push(parsed);
  }
  return calls;
}

function parseCitedClaims(
  value: unknown,
  path: string
): readonly CitedClaim[] | string {
  if (!Array.isArray(value)) {
    return `CITED_CLAIM_ARRAY_INVALID: ${path} must be an array`;
  }
  if (value.length > MAX_LIST_ITEMS) {
    return `CITED_CLAIM_ARRAY_TOO_LONG: ${path} must contain at most ${MAX_LIST_ITEMS} items`;
  }
  const claims: CitedClaim[] = [];
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    const itemPath = `${path}[${i}]`;
    if (!isPlainObject(item)) {
      return `CITED_CLAIM_INVALID: ${itemPath} must be an object`;
    }
    const { claim, evidence } = item;
    if (!isNonEmptyString(claim)) {
      return `CITED_CLAIM_INVALID: ${itemPath}.claim must be a nonempty string`;
    }
    if (claim.length > MAX_LIST_ITEM_CHARS) {
      return `CITED_CLAIM_TOO_LONG: ${itemPath}.claim exceeds ${MAX_LIST_ITEM_CHARS} characters`;
    }
    const parsedEvidence = parseEvidenceArray(evidence, `${itemPath}.evidence`);
    if (typeof parsedEvidence === "string") return parsedEvidence;
    claims.push({ claim, evidence: parsedEvidence });
  }
  return claims;
}

function parseStringList(
  value: unknown,
  path: string
): readonly string[] | string {
  if (!Array.isArray(value)) {
    return `STRING_ARRAY_INVALID: ${path} must be an array`;
  }
  if (value.length > MAX_LIST_ITEMS) {
    return `STRING_ARRAY_TOO_LONG: ${path} must contain at most ${MAX_LIST_ITEMS} items`;
  }
  const items: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (!isNonEmptyString(item)) {
      return `STRING_ARRAY_ITEM_INVALID: ${path}[${i}] must be a nonempty string`;
    }
    if (item.length > MAX_LIST_ITEM_CHARS) {
      return `STRING_ARRAY_ITEM_TOO_LONG: ${path}[${i}] exceeds ${MAX_LIST_ITEM_CHARS} characters`;
    }
    items.push(item);
  }
  return items;
}

function isRecommendation(value: unknown): value is BriefRecommendation {
  return typeof value === "string" && RECOMMENDATION_LOOKUP[value] === true;
}

export function parseBriefPayload(json: string): ParseBriefResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: "INVALID_JSON: payload is not valid JSON" };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: "INVALID_SHAPE: payload must be a JSON object" };
  }

  const { thesis } = raw;
  if (!isNonEmptyString(thesis)) {
    return {
      ok: false,
      error: "THESIS_INVALID: thesis must be a nonempty string"
    };
  }
  if (thesis.length > MAX_THESIS_CHARS) {
    return {
      ok: false,
      error: `THESIS_TOO_LONG: thesis exceeds ${MAX_THESIS_CHARS} characters`
    };
  }

  const thesisEvidence = parseEvidenceArray(raw["thesisEvidence"], "thesisEvidence");
  if (typeof thesisEvidence === "string") {
    return { ok: false, error: thesisEvidence };
  }

  const { confidenceBps } = raw;
  if (
    typeof confidenceBps !== "number" ||
    !Number.isInteger(confidenceBps) ||
    confidenceBps < 0 ||
    confidenceBps > 10_000
  ) {
    return {
      ok: false,
      error:
        "CONFIDENCE_OUT_OF_RANGE: confidenceBps must be an integer between 0 and 10000"
    };
  }

  const riskCalls = parseRiskCalls(raw["riskCalls"]);
  if (typeof riskCalls === "string") {
    return { ok: false, error: riskCalls };
  }

  const disconfirming = parseCitedClaims(raw["disconfirming"], "disconfirming");
  if (typeof disconfirming === "string") {
    return { ok: false, error: disconfirming };
  }

  const whatWouldChangeThisCall = parseStringList(
    raw["whatWouldChangeThisCall"],
    "whatWouldChangeThisCall"
  );
  if (typeof whatWouldChangeThisCall === "string") {
    return { ok: false, error: whatWouldChangeThisCall };
  }

  const { recommendation } = raw;
  if (!isRecommendation(recommendation)) {
    return {
      ok: false,
      error:
        "RECOMMENDATION_INVALID: recommendation must be one of RESEARCH, WATCH, PASS"
    };
  }

  return {
    ok: true,
    payload: {
      thesis,
      thesisEvidence,
      confidenceBps,
      riskCalls,
      disconfirming,
      whatWouldChangeThisCall,
      recommendation
    }
  };
}

const EVIDENCE_POINTER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["table", "rowId", "field", "claimedValue"],
  properties: {
    table: { type: "string", minLength: 1 },
    rowId: { type: "string", minLength: 1 },
    field: { type: "string", minLength: 1 },
    claimedValue: { type: "string", minLength: 1 }
  }
};

const CITED_CLAIM_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["claim", "evidence"],
  properties: {
    claim: { type: "string", minLength: 1, maxLength: MAX_LIST_ITEM_CHARS },
    evidence: { type: "array", items: EVIDENCE_POINTER_SCHEMA }
  }
};

const RISK_CALL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["risk", "tag", "severity", "evidence"],
  properties: {
    risk: { type: "string", minLength: 1 },
    tag: { type: "string", enum: [...RISK_TAGS] },
    severity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
    evidence: {
      type: "array",
      items: EVIDENCE_POINTER_SCHEMA,
      minItems: 1
    }
  }
};

/**
 * Draft-07-style JSON schema mirroring {@link JudgmentBriefPayload}, handed
 * to the LLM as `LlmCompletionRequest.responseSchema`. `riskCalls` is
 * pinned to exactly 3 strict entries. Every object level (root included)
 * sets `additionalProperties: false` with a full `required` list — OpenAI
 * strict structured outputs rejects the request otherwise (observed live:
 * 400 "'additionalProperties' is required to be supplied and to be false").
 * `parseBriefPayload` remains the actual source of truth for backends that
 * ignore `strict`.
 */
export const BRIEF_RESPONSE_SCHEMA: Record<string, unknown> = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: [
    "thesis",
    "thesisEvidence",
    "confidenceBps",
    "riskCalls",
    "disconfirming",
    "whatWouldChangeThisCall",
    "recommendation"
  ],
  properties: {
    thesis: { type: "string", minLength: 1, maxLength: MAX_THESIS_CHARS },
    thesisEvidence: { type: "array", items: EVIDENCE_POINTER_SCHEMA },
    confidenceBps: { type: "integer", minimum: 0, maximum: 10_000 },
    riskCalls: {
      type: "array",
      items: RISK_CALL_SCHEMA,
      minItems: REQUIRED_RISK_CALLS,
      maxItems: REQUIRED_RISK_CALLS
    },
    disconfirming: {
      type: "array",
      items: CITED_CLAIM_SCHEMA,
      maxItems: MAX_LIST_ITEMS
    },
    whatWouldChangeThisCall: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
        maxLength: MAX_LIST_ITEM_CHARS
      },
      maxItems: MAX_LIST_ITEMS
    },
    recommendation: { type: "string", enum: ["RESEARCH", "WATCH", "PASS"] }
  }
};
