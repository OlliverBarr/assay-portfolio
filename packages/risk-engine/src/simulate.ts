import type { LegStatus } from "./types.js";

/**
 * One point of the sell-slippage curve: the round-trip loss probed at a
 * given USD notional. `lossBps` is null when either leg of that notional's
 * probe reverted — a reverted point never aborts the others.
 */
export interface SlippagePoint {
  readonly notionalUsd: string;
  readonly lossBps: number | null;
}

/**
 * Raw outputs of a buy -> transfer -> sell route probe. Amounts are raw token
 * integers; `spot*` are the amounts expected at the pool's current spot price,
 * so loss is the shortfall of the actual route versus a frictionless swap.
 */
export interface RawRouteSimulation {
  readonly route: string;
  readonly buyReverted: boolean;
  readonly transferReverted: boolean;
  readonly sellReverted: boolean;
  readonly buyQuoteInRaw: bigint | null;
  readonly buyBaseOutRaw: bigint | null;
  readonly spotBaseOutRaw: bigint | null;
  readonly sellBaseInRaw: bigint | null;
  readonly sellQuoteOutRaw: bigint | null;
  readonly spotQuoteOutRaw: bigint | null;
  /** Ascending-notional sell-slippage curve; null when disabled/no-op. */
  readonly slippageCurve: readonly SlippagePoint[] | null;
}

export interface SimulationClassification {
  readonly status: LegStatus;
  readonly buyStatus: LegStatus;
  readonly transferStatus: LegStatus;
  readonly sellStatus: LegStatus;
  readonly effectiveBuyLossBps: number | null;
  readonly effectiveSellLossBps: number | null;
  readonly reasons: string[];
}

export interface SimulationThresholds {
  /** Sell loss at or above this many bps marks the route untradeable. */
  readonly maxSellLossBps: number;
}

export const DEFAULT_SIMULATION_THRESHOLDS: SimulationThresholds = {
  maxSellLossBps: 5_000 // 50%: honeypot / punitive-tax territory, not a fee
};

/** Shortfall of `actual` vs `spot`, in basis points, floored at zero. */
export function shortfallBps(
  spot: bigint | null,
  actual: bigint | null
): number | null {
  if (spot === null || actual === null || spot <= 0n) return null;
  const lossBps = ((spot - actual) * 10_000n) / spot;
  if (lossBps <= 0n) return 0;
  return Number(lossBps);
}

function legStatus(reverted: boolean, out: bigint | null): LegStatus {
  if (reverted) return "FAIL";
  if (out === null || out <= 0n) return "UNKNOWN";
  return "PASS";
}

/**
 * Classify a route probe into per-leg and overall tradeability. Reverts are
 * FAIL; missing outputs are UNKNOWN (never silently PASS); an excessive sell
 * shortfall marks the route FAIL as an untradeable / honeypot signal.
 */
export function classifySimulation(
  sim: RawRouteSimulation,
  thresholds: SimulationThresholds = DEFAULT_SIMULATION_THRESHOLDS
): SimulationClassification {
  const buyStatus = legStatus(sim.buyReverted, sim.buyBaseOutRaw);
  const sellStatus = legStatus(sim.sellReverted, sim.sellQuoteOutRaw);
  const transferStatus: LegStatus = sim.transferReverted ? "FAIL" : "PASS";

  const effectiveBuyLossBps = sim.buyReverted
    ? null
    : shortfallBps(sim.spotBaseOutRaw, sim.buyBaseOutRaw);
  const effectiveSellLossBps = sim.sellReverted
    ? null
    : shortfallBps(sim.spotQuoteOutRaw, sim.sellQuoteOutRaw);

  const reasons: string[] = [];
  if (sim.buyReverted) reasons.push("Buy through the real route reverted");
  if (sim.transferReverted) reasons.push("Token transfer reverted");
  if (sim.sellReverted) reasons.push("Sell through the real route reverted");

  const sellLossTooHigh =
    effectiveSellLossBps !== null &&
    effectiveSellLossBps >= thresholds.maxSellLossBps;
  if (sellLossTooHigh) {
    reasons.push(
      `Effective sell loss ${effectiveSellLossBps}bps at or above ${thresholds.maxSellLossBps}bps limit`
    );
  }

  let status: LegStatus;
  if (
    buyStatus === "FAIL" ||
    sellStatus === "FAIL" ||
    transferStatus === "FAIL" ||
    sellLossTooHigh
  ) {
    status = "FAIL";
  } else if (buyStatus === "UNKNOWN" || sellStatus === "UNKNOWN") {
    status = "UNKNOWN";
  } else {
    status = "PASS";
  }

  return {
    status,
    buyStatus,
    transferStatus,
    sellStatus,
    effectiveBuyLossBps,
    effectiveSellLossBps,
    reasons
  };
}
