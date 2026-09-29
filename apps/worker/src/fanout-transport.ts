import { listActiveTelegramSubscriptions, type Db } from "@assay/database";
import type { AlertTransport } from "@assay/alerts";

import type { Logger } from "./log.js";

/** Matches a Telegram delivery failure that means the bot lost access to the chat. */
const CHAT_REMOVED_PATTERN = /403|kicked|blocked/i;

export interface FanoutTransportDeps {
  readonly db: Db;
  /** The always-on static destination; its failure propagates from `send`. */
  readonly primary: AlertTransport;
  /** Delivers to one subscribed chat; throws on failure (never swallowed here). */
  readonly sendToChat: (chatId: string, text: string) => Promise<void>;
  /** Static chat id, excluded from fan-out — the primary already covers it. */
  readonly staticChatId?: string;
  /** Called when a chat's failure looks like the bot being kicked/blocked. */
  readonly onRemoved: (chatId: string) => Promise<void>;
  readonly logger?: Logger;
}

/**
 * True when a delivery failure looks like a Telegram 403 (bot kicked or
 * blocked from the chat) — tolerant text match, since transports across the
 * codebase (e.g. `AlertDeliveryError`) surface this only in the message.
 */
export function isChatRemovedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CHAT_REMOVED_PATTERN.test(message);
}

/**
 * Wraps a primary `AlertTransport` so every `send` also fans out to every
 * ACTIVE Telegram subscription (skipping the static chat, already covered by
 * `primary`). The primary's failure propagates — same contract as today.
 * Each subscription send is isolated: a failure is logged and never blocks
 * the rest of the fan-out; a 403-shaped failure additionally marks that
 * subscription REMOVED via `onRemoved`, while any other failure leaves the
 * row ACTIVE (treated as transient).
 */
export function createFanoutTransport(deps: FanoutTransportDeps): AlertTransport {
  const { db, primary, sendToChat, staticChatId, onRemoved, logger } = deps;

  return {
    async send(text: string): Promise<void> {
      await primary.send(text);

      const subscriptions = await listActiveTelegramSubscriptions(db);
      for (const subscription of subscriptions) {
        if (subscription.chatId === staticChatId) continue;

        try {
          await sendToChat(subscription.chatId, text);
        } catch (error) {
          logger?.error("fanout.chat_send_failed", { chatId: subscription.chatId, error });
          if (!isChatRemovedError(error)) continue;
          try {
            await onRemoved(subscription.chatId);
          } catch (removeError) {
            logger?.error("fanout.mark_removed_failed", {
              chatId: subscription.chatId,
              error: removeError
            });
          }
        }
      }
    }
  };
}
