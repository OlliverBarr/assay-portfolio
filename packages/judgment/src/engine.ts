/**
 * Orchestrates one brief generation attempt: renders the prompt from the
 * evidence bundle, drives the LLM through a bounded LLM<->tool loop, forces
 * a schema-only final answer once the tool-round budget is spent, then
 * parses and citation-checks whatever the model produced. Deliberately
 * never throws — every failure mode (transport error, abort, malformed
 * JSON, fabricated citation) is a value in the returned `GeneratedBrief` so
 * the worker calling this can persist a row unconditionally.
 */
import { createHash } from "node:crypto";

import { BRIEF_RESPONSE_SCHEMA, parseBriefPayload } from "./brief.js";
import { checkCitations } from "./citations.js";
import { renderJudgmentPrompt } from "./render.js";
import {
  DEFAULT_ENGINE_CONFIG,
  type GenerateBriefDeps,
  type GeneratedBrief,
  type JudgmentEngineConfig,
  type LlmCompletionRequest,
  type LlmMessage,
  type ToolTraceEntry
} from "./types.js";

const RESPONSE_SCHEMA_NAME = "judgment_brief";

const FINAL_ANSWER_INSTRUCTION =
  "You have used the maximum number of research tool calls available for this brief. " +
  "Do not call any more tools. Respond now with only the final JSON object matching " +
  "the required schema — no prose, no markdown fences.";

/** A failed `GeneratedBrief` sharing the trace/token bookkeeping collected so far. */
function failedBrief(
  toolTrace: readonly ToolTraceEntry[],
  tokensIn: number,
  tokensOut: number,
  latencyMs: number,
  error: string
): GeneratedBrief {
  return {
    status: "FAILED",
    payload: null,
    citationReport: null,
    toolTrace,
    tokensIn,
    tokensOut,
    latencyMs,
    error
  };
}

/**
 * Drives the bounded LLM<->tool loop. Returns once the assistant answers
 * without requesting a tool call, or once `maxToolRounds` tool-calling
 * rounds have been spent — in the latter case the caller must still send a
 * final schema-only request before a payload can be parsed.
 */
async function runToolLoop(
  deps: GenerateBriefDeps,
  config: JudgmentEngineConfig,
  messages: LlmMessage[],
  toolTrace: ToolTraceEntry[]
): Promise<{ finalMessage: LlmMessage | undefined; tokensIn: number; tokensOut: number }> {
  let tokensIn = 0;
  let tokensOut = 0;
  let round = 0;

  while (round < config.maxToolRounds) {
    const request: LlmCompletionRequest = {
      model: deps.model,
      messages: [...messages],
      tools: deps.toolkit.defs,
      responseSchema: { name: RESPONSE_SCHEMA_NAME, schema: BRIEF_RESPONSE_SCHEMA },
      maxTokens: config.maxOutputTokens,
      temperature: config.temperature
    };
    const response = await deps.llm.complete(request, deps.signal);
    tokensIn += response.tokensIn;
    tokensOut += response.tokensOut;
    messages.push(response.message);

    if (response.message.toolCalls === undefined || response.message.toolCalls.length === 0) {
      return { finalMessage: response.message, tokensIn, tokensOut };
    }

    round += 1;
    for (const call of response.message.toolCalls) {
      const startedAt = performance.now();
      const result = await deps.toolkit.execute(call.name, call.argsJson);
      const latencyMs = performance.now() - startedAt;
      const seq = toolTrace.length + 1;
      toolTrace.push({
        seq,
        toolName: call.name,
        argsJson: call.argsJson,
        resultRowIds: result.resultRowIds,
        resultJson: result.resultJson,
        resultDigest: createHash("sha256").update(result.resultJson, "utf8").digest("hex"),
        latencyMs,
        isError: result.isError
      });
      // Label the result with its citable ref by string splice — the inner
      // resultJson bytes stay identical to what resultDigest hashed.
      const labeled = `{"callRef":"judgment_tool_calls:${seq}","result":${result.resultJson}}`;
      messages.push({ role: "tool", content: labeled, toolCallId: call.id });
    }
  }

  return { finalMessage: undefined, tokensIn, tokensOut };
}

export async function generateBrief(deps: GenerateBriefDeps): Promise<GeneratedBrief> {
  const config: JudgmentEngineConfig = { ...DEFAULT_ENGINE_CONFIG, ...deps.config };
  const startedAt = performance.now();
  const toolTrace: ToolTraceEntry[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  try {
    const { system, user } = renderJudgmentPrompt(deps.bundle, deps.prompt.template);
    const messages: LlmMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user }
    ];

    const loopResult = await runToolLoop(deps, config, messages, toolTrace);
    tokensIn += loopResult.tokensIn;
    tokensOut += loopResult.tokensOut;
    let finalMessage = loopResult.finalMessage;

    if (finalMessage === undefined) {
      messages.push({ role: "user", content: FINAL_ANSWER_INSTRUCTION });
      const finalRequest: LlmCompletionRequest = {
        model: deps.model,
        messages: [...messages],
        responseSchema: { name: RESPONSE_SCHEMA_NAME, schema: BRIEF_RESPONSE_SCHEMA },
        maxTokens: config.maxOutputTokens,
        temperature: config.temperature
      };
      const response = await deps.llm.complete(finalRequest, deps.signal);
      tokensIn += response.tokensIn;
      tokensOut += response.tokensOut;
      messages.push(response.message);
      finalMessage = response.message;
    }

    const latencyMs = performance.now() - startedAt;

    if (finalMessage.toolCalls !== undefined && finalMessage.toolCalls.length > 0) {
      return failedBrief(
        toolTrace,
        tokensIn,
        tokensOut,
        latencyMs,
        "assistant requested a tool call in the final response with no tools available"
      );
    }

    const parsed = parseBriefPayload(finalMessage.content);
    if (!parsed.ok) {
      return failedBrief(toolTrace, tokensIn, tokensOut, latencyMs, parsed.error);
    }

    const citationReport = await checkCitations(
      parsed.payload,
      deps.fetchCitedRow,
      config.citationTolerance,
      toolTrace
    );

    return {
      status: citationReport.verdict === "REJECT" ? "REJECTED_FABRICATED_CITATION" : "COMPLETED",
      payload: parsed.payload,
      citationReport,
      toolTrace,
      tokensIn,
      tokensOut,
      latencyMs,
      error: null
    };
  } catch (cause) {
    return failedBrief(
      toolTrace,
      tokensIn,
      tokensOut,
      performance.now() - startedAt,
      cause instanceof Error ? cause.message : String(cause)
    );
  }
}
