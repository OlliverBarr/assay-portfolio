import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AlertDeliveryError } from "@assay/alerts";
import type { AlertTransport } from "@assay/alerts";
import { getTelegramSubscription, upsertTelegramSubscription, type Db } from "@assay/database";
import { createTestDatabase, type TestDatabaseHandle } from "@assay/database/testing";

import { createFanoutTransport, isChatRemovedError } from "../src/fanout-transport.js";

const STATIC_CHAT_ID = "-1009999";

describe("isChatRemovedError", () => {
  it("detects a Telegram 403 AlertDeliveryError", () => {
    expect(
      isChatRemovedError(
        new AlertDeliveryError("Telegram sendMessage returned 403: Forbidden", { status: 403 })
      )
    ).toBe(true);
  });

  it("detects 'kicked' and 'blocked' phrasing case-insensitively", () => {
    expect(isChatRemovedError(new Error("Forbidden: bot was Kicked from the group chat"))).toBe(
      true
    );
    expect(isChatRemovedError(new Error("bot was blocked by the user"))).toBe(true);
  });

  it("returns false for an unrelated or non-Error failure", () => {
    expect(isChatRemovedError(new Error("Telegram sendMessage returned 500: internal error"))).toBe(
      false
    );
    expect(isChatRemovedError("plain string failure")).toBe(false);
  });
});

describe("createFanoutTransport", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  async function activeSubscription(chatId: string): Promise<void> {
    await upsertTelegramSubscription(db, { chatId, title: null, status: "ACTIVE" });
  }

  it("sends to the primary first, then to every ACTIVE subscription except the static chat", async () => {
    await activeSubscription("100");
    await activeSubscription("101");
    await activeSubscription(STATIC_CHAT_ID);

    const order: string[] = [];
    const primary: AlertTransport = {
      send(text): Promise<void> {
        order.push(`primary:${text}`);
        return Promise.resolve();
      }
    };
    const sentTo: string[] = [];
    const sendToChat = (chatId: string, text: string): Promise<void> => {
      sentTo.push(chatId);
      order.push(`chat:${chatId}:${text}`);
      return Promise.resolve();
    };

    const transport = createFanoutTransport({
      db,
      primary,
      sendToChat,
      staticChatId: STATIC_CHAT_ID,
      onRemoved: () => Promise.resolve()
    });
    await transport.send("alert");

    expect(order[0]).toBe("primary:alert");
    expect(sentTo.sort()).toEqual(["100", "101"]);
  });

  it("propagates a primary failure and never reaches fan-out", async () => {
    await activeSubscription("200");
    const primary: AlertTransport = {
      send(): Promise<void> {
        throw new Error("primary down");
      }
    };
    let sendToChatCalled = false;
    const transport = createFanoutTransport({
      db,
      primary,
      sendToChat: (): Promise<void> => {
        sendToChatCalled = true;
        return Promise.resolve();
      },
      onRemoved: () => Promise.resolve()
    });

    await expect(transport.send("alert")).rejects.toThrow("primary down");
    expect(sendToChatCalled).toBe(false);
  });

  it("isolates per-chat failures: marks a 403 chat REMOVED, leaves a transient failure ACTIVE, and still delivers to the rest", async () => {
    await activeSubscription("300");
    await activeSubscription("301");
    await activeSubscription("302");

    const delivered: string[] = [];
    const sendToChat = (chatId: string): Promise<void> => {
      if (chatId === "300") {
        throw new AlertDeliveryError("Telegram sendMessage returned 403: bot was kicked", {
          status: 403
        });
      }
      if (chatId === "301") {
        throw new Error("Telegram sendMessage returned 500: internal error");
      }
      delivered.push(chatId);
      return Promise.resolve();
    };

    const removedIds: string[] = [];
    const onRemoved = async (chatId: string): Promise<void> => {
      removedIds.push(chatId);
      await upsertTelegramSubscription(db, { chatId, title: null, status: "REMOVED" });
    };

    const transport = createFanoutTransport({
      db,
      primary: { send: () => Promise.resolve() },
      sendToChat,
      onRemoved
    });

    await expect(transport.send("alert")).resolves.toBeUndefined();

    expect(delivered).toEqual(["302"]);
    expect(removedIds).toEqual(["300"]);
    expect((await getTelegramSubscription(db, "300"))?.status).toBe("REMOVED");
    expect((await getTelegramSubscription(db, "301"))?.status).toBe("ACTIVE");
    expect((await getTelegramSubscription(db, "302"))?.status).toBe("ACTIVE");
  });

  it("logs but does not throw when onRemoved itself fails", async () => {
    await activeSubscription("400");
    const errors: unknown[] = [];
    const transport = createFanoutTransport({
      db,
      primary: { send: () => Promise.resolve() },
      sendToChat: (): Promise<void> => {
        throw new Error("403 forbidden");
      },
      onRemoved: (): Promise<void> => {
        throw new Error("db unavailable");
      },
      logger: {
        info: () => {},
        error: (_event, fields) => {
          errors.push(fields);
        }
      }
    });

    await expect(transport.send("alert")).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });
});
