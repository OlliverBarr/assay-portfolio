/**
 * REPLAY brief generator: for historical `token_performance` rows (realized
 * band entries, independent of whether an alert ever fired), assembles a
 * REPLAY evidence bundle as-of the entry time, runs the same judgment
 * engine used for LIVE briefs, and persists the result with `alertId: null`.
 * Scoring against realized outcomes is a separate step (`judge:report`) —
 * this CLI only generates and persists briefs, never scores them.
 *
 *   bun run judge:replay -- --horizon=72 --limit=20
 *   bun run judge:replay -- --from=2026-01-01T00:00:00Z --to=2026-02-01T00:00:00Z
 *   bun run judge:replay -- --dry-run --limit=3   # FakeLlmClient, pipeline test only
 */
import { loadChainConfigFromEnv, type EnvSource } from "@assay/chain";
import {
  createDatabase,
  getCitedRow,
  getOrCreatePrompt,
  insertJudgmentBrief,
  insertJudgmentCitations,
  insertJudgmentToolCalls,
  listJudgmentBriefs,
  listTokenPerformance,
  type Db,
  type JudgmentBriefInsert,
  type JudgmentBriefRow,
  type JudgmentCitationInsert,
  type JudgmentToolCallInsert,
  type PromptRegistryRow,
  type TokenPerformanceRow
} from "@assay/database";
import {
  assembleEvidenceBundle,
  BRIEF_PROMPT_V1_CHANGELOG,
  briefPromptSpecV1,
  createFakeLlmClient,
  createJudgmentToolkit,
  createOpenAiCompatibleLlmClient,
  generateBrief,
  type BriefStatus,
  type CitableTable,
  type CitationReport,
  type CitedRowFetcher,
  type EvidencePointer,
  type GeneratedBrief,
  type JudgmentBriefPayload,
  type LlmClient,
  type PromptSpec,
  type ToolTraceEntry
} from "@assay/judgment";

import { assertKnownFlags, readFlag } from "./cli-flags.js";
import { loadDatabaseUrlFromEnv, WorkerConfigError } from "./config.js";
import { createLogger } from "./log.js";

const DEFAULT_HORIZON_HOURS = 72;
const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
/** Sentinel model name stamped on dry-run briefs so they are never mistaken for real scoring. */
const DRY_RUN_MODEL = "dry-run-fake-llm";
const DECIMAL_ROW_ID = /^\d+$/;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ReplayArgs {
  readonly horizonHours: number;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly limit?: number | undefined;
  readonly dryRun: boolean;
}

function parseIsoArg(flag: string, raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new WorkerConfigError(flag, `"${raw}" is not a valid ISO-8601 date`);
  }
  return parsed;
}

/** Parses `judge:replay`'s CLI flags. Never touches the environment or a database. */
export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  assertKnownFlags(argv, ["horizon", "limit", "from", "to"], ["dry-run"]);

  const horizonRaw = readFlag(argv, "horizon");
  const horizonHours = horizonRaw === undefined ? DEFAULT_HORIZON_HOURS : Number(horizonRaw);
  if (!Number.isFinite(horizonHours) || horizonHours <= 0) {
    throw new WorkerConfigError("--horizon", `"${horizonRaw}" must be a positive number`);
  }

  const limitRaw = readFlag(argv, "limit");
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new WorkerConfigError("--limit", `"${limitRaw}" must be a positive integer`);
    }
  }

  return {
    horizonHours,
    from: parseIsoArg("--from", readFlag(argv, "from")),
    to: parseIsoArg("--to", readFlag(argv, "to")),
    limit,
    dryRun: argv.includes("--dry-run")
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface ReplaySelectionParams {
  readonly horizonHours: number;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly limit?: number | undefined;
}

/**
 * Selects `token_performance` rows due for a REPLAY brief: matches the
 * requested horizon and `[from, to]` entry window, oldest entry first, and
 * excludes pools that already carry a REPLAY brief for the current prompt
 * version. `judgment_briefs` has no horizon column — a pool's REPLAY brief
 * covers its band-entry evidence once, and `judge:report` later scores that
 * same brief against whichever horizons have a realized outcome — so the
 * already-briefed check keys on `poolAddress` alone, not `(poolAddress,
 * horizonHours)`.
 */
export function selectReplayCandidates(
  perfRows: readonly TokenPerformanceRow[],
  existingReplayBriefs: readonly Pick<JudgmentBriefRow, "poolAddress">[],
  params: ReplaySelectionParams
): TokenPerformanceRow[] {
  const briefedPools = new Set(existingReplayBriefs.map((brief) => brief.poolAddress));
  const matching = perfRows.filter((row) => {
    if (row.horizonHours !== params.horizonHours) return false;
    if (params.from !== undefined && row.enteredAt.getTime() < params.from.getTime()) return false;
    if (params.to !== undefined && row.enteredAt.getTime() > params.to.getTime()) return false;
    return !briefedPools.has(row.poolAddress);
  });
  matching.sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime());
  return params.limit === undefined ? matching : matching.slice(0, params.limit);
}

// ---------------------------------------------------------------------------
// Dry-run payload (pipeline testing only — never a real evaluation)
// ---------------------------------------------------------------------------

const DRY_RUN_NOTE =
  "DRY-RUN PIPELINE TEST: FakeLlmClient scripted output for judge-replay plumbing verification only, not a real evaluation.";

/**
 * Deterministic, verifiably-cited payload for `--dry-run`. Every evidence
 * pointer cites the very `token_performance` row being replayed — a row
 * that always exists and whose fields are already known — so citation
 * checking still exercises the real fetch-and-compare path without an LLM.
 * This tests brief persistence plumbing, never brief quality.
 */
function buildDryRunPayload(row: TokenPerformanceRow): JudgmentBriefPayload {
  const pointer: EvidencePointer = {
    table: "token_performance",
    rowId: row.id.toString(),
    field: "maxMultipleBps",
    claimedValue: String(row.maxMultipleBps)
  };
  const riskCall = {
    risk: DRY_RUN_NOTE,
    tag: "OTHER" as const,
    severity: "LOW" as const,
    evidence: [pointer]
  };
  return {
    thesis: DRY_RUN_NOTE,
    thesisEvidence: [pointer],
    confidenceBps: 5000,
    riskCalls: [riskCall, riskCall, riskCall],
    disconfirming: [],
    whatWouldChangeThisCall: [DRY_RUN_NOTE],
    recommendation: "WATCH"
  };
}

// ---------------------------------------------------------------------------
// Persistence mapping
// ---------------------------------------------------------------------------

function toJudgmentBriefInsert(
  chainId: number,
  row: TokenPerformanceRow,
  promptRow: PromptRegistryRow,
  model: string,
  generated: GeneratedBrief
): JudgmentBriefInsert {
  const payload = generated.payload;
  return {
    chainId,
    tokenAddress: row.tokenAddress,
    poolAddress: row.poolAddress,
    mode: "REPLAY",
    alertId: null,
    evalRunId: null,
    asOf: row.enteredAt,
    promptName: promptRow.name,
    promptVersion: promptRow.version,
    templateHash: promptRow.templateHash,
    model,
    status: generated.status,
    thesis: payload?.thesis ?? null,
    confidenceBps: payload?.confidenceBps ?? null,
    recommendation: payload?.recommendation ?? null,
    riskCalls: payload?.riskCalls ?? null,
    disconfirming: payload?.disconfirming ?? null,
    whatWouldChange: payload?.whatWouldChangeThisCall ?? null,
    citationsTotal: generated.citationReport?.total ?? null,
    citationsVerified: generated.citationReport?.verified ?? null,
    delivery: null,
    costUsd: null,
    tokensIn: generated.tokensIn,
    tokensOut: generated.tokensOut,
    latencyMs: Math.round(generated.latencyMs),
    error: generated.error
  };
}

function parseToolArgs(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson);
  } catch {
    // A malformed tool call is preserved verbatim rather than dropped —
    // the audit trace must reflect exactly what the model sent.
    return { raw: argsJson };
  }
}

function toToolCallInserts(
  briefId: bigint,
  trace: readonly ToolTraceEntry[]
): JudgmentToolCallInsert[] {
  return trace.map((entry) => ({
    briefId,
    seq: entry.seq,
    toolName: entry.toolName,
    args: parseToolArgs(entry.argsJson),
    resultRowIds: entry.resultRowIds,
    result: parseToolArgs(entry.resultJson),
    resultDigest: entry.resultDigest,
    latencyMs: Math.round(entry.latencyMs)
  }));
}

function toCitationInserts(
  briefId: bigint,
  report: CitationReport
): JudgmentCitationInsert[] {
  return report.checks.map((check) => ({
    briefId,
    claimKey: check.claimKey,
    citedTable: check.pointer.table,
    // Non-decimal rowId means a fabricated citation; 0 never collides with
    // a real bigserial id (they start at 1).
    citedRowId: DECIMAL_ROW_ID.test(check.pointer.rowId) ? BigInt(check.pointer.rowId) : 0n,
    citedField: check.pointer.field,
    claimedValue: check.pointer.claimedValue,
    verified: check.verified,
    actualValue: check.actualValue
  }));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ReplayLlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export interface JudgeReplayOptions extends ReplaySelectionParams {
  readonly db: Db;
  readonly chainId: number;
  readonly dryRun: boolean;
  /** Required unless `dryRun`; ignored when `dryRun`. */
  readonly llm?: ReplayLlmConfig | undefined;
}

export interface JudgeReplayBriefResult {
  readonly poolAddress: string;
  readonly tokenAddress: string;
  readonly briefId: string;
  readonly status: BriefStatus;
  readonly citationsTotal: number;
  readonly citationsVerified: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly costUsd: string | null;
}

export interface JudgeReplayError {
  readonly poolAddress: string;
  readonly tokenAddress: string;
  readonly message: string;
}

export interface JudgeReplayResult {
  readonly promptName: string;
  readonly promptVersion: number;
  readonly candidates: number;
  readonly briefs: readonly JudgeReplayBriefResult[];
  readonly errors: readonly JudgeReplayError[];
}

/**
 * Generates and persists REPLAY briefs for every selected candidate.
 * Per-row failures (bundle assembly, LLM transport, DB write) are collected
 * so one bad pool never aborts the rest of the batch — same discipline as
 * `runPerformancePass`. `dryRun` swaps the LLM for a scripted
 * `FakeLlmClient` whose output is clearly non-evaluative (see
 * `buildDryRunPayload`); real generation requires `llm`.
 */
export async function runJudgeReplay(options: JudgeReplayOptions): Promise<JudgeReplayResult> {
  const { db, chainId } = options;
  if (!options.dryRun && options.llm === undefined) {
    throw new WorkerConfigError(
      "LLM_API_KEY/JUDGMENT_MODEL",
      "judge:replay requires LLM configuration unless dryRun is set"
    );
  }

  const spec = briefPromptSpecV1();
  const promptRow = await getOrCreatePrompt(db, {
    name: spec.name,
    template: spec.template,
    templateHash: spec.templateHash,
    changelog: BRIEF_PROMPT_V1_CHANGELOG
  });
  // Always score against the persisted row, not the hardcoded literal — the
  // literal's `version` can drift from the DB's if `getOrCreatePrompt` had
  // to mint a new version for an unrelated concurrent template edit.
  const prompt: PromptSpec = {
    name: promptRow.name,
    version: promptRow.version,
    template: promptRow.template,
    templateHash: promptRow.templateHash
  };

  const [perfRows, existingReplayBriefs] = await Promise.all([
    listTokenPerformance(db, chainId),
    listJudgmentBriefs(db, chainId, {
      mode: "REPLAY",
      promptName: prompt.name,
      promptVersion: prompt.version
    })
  ]);

  const candidates = selectReplayCandidates(perfRows, existingReplayBriefs, options);

  const model = options.dryRun ? DRY_RUN_MODEL : options.llm!.model;
  const sharedLlm: LlmClient | undefined = options.dryRun
    ? undefined
    : createOpenAiCompatibleLlmClient({
        baseUrl: options.llm!.baseUrl,
        apiKey: options.llm!.apiKey
      });

  const briefs: JudgeReplayBriefResult[] = [];
  const errors: JudgeReplayError[] = [];

  for (const row of candidates) {
    try {
      const bundle = await assembleEvidenceBundle({
        db,
        chainId,
        tokenAddress: row.tokenAddress,
        poolAddress: row.poolAddress,
        asOf: row.enteredAt,
        mode: "REPLAY"
      });
      const toolkit = createJudgmentToolkit({ db, bundle });
      const fetchCitedRow: CitedRowFetcher = (table: CitableTable, rowId: bigint) =>
        getCitedRow(db, table, rowId);
      const llm: LlmClient = options.dryRun
        ? createFakeLlmClient([{ content: JSON.stringify(buildDryRunPayload(row)) }])
        : sharedLlm!;

      const generated = await generateBrief({
        llm,
        model,
        toolkit,
        bundle,
        prompt,
        fetchCitedRow
      });

      const inserted = await insertJudgmentBrief(
        db,
        toJudgmentBriefInsert(chainId, row, promptRow, model, generated)
      );
      if (inserted === undefined) {
        // Defensive only: REPLAY rows carry alertId=null, which never
        // collides against the alertId unique index, so this never fires.
        continue;
      }

      if (generated.toolTrace.length > 0) {
        await insertJudgmentToolCalls(db, toToolCallInserts(inserted.id, generated.toolTrace));
      }
      if (generated.citationReport !== null && generated.citationReport.total > 0) {
        await insertJudgmentCitations(db, toCitationInserts(inserted.id, generated.citationReport));
      }

      briefs.push({
        poolAddress: row.poolAddress,
        tokenAddress: row.tokenAddress,
        briefId: inserted.id.toString(),
        status: generated.status,
        citationsTotal: generated.citationReport?.total ?? 0,
        citationsVerified: generated.citationReport?.verified ?? 0,
        tokensIn: generated.tokensIn,
        tokensOut: generated.tokensOut,
        latencyMs: Math.round(generated.latencyMs),
        costUsd: inserted.costUsd
      });
    } catch (error) {
      errors.push({
        poolAddress: row.poolAddress,
        tokenAddress: row.tokenAddress,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    promptName: prompt.name,
    promptVersion: prompt.version,
    candidates: candidates.length,
    briefs,
    errors
  };
}

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

/**
 * `LLM_API_KEY` + `JUDGMENT_MODEL`, same partial-config hard-error rule as
 * `loadTelegramConfigFromEnv`: both set => configured, neither => undefined
 * (only tolerated with `--dry-run`), one without the other => hard error.
 */
function loadReplayLlmConfigFromEnv(env: EnvSource): ReplayLlmConfig | undefined {
  const apiKey = env["LLM_API_KEY"]?.trim();
  const model = env["JUDGMENT_MODEL"]?.trim();
  const hasKey = apiKey !== undefined && apiKey !== "";
  const hasModel = model !== undefined && model !== "";
  if (!hasKey && !hasModel) return undefined;
  if (!hasKey) {
    throw new WorkerConfigError("LLM_API_KEY", "required when JUDGMENT_MODEL is set");
  }
  if (!hasModel) {
    throw new WorkerConfigError("JUDGMENT_MODEL", "required when LLM_API_KEY is set");
  }
  const baseUrl = env["LLM_API_BASE_URL"]?.trim() || DEFAULT_LLM_BASE_URL;
  return { baseUrl, apiKey, model };
}

async function main(): Promise<void> {
  const logger = createLogger();
  const args = parseReplayArgs(process.argv.slice(2));
  const env = process.env;
  const chainConfig = loadChainConfigFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);

  const llmConfig = args.dryRun ? undefined : loadReplayLlmConfigFromEnv(env);
  if (!args.dryRun && llmConfig === undefined) {
    throw new WorkerConfigError(
      "LLM_API_KEY/JUDGMENT_MODEL",
      "judge:replay requires LLM_API_KEY and JUDGMENT_MODEL to be set unless --dry-run is passed"
    );
  }
  if (args.dryRun) {
    logger.info("judge_replay.dry_run", {
      note: "FakeLlmClient scripted output — pipeline test only, never a real evaluation"
    });
  }

  const handle = createDatabase(databaseUrl);
  try {
    await handle.applyMigrations();
    const result = await runJudgeReplay({
      db: handle.db,
      chainId: chainConfig.chainId,
      horizonHours: args.horizonHours,
      from: args.from,
      to: args.to,
      limit: args.limit,
      dryRun: args.dryRun,
      llm: llmConfig
    });

    for (const brief of result.briefs) {
      logger.info("judge_replay.brief", {
        poolAddress: brief.poolAddress,
        tokenAddress: brief.tokenAddress,
        status: brief.status,
        citationsTotal: brief.citationsTotal,
        citationsVerified: brief.citationsVerified,
        tokensIn: brief.tokensIn,
        tokensOut: brief.tokensOut,
        latencyMs: brief.latencyMs,
        ...(brief.costUsd !== null ? { costUsd: brief.costUsd } : {})
      });
    }
    for (const error of result.errors) {
      logger.error("judge_replay.brief_error", { ...error });
    }

    logger.info("judge_replay.summary", {
      promptName: result.promptName,
      promptVersion: result.promptVersion,
      candidates: result.candidates,
      generated: result.briefs.length,
      failed: result.errors.length,
      dryRun: args.dryRun
    });
  } finally {
    await handle.close();
  }
}

// Run only when executed directly — see feedback.ts; importing the pure
// selection/mapping helpers above must never open a database connection.
if (import.meta.main) {
  main().catch((error: unknown) => {
    createLogger().error("judge_replay.crashed", { error });
    process.exit(1);
  });
}
