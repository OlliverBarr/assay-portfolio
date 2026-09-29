import { describe, expect, it } from "vitest";

import type {
  PoolActivitySnapshotRow,
  PoolRow,
  PoolSnapshotRow,
  TokenHolderSnapshotRow,
  TokenRiskRow
} from "@assay/database";

import { buildEntryFeatures } from "../src/performance-pass.js";
import {
  attributeCoverageTier,
  computeSustained,
  formatWinnersDigest,
  parseEntryFeatures,
  replayCandidateFeatures,
  type DigestItem,
  type GateAttribution,
  type SnapshotPoint,
  type TierInputs
} from "../src/winners-retro.js";

const MIN_MS = 60 * 1000;
const ENTRY_AT = new Date("2026-07-01T00:00:00.000Z");

function point(minutesFromEntry: number, fdv: string | null, liq: string | null): SnapshotPoint {
  return {
    capturedAt: new Date(ENTRY_AT.getTime() + minutesFromEntry * MIN_MS),
    estimatedFdvUsd: fdv,
    quoteLiquidityUsd: liq
  };
}

describe("computeSustained", () => {
  it("reports sustained below the wick when the peak is an unconfirmed single-snapshot wick", () => {
    const points = [
      point(0, "100000", "20000"), // entry, bucket 0
      point(5, "105000", "21000"), // bucket 0 second reading -> bucket 0 valid, value 100000
      point(20, "1000000", "5000") // lone wick in bucket 1 -> invalid, contributes nothing
    ];
    const wickMultipleBps = 100_000; // stored maxMultipleBps: 10x, from the wick alone
    const result = computeSustained(points, ENTRY_AT, "100000", wickMultipleBps);

    expect(result.wickMultipleBps).toBe(100_000);
    expect(result.sustainedMultipleBps).toBe(10_000); // 1x: only bucket 0 (value 100000) is confirmed
    expect(result.sustainedMultipleBps).toBeLessThan(result.wickMultipleBps);
    expect(result.exitQuoteLiquidityUsd).toBe("21000"); // last snapshot in bucket 0
    expect(result.minutesToSustainedPeak).toBe(5);
  });

  it("matches the wick multiple when the peak level holds across a full 15-minute bucket", () => {
    const points = [
      point(0, "100000", "9000"), // entry, alone in bucket 0 (invalid, irrelevant)
      point(16, "500000", "30000"), // bucket 1, first reading at the peak level
      point(20, "500000", "32000") // bucket 1, second reading at the same level -> valid
    ];
    const wickMultipleBps = 50_000; // stored max was the same 500000 peak: 5x
    const result = computeSustained(points, ENTRY_AT, "100000", wickMultipleBps);

    expect(result.sustainedMultipleBps).toBe(50_000);
    expect(result.sustainedMultipleBps).toBe(result.wickMultipleBps);
    expect(result.minutesToSustainedPeak).toBe(20);
  });

  it("reads exit liquidity from the peak bucket's last snapshot and ignores null-FDV readings entirely", () => {
    const points = [
      point(0, "100000", "1000"), // entry, alone in bucket 0
      point(16, "500000", "10000"), // bucket 1, reading A
      point(18, null, "99999"), // bucket 1, null FDV — must not count or be picked as "last"
      point(20, "500000", "12000") // bucket 1, reading B, chronologically last valued snapshot
    ];
    const result = computeSustained(points, ENTRY_AT, "100000", 50_000);

    expect(result.sustainedMultipleBps).toBe(50_000); // bucket 1 still valid: 2 non-null readings
    expect(result.exitQuoteLiquidityUsd).toBe("12000");
    expect(result.minutesToSustainedPeak).toBe(20);
  });

  it("does not let a null-FDV snapshot pad a bucket's validity count", () => {
    const points = [
      point(0, "100000", "1000"), // entry, alone in bucket 0 -> invalid, irrelevant
      point(20, "500000", "8000"), // bucket 1's only VALUED reading
      point(22, null, "9999") // bucket 1, null FDV: if miscounted, would fake a 2nd confirming reading
    ];
    // If nulls counted toward the >=2 threshold, bucket 1 would look valid (2 total
    // snapshots) and report a 500000 sustained peak. Since nulls are excluded before
    // bucketing, bucket 1 has only 1 real reading and stays a wick -> zero fallback.
    const result = computeSustained(points, ENTRY_AT, "100000", 50_000);
    expect(result.sustainedMultipleBps).toBe(0);
    expect(result.exitQuoteLiquidityUsd).toBeNull();
    expect(result.minutesToSustainedPeak).toBeNull();
  });

  it("falls back to zero sustained gain when no bucket ever gets a confirming second reading", () => {
    const points = [point(0, "100000", "1000"), point(20, "9000000", "2000")];
    const result = computeSustained(points, ENTRY_AT, "100000", 900_000);

    expect(result.sustainedMultipleBps).toBe(0);
    expect(result.exitQuoteLiquidityUsd).toBeNull();
    expect(result.minutesToSustainedPeak).toBeNull();
    expect(result.wickMultipleBps).toBe(900_000); // wick is still carried through for contrast
  });
});

function gateAttribution(overrides: Partial<GateAttribution> = {}): GateAttribution {
  return {
    source: "shadow",
    eligible: true,
    failedRules: [],
    softFailedRules: [],
    score: 80,
    alertLevel: "RED",
    floor: 50,
    ...overrides
  };
}

function tierInputs(overrides: Partial<TierInputs> = {}): TierInputs {
  return {
    trustedQuote: true,
    hadSnapshots: true,
    attribution: gateAttribution(),
    alerted: true,
    ...overrides
  };
}

describe("attributeCoverageTier", () => {
  it("enforces ladder precedence: untrusted beats gated beats below-floor beats caught", () => {
    const untrustedButOtherwiseGated = attributeCoverageTier(
      tierInputs({
        trustedQuote: false,
        attribution: gateAttribution({ eligible: false, score: 10, alertLevel: "GRAY" }),
        alerted: true
      })
    );
    expect(untrustedButOtherwiseGated).toEqual({ tier: 2, label: "no-trusted-quote" });

    const gatedButBelowFloorAndAlerted = attributeCoverageTier(
      tierInputs({
        attribution: gateAttribution({ eligible: false, failedRules: ["minQuoteLiquidity"], score: 10 }),
        alerted: true
      })
    );
    expect(gatedButBelowFloorAndAlerted).toEqual({ tier: 5, label: "hard-gated" });

    const belowFloorButAlerted = attributeCoverageTier(
      tierInputs({
        attribution: gateAttribution({ eligible: true, score: 30, floor: 50 }),
        alerted: true
      })
    );
    expect(belowFloorButAlerted).toEqual({ tier: 6, label: "below-floor" });

    const caught = attributeCoverageTier(
      tierInputs({ attribution: gateAttribution({ eligible: true, score: 80, floor: 50 }), alerted: true })
    );
    expect(caught).toEqual({ tier: 7, label: "caught" });
  });

  it("attributes T3 when no snapshots existed before the sustained peak", () => {
    const result = attributeCoverageTier(tierInputs({ hadSnapshots: false }));
    expect(result).toEqual({ tier: 3, label: "enriched-late" });
  });

  it("attributes T4 when neither a shadow row nor a replay could be assembled", () => {
    const result = attributeCoverageTier(
      tierInputs({ attribution: gateAttribution({ source: "none", eligible: null, score: null, alertLevel: null }) })
    );
    expect(result).toEqual({ tier: 4, label: "signals-missing" });
  });

  it("attributes T6 for a GRAY classification even when the raw score clears the floor", () => {
    const result = attributeCoverageTier(
      tierInputs({ attribution: gateAttribution({ eligible: true, score: 90, floor: 50, alertLevel: "GRAY" }) })
    );
    expect(result).toEqual({ tier: 6, label: "below-floor" });
  });
});

// ---------------------------------------------------------------------------
// parseEntryFeatures / replayCandidateFeatures — the write/read shape contract
// ---------------------------------------------------------------------------

const ENTRY_SNAPSHOT = {
  capturedAt: new Date("2026-07-01T00:42:00.000Z"),
  quoteLiquidityUsd: "30000",
  totalLiquidityUsd: "60000"
} as PoolSnapshotRow;

const POOL = { discoveredAt: new Date("2026-07-01T00:00:00.000Z") } as PoolRow;

const ACTIVITY = {
  uniqueBuyers20m: 40,
  uniqueBuyers1h: 60,
  buyCount20m: 80,
  sellCount20m: 20,
  quoteBuyVolumeRaw20m: "3000000000000000000",
  quoteSellVolumeRaw20m: "1000000000000000000",
  buySizeGiniBps: 4_000,
  buySizeEntropyBps: 7_000,
  repeatedSizeBuyPctBps: 500
} as PoolActivitySnapshotRow;

const HOLDER = {
  floatBps: 8_000,
  supplyInPoolBps: 6_000,
  adjustedTop10PctBps: 2_500,
  deployerPctBps: 300,
  holderCount: 300,
  adjustedHolderCount: 250,
  largestHolderPctBps: 800,
  holderClusterScoreBps: 100
} as TokenHolderSnapshotRow;

const RISK = {
  status: "PASS",
  simulationStatus: "PASS",
  effectiveSellLossBps: 200,
  isProxy: false,
  verificationStatus: "VERIFIED",
  permissionFindings: [
    { kind: "mint", state: "ABSENT", matchedSelectors: [] },
    { kind: "pause", state: "UNKNOWN", matchedSelectors: [] }
  ]
} as unknown as TokenRiskRow;

const IDENTITY = {
  chainId: 4242,
  tokenAddress: "0xtoken",
  poolAddress: "0xpool",
  entryBlock: 123_456_789n,
  enteredAt: new Date("2026-07-01T00:42:00.000Z"),
  entryPriceUsd: "0.0015",
  entryFdvUsd: "150000"
};

/** Simulates the jsonb write/read cycle: what Postgres hands back to the retro. */
function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("parseEntryFeatures", () => {
  it("round-trips buildEntryFeatures output through jsonb — the cross-file shape contract", () => {
    const written = buildEntryFeatures(ENTRY_SNAPSHOT, POOL, ACTIVITY, HOLDER, RISK);
    expect(parseEntryFeatures(jsonRoundTrip(written))).toEqual(written);
  });

  it("round-trips the all-sources-absent vector (every nullable field null)", () => {
    const written = buildEntryFeatures(ENTRY_SNAPSHOT, POOL, undefined, undefined, undefined);
    expect(written.uniqueBuyers20m).toBeNull();
    expect(written.criticalPermissionPresent).toBeNull();
    expect(written.verificationStatus).toBeNull();
    expect(parseEntryFeatures(jsonRoundTrip(written))).toEqual(written);
  });

  it("derives criticalPermissionPresent from PRESENT critical findings", () => {
    const risky = {
      ...RISK,
      permissionFindings: [{ kind: "mint", state: "PRESENT", matchedSelectors: ["0x40c10f19"] }]
    } as TokenRiskRow;
    const written = buildEntryFeatures(ENTRY_SNAPSHOT, POOL, ACTIVITY, HOLDER, risky);
    expect(written.criticalPermissionPresent).toBe(true);
  });

  it("returns null for garbage and for the pre-gate-input legacy shape (stays tier 4)", () => {
    expect(parseEntryFeatures(null)).toBeNull();
    expect(parseEntryFeatures("not an object")).toBeNull();
    expect(parseEntryFeatures([])).toBeNull();
    expect(parseEntryFeatures({})).toBeNull();
    // The 15-field shape written before 2026-07-15 lacks the gate inputs
    // (criticalPermissionPresent, 20m activity, verificationStatus); it must
    // NOT parse — defaulting those would fabricate a gate decision.
    const legacy = {
      quoteLiquidityUsd: "30000",
      totalLiquidityUsd: "60000",
      ageMinutesAtEntry: 42,
      uniqueBuyers1h: 60,
      buySizeGiniBps: 4_000,
      buySizeEntropyBps: 7_000,
      repeatedSizeBuyPctBps: 500,
      floatBps: 8_000,
      supplyInPoolBps: 6_000,
      adjustedTop10PctBps: 2_500,
      deployerPctBps: 300,
      adjustedHolderCount: 250,
      riskStatus: "PASS",
      simulationStatus: "PASS",
      effectiveSellLossBps: 200
    };
    expect(parseEntryFeatures(legacy)).toBeNull();
  });

  it("returns null on a wrong-typed field rather than replaying a corrupted vector", () => {
    const written = jsonRoundTrip(
      buildEntryFeatures(ENTRY_SNAPSHOT, POOL, ACTIVITY, HOLDER, RISK)
    ) as Record<string, unknown>;
    expect(parseEntryFeatures({ ...written, riskStatus: "BOGUS" })).toBeNull();
    expect(parseEntryFeatures({ ...written, uniqueBuyers20m: "40" })).toBeNull();
    expect(parseEntryFeatures({ ...written, criticalPermissionPresent: "false" })).toBeNull();
  });
});

describe("replayCandidateFeatures", () => {
  it("maps identity from the token_performance row and features from the stored vector", () => {
    const entry = buildEntryFeatures(ENTRY_SNAPSHOT, POOL, ACTIVITY, HOLDER, RISK);
    const features = replayCandidateFeatures(IDENTITY, entry);

    expect(features.chainId).toBe(4242);
    expect(features.blockNumber).toBe(123_456_789n);
    expect(features.capturedAt).toEqual(IDENTITY.enteredAt);
    expect(features.tokenAgeMinutes).toBe(42);
    expect(features.priceUsd).toBe("0.0015");
    expect(features.estimatedFdvUsd).toBe("150000");
    expect(features.uniqueBuyers20m).toBe(40);
    expect(features.hasActivity).toBe(true);
    expect(features.simulationStatus).toBe("PASS");
    expect(features.criticalPermissionPresent).toBe(false);
    expect(features.verificationStatus).toBe("VERIFIED");
    expect(features.hasRisk).toBe(true);
    expect(features.adjustedTop10PctBps).toBe(2_500);
  });

  it("mirrors assembleCandidate's missing-source defaults: 0 buyers, UNKNOWN statuses, no critical permission", () => {
    const entry = buildEntryFeatures(ENTRY_SNAPSHOT, POOL, undefined, undefined, undefined);
    const features = replayCandidateFeatures(IDENTITY, entry);

    expect(features.uniqueBuyers20m).toBe(0);
    expect(features.uniqueBuyers1h).toBe(0);
    expect(features.quoteBuyVolumeRaw20m).toBe("0");
    expect(features.hasActivity).toBe(false);
    expect(features.riskStatus).toBe("UNKNOWN");
    expect(features.simulationStatus).toBe("UNKNOWN");
    expect(features.criticalPermissionPresent).toBe(false);
    expect(features.verificationStatus).toBe("UNKNOWN");
    expect(features.hasRisk).toBe(false);
  });

  it("nulls the fields the retro cannot honestly reconstruct as-of entry", () => {
    const entry = buildEntryFeatures(ENTRY_SNAPSHOT, POOL, ACTIVITY, HOLDER, RISK);
    const features = replayCandidateFeatures(IDENTITY, entry);

    expect(features.peakQuoteLiquidityUsd).toBeNull();
    expect(features.liquidityCollapsed).toBeNull();
    expect(features.sellSlippageCurve).toBeNull();
    expect(features.deployerTokenCount).toBeNull();
    expect(features.earlyBuyerRetentionBps).toBeNull();
    expect(features.cohortSize).toBeNull();
  });
});

function digestItem(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    tokenAddress: "0xdeadbeef",
    tokenSymbol: "TOKN",
    sustainedMultipleBps: 82_000,
    exitQuoteLiquidityUsd: "40000",
    tier: 5,
    tierLabel: "hard-gated",
    detail: "minQuoteLiquidity",
    provisional: true,
    ...overrides
  };
}

describe("formatWinnersDigest", () => {
  it("escapes a hostile token symbol so it can never inject Telegram HTML markup", () => {
    const hostile = '<b>PUMP</b>&"\'';
    const digest = formatWinnersDigest({
      date: new Date("2026-07-11T00:00:00.000Z"),
      items: [digestItem({ tokenSymbol: hostile })],
      untrustedPoolCount: 1,
      tierTotals: new Map([[5, 1]])
    });
    expect(digest).not.toContain("<b>PUMP</b>");
    expect(digest).toContain("&lt;b&gt;PUMP&lt;/b&gt;&amp;");
  });

  it("renders the 0-item case with an explicit empty state and 0-item counts", () => {
    const digest = formatWinnersDigest({
      date: new Date("2026-07-11T00:00:00.000Z"),
      items: [],
      untrustedPoolCount: 0,
      tierTotals: new Map()
    });
    expect(digest).toContain("(n=0 new; provisional 24h)");
    expect(digest).toContain("No new winners this pass.");
    expect(digest).toContain("👻 0 pools launched without a trusted quote");
    expect(digest).toContain("(none)");
    expect(digest).toContain("n=0 small — anecdotes, not signal.");
  });

  it("renders a 3-item digest with per-item lines, tier totals, and the census/caveat", () => {
    const items = [
      digestItem({ tokenSymbol: "LEAK5", tier: 5, tierLabel: "hard-gated", detail: "minQuoteLiquidity" }),
      digestItem({ tokenSymbol: "LEAK6", tier: 6, tierLabel: "below-floor", detail: "score 30 < floor 50" }),
      digestItem({ tokenSymbol: "CAUGHT7", tier: 7, tierLabel: "caught", detail: "", provisional: false })
    ];
    const digest = formatWinnersDigest({
      date: new Date("2026-07-11T00:00:00.000Z"),
      items,
      untrustedPoolCount: 4,
      tierTotals: new Map([
        [5, 1],
        [6, 1],
        [7, 1]
      ])
    });

    expect(digest).toContain("(n=3 new; provisional 24h)");
    expect(digest.match(/•/g)).toHaveLength(3);
    expect(digest).toContain("LEAK5");
    expect(digest).toContain("LEAKED T5 hard-gated: minQuoteLiquidity");
    expect(digest).toContain("LEAKED T6 below-floor: score 30 &lt; floor 50");
    expect(digest).toContain("CAUGHT7 <code>0xdeadbeef</code> 8.2x — CAUGHT");
    expect(digest).toContain("👻 4 pools launched without a trusted quote (unvaluable, invisible)");
    expect(digest).toContain("T5 hard-gated: 1");
    expect(digest).toContain("T6 below-floor: 1");
    expect(digest).toContain("T7 caught: 1");
    expect(digest).toContain("n=3 small — anecdotes, not signal.");
  });
});
