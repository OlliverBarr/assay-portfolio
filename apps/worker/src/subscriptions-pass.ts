import {
  getTelegramCursor,
  getTelegramSubscription,
  setTelegramCursor,
  upsertTelegramSubscription,
  type Db
} from "@assay/database";

import {
  parseScoreRequest,
  SCORE_FAILED_TEXT,
  SCORE_USAGE_TEXT,
  type ScoreRequest
} from "./score-request.js";

/** Bot's own membership states that count as "added". */
const MEMBER_STATUSES: Record<string, true> = { member: true, administrator: true };
/** Bot's own membership states that count as "removed". */
const REMOVED_STATUSES: Record<string, true> = { left: true, kicked: true };
/** `/join` or `/start` (Telegram's first-contact DM command), optionally `@botname`-suffixed, optionally followed by one code argument. */
const JOIN_COMMAND_RE = /^\/(?:join|start)(?:@\S+)?(?:[ \t]+(.*))?$/i;

const SUBSCRIBED_TEXT =
  "Subscribed! This chat will now receive Robinhood Chain launch radar alerts.";
const WRONG_CODE_TEXT =
  "That join code didn't match. Ask the operator for the correct /join code.";
const ALREADY_SUBSCRIBED_TEXT =
  "This chat is already subscribed to launch radar alerts.";
const SUBSCRIPTIONS_DISABLED_TEXT =
  "Self-service subscriptions are disabled. Ask the operator for access.";

/**
 * A Telegram Bot API interaction failed in a classifiable, transient way:
 * network failure, non-OK HTTP status, a malformed/truncated JSON body, or
 * a not-ok envelope. The subscriptions loop logs-and-backs-off on this type
 * instead of crashing the worker — the Bot API flaking must never take the
 * ingestion pipeline down with it (observed live 2026-07-11: a truncated
 * body crashed the worker via an unguarded JSON.parse).
 */
export class TelegramApiError extends Error {
  readonly method: string;

  constructor(method: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TelegramApiError";
    this.method = method;
  }
}

/** Minimal chat shape the pass reads. Chat ids are text — never a JS number. */
export interface TelegramChat {
  readonly id: string;
  readonly title?: string;
  readonly username?: string;
}

export interface TelegramChatMemberUpdated {
  readonly chat: TelegramChat;
  readonly new_chat_member: { readonly status: string };
}

export interface TelegramMessage {
  readonly chat: TelegramChat;
  readonly text?: string;
}

/** One `getUpdates` item, normalized to the fields the pass reads. */
export interface TelegramUpdate {
  readonly update_id: string;
  readonly my_chat_member?: TelegramChatMemberUpdated;
  readonly message?: TelegramMessage;
}

/**
 * Minimal injectable Telegram Bot API surface. The real implementation is
 * fetch-based (see {@link createTelegramUpdatesApi}); tests supply a fake so
 * no live network I/O ever happens under `vitest`.
 */
export interface TelegramUpdatesApi {
  getUpdates(offsetExclusive: bigint): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
}

/** Builds the /score reply for one token address (see score-request.ts). */
export type ScorecardBuilder = (tokenAddress: string) => Promise<string>;

export interface SubscriptionsPassOptions {
  readonly db: Db;
  readonly api: TelegramUpdatesApi;
  /** Required to activate new self-service subscriptions. Unset disables new subscriptions. */
  readonly joinCode?: string;
  /** Static always-on chat id; recorded like any other row (fan-out skips it elsewhere). */
  readonly staticChatId?: string;
  /** When set, ACTIVE chats can request on-demand scorecards via /score. */
  readonly scorecard?: ScorecardBuilder;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface SubscriptionUpdateError {
  readonly updateId: string;
  readonly message: string;
}

export interface SubscriptionsPassResult {
  readonly updatesProcessed: number;
  readonly subscribed: number;
  readonly pendingCreated: number;
  readonly removed: number;
  readonly hintsSent: number;
  readonly scorecardsSent: number;
  readonly updateErrors: SubscriptionUpdateError[];
  readonly stopped: boolean;
}

interface UpdateOutcome {
  readonly subscribed?: boolean;
  readonly pendingCreated?: boolean;
  readonly removed?: boolean;
  readonly hintSent?: boolean;
  readonly scorecardSent?: boolean;
}

/**
 * Parses a `/join` command. `undefined` when the text isn't a `/join`
 * command at all; `""` when it's `/join` with no code or more than one
 * argument (treated the same as a wrong code — "wrong/missing code" per the
 * contract); otherwise the trimmed single argument.
 */
function parseJoinCommand(text: string): string | undefined {
  const match = JOIN_COMMAND_RE.exec(text.trim());
  if (match === null) return undefined;
  const rest = (match[1] ?? "").trim();
  if (rest.length === 0) return "";
  const parts = rest.split(/\s+/);
  return parts.length === 1 ? (parts[0] ?? "") : "";
}

/**
 * `my_chat_member` records a new subscription as PENDING behind a join code.
 * With no join code, self-service subscriptions are disabled. An existing
 * subscription is marked REMOVED when the bot leaves or is kicked.
 */
async function processMyChatMember(
  db: Db,
  event: TelegramChatMemberUpdated,
  joinCode: string | undefined
): Promise<UpdateOutcome> {
  const chatId = event.chat.id;
  const title = event.chat.title ?? event.chat.username ?? null;
  const status = event.new_chat_member.status;

  if (MEMBER_STATUSES[status] === true) {
    if (joinCode === undefined) return {};
    const existing = await getTelegramSubscription(db, chatId);
    if (existing?.status === "ACTIVE") {
      await upsertTelegramSubscription(db, { chatId, title, status: "ACTIVE" });
      return { subscribed: true };
    }
    await upsertTelegramSubscription(db, { chatId, title, status: "PENDING" });
    return { pendingCreated: true };
  }

  if (REMOVED_STATUSES[status] === true) {
    const existing = await getTelegramSubscription(db, chatId);
    if (existing === undefined) return {};
    await upsertTelegramSubscription(db, { chatId, title, status: "REMOVED" });
    return { removed: true };
  }

  return {};
}

/**
 * Routes one chat message: `/join` commands keep their subscribe semantics
 * (see {@link processJoin}); otherwise, when a scorecard builder is wired,
 * a `/score 0x...` command or a bare pasted token address in an ACTIVE chat
 * returns an on-demand scorecard.
 */
async function processMessage(
  db: Db,
  api: TelegramUpdatesApi,
  event: TelegramMessage,
  joinCode: string | undefined,
  scorecard: ScorecardBuilder | undefined
): Promise<UpdateOutcome> {
  if (event.text === undefined) return {};
  const code = parseJoinCommand(event.text);
  if (code !== undefined) {
    return processJoin(db, api, event, joinCode, code);
  }
  if (scorecard === undefined) return {};
  const request = parseScoreRequest(event.text);
  if (request === undefined) return {};
  return processScoreRequest(db, api, event.chat.id, request, scorecard);
}

/**
 * A `/score` request. Only ACTIVE chats are served: the bot must never act
 * as an open scoring oracle for chats that never subscribed. A scorecard
 * build failure sends a canned failure reply, then rethrows into the pass's
 * per-update error collection so the failure is never silent.
 */
async function processScoreRequest(
  db: Db,
  api: TelegramUpdatesApi,
  chatId: string,
  request: ScoreRequest,
  scorecard: ScorecardBuilder
): Promise<UpdateOutcome> {
  const existing = await getTelegramSubscription(db, chatId);
  if (existing?.status !== "ACTIVE") return {};
  if (request.kind === "usage") {
    await api.sendMessage(chatId, SCORE_USAGE_TEXT);
    return { hintSent: true };
  }
  let reply: string;
  try {
    reply = await scorecard(request.tokenAddress);
  } catch (error) {
    await api.sendMessage(chatId, SCORE_FAILED_TEXT);
    throw error;
  }
  await api.sendMessage(chatId, reply);
  return { scorecardSent: true };
}

/**
 * A `/join <code>` (or `/start`, so a first DM to the bot works) message.
 * PENDING + correct code → ACTIVE + confirmation. PENDING (or unknown chat,
 * code check first creating a PENDING row) + wrong or missing code → stays
 * PENDING + one-line hint. Without a configured join code, new self-service
 * subscriptions are disabled and no chat row is created.
 */
async function processJoin(
  db: Db,
  api: TelegramUpdatesApi,
  event: TelegramMessage,
  joinCode: string | undefined,
  code: string
): Promise<UpdateOutcome> {
  const chatId = event.chat.id;
  const title = event.chat.title ?? event.chat.username ?? null;
  if (joinCode === undefined) {
    await api.sendMessage(chatId, SUBSCRIPTIONS_DISABLED_TEXT);
    return { hintSent: true };
  }

  const existing = await getTelegramSubscription(db, chatId);

  if (existing?.status === "ACTIVE") {
    await api.sendMessage(chatId, ALREADY_SUBSCRIBED_TEXT);
    return {};
  }
  if (existing?.status === "REMOVED") {
    return {};
  }

  let pendingCreated = false;
  if (existing === undefined) {
    await upsertTelegramSubscription(db, { chatId, title, status: "PENDING" });
    pendingCreated = true;
  }

  if (code !== "" && code === joinCode) {
    await upsertTelegramSubscription(db, { chatId, title, status: "ACTIVE" });
    await api.sendMessage(chatId, SUBSCRIBED_TEXT);
    return { pendingCreated, subscribed: true };
  }

  await api.sendMessage(chatId, WRONG_CODE_TEXT);
  return { pendingCreated, hintSent: true };
}

/**
 * Polls one batch of Telegram updates and applies subscribe/unsubscribe/join
 * semantics. Updates are processed in order; the cursor is advanced to the
 * max `update_id` seen only after every row write in the batch has been
 * persisted. A per-update failure is collected (never thrown) so the rest of
 * the batch — and the cursor advance — still happen.
 */
export async function runSubscriptionsPass(
  options: SubscriptionsPassOptions
): Promise<SubscriptionsPassResult> {
  const { db, api, joinCode } = options;
  // Function call (not property read) so TS doesn't narrow `aborted` across awaits.
  const isAborted = (): boolean => options.signal?.aborted === true;

  let updatesProcessed = 0;
  let subscribed = 0;
  let pendingCreated = 0;
  let removed = 0;
  let hintsSent = 0;
  let scorecardsSent = 0;
  const updateErrors: SubscriptionUpdateError[] = [];
  let stopped = false;

  const cursor = await getTelegramCursor(db);
  const updates = await api.getUpdates(cursor ?? 0n);

  let maxUpdateId: bigint | null = null;

  for (const update of updates) {
    if (isAborted()) {
      stopped = true;
      break;
    }

    const updateId = BigInt(update.update_id);
    updatesProcessed += 1;
    if (maxUpdateId === null || updateId > maxUpdateId) {
      maxUpdateId = updateId;
    }

    try {
      let outcome: UpdateOutcome = {};
      if (update.my_chat_member !== undefined) {
        outcome = await processMyChatMember(db, update.my_chat_member, joinCode);
      } else if (update.message !== undefined) {
        outcome = await processMessage(
          db,
          api,
          update.message,
          joinCode,
          options.scorecard
        );
      }
      if (outcome.subscribed === true) subscribed += 1;
      if (outcome.pendingCreated === true) pendingCreated += 1;
      if (outcome.removed === true) removed += 1;
      if (outcome.hintSent === true) hintsSent += 1;
      if (outcome.scorecardSent === true) scorecardsSent += 1;
    } catch (error) {
      updateErrors.push({
        updateId: updateId.toString(),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (maxUpdateId !== null) {
    await setTelegramCursor(db, maxUpdateId);
  }

  return {
    updatesProcessed,
    subscribed,
    pendingCreated,
    removed,
    hintsSent,
    scorecardsSent,
    updateErrors,
    stopped
  };
}

/** Quotes bare `id`/`update_id` integer literals so `JSON.parse` can't round them to a float64. */
function preserveWideIntegers(rawJson: string): string {
  return rawJson.replace(/"(id|update_id)":(-?\d+)/g, '"$1":"$2"');
}

interface TelegramApiEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
}

/**
 * Fetch-based `TelegramUpdatesApi`, mirroring how `@assay/alerts`'
 * `createTelegramTransport` calls the Bot API: POST JSON to
 * `https://api.telegram.org/bot<token>/<method>`, a short request timeout,
 * and a structured error on a non-OK/non-ok response. `getUpdates` never
 * long-polls — the worker loop's own cadence is the poll — and restricts to
 * `allowed_updates: ["my_chat_member", "message"]` with `limit: 100`.
 *
 * Chat and update ids are extracted as exact-precision strings (Telegram
 * supergroup ids can exceed `Number.MAX_SAFE_INTEGER`), never parsed as JS
 * numbers.
 */
export function createTelegramUpdatesApi(botToken: string): TelegramUpdatesApi {
  const base = `https://api.telegram.org/bot${botToken}`;

  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000)
      });
    } catch (cause) {
      throw new TelegramApiError(method, `Telegram ${method} request failed`, {
        cause
      });
    }

    const rawText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new TelegramApiError(
        method,
        `Telegram ${method} returned ${response.status}: ${rawText}`
      );
    }

    let payload: TelegramApiEnvelope<T>;
    try {
      payload = JSON.parse(preserveWideIntegers(rawText)) as TelegramApiEnvelope<T>;
    } catch (cause) {
      throw new TelegramApiError(
        method,
        `Telegram ${method} returned a malformed JSON body`,
        { cause }
      );
    }
    if (!payload.ok || payload.result === undefined) {
      throw new TelegramApiError(
        method,
        `Telegram ${method} returned not-ok: ${payload.description ?? "unknown error"}`
      );
    }
    return payload.result;
  }

  return {
    async getUpdates(offsetExclusive: bigint): Promise<TelegramUpdate[]> {
      return call<TelegramUpdate[]>("getUpdates", {
        offset: Number(offsetExclusive + 1n),
        limit: 100,
        timeout: 0,
        allowed_updates: ["my_chat_member", "message"]
      });
    },
    async sendMessage(chatId: string, text: string): Promise<void> {
      await call<unknown>("sendMessage", { chat_id: chatId, text });
    }
  };
}
