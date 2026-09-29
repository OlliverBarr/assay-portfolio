import {
  CITABLE_TABLES,
  DEFAULT_CITATION_TOLERANCE,
  TOOL_CALL_CITATION_TABLE,
  type CitableTable,
  type CitationCheck,
  type CitationReport,
  type CitationTolerance,
  type CitedRowFetcher,
  type EvidencePointer,
  type JudgmentBriefPayload,
  type ToolTraceEntry
} from "./types.js";

const CITABLE_TABLE_LOOKUP: Record<string, true> = Object.fromEntries(
  CITABLE_TABLES.map((table) => [table, true] as const)
);

function isCitableTable(table: string): table is CitableTable {
  return CITABLE_TABLE_LOOKUP[table] === true;
}

const DECIMAL_ROW_ID = /^\d+$/;

/** One (claimKey, pointer) pair pending verification. */
interface CitationEntry {
  readonly claimKey: string;
  readonly pointer: EvidencePointer;
}

/** Every pointer in the payload, tagged with its owning clause. */
function collectEntries(payload: JudgmentBriefPayload): readonly CitationEntry[] {
  const entries: CitationEntry[] = [];
  for (const pointer of payload.thesisEvidence) {
    entries.push({ claimKey: "thesis", pointer });
  }
  payload.riskCalls.forEach((call, index) => {
    for (const pointer of call.evidence) {
      entries.push({ claimKey: `riskCalls[${index}]`, pointer });
    }
  });
  payload.disconfirming.forEach((claim, index) => {
    for (const pointer of claim.evidence) {
      entries.push({ claimKey: `disconfirming[${index}]`, pointer });
    }
  });
  return entries;
}

/** True when `claimKey` names a clause that gates the citation verdict. */
function isLoadBearing(claimKey: string): boolean {
  return claimKey === "thesis" || claimKey.startsWith("riskCalls[");
}

/**
 * Coerces a re-fetched column value to a finite comparison number. Drizzle
 * surfaces numeric/decimal columns as strings (e.g.
 * `"12345.000000000000000000"`) and bigint columns as JS `bigint`; both are
 * accepted alongside plain `number`. Anything else (including `Date`,
 * `boolean`, and non-numeric strings/enums) is not numerically comparable.
 */
function toComparableNumber(actual: unknown): number | null {
  if (typeof actual === "number") {
    return Number.isFinite(actual) ? actual : null;
  }
  if (typeof actual === "bigint") {
    return Number(actual);
  }
  if (typeof actual === "string") {
    const trimmed = actual.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Parses a claimed string as a finite number, or null when unparseable. */
function parseClaimedNumber(claimed: string): number | null {
  if (claimed.length === 0) return null;
  const parsed = Number(claimed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Stringifies a re-fetched value for exact (trimmed) comparison/reporting. */
function toComparableString(actual: unknown): string {
  if (typeof actual === "string") return actual.trim();
  if (typeof actual === "boolean") return String(actual);
  if (typeof actual === "bigint") return actual.toString();
  if (typeof actual === "number") return String(actual);
  if (actual === null || actual === undefined) return "";
  return String(actual);
}

/** "YYYY-MM-DDTHH:MM" minute-precision prefix of an ISO-8601 string. */
function isoMinutePrefix(iso: string): string {
  return iso.slice(0, 16);
}

function withinRelativeTolerance(
  claimed: number,
  actual: number,
  relativeBps: number
): boolean {
  if (claimed === actual) return true;
  const denominator = actual === 0 ? Math.abs(claimed) : Math.abs(actual);
  if (denominator === 0) return false;
  const deviationBps = (Math.abs(claimed - actual) / denominator) * 10_000;
  return deviationBps <= relativeBps;
}

/**
 * Compares a claimed string value against a re-fetched column value.
 * Numeric-looking values (on both sides) compare within
 * `tolerance.relativeBps`; `Date` values compare by minute-precision ISO
 * prefix; everything else (booleans, enums, non-numeric strings, and claims
 * like "1.5%" that fail to parse as a plain number) compares as an exact
 * trimmed string match.
 */
function compareValues(
  claimedValue: string,
  actual: unknown,
  tolerance: CitationTolerance
): boolean {
  const claimed = claimedValue.trim();
  if (actual instanceof Date) {
    return isoMinutePrefix(actual.toISOString()) === isoMinutePrefix(claimed);
  }
  if (Array.isArray(actual)) {
    // jsonb array columns (e.g. token_risks.riskReasons): a claim verifies
    // against the full serialization or against exactly one element — citing
    // a single risk reason out of the array is honest, not fabricated.
    if (claimed === toComparableString(actual)) return true;
    return actual.some((element) => compareValues(claimedValue, element, tolerance));
  }
  const actualNumber = toComparableNumber(actual);
  const claimedNumber = actualNumber === null ? null : parseClaimedNumber(claimed);
  if (actualNumber !== null && claimedNumber !== null) {
    return withinRelativeTolerance(claimedNumber, actualNumber, tolerance.relativeBps);
  }
  return claimed === toComparableString(actual);
}

/**
 * Resolves a `judgment_tool_calls:<seq>` pointer against the in-memory tool
 * trace of the same generation attempt. The citable surface is the top-level
 * keys of the result object the model was shown (nested values compare by
 * JSON serialization). Never re-executes a tool: results may be
 * time-sensitive (e.g. "current" liquidity), so the only honest comparison
 * is against the bytes the model actually received.
 */
function verifyToolCallEntry(
  entry: CitationEntry,
  trace: readonly ToolTraceEntry[],
  parsedResults: Map<number, Record<string, unknown> | undefined>,
  tolerance: CitationTolerance
): CitationCheck {
  const { claimKey, pointer } = entry;
  if (!DECIMAL_ROW_ID.test(pointer.rowId)) {
    return { claimKey, pointer, verified: false, actualValue: null, reason: "ROW_NOT_FOUND" };
  }
  const seq = Number(pointer.rowId);
  const traceEntry = trace.find((candidate) => candidate.seq === seq);
  if (traceEntry === undefined) {
    return { claimKey, pointer, verified: false, actualValue: null, reason: "ROW_NOT_FOUND" };
  }
  if (!parsedResults.has(seq)) {
    let parsed: Record<string, unknown> | undefined;
    try {
      const raw: unknown = JSON.parse(traceEntry.resultJson);
      parsed =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : undefined;
    } catch {
      parsed = undefined;
    }
    parsedResults.set(seq, parsed);
  }
  const result = parsedResults.get(seq);
  if (result === undefined || !Object.prototype.hasOwnProperty.call(result, pointer.field)) {
    return { claimKey, pointer, verified: false, actualValue: null, reason: "FIELD_NOT_FOUND" };
  }
  const actual = result[pointer.field];
  const comparable =
    typeof actual === "object" && actual !== null && !Array.isArray(actual)
      ? JSON.stringify(actual)
      : actual;
  const actualValue = toComparableString(comparable);
  const matches = compareValues(pointer.claimedValue, comparable, tolerance);
  return {
    claimKey,
    pointer,
    verified: matches,
    actualValue,
    reason: matches ? "OK" : "VALUE_MISMATCH"
  };
}

async function verifyEntry(
  entry: CitationEntry,
  fetchCached: (table: CitableTable, rowId: bigint) => Promise<Record<string, unknown> | undefined>,
  tolerance: CitationTolerance
): Promise<CitationCheck> {
  const { claimKey, pointer } = entry;

  if (!isCitableTable(pointer.table)) {
    return { claimKey, pointer, verified: false, actualValue: null, reason: "UNKNOWN_TABLE" };
  }
  if (!DECIMAL_ROW_ID.test(pointer.rowId)) {
    return { claimKey, pointer, verified: false, actualValue: null, reason: "ROW_NOT_FOUND" };
  }

  const row = await fetchCached(pointer.table, BigInt(pointer.rowId));
  if (row === undefined) {
    return { claimKey, pointer, verified: false, actualValue: null, reason: "ROW_NOT_FOUND" };
  }
  if (!Object.prototype.hasOwnProperty.call(row, pointer.field)) {
    return { claimKey, pointer, verified: false, actualValue: null, reason: "FIELD_NOT_FOUND" };
  }

  const actual = row[pointer.field];
  const actualValue = toComparableString(actual instanceof Date ? actual.toISOString() : actual);
  const matches = compareValues(pointer.claimedValue, actual, tolerance);
  return {
    claimKey,
    pointer,
    verified: matches,
    actualValue,
    reason: matches ? "OK" : "VALUE_MISMATCH"
  };
}

/**
 * Re-fetches and machine-verifies every evidence pointer in a brief
 * (thesisEvidence + riskCalls[*].evidence + disconfirming[*].evidence).
 * DB-table pointers re-fetch their append-only row; `judgment_tool_calls`
 * pointers verify against the audited tool trace of this same attempt.
 * Each distinct `(table, rowId)` pair is fetched at most once, even when
 * multiple clauses cite the same row. The verdict is REJECT iff any
 * load-bearing clause (thesis or a riskCall) has a failed citation — a
 * disconfirming-only failure never gates the brief.
 */
export async function checkCitations(
  payload: JudgmentBriefPayload,
  fetchRow: CitedRowFetcher,
  tolerance: CitationTolerance = DEFAULT_CITATION_TOLERANCE,
  toolTrace: readonly ToolTraceEntry[] = []
): Promise<CitationReport> {
  const rowCache = new Map<string, Promise<Record<string, unknown> | undefined>>();
  const fetchCached = (
    table: CitableTable,
    rowId: bigint
  ): Promise<Record<string, unknown> | undefined> => {
    const key = `${table}:${rowId.toString()}`;
    const cached = rowCache.get(key);
    if (cached !== undefined) return cached;
    const pending = fetchRow(table, rowId);
    rowCache.set(key, pending);
    return pending;
  };

  const parsedToolResults = new Map<number, Record<string, unknown> | undefined>();
  const entries = collectEntries(payload);
  const checks = await Promise.all(
    entries.map((entry) =>
      entry.pointer.table === TOOL_CALL_CITATION_TABLE
        ? Promise.resolve(verifyToolCallEntry(entry, toolTrace, parsedToolResults, tolerance))
        : verifyEntry(entry, fetchCached, tolerance)
    )
  );

  let verified = 0;
  let loadBearingFailures = 0;
  for (const check of checks) {
    if (check.verified) {
      verified++;
    } else if (isLoadBearing(check.claimKey)) {
      loadBearingFailures++;
    }
  }

  return {
    checks,
    total: checks.length,
    verified,
    loadBearingFailures,
    verdict: loadBearingFailures > 0 ? "REJECT" : "OK"
  };
}
