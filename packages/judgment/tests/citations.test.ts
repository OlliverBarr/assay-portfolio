import { describe, expect, it } from "vitest";

import { checkCitations } from "../src/citations.js";
import type {
  CitedRowFetcher,
  EvidencePointer,
  JudgmentBriefPayload,
  RiskCall,
  ToolTraceEntry
} from "../src/types.js";

/** Records every (table, rowId) it is asked for; answers from a fixed table. */
function createFetchRowStub(rows: Record<string, Record<string, unknown>>): {
  readonly fetchRow: CitedRowFetcher;
  readonly calls: readonly string[];
} {
  const calls: string[] = [];
  const fetchRow: CitedRowFetcher = (table, rowId) => {
    const key = `${table}:${rowId.toString()}`;
    calls.push(key);
    return Promise.resolve(rows[key]);
  };
  return { fetchRow, calls };
}

function pointer(overrides: Partial<EvidencePointer> = {}): EvidencePointer {
  return {
    table: "pool_snapshots",
    rowId: "1",
    field: "priceUsd",
    claimedValue: "1.23",
    ...overrides
  };
}

function riskCall(overrides: Partial<RiskCall> = {}): RiskCall {
  return {
    risk: "Deployer controls a large share of supply",
    tag: "CONCENTRATION_DUMP",
    severity: "HIGH",
    evidence: [pointer()],
    ...overrides
  };
}

function payload(overrides: Partial<JudgmentBriefPayload> = {}): JudgmentBriefPayload {
  return {
    thesis: "Organic buy pressure with no immediate red flags.",
    thesisEvidence: [],
    confidenceBps: 6_000,
    riskCalls: [],
    disconfirming: [],
    whatWouldChangeThisCall: [],
    recommendation: "WATCH",
    ...overrides
  };
}

describe("checkCitations — value comparison", () => {
  it("verifies an exact non-numeric string match", async () => {
    const { fetchRow } = createFetchRowStub({
      "token_risks:1": { verdict: "PASS" }
    });
    const report = await checkCitations(
      payload({
        thesisEvidence: [
          pointer({ table: "token_risks", rowId: "1", field: "verdict", claimedValue: "PASS" })
        ]
      }),
      fetchRow
    );
    expect(report.checks[0]?.reason).toBe("OK");
    expect(report.checks[0]?.verified).toBe(true);
    expect(report.verdict).toBe("OK");
  });

  it("passes a numeric claim within the default 100bps tolerance", async () => {
    const { fetchRow } = createFetchRowStub({
      "pool_snapshots:1": { priceUsd: "41003.000000000000000000" }
    });
    const report = await checkCitations(
      payload({
        thesisEvidence: [pointer({ claimedValue: "41000" })]
      }),
      fetchRow
    );
    expect(report.checks[0]?.reason).toBe("OK");
    expect(report.checks[0]?.verified).toBe(true);
    expect(report.checks[0]?.actualValue).toBe("41003.000000000000000000");
  });

  it("fails a numeric claim outside the default 100bps tolerance", async () => {
    const { fetchRow } = createFetchRowStub({
      "pool_snapshots:1": { priceUsd: "41003.000000000000000000" }
    });
    const report = await checkCitations(
      payload({
        thesisEvidence: [pointer({ claimedValue: "45000" })]
      }),
      fetchRow
    );
    expect(report.checks[0]?.reason).toBe("VALUE_MISMATCH");
    expect(report.checks[0]?.verified).toBe(false);
  });

  it("honors an explicit wider tolerance", async () => {
    const { fetchRow } = createFetchRowStub({
      "pool_snapshots:1": { priceUsd: "41003" }
    });
    const report = await checkCitations(
      payload({ thesisEvidence: [pointer({ claimedValue: "45000" })] }),
      fetchRow,
      { relativeBps: 2_000 }
    );
    expect(report.checks[0]?.reason).toBe("OK");
  });

  it("compares Date actuals by minute-precision ISO prefix", async () => {
    const { fetchRow } = createFetchRowStub({
      "pool_snapshots:1": { capturedAt: new Date("2026-07-11T10:30:45.123Z") }
    });
    const report = await checkCitations(
      payload({
        thesisEvidence: [
          pointer({ field: "capturedAt", claimedValue: "2026-07-11T10:30" })
        ]
      }),
      fetchRow
    );
    expect(report.checks[0]?.reason).toBe("OK");
  });

  it("treats an unparseable percentage claim as an exact-match failure", async () => {
    const { fetchRow } = createFetchRowStub({
      "pool_snapshots:1": { slippageBps: 150 }
    });
    const report = await checkCitations(
      payload({
        thesisEvidence: [
          pointer({ field: "slippageBps", claimedValue: "1.5%" })
        ]
      }),
      fetchRow
    );
    expect(report.checks[0]?.reason).toBe("VALUE_MISMATCH");
  });
});

describe("checkCitations — failure reasons", () => {
  it("reports ROW_NOT_FOUND when the fetcher returns undefined", async () => {
    const { fetchRow } = createFetchRowStub({});
    const report = await checkCitations(
      payload({ thesisEvidence: [pointer({ rowId: "999" })] }),
      fetchRow
    );
    expect(report.checks[0]).toMatchObject({
      reason: "ROW_NOT_FOUND",
      verified: false,
      actualValue: null
    });
  });

  it("reports FIELD_NOT_FOUND when the row lacks the claimed field", async () => {
    const { fetchRow } = createFetchRowStub({
      "pool_snapshots:1": { fdvUsd: "1000" }
    });
    const report = await checkCitations(
      payload({ thesisEvidence: [pointer({ field: "priceUsd" })] }),
      fetchRow
    );
    expect(report.checks[0]).toMatchObject({
      reason: "FIELD_NOT_FOUND",
      verified: false,
      actualValue: null
    });
  });

  it("reports UNKNOWN_TABLE for a table outside CITABLE_TABLES without fetching", async () => {
    const { fetchRow, calls } = createFetchRowStub({});
    const report = await checkCitations(
      payload({ thesisEvidence: [pointer({ table: "tokens" })] }),
      fetchRow
    );
    expect(report.checks[0]).toMatchObject({
      reason: "UNKNOWN_TABLE",
      verified: false,
      actualValue: null
    });
    expect(calls).toHaveLength(0);
  });
});

describe("checkCitations — load-bearing verdict", () => {
  it("REJECTs when a thesis citation fails", async () => {
    const { fetchRow } = createFetchRowStub({});
    const report = await checkCitations(
      payload({ thesisEvidence: [pointer({ rowId: "404" })] }),
      fetchRow
    );
    expect(report.loadBearingFailures).toBe(1);
    expect(report.verdict).toBe("REJECT");
  });

  it("REJECTs when a riskCalls citation fails", async () => {
    const { fetchRow } = createFetchRowStub({});
    const report = await checkCitations(
      payload({ riskCalls: [riskCall({ evidence: [pointer({ rowId: "404" })] })] }),
      fetchRow
    );
    expect(report.loadBearingFailures).toBe(1);
    expect(report.verdict).toBe("REJECT");
  });

  it("stays OK when only a disconfirming citation fails", async () => {
    const { fetchRow } = createFetchRowStub({
      "pool_snapshots:1": { priceUsd: "1.23" }
    });
    const report = await checkCitations(
      payload({
        thesisEvidence: [pointer()],
        disconfirming: [
          { claim: "Volume looks thin", evidence: [pointer({ rowId: "404" })] }
        ]
      }),
      fetchRow
    );
    expect(report.loadBearingFailures).toBe(0);
    expect(report.verdict).toBe("OK");
    expect(report.verified).toBe(1);
    expect(report.total).toBe(2);
  });
});

describe("checkCitations — fetch dedup", () => {
  it("fetches each distinct (table, rowId) at most once", async () => {
    const { fetchRow, calls } = createFetchRowStub({
      "pool_snapshots:1": { priceUsd: "1.23", fdvUsd: "9999" }
    });
    const report = await checkCitations(
      payload({
        thesisEvidence: [pointer({ field: "priceUsd" })],
        riskCalls: [
          riskCall({ evidence: [pointer({ field: "fdvUsd", claimedValue: "9999" })] })
        ]
      }),
      fetchRow
    );
    expect(calls).toEqual(["pool_snapshots:1"]);
    expect(report.total).toBe(2);
    expect(report.verified).toBe(2);
  });
});

function traceEntry(overrides: Partial<ToolTraceEntry> = {}): ToolTraceEntry {
  return {
    seq: 1,
    toolName: "deployerHistory",
    argsJson: "{}",
    resultRowIds: [],
    resultJson: JSON.stringify({ available: true, tokenCount: 3, drawdownFromPeakBps: 1000 }),
    resultDigest: "test-digest",
    latencyMs: 5,
    isError: false,
    ...overrides
  };
}

describe("checkCitations — tool-call citations", () => {
  it("verifies a claim against a top-level tool result key without touching the DB", async () => {
    const { fetchRow, calls } = createFetchRowStub({});
    const report = await checkCitations(
      payload({
        thesisEvidence: [
          pointer({
            table: "judgment_tool_calls",
            rowId: "1",
            field: "tokenCount",
            claimedValue: "3"
          })
        ]
      }),
      fetchRow,
      undefined,
      [traceEntry()]
    );
    expect(report.checks[0]?.reason).toBe("OK");
    expect(report.verdict).toBe("OK");
    expect(calls).toEqual([]);
  });

  it("applies the numeric tolerance to tool result values", async () => {
    const { fetchRow } = createFetchRowStub({});
    const report = await checkCitations(
      payload({
        thesisEvidence: [
          pointer({
            table: "judgment_tool_calls",
            rowId: "1",
            field: "drawdownFromPeakBps",
            claimedValue: "1005"
          })
        ]
      }),
      fetchRow,
      undefined,
      [traceEntry()]
    );
    expect(report.checks[0]?.reason).toBe("OK");
  });

  it("fails with ROW_NOT_FOUND for a seq absent from the trace", async () => {
    const { fetchRow } = createFetchRowStub({});
    const report = await checkCitations(
      payload({
        thesisEvidence: [
          pointer({ table: "judgment_tool_calls", rowId: "9", field: "tokenCount", claimedValue: "3" })
        ]
      }),
      fetchRow,
      undefined,
      [traceEntry()]
    );
    expect(report.checks[0]?.reason).toBe("ROW_NOT_FOUND");
  });

  it("fails with ROW_NOT_FOUND for a non-decimal rowId", async () => {
    const { fetchRow } = createFetchRowStub({});
    const report = await checkCitations(
      payload({
        thesisEvidence: [
          pointer({
            table: "judgment_tool_calls",
            rowId: "callRef-1",
            field: "tokenCount",
            claimedValue: "3"
          })
        ]
      }),
      fetchRow,
      undefined,
      [traceEntry()]
    );
    expect(report.checks[0]?.reason).toBe("ROW_NOT_FOUND");
  });

  it("fails with FIELD_NOT_FOUND for a key the tool never returned", async () => {
    const { fetchRow } = createFetchRowStub({});
    const report = await checkCitations(
      payload({
        thesisEvidence: [
          pointer({
            table: "judgment_tool_calls",
            rowId: "1",
            field: "peakQuoteLiquidityUsd",
            claimedValue: "50000"
          })
        ]
      }),
      fetchRow,
      undefined,
      [traceEntry()]
    );
    expect(report.checks[0]?.reason).toBe("FIELD_NOT_FOUND");
  });

  it("fails with VALUE_MISMATCH and preserves the actual tool value", async () => {
    const { fetchRow } = createFetchRowStub({});
    const report = await checkCitations(
      payload({
        riskCalls: [
          riskCall({
            evidence: [
              pointer({
                table: "judgment_tool_calls",
                rowId: "1",
                field: "tokenCount",
                claimedValue: "12"
              })
            ]
          })
        ]
      }),
      fetchRow,
      undefined,
      [traceEntry()]
    );
    expect(report.checks[0]?.reason).toBe("VALUE_MISMATCH");
    expect(report.checks[0]?.actualValue).toBe("3");
    expect(report.verdict).toBe("REJECT");
  });

  it("keeps rejecting unknown tables when no trace is supplied", async () => {
    const { fetchRow } = createFetchRowStub({});
    const report = await checkCitations(
      payload({
        thesisEvidence: [
          pointer({
            table: "functions.deployerHistory",
            rowId: "1",
            field: "tokenCount",
            claimedValue: "3"
          })
        ]
      }),
      fetchRow
    );
    expect(report.checks[0]?.reason).toBe("UNKNOWN_TABLE");
  });
});

describe("checkCitations — jsonb array membership", () => {
  it("verifies a claim equal to one array element", async () => {
    const { fetchRow } = createFetchRowStub({
      "token_risks:1": { riskReasons: ["contract source is not verified", "proxy detected"] }
    });
    const report = await checkCitations(
      payload({
        thesisEvidence: [
          pointer({
            table: "token_risks",
            rowId: "1",
            field: "riskReasons",
            claimedValue: "proxy detected"
          })
        ]
      }),
      fetchRow
    );
    expect(report.checks[0]?.reason).toBe("OK");
  });

  it("verifies a claim equal to the full array serialization", async () => {
    const { fetchRow } = createFetchRowStub({
      "token_risks:1": { riskReasons: ["a", "b"] }
    });
    const report = await checkCitations(
      payload({
        thesisEvidence: [
          pointer({ table: "token_risks", rowId: "1", field: "riskReasons", claimedValue: "a,b" })
        ]
      }),
      fetchRow
    );
    expect(report.checks[0]?.reason).toBe("OK");
  });

  it("fails a claim matching no array element", async () => {
    const { fetchRow } = createFetchRowStub({
      "token_risks:1": { riskReasons: ["contract source is not verified"] }
    });
    const report = await checkCitations(
      payload({
        thesisEvidence: [
          pointer({
            table: "token_risks",
            rowId: "1",
            field: "riskReasons",
            claimedValue: "no such reason"
          })
        ]
      }),
      fetchRow
    );
    expect(report.checks[0]?.reason).toBe("VALUE_MISMATCH");
  });
});
