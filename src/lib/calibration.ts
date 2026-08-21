// Self-learning calibration: the model grades its own predictions and
// tightens itself, gameweek after gameweek.
//
// How it works:
//  1. Every time the app loads before a deadline, the current xP projection
//     for the upcoming GW is snapshotted (localStorage) — that snapshot is
//     exactly what the app told the user to expect.
//  2. Once that GW finishes, the snapshot is reconciled against the actual
//     points from the live endpoint: mean absolute error, and the bias
//     (did we systematically over- or under-predict?) per position.
//  3. The bias feeds an exponential-moving-average correction factor per
//     position (clamped, so one weird gameweek can't wreck the model),
//     which multiplies every future projection.
//
// The result: if the model keeps over-rating forwards by 8%, within a few
// gameweeks forwards are scaled down ~8% — continuously, automatically.
//
// That sentence was false for the life of this file and is worth the warning.
// The snapshot it grades is ALREADY calibrated, so the ratio it measures is a
// residual, not a factor; folding it in as one made the fixed point the square
// root of the correction needed, and an 8% bias settled at ~4% forever. See
// `applyGwOutcome`. Anything added here has to keep asking "is this quantity
// measured before or after the thing I am about to multiply by it?"

import type { Bootstrap } from "./types";
import { currentSeasonName } from "./seasonArchive";
import type { PlayerXp } from "./xp";

export interface CalibrationFactors {
  global: number;
  byPos: Record<number, number>; // element_type -> multiplier
}

export interface GwAccuracy {
  gw: number;
  n: number; // players compared
  mae: number; // mean absolute error, points per player
  bias: number; // (total predicted / total actual) - 1; + = over-predicted
  at: number; // reconciled timestamp
}

export interface CalibrationState {
  factors: CalibrationFactors;
  log: GwAccuracy[]; // most recent last
  reconciled: number[]; // gameweeks already graded
  /**
   * Which season `reconciled` refers to, in FPL's "2025/26" form.
   *
   * WITHOUT THIS THE FEATURE DIED EVERY AUGUST. `reconciled` is capped at the
   * last 30 entries, so a finished 38-gameweek season leaves exactly [9..38] —
   * and with no season on the state, next season loaded that list and skipped
   * its own GW9 through GW38. Calibration graded eight gameweeks a year and
   * then went quiet, with nothing anywhere saying so. Absent on state written
   * before this existed, which is treated as "not this season".
   */
  season?: string | null;
}

export const CAL_CONFIG = {
  alpha: 0.3, // EMA learning rate per graded gameweek
  factorMin: 0.75,
  factorMax: 1.3,
  minPred: 1.0, // only grade players we actually predicted something for
  maxLog: 12,
  snapshotMinXp: 0.3, // don't store near-zero predictions
};

export const IDENTITY_FACTORS: CalibrationFactors = {
  global: 1,
  byPos: { 1: 1, 2: 1, 3: 1, 4: 1 },
};

// Module-level active factors so the xP model can read them without every
// caller having to thread them through. Identity on the server and in tests.
let active: CalibrationFactors = IDENTITY_FACTORS;
export function activeCalibration(): CalibrationFactors {
  return active;
}
export function setActiveCalibration(f: CalibrationFactors) {
  active = f;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---- Pure core (unit-tested) ----------------------------------------------

export interface GradedPlayer {
  pos: number; // element_type
  pred: number;
  actual: number;
}

/** Grade one gameweek's predictions and fold the outcome into the factors. */
export function applyGwOutcome(
  state: CalibrationState,
  gw: number,
  entries: GradedPlayer[],
  now: number
): CalibrationState {
  const cfg = CAL_CONFIG;
  const graded = entries.filter((e) => e.pred >= cfg.minPred);
  if (graded.length < 10 || state.reconciled.includes(gw)) {
    return { ...state, reconciled: [...new Set([...state.reconciled, gw])] };
  }
  const mae = graded.reduce((s, e) => s + Math.abs(e.pred - e.actual), 0) / graded.length;
  const sumPred = graded.reduce((s, e) => s + e.pred, 0);
  const sumAct = graded.reduce((s, e) => s + e.actual, 0);
  const bias = sumAct > 0 ? sumPred / sumAct - 1 : 0;

  /*
   * THE RATIO IS A RESIDUAL, NOT A FACTOR, AND IT WAS FOLDED IN AS A FACTOR.
   *
   * `snapshotPredictions` stores `p.next`, and `projectAll` has ALREADY
   * multiplied that by `calibrationMultiplier`. So `sumAct / sumPred` is what
   * is left over AFTER the correction currently in force — and EMAing it in as
   * an absolute factor makes the fixed point `g = sqrt(r)` instead of `g = r`.
   * The loop closes half the gap and stalls at the geometric mean.
   *
   * Measured on a probe of 40 graded gameweeks with the raw model over-rating
   * by 25% (r = 0.8): global converged to 0.894427 — exactly sqrt(0.8) — and
   * 11.8% of the over-prediction was still there at the end. The header of this
   * file used to promise that an 8% bias is corrected by ~8% within a few
   * gameweeks; it was ~4%, permanently.
   *
   * The factor that WOULD have made this gameweek right is the one already
   * applied times the residual, so that is what the EMA aims at. `byPos` has
   * the same shape one level down, and the comment below already identified
   * this exact failure mode for `byPos` relative to `global` while `global`
   * itself had it relative to the shipped projection.
   *
   * `global` carries the aggregate correction; `byPos` must be RELATIVE to it,
   * otherwise multiplier = global * byPos double-counts the overall bias.
   */
  const globalRatio = sumPred > 0 ? sumAct / sumPred : 1;
  /*
   * `byPos` STAYS RELATIVE TO `global`, AND SEPARATELY STOPS INTEGRATING WHEN
   * `global` CANNOT MOVE.
   *
   * An earlier attempt divided by how much `global` actually moved rather than
   * by the aggregate residual. It fixed the saturation bug below and broke
   * something worse: `absorbed = 1 + alpha*(r - 1)` equals `globalRatio` only
   * at r = 1, so in the ORDINARY regime `byPos` picked up part of the aggregate
   * bias too — exactly the double-count the paragraph above forbids — and the
   * applied multiplier moved 51% of the way per graded gameweek against a
   * documented `alpha` of 0.3. Measured on a uniform bias with no positional
   * deviation at all: byPos came out 0.97835 at r = 0.9 where it should be
   * exactly 1. That is `CAL_CONFIG.alpha` retuned by accident, which the rules
   * in CLAUDE.md forbid outright.
   *
   * So the division stays `globalRatio`, and saturation is handled where it
   * actually happens: `global` is computed FIRST, and when the clamp stops it
   * from taking the residual it was asked to take, the part it refused is
   * handed to `byPos` instead. In the ordinary regime `headroom` is 1 and this
   * is byte-for-byte the relative rule; against a bound clamp `byPos` carries
   * the remainder because nothing else can.
   *
   * Without that, probed at 200 gameweeks with r = 0.5 for GK/DEF/MID and 0.2
   * for forwards: `global` pinned at 0.75 while `byPos` ran to 1.3/1.3/1.3/0.75
   * — a 30% UPWARD correction on three positions the model over-rates twofold.
   */
  const wanted = state.factors.global * globalRatio;
  const global = clamp(
    (1 - cfg.alpha) * state.factors.global + cfg.alpha * wanted,
    cfg.factorMin,
    cfg.factorMax
  );
  /*
   * The aggregate residual `global` can EVENTUALLY absorb, given the clamp.
   *
   * Dividing by `globalRatio` is right because `global` converges on absorbing
   * the whole aggregate — over several EMA steps, not this one. The saturation
   * bug is simply that at the clamp it can never get there, so `byPos` goes on
   * dividing out a correction nobody is applying. Asking what `global` can
   * REACH answers both: unclamped it is `globalRatio` exactly and this is
   * byte-for-byte the relative rule, and pinned at the floor it is 1, so
   * `byPos` picks up the whole position residual because nothing else can.
   */
  const reachable =
    state.factors.global > 0
      ? clamp(state.factors.global * globalRatio, cfg.factorMin, cfg.factorMax) /
        state.factors.global
      : 1;
  const byPos = { ...state.factors.byPos };
  for (const pos of [1, 2, 3, 4]) {
    const posEntries = graded.filter((e) => e.pos === pos);
    if (posEntries.length < 5) continue;
    const p = posEntries.reduce((s, e) => s + e.pred, 0);
    const a = posEntries.reduce((s, e) => s + e.actual, 0);
    if (p <= 0 || a <= 0) continue;
    // How much this position deviates BEYOND the global correction the clamp
    // will actually allow.
    const ratio = reachable > 0 ? a / p / reachable : 1;
    const prev = byPos[pos] ?? 1;
    byPos[pos] = clamp((1 - cfg.alpha) * prev + cfg.alpha * (prev * ratio), cfg.factorMin, cfg.factorMax);
  }

  const log = [...state.log, { gw, n: graded.length, mae, bias, at: now }]
    .sort((a, b) => a.gw - b.gw)
    .slice(-cfg.maxLog);
  return {
    factors: { global, byPos },
    log,
    reconciled: [...new Set([...state.reconciled, gw])].slice(-30),
    // Carried through, or the guard in `reconcileFinishedGws` that refuses to
    // write a null season over a real one has nothing left to fall back to —
    // and a null stamp is what makes the NEXT load clear `reconciled` and
    // re-grade the whole season. The early return above already preserved it;
    // this path did not, so one bad bootstrap during a grading pass was enough.
    season: state.season,
  };
}

/** Combined multiplier the model applies to a player's projection. */
export function calibrationMultiplier(f: CalibrationFactors, pos: number): number {
  return clamp(f.global * (f.byPos[pos] ?? 1), 0.7, 1.35);
}

// ---- Browser persistence ---------------------------------------------------

const key = (demo: boolean, k: string) => `${demo ? "demo-" : ""}fpl-${k}`;

export function loadCalibration(demo: boolean, season?: string | null): CalibrationState {
  try {
    const raw = localStorage.getItem(key(demo, "calibration"));
    if (raw) {
      const s = JSON.parse(raw) as CalibrationState;
      if (s?.factors?.byPos) {
        /*
         * A NEW SEASON CLEARS WHAT IS SEASON-SHAPED AND KEEPS WHAT IS NOT.
         *
         * `reconciled` is a list of gameweek NUMBERS, so it means nothing once
         * the numbers start again — and left alone it silently suppressed
         * grading for most of the new season (see `CalibrationState.season`).
         * The factors and the log are about the MODEL, not about a particular
         * season's gameweeks, so they carry over: what the model has learned
         * about its own bias does not stop being true in August.
         */
        /*
         * ABSENT IS NOT "THIS SEASON". State written before this field existed
         * carries no `season`, which is exactly the state every install has —
         * so requiring `s.season != null` meant the rollover never fired for
         * anyone, and the doc on `CalibrationState.season` promised the
         * opposite. Worse, `reconcileFinishedGws` then stamps the current
         * season onto that state and saves it, so the stale gameweek list is
         * marked as belonging to this season permanently and the reset can
         * never fire again.
         */
        if (season != null && s.season !== season) {
          return { ...s, reconciled: [], season };
        }
        return s;
      }
    }
  } catch {}
  return { factors: IDENTITY_FACTORS, log: [], reconciled: [], season: season ?? null };
}

/** The season stamped on stored state, before any rollover normalisation. */
function loadRawSeason(demo: boolean): string | null | undefined {
  try {
    const raw = localStorage.getItem(key(demo, "calibration"));
    if (!raw) return undefined;
    return (JSON.parse(raw) as CalibrationState).season ?? null;
  } catch {
    return undefined;
  }
}

function saveCalibration(demo: boolean, state: CalibrationState) {
  try {
    localStorage.setItem(key(demo, "calibration"), JSON.stringify(state));
  } catch {}
}

/** Store what we predicted for an upcoming GW (overwrites until the deadline). */
export function snapshotPredictions(
  demo: boolean,
  gw: number,
  xp: Map<number, PlayerXp>,
  season?: string | null
): void {
  try {
    const preds: Record<number, number> = {};
    for (const [id, p] of xp) {
      if (p.next >= CAL_CONFIG.snapshotMinXp) preds[id] = Math.round(p.next * 10) / 10;
    }
    localStorage.setItem(
      key(demo, `pred-${gw}`),
      JSON.stringify({ at: Date.now(), season, preds })
    );
  } catch {}
}

/**
 * Grade every stored snapshot whose gameweek has finished. Returns true if
 * the calibration changed (callers should re-project).
 */
export async function reconcileFinishedGws(
  demo: boolean,
  bootstrap: Bootstrap,
  getActuals: (gw: number) => Promise<Map<number, number>>
): Promise<boolean> {
  const season = currentSeasonName(bootstrap.events);
  let state = loadCalibration(demo, season);
  // The season rollover above is itself a change worth persisting: without
  // this, the reset is recomputed on every load until something else happens
  // to save, and any snapshot dropped below stays orphaned in the meantime.
  let changed = state.season !== loadRawSeason(demo);
  const posOf = new Map(bootstrap.elements.map((e) => [e.id, e.element_type]));
  const drop = (gw: number) => {
    try {
      localStorage.removeItem(key(demo, `pred-${gw}`));
    } catch {}
  };
  for (const ev of bootstrap.events) {
    if (!ev.finished || state.reconciled.includes(ev.id)) continue;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key(demo, `pred-${ev.id}`));
    } catch {}
    if (!raw) continue;
    try {
      const snap = JSON.parse(raw) as { preds: Record<string, number>; season?: string | null };
      /*
       * A SNAPSHOT FROM ANOTHER SEASON IS NOT EVIDENCE, IT IS POISON.
       *
       * The key is `pred-{gw}` with no season in it, and FPL reassigns element
       * ids every summer — `seasonArchive.ts`'s header says so. A reader who
       * visited before last season's GW38 deadline and came back a year later
       * had that snapshot graded against THIS season's actuals, mapping one
       * man's projection onto another man's return. Measured on a probe: it
       * drove `factors.global` straight to the 0.75 clamp floor, a 25% haircut
       * on every projection in the app, from one leftover key.
       */
      if (season != null && snap.season != null && snap.season !== season) {
        drop(ev.id);
        state = { ...state, reconciled: [...state.reconciled, ev.id] };
        changed = true;
        continue;
      }
      const actuals = await getActuals(ev.id);
      const entries: GradedPlayer[] = Object.entries(snap.preds).map(([idStr, pred]) => {
        const id = parseInt(idStr, 10);
        return { pos: posOf.get(id) ?? 3, pred, actual: actuals.get(id) ?? 0 };
      });
      state = applyGwOutcome(state, ev.id, entries, Date.now());
      changed = true;
      drop(ev.id);
    } catch {
      /*
       * Grading failed (live data gone, malformed snapshot) — skip this GW
       * permanently. `changed` MUST be set, and the key MUST go.
       *
       * Neither used to happen. If this was the only gameweek in the pass,
       * nothing saved, so every later page load re-fetched the same dead
       * `event/{gw}/live/` and failed again for the life of the install. And
       * the snapshot was left behind either way — which is exactly the orphan
       * that becomes next season's poison above.
       */
      state = { ...state, reconciled: [...state.reconciled, ev.id] };
      changed = true;
      drop(ev.id);
    }
  }
  /*
   * Never write `season: null` over a real stamp. `currentSeasonName` returns
   * null on a missing or odd GW1 `deadline_time`, and a null stamp makes the
   * next load see a season mismatch — which would clear `reconciled` and
   * re-grade the whole season, permanently, from one bad bootstrap.
   */
  if (changed) saveCalibration(demo, { ...state, season: season ?? state.season ?? null });
  setActiveCalibration(state.factors);
  return changed;
}

/** Demo mode: seed a plausible learning history so the feature is visible. */
export function seedDemoCalibration(): void {
  const demo = true;
  const existing = loadCalibration(demo);
  if (existing.log.length > 0) return;
  const now = Date.now();
  const state: CalibrationState = {
    factors: { global: 0.97, byPos: { 1: 1.02, 2: 0.95, 3: 0.98, 4: 0.93 } },
    log: [
      { gw: 15, n: 212, mae: 2.86, bias: 0.11, at: now },
      { gw: 16, n: 208, mae: 2.71, bias: 0.08, at: now },
      { gw: 17, n: 215, mae: 2.62, bias: 0.05, at: now },
      { gw: 18, n: 210, mae: 2.49, bias: 0.04, at: now },
      { gw: 19, n: 214, mae: 2.41, bias: 0.02, at: now },
    ],
    reconciled: [15, 16, 17, 18, 19],
  };
  saveCalibration(demo, state);
  setActiveCalibration(state.factors);
}
