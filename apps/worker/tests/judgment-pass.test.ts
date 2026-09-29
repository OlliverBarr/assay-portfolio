import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDryRunTransport
} from "@assay/alerts";
import {
  getJudgmentBriefByAlert,
  insertAlertSent,
  insertPools,
  insertPoolSnapshots,
  insertTokens,
  listJudgmentCitations,
  listJudgmentToolCalls,
  listPoolSnapshots,
  type AlertSentInsert,
  type Db,
  type PoolInsert,
  type PoolSnapshotInsert,
  type TokenInsert
} from "@assay/database";
import {
  createTestDatabase,
  type TestDatabaseHandle
} from "@assay/database/testing";
import {
  briefPromptSpecV1,
  createFakeLlmClient,
  type FakeLlmStep,
  type JudgmentBriefPayload
} from "@assay/judgment";

import { loadJudgmentConfigFromEnv, WorkerConfigError } from "../src/config.js";
import {
  formatBriefMessage,
  runJudgmentPass,
  type JudgmentPassOptions
} from "../src/judgment-pass.js";

const CHAIN_ID = 8181;
const POOL = "0x1111111111111111111111111111111111111111";
const BASE = "0x3333333333333333333333333333333333333333";
const QUOTE = "0x4444444444444444444444444444444444444444";
const HOUR_MS = 60 * 60 * 1000;
const SNAPSHOT_PRICE_USD = "0.001";

function poolInsert(overrides: Partial<PoolInsert> = {}): PoolInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress: POOL,
    factoryAddress: "0x2222222222222222222222222222222222222222",
    dex: "uniswap",
    factoryKind: "uniswap-v2",
    token0Address: BASE,
    token1Address: QUOTE,
    quoteTokenAddress: QUOTE,
    baseTokenAddress: BASE,
    createdAtBlock: 100n,
    createdTxHash: `0x${"ab".repeat(32)}`,
    createdLogIndex: 0,
    ...overrides
  };
}

function tokenInsert(overrides: Partial<TokenInsert> = {}): TokenInsert {
  return {
    chainId: CHAIN_ID,
    address: BASE,
    firstSeenBlock: 100n,
    ...overrides
  };
}

function snapshotInsert(
  capturedAt: Date,
  overrides: Partial<PoolSnapshotInsert> = {}
): PoolSnapshotInsert {
  return {
    chainId: CHAIN_ID,
    poolAddress: POOL,
    blockNumber: 100n,
    capturedAt,
    calculationMethod: "v2-reserves",
    priceUsd: SNAPSHOT_PRICE_USD,
    estimatedFdvUsd: "100000",
    quoteLiquidityUsd: "50000",
    totalLiquidityUsd: "100000",
    ...overrides
  };
}

function alertInsert(overrides: Partial<AlertSentInsert> = {}): AlertSentInsert {
  return {
    chainId: CHAIN_ID,
    tokenAddress: BASE,
    poolAddress: POOL,
    alertLevel: "YELLOW",
    score: 80,
    reason: "test alert",
    transport: "dry-run",
    delivered: true,
    ...overrides
  };
}

/** A schema-valid brief payload citing `snapshotId`'s `priceUsd` field. */
function buildPayload(
  snapshotId: bigint,
  overrides: {
    thesisClaimedValue?: string;
    riskClaimedValue?: string;
  } = {}
): JudgmentBriefPayload {
  const evidencePointer = (claimedValue: string) => [
    { table: "pool_snapshots", rowId: snapshotId.toString(), field: "priceUsd", claimedValue }
  ];
  return {
    thesis: "Liquidity looks stable relative to FDV at entry.",
    thesisEvidence: evidencePointer(overrides.thesisClaimedValue ?? SNAPSHOT_PRICE_USD),
    confidenceBps: 6000,
    riskCalls: [
      {
        risk: "LP could be pulled quickly given concentration.",
        tag: "RUG_LP_PULL",
        severity: "MEDIUM",
        evidence: evidencePointer(overrides.riskClaimedValue ?? SNAPSHOT_PRICE_USD)
      },
      {
        risk: "Holder concentration could trigger a dump.",
        tag: "CONCENTRATION_DUMP",
        severity: "LOW",
        evidence: evidencePointer(SNAPSHOT_PRICE_USD)
      },
      {
        risk: "No follow-through demand observed yet.",
        tag: "NO_FOLLOW_THROUGH",
        severity: "LOW",
        evidence: evidencePointer(SNAPSHOT_PRICE_USD)
      }
    ],
    disconfirming: [],
    whatWouldChangeThisCall: ["A second wave of unique wallet inflows within the hour."],
    recommendation: "WATCH"
  };
}

function fakeLlmStep(payload: JudgmentBriefPayload): FakeLlmStep {
  return { content: JSON.stringify(payload) };
}

describe("runJudgmentPass", () => {
  let handle: TestDatabaseHandle;
  let db: Db;
  let snapshotId: bigint;
  let sent: string[];

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    sent = [];
    await insertPools(db, [poolInsert()]);
    await insertTokens(db, [tokenInsert()]);
    await insertPoolSnapshots(db, [
      snapshotInsert(new Date(Date.now() - 2 * HOUR_MS))
    ]);
    const [snapshot] = await listPoolSnapshots(db, CHAIN_ID, POOL);
    if (snapshot === undefined) throw new Error("fixture snapshot missing");
    snapshotId = snapshot.id;
  });

  afterEach(async () => {
    await handle.close();
  });

  function options(
    steps: readonly FakeLlmStep[],
    overrides: Partial<JudgmentPassOptions> = {}
  ): JudgmentPassOptions {
    return {
      db,
      chainId: CHAIN_ID,
      llm: createFakeLlmClient(steps),
      model: "test-model",
      prompt: briefPromptSpecV1(),
      transport: createDryRunTransport((text) => sent.push(text)),
      minAlertLevel: "YELLOW",
      batchLimit: 5,
      maxToolRounds: 8,
      timeoutMs: 5_000,
      rebriefCooldownMs: 0,
      ...overrides
    };
  }

  it("generates, persists, and delivers a COMPLETED brief", async () => {
    const alert = await insertAlertSent(db, alertInsert());
    const payload = buildPayload(snapshotId);

    const result = await runJudgmentPass(options([fakeLlmStep(payload)]));

    expect(result.alertsConsidered).toBe(1);
    expect(result.briefsCompleted).toBe(1);
    expect(result.briefsFailed).toBe(0);
    expect(result.briefsRejected).toBe(0);
    expect(result.briefsSkipped).toBe(0);
    expect(result.delivered).toBe(1);
    expect(result.briefErrors).toEqual([]);

    const brief = await getJudgmentBriefByAlert(db, alert.id);
    expect(brief?.status).toBe("COMPLETED");
    expect(brief?.delivery).toBe("SENT");
    expect(brief?.mode).toBe("LIVE");
    expect(brief?.citationsTotal).toBe(4);
    expect(brief?.citationsVerified).toBe(4);

    const citations = await listJudgmentCitations(db, brief!.id);
    expect(citations).toHaveLength(4);
    expect(citations.every((c) => c.verified)).toBe(true);

    const toolCalls = await listJudgmentToolCalls(db, brief!.id);
    expect(toolCalls).toHaveLength(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("advisory");
    expect(sent[0]).toContain("Citations verified: 4/4");
    for (const banned of ["buy", "sell", "ape", "long", "short"]) {
      expect(sent[0]?.toLowerCase()).not.toContain(banned);
    }
  });

  it("is idempotent: a second pass does not re-brief or re-deliver", async () => {
    await insertAlertSent(db, alertInsert());
    const payload = buildPayload(snapshotId);

    const first = await runJudgmentPass(options([fakeLlmStep(payload)]));
    expect(first.briefsCompleted).toBe(1);
    expect(sent).toHaveLength(1);

    const second = await runJudgmentPass(options([fakeLlmStep(payload)]));
    expect(second.alertsConsidered).toBe(0);
    expect(second.briefsCompleted).toBe(0);
    expect(second.delivered).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("persists a REJECTED_FABRICATED_CITATION brief but never delivers it", async () => {
    const alert = await insertAlertSent(db, alertInsert());
    // A load-bearing citation (riskCalls[0]) claims a value the source row
    // never had — the fabrication the citation checker exists to catch.
    const payload = buildPayload(snapshotId, { riskClaimedValue: "9.999" });

    const result = await runJudgmentPass(options([fakeLlmStep(payload)]));

    expect(result.briefsCompleted).toBe(0);
    expect(result.briefsRejected).toBe(1);
    expect(result.delivered).toBe(0);
    expect(sent).toHaveLength(0);

    const brief = await getJudgmentBriefByAlert(db, alert.id);
    expect(brief?.status).toBe("REJECTED_FABRICATED_CITATION");
    expect(brief?.delivery).toBe("SKIPPED");
  });

  it("records FAILED when the LLM throws, and continues to the next alert", async () => {
    const alertA = await insertAlertSent(db, alertInsert({ tokenAddress: BASE, poolAddress: POOL }));
    await insertPools(db, [poolInsert({ poolAddress: `0x${"5".repeat(40)}`, baseTokenAddress: `0x${"6".repeat(40)}`, token0Address: `0x${"6".repeat(40)}` })]);
    await insertTokens(db, [tokenInsert({ address: `0x${"6".repeat(40)}` })]);
    await insertPoolSnapshots(db, [
      snapshotInsert(new Date(Date.now() - 2 * HOUR_MS), { poolAddress: `0x${"5".repeat(40)}` })
    ]);
    const alertB = await insertAlertSent(
      db,
      alertInsert({ tokenAddress: `0x${"6".repeat(40)}`, poolAddress: `0x${"5".repeat(40)}` })
    );

    // Empty script: every llm.complete() call throws LlmClientError, which
    // `generateBrief` catches internally and turns into a FAILED brief — it
    // never escapes as an exception, so both alerts are still processed.
    const result = await runJudgmentPass(options([]));

    expect(result.alertsConsidered).toBe(2);
    expect(result.briefsFailed).toBe(2);
    expect(result.briefsCompleted).toBe(0);
    expect(result.delivered).toBe(0);
    expect(result.briefErrors).toEqual([]);
    expect(sent).toHaveLength(0);

    const briefA = await getJudgmentBriefByAlert(db, alertA.id);
    const briefB = await getJudgmentBriefByAlert(db, alertB.id);
    expect(briefA?.status).toBe("FAILED");
    expect(briefA?.delivery).toBe("SKIPPED");
    expect(briefA?.error).not.toBeNull();
    expect(briefB?.status).toBe("FAILED");
  });

  it("is a no-op when no alert meets the configured minimum level", async () => {
    await insertAlertSent(db, alertInsert({ alertLevel: "RED" }));

    const result = await runJudgmentPass(options([], { minAlertLevel: "GREEN" }));

    expect(result.alertsConsidered).toBe(0);
    expect(result.briefsCompleted).toBe(0);
    expect(result.delivered).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("stops between alerts once the signal is aborted, using the merged timeout+loop signal", async () => {
    const otherPool = `0x${"7".repeat(40)}`;
    const otherToken = `0x${"8".repeat(40)}`;
    await insertPools(db, [poolInsert({ poolAddress: otherPool, baseTokenAddress: otherToken, token0Address: otherToken })]);
    await insertTokens(db, [tokenInsert({ address: otherToken })]);
    await insertPoolSnapshots(db, [
      snapshotInsert(new Date(Date.now() - 2 * HOUR_MS), { poolAddress: otherPool })
    ]);
    await insertAlertSent(db, alertInsert());
    await insertAlertSent(db, alertInsert({ tokenAddress: otherToken, poolAddress: otherPool }));

    const controller = new AbortController();
    const payload = buildPayload(snapshotId);
    // Aborts as soon as the first alert's tool loop calls the LLM, so the
    // pass must stop before starting the second alert — the merged
    // AbortSignal.any([timeout, loop signal]) has to actually observe it.
    const llm = createFakeLlmClient([fakeLlmStep(payload)]);
    const originalComplete = llm.complete.bind(llm);
    llm.complete = (request, signal) => {
      controller.abort();
      return originalComplete(request, signal);
    };

    const result = await runJudgmentPass(
      options([], { llm, signal: controller.signal })
    );

    expect(result.stopped).toBe(true);
    expect(result.alertsConsidered).toBe(2);
    expect(result.briefsCompleted + result.briefsFailed + result.briefsRejected).toBe(1);
  });
});

describe("formatBriefMessage", () => {
  const briefBundle = () => ({
    chainId: CHAIN_ID,
    mode: "LIVE" as const,
    asOf: new Date(),
    alert: null,
    token: { address: BASE, decimals: null, totalSupply: null, deployerAddress: null, deployerStatus: null, name: { text: "Kermit <b>", provenance: "ATTACKER_STRING" as const }, symbol: { text: "KMT", provenance: "ATTACKER_STRING" as const } },
    pool: { address: POOL, dex: "uniswap", kind: "uniswap-v2", createdAtBlock: "100", discoveredAt: new Date(), quoteTokenAddress: QUOTE },
    marketSeries: [],
    activity: null,
    holders: null,
    risk: null,
    simulation: null
  });

  it("labels the message advisory, reports verified citation count, and avoids trading language", () => {
    const payload = buildPayload(1n);
    const citationReport = {
      checks: [],
      total: 4,
      verified: 3,
      loadBearingFailures: 1,
      verdict: "OK" as const
    };

    const message = formatBriefMessage(briefBundle(), payload, citationReport);

    expect(message).toContain("advisory");
    expect(message).toContain("Citations verified: 3/4");
    expect(message).toContain(`CA: <code>${BASE}</code>`);
    // Identity is not repeated: the alert directly above carries name/symbol.
    expect(message).not.toContain("Kermit");
    expect(message).not.toContain("<b>");
    // Risks capped to top 2: the third risk call is dropped.
    expect(message).toContain("RUG_LP_PULL");
    expect(message).toContain("CONCENTRATION_DUMP");
    expect(message).not.toContain("NO_FOLLOW_THROUGH");
    // "What would change this call" is rendered.
    expect(message).toContain("What would change this call:");
    expect(message).toContain("A second wave of unique wallet inflows within the hour.");
    // Pool address deliberately not displayed.
    expect(message).not.toContain(POOL);
    for (const banned of ["buy", "sell", "ape", "long", "short"]) {
      expect(message.toLowerCase()).not.toContain(banned);
    }
  });

  it("emits sections in the documented order, dropping empty ones and capped items", () => {
    const message = formatBriefMessage(briefBundle(), buildPayload(1n), {
      checks: [],
      total: 4,
      verified: 3,
      loadBearingFailures: 1,
      verdict: "OK" as const
    });

    // Disconfirming section absent (empty array); 3rd risk call dropped.
    expect(message.split("\n")).toEqual([
      "🔬 Research brief (advisory)",
      `CA: <code>${BASE}</code>`,
      "Recommendation: WATCH · Confidence: 60.0%",
      "Thesis: Liquidity looks stable relative to FDV at entry.",
      "Top risks:",
      "⚠ [RUG_LP_PULL/MEDIUM] LP could be pulled quickly given concentration.",
      "⚠ [CONCENTRATION_DUMP/LOW] Holder concentration could trigger a dump.",
      "What would change this call:",
      "- A second wave of unique wallet inflows within the hour.",
      "Citations verified: 3/4",
      "Advisory research only, not trading instructions — the human decides."
    ]);
  });
});

describe("loadJudgmentConfigFromEnv", () => {
  it("is disabled when neither LLM_API_KEY nor JUDGMENT_MODEL are set", () => {
    const config = loadJudgmentConfigFromEnv({});
    expect(config.enabled).toBe(false);
    expect(config.llm).toBeUndefined();
    expect(config.minAlertLevel).toBe("YELLOW");
  });

  it("hard-errors on partial LLM config", () => {
    expect(() => loadJudgmentConfigFromEnv({ LLM_API_KEY: "sk-test" })).toThrow(WorkerConfigError);
    expect(() => loadJudgmentConfigFromEnv({ JUDGMENT_MODEL: "gpt-5" })).toThrow(WorkerConfigError);
  });

  it("is enabled with an llm config when both are set", () => {
    const config = loadJudgmentConfigFromEnv({
      LLM_API_KEY: "sk-test",
      JUDGMENT_MODEL: "gpt-5"
    });
    expect(config.enabled).toBe(true);
    expect(config.llm).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-5"
    });
  });

  it("rejects an unknown JUDGMENT_MIN_ALERT_LEVEL", () => {
    expect(() =>
      loadJudgmentConfigFromEnv({ JUDGMENT_MIN_ALERT_LEVEL: "PURPLE" })
    ).toThrow(WorkerConfigError);
  });
});
