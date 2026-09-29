import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AlertDeliveryError,
  createDryRunTransport,
  createTelegramTransport
} from "../src/index.js";

/** Minimal stand-in for the parts of `Response` the transport touches. */
function fakeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body)
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDryRunTransport", () => {
  it("forwards the text to the sink and performs no network I/O", async () => {
    const captured: string[] = [];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const transport = createDryRunTransport((text) => captured.push(text));

    await transport.send("hello world");

    expect(captured).toEqual(["hello world"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createTelegramTransport", () => {
  it("POSTs to the Telegram sendMessage endpoint with chat_id and text", async () => {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(() => Promise.resolve(fakeResponse(200, '{"ok":true}')));
    vi.stubGlobal("fetch", fetchMock);

    const transport = createTelegramTransport("BOT:TOKEN", "-100123");
    await transport.send("alert body");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/botBOT:TOKEN/sendMessage");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body))).toEqual({
      chat_id: "-100123",
      text: "alert body",
      parse_mode: "HTML"
    });
  });

  it("throws a structured AlertDeliveryError on a non-OK response", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(fakeResponse(400, "bad request")));
    vi.stubGlobal("fetch", fetchMock);

    const transport = createTelegramTransport("BOT:TOKEN", "-100123");

    const error = await transport.send("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlertDeliveryError);
    expect((error as AlertDeliveryError).status).toBe(400);
    expect((error as AlertDeliveryError).message).toContain("400");
  });

  it("wraps a transport-level fetch failure in AlertDeliveryError", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("network down")));
    vi.stubGlobal("fetch", fetchMock);

    const transport = createTelegramTransport("BOT:TOKEN", "-100123");

    await expect(transport.send("x")).rejects.toBeInstanceOf(
      AlertDeliveryError
    );
  });
});
