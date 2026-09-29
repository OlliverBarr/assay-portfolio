import { toFunctionSelector, type Hex } from "viem";

import type { PermissionKind, PermissionState } from "./types.js";

export interface PermissionFinding {
  readonly kind: PermissionKind;
  readonly state: PermissionState;
  /** 4-byte selectors (0x-prefixed) found in the analyzed bytecode. */
  readonly matchedSelectors: string[];
}

/**
 * Candidate external function signatures whose presence in runtime bytecode is
 * evidence of a privileged capability. This is a deterministic heuristic, not
 * proof: selectors can collide and internal-only powers (e.g. a hidden owner
 * transfer hook) are not always externally callable. Findings are therefore
 * reported as evidence, and downstream never treats ABSENT as "safe".
 */
const PERMISSION_SIGNATURES: Record<PermissionKind, readonly string[]> = {
  mint: ["mint(address,uint256)", "mint(uint256)"],
  blacklist: [
    "blacklist(address)",
    "addBlackList(address)",
    "setBlackListStatus(address,bool)",
    "isBlacklisted(address)",
    "setBlacklist(address,bool)"
  ],
  pause: ["pause()", "unpause()", "setPaused(bool)", "pause(bool)"],
  transferTax: [
    "setFee(uint256)",
    "setFees(uint256,uint256)",
    "setTaxFee(uint256)",
    "setBuyTax(uint256)",
    "setSellTax(uint256)",
    "setTaxes(uint256,uint256)"
  ],
  ownership: [
    "transferOwnership(address)",
    "renounceOwnership()",
    "owner()"
  ],
  upgradeAdmin: [
    "upgradeTo(address)",
    "upgradeToAndCall(address,bytes)",
    "setImplementation(address)"
  ]
};

interface SelectorEntry {
  readonly selector: string;
  readonly signature: string;
}

const PERMISSION_KINDS = Object.keys(PERMISSION_SIGNATURES) as PermissionKind[];

/** Precomputed selector table: kind -> [{ selector, signature }]. */
const PERMISSION_SELECTORS: Record<PermissionKind, SelectorEntry[]> = (() => {
  const table = {} as Record<PermissionKind, SelectorEntry[]>;
  for (const kind of PERMISSION_KINDS) {
    table[kind] = PERMISSION_SIGNATURES[kind].map((signature) => ({
      selector: toFunctionSelector(signature).toLowerCase(),
      signature
    }));
  }
  return table;
})();

/**
 * Detect privileged permissions from runtime bytecode.
 *
 * `code === null` or empty bytecode yields UNKNOWN for every kind — an
 * unreadable contract is not a safe one. Otherwise each kind is PRESENT (with
 * the matched selectors as evidence) or ABSENT.
 */
export function detectPermissions(code: Hex | null): PermissionFinding[] {
  const normalized = code === null ? "" : code.toLowerCase();
  const hasCode = normalized.length > 2; // more than "0x"

  return PERMISSION_KINDS.map((kind) => {
    if (!hasCode) {
      return { kind, state: "UNKNOWN", matchedSelectors: [] };
    }
    const matchedSelectors = PERMISSION_SELECTORS[kind]
      .filter((entry) => normalized.includes(entry.selector.slice(2)))
      .map((entry) => entry.selector);
    return {
      kind,
      state: matchedSelectors.length > 0 ? "PRESENT" : "ABSENT",
      matchedSelectors
    };
  });
}
