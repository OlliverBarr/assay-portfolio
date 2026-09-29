/**
 * Judgment eval scorer: joins COMPLETED/REJECTED judgment briefs against
 * realized `token_performance` / `token_outcomes` labels and reports how
 * well the judgment layer's calls track reality, sliced by
 * `(promptName, promptVersion, horizonHours)` per the out-of-time
 * discipline (a prompt version is only ever judged against its own calls).
 * Read-only by default; `--write` freezes the report into
 * `judgment_eval_runs` + `judgment_eval_items`.
 *
 *   bun run judge:report
 *   bun run judge:report -- --from=2026-01-01T00:00:00Z --to=2026-02-01T00:00:00Z
 *   bun run judge:report -- --write
 */
import { loadChainConfigFromEnv } from "@assay/chain";
import {
  createDatabase,
  insertJudgmentEvalItems,
  insertJudgmentEvalRun,
  listJudgmentBriefs,
  listJudgmentToolCalls,
  listTokenOutcomes,
  listTokenPerformance,
  type Db,
  type JudgmentBriefRow,
  type JudgmentEvalItemInsert,
  type TokenOutcomeRow,
  type TokenPerformanceRow
} from "@assay/database";
import {
  classifyRealizedOutcome,
  DEFAULT_TAXONOMY_CONFIG,
  RISK_TAGS,
  type BriefRecommendation,
  type RealizedLabel,
  type RiskCall,
  type RiskTag,
  type TaxonomyConfig
} from "@assay/judgment";

import { assertKnownFlags, readFlag } from "./cli-flags.js";
import { loadDatabaseUrlFromEnv, WorkerConfigError } from "./config.js";
import { createLogger } from "./log.js";

/** 95% two-sided Wilson z-score. */
const WILSON_Z = 1.959963984540054;
const CALIBRATION_BUCKET_COUNT = 10;
/** CONCENTRATION_DUMP realizes on a drawdown deeper than this even without a rug. */
const CONCENTRATION_DUMP_DRAWDOWN_BPS = 5_000;
/** Latest quote liquidity below this share of its peak counts as collapsed. */
const LIQUIDITY_COLLAPSE_SHARE = 0.2;

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/** A judgment brief row plus its audited tool-call count (from `judgment_tool_calls`). */
export type JudgeReportBrief = JudgmentBriefRow & { readonly toolCallCount: number };

export interface JudgeReportConfig {
  readonly taxonomy: TaxonomyConfig;
  /** Out-of-time window on `brief.asOf`; unset = no bound. */
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/** A rate with its sample size and Wilson 95% interval — every reported rate carries one. */
export interface JudgeReportRate {
  readonly n: number;
  readonly successes: number;
  readonly rateBps: number;
  readonly wilsonLowerBps: number | null;
  readonly wilsonUpperBps: number | null;
}

export interface JudgeReportTaxonomy {
  readonly RESEARCH: number;
  readonly WATCH: number;
  readonly PASS: number;
}

export interface JudgeReportCalibrationBucket {
  /** "0-10" .. "90-100", percent of stated (implied) probability. */
  readonly bucket: string;
  readonly n: number;
  readonly meanStatedBps: number;
  readonly realized: JudgeReportRate;
}

export interface JudgeReportTagScore {
  readonly tag: RiskTag;
  /** False for SELL_RESTRICTION/WASH_COORDINATION/OTHER — no realization predicate exists yet. */
  readonly measured: boolean;
  readonly predicted: number;
  readonly precision: JudgeReportRate | null;
  readonly recall: JudgeReportRate | null;
}

/** One brief scored against its realized outcome — the exact row shape persisted to `judgment_eval_items`. */
export interface JudgeReportScoredItem {
  readonly briefId: string;
  readonly poolAddress: string;
  readonly tokenAddress: string;
  readonly realizedLabel: RealizedLabel;
  readonly realizedMaxMultipleBps: number;
  readonly predictedHitBps: number;
  readonly realizedHit: boolean;
  readonly brierMicro: number;
  /** Realization detail per tag this brief actually called; null = unmeasured tag. */
  readonly riskMatches: Readonly<Record<string, boolean | null>>;
}

export interface JudgeReportSlice {
  readonly promptName: string;
  readonly promptVersion: number;
  readonly horizonHours: number;
  /** ISO bounds of the briefs folded into this slice (explicit --from/--to, else the data's own range). */
  readonly periodStart: string;
  readonly periodEnd: string;
  /** COMPLETED + REJECTED_FABRICATED_CITATION briefs matched to this horizon. */
  readonly n: number;
  /** Subset of `n` that is COMPLETED with a resolvable realized outcome — the Brier/calibration/tag population. */
  readonly scored: number;
  readonly taxonomy: JudgeReportTaxonomy;
  readonly fabricationRate: JudgeReportRate;
  readonly brierMeanMicro: number | null;
  readonly calibration: readonly JudgeReportCalibrationBucket[];
  readonly tags: readonly JudgeReportTagScore[];
  readonly medianCostUsd: number | null;
  readonly medianLatencyMs: number | null;
  readonly medianToolCalls: number | null;
  readonly items: readonly JudgeReportScoredItem[];
}

export interface JudgeReport {
  readonly from: string | null;
  readonly to: string | null;
  readonly slices: readonly JudgeReportSlice[];
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** Wilson score interval for a binomial rate; null when there is no sample. */
export function wilsonInterval(
  successes: number,
  n: number,
  z: number = WILSON_Z
): { readonly lowerBps: number; readonly upperBps: number } | null {
  if (n <= 0) return null;
  const phat = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return {
    lowerBps: Math.round(Math.max(0, (center - margin) / denominator) * 10_000),
    upperBps: Math.round(Math.min(1, (center + margin) / denominator) * 10_000)
  };
}

function buildRate(successes: number, n: number): JudgeReportRate {
  const interval = wilsonInterval(successes, n);
  return {
    n,
    successes,
    rateBps: n === 0 ? 0 : Math.round((successes / n) * 10_000),
    wilsonLowerBps: interval?.lowerBps ?? null,
    wilsonUpperBps: interval?.upperBps ?? null
  };
}

/** True median (average of the two middle values on an even-length array); null for an empty array. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** RESEARCH -> stated confidence; WATCH -> the neutral midpoint; PASS -> confidence inverted (confident PASS = low implied hit probability). */
function impliedProbabilityBps(recommendation: BriefRecommendation, confidenceBps: number): number {
  if (recommendation === "RESEARCH") return confidenceBps;
  if (recommendation === "WATCH") return 5_000;
  return 10_000 - confidenceBps;
}

function computeBrierMicro(impliedBps: number, isPositive: boolean): number {
  const p = impliedBps / 10_000;
  const o = isPositive ? 1 : 0;
  return Math.round((p - o) ** 2 * 1_000_000);
}

/** Mirrors `computeLiquidityTrajectory`'s `collapsed` semantics (latest < 20% of peak), read off the frozen outcome row instead of the live snapshot series. */
function isLiquidityCollapsed(outcome: TokenOutcomeRow | undefined): boolean {
  if (outcome === undefined) return false;
  const peak = outcome.peakQuoteLiquidityUsd === null ? null : Number(outcome.peakQuoteLiquidityUsd);
  const atHorizon =
    outcome.quoteLiquidityAtHorizonUsd === null ? null : Number(outcome.quoteLiquidityAtHorizonUsd);
  if (peak === null || atHorizon === null || !Number.isFinite(peak) || !Number.isFinite(atHorizon)) {
    return false;
  }
  return peak > 0 && atHorizon < peak * LIQUIDITY_COLLAPSE_SHARE;
}

// ---------------------------------------------------------------------------
// Per-risk-tag realization (v1, honest): only these three tags have a
// realization predicate. SELL_RESTRICTION, WASH_COORDINATION, and OTHER are
// deliberately absent — they are unmeasured, never guessed.
// ---------------------------------------------------------------------------

const MEASURED_RISK_PREDICATES: Partial<
  Record<RiskTag, (label: RealizedLabel, perfRow: TokenPerformanceRow) => boolean>
> = {
  RUG_LP_PULL: (label) => label === "RUGGED",
  CONCENTRATION_DUMP: (label, perfRow) =>
    label === "RUGGED" || perfRow.maxDrawdownBps > CONCENTRATION_DUMP_DRAWDOWN_BPS,
  NO_FOLLOW_THROUGH: (label) => label === "BLED" || label === "HELD_BAND"
};

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  readonly brief: JudgeReportBrief;
  readonly perfRow: TokenPerformanceRow;
  readonly impliedBps: number;
  readonly label: RealizedLabel;
  readonly isRunner: boolean;
  readonly brierMicro: number;
}

/** Every riskCalls tag this brief actually called, mapped to its realization (null = unmeasured tag). */
function buildRiskMatches(
  riskCalls: readonly RiskCall[],
  label: RealizedLabel,
  perfRow: TokenPerformanceRow
): Record<string, boolean | null> {
  const matches: Record<string, boolean | null> = {};
  for (const call of riskCalls) {
    const predicate = MEASURED_RISK_PREDICATES[call.tag];
    matches[call.tag] = predicate === undefined ? null : predicate(label, perfRow);
  }
  return matches;
}

function scoreCandidate(
  brief: JudgeReportBrief,
  perfRow: TokenPerformanceRow,
  outcomeRow: TokenOutcomeRow | undefined,
  taxonomy: TaxonomyConfig
): ScoredCandidate {
  const impliedBps = impliedProbabilityBps(
    brief.recommendation as BriefRecommendation,
    brief.confidenceBps!
  );
  const label = classifyRealizedOutcome(
    {
      maxMultipleBps: perfRow.maxMultipleBps,
      died: outcomeRow?.outcome === "DIED",
      liquidityCollapsed: isLiquidityCollapsed(outcomeRow)
    },
    taxonomy
  );
  const isRunner = label === "RUNNER";
  return { brief, perfRow, impliedBps, label, isRunner, brierMicro: computeBrierMicro(impliedBps, isRunner) };
}

function buildCalibrationBuckets(
  scored: readonly ScoredCandidate[]
): readonly JudgeReportCalibrationBucket[] {
  const buckets: ScoredCandidate[][] = Array.from({ length: CALIBRATION_BUCKET_COUNT }, () => []);
  for (const candidate of scored) {
    const index = Math.min(CALIBRATION_BUCKET_COUNT - 1, Math.floor(candidate.impliedBps / 1_000));
    buckets[index]!.push(candidate);
  }
  const result: JudgeReportCalibrationBucket[] = [];
  for (let i = 0; i < CALIBRATION_BUCKET_COUNT; i++) {
    const items = buckets[i]!;
    if (items.length === 0) continue;
    const meanStatedBps = Math.round(
      items.reduce((sum, item) => sum + item.impliedBps, 0) / items.length
    );
    const runners = items.filter((item) => item.isRunner).length;
    result.push({
      bucket: `${i * 10}-${(i + 1) * 10}`,
      n: items.length,
      meanStatedBps,
      realized: buildRate(runners, items.length)
    });
  }
  return result;
}

function buildTagScores(scored: readonly ScoredCandidate[]): readonly JudgeReportTagScore[] {
  return RISK_TAGS.map((tag) => {
    const predicate = MEASURED_RISK_PREDICATES[tag];
    const called = scored.filter((candidate) =>
      ((candidate.brief.riskCalls as readonly RiskCall[] | null) ?? []).some(
        (call) => call.tag === tag
      )
    );
    if (predicate === undefined) {
      return { tag, measured: false, predicted: called.length, precision: null, recall: null };
    }
    const realized = scored.filter((candidate) => predicate(candidate.label, candidate.perfRow));
    const truePositives = called.filter((candidate) => predicate(candidate.label, candidate.perfRow)).length;
    return {
      tag,
      measured: true,
      predicted: called.length,
      precision: called.length === 0 ? null : buildRate(truePositives, called.length),
      recall: realized.length === 0 ? null : buildRate(truePositives, realized.length)
    };
  });
}

function buildSlice(
  promptName: string,
  promptVersion: number,
  horizonHours: number,
  items: readonly JudgeReportBrief[],
  from: Date | undefined,
  to: Date | undefined,
  perfByPoolHorizon: ReadonlyMap<string, TokenPerformanceRow>,
  outcomeByPoolHorizon: ReadonlyMap<string, TokenOutcomeRow>,
  taxonomyConfig: TaxonomyConfig
): JudgeReportSlice {
  const taxonomy: { RESEARCH: number; WATCH: number; PASS: number } = {
    RESEARCH: 0,
    WATCH: 0,
    PASS: 0
  };
  for (const brief of items) {
    if (brief.recommendation === "RESEARCH") taxonomy.RESEARCH += 1;
    else if (brief.recommendation === "WATCH") taxonomy.WATCH += 1;
    else if (brief.recommendation === "PASS") taxonomy.PASS += 1;
  }
  const rejected = items.filter((brief) => brief.status === "REJECTED_FABRICATED_CITATION").length;

  const scored: ScoredCandidate[] = [];
  for (const brief of items) {
    if (brief.status !== "COMPLETED") continue;
    if (brief.recommendation === null || brief.confidenceBps === null) continue;
    const perfRow = perfByPoolHorizon.get(`${brief.poolAddress}:${horizonHours}`);
    if (perfRow === undefined) continue;
    const outcomeRow = outcomeByPoolHorizon.get(`${brief.poolAddress}:${horizonHours}`);
    scored.push(scoreCandidate(brief, perfRow, outcomeRow, taxonomyConfig));
  }

  const brierMeanMicro =
    scored.length === 0
      ? null
      : Math.round(scored.reduce((sum, candidate) => sum + candidate.brierMicro, 0) / scored.length);

  const costs = items
    .map((brief) => (brief.costUsd === null ? null : Number(brief.costUsd)))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const latencies = items
    .map((brief) => brief.latencyMs)
    .filter((value): value is number => value !== null);
  const toolCalls = items.map((brief) => brief.toolCallCount);

  const asOfMs = items.map((brief) => brief.asOf.getTime());
  const periodStart = from ?? new Date(Math.min(...asOfMs));
  const periodEnd = to ?? new Date(Math.max(...asOfMs));

  const scoredItems: JudgeReportScoredItem[] = scored.map((candidate) => ({
    briefId: candidate.brief.id.toString(),
    poolAddress: candidate.brief.poolAddress,
    tokenAddress: candidate.brief.tokenAddress,
    realizedLabel: candidate.label,
    realizedMaxMultipleBps: candidate.perfRow.maxMultipleBps,
    predictedHitBps: candidate.impliedBps,
    realizedHit: candidate.isRunner,
    brierMicro: candidate.brierMicro,
    riskMatches: buildRiskMatches(
      (candidate.brief.riskCalls as readonly RiskCall[] | null) ?? [],
      candidate.label,
      candidate.perfRow
    )
  }));

  return {
    promptName,
    promptVersion,
    horizonHours,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    n: items.length,
    scored: scored.length,
    taxonomy,
    fabricationRate: buildRate(rejected, items.length),
    brierMeanMicro,
    calibration: buildCalibrationBuckets(scored),
    tags: buildTagScores(scored),
    medianCostUsd: median(costs),
    medianLatencyMs: median(latencies),
    medianToolCalls: median(toolCalls),
    items: scoredItems
  };
}

/**
 * Pure eval report builder. Slices strictly by `(promptName, promptVersion,
 * horizonHours)` — a prompt version is only ever compared against calls it
 * actually made, and a horizon slice only exists where a realized
 * `token_performance` row backs it. FAILED briefs and any brief outside
 * `[from, to]` are excluded up front; REJECTED briefs count toward `n` and
 * the fabrication rate but never toward Brier/calibration/tag scoring
 * (their claims cannot be trusted).
 */
export function buildJudgeReport(
  briefs: readonly JudgeReportBrief[],
  perfRows: readonly TokenPerformanceRow[],
  outcomeRows: readonly TokenOutcomeRow[],
  config: Partial<JudgeReportConfig> = {}
): JudgeReport {
  const taxonomyConfig = config.taxonomy ?? DEFAULT_TAXONOMY_CONFIG;
  const from = config.from;
  const to = config.to;

  const relevant = briefs.filter((brief) => {
    if (brief.status !== "COMPLETED" && brief.status !== "REJECTED_FABRICATED_CITATION") return false;
    if (from !== undefined && brief.asOf.getTime() < from.getTime()) return false;
    if (to !== undefined && brief.asOf.getTime() > to.getTime()) return false;
    return true;
  });

  const perfByPoolHorizon = new Map<string, TokenPerformanceRow>();
  for (const row of perfRows) perfByPoolHorizon.set(`${row.poolAddress}:${row.horizonHours}`, row);
  const outcomeByPoolHorizon = new Map<string, TokenOutcomeRow>();
  for (const row of outcomeRows) outcomeByPoolHorizon.set(`${row.poolAddress}:${row.horizonHours}`, row);

  const horizons = [...new Set(perfRows.map((row) => row.horizonHours))].sort((a, b) => a - b);

  const groups = new Map<string, { promptName: string; promptVersion: number; briefs: JudgeReportBrief[] }>();
  for (const brief of relevant) {
    const key = `${brief.promptName}::${brief.promptVersion}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { promptName: brief.promptName, promptVersion: brief.promptVersion, briefs: [brief] });
    } else {
      group.briefs.push(brief);
    }
  }

  const slices: JudgeReportSlice[] = [];
  for (const group of groups.values()) {
    for (const horizonHours of horizons) {
      const sliceItems = group.briefs.filter((brief) =>
        perfByPoolHorizon.has(`${brief.poolAddress}:${horizonHours}`)
      );
      if (sliceItems.length === 0) continue;
      slices.push(
        buildSlice(
          group.promptName,
          group.promptVersion,
          horizonHours,
          sliceItems,
          from,
          to,
          perfByPoolHorizon,
          outcomeByPoolHorizon,
          taxonomyConfig
        )
      );
    }
  }
  slices.sort(
    (a, b) =>
      a.promptName.localeCompare(b.promptName) ||
      a.promptVersion - b.promptVersion ||
      a.horizonHours - b.horizonHours
  );

  return { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null, slices };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface ReportArgs {
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly write: boolean;
}

function parseIsoArg(flag: string, raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new WorkerConfigError(flag, `"${raw}" is not a valid ISO-8601 date`);
  }
  return parsed;
}

/** Parses `judge:report`'s CLI flags. Never touches the environment or a database. */
export function parseReportArgs(argv: readonly string[]): ReportArgs {
  assertKnownFlags(argv, ["from", "to"], ["write"]);

  return {
    from: parseIsoArg("--from", readFlag(argv, "from")),
    to: parseIsoArg("--to", readFlag(argv, "to")),
    write: argv.includes("--write")
  };
}

async function loadReportBriefs(db: Db, chainId: number): Promise<JudgeReportBrief[]> {
  const rows = await listJudgmentBriefs(db, chainId);
  const relevant = rows.filter(
    (brief) => brief.status === "COMPLETED" || brief.status === "REJECTED_FABRICATED_CITATION"
  );
  return Promise.all(
    relevant.map(async (brief) => ({
      ...brief,
      toolCallCount: (await listJudgmentToolCalls(db, brief.id)).length
    }))
  );
}

async function writeSlice(db: Db, chainId: number, slice: JudgeReportSlice): Promise<bigint> {
  const run = await insertJudgmentEvalRun(db, {
    chainId,
    promptName: slice.promptName,
    promptVersion: slice.promptVersion,
    horizonHours: slice.horizonHours,
    periodStart: new Date(slice.periodStart),
    periodEnd: new Date(slice.periodEnd),
    briefsTotal: slice.n,
    report: slice
  });
  const itemRows: JudgmentEvalItemInsert[] = slice.items.map((item) => ({
    runId: run.id,
    briefId: BigInt(item.briefId),
    poolAddress: item.poolAddress,
    realizedLabel: item.realizedLabel,
    realizedMaxMultipleBps: item.realizedMaxMultipleBps,
    predictedHitBps: item.predictedHitBps,
    realizedHit: item.realizedHit,
    brierMicro: item.brierMicro,
    riskMatches: item.riskMatches
  }));
  await insertJudgmentEvalItems(db, itemRows);
  return run.id;
}

async function main(): Promise<void> {
  const logger = createLogger();
  const args = parseReportArgs(process.argv.slice(2));
  const env = process.env;
  const chainConfig = loadChainConfigFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);

  const handle = createDatabase(databaseUrl);
  try {
    await handle.applyMigrations();
    const db = handle.db;
    const chainId = chainConfig.chainId;

    const [briefs, perfRows, outcomeRows] = await Promise.all([
      loadReportBriefs(db, chainId),
      listTokenPerformance(db, chainId),
      listTokenOutcomes(db, chainId)
    ]);

    const report = buildJudgeReport(briefs, perfRows, outcomeRows, { from: args.from, to: args.to });

    for (const slice of report.slices) {
      logger.info("judge_report.slice", {
        promptName: slice.promptName,
        promptVersion: slice.promptVersion,
        horizonHours: slice.horizonHours,
        periodStart: slice.periodStart,
        periodEnd: slice.periodEnd,
        n: slice.n,
        scored: slice.scored,
        taxonomy: slice.taxonomy,
        fabricationRate: slice.fabricationRate,
        brierMeanMicro: slice.brierMeanMicro,
        medianCostUsd: slice.medianCostUsd,
        medianLatencyMs: slice.medianLatencyMs,
        medianToolCalls: slice.medianToolCalls
      });
      for (const bucket of slice.calibration) {
        logger.info("judge_report.calibration_bucket", {
          promptName: slice.promptName,
          promptVersion: slice.promptVersion,
          horizonHours: slice.horizonHours,
          ...bucket
        });
      }
      for (const tag of slice.tags) {
        logger.info("judge_report.tag", {
          promptName: slice.promptName,
          promptVersion: slice.promptVersion,
          horizonHours: slice.horizonHours,
          ...tag
        });
      }

      if (args.write) {
        const runId = await writeSlice(db, chainId, slice);
        logger.info("judge_report.written", {
          promptName: slice.promptName,
          promptVersion: slice.promptVersion,
          horizonHours: slice.horizonHours,
          runId: runId.toString(),
          items: slice.items.length
        });
      }
    }

    logger.info("judge_report.summary", {
      slices: report.slices.length,
      briefsConsidered: briefs.length,
      write: args.write
    });
  } finally {
    await handle.close();
  }
}

// Run only when executed directly — see feedback.ts; importing the pure
// report builder above must never open a database connection.
if (import.meta.main) {
  main().catch((error: unknown) => {
    createLogger().error("judge_report.crashed", { error });
    process.exit(1);
  });
}
