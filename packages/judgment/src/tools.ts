/**
 * The read-only history toolkit handed to the judgment engine. Every tool
 * validates `argsJson` strictly (numbers/enums only, `additionalProperties:
 * false`) and respects the bundle's `asOf` — replay-unsafe tools report
 * themselves unavailable in REPLAY instead of leaking the present. No tool
 * ever throws: validation and execution failures both surface as
 * `isError: true` with a short machine-readable `resultJson.error`, exactly
 * like an LLM-supplied citation is adversarial input rather than a bug.
 */
import {
  getCitedRow,
  getCohortPercentiles,
  listTokenOutcomes,
  listTokenOutcomesByDeployer,
  listTokenPerformance,
  type Db,
  type TokenOutcomeRow,
  type TokenPerformanceRow
} from "@assay/database";

import {
  computeFeatureStats,
  computeLiquidityTrajectory,
  computeStandardizedDistance,
  coerceFiniteNumber,
  downsampleIndices,
  percentile,
  readEntryFeatureValue,
  standardizeValue,
  toJsonSafe,
  transformFeatureValue,
  type FeatureStats
} from "./tools-analytics.js";
import {
  BASE_RATE_FEATURES,
  CITABLE_TABLES,
  type BaseRateFeature,
  type BaseRatePredicate,
  type CitableTable,
  type EvidenceBundle,
  type JudgmentToolName,
  type JudgmentToolkit,
  type LlmToolDef,
  type ToolExecutionResult
} from "./types.js";

export interface ToolkitConfig {
  /** Comparables returned when the caller omits `k`. */
  readonly comparablesDefaultK: number;
  /** Hard cap on `k`, regardless of what the caller asks for. */
  readonly comparablesMaxK: number;
  /** Hard cap on `baseRateForPattern` predicate count. */
  readonly baseRateMaxPredicates: number;
  /** Hard cap on `marketSeries` points returned per call. */
  readonly marketSeriesMaxPoints: number;
  /** `getCohortPercentiles` minimum peer-cohort size. */
  readonly cohortMinSize: number;
}

export const DEFAULT_TOOLKIT_CONFIG: ToolkitConfig = {
  comparablesDefaultK: 10,
  comparablesMaxK: 25,
  baseRateMaxPredicates: 3,
  marketSeriesMaxPoints: 120,
  cohortMinSize: 20
};

export interface CreateToolkitArgs {
  readonly db: Db;
  readonly bundle: EvidenceBundle;
  readonly config?: Partial<ToolkitConfig>;
}

/** Realized outcome horizons the labeling passes actually produce. */
const VALID_HORIZONS: Record<number, true> = { 72: true, 168: true };
const DEFAULT_HORIZON_HOURS = 72;

/** Thrown internally for a validation failure; caught once in `execute` and turned into `isError: true`. */
class ToolArgError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertNoExtraKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new ToolArgError(`unknown argument "${key}"`);
    }
  }
}

function validateHorizonHours(raw: unknown): 72 | 168 {
  if (raw === undefined) return DEFAULT_HORIZON_HOURS;
  if (typeof raw !== "number" || VALID_HORIZONS[raw] !== true) {
    throw new ToolArgError("horizonHours must be 72 or 168");
  }
  return raw as 72 | 168;
}

function validatePredicates(raw: unknown, maxPredicates: number): BaseRatePredicate[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ToolArgError("predicates must be an array");
  if (raw.length > maxPredicates) {
    throw new ToolArgError(`predicates must have at most ${maxPredicates} entries`);
  }
  return raw.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new ToolArgError(`predicates[${index}] must be an object`);
    }
    for (const key of Object.keys(item)) {
      if (key !== "feature" && key !== "op" && key !== "value") {
        throw new ToolArgError(`predicates[${index}] has unknown key "${key}"`);
      }
    }
    const { feature, op, value } = item;
    if (typeof feature !== "string" || !BASE_RATE_FEATURES.includes(feature as BaseRateFeature)) {
      throw new ToolArgError(`predicates[${index}].feature is invalid`);
    }
    if (op !== "lte" && op !== "gte") {
      throw new ToolArgError(`predicates[${index}].op must be "lte" or "gte"`);
    }
    if (!isFiniteNumber(value)) {
      throw new ToolArgError(`predicates[${index}].value must be a finite number`);
    }
    return { feature: feature as BaseRateFeature, op, value };
  });
}

/**
 * Candidate entry-feature vector from bundle sections, mirroring
 * `PerformanceEntryFeatures` exactly: liquidity from the latest market
 * snapshot, activity/holder/risk fields from their bundle sections,
 * `ageMinutesAtEntry` from `asOf - pool.discoveredAt`.
 */
function buildCandidateFeatures(bundle: EvidenceBundle): Record<BaseRateFeature, number | null> {
  const latest =
    bundle.marketSeries.length > 0
      ? bundle.marketSeries[bundle.marketSeries.length - 1]!.row
      : null;
  const activity = bundle.activity?.row ?? null;
  const holder = bundle.holders?.row ?? null;
  const risk = bundle.risk?.row ?? null;
  const ageMinutes = Math.max(
    0,
    Math.floor((bundle.asOf.getTime() - bundle.pool.discoveredAt.getTime()) / 60_000)
  );
  return {
    quoteLiquidityUsd: coerceFiniteNumber(latest?.quoteLiquidityUsd),
    totalLiquidityUsd: coerceFiniteNumber(latest?.totalLiquidityUsd),
    ageMinutesAtEntry: ageMinutes,
    uniqueBuyers1h: activity?.uniqueBuyers1h ?? null,
    buySizeGiniBps: activity?.buySizeGiniBps ?? null,
    buySizeEntropyBps: activity?.buySizeEntropyBps ?? null,
    repeatedSizeBuyPctBps: activity?.repeatedSizeBuyPctBps ?? null,
    floatBps: holder?.floatBps ?? null,
    supplyInPoolBps: holder?.supplyInPoolBps ?? null,
    adjustedTop10PctBps: holder?.adjustedTop10PctBps ?? null,
    deployerPctBps: holder?.deployerPctBps ?? null,
    adjustedHolderCount: holder?.adjustedHolderCount ?? null,
    effectiveSellLossBps: risk?.effectiveSellLossBps ?? null
  };
}

function errorResult(message: string): ToolExecutionResult {
  return {
    resultJson: JSON.stringify({ error: message }),
    resultRowIds: [],
    isError: true
  };
}

function okResult(payload: unknown, resultRowIds: readonly string[]): ToolExecutionResult {
  return {
    resultJson: JSON.stringify(payload),
    resultRowIds,
    isError: false
  };
}

function buildToolDefs(config: ToolkitConfig): LlmToolDef[] {
  return [
    {
      name: "comparableLaunches",
      description:
        "Find the k most similar historical launches by standardized distance over entry-time features, restricted to outcome labels available as of this bundle's asOf.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          horizonHours: {
            type: "integer",
            enum: [72, 168],
            description: "Outcome horizon to compare against; defaults to 72."
          },
          k: {
            type: "integer",
            minimum: 1,
            description: `Number of comparables to return; capped at ${config.comparablesMaxK}, defaults to ${config.comparablesDefaultK}.`
          }
        }
      }
    },
    {
      name: "baseRateForPattern",
      description:
        "Realized-outcome base rate (died %, runner %, median max multiple) over the historical population, optionally narrowed by up to a few entry-feature predicates.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          horizonHours: {
            type: "integer",
            enum: [72, 168],
            description: "Outcome horizon; defaults to 72."
          },
          predicates: {
            type: "array",
            maxItems: config.baseRateMaxPredicates,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["feature", "op", "value"],
              properties: {
                feature: { type: "string", enum: [...BASE_RATE_FEATURES] },
                op: { type: "string", enum: ["lte", "gte"] },
                value: { type: "number" }
              }
            }
          }
        }
      }
    },
    {
      name: "deployerHistory",
      description:
        "This token's deployer's prior launch history: token count, survived, died (died only counts tokens that never survived at any horizon).",
      parameters: { type: "object", additionalProperties: false, properties: {} }
    },
    {
      name: "liquidityTrajectory",
      description:
        "Peak/current quote liquidity, drawdown from peak, and collapse status over this bundle's own market-snapshot series.",
      parameters: { type: "object", additionalProperties: false, properties: {} }
    },
    {
      name: "slippageAtSize",
      description:
        "This token's probed sell-side slippage curve and effective sell loss, optionally the curve point nearest a given notional size.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          sizeUsd: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Notional USD size to find the nearest probed slippage point for."
          }
        }
      }
    },
    {
      name: "cohortPercentiles",
      description:
        "Where this pool ranks among same-age peers on 1h unique buyers and 1h net quote inflow. LIVE mode only — unavailable in REPLAY.",
      parameters: { type: "object", additionalProperties: false, properties: {} }
    },
    {
      name: "marketSeries",
      description:
        "Downsampled market-snapshot series (price/FDV/quote liquidity per point) within an optional minute-offset window.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          fromMinutes: { type: "number", minimum: 0 },
          toMinutes: { type: "number", minimum: 0 },
          maxPoints: {
            type: "integer",
            minimum: 1,
            description: `Capped at ${config.marketSeriesMaxPoints}.`
          }
        }
      }
    },
    {
      name: "fetchCitedRow",
      description: "Fetch one citable row by table + row id, to verify a citation's exact fields.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["table", "rowId"],
        properties: {
          table: { type: "string", enum: [...CITABLE_TABLES] },
          rowId: { type: "integer", minimum: 1 }
        }
      }
    }
  ];
}

async function runComparableLaunches(
  bundle: EvidenceBundle,
  config: ToolkitConfig,
  getPerformanceRows: () => Promise<TokenPerformanceRow[]>,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  assertNoExtraKeys(args, ["horizonHours", "k"]);
  const horizonHours = validateHorizonHours(args["horizonHours"]);
  if (
    args["k"] !== undefined &&
    !(isFiniteNumber(args["k"]) && Number.isInteger(args["k"]) && args["k"] >= 1)
  ) {
    throw new ToolArgError("k must be a positive integer");
  }
  const k = Math.min(
    typeof args["k"] === "number" ? args["k"] : config.comparablesDefaultK,
    config.comparablesMaxK
  );

  const asOfMs = bundle.asOf.getTime();
  const performanceRows = await getPerformanceRows();
  const population = performanceRows.filter(
    (row) =>
      row.horizonHours === horizonHours &&
      row.labeledAt.getTime() <= asOfMs &&
      row.poolAddress !== bundle.pool.address
  );

  const candidateRaw = buildCandidateFeatures(bundle);
  const candidateTransformed = BASE_RATE_FEATURES.map((feature) =>
    transformFeatureValue(feature, candidateRaw[feature])
  );
  const populationTransformed = population.map((row) =>
    BASE_RATE_FEATURES.map((feature) =>
      transformFeatureValue(feature, readEntryFeatureValue(row.entryFeatures, feature))
    )
  );

  const stats: (FeatureStats | undefined)[] = BASE_RATE_FEATURES.map((_, featureIndex) => {
    const values = populationTransformed
      .map((row) => row[featureIndex])
      .filter((v): v is number => v !== null);
    return values.length > 0 ? computeFeatureStats(values) : undefined;
  });

  const candidateZ = candidateTransformed.map((v, i) => standardizeValue(v, stats[i]));

  const scored = population.map((row, index) => {
    const rowZ = populationTransformed[index]!.map((v, i) => standardizeValue(v, stats[i]));
    const { distance, matchedFeatures } = computeStandardizedDistance(candidateZ, rowZ);
    return { row, distance, matchedFeatures };
  });
  scored.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.row.poolAddress < b.row.poolAddress
      ? -1
      : a.row.poolAddress > b.row.poolAddress
        ? 1
        : 0;
  });

  const comparables = scored.slice(0, k).map(({ row, matchedFeatures }) => ({
    poolAddress: row.poolAddress,
    enteredAt: row.enteredAt.toISOString(),
    maxMultipleBps: row.maxMultipleBps,
    maxDrawdownBps: row.maxDrawdownBps,
    minutesToPeak: row.minutesToPeak,
    matchedFeatures,
    rowRef: `token_performance:${row.id}`
  }));

  return okResult(
    { horizonHours, k, populationSize: population.length, comparables },
    comparables.map((c) => c.rowRef)
  );
}

async function runBaseRateForPattern(
  bundle: EvidenceBundle,
  config: ToolkitConfig,
  getPerformanceRows: () => Promise<TokenPerformanceRow[]>,
  getOutcomeRows: () => Promise<TokenOutcomeRow[]>,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  assertNoExtraKeys(args, ["horizonHours", "predicates"]);
  const horizonHours = validateHorizonHours(args["horizonHours"]);
  const predicates = validatePredicates(args["predicates"], config.baseRateMaxPredicates);

  const asOfMs = bundle.asOf.getTime();
  const performanceRows = await getPerformanceRows();
  const populationRows = performanceRows.filter(
    (row) => row.horizonHours === horizonHours && row.labeledAt.getTime() <= asOfMs
  );
  const matched = populationRows.filter((row) =>
    predicates.every((predicate) => {
      const value = readEntryFeatureValue(row.entryFeatures, predicate.feature);
      if (value === null) return false;
      return predicate.op === "lte" ? value <= predicate.value : value >= predicate.value;
    })
  );

  const outcomeRows = await getOutcomeRows();
  const outcomeByPoolHorizon = new Map<string, TokenOutcomeRow>();
  for (const outcome of outcomeRows) {
    if (outcome.labeledAt.getTime() <= asOfMs) {
      outcomeByPoolHorizon.set(`${outcome.poolAddress}:${outcome.horizonHours}`, outcome);
    }
  }

  let died = 0;
  let runner = 0;
  const multiples: number[] = [];
  const outcomeRefs: string[] = [];
  for (const row of matched) {
    const outcome = outcomeByPoolHorizon.get(`${row.poolAddress}:${row.horizonHours}`);
    if (outcome !== undefined) {
      if (outcome.outcome === "DIED") died += 1;
      outcomeRefs.push(`token_outcomes:${outcome.id}`);
    }
    if (row.maxMultipleBps >= 20_000) runner += 1;
    multiples.push(row.maxMultipleBps);
  }
  multiples.sort((a, b) => a - b);

  const n = matched.length;
  const result: Record<string, unknown> = {
    horizonHours,
    predicates,
    n,
    populationN: populationRows.length,
    diedPct: n === 0 ? 0 : Math.round((died / n) * 10_000) / 100,
    runnerPctBps: n === 0 ? 0 : Math.round((runner / n) * 10_000),
    medianMultipleBps: percentile(multiples, 50)
  };
  if (n < 5) result["lowSample"] = true;

  const performanceRefs = matched.map((row) => `token_performance:${row.id}`);
  return okResult(result, [...performanceRefs, ...outcomeRefs]);
}

async function runDeployerHistory(
  db: Db,
  bundle: EvidenceBundle,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  assertNoExtraKeys(args, []);
  const deployerAddress = bundle.token.deployerAddress;
  if (deployerAddress === null) {
    return okResult({ available: false, reason: "deployer-unresolved" }, []);
  }

  const asOfMs = bundle.asOf.getTime();
  const rows = await listTokenOutcomesByDeployer(
    db,
    bundle.chainId,
    deployerAddress,
    bundle.token.address
  );
  const filtered = rows.filter((row) => row.labeledAt.getTime() <= asOfMs);

  const survivedTokens = new Set<string>();
  for (const row of filtered) {
    if (row.outcome === "SURVIVED") survivedTokens.add(row.tokenAddress);
  }
  const diedTokens = new Set<string>();
  for (const row of filtered) {
    if (row.outcome === "DIED" && !survivedTokens.has(row.tokenAddress)) {
      diedTokens.add(row.tokenAddress);
    }
  }
  const tokenAddresses = new Set(filtered.map((row) => row.tokenAddress));

  return okResult(
    {
      available: true,
      tokenCount: tokenAddresses.size,
      survived: survivedTokens.size,
      died: diedTokens.size
    },
    filtered.map((row) => `token_outcomes:${row.id}`)
  );
}

function runLiquidityTrajectory(
  bundle: EvidenceBundle,
  args: Record<string, unknown>
): ToolExecutionResult {
  assertNoExtraKeys(args, []);
  const trajectory = computeLiquidityTrajectory(bundle.marketSeries);
  if (!trajectory.available) {
    return okResult(trajectory, []);
  }
  return okResult(trajectory, [trajectory.peakRef, trajectory.currentRef]);
}

function runSlippageAtSize(
  bundle: EvidenceBundle,
  args: Record<string, unknown>
): ToolExecutionResult {
  assertNoExtraKeys(args, ["sizeUsd"]);
  let sizeUsd: number | undefined;
  if (args["sizeUsd"] !== undefined) {
    if (!isFiniteNumber(args["sizeUsd"]) || args["sizeUsd"] <= 0) {
      throw new ToolArgError("sizeUsd must be a positive number");
    }
    sizeUsd = args["sizeUsd"];
  }

  if (bundle.simulation === null) {
    return okResult({ available: false }, []);
  }
  const sim = bundle.simulation.row;
  const curve = sim.slippageCurve ?? [];

  let nearest = null;
  if (sizeUsd !== undefined) {
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const point of curve) {
      const notional = coerceFiniteNumber(point.notionalUsd);
      if (notional === null) continue;
      const diff = Math.abs(notional - sizeUsd);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearest = point;
      }
    }
  }

  const ref = `trade_simulations:${sim.id}`;
  return okResult(
    { available: true, curve, effectiveSellLossBps: sim.effectiveSellLossBps, nearest, ref },
    [ref]
  );
}

async function runCohortPercentiles(
  db: Db,
  bundle: EvidenceBundle,
  config: ToolkitConfig,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  assertNoExtraKeys(args, []);
  if (bundle.mode === "REPLAY") {
    return okResult({ available: false, reason: "not-as-of-safe" }, []);
  }
  const ageMinutes = Math.max(
    0,
    (bundle.asOf.getTime() - bundle.pool.discoveredAt.getTime()) / 60_000
  );
  const result = await getCohortPercentiles(
    db,
    bundle.chainId,
    bundle.pool.address,
    ageMinutes,
    config.cohortMinSize
  );
  if (result === undefined) {
    return okResult({ available: false, reason: "insufficient-cohort" }, []);
  }
  return okResult({ available: true, ...result }, []);
}

function runMarketSeries(
  bundle: EvidenceBundle,
  config: ToolkitConfig,
  args: Record<string, unknown>
): ToolExecutionResult {
  assertNoExtraKeys(args, ["fromMinutes", "toMinutes", "maxPoints"]);
  if (args["fromMinutes"] !== undefined && (!isFiniteNumber(args["fromMinutes"]) || args["fromMinutes"] < 0)) {
    throw new ToolArgError("fromMinutes must be a non-negative number");
  }
  if (args["toMinutes"] !== undefined && (!isFiniteNumber(args["toMinutes"]) || args["toMinutes"] < 0)) {
    throw new ToolArgError("toMinutes must be a non-negative number");
  }
  if (
    args["maxPoints"] !== undefined &&
    !(isFiniteNumber(args["maxPoints"]) && Number.isInteger(args["maxPoints"]) && args["maxPoints"] >= 1)
  ) {
    throw new ToolArgError("maxPoints must be a positive integer");
  }
  const maxPoints = Math.min(
    typeof args["maxPoints"] === "number" ? args["maxPoints"] : config.marketSeriesMaxPoints,
    config.marketSeriesMaxPoints
  );

  if (bundle.marketSeries.length === 0) {
    return okResult({ points: [] }, []);
  }
  const t0 = bundle.marketSeries[0]!.row.capturedAt.getTime();
  const from = typeof args["fromMinutes"] === "number" ? args["fromMinutes"] : 0;
  const to = typeof args["toMinutes"] === "number" ? args["toMinutes"] : Number.POSITIVE_INFINITY;
  const filtered = bundle.marketSeries.filter((s) => {
    const offset = (s.row.capturedAt.getTime() - t0) / 60_000;
    return offset >= from && offset <= to;
  });

  const points = downsampleIndices(filtered.length, maxPoints).map((index) => {
    const s = filtered[index]!;
    return {
      minuteOffset: Math.round((s.row.capturedAt.getTime() - t0) / 60_000),
      priceUsd: s.row.priceUsd,
      fdvUsd: s.row.estimatedFdvUsd,
      quoteLiquidityUsd: s.row.quoteLiquidityUsd,
      ref: `pool_snapshots:${s.row.id}`
    };
  });
  return okResult(
    { points },
    points.map((p) => p.ref)
  );
}

async function runFetchCitedRow(
  db: Db,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  assertNoExtraKeys(args, ["table", "rowId"]);
  const table = args["table"];
  if (typeof table !== "string" || !CITABLE_TABLES.includes(table as CitableTable)) {
    throw new ToolArgError(`table must be one of ${CITABLE_TABLES.join(", ")}`);
  }
  const rowId = args["rowId"];
  if (!isFiniteNumber(rowId) || !Number.isInteger(rowId) || rowId < 1) {
    throw new ToolArgError("rowId must be a positive integer");
  }

  const row = await getCitedRow(db, table, BigInt(rowId));
  if (row === undefined) {
    return okResult({ available: false }, []);
  }
  const ref = `${table}:${rowId}`;
  return okResult({ available: true, row: toJsonSafe(row) }, [ref]);
}

/** Builds the fixed, read-only history toolkit for one evidence bundle. */
export function createJudgmentToolkit(args: CreateToolkitArgs): JudgmentToolkit {
  const { db, bundle } = args;
  const config: ToolkitConfig = { ...DEFAULT_TOOLKIT_CONFIG, ...args.config };
  const defs = buildToolDefs(config);
  const defNames: Record<string, true> = {};
  for (const def of defs) defNames[def.name] = true;

  let performanceRowsPromise: Promise<TokenPerformanceRow[]> | null = null;
  const getPerformanceRows = (): Promise<TokenPerformanceRow[]> => {
    performanceRowsPromise ??= listTokenPerformance(db, bundle.chainId);
    return performanceRowsPromise;
  };
  let outcomeRowsPromise: Promise<TokenOutcomeRow[]> | null = null;
  const getOutcomeRows = (): Promise<TokenOutcomeRow[]> => {
    outcomeRowsPromise ??= listTokenOutcomes(db, bundle.chainId);
    return outcomeRowsPromise;
  };

  async function execute(name: string, argsJson: string): Promise<ToolExecutionResult> {
    if (defNames[name] !== true) {
      return errorResult(`unknown tool "${name}"`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsJson);
    } catch {
      return errorResult("arguments are not valid JSON");
    }
    if (!isPlainObject(parsed)) {
      return errorResult("arguments must be a JSON object");
    }
    try {
      switch (name as JudgmentToolName) {
        case "comparableLaunches":
          return await runComparableLaunches(bundle, config, getPerformanceRows, parsed);
        case "baseRateForPattern":
          return await runBaseRateForPattern(
            bundle,
            config,
            getPerformanceRows,
            getOutcomeRows,
            parsed
          );
        case "deployerHistory":
          return await runDeployerHistory(db, bundle, parsed);
        case "liquidityTrajectory":
          return runLiquidityTrajectory(bundle, parsed);
        case "slippageAtSize":
          return runSlippageAtSize(bundle, parsed);
        case "cohortPercentiles":
          return await runCohortPercentiles(db, bundle, config, parsed);
        case "marketSeries":
          return runMarketSeries(bundle, config, parsed);
        case "fetchCitedRow":
          return await runFetchCitedRow(db, parsed);
        default:
          return errorResult(`unknown tool "${name}"`);
      }
    } catch (err) {
      return errorResult(err instanceof ToolArgError ? err.message : "tool execution failed");
    }
  }

  return { defs, execute };
}
