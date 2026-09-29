import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ResponseBodyTooLargeError,
  getAddress,
  type PublicClient
} from "viem";

import { createHolderReader } from "../src/index.js";
import { BASE, HOLDER_A } from "./fixtures.js";

const EXPLORER_URL = "https://explorer.test";

/** Deterministic retries: no real backoff sleeps in tests. */
const RETRY = { sleep: () => Promise.resolve() };

/** Minimal stand-in for the parts of `Response` the reader touches. */
function fakeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(JSON.parse(body) as unknown)
  } as unknown as Response;
}

function okCreationResponse(creator: string): Response {
  return fakeResponse(
    200,
    JSON.stringify({
      status: "1",
      message: "OK",
      result: [{ contractCreator: creator }]
    })
  );
}

const EXPLORER_500 = fakeResponse(
  500,
  '{"message":"Something went wrong.","result":null,"status":"0"}'
);

/** The reader never touches the client for explorer lookups. */
const client = {} as PublicClient;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createHolderReader fetchContractCreation", () => {
  it("returns the checksummed creator from a well-formed answer", async () => {
    const fetchMock = vi.fn(() =>
      // Blockscout returns lowercase hex addresses.
      Promise.resolve(okCreationResponse(HOLDER_A.toLowerCase()))
    );
    vi.stubGlobal("fetch", fetchMock);

    const reader = createHolderReader(client, { explorerUrl: EXPLORER_URL });
    const creator = await reader.fetchContractCreation(BASE);

    expect(creator).toBe(getAddress(HOLDER_A));
    expect(fetchMock).toHaveBeenCalledWith(
      `${EXPLORER_URL}/api?module=contract&action=getcontractcreation` +
        `&contractaddresses=${BASE}`
    );
  });

  it("retries an intermittent 500 and returns the eventual creator", async () => {
    // Measured live: the endpoint 500s intermittently for indexed contracts.
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(EXPLORER_500)
      .mockResolvedValueOnce(okCreationResponse(HOLDER_A.toLowerCase()));
    vi.stubGlobal("fetch", fetchMock);

    const reader = createHolderReader(client, {
      explorerUrl: EXPLORER_URL,
      retry: RETRY
    });
    expect(await reader.fetchContractCreation(BASE)).toBe(getAddress(HOLDER_A));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is null after bounded attempts of persistent 500s, never throwing", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(EXPLORER_500));
    vi.stubGlobal("fetch", fetchMock);

    const reader = createHolderReader(client, {
      explorerUrl: EXPLORER_URL,
      retry: { ...RETRY, attempts: 3 }
    });
    expect(await reader.fetchContractCreation(BASE)).toBeNull();
    // Bounded: exactly the configured attempts, then a missing signal.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("is null when the explorer is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down")))
    );

    const reader = createHolderReader(client, {
      explorerUrl: EXPLORER_URL,
      retry: RETRY
    });
    expect(await reader.fetchContractCreation(BASE)).toBeNull();
  });

  it("does not retry a permanent non-OK miss", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(fakeResponse(404, '{"message":"Not found"}'))
    );
    vi.stubGlobal("fetch", fetchMock);

    const reader = createHolderReader(client, {
      explorerUrl: EXPLORER_URL,
      retry: RETRY
    });
    expect(await reader.fetchContractCreation(BASE)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["non-JSON body", () => Promise.reject(new SyntaxError("bad json"))],
    ["string result", () => Promise.resolve({ status: "0", result: "Error!" })],
    ["empty result array", () => Promise.resolve({ status: "1", result: [] })],
    [
      "garbage creator address",
      () =>
        Promise.resolve({
          status: "1",
          result: [{ contractCreator: "0xNOTANADDRESS" }]
        })
    ]
  ])("is null on adversarial explorer output: %s", async (_label, json) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, status: 200, json } as unknown as Response)
      )
    );

    const reader = createHolderReader(client, { explorerUrl: EXPLORER_URL });
    expect(await reader.fetchContractCreation(BASE)).toBeNull();
  });

  it("is null without an explorer URL and performs no network I/O", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const reader = createHolderReader(client);
    expect(await reader.fetchContractCreation(BASE)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createHolderReader getErc20TransferLogs oversized responses", () => {
  function transferLog(from: string, to: string, value: bigint) {
    return { args: { from, to, value } };
  }

  it("bisects a chunk whose transfer-log response overflows viem's cap", async () => {
    const ranges: Array<{ from: bigint; to: bigint }> = [];
    const logsClient = {
      getLogs(args: { fromBlock: bigint; toBlock: bigint }) {
        ranges.push({ from: args.fromBlock, to: args.toBlock });
        if (args.toBlock - args.fromBlock >= 2n) {
          return Promise.reject(
            new ResponseBodyTooLargeError({ maxSize: 10, size: 11 })
          );
        }
        return Promise.resolve([
          transferLog(HOLDER_A, BASE, args.fromBlock)
        ]);
      }
    } as unknown as PublicClient;

    // Chunk size covers the whole range in one call, forcing the oversize
    // path (not the pre-existing chunking) to do the splitting.
    const reader = createHolderReader(logsClient, {
      chunkSize: 100n,
      retry: RETRY
    });
    const transfers = await reader.getErc20TransferLogs(BASE, 1n, 4n);

    // 1-4 overflows, then 1-2 and 3-4 each fit.
    expect(ranges).toEqual([
      { from: 1n, to: 4n },
      { from: 1n, to: 2n },
      { from: 3n, to: 4n }
    ]);
    expect(transfers).toEqual([
      { from: getAddress(HOLDER_A), to: getAddress(BASE), valueRaw: 1n },
      { from: getAddress(HOLDER_A), to: getAddress(BASE), valueRaw: 3n }
    ]);
  });
});
