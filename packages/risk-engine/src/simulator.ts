import type { Address, PublicClient } from "viem";

import {
  uniswapV2RouterAbi,
  uniswapV3QuoterAbi,
  withRetry,
  type RetryOptions
} from "@assay/chain";
import type { PoolRow } from "@assay/database";

import {
  shortfallBps,
  type RawRouteSimulation,
  type SlippagePoint
} from "./simulate.js";

/**
 * Produces a raw buy -> sell route probe for one pool. The pure
 * {@link classifySimulation} turns this into a verdict; tests inject a fake.
 */
export interface RouteSimulator {
  simulate(pool: PoolRow): Promise<RawRouteSimulation>;
}

export interface QuoteRouteSimulatorOptions {
  /** Uniswap V2 router with `getAmountsOut`. Omit to skip V2 pools. */
  readonly v2Router?: Address;
  /** Uniswap V3 QuoterV2. Omit to skip V3 pools. */
  readonly v3Quoter?: Address;
  /** Raw quote-token amount used as the buy probe. Default 1e6 base units. */
  readonly probeQuoteInRaw?: bigint;
  /**
   * Ascending USD notionals probed for the sell-slippage curve, on top of
   * the single `probeQuoteInRaw` eligibility probe above. Each notional is
   * converted to raw quote units using the exact anchoring `probeQuoteInRaw`
   * itself already uses — `probeQuoteInRaw` raw units are treated as $1, so
   * a $2,000 notional probes `probeQuoteInRaw * 2000n` raw units. Pass `[]`
   * to disable the curve. Default `[500, 2000, 5000]`.
   */
  readonly slippageCurveNotionalsUsd?: readonly number[];
  readonly retry?: Partial<RetryOptions>;
}

const EMPTY_SIM = (route: string): RawRouteSimulation => ({
  route,
  buyReverted: false,
  transferReverted: false,
  sellReverted: false,
  buyQuoteInRaw: null,
  buyBaseOutRaw: null,
  spotBaseOutRaw: null,
  sellBaseInRaw: null,
  sellQuoteOutRaw: null,
  spotQuoteOutRaw: null,
  slippageCurve: null
});

const DEFAULT_SLIPPAGE_CURVE_NOTIONALS_USD: readonly number[] = [
  500, 2_000, 5_000
];

type LegQuote = (
  amountIn: bigint
) => Promise<{ out: bigint | null; reverted: boolean }>;

/**
 * Probes an ascending vector of USD notionals with an independent buy ->
 * sell round trip each. Each notional is converted to raw quote units using
 * the same anchoring as the single-probe `probeQuoteInRaw`: `probeQuoteInRaw`
 * raw units == $1, with cent-level rounding to avoid floating-point bigint
 * drift. A reverted leg yields `lossBps: null` for that point only — it
 * never aborts the remaining notionals.
 */
async function computeSlippageCurve(
  notionalsUsd: readonly number[],
  probeQuoteInRaw: bigint,
  buyLeg: LegQuote,
  sellLeg: LegQuote
): Promise<readonly SlippagePoint[] | null> {
  if (notionalsUsd.length === 0) return null;
  const points: SlippagePoint[] = [];
  for (const notionalUsd of notionalsUsd) {
    const notionalCents = BigInt(Math.round(notionalUsd * 100));
    const raw = (probeQuoteInRaw * notionalCents) / 100n;
    const buy = await buyLeg(raw);
    const sell =
      buy.out === null || buy.out === 0n
        ? { out: null, reverted: buy.reverted }
        : await sellLeg(buy.out);
    const lossBps =
      buy.reverted || sell.reverted ? null : shortfallBps(raw, sell.out);
    points.push({ notionalUsd: String(notionalUsd), lossBps });
  }
  return points;
}

/**
 * Quote-based route probe. Reverts on the buy/sell quote are recorded as the
 * corresponding leg reverting — a strong untradeable/honeypot signal — while a
 * successful quote yields the output amount.
 *
 * The sell leg's spot baseline is the quote amount the buy consumed: a
 * frictionless round trip returns exactly what went in, so the measured
 * shortfall (`effectiveSellLossBps`) is the full round-trip cost — both fee
 * legs, slippage, and any transfer tax. Conservative: it can only overstate
 * loss, never fabricate a PASS. Per-leg buy loss still needs a spot oracle and
 * stays null (`spotBaseOutRaw` = null). Requires verified router/quoter
 * addresses (see docs/data-sources.md); when a pool's route address is unset,
 * the probe is a no-op UNKNOWN rather than a fabricated PASS.
 */
export function createQuoteRouteSimulator(
  client: PublicClient,
  options: QuoteRouteSimulatorOptions = {}
): RouteSimulator {
  const probeQuoteInRaw = options.probeQuoteInRaw ?? 1_000_000n;
  const { retry } = options;
  const slippageCurveNotionalsUsd =
    options.slippageCurveNotionalsUsd ?? DEFAULT_SLIPPAGE_CURVE_NOTIONALS_USD;

  const quoteV2 = async (
    router: Address,
    path: readonly [Address, Address],
    amountIn: bigint
  ): Promise<{ out: bigint | null; reverted: boolean }> => {
    try {
      const amounts = (await withRetry(
        `getAmountsOut ${path[0]}->${path[1]}`,
        () =>
          client.readContract({
            address: router,
            abi: uniswapV2RouterAbi,
            functionName: "getAmountsOut",
            args: [amountIn, [...path]]
          }),
        retry
      )) as readonly bigint[];
      return { out: amounts[amounts.length - 1] ?? null, reverted: false };
    } catch {
      return { out: null, reverted: true };
    }
  };

  const quoteV3 = async (
    quoter: Address,
    tokenIn: Address,
    tokenOut: Address,
    fee: number,
    amountIn: bigint
  ): Promise<{ out: bigint | null; reverted: boolean }> => {
    try {
      const result = (await withRetry(
        `quoteExactInputSingle ${tokenIn}->${tokenOut}`,
        () =>
          client.readContract({
            address: quoter,
            abi: uniswapV3QuoterAbi,
            functionName: "quoteExactInputSingle",
            args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }]
          }),
        retry
      )) as readonly [bigint, ...unknown[]];
      return { out: result[0] ?? null, reverted: false };
    } catch {
      return { out: null, reverted: true };
    }
  };

  return {
    async simulate(pool) {
      const route = pool.factoryKind;
      const base = pool.baseTokenAddress;
      const quote = pool.quoteTokenAddress;
      if (base === null || quote === null) return EMPTY_SIM(route);
      const baseAddr = base as Address;
      const quoteAddr = quote as Address;

      if (route === "uniswap-v2") {
        if (options.v2Router === undefined) return EMPTY_SIM(route);
        const v2Router = options.v2Router;
        const buy = await quoteV2(
          v2Router,
          [quoteAddr, baseAddr],
          probeQuoteInRaw
        );
        const sell =
          buy.out === null || buy.out === 0n
            ? { out: null, reverted: buy.reverted }
            : await quoteV2(v2Router, [baseAddr, quoteAddr], buy.out);
        return {
          route,
          buyReverted: buy.reverted,
          transferReverted: false,
          sellReverted: sell.reverted,
          buyQuoteInRaw: probeQuoteInRaw,
          buyBaseOutRaw: buy.out,
          spotBaseOutRaw: null,
          sellBaseInRaw: buy.out,
          sellQuoteOutRaw: sell.out,
          spotQuoteOutRaw: probeQuoteInRaw,
          slippageCurve: await computeSlippageCurve(
            slippageCurveNotionalsUsd,
            probeQuoteInRaw,
            (amountIn) => quoteV2(v2Router, [quoteAddr, baseAddr], amountIn),
            (amountIn) => quoteV2(v2Router, [baseAddr, quoteAddr], amountIn)
          )
        };
      }

      if (options.v3Quoter === undefined || pool.feePpm === null) {
        return EMPTY_SIM(route);
      }
      const v3Quoter = options.v3Quoter;
      const feePpm = pool.feePpm;
      const buy = await quoteV3(
        v3Quoter,
        quoteAddr,
        baseAddr,
        feePpm,
        probeQuoteInRaw
      );
      const sell =
        buy.out === null || buy.out === 0n
          ? { out: null, reverted: buy.reverted }
          : await quoteV3(
              v3Quoter,
              baseAddr,
              quoteAddr,
              feePpm,
              buy.out
            );
      return {
        route,
        buyReverted: buy.reverted,
        transferReverted: false,
        sellReverted: sell.reverted,
        buyQuoteInRaw: probeQuoteInRaw,
        buyBaseOutRaw: buy.out,
        spotBaseOutRaw: null,
        sellBaseInRaw: buy.out,
        sellQuoteOutRaw: sell.out,
        spotQuoteOutRaw: probeQuoteInRaw,
        slippageCurve: await computeSlippageCurve(
          slippageCurveNotionalsUsd,
          probeQuoteInRaw,
          (amountIn) => quoteV3(v3Quoter, quoteAddr, baseAddr, feePpm, amountIn),
          (amountIn) => quoteV3(v3Quoter, baseAddr, quoteAddr, feePpm, amountIn)
        )
      };
    }
  };
}
