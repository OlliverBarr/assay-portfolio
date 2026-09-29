import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

import { createRiskReader } from "../src/reader.js";

/**
 * The explorer verification fetch is adversarial-input territory: Blockscout
 * can return truncated bodies, HTML error pages, or garbage. Every such shape
 * must degrade to `null` (verification UNKNOWN) — never throw into the risk
 * pass. A truncated JSON body crashed the live worker on 2026-07-11.
 */
describe("createRiskReader.fetchContractVerification", () => {
  const ADDRESS = "0x8a36AaB432cB2926c6f05F8761800eaE0Cdbd010" as const;
  /** No on-chain method is touched by fetchContractVerification. */
  const client = {} as PublicClient;

  /**
   * Minimal stand-in for the parts of `Response` the reader touches. A plain
   * object, not `new Response(...)` — the test runner's worker pool executes
   * under Node 16, which has no global Response; a constructor throw here
   * would make the null-path tests pass vacuously.
   */
  function fakeResponse(status: number, body: string): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(JSON.parse(body))
    } as unknown as Response;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null on a malformed/truncated JSON body instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(fakeResponse(200, '{"status":"1","result":[')))
    );
    const reader = createRiskReader(client, { explorerUrl: "https://x.example" });
    await expect(reader.fetchContractVerification(ADDRESS)).resolves.toBeNull();
  });

  it("returns null on an HTML error page body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(fakeResponse(200, "<html>502 Bad Gateway</html>")))
    );
    const reader = createRiskReader(client, { explorerUrl: "https://x.example" });
    await expect(reader.fetchContractVerification(ADDRESS)).resolves.toBeNull();
  });

  it("still parses a well-formed verification result", async () => {
    const body = JSON.stringify({
      status: "1",
      result: [{ SourceCode: "contract X {}", Proxy: "0" }]
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fakeResponse(200, body))));
    const reader = createRiskReader(client, { explorerUrl: "https://x.example" });
    const result = await reader.fetchContractVerification(ADDRESS);
    expect(result).toMatchObject({ SourceCode: "contract X {}" });
  });
});
