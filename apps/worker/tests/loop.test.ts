import { describe, expect, it } from "vitest";

import { ActivityHaltError, type ActivityPassResult } from "@assay/activity";
import { EnrichmentHaltError } from "@assay/enrichment";

import { DiscoveryHaltError, type DiscoveryPassResult } from "@assay/discovery";
import { RiskHaltError, type RiskPassResult } from "@assay/risk-engine";

import type { LogFields, Logger } from "../src/log.js";
import {
  ActiveSetCutoffError,
  runActivityLoop,
  runDiscoveryLoop,
  runHolderLoop,
  runPollLoop,
  runRiskLoop,
  runSubscriptionsLoop
} from "../src/loop.js";
import {
  TelegramApiError,
  type SubscriptionsPassResult
} from "../src/subscriptions-pass.js";

function passResult(
  overrides: Partial<DiscoveryPassResult> = {}
): DiscoveryPassResult {
  return {
    chainId: 4663,
    scannedFromBlock: 100n,
    scannedToBlock: 150n,
    chunksProcessed: 1,
    logsSeen: 2,
    poolsInserted: 2,
    stopped: false,
    ...overrides
  };
}

function activityPassResult(
  overrides: Partial<ActivityPassResult> = {}
): ActivityPassResult {
  return {
    chainId: 4663,
    scannedFromBlock: 100n,
    scannedToBlock: 150n,
    chunksProcessed: 1,
    logsSeen: 2,
    swapEventsInserted: 2,
    snapshotsInserted: 1,
    poolsSelected: 1,
    poolsRefreshed: 0,
    stopped: false,
    ...overrides
  };
}

interface Recorded {
  level: "info" | "error";
  event: string;
  fields: LogFields | undefined;
}

function recordingLogger(): { logger: Logger; events: Recorded[] } {
  const events: Recorded[] = [];
  return {
    events,
    logger: {
      info: (event, fields) => events.push({ level: "info", event, fields }),
      error: (event, fields) => events.push({ level: "error", event, fields })
    }
  };
}

/** Sleep stub that records requested delays and yields the microtask queue. */
function recordingSleep(): {
  delays: number[];
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
      await Promise.resolve();
    }
  };
}

describe("runDiscoveryLoop", () => {
  it("keeps polling until aborted, then stops cleanly", async () => {
    const { logger, events } = recordingLogger();
    const { delays, sleep } = recordingSleep();
    const controller = new AbortController();
    let passes = 0;

    await runDiscoveryLoop({
      runPass: () => {
        passes += 1;
        if (passes === 3) controller.abort();
        return Promise.resolve(passResult());
      },
      pollIntervalMs: 15_000,
      signal: controller.signal,
      logger,
      sleep
    });

    expect(passes).toBe(3);
    // Abort observed after the third pass: no sleep afterwards.
    expect(delays).toEqual([15_000, 15_000]);
    expect(events.at(-1)?.event).toBe("discovery.stopped");
  });

  it("survives DiscoveryHaltError with backoff and retries", async () => {
    const { logger, events } = recordingLogger();
    const { delays, sleep } = recordingSleep();
    const controller = new AbortController();
    let passes = 0;

    await runDiscoveryLoop({
      runPass: () => {
        passes += 1;
        if (passes === 1) {
          return Promise.reject(
            new DiscoveryHaltError("rpc down", {
              fromBlock: 120n,
              toBlock: 139n
            })
          );
        }
        controller.abort();
        return Promise.resolve(passResult());
      },
      pollIntervalMs: 1_000,
      haltBackoffMs: 9_000,
      signal: controller.signal,
      logger,
      sleep
    });

    expect(passes).toBe(2); // retried after the halt
    expect(delays).toEqual([9_000]); // backoff, not the poll interval
    const halted = events.find((e) => e.event === "discovery.halted");
    expect(halted?.level).toBe("error");
    expect(halted?.fields).toMatchObject({ fromBlock: 120n, toBlock: 139n });
  });

  it("propagates unknown errors instead of retrying blindly", async () => {
    const { logger } = recordingLogger();
    const { sleep } = recordingSleep();
    const controller = new AbortController();

    await expect(
      runDiscoveryLoop({
        runPass: () => Promise.reject(new TypeError("bug in decode")),
        pollIntervalMs: 1_000,
        signal: controller.signal,
        logger,
        sleep
      })
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("lets the in-flight pass finish when aborted mid-pass", async () => {
    const { logger, events } = recordingLogger();
    const { sleep } = recordingSleep();
    const controller = new AbortController();
    const gate = Promise.withResolvers<DiscoveryPassResult>();
    let passCompleted = false;

    const loop = runDiscoveryLoop({
      runPass: async () => {
        const result = await gate.promise;
        passCompleted = true;
        return result;
      },
      pollIntervalMs: 1_000,
      signal: controller.signal,
      logger,
      sleep
    });

    // Abort while the first pass is still awaiting the gate.
    controller.abort();
    gate.resolve(passResult());
    await loop;

    expect(passCompleted).toBe(true);
    // The completed pass is still logged before shutdown.
    expect(events.map((e) => e.event)).toEqual([
      "discovery.pass",
      "discovery.stopped"
    ]);
  });

  it("logs an idle event when there is nothing to scan", async () => {
    const { logger, events } = recordingLogger();
    const { sleep } = recordingSleep();
    const controller = new AbortController();

    await runDiscoveryLoop({
      runPass: () => {
        controller.abort();
        return Promise.resolve(
          passResult({ scannedFromBlock: null, scannedToBlock: null })
        );
      },
      pollIntervalMs: 1_000,
      signal: controller.signal,
      logger,
      sleep
    });

    expect(events[0]?.event).toBe("discovery.idle");
  });
});

describe("runActivityLoop", () => {
  it("backs off on ActivityHaltError and retries", async () => {
    const { logger, events } = recordingLogger();
    const { delays, sleep } = recordingSleep();
    const controller = new AbortController();
    let passes = 0;

    await runActivityLoop({
      runPass: () => {
        passes += 1;
        if (passes === 1) {
          return Promise.reject(
            new ActivityHaltError("rpc down", {
              fromBlock: 120n,
              toBlock: 139n
            })
          );
        }
        controller.abort();
        return Promise.resolve(activityPassResult());
      },
      pollIntervalMs: 1_000,
      haltBackoffMs: 9_000,
      signal: controller.signal,
      logger,
      sleep
    });

    expect(passes).toBe(2);
    expect(delays).toEqual([9_000]);
    const halted = events.find((e) => e.event === "activity.halted");
    expect(halted?.level).toBe("error");
    expect(halted?.fields).toMatchObject({ fromBlock: 120n, toBlock: 139n });
  });

  it("propagates unknown activity errors", async () => {
    const { logger } = recordingLogger();
    const { sleep } = recordingSleep();
    const controller = new AbortController();

    await expect(
      runActivityLoop({
        runPass: () => Promise.reject(new TypeError("decode bug")),
        pollIntervalMs: 1_000,
        signal: controller.signal,
        logger,
        sleep
      })
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("lets an activity pass finish when aborted mid-pass", async () => {
    const { logger, events } = recordingLogger();
    const { sleep } = recordingSleep();
    const controller = new AbortController();
    const gate = Promise.withResolvers<ActivityPassResult>();
    let passCompleted = false;

    const loop = runActivityLoop({
      runPass: async () => {
        const result = await gate.promise;
        passCompleted = true;
        return result;
      },
      pollIntervalMs: 1_000,
      signal: controller.signal,
      logger,
      sleep
    });

    controller.abort();
    gate.resolve(activityPassResult());
    await loop;

    expect(passCompleted).toBe(true);
    expect(events.map((e) => e.event)).toEqual([
      "activity.pass",
      "activity.stopped"
    ]);
  });

  it("backs off on ActiveSetCutoffError instead of crashing", async () => {
    const { logger, events } = recordingLogger();
    const { delays, sleep } = recordingSleep();
    const controller = new AbortController();
    let passes = 0;

    await runActivityLoop({
      runPass: () => {
        passes += 1;
        if (passes === 1) {
          return Promise.reject(
            new ActiveSetCutoffError("active-set cutoff read failed")
          );
        }
        controller.abort();
        return Promise.resolve(activityPassResult());
      },
      pollIntervalMs: 1_000,
      haltBackoffMs: 9_000,
      signal: controller.signal,
      logger,
      sleep
    });

    expect(passes).toBe(2);
    expect(delays).toEqual([9_000]);
    const halted = events.find((e) => e.event === "activity.halted");
    expect(halted?.level).toBe("error");
    expect(halted?.fields).toMatchObject({
      reason: "active-set cutoff read failed"
    });
  });
});

function riskPassResult(
  overrides: Partial<RiskPassResult> = {}
): RiskPassResult {
  return {
    chainId: 4663,
    blockNumber: 1000n,
    poolsSelected: 1,
    assessed: 1,
    passed: 1,
    failed: 0,
    unknown: 0,
    errored: 0,
    poolErrors: [],
    stopped: false,
    ...overrides
  };
}

describe("runRiskLoop", () => {
  it("backs off on RiskHaltError and retries", async () => {
    const { logger, events } = recordingLogger();
    const { delays, sleep } = recordingSleep();
    const controller = new AbortController();
    let passes = 0;

    await runRiskLoop({
      runPass: () => {
        passes += 1;
        if (passes === 1) {
          return Promise.reject(new RiskHaltError("rpc down"));
        }
        controller.abort();
        return Promise.resolve(riskPassResult());
      },
      pollIntervalMs: 1_000,
      haltBackoffMs: 9_000,
      signal: controller.signal,
      logger,
      sleep
    });

    expect(passes).toBe(2);
    expect(delays).toEqual([9_000]);
    expect(events.find((e) => e.event === "risk.halted")?.level).toBe("error");
  });

  it("propagates unknown risk errors", async () => {
    const { logger } = recordingLogger();
    const { sleep } = recordingSleep();
    const controller = new AbortController();

    await expect(
      runRiskLoop({
        runPass: () => Promise.reject(new TypeError("assessment bug")),
        pollIntervalMs: 1_000,
        signal: controller.signal,
        logger,
        sleep
      })
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("lets a risk pass finish when aborted mid-pass", async () => {
    const { logger, events } = recordingLogger();
    const { sleep } = recordingSleep();
    const controller = new AbortController();
    const gate = Promise.withResolvers<RiskPassResult>();
    let passCompleted = false;

    const loop = runRiskLoop({
      runPass: async () => {
        const result = await gate.promise;
        passCompleted = true;
        return result;
      },
      pollIntervalMs: 1_000,
      signal: controller.signal,
      logger,
      sleep
    });

    controller.abort();
    gate.resolve(riskPassResult());
    await loop;

    expect(passCompleted).toBe(true);
    expect(events.map((e) => e.event)).toEqual(["risk.pass", "risk.stopped"]);
  });

  it("backs off on ActiveSetCutoffError instead of crashing", async () => {
    const { logger, events } = recordingLogger();
    const { delays, sleep } = recordingSleep();
    const controller = new AbortController();
    let passes = 0;

    await runRiskLoop({
      runPass: () => {
        passes += 1;
        if (passes === 1) {
          return Promise.reject(
            new ActiveSetCutoffError("active-set cutoff read failed")
          );
        }
        controller.abort();
        return Promise.resolve(riskPassResult());
      },
      pollIntervalMs: 1_000,
      haltBackoffMs: 9_000,
      signal: controller.signal,
      logger,
      sleep
    });

    expect(passes).toBe(2);
    expect(delays).toEqual([9_000]);
    const halted = events.find((e) => e.event === "risk.halted");
    expect(halted?.level).toBe("error");
    expect(halted?.fields).toMatchObject({
      reason: "active-set cutoff read failed"
    });
  });
});

describe("runHolderLoop", () => {
  it("backs off on ActiveSetCutoffError instead of crashing", async () => {
    const { logger, events } = recordingLogger();
    const { delays, sleep } = recordingSleep();
    const controller = new AbortController();
    let passes = 0;

    await runHolderLoop({
      runPass: () => {
        passes += 1;
        if (passes === 1) {
          return Promise.reject(
            new ActiveSetCutoffError("active-set cutoff read failed")
          );
        }
        controller.abort();
        return Promise.resolve({
          chainId: 4663,
          blockNumber: 1000n,
          poolsSelected: 0,
          assessed: 0,
          snapshotsInserted: 0,
          poolErrors: [],
          stopped: false
        });
      },
      pollIntervalMs: 1_000,
      haltBackoffMs: 9_000,
      signal: controller.signal,
      logger,
      sleep
    });

    expect(passes).toBe(2);
    expect(delays).toEqual([9_000]);
    const halted = events.find((e) => e.event === "holders.halted");
    expect(halted?.level).toBe("error");
    expect(halted?.fields).toMatchObject({
      reason: "active-set cutoff read failed"
    });
  });

  it("propagates unknown holder errors", async () => {
    const { logger } = recordingLogger();
    const { sleep } = recordingSleep();
    const controller = new AbortController();

    await expect(
      runHolderLoop({
        runPass: () => Promise.reject(new TypeError("scan bug")),
        pollIntervalMs: 1_000,
        signal: controller.signal,
        logger,
        sleep
      })
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("enrichment loop wiring", () => {
  it("backs off on EnrichmentHaltError and retries instead of crashing", async () => {
    const { logger, events } = recordingLogger();
    const { delays, sleep } = recordingSleep();
    const controller = new AbortController();
    let passes = 0;

    // Mirrors the main.ts wiring: runPollLoop driven directly, halt errors
    // recoverable, anything else fatal.
    await runPollLoop<{ snapshotsInserted: number }>({
      name: "enrichment",
      runOnce: () => {
        passes += 1;
        if (passes === 1) {
          return Promise.reject(new EnrichmentHaltError("rpc down"));
        }
        controller.abort();
        return Promise.resolve({ snapshotsInserted: 0 });
      },
      describe: (result) => ({
        event: "enrichment.pass",
        fields: { snapshotsInserted: result.snapshotsInserted }
      }),
      isRecoverable: (error) =>
        error instanceof EnrichmentHaltError ? { reason: error.message } : null,
      pollIntervalMs: 1_000,
      haltBackoffMs: 9_000,
      signal: controller.signal,
      logger,
      sleep
    });

    expect(passes).toBe(2);
    expect(delays).toEqual([9_000]);
    const halted = events.filter((e) => e.event === "enrichment.halted");
    expect(halted).toHaveLength(1);
    expect(halted[0]?.level).toBe("error");
    expect(halted[0]?.fields).toMatchObject({ reason: "rpc down" });
  });
});

function subscriptionsPassResult(): SubscriptionsPassResult {
  return {
    updatesProcessed: 0,
    subscribed: 0,
    pendingCreated: 0,
    removed: 0,
    hintsSent: 0,
    scorecardsSent: 0,
    updateErrors: [],
    stopped: false
  };
}

describe("runSubscriptionsLoop", () => {
  it("backs off on TelegramApiError and retries — Bot API flake never kills ingestion", async () => {
    const { logger, events } = recordingLogger();
    const { delays, sleep } = recordingSleep();
    const controller = new AbortController();
    let passes = 0;

    await runSubscriptionsLoop({
      runPass: () => {
        passes += 1;
        if (passes === 1) {
          return Promise.reject(
            new TelegramApiError(
              "getUpdates",
              "Telegram getUpdates returned a malformed JSON body"
            )
          );
        }
        controller.abort();
        return Promise.resolve(subscriptionsPassResult());
      },
      pollIntervalMs: 1_000,
      signal: controller.signal,
      logger,
      sleep
    });

    expect(passes).toBe(2);
    expect(delays).toEqual([4_000]);
    const halted = events.find((e) => e.event === "subscriptions.halted");
    expect(halted?.level).toBe("error");
    expect(halted?.fields).toMatchObject({ method: "getUpdates" });
  });

  it("still crashes on unknown subscription errors", async () => {
    const { logger } = recordingLogger();
    const { sleep } = recordingSleep();
    const controller = new AbortController();

    await expect(
      runSubscriptionsLoop({
        runPass: () => Promise.reject(new TypeError("real bug")),
        pollIntervalMs: 1_000,
        signal: controller.signal,
        logger,
        sleep
      })
    ).rejects.toBeInstanceOf(TypeError);
  });
});
