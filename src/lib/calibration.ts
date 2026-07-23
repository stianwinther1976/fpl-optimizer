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

import type { Bootstrap } from "./types";
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

  const byPos = { ...state.factors.byPos };
  for (const pos of [1, 2, 3, 4]) {
    const posEntries = graded.filter((e) => e.pos === pos);
    if (posEntries.length < 5) continue;
    const p = posEntries.reduce((s, e) => s + e.pred, 0);
    const a = posEntries.reduce((s, e) => s + e.actual, 0);
    if (p <= 0 || a <= 0) continue;
    const ratio = a / p; // >1 means we under-predicted -> scale up
    byPos[pos] = clamp(
      (1 - cfg.alpha) * (byPos[pos] ?? 1) + cfg.alpha * ratio,
      cfg.factorMin,
      cfg.factorMax
    );
  }
  const globalRatio = sumPred > 0 ? sumAct / sumPred : 1;
  const global = clamp(
    (1 - cfg.alpha) * state.factors.global + cfg.alpha * globalRatio,
    cfg.factorMin,
    cfg.factorMax
  );

  const log = [...state.log, { gw, n: graded.length, mae, bias, at: now }]
    .sort((a, b) => a.gw - b.gw)
    .slice(-cfg.maxLog);
  return {
    factors: { global, byPos },
    log,
    reconciled: [...new Set([...state.reconciled, gw])].slice(-30),
  };
}

/** Combined multiplier the model applies to a player's projection. */
export function calibrationMultiplier(f: CalibrationFactors, pos: number): number {
  return clamp(f.global * (f.byPos[pos] ?? 1), 0.7, 1.35);
}

// ---- Browser persistence ---------------------------------------------------

const key = (demo: boolean, k: string) => `${demo ? "demo-" : ""}fpl-${k}`;

export function loadCalibration(demo: boolean): CalibrationState {
  try {
    const raw = localStorage.getItem(key(demo, "calibration"));
    if (raw) {
      const s = JSON.parse(raw) as CalibrationState;
      if (s?.factors?.byPos) return s;
    }
  } catch {}
  return { factors: IDENTITY_FACTORS, log: [], reconciled: [] };
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
  xp: Map<number, PlayerXp>
): void {
  try {
    const preds: Record<number, number> = {};
    for (const [id, p] of xp) {
      if (p.next >= CAL_CONFIG.snapshotMinXp) preds[id] = Math.round(p.next * 10) / 10;
    }
    localStorage.setItem(key(demo, `pred-${gw}`), JSON.stringify({ at: Date.now(), preds }));
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
  let state = loadCalibration(demo);
  let changed = false;
  const posOf = new Map(bootstrap.elements.map((e) => [e.id, e.element_type]));
  for (const ev of bootstrap.events) {
    if (!ev.finished || state.reconciled.includes(ev.id)) continue;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key(demo, `pred-${ev.id}`));
    } catch {}
    if (!raw) continue;
    try {
      const snap = JSON.parse(raw) as { preds: Record<string, number> };
      const actuals = await getActuals(ev.id);
      const entries: GradedPlayer[] = Object.entries(snap.preds).map(([idStr, pred]) => {
        const id = parseInt(idStr, 10);
        return { pos: posOf.get(id) ?? 3, pred, actual: actuals.get(id) ?? 0 };
      });
      state = applyGwOutcome(state, ev.id, entries, Date.now());
      changed = true;
      try {
        localStorage.removeItem(key(demo, `pred-${ev.id}`));
      } catch {}
    } catch {
      // grading failed (e.g. live data gone) — skip this GW permanently
      state = { ...state, reconciled: [...state.reconciled, ev.id] };
    }
  }
  if (changed) {
    saveCalibration(demo, state);
    setActiveCalibration(state.factors);
  } else {
    setActiveCalibration(state.factors);
  }
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
