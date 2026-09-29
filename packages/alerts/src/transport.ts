import { AlertDeliveryError } from "./errors.js";
import type { AlertTransport } from "./types.js";

/**
 * A transport that only forwards the rendered message to a caller-supplied
 * sink (a logger, a test spy). It never performs network I/O, making it the
 * safe default for local runs and dry-run deployments.
 */
export function createDryRunTransport(
  sink: (text: string) => void
): AlertTransport {
  return {
    send(text: string): Promise<void> {
      sink(text);
      return Promise.resolve();
    }
  };
}

/**
 * A transport that delivers messages through the Telegram Bot API
 * (`sendMessage`) in HTML parse mode — required for tap-to-copy `<code>`
 * addresses. Consequence: every message sent through this transport MUST be
 * valid Telegram HTML (dynamic values escaped via `escapeHtml`), or the API
 * rejects the send with a 400. Uses the global `fetch`; a non-OK response is
 * surfaced as a structured {@link AlertDeliveryError} carrying the HTTP
 * status and body.
 */
export function createTelegramTransport(
  botToken: string,
  chatId: string
): AlertTransport {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  return {
    async send(text: string): Promise<void> {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
        });
      } catch (cause) {
        throw new AlertDeliveryError("Telegram sendMessage request failed", {
          cause
        });
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new AlertDeliveryError(
          `Telegram sendMessage returned ${response.status}: ${body}`,
          { status: response.status }
        );
      }
    }
  };
}
