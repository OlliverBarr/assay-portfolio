/**
 * Read-only operator-feedback report: joins `alerts_sent` x
 * `operator_decisions` x `token_outcomes` per token to surface where the
 * system and the operator disagreed. Sends nothing, mutates nothing.
 *
 *   bun apps/worker/src/feedback.ts
 */
import { loadChainConfigFromEnv } from "@assay/chain";
import {
  createDatabase,
  listAlertsSent,
  listOperatorDecisions,
  listSwapsByWallets,
  listTokenOutcomes,
  type AlertSentRow,
  type OperatorDecisionRow,
  type TokenOutcomeRow,
  type WalletSwap
} from "@assay/database";

import { loadDatabaseUrlFromEnv, loadOperatorWalletsFromEnv } from "./config.js";
import { createLogger, type Logger } from "./log.js";

export type FeedbackQuadrant =
  | "SYSTEM-HIT/OPERATOR-MISS"
  | "BAD-ENTRY"
  | "SYSTEM-MISS";

export interface FeedbackTokenRows {
  readonly alerts: readonly Pick<AlertSentRow, "alertLevel">[];
  readonly decisions: readonly Pick<OperatorDecisionRow, "action">[];
  readonly outcomes: readonly Pick<TokenOutcomeRow, "outcome">[];
  /** On-chain trades detected from watched operator wallets. */
  readonly detectedTrades: readonly Pick<WalletSwap, "side">[];
}

/**
 * Assigns one token's rows to at most one explainable quadrant:
 *
 * - SYSTEM-HIT/OPERATOR-MISS: the system alerted YELLOW/GREEN, the token went
 *   on to SURVIVE, and the operator never entered — neither a recorded
 *   ENTERED decision nor a detected on-chain BUY from a watched wallet.
 * - BAD-ENTRY: the operator entered (recorded decision or detected BUY), but
 *   every observed outcome DIED (no SURVIVED among them).
 * - SYSTEM-MISS: the token SURVIVED but the system never alerted at all.
 *
 * The three rules are mutually exclusive for a given token: (a) requires no
 * entry while (b) requires one; (a)/(c) require a SURVIVED
 * outcome while (b) requires none; (a) requires an alert while (c) requires
 * none. A token can therefore satisfy at most one.
 */
export function classifyFeedbackQuadrant(
  rows: FeedbackTokenRows
): FeedbackQuadrant | null {
  const hasEntered =
    rows.decisions.some((decision) => decision.action === "ENTERED") ||
    rows.detectedTrades.some((trade) => trade.side === "BUY");
  const hasResearchTierAlert = rows.alerts.some(
    (alert) => alert.alertLevel === "YELLOW" || alert.alertLevel === "GREEN"
  );
  const hasSurvived = rows.outcomes.some((outcome) => outcome.outcome === "SURVIVED");
  const hasDied = rows.outcomes.some((outcome) => outcome.outcome === "DIED");

  if (hasResearchTierAlert && hasSurvived && !hasEntered) {
    return "SYSTEM-HIT/OPERATOR-MISS";
  }
  if (hasEntered && hasDied && !hasSurvived) {
    return "BAD-ENTRY";
  }
  if (hasSurvived && rows.alerts.length === 0) {
    return "SYSTEM-MISS";
  }
  return null;
}

export interface FeedbackReportRow {
  readonly tokenAddress: string;
  readonly poolAddresses: readonly string[];
  readonly alertLevels: readonly string[];
  readonly decisionActions: readonly string[];
  /** Deduped sides of on-chain trades detected from watched wallets. */
  readonly detectedTradeSides: readonly string[];
  readonly outcomes: readonly string[];
  readonly quadrant: FeedbackQuadrant;
}

/**
 * Groups raw rows per token and classifies each token into its quadrant.
 * Tokens that match no quadrant are dropped — the report only ever shows
 * explainable disagreements, not every token ever seen.
 */
export function buildFeedbackReport(
  alerts: readonly AlertSentRow[],
  decisions: readonly OperatorDecisionRow[],
  outcomes: readonly TokenOutcomeRow[],
  detectedTrades: readonly WalletSwap[] = []
): FeedbackReportRow[] {
  const tokenAddresses = new Set<string>([
    ...alerts.map((alert) => alert.tokenAddress),
    ...decisions.map((decision) => decision.tokenAddress),
    ...outcomes.map((outcome) => outcome.tokenAddress),
    ...detectedTrades.map((trade) => trade.tokenAddress)
  ]);

  const rows: FeedbackReportRow[] = [];
  for (const tokenAddress of tokenAddresses) {
    const tokenAlerts = alerts.filter((alert) => alert.tokenAddress === tokenAddress);
    const tokenDecisions = decisions.filter(
      (decision) => decision.tokenAddress === tokenAddress
    );
    const tokenOutcomes = outcomes.filter(
      (outcome) => outcome.tokenAddress === tokenAddress
    );
    const tokenTrades = detectedTrades.filter(
      (trade) => trade.tokenAddress === tokenAddress
    );

    const quadrant = classifyFeedbackQuadrant({
      alerts: tokenAlerts,
      decisions: tokenDecisions,
      outcomes: tokenOutcomes,
      detectedTrades: tokenTrades
    });
    if (quadrant === null) continue;

    const poolAddresses = new Set<string>([
      ...tokenAlerts.map((alert) => alert.poolAddress),
      ...tokenDecisions
        .map((decision) => decision.poolAddress)
        .filter((poolAddress): poolAddress is string => poolAddress !== null),
      ...tokenOutcomes.map((outcome) => outcome.poolAddress),
      ...tokenTrades.map((trade) => trade.poolAddress)
    ]);

    rows.push({
      tokenAddress,
      poolAddresses: [...poolAddresses].sort(),
      alertLevels: [...new Set(tokenAlerts.map((alert) => alert.alertLevel))].sort(),
      decisionActions: [
        ...new Set(tokenDecisions.map((decision) => decision.action))
      ].sort(),
      detectedTradeSides: [...new Set(tokenTrades.map((trade) => trade.side))].sort(),
      outcomes: [...new Set(tokenOutcomes.map((outcome) => outcome.outcome))].sort(),
      quadrant
    });
  }

  return rows.sort((a, b) => a.tokenAddress.localeCompare(b.tokenAddress));
}

function printQuadrant(
  logger: Logger,
  quadrant: FeedbackQuadrant,
  rows: readonly FeedbackReportRow[]
): void {
  const matches = rows.filter((row) => row.quadrant === quadrant);
  logger.info("feedback.quadrant", {
    quadrant,
    count: matches.length,
    rows: matches.map((row) => ({
      token: row.tokenAddress,
      pool: row.poolAddresses.join(","),
      alertLevels: row.alertLevels.join(","),
      decisions: row.decisionActions.join(","),
      outcomes: row.outcomes.join(",")
    }))
  });
}

async function main(): Promise<void> {
  const logger = createLogger();
  const env = process.env;
  const config = loadChainConfigFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);
  const operatorWallets = loadOperatorWalletsFromEnv(env);

  const handle = createDatabase(databaseUrl);
  try {
    await handle.applyMigrations();
    const [alerts, decisions, outcomes, detectedTrades] = await Promise.all([
      listAlertsSent(handle.db, config.chainId),
      listOperatorDecisions(handle.db, config.chainId),
      listTokenOutcomes(handle.db, config.chainId),
      listSwapsByWallets(handle.db, config.chainId, operatorWallets)
    ]);

    const rows = buildFeedbackReport(alerts, decisions, outcomes, detectedTrades);

    printQuadrant(logger, "SYSTEM-HIT/OPERATOR-MISS", rows);
    printQuadrant(logger, "BAD-ENTRY", rows);
    printQuadrant(logger, "SYSTEM-MISS", rows);

    logger.info("feedback.summary", {
      systemHitOperatorMiss: rows.filter(
        (row) => row.quadrant === "SYSTEM-HIT/OPERATOR-MISS"
      ).length,
      badEntry: rows.filter((row) => row.quadrant === "BAD-ENTRY").length,
      systemMiss: rows.filter((row) => row.quadrant === "SYSTEM-MISS").length,
      totalAlerts: alerts.length,
      totalDecisions: decisions.length,
      totalOutcomes: outcomes.length,
      walletsWatched: operatorWallets.length,
      detectedTrades: detectedTrades.length
    });
  } finally {
    await handle.close();
  }
}

// Run only when executed directly (`bun apps/worker/src/feedback.ts`) — the
// pure report functions above are imported by tests, and importing must
// never open a database connection. `import.meta.main` is Bun's direct-run
// flag; it is absent (falsy) under vitest's Node runtime.
if (import.meta.main) {
  main().catch((error: unknown) => {
    createLogger().error("feedback.crashed", { error });
    process.exit(1);
  });
}
