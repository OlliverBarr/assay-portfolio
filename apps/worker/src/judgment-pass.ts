/**
 * One judgment pass: for every LIVE alert at or above the configured
 * minimum level that has no brief yet, assemble its as-of evidence bundle,
 * run the judgment engine, and persist whatever it produced. The LLM is
 * strictly advisory and downstream of alerting — this pass reads committed
 * `alerts_sent` rows and can never delay or gate an alert. A COMPLETED brief
 * gets one follow-up delivery via the existing alert transport; FAILED and
 * REJECTED_FABRICATED_CITATION briefs are persisted for the audit trail but
 * never delivered. Per-alert failures are collected so one bad alert never
 * starves the rest of the batch (mirrors `performance-pass.ts`).
 */
import {
  getCitedRow,
  insertJudgmentBrief,
  insertJudgmentCitations,
  insertJudgmentToolCalls,
  listAlertsNeedingBrief,
  updateJudgmentBriefDelivery,
  type Db,
  type JudgmentBriefInsert,
  type JudgmentCitationInsert,
  type JudgmentToolCallInsert
} from "@assay/database";
import type { AlertLevel } from "@assay/scoring";
import { escapeHtml, type AlertTransport } from "@assay/alerts";
import {
  assembleEvidenceBundle,
  createJudgmentToolkit,
  generateBrief,
  type CitationReport,
  type CitedRowFetcher,
  type EvidenceBundle,
  type GeneratedBrief,
  type JudgmentBriefPayload,
  type JudgmentToolkit,
  type LlmClient,
  type PromptSpec,
  type ToolkitConfig
} from "@assay/judgment";

import type { JudgmentMinAlertLevel } from "./config.js";

/** Alert levels a given minimum admits, from least to most inclusive. */
const MIN_ALERT_LEVEL_SETS: Record<JudgmentMinAlertLevel, readonly AlertLevel[]> = {
  RED: ["RED", "YELLOW", "GREEN"],
  YELLOW: ["YELLOW", "GREEN"],
  GREEN: ["GREEN"]
};

export interface JudgmentPassOptions {
  readonly db: Db;
  readonly chainId: number;
  readonly llm: LlmClient;
  readonly model: string;
  readonly prompt: PromptSpec;
  readonly transport: AlertTransport;
  readonly minAlertLevel: JudgmentMinAlertLevel;
  readonly batchLimit: number;
  readonly maxToolRounds: number;
  readonly timeoutMs: number;
  /**
   * Per-token re-brief suppression window (see `listAlertsNeedingBrief`):
   * a token with a COMPLETED brief this recent is only re-briefed on a
   * level escalation. 0 disables.
   */
  readonly rebriefCooldownMs: number;
  readonly toolkitConfig?: Partial<ToolkitConfig>;
  readonly signal?: AbortSignal;
  /** Injectable for tests. */
  readonly now?: () => Date;
}

export interface JudgmentBriefError {
  readonly alertId: string;
  readonly message: string;
}

export interface JudgmentPassResult {
  readonly chainId: number;
  readonly alertsConsidered: number;
  readonly briefsCompleted: number;
  readonly briefsFailed: number;
  readonly briefsRejected: number;
  /** Another instance already briefed this alert; `insertJudgmentBrief` returned undefined. */
  readonly briefsSkipped: number;
  readonly delivered: number;
  readonly briefErrors: readonly JudgmentBriefError[];
  readonly stopped: boolean;
}

/** Non-numeric or negative pointer row ids are a fabrication signal, not a crash: park them at 0. */
const DECIMAL_ROW_ID = /^\d+$/;

function citedRowIdFor(rowId: string): bigint {
  return DECIMAL_ROW_ID.test(rowId) ? BigInt(rowId) : 0n;
}

export interface MergedAbortSignal {
  readonly signal: AbortSignal;
  /** Detaches the listeners this merge added; call once the merged signal is no longer needed. */
  readonly cleanup: () => void;
}

/**
 * Composes a fresh (per-call, short-lived) signal with a long-lived loop
 * signal, aborting when either fires. Deliberately hand-rolled instead of
 * `AbortSignal.any` (Bun/Node 20+ only — not guaranteed on every runtime
 * this worker ships to) and always paired with `cleanup()` so listening on
 * the long-lived loop signal every pass never accumulates.
 */
function mergeAbortSignals(a: AbortSignal, b: AbortSignal | undefined): MergedAbortSignal {
  if (b === undefined) return { signal: a, cleanup: () => {} };
  const controller = new AbortController();
  if (a.aborted || b.aborted) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => {} };
  }
  const onAbort = (): void => controller.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      a.removeEventListener("abort", onAbort);
      b.removeEventListener("abort", onAbort);
    }
  };
}

/** Tool-call args as sent by the LLM are unvalidated wire input; malformed JSON is stored, not thrown. */
function safeParseArgs(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson);
  } catch {
    return { invalidJson: argsJson };
  }
}

function toBriefInsert(
  chainId: number,
  alert: { id: bigint; tokenAddress: string; poolAddress: string },
  bundle: EvidenceBundle,
  prompt: PromptSpec,
  model: string,
  generated: GeneratedBrief
): JudgmentBriefInsert {
  const payload = generated.payload;
  return {
    chainId,
    tokenAddress: alert.tokenAddress,
    poolAddress: alert.poolAddress,
    mode: "LIVE",
    alertId: alert.id,
    evalRunId: null,
    asOf: bundle.asOf,
    promptName: prompt.name,
    promptVersion: prompt.version,
    templateHash: prompt.templateHash,
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

/** Delivered-brief list caps: bound message length, keep ranked-top content. */
const MAX_BRIEF_RISKS = 2;
const MAX_BRIEF_DISCONFIRMING = 3;
const MAX_BRIEF_WHAT_CHANGES = 3;

/**
 * Advisory-labeled follow-up message in Telegram HTML (the shared transport
 * sends `parse_mode: "HTML"`, so every LLM-generated string is escaped and
 * the contract address is a tap-to-copy `<code>` block). Pure. The header is
 * a bare label: the alert message immediately preceding the brief already
 * carries the token name/symbol, so the identity line is deliberately not
 * repeated; only the permanent address anchors the brief. The pool address
 * is deliberately NOT displayed (operator feedback 2026-07-12: message
 * noise). Lists are capped (top 2 risks, top 3 disconfirming, top 3
 * what-would-change) to keep the message short. Never uses trading language
 * ("buy"/"sell"/"ape"/"long"/"short"), a research-attention signal, not an
 * instruction.
 */
export function formatBriefMessage(
  bundle: EvidenceBundle,
  payload: JudgmentBriefPayload,
  citationReport: CitationReport
): string {
  const lines: string[] = [];
  lines.push("🔬 Research brief (advisory)");
  lines.push(`CA: <code>${bundle.token.address}</code>`);
  lines.push(
    `Recommendation: ${payload.recommendation} · Confidence: ${(payload.confidenceBps / 100).toFixed(1)}%`
  );
  lines.push(`Thesis: ${escapeHtml(payload.thesis)}`);

  const risks = payload.riskCalls.slice(0, MAX_BRIEF_RISKS);
  if (risks.length > 0) {
    lines.push("Top risks:");
    for (const risk of risks) {
      lines.push(`⚠ [${risk.tag}/${risk.severity}] ${escapeHtml(risk.risk)}`);
    }
  }

  const disconfirming = payload.disconfirming.slice(0, MAX_BRIEF_DISCONFIRMING);
  if (disconfirming.length > 0) {
    lines.push("Disconfirming:");
    for (const claim of disconfirming) {
      lines.push(`- ${escapeHtml(claim.claim)}`);
    }
  }

  const changes = payload.whatWouldChangeThisCall.slice(0, MAX_BRIEF_WHAT_CHANGES);
  if (changes.length > 0) {
    lines.push("What would change this call:");
    for (const change of changes) {
      lines.push(`- ${escapeHtml(change)}`);
    }
  }

  lines.push(`Citations verified: ${citationReport.verified}/${citationReport.total}`);
  lines.push("Advisory research only, not trading instructions — the human decides.");
  return lines.join("\n");
}

/**
 * Runs the judgment engine over one alert's evidence and persists the
 * result unconditionally: `generateBrief` never throws, so every attempt
 * lands a final-status row. Returns `"skipped"` when a concurrent instance
 * already inserted a brief for this alert (idempotent race, not an error).
 */
interface BriefOutcome {
  readonly status: "completed" | "failed" | "rejected" | "skipped";
  readonly delivered: boolean;
}

async function briefOneAlert(
  options: JudgmentPassOptions,
  alert: { id: bigint; tokenAddress: string; poolAddress: string; alertLevel: string; score: number; reason: string; sentAt: Date }
): Promise<BriefOutcome> {
  const { db, chainId } = options;

  const bundle = await assembleEvidenceBundle({
    db,
    chainId,
    tokenAddress: alert.tokenAddress,
    poolAddress: alert.poolAddress,
    asOf: alert.sentAt,
    mode: "LIVE",
    alert: {
      alertId: alert.id.toString(),
      level: alert.alertLevel as AlertLevel,
      score: alert.score,
      reason: alert.reason,
      sentAt: alert.sentAt
    }
  });

  const toolkit: JudgmentToolkit = createJudgmentToolkit({
    db,
    bundle,
    ...(options.toolkitConfig === undefined ? {} : { config: options.toolkitConfig })
  });
  const fetchCitedRow: CitedRowFetcher = (table, rowId) => getCitedRow(db, table, rowId);

  // `AbortSignal.any` isn't available on every Node runtime this worker may
  // run under (only Bun/Node 20+); composed manually with explicit listener
  // cleanup so a long-lived loop signal never accumulates listeners.
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const merged = mergeAbortSignals(timeoutSignal, options.signal);

  let generated: GeneratedBrief;
  try {
    generated = await generateBrief({
      llm: options.llm,
      model: options.model,
      toolkit,
      bundle,
      prompt: options.prompt,
      fetchCitedRow,
      config: { maxToolRounds: options.maxToolRounds },
      signal: merged.signal
    });
  } finally {
    merged.cleanup();
  }

  const brief = await insertJudgmentBrief(
    db,
    toBriefInsert(chainId, alert, bundle, options.prompt, options.model, generated)
  );
  if (brief === undefined) return { status: "skipped", delivered: false };

  if (generated.toolTrace.length > 0) {
    const toolCallRows: JudgmentToolCallInsert[] = generated.toolTrace.map((entry) => ({
      briefId: brief.id,
      seq: entry.seq,
      toolName: entry.toolName,
      args: safeParseArgs(entry.argsJson),
      resultRowIds: entry.resultRowIds,
      result: safeParseArgs(entry.resultJson),
      resultDigest: entry.resultDigest,
      latencyMs: Math.round(entry.latencyMs)
    }));
    await insertJudgmentToolCalls(db, toolCallRows);
  }

  if (generated.citationReport !== null && generated.citationReport.checks.length > 0) {
    const citationRows: JudgmentCitationInsert[] = generated.citationReport.checks.map((check) => ({
      briefId: brief.id,
      claimKey: check.claimKey,
      citedTable: check.pointer.table,
      citedRowId: citedRowIdFor(check.pointer.rowId),
      citedField: check.pointer.field,
      claimedValue: check.pointer.claimedValue,
      verified: check.verified,
      actualValue: check.actualValue
    }));
    await insertJudgmentCitations(db, citationRows);
  }

  let delivered = false;
  if (generated.status === "COMPLETED" && generated.payload !== null && generated.citationReport !== null) {
    try {
      await options.transport.send(formatBriefMessage(bundle, generated.payload, generated.citationReport));
      await updateJudgmentBriefDelivery(db, brief.id, "SENT");
      delivered = true;
    } catch {
      await updateJudgmentBriefDelivery(db, brief.id, "SEND_FAILED");
    }
  } else {
    await updateJudgmentBriefDelivery(db, brief.id, "SKIPPED");
  }

  if (generated.status === "COMPLETED") return { status: "completed", delivered };
  if (generated.status === "REJECTED_FABRICATED_CITATION") return { status: "rejected", delivered };
  return { status: "failed", delivered };
}

export async function runJudgmentPass(options: JudgmentPassOptions): Promise<JudgmentPassResult> {
  const { db, chainId } = options;
  // Function call (not property read) so TS doesn't narrow `aborted` across awaits.
  const isAborted = (): boolean => options.signal?.aborted === true;

  const levels = MIN_ALERT_LEVEL_SETS[options.minAlertLevel];
  const alerts = await listAlertsNeedingBrief(
    db,
    chainId,
    levels,
    options.batchLimit,
    options.rebriefCooldownMs
  );

  let briefsCompleted = 0;
  let briefsFailed = 0;
  let briefsRejected = 0;
  let briefsSkipped = 0;
  let delivered = 0;
  const briefErrors: JudgmentBriefError[] = [];
  let stopped = false;

  for (const alert of alerts) {
    if (isAborted()) {
      stopped = true;
      break;
    }
    try {
      const outcome = await briefOneAlert(options, alert);
      if (outcome.status === "completed") {
        briefsCompleted += 1;
      } else if (outcome.status === "rejected") {
        briefsRejected += 1;
      } else if (outcome.status === "skipped") {
        briefsSkipped += 1;
      } else {
        briefsFailed += 1;
      }
      if (outcome.delivered) delivered += 1;
    } catch (error) {
      briefErrors.push({
        alertId: alert.id.toString(),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    chainId,
    alertsConsidered: alerts.length,
    briefsCompleted,
    briefsFailed,
    briefsRejected,
    briefsSkipped,
    delivered,
    briefErrors,
    stopped
  };
}
