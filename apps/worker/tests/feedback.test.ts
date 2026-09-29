import { describe, expect, it } from "vitest";

import type {
  AlertSentRow,
  OperatorDecisionRow,
  TokenOutcomeRow
} from "@assay/database";

import {
  buildFeedbackReport,
  classifyFeedbackQuadrant
} from "../src/feedback.js";

const CHAIN_ID = 4242;

function alertRow(overrides: Partial<AlertSentRow> = {}): AlertSentRow {
  return {
    id: 1n,
    chainId: CHAIN_ID,
    tokenAddress: "0xToken",
    poolAddress: "0xPool",
    alertLevel: "YELLOW",
    score: 80,
    sentAt: new Date("2024-01-01T00:00:00.000Z"),
    reason: "level increase",
    transport: "dry-run",
    delivered: true,
    ...overrides
  };
}

function decisionRow(
  overrides: Partial<OperatorDecisionRow> = {}
): OperatorDecisionRow {
  return {
    id: 1n,
    chainId: CHAIN_ID,
    tokenAddress: "0xToken",
    poolAddress: "0xPool",
    action: "ENTERED",
    reason: "clean holders",
    sizeUsd: null,
    priceUsd: null,
    recordedAt: new Date("2024-01-01T00:05:00.000Z"),
    ...overrides
  };
}

function outcomeRow(overrides: Partial<TokenOutcomeRow> = {}): TokenOutcomeRow {
  return {
    id: 1n,
    chainId: CHAIN_ID,
    tokenAddress: "0xToken",
    poolAddress: "0xPool",
    horizonHours: 24,
    outcome: "SURVIVED",
    peakQuoteLiquidityUsd: null,
    quoteLiquidityAtHorizonUsd: null,
    estimatedFdvAtHorizonUsd: null,
    firstObservedAt: new Date("2024-01-01T00:00:00.000Z"),
    labeledAt: new Date("2024-01-02T00:00:00.000Z"),
    details: {},
    ...overrides
  };
}

describe("classifyFeedbackQuadrant", () => {
  it("flags SYSTEM-HIT/OPERATOR-MISS when an ORANGE/RED alert survived with no ENTERED decision", () => {
    expect(
      classifyFeedbackQuadrant({
        alerts: [{ alertLevel: "YELLOW" }],
        decisions: [{ action: "PASSED" }],
        outcomes: [{ outcome: "SURVIVED" }],
        detectedTrades: []
      })
    ).toBe("SYSTEM-HIT/OPERATOR-MISS");
  });

  it("flags BAD-ENTRY when an ENTERED decision only ever DIED", () => {
    expect(
      classifyFeedbackQuadrant({
        alerts: [],
        decisions: [{ action: "ENTERED" }],
        outcomes: [{ outcome: "DIED" }],
        detectedTrades: []
      })
    ).toBe("BAD-ENTRY");
  });

  it("flags SYSTEM-MISS when a token survived without ever being alerted", () => {
    expect(
      classifyFeedbackQuadrant({
        alerts: [],
        decisions: [],
        outcomes: [{ outcome: "SURVIVED" }],
        detectedTrades: []
      })
    ).toBe("SYSTEM-MISS");
  });

  it("returns null for a token matching no quadrant", () => {
    expect(
      classifyFeedbackQuadrant({
        alerts: [{ alertLevel: "RED" }],
        decisions: [{ action: "WATCHING" }],
        outcomes: [],
        detectedTrades: []
      })
    ).toBeNull();
  });

  it("does not flag SYSTEM-HIT/OPERATOR-MISS once an ENTERED decision exists", () => {
    expect(
      classifyFeedbackQuadrant({
        alerts: [{ alertLevel: "GREEN" }],
        decisions: [{ action: "ENTERED" }],
        outcomes: [{ outcome: "SURVIVED" }],
        detectedTrades: []
      })
    ).toBeNull();
  });

  it("does not flag BAD-ENTRY once any outcome SURVIVED (falls through to SYSTEM-MISS since it was never alerted)", () => {
    expect(
      classifyFeedbackQuadrant({
        alerts: [{ alertLevel: "RED" }],
        decisions: [{ action: "ENTERED" }],
        outcomes: [{ outcome: "DIED" }, { outcome: "SURVIVED" }],
        detectedTrades: []
      })
    ).toBeNull();
  });

  it("does not flag SYSTEM-MISS once any alert was sent, even YELLOW", () => {
    expect(
      classifyFeedbackQuadrant({
        alerts: [{ alertLevel: "RED" }],
        decisions: [],
        outcomes: [{ outcome: "SURVIVED" }],
        detectedTrades: []
      })
    ).toBeNull();
  });

  it("does not flag SYSTEM-HIT/OPERATOR-MISS when a watched wallet's BUY was detected on-chain", () => {
    expect(
      classifyFeedbackQuadrant({
        alerts: [{ alertLevel: "GREEN" }],
        decisions: [],
        outcomes: [{ outcome: "SURVIVED" }],
        detectedTrades: [{ side: "BUY" }]
      })
    ).toBeNull();
  });

  it("flags BAD-ENTRY from a detected on-chain BUY alone, with no recorded decision", () => {
    expect(
      classifyFeedbackQuadrant({
        alerts: [{ alertLevel: "YELLOW" }],
        decisions: [],
        outcomes: [{ outcome: "DIED" }],
        detectedTrades: [{ side: "BUY" }, { side: "SELL" }]
      })
    ).toBe("BAD-ENTRY");
  });

  it("a detected SELL alone is not an entry", () => {
    expect(
      classifyFeedbackQuadrant({
        alerts: [{ alertLevel: "YELLOW" }],
        decisions: [],
        outcomes: [{ outcome: "SURVIVED" }],
        detectedTrades: [{ side: "SELL" }]
      })
    ).toBe("SYSTEM-HIT/OPERATOR-MISS");
  });
});

describe("buildFeedbackReport", () => {
  it("groups per token, classifies each quadrant, and drops tokens matching none", () => {
    const hitToken = "0xHit";
    const badEntryToken = "0xBad";
    const missToken = "0xMiss";
    const noneToken = "0xNone";

    const alerts: AlertSentRow[] = [
      alertRow({ id: 1n, tokenAddress: hitToken, alertLevel: "YELLOW", poolAddress: "0xPoolHit" }),
      alertRow({ id: 2n, tokenAddress: hitToken, alertLevel: "GREEN", poolAddress: "0xPoolHit" }),
      alertRow({ id: 3n, tokenAddress: noneToken, alertLevel: "RED", poolAddress: "0xPoolNone" })
    ];
    const decisions: OperatorDecisionRow[] = [
      decisionRow({
        id: 1n,
        tokenAddress: badEntryToken,
        action: "ENTERED",
        poolAddress: "0xPoolBad"
      }),
      decisionRow({
        id: 2n,
        tokenAddress: noneToken,
        action: "PASSED",
        poolAddress: null
      })
    ];
    const outcomes: TokenOutcomeRow[] = [
      outcomeRow({
        id: 1n,
        tokenAddress: hitToken,
        outcome: "SURVIVED",
        poolAddress: "0xPoolHit"
      }),
      outcomeRow({
        id: 2n,
        tokenAddress: badEntryToken,
        outcome: "DIED",
        poolAddress: "0xPoolBad"
      }),
      outcomeRow({
        id: 3n,
        tokenAddress: missToken,
        outcome: "SURVIVED",
        poolAddress: "0xPoolMiss"
      })
    ];

    const rows = buildFeedbackReport(alerts, decisions, outcomes);

    expect(rows.map((row) => row.tokenAddress)).toEqual([
      badEntryToken,
      hitToken,
      missToken
    ]);

    const hit = rows.find((row) => row.tokenAddress === hitToken);
    expect(hit).toMatchObject({
      quadrant: "SYSTEM-HIT/OPERATOR-MISS",
      poolAddresses: ["0xPoolHit"],
      alertLevels: ["GREEN", "YELLOW"],
      decisionActions: [],
      outcomes: ["SURVIVED"]
    });

    const badEntry = rows.find((row) => row.tokenAddress === badEntryToken);
    expect(badEntry).toMatchObject({
      quadrant: "BAD-ENTRY",
      poolAddresses: ["0xPoolBad"],
      alertLevels: [],
      decisionActions: ["ENTERED"],
      outcomes: ["DIED"]
    });

    const miss = rows.find((row) => row.tokenAddress === missToken);
    expect(miss).toMatchObject({
      quadrant: "SYSTEM-MISS",
      poolAddresses: ["0xPoolMiss"],
      alertLevels: [],
      decisionActions: [],
      outcomes: ["SURVIVED"]
    });

    expect(rows.some((row) => row.tokenAddress === noneToken)).toBe(false);
  });

  it("folds detected wallet trades into entry classification and surfaces their sides", () => {
    const token = "0xDetected";
    const rows = buildFeedbackReport(
      [alertRow({ id: 1n, tokenAddress: token, alertLevel: "YELLOW", poolAddress: "0xPoolD" })],
      [],
      [outcomeRow({ id: 1n, tokenAddress: token, outcome: "DIED", poolAddress: "0xPoolD" })],
      [
        { tokenAddress: token, poolAddress: "0xPoolD", side: "BUY", observedAt: new Date(0) },
        { tokenAddress: token, poolAddress: "0xPoolD", side: "SELL", observedAt: new Date(1) }
      ]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tokenAddress: token,
      quadrant: "BAD-ENTRY",
      decisionActions: [],
      detectedTradeSides: ["BUY", "SELL"]
    });
  });
});
