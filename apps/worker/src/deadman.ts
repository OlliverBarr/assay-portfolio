/**
 * Dead-man heartbeat: alerts when the worker stops producing fresh market
 * snapshots. Runs as its own process (its own compose service) so it keeps
 * watching — and can still page out — even if the worker container itself
 * is wedged or crash-looping.
 *
 *   bun run deadman
 */
import {
  createDryRunTransport,
  createTelegramTransport,
  type AlertTransport
} from "@assay/alerts";
import { loadChainConfigFromEnv, type EnvSource } from "@assay/chain";
import { createDatabase, getLatestSnapshotCapturedAt, type Db } from "@assay/database";

import {
  loadDatabaseUrlFromEnv,
  loadTelegramConfigFromEnv,
  WorkerConfigError
} from "./config.js";
import { createLogger, type Logger } from "./log.js";
import { runPollLoop } from "./loop.js";

export interface DeadmanTuning {
  /** Delay between staleness checks. */
  readonly checkIntervalMs: number;
  /** A snapshot older than this (or missing entirely) counts as stale. */
  readonly maxSnapshotAgeMs: number;
  /** Minimum gap between repeated alerts while still stale. */
  readonly remindIntervalMs: number;
}

export const DEFAULT_DEADMAN_TUNING: DeadmanTuning = {
  checkIntervalMs: 60_000,
  maxSnapshotAgeMs: 600_000,
  remindIntervalMs: 1_800_000
};

/**
 * Positive-integer env parsing, kept local: this script owns a small,
 * independent env surface and has no reason to grow apps/worker/src/config.ts.
 */
function parsePositiveInt(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkerConfigError(key, `"${raw}" is not a positive integer`);
  }
  return value;
}

/** Unset values fall back to defaults; malformed values are hard errors. */
export function loadDeadmanTuningFromEnv(env: EnvSource): DeadmanTuning {
  return {
    checkIntervalMs: parsePositiveInt(
      env,
      "DEADMAN_CHECK_INTERVAL_MS",
      DEFAULT_DEADMAN_TUNING.checkIntervalMs
    ),
    maxSnapshotAgeMs: parsePositiveInt(
      env,
      "DEADMAN_MAX_SNAPSHOT_AGE_MS",
      DEFAULT_DEADMAN_TUNING.maxSnapshotAgeMs
    ),
    remindIntervalMs: parsePositiveInt(
      env,
      "DEADMAN_REMIND_INTERVAL_MS",
      DEFAULT_DEADMAN_TUNING.remindIntervalMs
    )
  };
}

export interface StalenessCheck {
  readonly stale: boolean;
  /** Human-readable cause; empty when not stale. */
  readonly reason: string;
}

/**
 * Reads the latest snapshot timestamp for `chainId`. A database read failure
 * counts as stale too — an unreachable database is exactly the situation the
 * heartbeat exists to surface, not a reason to go quiet.
 */
async function checkSnapshotFreshness(
  db: Db,
  chainId: number,
  maxSnapshotAgeMs: number,
  logger: Logger
): Promise<StalenessCheck> {
  let capturedAt: Date | undefined;
  try {
    capturedAt = await getLatestSnapshotCapturedAt(db, chainId);
  } catch (error) {
    logger.error("deadman.db_read_failed", { error });
    return { stale: true, reason: "database read failed" };
  }
  if (capturedAt === undefined) {
    return { stale: true, reason: "no snapshot recorded yet" };
  }
  const ageMs = Date.now() - capturedAt.getTime();
  if (ageMs > maxSnapshotAgeMs) {
    return {
      stale: true,
      reason: `latest snapshot is ${Math.round(ageMs / 1000)}s old (max ${Math.round(maxSnapshotAgeMs / 1000)}s)`
    };
  }
  return { stale: false, reason: "" };
}

async function main(): Promise<void> {
  const logger = createLogger();
  const env = process.env;

  // Any malformed configuration stops the process before it touches state.
  const chainConfig = loadChainConfigFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);
  const tuning = loadDeadmanTuningFromEnv(env);
  const telegram = loadTelegramConfigFromEnv(env);
  // Optional separate chat for infra pages, so operator/research chats (which
  // may include other people) don't see ops noise. Same bot, different chat.
  const deadmanChatId = env["DEADMAN_CHAT_ID"]?.trim();

  const handle = createDatabase(databaseUrl);

  const alertTransport: AlertTransport =
    telegram === undefined
      ? createDryRunTransport((text) => {
          logger.info("deadman.alert_dry_run", { text });
        })
      : createTelegramTransport(
          telegram.botToken,
          deadmanChatId === undefined || deadmanChatId === ""
            ? telegram.chatId
            : deadmanChatId
        );
  const alertTransportName = telegram === undefined ? "dry-run" : "telegram";

  logger.info("deadman.started", {
    chainId: chainConfig.chainId,
    checkIntervalMs: tuning.checkIntervalMs,
    maxSnapshotAgeMs: tuning.maxSnapshotAgeMs,
    remindIntervalMs: tuning.remindIntervalMs,
    chatOverride: deadmanChatId !== undefined && deadmanChatId !== "",
    alertTransport: alertTransportName
  });

  const controller = new AbortController();
  let signalCount = 0;
  const onSignal = (signal: string) => {
    signalCount += 1;
    if (signalCount > 1) {
      logger.error("deadman.force_exit", { signal });
      process.exit(130);
    }
    logger.info("deadman.stopping", { signal });
    controller.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // undefined = no check has run yet, so the first stale reading always
  // alerts (a switch that starts stale on a fresh deploy must still page).
  let wasStale: boolean | undefined;
  let lastAlertAt = 0;

  const sendAlert = async (event: string, text: string): Promise<void> => {
    try {
      await alertTransport.send(text);
      logger.info(event, { text });
    } catch (error) {
      // A failed page must never crash the watcher that exists to catch
      // failures — log it and keep checking.
      logger.error("deadman.alert_send_failed", { error, text });
    }
  };

  try {
    await runPollLoop<StalenessCheck>({
      name: "deadman",
      runOnce: async () => {
        const result = await checkSnapshotFreshness(
          handle.db,
          chainConfig.chainId,
          tuning.maxSnapshotAgeMs,
          logger
        );
        const now = Date.now();
        if (result.stale) {
          if (wasStale !== true) {
            await sendAlert(
              "deadman.alert_stale",
              `\u26A0\uFE0F Launch Radar dead-man switch: chain ${chainConfig.chainId} snapshots are STALE \u2014 ${result.reason}`
            );
            lastAlertAt = now;
          } else if (now - lastAlertAt >= tuning.remindIntervalMs) {
            await sendAlert(
              "deadman.alert_reminder",
              `\u26A0\uFE0F Launch Radar dead-man switch: still STALE \u2014 ${result.reason}`
            );
            lastAlertAt = now;
          }
        } else if (wasStale === true) {
          await sendAlert(
            "deadman.alert_recovered",
            `\u2705 Launch Radar dead-man switch: chain ${chainConfig.chainId} snapshots recovered`
          );
        }
        wasStale = result.stale;
        return result;
      },
      describe: (result) => ({
        event: "deadman.check",
        fields: { stale: result.stale, reason: result.reason }
      }),
      // Failures worth retrying are already absorbed into a "stale" result
      // above; anything that still throws is unexpected and should be seen.
      isRecoverable: () => null,
      pollIntervalMs: tuning.checkIntervalMs,
      signal: controller.signal,
      logger
    });
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  // Structured last words; a crash must never be silent.
  const logger = createLogger();
  logger.error("deadman.crashed", { error });
  process.exit(1);
});
