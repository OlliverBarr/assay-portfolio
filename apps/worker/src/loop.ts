import { setTimeout as sleepMs } from "node:timers/promises";
import { ActivityHaltError, type ActivityPassResult } from "@assay/activity";
import { DiscoveryHaltError, type DiscoveryPassResult } from "@assay/discovery";
import { HolderHaltError, type HolderPassResult } from "@assay/holders";
import { RiskHaltError, type RiskPassResult } from "@assay/risk-engine";

import type { ScoringPassResult } from "./scoring-pass.js";
import type { OutcomePassResult } from "./outcome-pass.js";
import type { PerformancePassResult } from "./performance-pass.js";
import type { SubscriptionsPassResult } from "./subscriptions-pass.js";
import { TelegramApiError } from "./subscriptions-pass.js";
import type { JudgmentPassResult } from "./judgment-pass.js";
import type { WinnersRetroPassResult } from "./winners-retro-pass.js";

import type { LogFields, Logger } from "./log.js";

/**
 * Raised when the shared active-set cutoff read (head block + timestamp
 * binary search in main.ts) fails before a pass body runs. That read
 * executes inside each loop's runOnce closure but ahead of the pass
 * function, so its RPC failures are never wrapped in a pass-specific halt
 * error; without this type they would propagate as unknown and crash the
 * worker (live incident 2026-07-21: exhausted RPC credits produced a
 * 358-restart crash loop). Classified recoverable by the enrichment,
 * activity, risk, and holder loops: halt, back off, retry.
 */
export class ActiveSetCutoffError extends Error {
  override readonly name = "ActiveSetCutoffError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export interface PollLoopOptions<R> {
  /** Log-event prefix: `${name}.pass`, `${name}.halted`, `${name}.stopped`. */
  readonly name: string;
  /** Runs one pass. Injectable for tests. */
  readonly runOnce: () => Promise<R>;
  /** Turn a result into its log event; return null to log nothing. */
  readonly describe: (result: R) => { event: string; fields: LogFields } | null;
  /**
   * Classify an error as recoverable: return log fields to log-and-backoff,
   * or null to crash the worker. Unknown failure modes must be seen, not
   * retried blindly.
   */
  readonly isRecoverable: (error: unknown) => LogFields | null;
  /** Delay between successful passes. */
  readonly pollIntervalMs: number;
  /** Delay after a recoverable failure. Default: 4x the poll interval. */
  readonly haltBackoffMs?: number;
  /** Stops the loop after the in-flight pass completes. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** Injectable abortable sleep for tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleepMs(ms, undefined, { signal });
  } catch (error) {
    // Aborted sleeps wake the loop so it can observe the stop signal;
    // anything else is a real failure.
    if (error instanceof Error && error.name === "AbortError") return;
    throw error;
  }
}

/**
 * Run passes until aborted. Recoverable failures (per `isRecoverable`) are
 * logged and retried after a backoff; everything else propagates. The
 * in-flight pass always completes before the loop returns.
 */
export async function runPollLoop<R>(
  options: PollLoopOptions<R>
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const haltBackoffMs = options.haltBackoffMs ?? options.pollIntervalMs * 4;

  while (!options.signal.aborted) {
    let delay = options.pollIntervalMs;
    try {
      const result = await options.runOnce();
      const described = options.describe(result);
      if (described !== null) {
        options.logger.info(described.event, described.fields);
      }
    } catch (error) {
      const recoverable = options.isRecoverable(error);
      if (recoverable === null) throw error;
      options.logger.error(`${options.name}.halted`, {
        ...recoverable,
        error
      });
      delay = haltBackoffMs;
    }
    if (options.signal.aborted) break;
    await sleep(delay, options.signal);
  }
  options.logger.info(`${options.name}.stopped`);
}

export interface DiscoveryLoopOptions {
  readonly runPass: () => Promise<DiscoveryPassResult>;
  readonly pollIntervalMs: number;
  readonly haltBackoffMs?: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Discovery-specific adapter kept thin so logging/retry semantics stay explicit. */
export function runDiscoveryLoop(options: DiscoveryLoopOptions): Promise<void> {
  const loopOptions: PollLoopOptions<DiscoveryPassResult> = {
    name: "discovery",
    runOnce: options.runPass,
    describe: (result) => ({
      event:
        result.scannedFromBlock === null && result.scannedToBlock === null
          ? "discovery.idle"
          : "discovery.pass",
      fields: {
        chainId: result.chainId,
        scannedFromBlock: result.scannedFromBlock,
        scannedToBlock: result.scannedToBlock,
        chunksProcessed: result.chunksProcessed,
        logsSeen: result.logsSeen,
        poolsInserted: result.poolsInserted,
        stopped: result.stopped
      }
    }),
    isRecoverable: (error) => {
      if (!(error instanceof DiscoveryHaltError)) return null;
      return {
        fromBlock: error.fromBlock,
        toBlock: error.toBlock
      };
    },
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    logger: options.logger,
    ...(options.haltBackoffMs === undefined
      ? {}
      : { haltBackoffMs: options.haltBackoffMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  };
  return runPollLoop(loopOptions);
}

export interface ActivityLoopOptions {
  readonly runPass: () => Promise<ActivityPassResult>;
  readonly pollIntervalMs: number;
  readonly haltBackoffMs?: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Activity-specific adapter: retry typed RPC halts, crash on unknown errors. */
export function runActivityLoop(options: ActivityLoopOptions): Promise<void> {
  const loopOptions: PollLoopOptions<ActivityPassResult> = {
    name: "activity",
    runOnce: options.runPass,
    describe: (result) => ({
      event:
        result.scannedFromBlock === null && result.scannedToBlock === null
          ? "activity.idle"
          : "activity.pass",
      fields: {
        chainId: result.chainId,
        scannedFromBlock: result.scannedFromBlock,
        scannedToBlock: result.scannedToBlock,
        chunksProcessed: result.chunksProcessed,
        logsSeen: result.logsSeen,
        swapEventsInserted: result.swapEventsInserted,
        snapshotsInserted: result.snapshotsInserted,
        poolsSelected: result.poolsSelected,
        poolsRefreshed: result.poolsRefreshed,
        stopped: result.stopped
      }
    }),
    isRecoverable: (error) => {
      if (error instanceof ActiveSetCutoffError) return { reason: error.message };
      if (!(error instanceof ActivityHaltError)) return null;
      return {
        fromBlock: error.fromBlock,
        toBlock: error.toBlock
      };
    },
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    logger: options.logger,
    ...(options.haltBackoffMs === undefined
      ? {}
      : { haltBackoffMs: options.haltBackoffMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  };
  return runPollLoop(loopOptions);
}

export interface RiskLoopOptions {
  readonly runPass: () => Promise<RiskPassResult>;
  readonly pollIntervalMs: number;
  readonly haltBackoffMs?: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Risk-specific adapter: retry typed RPC halts, crash on unknown errors. */
export function runRiskLoop(options: RiskLoopOptions): Promise<void> {
  const loopOptions: PollLoopOptions<RiskPassResult> = {
    name: "risk",
    runOnce: options.runPass,
    describe: (result) => ({
      event: result.poolsSelected === 0 ? "risk.idle" : "risk.pass",
      fields: {
        chainId: result.chainId,
        blockNumber: result.blockNumber,
        poolsSelected: result.poolsSelected,
        assessed: result.assessed,
        passed: result.passed,
        failed: result.failed,
        unknown: result.unknown,
        errored: result.errored,
        poolErrors: result.poolErrors.length,
        stopped: result.stopped
      }
    }),
    isRecoverable: (error) =>
      error instanceof RiskHaltError || error instanceof ActiveSetCutoffError
        ? { reason: error.message }
        : null,
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    logger: options.logger,
    ...(options.haltBackoffMs === undefined
      ? {}
      : { haltBackoffMs: options.haltBackoffMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  };
  return runPollLoop(loopOptions);
}

export interface HolderLoopOptions {
  readonly runPass: () => Promise<HolderPassResult>;
  readonly pollIntervalMs: number;
  readonly haltBackoffMs?: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Holder-scan adapter: retry typed RPC halts, crash on unknown errors. */
export function runHolderLoop(options: HolderLoopOptions): Promise<void> {
  const loopOptions: PollLoopOptions<HolderPassResult> = {
    name: "holders",
    runOnce: options.runPass,
    describe: (result) => ({
      event: result.poolsSelected === 0 ? "holders.idle" : "holders.pass",
      fields: {
        chainId: result.chainId,
        blockNumber: result.blockNumber,
        poolsSelected: result.poolsSelected,
        assessed: result.assessed,
        snapshotsInserted: result.snapshotsInserted,
        poolErrors: result.poolErrors.length,
        stopped: result.stopped
      }
    }),
    isRecoverable: (error) =>
      error instanceof HolderHaltError || error instanceof ActiveSetCutoffError
        ? { reason: error.message }
        : null,
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    logger: options.logger,
    ...(options.haltBackoffMs === undefined
      ? {}
      : { haltBackoffMs: options.haltBackoffMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  };
  return runPollLoop(loopOptions);
}

export interface ScoringLoopOptions {
  readonly runPass: () => Promise<ScoringPassResult>;
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Scoring/alert adapter. It reads persisted signals and sends alerts (no direct
 * RPC), so there is no typed halt to retry — any unknown error crashes the
 * worker; per-pool and delivery failures are handled inside the pass.
 */
export function runScoringLoop(options: ScoringLoopOptions): Promise<void> {
  const loopOptions: PollLoopOptions<ScoringPassResult> = {
    name: "scoring",
    runOnce: options.runPass,
    describe: (result) => ({
      event: "scoring.pass",
      fields: {
        chainId: result.chainId,
        poolsEvaluated: result.poolsEvaluated,
        candidates: result.candidates,
        alertsEmitted: result.alertsEmitted,
        red: result.red,
        yellow: result.yellow,
        green: result.green,
        poolErrors: result.poolErrors.length,
        /** First failure's message — per-pool errors were previously
         * count-only, which hid a 100%-failure persist bug in production. */
        firstPoolError: result.poolErrors[0]?.message ?? null,
        stopped: result.stopped
      }
    }),
    isRecoverable: () => null,
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    logger: options.logger,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  };
  return runPollLoop(loopOptions);
}

export interface OutcomeLoopOptions {
  readonly runPass: () => Promise<OutcomePassResult>;
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Outcome-labeling adapter. Pure DB reads/writes (no RPC), so like scoring
 * there is no typed halt to retry — unknown errors crash the worker; per-pool
 * failures are collected inside the pass.
 */
export function runOutcomeLoop(options: OutcomeLoopOptions): Promise<void> {
  const loopOptions: PollLoopOptions<OutcomePassResult> = {
    name: "outcomes",
    runOnce: options.runPass,
    describe: (result) => ({
      event: "outcomes.pass",
      fields: {
        chainId: result.chainId,
        horizons: result.horizons.join(","),
        poolsConsidered: result.poolsConsidered,
        labeled: result.labeled,
        survived: result.survived,
        died: result.died,
        skipped: result.skipped,
        poolErrors: result.poolErrors.length,
        stopped: result.stopped
      }
    }),
    isRecoverable: () => null,
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    logger: options.logger,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  };
  return runPollLoop(loopOptions);
}

export interface PerformanceLoopOptions {
  readonly runPass: () => Promise<PerformancePassResult>;
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Performance-labeling adapter. Pure DB reads/writes (no RPC), so like
 * outcomes there is no typed halt to retry — unknown errors crash the worker;
 * per-pool failures are collected inside the pass.
 */
export function runPerformanceLoop(options: PerformanceLoopOptions): Promise<void> {
  const loopOptions: PollLoopOptions<PerformancePassResult> = {
    name: "performance",
    runOnce: options.runPass,
    describe: (result) => ({
      event: "performance.pass",
      fields: {
        chainId: result.chainId,
        horizons: result.horizons.join(","),
        poolsConsidered: result.poolsConsidered,
        labeled: result.labeled,
        skipped: result.skipped,
        poolErrors: result.poolErrors.length,
        stopped: result.stopped
      }
    }),
    isRecoverable: () => null,
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    logger: options.logger,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  };
  return runPollLoop(loopOptions);
}

export interface SubscriptionsLoopOptions {
  readonly runPass: () => Promise<SubscriptionsPassResult>;
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Telegram subscription-sync adapter. Talks only to the Bot API and the
 * database. A typed `TelegramApiError` (network, HTTP, malformed body,
 * not-ok envelope) is logged and retried after the halt backoff — the Bot
 * API flaking must never crash ingestion; per-update handling failures are
 * collected inside the pass. Any other error crashes the worker.
 */
export function runSubscriptionsLoop(
  options: SubscriptionsLoopOptions
): Promise<void> {
  const loopOptions: PollLoopOptions<SubscriptionsPassResult> = {
    name: "subscriptions",
    runOnce: options.runPass,
    describe: (result) => ({
      event: "subscriptions.pass",
      fields: {
        updatesProcessed: result.updatesProcessed,
        subscribed: result.subscribed,
        pendingCreated: result.pendingCreated,
        removed: result.removed,
        hintsSent: result.hintsSent,
        scorecardsSent: result.scorecardsSent,
        updateErrors: result.updateErrors.length,
        stopped: result.stopped
      }
    }),
    isRecoverable: (error) => {
      if (!(error instanceof TelegramApiError)) return null;
      return { method: error.method, message: error.message };
    },
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    logger: options.logger,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  };
  return runPollLoop(loopOptions);
}

export interface JudgmentLoopOptions {
  readonly runPass: () => Promise<JudgmentPassResult>;
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Judgment/brief adapter, same shape as `runScoringLoop`: reads committed
 * alerts and calls an LLM (no direct chain RPC), so there is no typed halt
 * to retry — any unknown error crashes the worker; per-alert failures are
 * handled inside the pass.
 */
export function runJudgmentLoop(options: JudgmentLoopOptions): Promise<void> {
  const loopOptions: PollLoopOptions<JudgmentPassResult> = {
    name: "judgment",
    runOnce: options.runPass,
    describe: (result) => ({
      event: "judgment.pass",
      fields: {
        chainId: result.chainId,
        alertsConsidered: result.alertsConsidered,
        briefsCompleted: result.briefsCompleted,
        briefsFailed: result.briefsFailed,
        briefsRejected: result.briefsRejected,
        briefsSkipped: result.briefsSkipped,
        delivered: result.delivered,
        briefErrors: result.briefErrors.length,
        stopped: result.stopped
      }
    }),
    isRecoverable: () => null,
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    logger: options.logger,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  };
  return runPollLoop(loopOptions);
}

export interface WinnersRetroLoopOptions {
  readonly runPass: () => Promise<WinnersRetroPassResult>;
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Winners-retro adapter, same shape as `runJudgmentLoop`: pure DB reads plus
 * one optional Telegram send (failure absorbed inside the pass), so there is
 * no typed halt to retry — any unknown error crashes the worker; per-pool
 * failures are handled inside the pass.
 */
export function runWinnersRetroLoop(options: WinnersRetroLoopOptions): Promise<void> {
  const loopOptions: PollLoopOptions<WinnersRetroPassResult> = {
    name: "winners-retro",
    runOnce: options.runPass,
    describe: (result) => ({
      event: "winners_retro.pass",
      fields: {
        chainId: result.chainId,
        candidates: result.candidates,
        evaluated: result.evaluated,
        newWinners: result.newWinners,
        digestSent: result.digestSent,
        poolErrors: result.poolErrors.length,
        stopped: result.stopped
      }
    }),
    isRecoverable: () => null,
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    logger: options.logger,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  };
  return runPollLoop(loopOptions);
}
