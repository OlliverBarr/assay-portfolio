import { describe, expect, it } from "vitest";

import { evaluateAlert } from "../src/index.js";
import { makeAlertRow, makeContext, makeScore } from "./fixtures.js";

const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const MIN_SCORE = 50;
const RE_ALERT_DELTA = 10;
const cfg = {
  cooldownMs: COOLDOWN_MS,
  minScore: MIN_SCORE,
  reAlertMinScoreDelta: RE_ALERT_DELTA
};
const SENT_AT = new Date("2026-07-10T00:00:00Z");

describe("evaluateAlert", () => {
  it("never emits GRAY, even with no prior alert", () => {
    const decision = evaluateAlert(makeContext("GRAY"), undefined, cfg, SENT_AT);
    expect(decision.emit).toBe(false);
    expect(decision.reason).toContain("gray");
  });

  it("never emits GRAY even when a prior alert exists", () => {
    const decision = evaluateAlert(
      makeContext("GRAY"),
      makeAlertRow({ alertLevel: "RED" }),
      cfg,
      new Date(SENT_AT.getTime() + COOLDOWN_MS * 10)
    );
    expect(decision.emit).toBe(false);
  });

  it("emits the first alert when there is no prior alert", () => {
    const decision = evaluateAlert(
      makeContext("RED"),
      undefined,
      cfg,
      SENT_AT
    );
    expect(decision.emit).toBe(true);
    expect(decision.reason).toBe("first-alert");
  });

  it("emits immediately on a level increase, ignoring cooldown", () => {
    const decision = evaluateAlert(
      makeContext("YELLOW"),
      makeAlertRow({ alertLevel: "RED", sentAt: SENT_AT }),
      cfg,
      new Date(SENT_AT.getTime() + 1000) // well within cooldown
    );
    expect(decision.emit).toBe(true);
    expect(decision.reason).toContain("level-increase");
  });

  it("suppresses a same-level alert within the cooldown window", () => {
    const decision = evaluateAlert(
      makeContext("RED"),
      makeAlertRow({ alertLevel: "RED", sentAt: SENT_AT }),
      cfg,
      new Date(SENT_AT.getTime() + COOLDOWN_MS - 1)
    );
    expect(decision.emit).toBe(false);
    expect(decision.reason).toBe("within-cooldown");
  });

  it("emits a same-level alert once the cooldown has elapsed", () => {
    const decision = evaluateAlert(
      makeContext("RED"),
      makeAlertRow({ alertLevel: "RED", sentAt: SENT_AT }),
      cfg,
      new Date(SENT_AT.getTime() + COOLDOWN_MS)
    );
    expect(decision.emit).toBe(true);
    expect(decision.reason).toContain("cooldown-elapsed");
  });

  it("suppresses a de-escalation within cooldown but re-emits after the gap", () => {
    const within = evaluateAlert(
      makeContext("RED"),
      makeAlertRow({ alertLevel: "YELLOW", sentAt: SENT_AT }),
      cfg,
      new Date(SENT_AT.getTime() + 1000)
    );
    expect(within.emit).toBe(false);

    const afterGap = evaluateAlert(
      makeContext("RED"),
      makeAlertRow({ alertLevel: "YELLOW", sentAt: SENT_AT }),
      cfg,
      new Date(SENT_AT.getTime() + COOLDOWN_MS)
    );
    expect(afterGap.emit).toBe(true);
    expect(afterGap.reason).toContain("de-escalation");
  });

  it("suppresses a same-level re-alert after cooldown when the score has not materially improved", () => {
    // Live 2026-07-12: an unchanged ORANGE 68 re-alerted every 30 minutes.
    const decision = evaluateAlert(
      makeContext("YELLOW", { score: makeScore({ score: 68 }) }),
      makeAlertRow({ alertLevel: "YELLOW", score: 68, sentAt: SENT_AT }),
      cfg,
      new Date(SENT_AT.getTime() + COOLDOWN_MS * 3)
    );
    expect(decision.emit).toBe(false);
    expect(decision.reason).toBe("no-material-improvement:68<68+10");
  });

  it("emits a same-level re-alert at exactly the improvement delta", () => {
    const decision = evaluateAlert(
      makeContext("RED", { score: makeScore({ score: 60 + RE_ALERT_DELTA }) }),
      makeAlertRow({ alertLevel: "RED", score: 60, sentAt: SENT_AT }),
      cfg,
      new Date(SENT_AT.getTime() + COOLDOWN_MS)
    );
    expect(decision.emit).toBe(true);
    expect(decision.reason).toBe("cooldown-elapsed:same-level:score+10");
  });

  it("level escalation ignores both cooldown and improvement delta", () => {
    const decision = evaluateAlert(
      makeContext("GREEN", { score: makeScore({ score: 60 }) }),
      makeAlertRow({ alertLevel: "YELLOW", score: 75, sentAt: SENT_AT }),
      cfg,
      new Date(SENT_AT.getTime() + 1000)
    );
    expect(decision.emit).toBe(true);
    expect(decision.reason).toContain("level-increase");
  });

  it("delta 0 restores cooldown-only re-alerts", () => {
    const decision = evaluateAlert(
      makeContext("RED", { score: makeScore({ score: 60 }) }),
      makeAlertRow({ alertLevel: "RED", score: 60, sentAt: SENT_AT }),
      { ...cfg, reAlertMinScoreDelta: 0 },
      new Date(SENT_AT.getTime() + COOLDOWN_MS)
    );
    expect(decision.emit).toBe(true);
  });

  it("suppresses any level scoring below minScore, even a first alert", () => {
    const decision = evaluateAlert(
      makeContext("GREEN", { score: makeScore({ score: MIN_SCORE - 1 }) }),
      undefined,
      cfg,
      SENT_AT
    );
    expect(decision.emit).toBe(false);
    expect(decision.reason).toBe("below-min-score:49<50");
  });

  it("emits at exactly minScore", () => {
    const decision = evaluateAlert(
      makeContext("RED", { score: makeScore({ score: MIN_SCORE }) }),
      undefined,
      cfg,
      SENT_AT
    );
    expect(decision.emit).toBe(true);
    expect(decision.reason).toBe("first-alert");
  });

  it("minScore 0 disables the gate", () => {
    const decision = evaluateAlert(
      makeContext("RED", { score: makeScore({ score: 0 }) }),
      undefined,
      { cooldownMs: COOLDOWN_MS, minScore: 0, reAlertMinScoreDelta: RE_ALERT_DELTA },
      SENT_AT
    );
    expect(decision.emit).toBe(true);
  });

  describe("minScoreRed (RED-only delivery floor)", () => {
    const redCfg = { ...cfg, minScoreRed: 70 };

    it("suppresses a RED alert below the RED floor even when it clears minScore", () => {
      const decision = evaluateAlert(
        makeContext("RED", { score: makeScore({ score: 65 }) }),
        undefined,
        redCfg,
        SENT_AT
      );
      expect(decision.emit).toBe(false);
      expect(decision.reason).toBe("below-min-score:65<70");
    });

    it("emits a RED alert at exactly the RED floor", () => {
      const decision = evaluateAlert(
        makeContext("RED", { score: makeScore({ score: 70 }) }),
        undefined,
        redCfg,
        SENT_AT
      );
      expect(decision.emit).toBe(true);
      expect(decision.reason).toBe("first-alert");
    });

    it("leaves YELLOW/GREEN on the global floor", () => {
      for (const level of ["YELLOW", "GREEN"] as const) {
        const decision = evaluateAlert(
          makeContext(level, { score: makeScore({ score: 65 }) }),
          undefined,
          redCfg,
          SENT_AT
        );
        expect(decision.emit).toBe(true);
      }
    });

    it("never lowers the floor: a RED floor below minScore falls back to minScore", () => {
      const decision = evaluateAlert(
        makeContext("RED", { score: makeScore({ score: 45 }) }),
        undefined,
        { ...cfg, minScoreRed: 10 },
        SENT_AT
      );
      expect(decision.emit).toBe(false);
      expect(decision.reason).toBe("below-min-score:45<50");
    });

    it("omitted minScoreRed keeps legacy single-floor behavior for RED", () => {
      const decision = evaluateAlert(
        makeContext("RED", { score: makeScore({ score: MIN_SCORE }) }),
        undefined,
        cfg,
        SENT_AT
      );
      expect(decision.emit).toBe(true);
    });
  });

  describe("duplicate-name sibling suppression", () => {
    const sibling = makeAlertRow({
      tokenAddress: "0xSibling000000000000000000000000000000001",
      alertLevel: "YELLOW",
      score: 66,
      sentAt: SENT_AT
    });

    it("suppresses a same-level alert when a same-named sibling delivered", () => {
      const decision = evaluateAlert(
        makeContext("YELLOW"),
        undefined,
        cfg,
        SENT_AT,
        sibling
      );
      expect(decision.emit).toBe(false);
      expect(decision.reason).toBe(
        "duplicate-name:YELLOW@0xSibling000000000000000000000000000000001"
      );
    });

    it("suppresses a lower-level alert behind a delivered sibling", () => {
      const decision = evaluateAlert(
        makeContext("RED", { score: makeScore({ score: MIN_SCORE }) }),
        undefined,
        cfg,
        SENT_AT,
        sibling
      );
      expect(decision.emit).toBe(false);
      expect(decision.reason).toContain("duplicate-name:");
    });

    it("delivers an alert that outranks the sibling — the strongest of a wave surfaces", () => {
      const decision = evaluateAlert(
        makeContext("GREEN"),
        undefined,
        cfg,
        SENT_AT,
        sibling
      );
      expect(decision.emit).toBe(true);
      expect(decision.reason).toBe("first-alert");
    });

    it("sibling suppression composes with per-token history, not instead of it", () => {
      // Same token alerted RED before; sibling delivered YELLOW. The
      // escalation to GREEN outranks both and delivers immediately.
      const decision = evaluateAlert(
        makeContext("GREEN"),
        makeAlertRow({ alertLevel: "RED", score: 60, sentAt: SENT_AT }),
        cfg,
        new Date(SENT_AT.getTime() + 1000),
        sibling
      );
      expect(decision.emit).toBe(true);
      expect(decision.reason).toBe("level-increase:RED->GREEN");
    });
  });
});
