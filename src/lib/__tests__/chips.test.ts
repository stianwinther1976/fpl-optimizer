import { describe, expect, it } from "vitest";
import { chipTiming, chipWindow, seasonStructure, structuralWindows } from "../chips";
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
