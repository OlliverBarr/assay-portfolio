import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getTelegramCursor,
  getTelegramSubscription,
  listActiveTelegramSubscriptions,
  setTelegramCursor,
  upsertTelegramSubscription,
  type Db
} from "../src/index.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

// Telegram supergroup ids are negative and can exceed 2^53 in magnitude;
// storing as text (not a JS number) must survive an exact round trip.
const HUGE_CHAT_ID = "-1009007199254740993";

describe("telegram subscriptions", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  describe("upsertTelegramSubscription / getTelegramSubscription", () => {
    it("inserts a new row with the given status", async () => {
      await upsertTelegramSubscription(db, {
        chatId: "111",
        title: "Launch Radar Alerts",
        status: "ACTIVE"
      });
      const row = await getTelegramSubscription(db, "111");
      expect(row?.chatId).toBe("111");
      expect(row?.title).toBe("Launch Radar Alerts");
      expect(row?.status).toBe("ACTIVE");
      expect(row?.addedAt).toBeInstanceOf(Date);
      expect(row?.updatedAt).toBeInstanceOf(Date);
    });

    it("preserves added_at and bumps status/updated_at on re-upsert", async () => {
      await upsertTelegramSubscription(db, {
        chatId: "111",
        title: "Launch Radar Alerts",
        status: "PENDING"
      });
      const first = await getTelegramSubscription(db, "111");
      expect(first?.status).toBe("PENDING");

      await upsertTelegramSubscription(db, {
        chatId: "111",
        title: "Launch Radar Alerts",
        status: "ACTIVE"
      });
      const second = await getTelegramSubscription(db, "111");
      expect(second?.status).toBe("ACTIVE");
      expect(second?.addedAt).toEqual(first?.addedAt);
      expect(second?.updatedAt.getTime()).toBeGreaterThanOrEqual(
        first?.updatedAt.getTime() ?? 0
      );
    });

    it("returns undefined for an unknown chat", async () => {
      expect(await getTelegramSubscription(db, "does-not-exist")).toBeUndefined();
    });

    it("round-trips a chat id beyond Number.MAX_SAFE_INTEGER as exact text", async () => {
      expect(Number.isSafeInteger(Number(HUGE_CHAT_ID))).toBe(false);

      await upsertTelegramSubscription(db, {
        chatId: HUGE_CHAT_ID,
        title: null,
        status: "ACTIVE"
      });
      const row = await getTelegramSubscription(db, HUGE_CHAT_ID);
      expect(row?.chatId).toBe(HUGE_CHAT_ID);
      expect(typeof row?.chatId).toBe("string");
    });
  });

  describe("listActiveTelegramSubscriptions", () => {
    it("excludes PENDING and REMOVED, ordered by chat_id", async () => {
      await upsertTelegramSubscription(db, {
        chatId: "300",
        title: "c",
        status: "ACTIVE"
      });
      await upsertTelegramSubscription(db, {
        chatId: "100",
        title: "a",
        status: "ACTIVE"
      });
      await upsertTelegramSubscription(db, {
        chatId: "200",
        title: "b",
        status: "PENDING"
      });
      await upsertTelegramSubscription(db, {
        chatId: "400",
        title: "d",
        status: "REMOVED"
      });

      const rows = await listActiveTelegramSubscriptions(db);
      expect(rows.map((row) => row.chatId)).toEqual(["100", "300"]);
    });

    it("returns an empty list when nothing is active", async () => {
      await upsertTelegramSubscription(db, {
        chatId: "1",
        title: null,
        status: "PENDING"
      });
      expect(await listActiveTelegramSubscriptions(db)).toEqual([]);
    });
  });

  describe("getTelegramCursor / setTelegramCursor", () => {
    it("is undefined before the first poll", async () => {
      expect(await getTelegramCursor(db)).toBeUndefined();
    });

    it("stores and advances the singleton cursor row", async () => {
      await setTelegramCursor(db, 1000n);
      expect(await getTelegramCursor(db)).toBe(1000n);

      await setTelegramCursor(db, 1001n);
      expect(await getTelegramCursor(db)).toBe(1001n);
    });
  });
});
