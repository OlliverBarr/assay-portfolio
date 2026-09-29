import { getAddress, type Address, type Hex } from "viem";

export type ProxyKind = "none" | "eip1967" | "beacon" | "legacy";

export interface ProxyReport {
  readonly isProxy: boolean;
  readonly kind: ProxyKind;
  /** Resolved logic address when a non-beacon implementation slot is set. */
  readonly implementation: Address | null;
}

/** A 32-byte storage word is empty when it is missing or all-zero. */
function isEmptySlot(value: Hex | null): boolean {
  if (value === null) return true;
  return /^0x0*$/.test(value);
}

/** Right-most 20 bytes of a 32-byte slot, as a checksummed address. */
function slotToAddress(value: Hex): Address {
  const hex = value.slice(2).padStart(64, "0");
  return getAddress(`0x${hex.slice(24)}`);
}

/**
 * Decide whether a contract is a proxy from its EIP-1967 / beacon / legacy
 * implementation-slot storage. Pure: the caller supplies already-read slots.
 * A set implementation slot means the token's own bytecode is a shim and its
 * real logic (and therefore its permissions) lives elsewhere.
 */
export function classifyProxy(slots: {
  implementation: Hex | null;
  beacon: Hex | null;
  legacy: Hex | null;
}): ProxyReport {
  if (!isEmptySlot(slots.implementation)) {
    return {
      isProxy: true,
      kind: "eip1967",
      implementation: slotToAddress(slots.implementation as Hex)
    };
  }
  if (!isEmptySlot(slots.legacy)) {
    return {
      isProxy: true,
      kind: "legacy",
      implementation: slotToAddress(slots.legacy as Hex)
    };
  }
  if (!isEmptySlot(slots.beacon)) {
    // Logic address is resolved through the beacon at call time, not stored
    // here; we cannot name it from storage alone.
    return { isProxy: true, kind: "beacon", implementation: null };
  }
  return { isProxy: false, kind: "none", implementation: null };
}
