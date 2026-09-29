import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getCitedRow,
  getJudgmentBriefByAlert,
  getLatestPrompt,
  getOrCreatePrompt,
  getPrompt,
  getTradeSimulationAt,
  insertAlertSent,
  insertJudgmentBrief,
  insertJudgmentCitations,
  insertJudgmentEvalItems,
  insertJudgmentEvalRun,
  insertJudgmentToolCalls,
  insertPools,
  insertPoolSnapshots,
  listPoolSnapshots,
  insertTokenOutcome,
  insertTokens,
  insertTradeSimulation,
  listAlertsNeedingBrief,
  listJudgmentBriefs,
  listJudgmentCitations,
  listJudgmentEvalRuns,
  listJudgmentToolCalls,
  listTokenOutcomesByDeployer,
  type AlertSentInsert,
  type JudgmentBriefInsert,
  type JudgmentCitationInsert,
  type JudgmentEvalItemInsert,
  type JudgmentEvalRunInsert,
  type JudgmentToolCallInsert,
  type PoolInsert,
  type PoolSnapshotInsert,
  type TokenInsert,
  type TokenOutcomeInsert,
  type TradeSimulationInsert
} from "../src/repositories/index.js";
import type { Db } from "../src/client.js";
import { createTestDatabase, type TestDatabaseHandle } from "../src/testing.js";

const CHAIN_ID = 9191;
const T0 = new Date("2024-05-01T00:00:00.000Z");

function minutes(n: number): Date {
  return new Date(T0.getTime() + n * 60_000);
}

function poolFixture(
  poolAddress: string,
  overrides: Partial<PoolInsert> = {}
): PoolInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress,
    factoryAddress: "0xFactory",
    dex: "uniswap",
    factoryKind: "uniswap-v2",
    token0Address: "0xQuote",
    token1Address: "0xBase",
    createdAtBlock: 1n,
    createdTxHash: `0xcreate${poolAddress}`,
    createdLogIndex: 0,
    ...overrides
  };
}

function snapshotFixture(
  poolAddress: string,
  capturedAt: Date,
  overrides: Partial<PoolSnapshotInsert> = {}
): PoolSnapshotInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress,
    blockNumber: 1n,
    capturedAt,
    calculationMethod: "v2-reserves",
    ...overrides
  };
}

function tokenFixture(
  address: string,
  overrides: Partial<TokenInsert> = {}
): TokenInsert {
  return {
    chainId: CHAIN_ID,
    address,
    firstSeenBlock: 1n,
    name: "Token",
    symbol: "TKN",
    decimals: 18,
    ...overrides
  };
}

function alertFixture(overrides: Partial<AlertSentInsert> = {}): AlertSentInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress: "0xToken",
    poolAddress: "0xPool",
    alertLevel: "RED",
    score: 50,
    sentAt: T0,
    reason: "score threshold",
    transport: "dry-run",
    delivered: true,
    ...overrides
  };
}

function briefFixture(overrides: Partial<JudgmentBriefInsert> = {}): JudgmentBriefInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress: "0xToken",
    poolAddress: "0xPool",
    mode: "LIVE",
    alertId: null,
    evalRunId: null,
    asOf: T0,
    promptName: "research-brief",
    promptVersion: 1,
    templateHash: "hash-v1",
    model: "test-model",
    status: "COMPLETED",
    thesis: "thesis text",
    confidenceBps: 5000,
    recommendation: "WATCH",
    ...overrides
  };
}

function tradeSimFixture(
  tokenAddress: string,
  poolAddress: string,
  simulatedAt: Date,
  overrides: Partial<TradeSimulationInsert> = {}
): TradeSimulationInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress,
    poolAddress,
    blockNumber: 1n,
    simulatedAt,
    route: "uniswap-v2",
    buyStatus: "PASS",
    transferStatus: "PASS",
    sellStatus: "PASS",
    status: "PASS",
    ...overrides
  };
}

function outcomeFixture(
  tokenAddress: string,
  poolAddress: string,
  overrides: Partial<TokenOutcomeInsert> = {}
): TokenOutcomeInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress,
    poolAddress,
    horizonHours: 72,
    outcome: "SURVIVED",
    firstObservedAt: T0,
    labeledAt: T0,
    details: {},
    ...overrides
  };
}

describe("judgment repositories", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  describe("insertJudgmentBrief", () => {
    it("is idempotent on alertId: a second insert for the same alert returns undefined", async () => {
      const alert = await insertAlertSent(db, alertFixture());

      const first = await insertJudgmentBrief(
        db,
        briefFixture({ alertId: alert.id })
      );
      expect(first).toBeDefined();
      expect(first?.alertId).toBe(alert.id);

      const second = await insertJudgmentBrief(
        db,
        briefFixture({ alertId: alert.id, thesis: "different thesis" })
      );
      expect(second).toBeUndefined();

      const stored = await getJudgmentBriefByAlert(db, alert.id);
      expect(stored?.thesis).toBe("thesis text");
    });

    it("always inserts null-alert REPLAY rows, even several in a row", async () => {
      const first = await insertJudgmentBrief(
        db,
        briefFixture({ mode: "REPLAY", alertId: null, evalRunId: 1n })
      );
      const second = await insertJudgmentBrief(
        db,
        briefFixture({ mode: "REPLAY", alertId: null, evalRunId: 1n })
      );
      const third = await insertJudgmentBrief(
        db,
        briefFixture({ mode: "REPLAY", alertId: null, evalRunId: 2n })
      );

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(third).toBeDefined();
      expect(new Set([first?.id, second?.id, third?.id]).size).toBe(3);
    });
  });

  describe("listAlertsNeedingBrief", () => {
    it("excludes briefed alerts and respects the level filter, oldest first", async () => {
      const earlyWatch = await insertAlertSent(
        db,
        alertFixture({ alertLevel: "RED", sentAt: minutes(0) })
      );
      const yellowOld = await insertAlertSent(
        db,
        alertFixture({ alertLevel: "YELLOW", sentAt: minutes(5) })
      );
      const yellowBriefed = await insertAlertSent(
        db,
        alertFixture({ alertLevel: "YELLOW", sentAt: minutes(10) })
      );
      const greenNew = await insertAlertSent(
        db,
        alertFixture({ alertLevel: "GREEN", sentAt: minutes(15) })
      );

      await insertJudgmentBrief(
        db,
        briefFixture({ alertId: yellowBriefed.id })
      );

      const due = await listAlertsNeedingBrief(
        db,
        CHAIN_ID,
        ["YELLOW", "GREEN"],
        10
      );

      expect(due.map((row) => row.id)).toEqual([yellowOld.id, greenNew.id]);
      expect(due.some((row) => row.id === earlyWatch.id)).toBe(false);
      expect(due.some((row) => row.id === yellowBriefed.id)).toBe(false);
    });

    it("respects the limit", async () => {
      await insertAlertSent(
        db,
        alertFixture({ alertLevel: "GREEN", sentAt: minutes(0) })
      );
      await insertAlertSent(
        db,
        alertFixture({ alertLevel: "GREEN", sentAt: minutes(1) })
      );

      const due = await listAlertsNeedingBrief(db, CHAIN_ID, ["GREEN"], 1);
      expect(due).toHaveLength(1);
    });

    describe("per-token re-brief suppression (rebriefCooldownMs)", () => {
      const DAY_MS = 24 * 60 * 60 * 1000;

      /** A briefed YELLOW alert at t=0 for the fixture token. */
      async function briefedYellowAt(sentAt: Date): Promise<void> {
        const briefed = await insertAlertSent(
          db,
          alertFixture({ alertLevel: "YELLOW", sentAt })
        );
        await insertJudgmentBrief(
          db,
          briefFixture({ alertId: briefed.id, createdAt: new Date(sentAt.getTime() + 60_000) })
        );
      }

      it("suppresses a same-level re-alert inside the cooldown", async () => {
        await briefedYellowAt(minutes(0));
        await insertAlertSent(
          db,
          alertFixture({ alertLevel: "YELLOW", sentAt: minutes(60) })
        );

        const due = await listAlertsNeedingBrief(db, CHAIN_ID, ["YELLOW", "GREEN"], 10, DAY_MS);
        expect(due).toHaveLength(0);
      });

      it("briefs a level escalation despite a recent brief", async () => {
        await briefedYellowAt(minutes(0));
        const escalated = await insertAlertSent(
          db,
          alertFixture({ alertLevel: "GREEN", sentAt: minutes(60) })
        );

        const due = await listAlertsNeedingBrief(db, CHAIN_ID, ["YELLOW", "GREEN"], 10, DAY_MS);
        expect(due.map((row) => row.id)).toEqual([escalated.id]);
      });

      it("briefs again once the cooldown has elapsed", async () => {
        await briefedYellowAt(minutes(0));
        const late = await insertAlertSent(
          db,
          alertFixture({
            alertLevel: "YELLOW",
            sentAt: new Date(T0.getTime() + DAY_MS + 60 * 60 * 1000)
          })
        );

        const due = await listAlertsNeedingBrief(db, CHAIN_ID, ["YELLOW", "GREEN"], 10, DAY_MS);
        expect(due.map((row) => row.id)).toEqual([late.id]);
      });

      it("does not suppress across different tokens", async () => {
        await briefedYellowAt(minutes(0));
        const otherToken = await insertAlertSent(
          db,
          alertFixture({
            tokenAddress: "0xOtherToken",
            alertLevel: "YELLOW",
            sentAt: minutes(60)
          })
        );

        const due = await listAlertsNeedingBrief(db, CHAIN_ID, ["YELLOW", "GREEN"], 10, DAY_MS);
        expect(due.map((row) => row.id)).toEqual([otherToken.id]);
      });

      it("does not let FAILED or REJECTED briefs suppress a new alert", async () => {
        const failedAlert = await insertAlertSent(
          db,
          alertFixture({ alertLevel: "YELLOW", sentAt: minutes(0) })
        );
        await insertJudgmentBrief(
          db,
          briefFixture({ alertId: failedAlert.id, status: "FAILED", thesis: null })
        );
        const reAlert = await insertAlertSent(
          db,
          alertFixture({ alertLevel: "YELLOW", sentAt: minutes(60) })
        );

        const due = await listAlertsNeedingBrief(db, CHAIN_ID, ["YELLOW", "GREEN"], 10, DAY_MS);
        expect(due.map((row) => row.id)).toEqual([reAlert.id]);
      });

      it("cooldown 0 disables the per-token gate (every re-alert briefs)", async () => {
        await briefedYellowAt(minutes(0));
        const reAlert = await insertAlertSent(
          db,
          alertFixture({ alertLevel: "YELLOW", sentAt: minutes(60) })
        );

        const due = await listAlertsNeedingBrief(db, CHAIN_ID, ["YELLOW", "GREEN"], 10, 0);
        expect(due.map((row) => row.id)).toEqual([reAlert.id]);
      });
    });
  });

  describe("insertJudgmentToolCalls / listJudgmentToolCalls", () => {
    it("returns tool calls in seq order", async () => {
      const alert = await insertAlertSent(db, alertFixture());
      const brief = await insertJudgmentBrief(
        db,
        briefFixture({ alertId: alert.id })
      );
      if (brief === undefined) throw new Error("brief insert failed");

      const rows: JudgmentToolCallInsert[] = [
        { briefId: brief.id, seq: 1, toolName: "baseRateForPattern", args: {} },
        { briefId: brief.id, seq: 0, toolName: "comparableLaunches", args: {} }
      ];
      await insertJudgmentToolCalls(db, rows);

      const listed = await listJudgmentToolCalls(db, brief.id);
      expect(listed.map((row) => row.toolName)).toEqual([
        "comparableLaunches",
        "baseRateForPattern"
      ]);
    });
  });

  describe("insertJudgmentCitations / listJudgmentCitations", () => {
    it("persists every citation check, verified or not", async () => {
      const alert = await insertAlertSent(db, alertFixture());
      const brief = await insertJudgmentBrief(
        db,
        briefFixture({ alertId: alert.id })
      );
      if (brief === undefined) throw new Error("brief insert failed");

      const rows: JudgmentCitationInsert[] = [
        {
          briefId: brief.id,
          claimKey: "thesis",
          citedTable: "pool_snapshots",
          citedRowId: 1n,
          citedField: "estimatedFdvUsd",
          claimedValue: "1000",
          verified: true,
          actualValue: null
        },
        {
          briefId: brief.id,
          claimKey: "riskCalls[0]",
          citedTable: "token_risks",
          citedRowId: 1n,
          citedField: "score",
          claimedValue: "80",
          verified: false,
          actualValue: "42"
        }
      ];
      await insertJudgmentCitations(db, rows);

      const listed = await listJudgmentCitations(db, brief.id);
      expect(listed).toHaveLength(2);
      expect(listed.filter((row) => !row.verified)).toHaveLength(1);
    });
  });

  describe("listJudgmentBriefs", () => {
    it("filters by mode/status and orders newest first", async () => {
      const a1 = await insertAlertSent(db, alertFixture({ sentAt: minutes(0) }));
      const a2 = await insertAlertSent(db, alertFixture({ sentAt: minutes(1) }));

      await insertJudgmentBrief(
        db,
        briefFixture({ alertId: a1.id, status: "COMPLETED", createdAt: minutes(0) })
      );
      await insertJudgmentBrief(
        db,
        briefFixture({ alertId: a2.id, status: "FAILED", createdAt: minutes(1) })
      );

      const completed = await listJudgmentBriefs(db, CHAIN_ID, {
        status: "COMPLETED"
      });
      expect(completed).toHaveLength(1);
      expect(completed[0]?.alertId).toBe(a1.id);

      const all = await listJudgmentBriefs(db, CHAIN_ID);
      expect(all.map((row) => row.alertId)).toEqual([a2.id, a1.id]);
    });
  });

  describe("getOrCreatePrompt", () => {
    it("returns the same row for the same hash and bumps version on change", async () => {
      const first = await getOrCreatePrompt(db, {
        name: "research-brief",
        template: "template v1",
        templateHash: "hash-v1",
        changelog: "initial"
      });
      expect(first.version).toBe(1);

      const reused = await getOrCreatePrompt(db, {
        name: "research-brief",
        template: "template v1",
        templateHash: "hash-v1",
        changelog: "initial"
      });
      expect(reused.id).toBe(first.id);
      expect(reused.version).toBe(1);

      const bumped = await getOrCreatePrompt(db, {
        name: "research-brief",
        template: "template v2",
        templateHash: "hash-v2",
        changelog: "tweak wording"
      });
      expect(bumped.version).toBe(2);
      expect(bumped.id).not.toBe(first.id);

      const latest = await getLatestPrompt(db, "research-brief");
      expect(latest?.version).toBe(2);
      const exact = await getPrompt(db, "research-brief", 1);
      expect(exact?.templateHash).toBe("hash-v1");
    });
  });

  describe("getCitedRow", () => {
    it("dispatches to the right table, and returns undefined for bad table/id", async () => {
      await insertPools(db, [poolFixture("0xPool")]);
      await insertPoolSnapshots(db, [snapshotFixture("0xPool", T0)]);
      const [snapshot] = await listPoolSnapshots(db, CHAIN_ID, "0xPool");
      expect(snapshot).toBeDefined();

      const sim = await insertTradeSimulation(
        db,
        tradeSimFixture("0xToken", "0xPool", T0)
      );

      const poolRow = await getCitedRow(db, "pool_snapshots", snapshot!.id);
      expect(poolRow?.["poolAddress"]).toBe("0xPool");

      const simRow = await getCitedRow(db, "trade_simulations", sim.id);
      expect(simRow?.["tokenAddress"]).toBe("0xToken");

      expect(await getCitedRow(db, "tokens", 1n)).toBeUndefined();
      expect(await getCitedRow(db, "pool_snapshots", 999_999n)).toBeUndefined();
    });
  });

  describe("insertJudgmentEvalRun / insertJudgmentEvalItems / listJudgmentEvalRuns", () => {
    it("round-trips an eval run and its items", async () => {
      const runInsert: JudgmentEvalRunInsert = {
        chainId: CHAIN_ID,
        promptName: "research-brief",
        promptVersion: 1,
        horizonHours: 72,
        periodStart: minutes(0),
        periodEnd: minutes(1000),
        briefsTotal: 1,
        report: { brier: 0.1 }
      };
      const run = await insertJudgmentEvalRun(db, runInsert);
      expect(run.id).toBeDefined();

      const alert = await insertAlertSent(db, alertFixture());
      const brief = await insertJudgmentBrief(
        db,
        briefFixture({ alertId: alert.id })
      );
      if (brief === undefined) throw new Error("brief insert failed");

      const item: JudgmentEvalItemInsert = {
        runId: run.id,
        briefId: brief.id,
        poolAddress: "0xPool",
        realizedLabel: "HELD_BAND",
        realizedMaxMultipleBps: 12000,
        predictedHitBps: 5000,
        realizedHit: true,
        brierMicro: 250000,
        riskMatches: {}
      };
      await insertJudgmentEvalItems(db, [item]);

      const runs = await listJudgmentEvalRuns(db, CHAIN_ID);
      expect(runs.map((row) => row.id)).toContain(run.id);
    });
  });

  describe("getTradeSimulationAt", () => {
    it("returns the latest row at or before `at`, and undefined when only future rows exist", async () => {
      await insertTradeSimulation(
        db,
        tradeSimFixture("0xToken", "0xPool", minutes(10))
      );
      await insertTradeSimulation(
        db,
        tradeSimFixture("0xToken", "0xPool", minutes(20))
      );

      const atMid = await getTradeSimulationAt(
        db,
        CHAIN_ID,
        "0xToken",
        minutes(15)
      );
      expect(atMid?.simulatedAt.getTime()).toBe(minutes(10).getTime());

      await insertTradeSimulation(
        db,
        tradeSimFixture("0xFutureToken", "0xPool", minutes(100))
      );
      const beforeAny = await getTradeSimulationAt(
        db,
        CHAIN_ID,
        "0xFutureToken",
        minutes(0)
      );
      expect(beforeAny).toBeUndefined();
    });
  });

  describe("listTokenOutcomesByDeployer", () => {
    it("filters by RESOLVED deployer and excludes the candidate token", async () => {
      await insertTokens(db, [
        tokenFixture("0xCandidate", {
          deployerAddress: "0xDeployer",
          deployerStatus: "RESOLVED"
        }),
        tokenFixture("0xSibling", {
          deployerAddress: "0xDeployer",
          deployerStatus: "RESOLVED"
        }),
        tokenFixture("0xOtherDeployer", {
          deployerAddress: "0xOtherDeployer",
          deployerStatus: "RESOLVED"
        }),
        tokenFixture("0xUnresolved", {
          deployerAddress: "0xDeployer",
          deployerStatus: "UNKNOWN"
        })
      ]);
      await insertTokenOutcome(
        db,
        outcomeFixture("0xCandidate", "0xPoolCandidate")
      );
      await insertTokenOutcome(db, outcomeFixture("0xSibling", "0xPoolSibling"));
      await insertTokenOutcome(
        db,
        outcomeFixture("0xOtherDeployer", "0xPoolOther")
      );
      await insertTokenOutcome(
        db,
        outcomeFixture("0xUnresolved", "0xPoolUnresolved")
      );

      const rows = await listTokenOutcomesByDeployer(
        db,
        CHAIN_ID,
        "0xDeployer",
        "0xCandidate"
      );

      expect(rows.map((row) => row.tokenAddress)).toEqual(["0xSibling"]);
    });
  });
});
