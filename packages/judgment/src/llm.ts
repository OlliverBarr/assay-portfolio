/**
 * OpenAI-compatible `/chat/completions` transport for the judgment engine,
 * plus a scripted fake used by tests and offline replay. Same discipline as
 * `@assay/alerts`'s transport: a thin wire mapping, structured errors that
 * carry enough context to debug without leaking secrets, and a fake that
 * never touches the network.
 */
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmMessage,
  LlmToolCallRequest
} from "./types.js";

/** Longest response-body snippet kept on a transport error. */
const ERROR_BODY_SNIPPET_LENGTH = 500;

/**
 * Raised when the chat-completions transport fails: a network error, a
 * non-OK HTTP response, or a response body that doesn't match the expected
 * OpenAI-compatible shape. `status` is set only for HTTP-level failures.
 */
export class LlmClientError extends Error {
  override readonly name = "LlmClientError";

  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}

interface WireFunctionCall {
  readonly name: string;
  readonly arguments: string;
}

interface WireToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: WireFunctionCall;
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: readonly WireToolCall[];
  tool_call_id?: string;
}

function toWireMessage(message: LlmMessage): WireMessage {
  const wire: WireMessage = { role: message.role, content: message.content };
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    wire.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.argsJson }
    }));
  }
  if (message.toolCallId !== undefined) {
    wire.tool_call_id = message.toolCallId;
  }
  return wire;
}

function toWireBody(request: LlmCompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(toWireMessage)
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    body["tools"] = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }
  if (request.responseSchema !== undefined) {
    body["response_format"] = {
      type: "json_schema",
      json_schema: {
        name: request.responseSchema.name,
        schema: request.responseSchema.schema,
        strict: true
      }
    };
  }
  if (request.maxTokens !== undefined) {
    body["max_tokens"] = request.maxTokens;
  }
  if (request.temperature !== undefined) {
    body["temperature"] = request.temperature;
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseWireToolCall(raw: unknown): LlmToolCallRequest {
  if (!isRecord(raw) || typeof raw["id"] !== "string" || !isRecord(raw["function"])) {
    throw new LlmClientError(
      "chat completions response tool_call entry was malformed"
    );
  }
  const fn = raw["function"];
  const name = fn["name"];
  const args = fn["arguments"];
  if (typeof name !== "string" || typeof args !== "string") {
    throw new LlmClientError(
      "chat completions response tool_call function was malformed"
    );
  }
  return { id: raw["id"], name, argsJson: args };
}

function parseWireResponse(json: unknown): LlmCompletionResponse {
  if (!isRecord(json)) {
    throw new LlmClientError("chat completions response was not a JSON object");
  }
  const choices = json["choices"];
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw new LlmClientError("chat completions response had no choices");
  }
  const message = choices[0]["message"];
  if (!isRecord(message) || message["role"] !== "assistant") {
    throw new LlmClientError(
      "chat completions response choice had no assistant message"
    );
  }

  const content = typeof message["content"] === "string" ? message["content"] : "";
  const toolCallsRaw = message["tool_calls"];
  const toolCalls =
    Array.isArray(toolCallsRaw) && toolCallsRaw.length > 0
      ? toolCallsRaw.map(parseWireToolCall)
      : undefined;

  const usage = json["usage"];
  const usageRecord = isRecord(usage) ? usage : {};
  const tokensIn =
    typeof usageRecord["prompt_tokens"] === "number" ? usageRecord["prompt_tokens"] : 0;
  const tokensOut =
    typeof usageRecord["completion_tokens"] === "number"
      ? usageRecord["completion_tokens"]
      : 0;

  const outMessage: LlmMessage = {
    role: "assistant",
    content,
    ...(toolCalls !== undefined ? { toolCalls } : {})
  };
  return { message: outMessage, tokensIn, tokensOut };
}

/**
 * Real transport: POSTs an OpenAI-compatible `/chat/completions` body via
 * global `fetch`. Never throws anything other than {@link LlmClientError}.
 */
export function createOpenAiCompatibleLlmClient(opts: {
  readonly baseUrl: string;
  readonly apiKey: string;
}): LlmClient {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    async complete(
      request: LlmCompletionRequest,
      signal?: AbortSignal
    ): Promise<LlmCompletionResponse> {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`
          },
          body: JSON.stringify(toWireBody(request)),
          ...(signal !== undefined ? { signal } : {})
        });
      } catch (cause) {
        throw new LlmClientError("chat completions request failed", { cause });
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LlmClientError(
          `chat completions returned ${response.status}: ${body.length > ERROR_BODY_SNIPPET_LENGTH ? `${body.slice(0, ERROR_BODY_SNIPPET_LENGTH)}\u2026` : body}`,
          { status: response.status }
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (cause) {
        throw new LlmClientError(
          "chat completions returned a malformed JSON body",
          { cause }
        );
      }

      return parseWireResponse(json);
    }
  };
}

/** One scripted assistant turn for {@link createFakeLlmClient}. */
export interface FakeLlmStep {
  readonly toolCalls?: readonly LlmToolCallRequest[];
  readonly content?: string;
}

/** Fixed token counts charged per scripted step, so callers can assert aggregation across rounds without depending on real usage accounting. */
const FAKE_TOKENS_IN = 100;
const FAKE_TOKENS_OUT = 40;

/**
 * Deterministic {@link LlmClient} for tests: returns `steps` in order and
 * records every request it received on `.requests`. Throws
 * {@link LlmClientError} (matching the real client's failure mode) once the
 * script is exhausted, so an engine bug that over-calls the LLM fails loudly
 * instead of silently reusing the last step.
 */
export function createFakeLlmClient(
  steps: readonly FakeLlmStep[]
): LlmClient & { readonly requests: LlmCompletionRequest[] } {
  const requests: LlmCompletionRequest[] = [];
  let cursor = 0;

  return {
    requests,
    complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
      requests.push(request);
      if (cursor >= steps.length) {
        return Promise.reject(
          new LlmClientError("fake LLM client script exhausted")
        );
      }
      const step = steps[cursor];
      cursor += 1;
      const message: LlmMessage = {
        role: "assistant",
        content: step?.content ?? "",
        ...(step?.toolCalls !== undefined ? { toolCalls: step.toolCalls } : {})
      };
      return Promise.resolve({
        message,
        tokensIn: FAKE_TOKENS_IN,
        tokensOut: FAKE_TOKENS_OUT
      });
    }
  };
}
