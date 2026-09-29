/**
 * OPT-IN — sends one real test message to the configured Telegram chat to
 * confirm TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID work. Never part of `bun run test`.
 *
 *   bun run validate:telegram
 */
import { createTelegramTransport } from "@assay/alerts";

import { WorkerConfigError } from "./config.js";
import { createLogger } from "./log.js";

async function main(): Promise<void> {
  const logger = createLogger();
  const env = process.env;
  const botToken = env["TELEGRAM_BOT_TOKEN"]?.trim();
  const chatId = env["TELEGRAM_CHAT_ID"]?.trim();
  if (botToken === undefined || botToken === "") {
    throw new WorkerConfigError("TELEGRAM_BOT_TOKEN", "required for this check");
  }
  if (chatId === undefined || chatId === "") {
    throw new WorkerConfigError("TELEGRAM_CHAT_ID", "required for this check");
  }

  const transport = createTelegramTransport(botToken, chatId);
  const stamp = new Date().toISOString();
  await transport.send(
    [
      "\u2705 Launch Radar — Telegram connectivity test",
      "If you can read this, alerts are wired correctly.",
      `sent at ${stamp}`
    ].join("\n")
  );
  logger.info("validate_telegram.sent", { chatId, at: stamp });
}

main().catch((error: unknown) => {
  createLogger().error("validate_telegram.crashed", { error });
  process.exit(1);
});
