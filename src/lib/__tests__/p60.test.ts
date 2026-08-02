// The sixty-minute probability is the model's floor. It pays the second
// appearance point, it gates every clean sheet, and for a keeper it scales the
// save term — so for a defender or a goalkeeper it is most of the projection.
//
// It used to be a step function of minutes-per-start: 1.0 from 60 minutes up,
// `(mps/60)*0.5` below. It is now a logistic fitted by maximum likelihood to
// 23,158 real starts, bucketed by the model's OWN minutes-per-start at the time
// of the prediction (see XP_CONFIG.p60Curve).
//
// Nothing in the suite noticed when the step was replaced, which is the reason
// this file exists: a silent rewrite of the term that carries every defender's
// floor should not be possible.

import { describe, expect, it } from "vitest";
import { p60GivenStart, XP_CONFIG, projectAll, XP_DEBUG } from "../xp";
import type { Bootstrap, Element, Fixture, RecentForm, Team } from "../types";

describe("p60GivenStart", () => {
  it("reproduces the measured table it was fitted to", () => {
    // Bucket midpoint -> observed P(played 60+ | started), from the three
    // seasons the constants were fitted on. This is the falsifiable claim the
    // config comment makes; if a future edit to the constants breaks it, the
    // comment has become a lie and this test says so.
    const measured: [number, number][] = [
      [62.5, 0.8],
      [67.5, 0.824],
      [72.5, 0.879],
      [77.5, 0.892],
      [82.5, 0.924],
      [87.5, 0.948],
      [90, 0.963],
    ];
    for (const [mps, observed] of measured) {
      expect(Math.abs(p60GivenStart(mps) - observed)).toBeLessThan(0.02);
    }
  });

  it("never promises certainty, however reliable the player", () => {
    // The single biggest error in the old step. A man who averages a full
    // ninety minutes still gets substituted, sent off or injured before the
    // hour in about one start in twenty-seven, and the model used to charge
    // that to nobody. 90 is the hard ceiling on minutes per start, so this is
    // the most optimistic value the term can ever take.
    expect(p60GivenStart(90)).toBeLessThan(0.97);
    expect(p60GivenStart(90)).toBeGreaterThan(0.94);
  });

  it("rises monotonically with minutes per start", () => {
    let prev = -1;
    for (let m = 1; m <= 90; m++) {
      const p = p60GivenStart(m);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it("has no cliff at the hour mark", () => {
    // The defect that made this urgent: `minsPerStart` is now a fast-moving
    // quantity fed by the last five games, and one minute of drift across 60
    // used to double a player's appearance points (0.492 -> 1.000). A minute
    // either side of the old step must now be worth about a minute.
    const jump = p60GivenStart(60) - p60GivenStart(59);
    const oldStep = 1 - (59 / 60) * 0.5; // what the step charged for that minute
    expect(jump).toBeLessThan(0.02);
    expect(jump * 20).toBeLessThan(oldStep);
    expect(jump).toBeGreaterThan(0);
  });

  it("treats zero minutes per start as 'does not start', not as a short start", () => {
    // `minsPerStart === 0` is the sub-only state and always arrives with
    // `pStart === 0`. Feeding it to the curve would return 0.08 rather than 0;
    // harmless as it stands, but it would make the term's meaning depend on a
    // coincidence in another function.
    expect(p60GivenStart(0)).toBe(0);
    expect(p60GivenStart(-5)).toBe(0);
  });

  it("keeps the fitted constants where the measurement put them", () => {
    // Not a sweep result — the maximum-likelihood fit over the 23,158 rows.
    expect(XP_CONFIG.p60Curve.intercept).toBeCloseTo(-2.441, 6);
    expect(XP_CONFIG.p60Curve.slope).toBeCloseTo(0.061, 6);
  });
});

// ---- end to end: the curve has to reach the projection ---------------------

const teams: Team[] = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  name: `Team ${i + 1}`,
  short_name: `T${i + 1}`,
  strength: 3,
  strength_overall_home: 1100,
  strength_overall_away: 1100,
  strength_attack_home: 0,
  strength_attack_away: 0,
  strength_defence_home: 0,
  strength_defence_away: 0,
}));

const fixtures: Fixture[] = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  event: 11,
  team_h: i * 2 + 1,
  team_a: i * 2 + 2,
  team_h_difficulty: 3,
  team_a_difficulty: 3,
  finished: false,
  started: false,
  kickoff_time: "2026-11-07T15:00:00Z",
  team_h_score: null,
  team_a_score: null,
}));

const events = Array.from({ length: 38 }, (_, i) => ({
  id: i + 1,
  name: `Gameweek ${i + 1}`,
  deadline_time: new Date(Date.UTC(2026, 7, 15 + i * 7)).toISOString(),
  finished: i + 1 <= 10,
  is_current: i + 1 === 10,
  is_next: i + 1 === 11,
  average_entry_score: 50,
  highest_score: 100,
}));

/** A defender, because the clean sheet makes p60 most of his projection. */
function def(id: number, team: number, minutes: number): Element {
  return {
    id,
    team,
    element_type: 2,
    starts: 10,
    minutes,
    web_name: `P${id}`,
    first_name: "",
    second_name: "",
    now_cost: 50,
    cost_change_start: 0,
    form: "3.0",
    event_points: 3,
    status: "a",
    news: "",
    chance_of_playing_next_round: null,
    selected_by_percent: "10.0",
    total_points: 40,
    points_per_game: "4.0",
    goals_scored: 1,
    assists: 1,
    clean_sheets: 4,
    goals_conceded: 10,
    bonus: 5,
    ict_index: "60.0",
    expected_goals: "1.00",
    expected_assists: "1.00",
    expected_goal_involvements: "2.00",
    expected_goals_conceded: "10.00",
    defensive_contribution: 0,
    ep_next: "4.0",
  } as unknown as Element;
}

function project(elements: Element[], recentForm?: Map<number, RecentForm>) {
  const bootstrap = { events, teams, elements, total_players: 1_167_938 } as unknown as Bootstrap;
  XP_DEBUG.minutes = new Map();
  try {
    const xp = projectAll({ pastSeason: undefined, bootstrap, fixtures, nextEvent: 11, horizon: 1, recentForm });
    return { xp, mm: new Map(XP_DEBUG.minutes) };
  } finally {
    XP_DEBUG.minutes = null;
  }
}

describe("the p60 curve reaches expected points", () => {
  it("prices the hour either side of 60 minutes smoothly", () => {
    // Two identical defenders whose recent minutes-per-start straddle the old
    // step. Under it, 61 was worth twice 59; the gap must now be small — but it
    // must NOT be zero, or the term has stopped responding to minutes at all.
    // Same club, so both are the home side of the same fixture and the only
    // thing separating them is the minute.
    const a = def(1, 1, 900);
    const b = def(2, 1, 900);
    const { xp } = project(
      [a, b],
      new Map([
        [1, { startShare: 1, minsPerGame: 59, minsPerStart: 59 }],
        [2, { startShare: 1, minsPerGame: 61, minsPerStart: 61 }],
      ])
    );
    const lo = xp.get(1)!.next;
    const hi = xp.get(2)!.next;
    expect(hi).toBeGreaterThan(lo);
    expect(hi / lo).toBeLessThan(1.06);
  });

  it("costs a nailed ninety-minute defender the certainty he used to be given", () => {
    // Same player, same everything, projected against the old step's answer.
    // The step gave p60 = 1.0; the curve gives ~0.955, so roughly 4.5% of the
    // appearance point and the clean sheet comes off. It has to actually show
    // up in the number, or the curve is not wired in.
    const { xp, mm } = project(
      [def(1, 1, 900)],
      new Map([[1, { startShare: 1, minsPerGame: 90, minsPerStart: 90 }]])
    );
    expect(mm.get(1)!.minsPerStart).toBeCloseTo(90, 6);
    // Reconstruct what the appearance term alone is worth under each rule.
    const p60 = p60GivenStart(90);
    expect(p60).toBeLessThan(1);
    expect(xp.get(1)!.next).toBeGreaterThan(0);
    // The projection must sit strictly below the same projection computed with
    // certainty, which is what temporarily flattening the curve reproduces.
    const saved = { ...XP_CONFIG.p60Curve };
    XP_CONFIG.p60Curve = { intercept: 100, slope: 0 }; // p60 = 1 for any mps > 0
    try {
      const certain = project(
        [def(1, 1, 900)],
        new Map([[1, { startShare: 1, minsPerGame: 90, minsPerStart: 90 }]])
      ).xp.get(1)!.next;
      expect(xp.get(1)!.next).toBeLessThan(certain);
    } finally {
      XP_CONFIG.p60Curve = saved;
    }
  });
});
