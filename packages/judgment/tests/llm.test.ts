import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFakeLlmClient,
  createOpenAiCompatibleLlmClient,
  LlmClientError
} from "../src/llm.js";
import type { LlmCompletionRequest, LlmMessage } from "../src/types.js";

/** Minimal stand-in for the parts of `Response` the transport touches. */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    json: () => Promise.resolve(typeof body === "string" ? JSON.parse(body) : body)
  } as unknown as Response;
}

function wireOk(message: Record<string, unknown>, usage?: Record<string, number>): unknown {
  return {
    choices: [{ message: { role: "assistant", ...message } }],
    ...(usage !== undefined ? { usage } : {})
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOpenAiCompatibleLlmClient", () => {
  it("POSTs an OpenAI-compatible body: messages, tools, and response_format", async () => {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(() => Promise.resolve(fakeResponse(200, wireOk({ content: "{}" }))));
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatibleLlmClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test"
    });

    const request: LlmCompletionRequest = {
      model: "gpt-test",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" }
      ],
      tools: [
        {
          name: "lookup",
          description: "look something up",
          parameters: { type: "object", properties: {}, additionalProperties: false }
        }
      ],
      responseSchema: { name: "brief", schema: { type: "object" } },
      maxTokens: 512,
      temperature: 0.3
    };

    await client.complete(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>)["authorization"]).toBe("Bearer sk-test");

    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("gpt-test");
    expect(body["messages"]).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" }
    ]);
    expect(body["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "look something up",
          parameters: { type: "object", properties: {}, additionalProperties: false }
        }
      }
    ]);
    expect(body["response_format"]).toEqual({
      type: "json_schema",
      json_schema: { name: "brief", schema: { type: "object" }, strict: true }
    });
    expect(body["max_tokens"]).toBe(512);
    expect(body["temperature"]).toBe(0.3);
  });

  it("maps assistant tool_calls and tool-role messages onto the wire shape", async () => {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(() => Promise.resolve(fakeResponse(200, wireOk({ content: "" }))));
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatibleLlmClient({
      baseUrl: "https://api.example.com",
      apiKey: "sk-test"
    });

    const messages: LlmMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "comparableLaunches", argsJson: '{"k":5}' }]
      },
      { role: "tool", content: '{"ok":true}', toolCallId: "call_1" }
    ];

    await client.complete({ model: "m", messages });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init!.body)) as { messages: unknown[] };
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "comparableLaunches", arguments: '{"k":5}' } }
      ]
    });
    expect(body.messages[3]).toEqual({
      role: "tool",
      content: '{"ok":true}',
      tool_call_id: "call_1"
    });
  });

  it("parses assistant tool_calls out of the response", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        fakeResponse(
          200,
          wireOk({
            content: null,
            tool_calls: [
              {
                id: "call_9",
                type: "function",
                function: { name: "baseRateForPattern", arguments: '{"predicates":[]}' }
              }
            ]
          })
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com", apiKey: "k" });
    const response = await client.complete({ model: "m", messages: [] });

    expect(response.message.role).toBe("assistant");
    expect(response.message.content).toBe("");
    expect(response.message.toolCalls).toEqual([
      { id: "call_9", name: "baseRateForPattern", argsJson: '{"predicates":[]}' }
    ]);
  });

  it("maps usage.prompt_tokens/completion_tokens to tokensIn/tokensOut, defaulting to 0", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(fakeResponse(200, wireOk({ content: "hi" }, { prompt_tokens: 123, completion_tokens: 45 })))
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com", apiKey: "k" });
    const withUsage = await client.complete({ model: "m", messages: [] });
    expect(withUsage.tokensIn).toBe(123);
    expect(withUsage.tokensOut).toBe(45);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(fakeResponse(200, wireOk({ content: "hi" }))))
    );
    const client2 = createOpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com", apiKey: "k" });
    const noUsage = await client2.complete({ model: "m", messages: [] });
    expect(noUsage.tokensIn).toBe(0);
    expect(noUsage.tokensOut).toBe(0);
  });

  it("throws a structured LlmClientError with status on a non-OK response", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(fakeResponse(429, "rate limited")));
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com", apiKey: "k" });

    const error = await client.complete({ model: "m", messages: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmClientError);
    expect((error as LlmClientError).status).toBe(429);
    expect((error as LlmClientError).message).toContain("429");
    expect((error as LlmClientError).message).toContain("rate limited");
  });

  it("wraps a network failure in LlmClientError with no status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("dns failure")))
    );
    const client = createOpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com", apiKey: "k" });

    const error = await client.complete({ model: "m", messages: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmClientError);
    expect((error as LlmClientError).status).toBeUndefined();
  });

  it("throws LlmClientError on a malformed response body", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(fakeResponse(200, { nope: true })));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com", apiKey: "k" });

    await expect(client.complete({ model: "m", messages: [] })).rejects.toBeInstanceOf(LlmClientError);
  });

  it("propagates an AbortSignal through to fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com", apiKey: "k" });

    await expect(
      client.complete({ model: "m", messages: [] }, controller.signal)
    ).rejects.toBeInstanceOf(LlmClientError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init!.signal).toBe(controller.signal);
  });
});

describe("createFakeLlmClient", () => {
  it("returns scripted steps in order and records every request", async () => {
    const client = createFakeLlmClient([
      { toolCalls: [{ id: "1", name: "marketSeries", argsJson: "{}" }] },
      { content: '{"thesis":"x"}' }
    ]);

    const first = await client.complete({ model: "m", messages: [{ role: "user", content: "a" }] });
    expect(first.message.toolCalls).toEqual([{ id: "1", name: "marketSeries", argsJson: "{}" }]);

    const second = await client.complete({ model: "m", messages: [{ role: "user", content: "b" }] });
    expect(second.message.content).toBe('{"thesis":"x"}');
    expect(second.message.toolCalls).toBeUndefined();

    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]?.messages).toEqual([{ role: "user", content: "a" }]);
    expect(client.requests[1]?.messages).toEqual([{ role: "user", content: "b" }]);
  });

  it("throws LlmClientError once the script is exhausted", async () => {
    const client = createFakeLlmClient([{ content: "{}" }]);
    await client.complete({ model: "m", messages: [] });
    await expect(client.complete({ model: "m", messages: [] })).rejects.toBeInstanceOf(LlmClientError);
  });
});
