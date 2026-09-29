import type {
  PoolActivitySnapshotRow,
  PoolSnapshotRow,
  TokenHolderSnapshotRow,
  TokenRiskRow,
  TradeSimulationRow
} from "@assay/database";
import type { AlertLevel } from "@assay/scoring";

/**
 * Shared contract for the advisory judgment layer.
 *
 * Invariants encoded here, not merely documented:
 *
 * - The LLM is a briefer, never a judge: nothing in this package can gate,
 *   delay, or alter a deterministic alert. The worker's judgment loop reads
 *   `alerts_sent` rows that are already committed and delivered.
 * - Every claim must cite an append-only row by id; citations are re-fetched
 *   and machine-verified.
 * - Tool arguments are numbers, enums, and whitelisted table names only.
 *   Attacker-controlled strings (token name/symbol/website) are typed as
 *   {@link UntrustedString} and can never reach a tool argument.
 */

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/**
 * Tables a brief may cite. All append-only with bigserial primary keys, so a
 * (table, rowId) pointer is stable forever. Deliberately excludes mutable
 * tables (`tokens`, `pools`, `token_holders`).
 */
export const CITABLE_TABLES = [
  "pool_snapshots",
  "pool_activity_snapshots",
  "token_holder_snapshots",
  "token_risks",
  "trade_simulations",
  "token_outcomes",
  "token_performance"
] as const;

export type CitableTable = (typeof CITABLE_TABLES)[number];

/**
 * Virtual citation table for audited tool-call results. A pointer
 * `{table: "judgment_tool_calls", rowId: "<seq>", field}` cites the named
 * top-level key of the tool result the model received in this conversation
 * (the engine labels each tool message with a matching
 * `callRef: "judgment_tool_calls:<seq>"`). Verified against the in-memory
 * tool trace at generation time and against the persisted `result` body on
 * replay — never by re-executing the tool, whose output may be
 * time-sensitive.
 */
export const TOOL_CALL_CITATION_TABLE = "judgment_tool_calls";

/** Pointer to one append-only row backing a bundle field or a claim. */
export interface SourceRef {
  readonly table: CitableTable;
  /** bigserial id as a decimal string — never a JS number. */
  readonly rowId: string;
}

/**
 * One evidence pointer inside a brief: the LLM asserts that
 * `table[rowId].field` equals `claimedValue`. Verified by re-fetching.
 */
export interface EvidencePointer {
  readonly table: string;
  readonly rowId: string;
  readonly field: string;
  readonly claimedValue: string;
}

export type CitationFailureReason =
  | "UNKNOWN_TABLE"
  | "ROW_NOT_FOUND"
  | "FIELD_NOT_FOUND"
  | "VALUE_MISMATCH";

/** Verification result for one pointer. */
export interface CitationCheck {
  /** Brief clause the pointer belongs to, e.g. "thesis", "riskCalls[1]". */
  readonly claimKey: string;
  readonly pointer: EvidencePointer;
  readonly verified: boolean;
  /** Populated on failure (except ROW_NOT_FOUND/UNKNOWN_TABLE). */
  readonly actualValue: string | null;
  readonly reason: "OK" | CitationFailureReason;
}

export interface CitationReport {
  readonly checks: readonly CitationCheck[];
  readonly total: number;
  readonly verified: number;
  /** Failures on load-bearing clauses (thesis + riskCalls). */
  readonly loadBearingFailures: number;
  /** REJECT when any load-bearing citation failed. */
  readonly verdict: "OK" | "REJECT";
}

/**
 * Fetches one citable row as a column->value record (drizzle camelCase
 * column names), or undefined when absent. Backed by a typed per-table
 * dispatch in @assay/database — never string-built SQL.
 */
export type CitedRowFetcher = (
  table: CitableTable,
  rowId: bigint
) => Promise<Record<string, unknown> | undefined>;

/** Numeric tolerance for claimed-vs-actual comparison (LLMs round). */
export interface CitationTolerance {
  /** Maximum relative deviation in basis points (100 = 1%). */
  readonly relativeBps: number;
}

export const DEFAULT_CITATION_TOLERANCE: CitationTolerance = {
  relativeBps: 100
};

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type FieldProvenance =
  | "CHAIN_NUMERIC"
  | "CHAIN_DERIVED"
  | "ATTACKER_STRING";

/**
 * An attacker-controlled string (token name, symbol, website, description).
 * Data, never instructions: rendered only inside an explicit untrusted fence
 * and never interpolated into system prompts or tool arguments.
 */
export interface UntrustedString {
  readonly text: string;
  readonly provenance: "ATTACKER_STRING";
}

// ---------------------------------------------------------------------------
// Evidence bundle
// ---------------------------------------------------------------------------

export type JudgmentMode = "LIVE" | "REPLAY";

/** A raw database row plus the citation pointer for it. */
export interface SourcedRow<T> {
  readonly row: T;
  readonly source: SourceRef;
}

/** Alert context for LIVE briefs; null in REPLAY (no alert fired). */
export interface BundleAlert {
  readonly alertId: string;
  readonly level: AlertLevel;
  readonly score: number;
  readonly reason: string;
  readonly sentAt: Date;
}

export interface BundleToken {
  readonly address: string;
  readonly decimals: number | null;
  readonly totalSupply: string | null;
  readonly deployerAddress: string | null;
  readonly deployerStatus: string | null;
  readonly name: UntrustedString | null;
  readonly symbol: UntrustedString | null;
}

export interface BundlePool {
  readonly address: string;
  readonly dex: string;
  readonly kind: string;
  readonly createdAtBlock: string;
  readonly discoveredAt: Date;
  readonly quoteTokenAddress: string | null;
}

/**
 * Everything true about a candidate as of `asOf`, assembled exclusively from
 * append-only history via `captured_at <= asOf` reads. The same assembly
 * serves live briefs (asOf = alert sent_at) and replay (asOf = historical
 * band entry); the leakage guard asserts no row postdates `asOf`.
 */
export interface EvidenceBundle {
  readonly chainId: number;
  readonly mode: JudgmentMode;
  readonly asOf: Date;
  readonly alert: BundleAlert | null;
  readonly token: BundleToken;
  readonly pool: BundlePool;
  /** Full snapshot series capped at asOf, ascending by captured_at. */
  readonly marketSeries: readonly SourcedRow<PoolSnapshotRow>[];
  readonly activity: SourcedRow<PoolActivitySnapshotRow> | null;
  readonly holders: SourcedRow<TokenHolderSnapshotRow> | null;
  readonly risk: SourcedRow<TokenRiskRow> | null;
  readonly simulation: SourcedRow<TradeSimulationRow> | null;
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

export type BriefStatus =
  | "COMPLETED"
  | "FAILED"
  | "REJECTED_FABRICATED_CITATION";

/** Advisory only. The human decides; this is the briefer's argued stance. */
export type BriefRecommendation = "RESEARCH" | "WATCH" | "PASS";

/**
 * Machine taxonomy for risk calls so per-tag precision/recall is computable
 * against realized outcomes.
 */
export const RISK_TAGS = [
  "RUG_LP_PULL",
  "SELL_RESTRICTION",
  "CONCENTRATION_DUMP",
  "WASH_COORDINATION",
  "NO_FOLLOW_THROUGH",
  "OTHER"
] as const;

export type RiskTag = (typeof RISK_TAGS)[number];

export type RiskSeverity = "LOW" | "MEDIUM" | "HIGH";

export interface RiskCall {
  readonly risk: string;
  readonly tag: RiskTag;
  readonly severity: RiskSeverity;
  /** At least one pointer; a risk call with none is rejected by the parser. */
  readonly evidence: readonly EvidencePointer[];
}

export interface CitedClaim {
  readonly claim: string;
  readonly evidence: readonly EvidencePointer[];
}

/**
 * The structured object the LLM must emit. Parsed and validated by code
 * (`parseBriefPayload`); free text or schema violations are FAILED, never
 * best-effort-parsed.
 */
export interface JudgmentBriefPayload {
  readonly thesis: string;
  /** Evidence for the thesis itself; load-bearing for citation checking. */
  readonly thesisEvidence: readonly EvidencePointer[];
  /** Stated confidence in the recommendation, 0..10000. */
  readonly confidenceBps: number;
  /** Exactly the top 3, ranked most severe first. */
  readonly riskCalls: readonly RiskCall[];
  readonly disconfirming: readonly CitedClaim[];
  /** Concrete observable events that would invalidate the call. */
  readonly whatWouldChangeThisCall: readonly string[];
  readonly recommendation: BriefRecommendation;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const JUDGMENT_TOOL_NAMES = [
  "comparableLaunches",
  "baseRateForPattern",
  "deployerHistory",
  "liquidityTrajectory",
  "slippageAtSize",
  "cohortPercentiles",
  "marketSeries",
  "fetchCitedRow"
] as const;

export type JudgmentToolName = (typeof JUDGMENT_TOOL_NAMES)[number];

/**
 * Entry-feature keys usable in base-rate predicates and k-NN distance.
 * Mirrors `PerformanceEntryFeatures` / calibrate.ts feature keys; numeric
 * only, so predicates never carry strings.
 */
export const BASE_RATE_FEATURES = [
  "quoteLiquidityUsd",
  "totalLiquidityUsd",
  "ageMinutesAtEntry",
  "uniqueBuyers1h",
  "buySizeGiniBps",
  "buySizeEntropyBps",
  "repeatedSizeBuyPctBps",
  "floatBps",
  "supplyInPoolBps",
  "adjustedTop10PctBps",
  "deployerPctBps",
  "adjustedHolderCount",
  "effectiveSellLossBps"
] as const;

export type BaseRateFeature = (typeof BASE_RATE_FEATURES)[number];

export interface BaseRatePredicate {
  readonly feature: BaseRateFeature;
  readonly op: "lte" | "gte";
  readonly value: number;
}

/** What one tool execution returns to the engine. */
export interface ToolExecutionResult {
  /** JSON string handed back to the LLM as the tool message. */
  readonly resultJson: string;
  /** Citable row ids surfaced by this call, "table:id" strings. */
  readonly resultRowIds: readonly string[];
  /** True when the call failed validation or execution; LLM sees the error. */
  readonly isError: boolean;
}

/**
 * The fixed, read-only history toolkit handed to the engine. Implementations
 * validate `argsJson` strictly (numbers/enums only) and must respect the
 * bundle's `asOf`: replay-unsafe tools (cohort percentiles) report
 * themselves unavailable in REPLAY mode instead of leaking the present.
 */
export interface JudgmentToolkit {
  readonly defs: readonly LlmToolDef[];
  execute(name: string, argsJson: string): Promise<ToolExecutionResult>;
}

/** One audited tool call, persisted to `judgment_tool_calls`. */
export interface ToolTraceEntry {
  readonly seq: number;
  readonly toolName: string;
  readonly argsJson: string;
  readonly resultRowIds: readonly string[];
  /** Exact JSON string the LLM received for this call (citation source). */
  readonly resultJson: string;
  /** sha-256 hex of resultJson; makes replays byte-comparable. */
  readonly resultDigest: string;
  readonly latencyMs: number;
  readonly isError: boolean;
}

// ---------------------------------------------------------------------------
// LLM client
// ---------------------------------------------------------------------------

export interface LlmToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON-schema object for the tool's arguments. */
  readonly parameters: Record<string, unknown>;
}

export interface LlmToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly argsJson: string;
}

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /** Present on assistant messages that request tool calls. */
  readonly toolCalls?: readonly LlmToolCallRequest[];
  /** Present on tool messages: which request this answers. */
  readonly toolCallId?: string;
}

export interface LlmCompletionRequest {
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly tools?: readonly LlmToolDef[];
  /** When set, the final answer must be a JSON object of this schema. */
  readonly responseSchema?: {
    readonly name: string;
    readonly schema: Record<string, unknown>;
  };
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface LlmCompletionResponse {
  readonly message: LlmMessage;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/**
 * Pluggable LLM transport, same discipline as `AlertTransport`: dry-run/fake
 * default in tests, real implementation selected by configuration, partial
 * configuration is a hard error.
 */
export interface LlmClient {
  complete(
    request: LlmCompletionRequest,
    signal?: AbortSignal
  ): Promise<LlmCompletionResponse>;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface PromptSpec {
  readonly name: string;
  readonly version: number;
  readonly template: string;
  /** sha-256 hex of the template. */
  readonly templateHash: string;
}

export interface JudgmentEngineConfig {
  /** Max LLM<->tool round trips before forcing a final answer. */
  readonly maxToolRounds: number;
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly citationTolerance: CitationTolerance;
}

export const DEFAULT_ENGINE_CONFIG: JudgmentEngineConfig = {
  maxToolRounds: 8,
  maxOutputTokens: 4_096,
  temperature: 0.2,
  citationTolerance: DEFAULT_CITATION_TOLERANCE
};

export interface GenerateBriefDeps {
  readonly llm: LlmClient;
  readonly model: string;
  readonly toolkit: JudgmentToolkit;
  readonly bundle: EvidenceBundle;
  readonly prompt: PromptSpec;
  readonly fetchCitedRow: CitedRowFetcher;
  readonly config?: Partial<JudgmentEngineConfig>;
  readonly signal?: AbortSignal;
}

/** Everything the worker persists about one generation attempt. */
export interface GeneratedBrief {
  readonly status: BriefStatus;
  /** Parsed payload; null when FAILED before/at parsing. */
  readonly payload: JudgmentBriefPayload | null;
  /** Null when generation failed before citation checking. */
  readonly citationReport: CitationReport | null;
  readonly toolTrace: readonly ToolTraceEntry[];
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly error: string | null;
}

// ---------------------------------------------------------------------------
// Realized-outcome taxonomy (judge ground truth)
// ---------------------------------------------------------------------------

export type RealizedLabel = "RUGGED" | "BLED" | "HELD_BAND" | "RUNNER";

export interface TaxonomyConfig {
  /** Below this max multiple (bps) a survivor is BLED. */
  readonly bledMaxMultipleBps: number;
  /** At or above this max multiple (bps) the label is RUNNER. */
  readonly runnerMinMultipleBps: number;
}

export const DEFAULT_TAXONOMY_CONFIG: TaxonomyConfig = {
  bledMaxMultipleBps: 11_000,
  runnerMinMultipleBps: 20_000
};

/** Inputs derived from token_performance + token_outcomes for one horizon. */
export interface RealizedOutcomeInput {
  readonly maxMultipleBps: number;
  /** DIED outcome at (or nearest at-or-below) the horizon. */
  readonly died: boolean;
  /** Observed quote-liquidity collapse inside the window. */
  readonly liquidityCollapsed: boolean;
}
