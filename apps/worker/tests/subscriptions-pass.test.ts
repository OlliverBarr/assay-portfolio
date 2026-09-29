import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getTelegramCursor,
  getTelegramSubscription,
  upsertTelegramSubscription,
  type Db
} from "@assay/database";
import { createTestDatabase, type TestDatabaseHandle } from "@assay/database/testing";

import {
  createTelegramUpdatesApi,
  TelegramApiError,
  runSubscriptionsPass,
  type TelegramUpdate,
  type TelegramUpdatesApi
} from "../src/subscriptions-pass.js";
import { SCORE_FAILED_TEXT, SCORE_USAGE_TEXT } from "../src/score-request.js";

function memberUpdate(
  updateId: string,
  chatId: string,
  status: string,
  title = "Chat"
): TelegramUpdate {
  return {
    update_id: updateId,
    my_chat_member: { chat: { id: chatId, title }, new_chat_member: { status } }
  };
}

function messageUpdate(
  updateId: string,
  chatId: string,
  text: string,
  title = "Chat"
): TelegramUpdate {
  return { update_id: updateId, message: { chat: { id: chatId, title }, text } };
}

/** Fake `TelegramUpdatesApi` that filters by offset like the real Bot API does. */
function createFakeApi(allUpdates: TelegramUpdate[]): {
  api: TelegramUpdatesApi;
  sentMessages: { chatId: string; text: string }[];
  offsetsRequested: bigint[];
} {
  const sentMessages: { chatId: string; text: string }[] = [];
  const offsetsRequested: bigint[] = [];
  const api: TelegramUpdatesApi = {
    getUpdates(offsetExclusive): Promise<TelegramUpdate[]> {
      offsetsRequested.push(offsetExclusive);
      return Promise.resolve(
        allUpdates.filter((u) => BigInt(u.update_id) > offsetExclusive)
      );
    },
    sendMessage(chatId, text): Promise<void> {
      sentMessages.push({ chatId, text });
      return Promise.resolve();
    }
  };
  return { api, sentMessages, offsetsRequested };
}

describe("runSubscriptionsPass", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  it("does not subscribe a chat when self-service subscriptions are disabled", async () => {
    const { api } = createFakeApi([memberUpdate("1", "100", "member")]);
    const result = await runSubscriptionsPass({ db, api });

    expect(result.subscribed).toBe(0);
    expect(result.pendingCreated).toBe(0);
    expect((await getTelegramSubscription(db, "100"))).toBeUndefined();
  });

  it("creates a PENDING row behind a join code, then activates on the correct /join and sends a confirmation", async () => {
    const { api, sentMessages } = createFakeApi([
      memberUpdate("1", "200", "member"),
      messageUpdate("2", "200", "/join secret")
    ]);
    const result = await runSubscriptionsPass({ db, api, joinCode: "secret" });

    expect(result.pendingCreated).toBe(1);
    expect(result.subscribed).toBe(1);
    expect((await getTelegramSubscription(db, "200"))?.status).toBe("ACTIVE");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.chatId).toBe("200");
  });

  it("sends a one-line hint and stays PENDING on a wrong /join code", async () => {
    const { api, sentMessages } = createFakeApi([
      memberUpdate("1", "300", "member"),
      messageUpdate("2", "300", "/join nope")
    ]);
    const result = await runSubscriptionsPass({ db, api, joinCode: "secret" });

    expect(result.hintsSent).toBe(1);
    expect(result.subscribed).toBe(0);
    expect((await getTelegramSubscription(db, "300"))?.status).toBe("PENDING");
    expect(sentMessages).toHaveLength(1);
  });

  it("stays PENDING and hints on a missing /join code argument", async () => {
    const { api, sentMessages } = createFakeApi([
      memberUpdate("1", "310", "member"),
      messageUpdate("2", "310", "/join")
    ]);
    const result = await runSubscriptionsPass({ db, api, joinCode: "secret" });

    expect(result.hintsSent).toBe(1);
    expect((await getTelegramSubscription(db, "310"))?.status).toBe("PENDING");
    expect(sentMessages).toHaveLength(1);
  });

  it("never downgrades an ACTIVE row when a join code is later configured", async () => {
    await upsertTelegramSubscription(db, { chatId: "400", title: "Chat", status: "ACTIVE" });
    const api = createFakeApi([memberUpdate("1", "400", "member")]);
    const result = await runSubscriptionsPass({ db, api: api.api, joinCode: "secret" });

    expect((await getTelegramSubscription(db, "400"))?.status).toBe("ACTIVE");
    expect(result.subscribed).toBe(1);
    expect(result.pendingCreated).toBe(0);
  });

  it("marks an existing chat REMOVED when the bot is kicked", async () => {
    await upsertTelegramSubscription(db, { chatId: "500", title: "Chat", status: "ACTIVE" });
    const api = createFakeApi([memberUpdate("2", "500", "kicked")]);
    const result = await runSubscriptionsPass({ db, api: api.api });

    expect(result.removed).toBe(1);
    expect((await getTelegramSubscription(db, "500"))?.status).toBe("REMOVED");
  });

  it("creates PENDING then immediately activates on a correct /join from an unknown chat with a join code configured", async () => {
    const { api } = createFakeApi([messageUpdate("1", "550", "/join secret")]);
    const result = await runSubscriptionsPass({ db, api, joinCode: "secret" });

    expect(result.pendingCreated).toBe(1);
    expect(result.subscribed).toBe(1);
    expect((await getTelegramSubscription(db, "550"))?.status).toBe("ACTIVE");
  });

  it("rejects a direct join when self-service subscriptions are disabled", async () => {
    const { api, sentMessages } = createFakeApi([messageUpdate("1", "570", "/join")]);
    const result = await runSubscriptionsPass({ db, api });

    expect(result.subscribed).toBe(0);
    expect(result.hintsSent).toBe(1);
    expect((await getTelegramSubscription(db, "570"))).toBeUndefined();
    expect(sentMessages).toHaveLength(1);
  });

  it("treats /start as a gated join, then serves /score in that DM", async () => {
    const ADDRESS = `0x${"b".repeat(40)}`;
    const start = createFakeApi([messageUpdate("1", "580", "/start sesame")]);
    const startResult = await runSubscriptionsPass({
      db,
      api: start.api,
      joinCode: "sesame"
    });

    expect(startResult.subscribed).toBe(1);
    expect((await getTelegramSubscription(db, "580"))?.status).toBe("ACTIVE");

    const { api, sentMessages } = createFakeApi([
      messageUpdate("2", "580", `/score ${ADDRESS}`)
    ]);
    const result = await runSubscriptionsPass({
      db,
      api,
      joinCode: "sesame",
      scorecard: () => Promise.resolve("SCORECARD")
    });

    expect(result.scorecardsSent).toBe(1);
    expect(sentMessages).toEqual([{ chatId: "580", text: "SCORECARD" }]);
  });

  it("keeps /start behind the join code when one is configured", async () => {
    const { api, sentMessages } = createFakeApi([
      messageUpdate("1", "590", "/start")
    ]);
    const result = await runSubscriptionsPass({ db, api, joinCode: "sesame" });

    expect(result.subscribed).toBe(0);
    expect(result.pendingCreated).toBe(1);
    expect(result.hintsSent).toBe(1);
    expect((await getTelegramSubscription(db, "590"))?.status).toBe("PENDING");
    expect(sentMessages).toHaveLength(1);
  });

  it("advances the cursor exactly once per batch, to the max update_id, and resumes from it on the next pass", async () => {
    const updates: TelegramUpdate[] = [
      memberUpdate("1", "600", "member"),
      memberUpdate("2", "601", "member")
    ];
    const first = createFakeApi(updates);
    const firstResult = await runSubscriptionsPass({
      db,
      api: first.api,
      joinCode: "secret"
    });

    expect(firstResult.updatesProcessed).toBe(2);
    expect(first.offsetsRequested).toEqual([0n]);
    expect(await getTelegramCursor(db)).toBe(2n);

    updates.push(memberUpdate("3", "602", "member"));
    const second = createFakeApi(updates);
    const secondResult = await runSubscriptionsPass({
      db,
      api: second.api,
      joinCode: "secret"
    });

    expect(second.offsetsRequested).toEqual([2n]);
    expect(secondResult.updatesProcessed).toBe(1);
    expect((await getTelegramSubscription(db, "602"))?.status).toBe("PENDING");
    expect(await getTelegramCursor(db)).toBe(3n);
  });

  it("does not move the cursor when the batch is empty", async () => {
    const { api } = createFakeApi([]);
    await runSubscriptionsPass({ db, api });
    expect(await getTelegramCursor(db)).toBeUndefined();
  });

  it("collects a per-update error without aborting the rest of the batch, and still advances the cursor", async () => {
    const api: TelegramUpdatesApi = {
      getUpdates(): Promise<TelegramUpdate[]> {
        return Promise.resolve([
          messageUpdate("1", "800", "/join wrong"),
          memberUpdate("2", "900", "member")
        ]);
      },
      sendMessage(chatId): Promise<void> {
        if (chatId === "800") throw new Error("telegram rate limited");
        return Promise.resolve();
      }
    };

    const result = await runSubscriptionsPass({ db, api, joinCode: "secret" });

    expect(result.updateErrors).toHaveLength(1);
    expect(result.updateErrors[0]?.updateId).toBe("1");
    expect(result.updateErrors[0]?.message).toContain("rate limited");
    expect(result.updatesProcessed).toBe(2);
    expect(result.pendingCreated).toBe(1);
    expect((await getTelegramSubscription(db, "800"))?.status).toBe("PENDING");
    expect((await getTelegramSubscription(db, "900"))?.status).toBe("PENDING");
    expect(await getTelegramCursor(db)).toBe(2n);
  });

  it("stops without processing further updates once the signal aborts", async () => {
    const controller = new AbortController();
    const api: TelegramUpdatesApi = {
      getUpdates(): Promise<TelegramUpdate[]> {
        controller.abort();
        return Promise.resolve([
          memberUpdate("1", "1000", "member"),
          memberUpdate("2", "1001", "member")
        ]);
      },
      sendMessage(): Promise<void> {
        return Promise.resolve();
      }
    };

    const result = await runSubscriptionsPass({ db, api, signal: controller.signal });

    expect(result.stopped).toBe(true);
    expect(result.updatesProcessed).toBe(0);
    expect(await getTelegramSubscription(db, "1000")).toBeUndefined();
    expect(await getTelegramCursor(db)).toBeUndefined();
  });

  describe("/score requests", () => {
    const ADDRESS = `0x${"a".repeat(40)}`;

    it("serves /score in an ACTIVE chat via the injected builder", async () => {
      await upsertTelegramSubscription(db, {
        chatId: "700",
        title: "Ops",
        status: "ACTIVE"
      });
      const { api, sentMessages } = createFakeApi([
        messageUpdate("1", "700", `/score ${ADDRESS}`)
      ]);
      const requested: string[] = [];

      const result = await runSubscriptionsPass({
        db,
        api,
        scorecard: (tokenAddress) => {
          requested.push(tokenAddress);
          return Promise.resolve("SCORECARD");
        }
      });

      expect(result.scorecardsSent).toBe(1);
      expect(result.updateErrors).toEqual([]);
      expect(requested).toEqual([ADDRESS]);
      expect(sentMessages).toEqual([{ chatId: "700", text: "SCORECARD" }]);
    });

    it("serves a bare pasted token address", async () => {
      await upsertTelegramSubscription(db, {
        chatId: "701",
        title: "Ops",
        status: "ACTIVE"
      });
      const { api, sentMessages } = createFakeApi([
        messageUpdate("1", "701", ADDRESS)
      ]);

      const result = await runSubscriptionsPass({
        db,
        api,
        scorecard: () => Promise.resolve("SCORECARD")
      });

      expect(result.scorecardsSent).toBe(1);
      expect(sentMessages).toEqual([{ chatId: "701", text: "SCORECARD" }]);
    });

    it("stays silent for chats that never subscribed", async () => {
      const { api, sentMessages } = createFakeApi([
        messageUpdate("1", "702", `/score ${ADDRESS}`)
      ]);

      const result = await runSubscriptionsPass({
        db,
        api,
        scorecard: () => Promise.resolve("SCORECARD")
      });

      expect(result.scorecardsSent).toBe(0);
      expect(sentMessages).toEqual([]);
    });

    it("replies with usage for a malformed /score argument", async () => {
      await upsertTelegramSubscription(db, {
        chatId: "703",
        title: "Ops",
        status: "ACTIVE"
      });
      const { api, sentMessages } = createFakeApi([
        messageUpdate("1", "703", "/score nope")
      ]);

      const result = await runSubscriptionsPass({
        db,
        api,
        scorecard: () => Promise.resolve("SCORECARD")
      });

      expect(result.scorecardsSent).toBe(0);
      expect(result.hintsSent).toBe(1);
      expect(sentMessages[0]?.text).toBe(SCORE_USAGE_TEXT);
    });

    it("ignores score requests when no builder is wired", async () => {
      await upsertTelegramSubscription(db, {
        chatId: "704",
        title: "Ops",
        status: "ACTIVE"
      });
      const { api, sentMessages } = createFakeApi([
        messageUpdate("1", "704", `/score ${ADDRESS}`)
      ]);

      const result = await runSubscriptionsPass({ db, api });

      expect(result.scorecardsSent).toBe(0);
      expect(sentMessages).toEqual([]);
    });

    it("sends the canned failure reply and records the error when the builder throws", async () => {
      await upsertTelegramSubscription(db, {
        chatId: "705",
        title: "Ops",
        status: "ACTIVE"
      });
      const { api, sentMessages } = createFakeApi([
        messageUpdate("1", "705", `/score ${ADDRESS}`)
      ]);

      const result = await runSubscriptionsPass({
        db,
        api,
        scorecard: () => Promise.reject(new Error("db exploded"))
      });

      expect(result.scorecardsSent).toBe(0);
      expect(result.updateErrors).toHaveLength(1);
      expect(result.updateErrors[0]?.message).toContain("db exploded");
      expect(sentMessages).toEqual([{ chatId: "705", text: SCORE_FAILED_TEXT }]);
      // The failure never blocks the cursor: the batch still advances.
      expect(await getTelegramCursor(db)).toBe(1n);
    });
  });
});

describe("createTelegramUpdatesApi", () => {
  /** Minimal stand-in for the parts of `Response` the API touches. */
  function fakeResponse(status: number, body: string): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body)
    } as unknown as Response;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to getUpdates with the offset, limit, and allowed_updates the pass relies on", async () => {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(() => Promise.resolve(fakeResponse(200, '{"ok":true,"result":[]}')));
    vi.stubGlobal("fetch", fetchMock);

    const api = createTelegramUpdatesApi("BOT:TOKEN");
    await api.getUpdates(41n);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/botBOT:TOKEN/getUpdates");
    expect(JSON.parse(String(init!.body))).toEqual({
      offset: 42,
      limit: 100,
      timeout: 0,
      allowed_updates: ["my_chat_member", "message"]
    });
  });

  it("preserves wide chat and update ids as exact-precision strings, not JS numbers", async () => {
    const body =
      '{"ok":true,"result":[{"update_id":9007199254740993,' +
      '"message":{"chat":{"id":-1009007199254740993,"title":"Big Group"},"text":"/join x"}}]}';
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(fakeResponse(200, body)))
    );

    const api = createTelegramUpdatesApi("BOT:TOKEN");
    const [update] = await api.getUpdates(0n);

    expect(update?.update_id).toBe("9007199254740993");
    expect(update?.message?.chat.id).toBe("-1009007199254740993");
  });

  it("throws when the response is a non-OK HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(fakeResponse(401, "unauthorized")))
    );
    const api = createTelegramUpdatesApi("BOT:TOKEN");
    await expect(api.getUpdates(0n)).rejects.toThrow("401");
  });

  it("throws when the Telegram payload reports ok: false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(fakeResponse(200, '{"ok":false,"description":"bad token"}'))
      )
    );
    const api = createTelegramUpdatesApi("BOT:TOKEN");
    await expect(api.getUpdates(0n)).rejects.toThrow("bad token");
  });

  it("throws a typed TelegramApiError on a malformed/truncated JSON body — the live 2026-07-11 crash shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(fakeResponse(200, '{"ok":true,"result":[')))
    );
    const api = createTelegramUpdatesApi("BOT:TOKEN");
    const failure = await api.getUpdates(0n).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelegramApiError);
    expect((failure as TelegramApiError).method).toBe("getUpdates");
    expect((failure as TelegramApiError).message).toContain("malformed");
  });

  it("classifies every Bot API failure shape as TelegramApiError so the loop can retry instead of crash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("socket hang up")))
    );
    const api = createTelegramUpdatesApi("BOT:TOKEN");
    await expect(api.getUpdates(0n)).rejects.toBeInstanceOf(TelegramApiError);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(fakeResponse(502, "bad gateway")))
    );
    await expect(api.getUpdates(0n)).rejects.toBeInstanceOf(TelegramApiError);

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(fakeResponse(200, '{"ok":false,"description":"flood"}'))
      )
    );
    await expect(api.getUpdates(0n)).rejects.toBeInstanceOf(TelegramApiError);
  });

  it("POSTs to sendMessage with chat_id and text", async () => {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(() => Promise.resolve(fakeResponse(200, '{"ok":true,"result":true}')));
    vi.stubGlobal("fetch", fetchMock);

    const api = createTelegramUpdatesApi("BOT:TOKEN");
    await api.sendMessage("-100123", "hello");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/botBOT:TOKEN/sendMessage");
    expect(JSON.parse(String(init!.body))).toEqual({ chat_id: "-100123", text: "hello" });
  });
});
