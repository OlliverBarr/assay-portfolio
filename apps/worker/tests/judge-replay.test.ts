import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  insertPools,
  insertTokenPerformance,
  insertTokens,
  listJudgmentBriefs,
  listJudgmentCitations,
  type Db,
  type JudgmentBriefRow,
  type PoolInsert,
  type TokenInsert,
  type TokenPerformanceInsert,
  type TokenPerformanceRow
} from "@assay/database";
import { createTestDatabase, type TestDatabaseHandle } from "@assay/database/testing";

import {
  parseReplayArgs,
  runJudgeReplay,
  selectReplayCandidates,
  type ReplaySelectionParams
} from "../src/judge-replay.js";

const CHAIN_ID = 7373;
const T0 = new Date("2026-03-01T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

let nextId = 1n;

function perfRow(
  poolAddress: string,
  overrides: Partial<TokenPerformanceRow> = {}
): TokenPerformanceRow {
  const id = nextId;
  nextId += 1n;
  return {
    id,
    chainId: CHAIN_ID,
    tokenAddress: `0xToken${id}`,
    poolAddress,
    horizonHours: 72,
    bandMinFdvUsd: "50000",
    bandMaxFdvUsd: "200000",
    enteredAt: T0,
    entryBlock: 1n,
    entryPriceUsd: "0.001",
    entryFdvUsd: "100000",
    maxMultipleBps: 15_000,
    maxDrawdownBps: 500,
    minutesToPeak: 60,
    snapshotsInWindow: 2,
    entryFeatures: {},
    labeledAt: T0,
    details: {},
    ...overrides
  };
}

describe("selectReplayCandidates", () => {
  it("matches horizon and the [from, to] entry window, sorted oldest-entry first", () => {
    const inWindowLate = perfRow("0xPool1", {
      horizonHours: 72,
      enteredAt: new Date(T0.getTime() + 2 * HOUR_MS)
    });
    const inWindowEarly = perfRow("0xPool2", { horizonHours: 72, enteredAt: T0 });
    const wrongHorizon = perfRow("0xPool3", { horizonHours: 168, enteredAt: T0 });
    const beforeWindow = perfRow("0xPool4", {
      horizonHours: 72,
      enteredAt: new Date(T0.getTime() - HOUR_MS)
    });
    const afterWindow = perfRow("0xPool5", {
      horizonHours: 72,
      enteredAt: new Date(T0.getTime() + 10 * HOUR_MS)
    });

    const params: ReplaySelectionParams = {
      horizonHours: 72,
      from: T0,
      to: new Date(T0.getTime() + 5 * HOUR_MS)
    };
    const selected = selectReplayCandidates(
      [inWindowLate, inWindowEarly, wrongHorizon, beforeWindow, afterWindow],
      [],
      params
    );
    expect(selected.map((row) => row.poolAddress)).toEqual(["0xPool2", "0xPool1"]);
  });

  it("excludes pools that already carry a REPLAY brief for the current prompt version", () => {
    const briefed = perfRow("0xPoolA", { horizonHours: 72, enteredAt: T0 });
    const unbriefed = perfRow("0xPoolB", { horizonHours: 72, enteredAt: T0 });
    const existingBriefs: Pick<JudgmentBriefRow, "poolAddress">[] = [{ poolAddress: "0xPoolA" }];

    const selected = selectReplayCandidates([briefed, unbriefed], existingBriefs, {
      horizonHours: 72
    });
    expect(selected.map((row) => row.poolAddress)).toEqual(["0xPoolB"]);
  });

  it("applies the limit after sorting", () => {
    const rows = [0, 1, 2].map((offset) =>
      perfRow(`0xPoolL${offset}`, {
        horizonHours: 72,
        enteredAt: new Date(T0.getTime() + offset * HOUR_MS)
      })
    );
    const selected = selectReplayCandidates(rows, [], { horizonHours: 72, limit: 2 });
    expect(selected.map((row) => row.poolAddress)).toEqual(["0xPoolL0", "0xPoolL1"]);
  });
});

describe("parseReplayArgs", () => {
  it("defaults to a 72h horizon and dryRun=false with no bounds", () => {
    expect(parseReplayArgs([])).toEqual({
      horizonHours: 72,
      from: undefined,
      to: undefined,
      limit: undefined,
      dryRun: false
    });
  });

  it("parses --horizon/--from/--to/--limit/--dry-run", () => {
    const args = parseReplayArgs([
      "--horizon=168",
      "--from=2026-01-01T00:00:00Z",
      "--to=2026-02-01T00:00:00Z",
      "--limit=5",
      "--dry-run"
    ]);
    expect(args.horizonHours).toBe(168);
    expect(args.from).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(args.to).toEqual(new Date("2026-02-01T00:00:00Z"));
    expect(args.limit).toBe(5);
    expect(args.dryRun).toBe(true);
  });

  it("rejects a non-positive --horizon", () => {
    expect(() => parseReplayArgs(["--horizon=0"])).toThrow();
  });

  it("rejects a non-integer --limit", () => {
    expect(() => parseReplayArgs(["--limit=1.5"])).toThrow();
  });
});

function poolFixture(poolAddress: string, overrides: Partial<PoolInsert> = {}): PoolInsert {
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

function tokenFixture(address: string, overrides: Partial<TokenInsert> = {}): TokenInsert {
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

function perfInsertFixture(
  tokenAddress: string,
  poolAddress: string,
  overrides: Partial<TokenPerformanceInsert> = {}
): TokenPerformanceInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress,
    poolAddress,
    horizonHours: 72,
    bandMinFdvUsd: "50000",
    bandMaxFdvUsd: "200000",
    enteredAt: T0,
    entryBlock: 1n,
    entryPriceUsd: "0.001",
    entryFdvUsd: "100000",
    maxMultipleBps: 18_000,
    maxDrawdownBps: 500,
    minutesToPeak: 60,
    snapshotsInWindow: 1,
    entryFeatures: {},
    details: {},
    ...overrides
  };
}

describe("runJudgeReplay (dry-run, PGlite)", () => {
  let handle: TestDatabaseHandle;
  let db: Db;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
  });

  afterEach(async () => {
    await handle.close();
  });

  it("hard-errors when llm config is missing and dryRun is not set", async () => {
    await expect(
      runJudgeReplay({ db, chainId: CHAIN_ID, horizonHours: 72, dryRun: false })
    ).rejects.toThrow(/LLM/);
  });

  it("generates and persists a COMPLETED REPLAY brief with verified citations for every selected candidate", async () => {
    const poolAddress = "0xReplayPool";
    const tokenAddress = "0xReplayToken";
    await insertPools(db, [poolFixture(poolAddress)]);
    await insertTokens(db, [tokenFixture(tokenAddress)]);
    await insertTokenPerformance(db, perfInsertFixture(tokenAddress, poolAddress));

    const result = await runJudgeReplay({ db, chainId: CHAIN_ID, horizonHours: 72, dryRun: true });

    expect(result.candidates).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.briefs).toHaveLength(1);
    expect(result.briefs[0]).toMatchObject({
      poolAddress,
      tokenAddress,
      status: "COMPLETED"
    });

    const stored = await listJudgmentBriefs(db, CHAIN_ID, { mode: "REPLAY" });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      alertId: null,
      evalRunId: null,
      mode: "REPLAY",
      status: "COMPLETED",
      model: "dry-run-fake-llm",
      promptName: "research-brief",
      promptVersion: 1
    });

    const citations = await listJudgmentCitations(db, stored[0]!.id);
    expect(citations.length).toBeGreaterThan(0);
    expect(citations.every((citation) => citation.verified)).toBe(true);
  });

  it("respects --limit and only replays pools inside [from, to]", async () => {
    for (const suffix of ["A", "B", "C"]) {
      const poolAddress = `0xLimitPool${suffix}`;
      const tokenAddress = `0xLimitToken${suffix}`;
      await insertPools(db, [poolFixture(poolAddress)]);
      await insertTokens(db, [tokenFixture(tokenAddress)]);
      await insertTokenPerformance(
        db,
        perfInsertFixture(tokenAddress, poolAddress, {
          enteredAt: new Date(T0.getTime() + (suffix.charCodeAt(0) - 65) * HOUR_MS)
        })
      );
    }

    const result = await runJudgeReplay({
      db,
      chainId: CHAIN_ID,
      horizonHours: 72,
      dryRun: true,
      limit: 1
    });
    expect(result.candidates).toBe(1);
    expect(result.briefs[0]!.poolAddress).toBe("0xLimitPoolA");
  });

  it("is idempotent: a second dry-run pass generates nothing new for an already-briefed pool", async () => {
    const poolAddress = "0xIdemPool";
    const tokenAddress = "0xIdemToken";
    await insertPools(db, [poolFixture(poolAddress)]);
    await insertTokens(db, [tokenFixture(tokenAddress)]);
    await insertTokenPerformance(db, perfInsertFixture(tokenAddress, poolAddress));

    const first = await runJudgeReplay({ db, chainId: CHAIN_ID, horizonHours: 72, dryRun: true });
    expect(first.briefs).toHaveLength(1);

    const second = await runJudgeReplay({ db, chainId: CHAIN_ID, horizonHours: 72, dryRun: true });
    expect(second.candidates).toBe(0);
    expect(second.briefs).toHaveLength(0);

    const stored = await listJudgmentBriefs(db, CHAIN_ID, { mode: "REPLAY" });
    expect(stored).toHaveLength(1);
  });
});
