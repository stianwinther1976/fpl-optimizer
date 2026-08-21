import { beforeEach, describe, it, expect } from "vitest";
import {
  applyGwOutcome,
  calibrationMultiplier,
  CAL_CONFIG,
  IDENTITY_FACTORS,
  loadCalibration,
  reconcileFinishedGws,
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
  it("over-prediction shrinks the applied multiplier, under-prediction grows it", () => {
    // byPos is relative to global, so a uniform miss lives in `global` and the
    // combined multiplier is what carries the correction.
    const over = applyGwOutcome(fresh(), 10, makeEntries(20, () => 5, () => 4), 0);
    expect(over.factors.global).toBeLessThan(1);
    expect(calibrationMultiplier(over.factors, 3)).toBeLessThan(1);

    const under = applyGwOutcome(fresh(), 10, makeEntries(20, () => 4, () => 5), 0);
    expect(under.factors.global).toBeGreaterThan(1);
    expect(calibrationMultiplier(under.factors, 3)).toBeGreaterThan(1);
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
    /*
     * MEASURED OVER GAMEWEEKS, NOT AFTER ONE.
     *
     * This used to grade a single gameweek and assert the accurate positions
     * came out within 0.01 of 1 — which the old rule satisfied by ACCIDENT. It
     * aimed `byPos` at `(a/p) / globalRatio`, an overshoot, and one EMA step of
     * that overshoot happened to land near 1. Aiming at the correct target
     * instead lands at 1.009 after one step and reaches 1 over several, because
     * an EMA moves 30% of the way per gameweek by design.
     *
     * So the assertion now measures the property this test is named for —
     * forwards corrected, everyone else left alone — where that property is
     * actually claimed: at convergence.
     */
    let st = fresh();
    for (let gw = 1; gw <= 60; gw++) {
      const entries: GradedPlayer[] = [];
      for (const pos of [1, 2, 3, 4]) {
        const m = calibrationMultiplier(st.factors, pos);
        // Raw 5; forwards actually return 4, everyone else 5. Deliberately a
        // 0.8 correction rather than 0.6: `calibrationMultiplier` clamps the
        // combined figure at 0.7, so a harsher bias would measure the clamp
        // instead of the mechanism this test is about.
        for (let i = 0; i < 20; i++) {
          entries.push({ pos, pred: 5 * m, actual: pos === 4 ? 4 : 5 });
        }
      }
      st = applyGwOutcome(st, gw, entries, 0);
    }
    expect(calibrationMultiplier(st.factors, 4)).toBeCloseTo(0.8, 2);
    for (const pos of [1, 2, 3]) {
      expect(calibrationMultiplier(st.factors, pos)).toBeCloseTo(1, 2);
    }
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

/*
 * THE LOOP HAS TO CLOSE THE BIAS, NOT HALF OF IT.
 *
 * `snapshotPredictions` stores an already-calibrated projection, so the ratio
 * this module measures is a RESIDUAL. Folding it in as an absolute factor made
 * the fixed point `g = sqrt(r)`: an over-prediction of 25% settled at 0.894427
 * — exactly sqrt(0.8) — with 11.8% of the bias still there after 40 graded
 * gameweeks, permanently. The file's own header promised the opposite.
 */
describe("convergence", () => {
  /** Grade `rounds` gameweeks of a model whose RAW output is `1/r` too high. */
  const converge = (r: number, rounds: number) => {
    let st = fresh();
    for (let gw = 1; gw <= rounds; gw++) {
      const m = calibrationMultiplier(st.factors, 3);
      // What the reader is shown is the raw projection times the factor in
      // force — which is exactly what gets snapshotted and graded later.
      const shown = 5 * m;
      const actual = 5 * r;
      st = applyGwOutcome(st, gw, makeEntries(20, () => shown, () => actual), 0);
    }
    return st;
  };

  it("converges on the correction actually needed, not its square root", () => {
    const st = converge(0.8, 60);
    expect(calibrationMultiplier(st.factors, 3)).toBeCloseTo(0.8, 3);
    // The bug's fixed point, which must not come back.
    expect(calibrationMultiplier(st.factors, 3)).not.toBeCloseTo(Math.sqrt(0.8), 3);
  });

  it("closes an under-prediction the same way", () => {
    const st = converge(1.2, 60);
    expect(calibrationMultiplier(st.factors, 3)).toBeCloseTo(1.2, 3);
  });

  it("leaves an unbiased model alone", () => {
    const st = converge(1, 30);
    expect(calibrationMultiplier(st.factors, 3)).toBeCloseTo(1, 6);
  });

  it("closes a POSITION-specific bias too, not its square root", () => {
    /*
     * The uniform case above leaves `byPos` at 1, so it cannot see the same
     * defect one level down — mutation-testing caught exactly that. Here
     * forwards are wrong by a different amount from everyone else, so the
     * correction has to live in `byPos` and `global` together.
     */
    const rOther = 1.0;
    const rFwd = 0.7;
    let st = fresh();
    for (let gw = 1; gw <= 80; gw++) {
      const entries: GradedPlayer[] = [];
      for (const pos of [1, 2, 3, 4]) {
        const m = calibrationMultiplier(st.factors, pos);
        const r = pos === 4 ? rFwd : rOther;
        for (let i = 0; i < 20; i++) entries.push({ pos, pred: 5 * m, actual: 5 * r });
      }
      st = applyGwOutcome(st, gw, entries, 0);
    }
    expect(calibrationMultiplier(st.factors, 4)).toBeCloseTo(rFwd, 2);
    expect(calibrationMultiplier(st.factors, 3)).toBeCloseTo(rOther, 2);
    // The bug's fixed point for the forward line.
    expect(calibrationMultiplier(st.factors, 4)).not.toBeCloseTo(Math.sqrt(rFwd), 2);
  });

  it("leaves byPos alone for a uniform bias, and moves at the documented alpha", () => {
    /*
     * `CAL_CONFIG.alpha` IS A TUNED CONSTANT AND MUST NOT MOVE BY ACCIDENT.
     *
     * An attempt at the saturation bug below divided `byPos` by how much
     * `global` actually moved rather than by the aggregate residual. That
     * equals the residual only at r = 1, so `byPos` picked up part of the
     * aggregate bias too — the double-count the module's own comment forbids —
     * and the applied multiplier moved 51% of the way per gameweek against a
     * documented 0.3. Measured then: byPos 0.97835 at r = 0.9 where it should
     * be exactly 1. Retuning alpha without a sweep is what CLAUDE.md forbids
     * outright, so both halves are pinned.
     */
    for (const r of [0.9, 0.8, 1.1]) {
      const entries: GradedPlayer[] = [];
      for (const pos of [1, 2, 3, 4]) {
        for (let i = 0; i < 20; i++) entries.push({ pos, pred: 5, actual: 5 * r });
      }
      const s = applyGwOutcome(fresh(), 1, entries, 0);
      // A bias with no positional component lives entirely in `global`.
      for (const pos of [1, 2, 3, 4]) {
        expect(s.factors.byPos[pos], `byPos[${pos}] at r=${r}`).toBeCloseTo(1, 9);
      }
      const alphaEff = (calibrationMultiplier(s.factors, 1) - 1) / (r - 1);
      expect(alphaEff, `effective alpha at r=${r}`).toBeCloseTo(CAL_CONFIG.alpha, 6);
    }
  });

  it("does not let byPos integrate the wrong way when global saturates", () => {
    /*
     * `byPos` divides the aggregate residual out on the assumption `global`
     * absorbs it. When the clamp binds, nobody does — and dividing anyway turns
     * `byPos` into an integrator pointing the WRONG WAY. Probed at 200
     * gameweeks with r = 0.5 for GK/DEF/MID and 0.2 for forwards: `global`
     * pinned at 0.75 while `byPos` ran to 1.3/1.3/1.3/0.75, a 30% UPWARD
     * correction on three positions the model over-rates twofold, for a
     * combined multiplier of 0.975 where 0.5 was needed.
     */
    let st = fresh();
    for (let gw = 1; gw <= 200; gw++) {
      const entries: GradedPlayer[] = [];
      for (const pos of [1, 2, 3, 4]) {
        const m = calibrationMultiplier(st.factors, pos);
        const r = pos === 4 ? 0.2 : 0.5;
        for (let i = 0; i < 20; i++) entries.push({ pos, pred: 5 * m, actual: 5 * r });
      }
      st = applyGwOutcome(st, gw, entries, 0);
    }
    // Everything is over-rated, so nothing may be corrected UPWARD.
    for (const pos of [1, 2, 3, 4]) {
      expect(st.factors.byPos[pos], `byPos[${pos}]`).toBeLessThanOrEqual(1);
      // And the combined figure must sit on the floor, not near 1.
      expect(calibrationMultiplier(st.factors, pos), `mult[${pos}]`).toBeCloseTo(0.7, 2);
    }
  });

  it("still respects the clamp on a wild bias", () => {
    const st = converge(0.1, 60);
    expect(st.factors.global).toBeGreaterThanOrEqual(CAL_CONFIG.factorMin);
    expect(calibrationMultiplier(st.factors, 3)).toBeGreaterThanOrEqual(0.7);
  });
});

/*
 * PERSISTENCE, WHERE THREE DEFECTS LIVED TOGETHER.
 *
 * `reconciled` is a list of gameweek NUMBERS capped at 30 entries, so a
 * finished 38-gameweek season left exactly [9..38] — and with no season on the
 * state, the next season loaded that and skipped its own GW9 through GW38.
 * Calibration graded eight gameweeks a year and then went quiet.
 */
describe("persistence across a season boundary", () => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });

  const boot = (season: number, finishedUpTo: number) =>
    ({
      elements: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, element_type: (i % 4) + 1 })),
      events: Array.from({ length: 38 }, (_, i) => ({
        id: i + 1,
        finished: i + 1 <= finishedUpTo,
        deadline_time: `${season}-08-1${i === 0 ? "5" : "6"}T17:30:00Z`,
      })),
    }) as unknown as Parameters<typeof reconcileFinishedGws>[1];

  beforeEach(() => store.clear());

  it("clears last season's graded list but keeps what the model learned", () => {
    store.set(
      "fpl-calibration",
      JSON.stringify({
        factors: { global: 0.9, byPos: { 1: 1, 2: 1, 3: 1, 4: 1 } },
        log: [{ gw: 38, n: 100, mae: 1, bias: 0.1, at: 0 }],
        reconciled: Array.from({ length: 30 }, (_, i) => i + 9),
        season: "2025/26",
      })
    );
    const s = loadCalibration(false, "2026/27");
    // The gameweek numbers are meaningless now, so they go.
    expect(s.reconciled).toEqual([]);
    expect(s.season).toBe("2026/27");
    // What the model learned about its own bias does not stop being true.
    expect(s.factors.global).toBe(0.9);
    expect(s.log.length).toBe(1);
  });

  it("resets state written before the season field existed", () => {
    /*
     * THE CASE EVERY EXISTING INSTALL IS IN. Requiring `s.season != null` meant
     * the rollover never fired for anyone — and then `reconcileFinishedGws`
     * stamped the current season onto that stale list, so it could never fire
     * again either. An adversarial re-audit caught this on the commit that was
     * written to kill exactly this failure.
     */
    store.set(
      "fpl-calibration",
      JSON.stringify({
        factors: { global: 0.9, byPos: { 1: 1, 2: 1, 3: 1, 4: 1 } },
        log: [],
        reconciled: Array.from({ length: 30 }, (_, i) => i + 9),
        // No `season` key at all.
      })
    );
    const s = loadCalibration(false, "2026/27");
    expect(s.reconciled).toEqual([]);
    expect(s.season).toBe("2026/27");
    expect(s.factors.global).toBe(0.9);
  });

  it("keeps the graded list within one season", () => {
    store.set(
      "fpl-calibration",
      JSON.stringify({
        factors: IDENTITY_FACTORS,
        log: [],
        reconciled: [1, 2, 3],
        season: "2026/27",
      })
    );
    expect(loadCalibration(false, "2026/27").reconciled).toEqual([1, 2, 3]);
  });

  it("refuses to grade a snapshot stamped with another season", async () => {
    /*
     * FPL reassigns element ids every summer. A snapshot left over from last
     * season maps one man's projection onto another man's return; a probe drove
     * `factors.global` straight to the clamp floor from one leftover key.
     */
    store.set(
      "fpl-pred-1",
      JSON.stringify({ at: 0, season: "2025/26", preds: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i + 1, 8])) })
    );
    const changed = await reconcileFinishedGws(false, boot(2026, 1), async () =>
      new Map(Array.from({ length: 40 }, (_, i) => [i + 1, 0]))
    );
    /*
     * FALSE, and that is the point of the test's other two assertions. The
     * return value means "re-project" — nothing here moved a factor, so a
     * re-projection would compute the identical numbers at the cost of the most
     * expensive pass in the app. The work that DID happen is persisted below.
     */
    expect(changed).toBe(false);
    // Untouched by a snapshot it had no business grading...
    expect(JSON.parse(store.get("fpl-calibration")!).factors.global).toBe(1);
    // ...and the orphan key is gone, so it cannot poison a later pass either.
    expect(store.has("fpl-pred-1")).toBe(false);
  });

  it("persists a failed grade, so it is not retried on every page load", async () => {
    // The catch used to mutate state without setting `changed`, so nothing
    // saved: every later load re-fetched the same dead gameweek and failed
    // again for the life of the install, leaving the snapshot behind each time.
    store.set("fpl-pred-1", JSON.stringify({ at: 0, season: "2026/27", preds: { 1: 8 } }));
    const changed = await reconcileFinishedGws(false, boot(2026, 1), async () => {
      throw new Error("live data gone");
    });
    // Persisted (below) but not a reason to re-project: no factor moved.
    expect(changed).toBe(false);
    expect(JSON.parse(store.get("fpl-calibration")!).reconciled).toContain(1);
    expect(store.has("fpl-pred-1")).toBe(false);
  });

  it("does not ask for a re-projection on every load when storage refuses writes", async () => {
    /*
     * Safari private browsing and a full quota both make `setItem` throw. The
     * season stamp then never lands, so the rollover is re-detected on the next
     * load, and the next — and while `changed` was one variable that meant a
     * full re-projection, forever, to arrive at identity factors.
     */
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: (k: string) => void store.delete(k),
      },
    });
    try {
      for (let load = 0; load < 3; load++) {
        expect(
          await reconcileFinishedGws(false, boot(2026, 1), async () => new Map())
        ).toBe(false);
      }
    } finally {
      Object.defineProperty(globalThis, "localStorage", real);
    }
  });

  it("refuses to load a factor that is not a finite number", () => {
    /*
     * `calibrationMultiplier` is `clamp(global * byPos, 0.7, 1.35)`, and
     * `Math.max(0.7, Math.min(1.35, NaN))` is `NaN` — so one bad value in the
     * store turns every projection in the app into NaN until site data is
     * cleared. The old guard was `s?.factors?.byPos`, an object test, which
     * says nothing about either number.
     */
    store.set(
      "fpl-calibration",
      JSON.stringify({
        factors: { global: null, byPos: { 1: "1.2", 2: 5, 3: 0.9, 4: 1 } },
        log: [],
        reconciled: [],
        season: "2026/27",
      })
    );
    const f = loadCalibration(false, "2026/27").factors;
    expect(f.global).toBe(1); // null is not a number
    expect(f.byPos[1]).toBe(1); // nor is a numeric string
    expect(f.byPos[2]).toBe(CAL_CONFIG.factorMax); // out of range, but a real value: clamped
    expect(f.byPos[3]).toBe(0.9); // untouched
    for (const pos of [1, 2, 3, 4]) {
      expect(Number.isFinite(calibrationMultiplier(f, pos))).toBe(true);
    }
  });
});
