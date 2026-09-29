import { hexToString, isHex, type Address } from "viem";

import { withRetry, type RetryOptions } from "@assay/chain";

import type { ChainReader } from "./reader.js";

/**
 * Token metadata reads. Every external token is adversarial input: calls
 * revert, return junk, use bytes32 strings, or report absurd decimals.
 * Failures produce a structured ERROR result — never a throw that kills an
 * enrichment pass, never a silent default.
 *
 * RPC-infrastructure failures (RetryExhaustedError) DO propagate: they say
 * nothing about the token and must not brand it ERROR.
 */

/** Above this, `decimals` is treated as adversarial nonsense. */
const MAX_SANE_DECIMALS = 36;

const stringFacetAbi = (name: string) =>
  [
    {
      type: "function",
      name,
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "string" }]
    }
  ] as const;

const bytes32FacetAbi = (name: string) =>
  [
    {
      type: "function",
      name,
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "bytes32" }]
    }
  ] as const;

const decimalsAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }]
  }
] as const;

const totalSupplyAbi = [
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }]
  }
] as const;

export interface TokenMetadataResult {
  readonly status: "PASS" | "ERROR";
  readonly name: string | null;
  readonly symbol: string | null;
  /** Present iff status is PASS. */
  readonly decimals: number | null;
  /** Present iff status is PASS. */
  readonly totalSupply: bigint | null;
}

/** Strip NUL padding from a bytes32-encoded string. */
function decodeBytes32String(value: unknown): string | null {
  if (!isHex(value)) return null;
  const decoded = hexToString(value);
  const nul = decoded.indexOf("\0");
  const stripped = (nul === -1 ? decoded : decoded.slice(0, nul)).trim();
  return stripped.length > 0 ? stripped : null;
}

export async function fetchTokenMetadata(
  reader: ChainReader,
  token: Address,
  retry?: Partial<RetryOptions>
): Promise<TokenMetadataResult> {
  const read = (abi: readonly unknown[], functionName: string) =>
    withRetry(
      `${functionName} ${token}`,
      () => reader.readContract({ address: token, abi, functionName }),
      retry
    );

  // Adversarial failure (revert, junk returndata) → null for this facet.
  // RetryExhaustedError is infrastructure and re-thrown by `read` itself.
  const tryRead = async (
    abi: readonly unknown[],
    functionName: string
  ): Promise<{ ok: true; value: unknown } | { ok: false }> => {
    try {
      return { ok: true, value: await read(abi, functionName) };
    } catch (error) {
      if (error instanceof Error && error.name === "RetryExhaustedError") {
        throw error;
      }
      return { ok: false };
    }
  };

  const readString = async (facet: string): Promise<string | null> => {
    const asString = await tryRead(stringFacetAbi(facet), facet);
    if (asString.ok && typeof asString.value === "string") {
      const trimmed = asString.value.trim();
      if (trimmed.length > 0) return trimmed;
    }
    const asBytes32 = await tryRead(bytes32FacetAbi(facet), facet);
    return asBytes32.ok ? decodeBytes32String(asBytes32.value) : null;
  };

  const [name, symbol, decimalsRead, totalSupplyRead] = [
    await readString("name"),
    await readString("symbol"),
    await tryRead(decimalsAbi, "decimals"),
    await tryRead(totalSupplyAbi, "totalSupply")
  ];

  let decimals: number | null = null;
  if (decimalsRead.ok && typeof decimalsRead.value === "number") {
    decimals = decimalsRead.value;
  } else if (decimalsRead.ok && typeof decimalsRead.value === "bigint") {
    decimals = Number(decimalsRead.value);
  }
  if (decimals !== null && (decimals < 0 || decimals > MAX_SANE_DECIMALS)) {
    decimals = null;
  }

  const totalSupply =
    totalSupplyRead.ok && typeof totalSupplyRead.value === "bigint"
      ? totalSupplyRead.value
      : null;

  // Price and FDV math require decimals + totalSupply; name/symbol are
  // cosmetic and stay nullable either way.
  const status: "PASS" | "ERROR" =
    decimals !== null && totalSupply !== null ? "PASS" : "ERROR";

  return { status, name, symbol, decimals, totalSupply };
}
