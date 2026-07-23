import { describe, it, expect } from "vitest";
import {
  applyGwOutcome,
  calibrationMultiplier,
  CAL_CONFIG,
  IDENTITY_FACTORS,
  type CalibrationState,
  type GradedPlayer,
} from "../calibration";

const fresh = (): CalibrationState => ({
  factors: { global: 1, byPos: { 1: 1, 2: 1, 3: 1, 4: 1 } },
  log: [],
  reconciled: [],
});

/** n players per position with a fixed predicted/actual relationship. */
function makeEntries(perPos: number, predOf: (pos: number) => number, actualOf: (pos: number) => number): GradedPlayer[] {
  const out: GradedPlayer[] = [];
  for (const pos of [1, 2, 3, 4]) {
    for (let i = 0; i < perPos; i++) {
      out.push({ pos, pred: predOf(pos), actual: actualOf(pos) });
    }
  }
  return out;
}

describe("applyGwOutcome", () => {
  it("over-prediction shrinks the factors, under-prediction grows them", () => {
    const over = applyGwOutcome(fresh(), 10, makeEntries(20, () => 5, () => 4), 0);
    expect(over.factors.global).toBeLessThan(1);
    expect(over.factors.byPos[3]).toBeLessThan(1);

    const under = applyGwOutcome(fresh(), 10, makeEntries(20, () => 4, () => 5), 0);
    expect(under.factors.global).toBeGreaterThan(1);
    expect(under.factors.byPos[3]).toBeGreaterThan(1);
  });

  it("moves by the EMA rate, not all the way", () => {
    // actual/pred = 0.8; one update should land at 1 - alpha*0.2
    const s = applyGwOutcome(fresh(), 10, makeEntries(20, () => 5, () => 4), 0);
    const expected = (1 - CAL_CONFIG.alpha) * 1 + CAL_CONFIG.alpha * 0.8;
    expect(s.factors.global).toBeCloseTo(expected, 5);
  });

  it("clamps runaway corrections", () => {
    let s = fresh();
    for (let gw = 1; gw <= 20; gw++) {
      s = applyGwOutcome(s, gw, makeEntries(20, () => 10, () => 1), 0);
    }
    expect(s.factors.global).toBeGreaterThanOrEqual(CAL_CONFIG.factorMin);
    for (const pos of [1, 2, 3, 4]) {
      expect(s.factors.byPos[pos]).toBeGreaterThanOrEqual(CAL_CONFIG.factorMin);
    }
  });

  it("only corrects the position that misses", () => {
    const entries = makeEntries(
      20,
      () => 5,
      (pos) => (pos === 4 ? 3 : 5) // forwards over-predicted, rest spot-on
    );
    const s = applyGwOutcome(fresh(), 10, entries, 0);
    expect(s.factors.byPos[4]).toBeLessThan(0.95);
    expect(s.factors.byPos[2]).toBeCloseTo(1, 5);
  });

  it("records MAE and bias in the log and marks the GW reconciled", () => {
    const s = applyGwOutcome(fresh(), 12, makeEntries(20, () => 5, () => 4), 123);
    expect(s.reconciled).toContain(12);
    expect(s.log.length).toBe(1);
    expect(s.log[0].mae).toBeCloseTo(1, 5);
    expect(s.log[0].bias).toBeCloseTo(0.25, 5); // predicted 25% above actual
    expect(s.log[0].n).toBe(80);
  });

  it("never grades the same GW twice", () => {
    const once = applyGwOutcome(fresh(), 10, makeEntries(20, () => 5, () => 4), 0);
    const twice = applyGwOutcome(once, 10, makeEntries(20, () => 5, () => 4), 0);
    expect(twice.factors.global).toBe(once.factors.global);
    expect(twice.log.length).toBe(1);
  });

  it("ignores tiny samples (no correction from 3 players)", () => {
    const s = applyGwOutcome(
      fresh(),
      10,
      [
        { pos: 4, pred: 5, actual: 1 },
        { pos: 4, pred: 5, actual: 1 },
        { pos: 4, pred: 5, actual: 1 },
      ],
      0
    );
    expect(s.factors.global).toBe(1);
    expect(s.log.length).toBe(0);
  });
});

describe("calibrationMultiplier", () => {
  it("identity by default", () => {
    expect(calibrationMultiplier(IDENTITY_FACTORS, 3)).toBe(1);
  });
  it("combines global and positional, clamped", () => {
    const f = { global: 0.8, byPos: { 1: 1, 2: 1, 3: 0.8, 4: 1.4 } };
    expect(calibrationMultiplier(f, 3)).toBeCloseTo(0.7, 5); // 0.64 clamped up
    expect(calibrationMultiplier(f, 4)).toBeCloseTo(0.8 * 1.4, 5);
  });
});
