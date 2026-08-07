// Chip timing across the season, rather than across the next five gameweeks.
//
// ---------------------------------------------------------------------------
// WHY THE OLD ADVICE LEANED TOWARDS PLAYING EVERYTHING IMMEDIATELY
// ---------------------------------------------------------------------------
//
// The chip advisor scored each chip over `gws` — `nextEvent` to
// `nextEvent + horizon`, five gameweeks — and reported the best one it found.
// Three things follow from that, and all three push the same way.
//
// First, a five-week window cannot see a blank or a double that is fourteen
// weeks out, which is where chips are actually worth the most. Second, the
// Wildcard's figure is `max(0, bestSquadWithinValue - keepSquad)` over that
// window, which is bounded below by zero and is essentially always positive:
// a freshly optimised squad beats a held one over ANY window, so the number
// says "this chip works", never "now is the moment". Third, nothing compared
// the value of playing it against the value of not playing it yet, so there
// was no quantity anywhere in the advisor that could ever come out as "hold".
//
// ---------------------------------------------------------------------------
// STRUCTURE FINDS THE CANDIDATES; SCORING RESOLVES THEM
// ---------------------------------------------------------------------------
//
// The first version of this module refused to score anything beyond the
// projection horizon at all, on the grounds that an expected-points figure
// twenty weeks out is a number with no evidence in it. That was measured and
// it is the wrong objection. Projecting the whole first-half chip window on the
// 2026-08-07 snapshot, with a squad the app drafted itself:
//
//   bench xP by gameweek, GW1-19: 11.37 .. 12.28 — a spread of 0.91 across
//   nineteen gameweeks. Best inside a five-week horizon is GW2 at 12.16; best
//   over the whole window is GW9 at 12.28. A difference of 0.12 points.
//
//   The Triple Captain's best gameweek over all nineteen is GW1 — the same one
//   a five-week horizon already finds.
//
// So a far-out projection does not go WILD, it goes FLAT. Nothing in the model
// varies much by gameweek once availability has converged (injured players
// decay toward `recoveryCeiling`, bans toward the tail of `banAvail`) and the
// only per-gameweek input left is the fixture. Extending the horizon blindly
// would not produce a wrong answer; it would produce an answer with no
// discriminating power, and then invite a reader to act on 0.12 points as
// though it were a finding. Picking an argmax off a surface that flat is
// fitting noise, which is the thing this repo is most careful about.
//
// COST IS SMALL BUT NOT FREE, and this comment used to say otherwise. It cited
// 58 ms at horizon 5 against 63 ms at horizon 29 and concluded the work was
// dominated by per-player setup rather than by gameweeks. Both figures were
// measured cold, so each was mostly first-call overhead and the comparison
// meant nothing. Re-measured properly — nine interleaved runs after warmup,
// medians — `projectAll` costs 9.7 ms at horizon 5, 19.5 at 12, 27.9 at 19 and
// 37.6 at 29. It scales with the horizon, roughly linearly above a fixed offset.
//
// That does not change what is done here, because 38 ms was never the
// constraint; the flat surface above is. But the reason had to be corrected
// rather than left standing as a measurement nobody could reproduce.
//
// What DOES move the number is fixture structure, and it moves it enormously.
// Injecting a double gameweek into GW30 for the squad's clubs took the bench
// from 11.16 to 15.41 and the XI from 45.62 to 82.50.
//
// Hence the shape here. The calendar is scanned over the chip's whole window —
// cheap, and trustworthy months ahead because it is a schedule rather than a
// forecast. Only the gameweeks it FLAGS are then scored, and a scored gameweek
// is reported only when it beats what the horizon already found by more than
// the flat-surface spread above. Pre-season nothing is flagged, so nothing
// extra is computed and nothing is claimed.
//
// One caveat travels with every scored figure out here, and the copy says so:
// it is fixture-driven. It carries no team news, no form and no idea who will
// be injured in November.
//
// ---------------------------------------------------------------------------
// THE WINDOW IS A HARD BOUND, NOT A DETAIL
// ---------------------------------------------------------------------------
//
// Since 2025/26 there are two of each chip and each one expires: `bootstrap.chips`
// carries `start_event`/`stop_event`, and in the 2026/27 snapshot the first-half
// set runs GW2-19 and the second GW20-38. Advice to hold a chip for a gameweek
// past its own expiry is not merely unhelpful, it is wrong, and it is the exact
// mistake a season-long scan invites. Every structural window below is clipped
// to the chip's own, and a chip whose window has closed is reported as closed.

import type { Element, Fixture } from "./types";
import { makeFixtureIndex } from "./xp";

/** What the published calendar says about one gameweek. */
export interface GwStructure {
  gw: number;
  /** Clubs in YOUR squad with two or more fixtures that gameweek. */
  yourDoubles: number;
  /** Clubs in YOUR squad with no fixture at all. */
  yourBlanks: number;
  /** Clubs across the whole league with two or more fixtures. */
  leagueDoubles: number;
  /** Clubs across the whole league with no fixture. */
  leagueBlanks: number;
}

/**
 * Walk the published calendar over a range of gameweeks.
 *
 * `leagueBlanks` counts against the 20 clubs in the league, so it is only
 * meaningful once every club is accounted for; a gameweek absent from the
 * fixture index entirely is skipped rather than reported as twenty blanks,
 * which is what an off-by-one in the range would otherwise produce.
 */
export function seasonStructure(
  fixtures: Fixture[],
  squad: Element[],
  fromGw: number,
  toGw: number,
  leagueTeamIds: number[]
): GwStructure[] {
  const index = makeFixtureIndex(fixtures);
  const squadTeams = new Set(squad.map((e) => e.team));
  const out: GwStructure[] = [];
  for (let gw = fromGw; gw <= toGw; gw++) {
    const byTeam = index.get(gw);
    if (!byTeam) continue;
    let yourDoubles = 0;
    let yourBlanks = 0;
    for (const t of squadTeams) {
      const n = byTeam.get(t)?.length ?? 0;
      if (n >= 2) yourDoubles++;
      else if (n === 0) yourBlanks++;
    }
    let leagueDoubles = 0;
    let leagueBlanks = 0;
    for (const t of leagueTeamIds) {
      const n = byTeam.get(t)?.length ?? 0;
      if (n >= 2) leagueDoubles++;
      else if (n === 0) leagueBlanks++;
    }
    out.push({ gw, yourDoubles, yourBlanks, leagueDoubles, leagueBlanks });
  }
  return out;
}

/**
 * The window a chip must be played in, from `bootstrap.chips`.
 *
 * Returns the EARLIEST window that is still open at `nextEvent`, because that
 * is the one whose expiry constrains the reader now. A null means the game has
 * published no window for it, and every caller then declines to reason about
 * timing rather than assuming the season.
 */
export function chipWindow(
  chipName: string,
  bootstrapChips: { name: string; start_event: number; stop_event: number }[] | null | undefined,
  nextEvent: number
): { start: number; stop: number } | null {
  if (!bootstrapChips || bootstrapChips.length === 0) return null;
  const mine = bootstrapChips
    .filter((c) => c.name === chipName)
    .sort((a, b) => a.stop_event - b.stop_event);
  if (mine.length === 0) return null;
  /*
   * "THE GAME PUBLISHED NO WINDOW" AND "EVERY WINDOW HAS PASSED" ARE DIFFERENT
   * ANSWERS, and returning null for both conflated them — a chip read in GW25
   * whose only window ended at GW19 came back as unknown, so the advisor
   * declined to say anything instead of saying it had expired. The last window
   * is returned once they have all closed; `chipTiming` compares `nextEvent`
   * against `stop` and reports the expiry.
   */
  const open = mine.find((c) => nextEvent <= c.stop_event) ?? mine[mine.length - 1];
  return { start: open.start_event, stop: open.stop_event };
}

/**
 * Which chip a gameweek's SHAPE argues for, if any.
 *
 * Deliberately crude, and deliberately not a score. A gameweek where clubs play
 * twice is when a Bench Boost and a Triple Captain are worth most; a gameweek
 * where clubs have no fixture is when a Free Hit is. That is the whole of what
 * the calendar can say on its own, and dressing it up as a projected gain would
 * be inventing the part the calendar does not know.
 */
export function structuralWindows(
  chip: string,
  structure: GwStructure[]
): GwStructure[] {
  switch (chip) {
    case "bboost":
    case "3xc":
      // Your own clubs, because both chips act on players you already hold.
      return structure.filter((s) => s.yourDoubles > 0).sort((a, b) => b.yourDoubles - a.yourDoubles);
    case "freehit":
      // A Free Hit answers a gameweek you cannot field a team in, and that is a
      // question about YOUR squad — but a league-wide blank is what creates the
      // opportunity, because it also means a fresh squad can be built entirely
      // from the clubs that do play.
      return structure
        .filter((s) => s.yourBlanks > 0 || s.leagueBlanks > 0)
        .sort((a, b) => b.yourBlanks - a.yourBlanks || b.leagueBlanks - a.leagueBlanks);
    case "wildcard":
      // A Wildcard is not a one-week chip and no single gameweek's shape argues
      // for it. What does is the gameweek BEFORE a run of doubles or blanks, and
      // "before" is a judgement about a plan rather than a fact about a
      // calendar, so this reports the fixture events themselves and lets the
      // caller phrase it.
      return structure
        .filter((s) => s.leagueDoubles > 0 || s.leagueBlanks > 0)
        .sort((a, b) => a.gw - b.gw);
    default:
      return [];
  }
}

export type ChipTimingVerdict =
  | "closed"
  | "not-yet-open"
  | "structural-window-ahead"
  | "nothing-structural"
  | "unknown-window";

/** A flagged gameweek that was worth scoring, and what it scored. */
export interface ScoredWindow {
  gw: number;
  structure: GwStructure;
  /** Expected points for this chip in this gameweek. Fixture-driven only. */
  gain: number;
}

export interface ChipTiming {
  chip: string;
  window: { start: number; stop: number } | null;
  /** Gameweeks inside the chip's own window whose shape favours it. */
  windows: GwStructure[];
  /**
   * The flagged gameweeks that were also scored, best first.
   *
   * Empty whenever the calendar flagged nothing — which pre-season is always,
   * and which is why this costs nothing until there is a reason to spend it.
   */
  scored: ScoredWindow[];
  verdict: ChipTimingVerdict;
  /** One sentence, in the app's voice. Empty when there is nothing to add. */
  note: string;
}

/**
 * The smallest gain worth reporting as a better gameweek.
 *
 * MEASURED, and it is a noise floor rather than a tuned parameter. Projecting
 * the whole first-half window on the 2026-08-07 snapshot with a calendar
 * containing no blanks and no doubles, the app's own drafted squad produced a
 * bench-xP spread of 0.91 points across nineteen gameweeks — that is what
 * "identical weeks" looks like through this model. A recommendation resting on
 * less than that is reporting the shape of the flat surface, not a fixture.
 *
 * Real structure clears it by a distance and is in no danger from it: the
 * injected GW30 double moved the bench by 4.25 points, more than four times
 * this.
 *
 * The constant stays at 0.9 rather than tracking the spread to two decimals.
 * It is the order of magnitude that carries the argument, and re-fitting a
 * noise floor to each week's snapshot is the sort of false precision the value
 * exists to prevent.
 */
export const MATERIAL_GAIN = 0.9;

export interface ChipScoring {
  /** Expected points for this chip in a given gameweek. */
  scoreGw: (gw: number) => number;
  /** The best this chip scored inside the projection horizon. */
  inHorizonBest: number;
  /** How many flagged gameweeks to score. The calendar rarely offers many. */
  limit?: number;
}

/**
 * Timing advice for one chip, over the rest of its own window.
 *
 * This never contradicts the scored figure the optimizer computes inside the
 * projection horizon — it sits beside it. The scored number answers "what is it
 * worth if I play it in the next few weeks"; this answers "is there a gameweek
 * further out that the calendar already says is better", which is a different
 * question and the one that was missing.
 */
export function chipTiming(
  chip: string,
  fixtures: Fixture[],
  squad: Element[],
  leagueTeamIds: number[],
  nextEvent: number,
  lastEvent: number,
  bootstrapChips: { name: string; start_event: number; stop_event: number }[] | null | undefined,
  /** Gameweeks already scored on expected points, which need no flagging. */
  horizonEnd: number,
  /**
   * How to score a flagged gameweek. Optional: without it this stays a purely
   * structural read, which is all the caller can offer if it has no projection
   * reaching that far.
   */
  scoring?: ChipScoring
): ChipTiming {
  const window = chipWindow(chip, bootstrapChips, nextEvent);
  if (window === null) {
    return { chip, window: null, windows: [], scored: [], verdict: "unknown-window", note: "" };
  }
  if (nextEvent > window.stop) {
    return {
      chip,
      window,
      windows: [],
      scored: [],
      verdict: "closed",
      note: `This chip's window closed after GW${window.stop}.`,
    };
  }
  // Only look BEYOND what the projection already scored, and never past the
  // chip's own expiry — advice to hold for a gameweek the chip cannot be played
  // in is worse than no advice.
  const from = Math.max(nextEvent, horizonEnd + 1, window.start);
  const to = Math.min(lastEvent, window.stop);
  if (from > to) {
    return {
      chip,
      window,
      windows: [],
      scored: [],
      verdict: "nothing-structural",
      note:
        window.start > nextEvent
          ? `Playable from GW${window.start}.`
          : `The projection already covers the rest of this chip's window (to GW${window.stop}).`,
    };
  }
  const structure = seasonStructure(fixtures, squad, from, to, leagueTeamIds);
  const windows = structuralWindows(chip, structure);
  if (windows.length === 0) {
    return {
      chip,
      window,
      windows: [],
      scored: [],
      verdict: "nothing-structural",
      // Pre-season this is the honest answer for every chip and every gameweek:
      // the opening fixture list is one match per club per gameweek, so there
      // is not a single blank or double in it. They appear later, as cup runs
      // and postponements force rescheduling. Saying "no better week ahead"
      // would read as a finding; this says the calendar has not spoken yet.
      note: `No blank or double gameweeks are scheduled yet between GW${from} and GW${to}.`,
    };
  }

  const shortlist = windows.slice(0, 3);
  // SCORE ONLY WHAT THE CALENDAR FLAGGED. Scoring the whole window would be
  // affordable — horizon 29 costs about the same as horizon 5 — and useless:
  // with no blank or double in it the surface is flat to within `MATERIAL_GAIN`
  // and an argmax over it is noise. A flagged gameweek is a reason to spend the
  // computation, and there is no reason without one.
  const scored: ScoredWindow[] = scoring
    ? shortlist
        .slice(0, scoring.limit ?? 3)
        .map((s) => ({ gw: s.gw, structure: s, gain: scoring.scoreGw(s.gw) }))
        .sort((a, b) => b.gain - a.gain)
    : [];

  const best = scored[0];
  if (best && scoring) {
    const edge = best.gain - scoring.inHorizonBest;
    // A scored gameweek only earns a recommendation if it beats what the
    // horizon already found by more than the flat-surface spread. Otherwise the
    // structure is still worth naming — it is a fact about the calendar — but
    // the app must not pretend it has found a better week.
    if (edge < MATERIAL_GAIN) {
      return {
        chip,
        window,
        windows: shortlist,
        scored,
        verdict: "nothing-structural",
        note: `${describeStructureOnly(best.structure, chip)} — but it projects ${best.gain.toFixed(1)} pts against ${scoring.inHorizonBest.toFixed(1)} for the best week already in range, which is not a difference worth waiting for.`,
      };
    }
    return {
      chip,
      window,
      windows: shortlist,
      scored,
      verdict: "structural-window-ahead",
      note: `${describeWindow(chip, best.structure, window.stop)} It projects ~${best.gain.toFixed(1)} pts there against ${scoring.inHorizonBest.toFixed(1)} now — on fixtures alone, with no team news that far out.`,
    };
  }

  return {
    chip,
    window,
    windows: shortlist,
    scored,
    verdict: "structural-window-ahead",
    note: describeWindow(chip, shortlist[0], window.stop),
  };
}

function describeStructureOnly(s: GwStructure, chip: string): string {
  if (chip === "freehit" && s.yourBlanks > 0) {
    return `GW${s.gw} leaves ${s.yourBlanks} of your clubs without a fixture`;
  }
  if (s.yourDoubles > 0) return `GW${s.gw} is a double gameweek for ${s.yourDoubles} of your clubs`;
  if (s.leagueBlanks > 0) return `GW${s.gw} is a blank gameweek for ${s.leagueBlanks} clubs`;
  return `GW${s.gw} has ${s.leagueDoubles} clubs playing twice`;
}

function describeWindow(chip: string, s: GwStructure, stop: number): string {
  const tail = ` Window closes after GW${stop}.`;
  switch (chip) {
    case "bboost":
    case "3xc":
      return `GW${s.gw} is a double gameweek for ${s.yourDoubles} of your clubs — worth revisiting nearer the time.${tail}`;
    case "freehit":
      return s.yourBlanks > 0
        ? `GW${s.gw} currently leaves ${s.yourBlanks} of your clubs without a fixture.${tail}`
        : `GW${s.gw} is a blank gameweek for ${s.leagueBlanks} clubs.${tail}`;
    case "wildcard":
      return s.leagueDoubles > 0
        ? `GW${s.gw} has ${s.leagueDoubles} clubs playing twice — a squad built for it needs the transfers in hand beforehand.${tail}`
        : `GW${s.gw} has ${s.leagueBlanks} clubs without a fixture — a squad built for it needs the transfers in hand beforehand.${tail}`;
    default:
      return "";
  }
}
