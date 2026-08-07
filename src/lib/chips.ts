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
// WHAT CAN BE SCORED AND WHAT CAN ONLY BE FLAGGED
// ---------------------------------------------------------------------------
//
// The fix is NOT to run the projection out to GW38. `projectAll` builds
// `perGw` over the horizon it is given, and a per-gameweek expected-points
// figure twenty weeks out would be a number with no evidence in it — the model
// has no team news, no form, and no idea who will be injured. Quoting one would
// break the rule this repo runs on.
//
// So this module keeps two registers, and never mixes them:
//
//   SCORED     — inside the projection horizon. Expected points, as before.
//   STRUCTURAL — beyond it. Fixture COUNTS only: who blanks, who plays twice.
//                Never a points claim.
//
// The fixture list is the one input that is trustworthy months ahead, because
// it is a schedule rather than a forecast. "Six of your clubs play twice in
// GW29" is a fact about a published calendar. "Your bench will score 14.2 in
// GW29" is not a fact about anything.
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

export interface ChipTiming {
  chip: string;
  window: { start: number; stop: number } | null;
  /** Gameweeks inside the chip's own window whose shape favours it. */
  windows: GwStructure[];
  verdict: ChipTimingVerdict;
  /** One sentence, in the app's voice. Empty when there is nothing to add. */
  note: string;
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
  horizonEnd: number
): ChipTiming {
  const window = chipWindow(chip, bootstrapChips, nextEvent);
  if (window === null) {
    return { chip, window: null, windows: [], verdict: "unknown-window", note: "" };
  }
  if (nextEvent > window.stop) {
    return {
      chip,
      window,
      windows: [],
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
      verdict: "nothing-structural",
      // Pre-season this is the honest answer for every chip and every gameweek:
      // the opening fixture list is one match per club per gameweek, so there
      // is not a single blank or double in it. They appear later, as cup runs
      // and postponements force rescheduling. Saying "no better week ahead"
      // would read as a finding; this says the calendar has not spoken yet.
      note: `No blank or double gameweeks are scheduled yet between GW${from} and GW${to}.`,
      };
  }
  const best = windows[0];
  return {
    chip,
    window,
    windows: windows.slice(0, 3),
    verdict: "structural-window-ahead",
    note: describeWindow(chip, best, window.stop),
  };
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
