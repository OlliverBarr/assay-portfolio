import { getAddress, type Address } from "viem";

import type { Erc20Transfer } from "./reader.js";

/**
 * Net a transfer stream into current balances.
 *
 * Every transfer credits `to` and debits `from` in raw token units; the mint
 * source (zero address) nets negative and drops out, as does any address whose
 * observed inflows never covered its outflows (common when the scan starts
 * after genesis). Only strictly positive balances are economic holders.
 *
 * `seed`, when given, is the starting balance per address (e.g. the
 * previously stored balances from an incremental scan's cursor) — `transfers`
 * are then netted on top of it rather than from zero. Omit it for a
 * from-scratch scan; passing both a seed and the token's full history would
 * double-count everything the seed already reflects.
 */
export function computeBalances(
  transfers: readonly Erc20Transfer[],
  seed?: ReadonlyMap<Address, bigint>
): Map<Address, bigint> {
  const net = new Map<Address, bigint>();
  if (seed !== undefined) {
    for (const [address, balance] of seed) {
      net.set(getAddress(address), balance);
    }
  }
  for (const { from, to, valueRaw } of transfers) {
    const fromKey = getAddress(from);
    const toKey = getAddress(to);
    net.set(fromKey, (net.get(fromKey) ?? 0n) - valueRaw);
    net.set(toKey, (net.get(toKey) ?? 0n) + valueRaw);
  }

  const balances = new Map<Address, bigint>();
  for (const [address, balance] of net) {
    if (balance > 0n) balances.set(address, balance);
  }
  return balances;
}
