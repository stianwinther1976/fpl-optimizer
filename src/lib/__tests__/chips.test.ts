import { describe, expect, it } from "vitest";
import { MATERIAL_GAIN, chipTiming, chipWindow, seasonStructure, structuralWindows } from "../chips";
import type { Element, Fixture } from "../types";

const LEAGUE = [1, 2, 3, 4];

const el = (id: number, team: number): Element =>
  ({ id, team, web_name: `P${id}`, element_type: 3, now_cost: 50 }) as Element;

/** One squad club (1) and a league of four. */
const squad = [el(1, 1), el(2, 1)];

/**
 * `event -> [[home, away], ...]`. Anything not listed for a gameweek is a club
 * without a fixture, which is what a blank IS.
 */
function fixturesFrom(spec: Record<number, [number, number][]>): Fixture[] {
  const out: Fixture[] = [];
  let id = 1;
  for (const [ev, pairs] of Object.entries(spec)) {
    for (const [h, a] of pairs) {
      out.push({ id: id++, event: Number(ev), team_h: h, team_a: a } as Fixture);
    }
  }
  return out;
}

const CHIPS = [
  { name: "wildcard", start_event: 2, stop_event: 19 },
  { name: "wildcard", start_event: 20, stop_event: 38 },
  { name: "bboost", start_event: 1, stop_event: 19 },
  { name: "bboost", start_event: 20, stop_event: 38 },
];

describe("seasonStructure", () => {
  it("separates your clubs from the league", () => {
    // GW5: club 1 (yours) plays twice; club 4 does not play at all.
    const fx = fixturesFrom({
      5: [
        [1, 2],
        [1, 3],
      ],
    });
    const [s] = seasonStructure(fx, squad, 5, 5, LEAGUE);
    expect(s.yourDoubles).toBe(1);
    expect(s.yourBlanks).toBe(0);
    expect(s.leagueDoubles).toBe(1);
    expect(s.leagueBlanks).toBe(1); // club 4
  });

  it("counts a club with no fixture as a blank, for you and for the league", () => {
    const fx = fixturesFrom({ 6: [[2, 3]] });
    const [s] = seasonStructure(fx, squad, 6, 6, LEAGUE);
    expect(s.yourBlanks).toBe(1); // club 1 does not play
    expect(s.leagueBlanks).toBe(2); // clubs 1 and 4
  });

  it("skips a gameweek with no fixtures at all rather than calling it 20 blanks", () => {
    // A range that runs past the end of the calendar must not manufacture a
    // league-wide blank out of an off-by-one.
    const fx = fixturesFrom({ 5: [[1, 2]] });
    expect(seasonStructure(fx, squad, 5, 8, LEAGUE).map((s) => s.gw)).toEqual([5]);
  });
});

describe("chipWindow", () => {
  it("returns the earliest window still open, because that is the one that expires next", () => {
    expect(chipWindow("wildcard", CHIPS, 5)).toEqual({ start: 2, stop: 19 });
  });

  it("moves to the second window once the first has closed", () => {
    expect(chipWindow("wildcard", CHIPS, 25)).toEqual({ start: 20, stop: 38 });
  });

  it("still calls the LAST legal gameweek open, not already closed", () => {
    /*
     * THE BOUNDARY, WHICH WAS NEVER TESTED AT THE BOUNDARY.
     *
     * The tests around this probed GW5, GW20 and GW25 — comfortably inside and
     * comfortably outside — so `nextEvent <= c.stop_event` could be flipped to
     * `<` with the whole suite still green. Mutation-tested: with `<`,
     * `chipWindow("wildcard", CHIPS, 19)` returns the SECOND window, and the
     * advisor answers a GW19 reader about GW20-38 while silently writing off
     * the expiring window's last playable week. CLAUDE.md names this rule as
     * one the tests pin; it did not.
     */
    expect(chipWindow("wildcard", CHIPS, 19)).toEqual({ start: 2, stop: 19 });
    // And the very next gameweek is the first that belongs to the second.
    expect(chipWindow("wildcard", CHIPS, 20)).toEqual({ start: 20, stop: 38 });
    // The opening gameweek of a window is inside it too.
    expect(chipWindow("wildcard", CHIPS, 2)).toEqual({ start: 2, stop: 19 });
  });

  it("declines to reason at all when the game publishes no windows", () => {
    // Assuming "the whole season" would be a guess about the rules, and the
    // rules changed in 2025/26. Callers treat null as "say nothing".
    expect(chipWindow("wildcard", null, 5)).toBeNull();
    expect(chipWindow("wildcard", [], 5)).toBeNull();
  });
});

describe("structuralWindows", () => {
  const struct = [
    { gw: 10, yourDoubles: 0, yourBlanks: 2, leagueDoubles: 0, leagueBlanks: 6 },
    { gw: 12, yourDoubles: 3, yourBlanks: 0, leagueDoubles: 4, leagueBlanks: 0 },
  ];

  it("sends the bench and armband chips to the doubles", () => {
    for (const chip of ["bboost", "3xc"]) {
      expect(structuralWindows(chip, struct).map((s) => s.gw)).toEqual([12]);
    }
  });

  it("sends the Free Hit to the blanks", () => {
    expect(structuralWindows("freehit", struct).map((s) => s.gw)).toEqual([10]);
  });
});

/*
 * The case that makes this worth having: advice to hold a chip for a gameweek
 * it cannot be played in is not unhelpful, it is wrong — and a season-long scan
 * is exactly what invites it.
 */
describe("chipTiming never points past the chip's own expiry", () => {
  // A juicy double gameweek in GW25, and a chip that dies at GW19.
  const fx = fixturesFrom({
    12: [[2, 3]],
    25: [
      [1, 2],
      [1, 3],
    ],
  });

  it("ignores a double gameweek beyond the window", () => {
    const t = chipTiming("bboost", fx, squad, LEAGUE, 5, 38, CHIPS, 8);
    expect(t.window).toEqual({ start: 1, stop: 19 });
    expect(t.windows.every((w) => w.gw <= 19)).toBe(true);
    expect(t.verdict).toBe("nothing-structural");
    expect(t.note).not.toMatch(/GW25/);
  });

  it("finds that same double once the second window is the one in hand", () => {
    // Same calendar, same chip, read from GW20: now GW25 is inside the window
    // and the advice flips. The window is doing the work, not the fixtures.
    const t = chipTiming("bboost", fx, squad, LEAGUE, 20, 38, CHIPS, 23);
    expect(t.verdict).toBe("structural-window-ahead");
    expect(t.windows[0].gw).toBe(25);
    expect(t.note).toMatch(/GW25/);
    expect(t.note).toMatch(/closes after GW38/);
  });

  it("says the window is closed rather than searching a season it cannot use", () => {
    const closed = [{ name: "bboost", start_event: 1, stop_event: 19 }];
    const t = chipTiming("bboost", fx, squad, LEAGUE, 25, 38, closed, 28);
    expect(t.verdict).toBe("closed");
    expect(t.windows).toEqual([]);
  });

  it("treats the window's last gameweek as playable, not closed", () => {
    /*
     * `nextEvent > window.stop` is the other half of the same boundary, and it
     * was also only ever probed from a distance. Flipped to `>=`, a reader
     * standing on the final gameweek of a window is told the chip has expired
     * while they can still play it — the worst possible week to be wrong.
     */
    const closing = [{ name: "bboost", start_event: 1, stop_event: 19 }];
    const t = chipTiming("bboost", fx, squad, LEAGUE, 19, 38, closing, 19);
    expect(t.verdict).not.toBe("closed");
    const after = chipTiming("bboost", fx, squad, LEAGUE, 20, 38, closing, 20);
    expect(after.verdict).toBe("closed");
  });

  it("does not re-flag gameweeks the projection already scored", () => {
    // The scored figure and the structural note answer different questions, and
    // a gameweek inside the horizon has already been answered in points. Here
    // the horizon reaches GW25, so there is nothing left to flag.
    const t = chipTiming("bboost", fx, squad, LEAGUE, 20, 38, CHIPS, 25);
    expect(t.windows.every((w) => w.gw > 25)).toBe(true);
  });
});

describe("chipTiming pre-season", () => {
  it("says the calendar has not spoken rather than that there is nothing to wait for", () => {
    // The opening fixture list is one match per club per gameweek — measured on
    // the 2026/27 snapshot, 380 fixtures across 38 gameweeks with not a single
    // blank or double in it. They appear later, as cup runs and postponements
    // force rescheduling. "No better week ahead" would read as a finding; this
    // has to read as an absence of data.
    const clean: Record<number, [number, number][]> = {};
    for (let gw = 1; gw <= 38; gw++) {
      clean[gw] = [
        [1, 2],
        [3, 4],
      ];
    }
    const t = chipTiming("bboost", fixturesFrom(clean), squad, LEAGUE, 1, 38, CHIPS, 5);
    expect(t.verdict).toBe("nothing-structural");
    expect(t.note).toMatch(/No blank or double gameweeks are scheduled yet/);
    expect(t.note).toMatch(/GW6 and GW19/);
  });
});

/*
 * Scoring a flagged gameweek.
 *
 * The measurement that motivates all of this: projecting the whole first-half
 * window on the 2026-08-07 snapshot, with no blank or double anywhere in the
 * calendar, bench xP ran 11.37 to 12.28 across nineteen gameweeks — the best
 * week beat the best-inside-five by 0.12 points. A far-out projection does not
 * go wild, it goes flat, and an argmax over a surface that flat is noise. So a
 * scored gameweek has to clear `MATERIAL_GAIN` before it is allowed to become
 * a recommendation.
 */
describe("chipTiming scores the gameweeks the calendar flagged", () => {
  const fx = fixturesFrom({
    12: [[2, 3]],
    25: [
      [1, 2],
      [1, 3],
    ],
  });

  it("does not score anything when the calendar flagged nothing", () => {
    // The point of scoring only flagged weeks: pre-season this never runs.
    let calls = 0;
    const clean: Record<number, [number, number][]> = {};
    for (let gw = 1; gw <= 38; gw++) clean[gw] = [[1, 2], [3, 4]];
    const t = chipTiming("bboost", fixturesFrom(clean), squad, LEAGUE, 1, 38, CHIPS, 5, {
      scoreGw: () => {
        calls++;
        return 99;
      },
      inHorizonBest: 1,
    });
    expect(calls).toBe(0);
    expect(t.scored).toEqual([]);
  });

  it("scores the flagged gameweeks and no others", () => {
    // The efficiency claim the whole design rests on, and it is a claim about
    // MEANING as much as cost: an unflagged gameweek has nothing to separate it
    // from its neighbours, so scoring it produces a number whose only job would
    // be to lose an argmax by noise. Here GW22 through GW38 are ordinary and
    // only GW25 is a double; the scorer must see GW25 alone.
    const many: Record<number, [number, number][]> = {};
    for (let gw = 21; gw <= 30; gw++) many[gw] = [[1, 2], [3, 4]];
    many[25] = [
      [1, 2],
      [1, 3],
      [2, 4],
    ];
    const seen: number[] = [];
    chipTiming("bboost", fixturesFrom(many), squad, LEAGUE, 20, 38, CHIPS, 21, {
      scoreGw: (gw) => {
        seen.push(gw);
        return 20;
      },
      inHorizonBest: 1,
    });
    expect(seen).toEqual([25]);
  });

  it("puts the noise floor exactly where MATERIAL_GAIN says, not somewhere in a range", () => {
    /*
     * The pair of tests around this bracket the floor only at 0.4 and 5.0, so
     * mutation-testing moved `MATERIAL_GAIN` from 0.9 to 1.35 with the whole
     * suite green — an order of magnitude of slack on a value CLAUDE.md
     * presents as a MEASURED noise floor. A gain either side of the constant
     * is what actually pins it.
     *
     * Read against the constant rather than a literal 0.9: the number is
     * allowed to change when someone re-measures it, but the boundary must go
     * on changing with it.
     */
    const at = (gain: number) =>
      chipTiming("bboost", fx, squad, LEAGUE, 20, 38, CHIPS, 23, {
        scoreGw: () => 10 + gain,
        inHorizonBest: 10,
      }).verdict;

    /*
     * THE FLOOR ITSELF IS IMMATERIAL. `MATERIAL_GAIN`'s own doc and CLAUDE.md
     * both say a flagged week must beat the in-horizon best BY MORE THAN the
     * floor; the code said `edge < MATERIAL_GAIN`, which recommends on exactly
     * the floor. Measure-zero on real projections — the point is that the
     * constant meant one thing in the prose and another in the code.
     *
     * AND THIS TEST COULD NOT SEE IT. It fed `10 + MATERIAL_GAIN` and
     * subtracted 10, which in binary floating point is 0.9000000000000004 and
     * lands the same side of the comparison either way, so all three cases were
     * identical under `<` and `<=`. The edge is now constructed so that it is
     * exactly the floor.
     */
    const atEdge = (edge: number) =>
      chipTiming("bboost", fx, squad, LEAGUE, 20, 38, CHIPS, 23, {
        scoreGw: () => edge,
        inHorizonBest: 0,
      }).verdict;
    expect(atEdge(MATERIAL_GAIN + 0.01)).toBe("structural-window-ahead");
    expect(atEdge(MATERIAL_GAIN)).not.toBe("structural-window-ahead");
    expect(at(MATERIAL_GAIN + 0.01)).toBe("structural-window-ahead");
    // Just under: the double is still NAMED — it is a fact about the calendar —
    // but the app must not recommend waiting for it.
    expect(at(MATERIAL_GAIN - 0.01)).not.toBe("structural-window-ahead");
  });

  it("recommends a flagged gameweek that clears the noise floor", () => {
    const t = chipTiming("bboost", fx, squad, LEAGUE, 20, 38, CHIPS, 23, {
      scoreGw: () => 16,
      inHorizonBest: 11,
    });
    expect(t.verdict).toBe("structural-window-ahead");
    expect(t.scored[0]).toMatchObject({ gw: 25, gain: 16 });
    expect(t.note).toMatch(/GW25/);
    expect(t.note).toMatch(/16\.0 pts there against 11\.0/);
    // The caveat travels with the number, every time.
    expect(t.note).toMatch(/no team news/);
  });

  it("refuses to recommend a gameweek that only wins by noise", () => {
    // THE CASE THAT MATTERS. A double gameweek is a real fact about the
    // calendar and is still named — but if it projects no better than what the
    // horizon already found, the app must not tell anyone to wait for it.
    const t = chipTiming("bboost", fx, squad, LEAGUE, 20, 38, CHIPS, 23, {
      scoreGw: () => 11.4,
      inHorizonBest: 11.0,
    });
    expect(t.verdict).toBe("nothing-structural");
    expect(t.note).toMatch(/GW25 is a double gameweek/);
    expect(t.note).toMatch(/not a difference worth waiting for/);
  });

  it("stays a purely structural read when the caller offers no scorer", () => {
    // `planHorizon` and any future caller without a long projection must still
    // get the calendar read, not a crash or an empty note.
    const t = chipTiming("bboost", fx, squad, LEAGUE, 20, 38, CHIPS, 23);
    expect(t.verdict).toBe("structural-window-ahead");
    expect(t.scored).toEqual([]);
    expect(t.note).toMatch(/GW25/);
  });
});

describe("chipWindow picks the window that is actually open", () => {
  it("prefers an open window to a later one that closes sooner", () => {
    /*
     * The test was `nextEvent <= stop_event` against a list sorted by
     * `stop_event`, which finds the earliest window that has not CLOSED — not
     * one that has OPENED. Read at GW5 against `[{1, 38}, {20, 25}]` it
     * returned the GW20-25 window, so the advisor scanned GW20-25 and announced
     * "window closes after GW25" for a chip playable now and through GW38.
     */
    const chips = [
      { name: "bboost", start_event: 1, stop_event: 38 },
      { name: "bboost", start_event: 20, stop_event: 25 },
    ];
    expect(chipWindow("bboost", chips, 5)).toEqual({ start: 1, stop: 38 });
    // Inside both: the earlier-closing one is the binding constraint.
    expect(chipWindow("bboost", chips, 22)).toEqual({ start: 20, stop: 25 });
  });

  it("names the next window to open when none is open yet", () => {
    const chips = [{ name: "3xc", start_event: 20, stop_event: 38 }];
    expect(chipWindow("3xc", chips, 5)).toEqual({ start: 20, stop: 38 });
  });

  it("still reports the last window once they have all closed", () => {
    // "No window published" and "every window has passed" are different
    // answers, and the expiry has to survive this change.
    const chips = [
      { name: "freehit", start_event: 2, stop_event: 19 },
      { name: "freehit", start_event: 20, stop_event: 30 },
    ];
    expect(chipWindow("freehit", chips, 35)).toEqual({ start: 20, stop: 30 });
    expect(chipWindow("freehit", null, 35)).toBeNull();
    expect(chipWindow("freehit", [], 35)).toBeNull();
  });
});
