import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { generateBrief } from "../src/engine.js";
import { createFakeLlmClient } from "../src/llm.js";
import type {
  CitedRowFetcher,
  EvidenceBundle,
  GenerateBriefDeps,
  JudgmentToolkit,
  LlmClient,
  PromptSpec,
  ToolExecutionResult
} from "../src/types.js";

/** Minimal, render-safe evidence bundle — no DB, no alert, empty history. */
function makeBundle(): EvidenceBundle {
  return {
    chainId: 1,
    mode: "REPLAY",
    asOf: new Date("2026-01-01T00:00:00Z"),
    alert: null,
    token: {
      address: "0xtoken",
      decimals: 18,
      totalSupply: "1000000",
      deployerAddress: null,
      deployerStatus: null,
      name: null,
      symbol: null
    },
    pool: {
      address: "0xpool",
      dex: "uniswap-v2",
      kind: "AMM",
      createdAtBlock: "100",
      discoveredAt: new Date("2026-01-01T00:00:00Z"),
      quoteTokenAddress: "0xweth"
    },
    marketSeries: [],
    activity: null,
    holders: null,
    risk: null,
    simulation: null
  };
}

const PROMPT: PromptSpec = {
  name: "test-prompt",
  version: 1,
  template: "You are a research briefer. Output only the JSON object.",
  templateHash: "deadbeef"
};

/** A single evidence pointer reused across the payload's citation clauses. */
const POINTER = { table: "pool_snapshots", rowId: "1", field: "priceUsd", claimedValue: "1.23" };

function validPayload(overrides?: { riskCallEvidence?: typeof POINTER }): Record<string, unknown> {
  const riskEvidence = overrides?.riskCallEvidence ?? POINTER;
  return {
    thesis: "Healthy liquidity growth with a concentrated but plausible holder base.",
    thesisEvidence: [POINTER],
    confidenceBps: 6000,
    riskCalls: [
      {
        risk: "Deployer retains a large allocation",
        tag: "CONCENTRATION_DUMP",
        severity: "MEDIUM",
        evidence: [riskEvidence]
      },
      {
        risk: "No sell-side liquidity test yet",
        tag: "NO_FOLLOW_THROUGH",
        severity: "LOW",
        evidence: [POINTER]
      },
      {
        risk: "LP could be pulled without a lock",
        tag: "RUG_LP_PULL",
        severity: "HIGH",
        evidence: [POINTER]
      }
    ],
    disconfirming: [],
    whatWouldChangeThisCall: ["Quote liquidity drops below $5k within one hour"],
    recommendation: "WATCH"
  };
}

function makeToolkit(execute: JudgmentToolkit["execute"]): JudgmentToolkit {
  return {
    defs: [
      {
        name: "marketSeries",
        description: "windowed downsample of the pool's market series",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    ],
    execute
  };
}

/** fetchCitedRow stub that always returns the same row, matching POINTER. */
const matchingFetchCitedRow: CitedRowFetcher = () => Promise.resolve({ priceUsd: 1.23 });

function baseDeps(overrides: Partial<GenerateBriefDeps>): GenerateBriefDeps {
  return {
    llm: createFakeLlmClient([]),
    model: "test-model",
    toolkit: makeToolkit(() =>
      Promise.resolve({ resultJson: "{}", resultRowIds: [], isError: false })
    ),
    bundle: makeBundle(),
    prompt: PROMPT,
    fetchCitedRow: matchingFetchCitedRow,
    ...overrides
  };
}

describe("generateBrief", () => {
  it("happy path: one tool round then a valid payload -> COMPLETED with an audited tool trace", async () => {
    const toolResult: ToolExecutionResult = {
      resultJson: JSON.stringify({ points: [{ priceUsd: 1.23, ref: "pool_snapshots:1" }] }),
      resultRowIds: ["pool_snapshots:1"],
      isError: false
    };
    const execute = vi.fn(() => Promise.resolve(toolResult));
    const llm = createFakeLlmClient([
      { toolCalls: [{ id: "call_1", name: "marketSeries", argsJson: '{"fromMinutes":0}' }] },
      { content: JSON.stringify(validPayload()) }
    ]);

    const result = await generateBrief(
      baseDeps({ llm, toolkit: makeToolkit(execute) })
    );

    expect(result.status).toBe("COMPLETED");
    expect(result.error).toBeNull();
    expect(result.payload?.recommendation).toBe("WATCH");
    expect(execute).toHaveBeenCalledWith("marketSeries", '{"fromMinutes":0}');

    expect(result.toolTrace).toHaveLength(1);
    const entry = result.toolTrace[0]!;
    expect(entry.seq).toBe(1);
    expect(entry.toolName).toBe("marketSeries");
    expect(entry.resultRowIds).toEqual(["pool_snapshots:1"]);
    expect(entry.isError).toBe(false);
    expect(entry.resultDigest).toBe(
      createHash("sha256").update(toolResult.resultJson, "utf8").digest("hex")
    );
    expect(entry.latencyMs).toBeGreaterThanOrEqual(0);

    expect(result.citationReport).not.toBeNull();
    expect(result.citationReport?.verdict).toBe("OK");
    expect(result.citationReport?.loadBearingFailures).toBe(0);
    expect(result.citationReport?.total).toBe(result.citationReport?.verified);
  });

  it("labels tool results with a citable callRef and verifies tool-derived citations", async () => {
    const toolResult: ToolExecutionResult = {
      resultJson: JSON.stringify({ available: true, tokenCount: 3 }),
      resultRowIds: [],
      isError: false
    };
    const llm = createFakeLlmClient([
      { toolCalls: [{ id: "call_1", name: "marketSeries", argsJson: "{}" }] },
      {
        content: JSON.stringify(
          validPayload({
            riskCallEvidence: {
              table: "judgment_tool_calls",
              rowId: "1",
              field: "tokenCount",
              claimedValue: "3"
            }
          })
        )
      }
    ]);

    const result = await generateBrief(
      baseDeps({ llm, toolkit: makeToolkit(() => Promise.resolve(toolResult)) })
    );

    // The model saw the result labeled with its citable ref…
    const toolMessage = llm.requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toBe(
      `{"callRef":"judgment_tool_calls:1","result":${toolResult.resultJson}}`
    );
    // …the trace preserves the exact result bytes the digest hashed…
    expect(result.toolTrace[0]?.resultJson).toBe(toolResult.resultJson);
    // …and a load-bearing claim citing the tool value verifies end-to-end.
    expect(result.status).toBe("COMPLETED");
    expect(result.citationReport?.verdict).toBe("OK");
  });

  it("fabricated load-bearing citation -> REJECTED_FABRICATED_CITATION with the citationReport preserved", async () => {
    const mismatched = { ...POINTER, claimedValue: "999" };
    const llm = createFakeLlmClient([
      { content: JSON.stringify(validPayload({ riskCallEvidence: mismatched })) }
    ]);

    const result = await generateBrief(baseDeps({ llm }));

    expect(result.status).toBe("REJECTED_FABRICATED_CITATION");
    expect(result.payload).not.toBeNull();
    expect(result.citationReport).not.toBeNull();
    expect(result.citationReport?.verdict).toBe("REJECT");
    expect(result.citationReport?.loadBearingFailures).toBeGreaterThan(0);
    const failedCheck = result.citationReport?.checks.find((c) => !c.verified);
    expect(failedCheck?.reason).toBe("VALUE_MISMATCH");
  });

  it("invalid JSON payload -> FAILED with a parse error and no citation report", async () => {
    const llm = createFakeLlmClient([{ content: "this is not json" }]);

    const result = await generateBrief(baseDeps({ llm }));

    expect(result.status).toBe("FAILED");
    expect(result.payload).toBeNull();
    expect(result.citationReport).toBeNull();
    expect(result.error).toBeTruthy();
    expect(result.toolTrace).toHaveLength(0);
  });

  it("enforces the tool-round cap: sends one final no-tools request after maxToolRounds", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ resultJson: "{}", resultRowIds: [], isError: false })
    );
    const llm = createFakeLlmClient([
      { toolCalls: [{ id: "call_1", name: "marketSeries", argsJson: "{}" }] },
      { toolCalls: [{ id: "call_2", name: "marketSeries", argsJson: "{}" }] },
      { content: JSON.stringify(validPayload()) }
    ]);

    const result = await generateBrief(
      baseDeps({ llm, toolkit: makeToolkit(execute), config: { maxToolRounds: 2 } })
    );

    expect(llm.requests).toHaveLength(3);
    expect(llm.requests[0]?.tools).toBeDefined();
    expect(llm.requests[1]?.tools).toBeDefined();
    expect(llm.requests[2]?.tools).toBeUndefined();
    expect(
      llm.requests[2]?.messages.some(
        (m) => m.role === "user" && m.content.includes("maximum number")
      )
    ).toBe(true);

    expect(result.toolTrace).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("COMPLETED");
    expect(result.payload?.recommendation).toBe("WATCH");
  });

  it("LLM transport failure -> FAILED with the error message, never throws", async () => {
    const throwingLlm: LlmClient = {
      complete: () => Promise.reject(new Error("upstream 503"))
    };

    const result = await generateBrief(baseDeps({ llm: throwingLlm }));

    expect(result.status).toBe("FAILED");
    expect(result.payload).toBeNull();
    expect(result.citationReport).toBeNull();
    expect(result.error).toContain("upstream 503");
    expect(result.toolTrace).toHaveLength(0);
  });

  it("aggregates tokensIn/tokensOut across every LLM round, including the forced final request", async () => {
    const probe = createFakeLlmClient([{ content: "{}" }]);
    const single = await probe.complete({ model: "m", messages: [] });

    const execute = vi.fn(() =>
      Promise.resolve({ resultJson: "{}", resultRowIds: [], isError: false })
    );
    const llm = createFakeLlmClient([
      { toolCalls: [{ id: "call_1", name: "marketSeries", argsJson: "{}" }] },
      { content: JSON.stringify(validPayload()) }
    ]);

    const result = await generateBrief(
      baseDeps({ llm, toolkit: makeToolkit(execute) })
    );

    expect(llm.requests).toHaveLength(2);
    expect(result.tokensIn).toBe(single.tokensIn * 2);
    expect(result.tokensOut).toBe(single.tokensOut * 2);
  });

  it("never throws when the toolkit reports an error result — the LLM sees it and can recover", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ resultJson: '{"error":"bad args"}', resultRowIds: [], isError: true })
    );
    const llm = createFakeLlmClient([
      { toolCalls: [{ id: "call_1", name: "marketSeries", argsJson: "{}" }] },
      { content: JSON.stringify(validPayload()) }
    ]);

    const result = await generateBrief(
      baseDeps({ llm, toolkit: makeToolkit(execute) })
    );

    expect(result.toolTrace[0]?.isError).toBe(true);
    expect(result.status).toBe("COMPLETED");
  });
});
