// What the READER knows about the line-up, and the model does not.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
//
// The minutes model is the strongest thing in `xp.ts` and it is blind in one
// specific way: pre-season it reasons from price, last season's starts and
// where the crowd has put its money, and none of those has watched a press
// conference. Two cases show it clearly, both taken from the live 2026-08-07
// snapshot:
//
//   Muharemović (LEE, £5.0m) — `plSeasons: 0`. Not one Premier League minute
//   on record, so the whole estimate is derived from a price tag. The model
//   lands on pStart 0.550, which is not a belief about him; it is the absence
//   of one.
//
//   Thomas (COV, £4.0m) — four Premier League seasons, zero minutes last
//   season, and 8.9% of the field owns him. The model reads the record and
//   concludes he does not play (pStart 0.096). The crowd reads a promoted
//   club's new first-choice full-back. `xp.ts` documents this failure shape
//   itself: "the record was not wrong, it was answering a question about a
//   situation that no longer existed."
//
// Nothing in the official API closes that gap — team news of this kind is not
// published in a form anything can read. So the honest move is not to guess
// harder. It is to let someone who has seen the team sheet say so, and to be
// visibly clear about which numbers came from the model and which came from
// the reader.
//
// ---------------------------------------------------------------------------
// WHAT AN OVERRIDE IS AND IS NOT ALLOWED TO CLAIM
// ---------------------------------------------------------------------------
//
// It expresses exactly one fact — is this player in the starting eleven — and
// nothing else. It is deliberately not a free-form probability:
//
//   * A slider inviting "0.83" would be false precision. Nobody knows that,
//     and the model would then be fitted to a number somebody invented.
//   * It cannot claim more certainty than the model's own bounds. "Starts"
//     maps to `XP_CONFIG.preseasonMaxPStart`, the ceiling the model already
//     uses for the most nailed player in the game — because a manager naming
//     the XI still cannot rule out a warm-up injury, and the model's ceiling
//     is exactly that residual doubt. "Benched" maps to the bottom of
//     `priorPStartRange`, the floor of the price prior.
//   * "Benched" says HE IS NOT IN THE XI. It does not say he will not play.
//     A regular substitute's minutes are a different claim, and this override
//     does not make it — see the note on `applyStartCall`.
//
// Both values are the model's own, reused rather than invented, so there is no
// new constant here to be swept and none to go stale.

import { XP_CONFIG } from "./xp";

/** The reader's statement about one player, for the gameweek in front of them. */
export type StartCall = "starts" | "benched";

export interface MinutesLike {
  pStart: number;
  minsPerStart: number;
  share: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The pStart an override asserts. Both ends are the model's own bounds. */
export function pStartFor(call: StartCall): number {
  return call === "starts"
    ? XP_CONFIG.preseasonMaxPStart
    : XP_CONFIG.priorPStartRange[0];
}

/**
 * Fold a reader's call into a finished minutes model.
 *
 * The two directions are NOT symmetric, and that is the point.
 *
 * "Starts" raises `share` but never lowers it, mirroring the `liftedPStart`
 * block in `projectAll` for the same reason: a player whose observed minutes
 * already imply a bigger share is not made smaller by being told he starts.
 *
 * "Benched" recomputes `share` from the new `pStart` and lets it fall. That is
 * the honest reading of the claim being made — "he is not in the eleven" — and
 * it is also its limitation: a player who is a genuine regular substitute will
 * be under-rated by it, because "not starting" and "not playing" are different
 * facts and only the first one is being asserted. For a rotating sub the right
 * answer is to leave the override off and let the model's own share stand.
 */
export function applyStartCall(mm: MinutesLike, call: StartCall): MinutesLike {
  /*
   * `pStart` GETS THE SAME ONE-SIDED TREATMENT AS `share`, AND DID NOT.
   *
   * `pStartFor("starts")` is the PRE-SEASON ceiling, 0.97. In season the model
   * blends observed start share and clamps to 1.0, so an ever-present carries
   * 1.0 — and taking the override neat then DEMOTED him for being named in the
   * eleven. Measured on the demo's mid-season universe: 141 of 300 players sit
   * above 0.97, and every one sampled lost points when told he starts (element
   * 8: 5.961 to 5.932 next, 18.570 to 18.467 over three gameweeks).
   *
   * Small, but strictly the wrong sign, and it contradicted the asymmetry this
   * file's header states two paragraphs up — while `PlayerXp.startCall` labelled
   * the demoted number as the reader's own decision. `share` was already
   * guarded this way; `pStart` was not, and it feeds `p60` and `pPlay` directly.
   */
  const asserted = pStartFor(call);
  const p = call === "starts" ? Math.max(asserted, mm.pStart) : asserted;
  const derived = (p * mm.minsPerStart) / 90;
  return {
    pStart: p,
    minsPerStart: mm.minsPerStart,
    share: clamp(call === "starts" ? Math.max(derived, mm.share) : derived, 0, 1),
  };
}

// --- The active set --------------------------------------------------------
/*
 * Module-level, so `xp.ts` can read it without every caller threading it
 * through — the same trade `calibration.ts` already makes, and made for the
 * same reason: `projectAll` is called from four places and a fifth would
 * silently project without it.
 *
 * EMPTY ON THE SERVER AND IN TESTS. A projection with no overrides must be
 * bit-identical to the one this app shipped before the feature existed, and
 * `resetStartCalls()` is what lets a test assert that.
 */
let active: Map<number, StartCall> = new Map();

export function activeStartCalls(): Map<number, StartCall> {
  return active;
}

export function setActiveStartCalls(m: Map<number, StartCall>): void {
  active = m;
}

export function resetStartCalls(): void {
  active = new Map();
  bump();
}

/*
 * React cannot see module state move, so the version counter below is what
 * makes a projection re-run when the reader changes their mind. Same shape as
 * `pastSeasonStore`: a string snapshot that is `Object.is`-equal in and out, so
 * it is safe both as a dependency and as a `useSyncExternalStore` snapshot.
 */
let version = 0;
const listeners = new Set<() => void>();

export function startCallsVersion(): string {
  return `${version}:${active.size}`;
}

export function subscribeStartCalls(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

function bump(): void {
  version++;
  for (const cb of [...listeners]) cb();
}

/**
 * The single write path: update the active set, persist it, tell React.
 *
 * Components do not touch storage. Splitting those three steps across call
 * sites is how a saved call ends up not applied, or an applied one not saved —
 * and the reader would have no way to tell which of the two had happened.
 */
export function setStartCall(demo: boolean, id: number, call: StartCall | null): void {
  const next = new Map(active);
  if (call === null) next.delete(id);
  else next.set(id, call);
  active = next;
  saveStartCalls(demo, next);
  bump();
}

/** Load persisted calls into the active set — once, on mount. */
export function hydrateStartCalls(demo: boolean): void {
  active = loadStartCalls(demo);
  bump();
}

// --- Persistence -----------------------------------------------------------
/*
 * Keyed by feed, exactly as the calibration store is: the demo numbers its
 * players 1..300 and so do three hundred real footballers, so a call saved
 * against the demo's id 42 must never reach the real id 42.
 */
const key = (demo: boolean) => `${demo ? "demo-" : ""}fpl-start-calls`;

export function loadStartCalls(demo: boolean): Map<number, StartCall> {
  try {
    const raw = localStorage.getItem(key(demo));
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, string>;
    const out = new Map<number, StartCall>();
    for (const [id, v] of Object.entries(obj)) {
      // Anything unrecognised is dropped rather than coerced. A stored value
      // this build does not understand is not evidence of anything.
      if (v === "starts" || v === "benched") out.set(Number(id), v);
    }
    return out;
  } catch {
    return new Map();
  }
}

export function saveStartCalls(demo: boolean, m: Map<number, StartCall>): void {
  try {
    if (m.size === 0) localStorage.removeItem(key(demo));
    else localStorage.setItem(key(demo), JSON.stringify(Object.fromEntries(m)));
  } catch {}
}
