import { getAddress, isAddress, type Address } from "viem";

import type { VerificationStatus } from "./types.js";

/**
 * Etherscan-compatible `getsourcecode` result entry, as Blockscout returns it.
 * Only the fields we classify are typed; the rest are ignored.
 */
export interface ExplorerContractResult {
  readonly ABI?: string;
  readonly Proxy?: string;
  readonly Implementation?: string;
}

export interface VerificationMetadata {
  readonly status: VerificationStatus;
  /** Explorer's own proxy flag; null when the explorer had no opinion. */
  readonly isProxy: boolean | null;
  readonly implementation: Address | null;
}

const UNVERIFIED_ABI = "contract source code not verified";

/**
 * Classify a contract's verification metadata from the explorer response.
 * `null` (explorer unreachable or no entry) is UNKNOWN, never VERIFIED — a
 * missing answer must not read as a clean bill of health.
 */
export function classifyVerification(
  raw: ExplorerContractResult | null
): VerificationMetadata {
  if (raw === null) {
    return { status: "UNKNOWN", isProxy: null, implementation: null };
  }

  const abi = raw.ABI?.trim() ?? "";
  const status: VerificationStatus =
    abi === "" || abi.toLowerCase() === UNVERIFIED_ABI
      ? "UNVERIFIED"
      : "VERIFIED";

  const implementation =
    raw.Implementation !== undefined && isAddress(raw.Implementation)
      ? getAddress(raw.Implementation)
      : null;

  const isProxy =
    raw.Proxy === undefined ? null : raw.Proxy === "1" || implementation !== null;

  return { status, isProxy, implementation };
}
