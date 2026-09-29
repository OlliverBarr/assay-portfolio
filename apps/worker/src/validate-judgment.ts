/**
 * OPT-IN — live probe for one judgment brief: picks the latest YELLOW/GREEN
 * alert (or an explicit `--token`/`--pool` pair), assembles its evidence
 * bundle, and runs the real judgment engine against it. Prints the rendered
 * evidence, the tool trace, the citation report, and the formatted delivery
 * message. Reads only — makes no database writes (no brief is persisted, no
 * prompt is registered) and never sends anything to the alert transport.
 * Never part of `bun run test`. Requires a configured LLM (`LLM_API_KEY` +
 * `JUDGMENT_MODEL`); hard error otherwise.
 *
 *   bun run validate:judgment
 *   bun run validate:judgment -- --token=0x... --pool=0x...
 */
import { getAddress } from "viem";

import { loadChainConfigFromEnv } from "@assay/chain";
import {
  createDatabase,
  getCitedRow,
  getLatestAlert,
  listAlertsSent,
  type AlertSentRow,
  type Db
} from "@assay/database";
import type { AlertLevel } from "@assay/scoring";
import {
  assembleEvidenceBundle,
  briefPromptSpecV1,
  createJudgmentToolkit,
  createOpenAiCompatibleLlmClient,
  generateBrief,
  renderEvidence,
  type BundleAlert,
  type CitedRowFetcher,
  type ToolTraceEntry
} from "@assay/judgment";

import { loadDatabaseUrlFromEnv, loadJudgmentConfigFromEnv, WorkerConfigError } from "./config.js";
import { formatBriefMessage } from "./judgment-pass.js";
import { createLogger, type Logger } from "./log.js";

const LIVE_ALERT_LEVELS: readonly AlertLevel[] = ["YELLOW", "GREEN"];

function parseAddressArg(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  const raw = arg?.split("=")[1];
  if (raw === undefined || raw === "") return undefined;
  return getAddress(raw);
}

function toBundleAlert(alert: AlertSentRow): BundleAlert {
  return {
    alertId: alert.id.toString(),
    level: alert.alertLevel as AlertLevel,
    score: alert.score,
    reason: alert.reason,
    sentAt: alert.sentAt
  };
}

interface ValidationTarget {
  readonly tokenAddress: string;
  readonly poolAddress: string;
  readonly asOf: Date;
  readonly alert: BundleAlert | null;
}

/**
 * Explicit `--token`/`--pool` args target that pool directly, reusing its
 * most recent alert as context when one exists. Otherwise falls back to the
 * newest YELLOW/GREEN alert on the chain — the population this loop actually
 * briefs in production.
 */
async function pickTarget(
  db: Db,
  chainId: number,
  tokenArg: string | undefined,
  poolArg: string | undefined
): Promise<ValidationTarget> {
  if (tokenArg !== undefined || poolArg !== undefined) {
    if (tokenArg === undefined || poolArg === undefined) {
      throw new WorkerConfigError("--token/--pool", "both must be set together");
    }
    const latestAlert = await getLatestAlert(db, chainId, tokenArg);
    return {
      tokenAddress: tokenArg,
      poolAddress: poolArg,
      asOf: latestAlert?.sentAt ?? new Date(),
      alert: latestAlert === undefined ? null : toBundleAlert(latestAlert)
    };
  }

  const alerts = await listAlertsSent(db, chainId);
  const latest = alerts.find((a) => LIVE_ALERT_LEVELS.includes(a.alertLevel as AlertLevel));
  if (latest === undefined) {
    throw new WorkerConfigError(
      "alerts_sent",
      "no YELLOW/GREEN alert found; pass --token=0x... --pool=0x... to target one directly"
    );
  }
  return {
    tokenAddress: latest.tokenAddress,
    poolAddress: latest.poolAddress,
    asOf: latest.sentAt,
    alert: toBundleAlert(latest)
  };
}

function logToolTrace(logger: Logger, toolTrace: readonly ToolTraceEntry[]): void {
  for (const entry of toolTrace) {
    logger.info("validate_judgment.tool_call", {
      seq: entry.seq,
      toolName: entry.toolName,
      args: entry.argsJson,
      resultRowIds: entry.resultRowIds,
      latencyMs: Math.round(entry.latencyMs),
      isError: entry.isError
    });
  }
}

async function main(): Promise<void> {
  const logger = createLogger();
  const env = process.env;
  const chainConfig = loadChainConfigFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);
  const judgmentConfig = loadJudgmentConfigFromEnv(env);
  if (!judgmentConfig.enabled || judgmentConfig.llm === undefined) {
    throw new WorkerConfigError(
      "LLM_API_KEY/JUDGMENT_MODEL",
      "both required for validate:judgment — this tool always calls the real LLM"
    );
  }
  const llm = createOpenAiCompatibleLlmClient({
    baseUrl: judgmentConfig.llm.baseUrl,
    apiKey: judgmentConfig.llm.apiKey
  });

  const tokenArg = parseAddressArg("token");
  const poolArg = parseAddressArg("pool");

  const handle = createDatabase(databaseUrl);
  try {
    await handle.applyMigrations();
    const target = await pickTarget(handle.db, chainConfig.chainId, tokenArg, poolArg);

    const bundle = await assembleEvidenceBundle({
      db: handle.db,
      chainId: chainConfig.chainId,
      tokenAddress: target.tokenAddress,
      poolAddress: target.poolAddress,
      asOf: target.asOf,
      mode: "LIVE",
      alert: target.alert
    });
    logger.info("validate_judgment.evidence", { evidence: renderEvidence(bundle) });

    const toolkit = createJudgmentToolkit({ db: handle.db, bundle });
    const fetchCitedRow: CitedRowFetcher = (table, rowId) => getCitedRow(handle.db, table, rowId);
    const prompt = briefPromptSpecV1();

    const generated = await generateBrief({
      llm,
      model: judgmentConfig.llm.model,
      toolkit,
      bundle,
      prompt,
      fetchCitedRow,
      config: { maxToolRounds: judgmentConfig.maxToolRounds },
      signal: AbortSignal.timeout(judgmentConfig.timeoutMs)
    });

    logToolTrace(logger, generated.toolTrace);

    if (generated.citationReport !== null) {
      logger.info("validate_judgment.citations", {
        total: generated.citationReport.total,
        verified: generated.citationReport.verified,
        loadBearingFailures: generated.citationReport.loadBearingFailures,
        verdict: generated.citationReport.verdict,
        checks: generated.citationReport.checks
      });
    }

    logger.info("validate_judgment.result", {
      status: generated.status,
      error: generated.error,
      tokensIn: generated.tokensIn,
      tokensOut: generated.tokensOut,
      latencyMs: Math.round(generated.latencyMs)
    });

    if (generated.status === "COMPLETED" && generated.payload !== null && generated.citationReport !== null) {
      logger.info("validate_judgment.message", {
        message: formatBriefMessage(bundle, generated.payload, generated.citationReport)
      });
    }
  } finally {
    await handle.close();
  }
}

// Run only when executed directly — importing the pure helpers above (e.g.
// from tests) must never open a database connection or call a real LLM.
if (import.meta.main) {
  main().catch((error: unknown) => {
    createLogger().error("validate_judgment.crashed", { error });
    process.exit(1);
  });
}
