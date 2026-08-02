// The in-season minutes model has two axes and until now recency only moved
// one of them. `recentStartsWeight` corrected `pStart` — how often he is in the
// eleven — while `minsPerStart` stayed at the season-long `minutes / starts`,
// so a player who used to finish matches and is now hooked on the hour was
// still priced on how long he played in August.
//
// Mean minutes over the last five team games is, measured against actual
// minutes on the full population (Spearman, mean over gameweeks), the best
// single minutes predictor available — better in all four archived seasons than
// the composite the model was building, and better than the start share the
// model already consumed:
//
//              model  recentStarts  form   recentMinutes
//   2022-23   0.7428     0.7381    0.7411     0.7789
//   2023-24   0.7349     0.7310    0.7457     0.7806
//   2024-25   0.7374     0.7350    0.7493     0.7806
//   2025-26   0.7561     0.7481    0.7719     0.7946
//
// These tests pin the mechanism, not that measurement: that the signal reaches
// `minsPerStart`, at the documented weight, with its two guards intact.

import { describe, expect, it } from "vitest";
import { projectAll, XP_CONFIG, XP_DEBUG } from "../xp";
import type { Bootstrap, Element, Fixture, RecentForm, Team } from "../types";

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

// One round of fixtures for the gameweek being projected (GW11). Nothing is
// finished, so `gamesByTeam` stays empty and `teamGames` falls back to the ten
// finished EVENTS — the same path the live app takes early in a season.
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

const TEAM_GAMES = 10;

/** An in-season outfielder: ten team games behind him, everything else neutral. */
function el(
  p: Partial<Element> & Pick<Element, "id" | "team" | "element_type" | "starts" | "minutes">
): Element {
  return {
    web_name: `P${p.id}`,
    first_name: "",
    second_name: "",
    now_cost: 60,
    cost_change_start: 0,
    form: "3.0",
    event_points: 3,
    status: "a",
    news: "",
    chance_of_playing_next_round: null,
    selected_by_percent: "10.0",
    total_points: 40,
    points_per_game: "4.0",
    goals_scored: 2,
    assists: 2,
    clean_sheets: 3,
    goals_conceded: 10,
    bonus: 5,
    ict_index: "60.0",
    expected_goals: "2.00",
    expected_assists: "2.00",
    expected_goal_involvements: "4.00",
    expected_goals_conceded: "10.00",
    defensive_contribution: 0,
    ep_next: "4.0",
    ...p,
  } as Element;
}

const events = Array.from({ length: 38 }, (_, i) => ({
  id: i + 1,
  name: `Gameweek ${i + 1}`,
  deadline_time: new Date(Date.UTC(2026, 7, 15 + i * 7)).toISOString(),
  finished: i + 1 <= TEAM_GAMES,
  is_current: i + 1 === TEAM_GAMES,
  is_next: i + 1 === TEAM_GAMES + 1,
  average_entry_score: 50,
  highest_score: 100,
}));

/** Project, and hand back the minutes model the projection actually used. */
function minutesOf(elements: Element[], recentForm?: Map<number, RecentForm>) {
  const bootstrap = { events, teams, elements, total_players: 1_167_938 } as unknown as Bootstrap;
  XP_DEBUG.minutes = new Map();
  try {
    const xp = projectAll({ pastSeason: undefined,
      bootstrap,
      fixtures,
      nextEvent: TEAM_GAMES + 1,
      horizon: 1,
      recentForm,
    });
    return { xp, mm: new Map(XP_DEBUG.minutes) };
  } finally {
    XP_DEBUG.minutes = null;
  }
}

/** One player's last-five record. */
const form = (startShare: number, minsPerGame: number, minsPerStart: number | null) =>
  new Map([[1, { startShare, minsPerGame, minsPerStart }]]);

describe("recent minutes reach minsPerStart", () => {
  // A nailed starter who finished every game: pStart 1.0, minsPerStart 90.
  const ever = () => el({ id: 1, team: 1, element_type: 3, starts: 10, minutes: 900 });

  it("weights recency the same on both minutes axes", () => {
    // 0.65 is not a fitted number. It is `recentStartsWeight`, reused, because
    // the two terms answer the same question about the same five games and
    // there was no honest basis for giving them different trust. Sweeping it
    // moved the points metrics by less than the noise between seasons.
    expect(XP_CONFIG.recentMinutesWeight).toBe(0.65);
    expect(XP_CONFIG.recentMinutesWeight).toBe(XP_CONFIG.recentStartsWeight);
  });

  it("blends recent minutes per start into the season figure at the configured weight", () => {
    const w = XP_CONFIG.recentMinutesWeight;
    const { mm } = minutesOf([ever()], form(1, 60, 60));
    // Started all five recent games and was hooked on the hour in each, against
    // a full ninety across the season.
    expect(mm.get(1)!.minsPerStart).toBeCloseTo(w * 60 + (1 - w) * 90, 6);
    // The start share is untouched by this term — he is still always picked.
    expect(mm.get(1)!.pStart).toBeCloseTo(1, 6);
  });

  it("uses the MEASURED minutes per start, not per-game minutes over the start share", () => {
    // The bug this replaced. A defender who starts two of five and is hooked at
    // 50 minutes, plus two substitute cameos: 128 minutes over five games.
    // Reconstructing from the marginals gives 25.6 / 0.4 = 64 implied minutes
    // per start — his cameos charged to his starts, and enough to push him over
    // the sixty-minute line the appearance point sits on. The rows say 50.
    const w = XP_CONFIG.recentMinutesWeight;
    const def = el({ id: 1, team: 1, element_type: 2, starts: 10, minutes: 900 });
    const { mm } = minutesOf([def], form(0.4, 25.6, 50));
    expect(mm.get(1)!.minsPerStart).toBeCloseTo(w * 50 + (1 - w) * 90, 6);
    // And the reconstruction it replaced would have landed elsewhere.
    expect(mm.get(1)!.minsPerStart).not.toBeCloseTo(w * 64 + (1 - w) * 90, 3);
  });

  it("leaves minsPerStart at the season value when the window records no starts", () => {
    // Not zero, not the per-game figure: `null` means "nothing measured", and
    // the season figure is the only evidence left about how long a start lasts.
    const { mm } = minutesOf([ever()], form(0, 0, null));
    expect(mm.get(1)!.minsPerStart).toBeCloseTo(90, 6);
  });

  it("holds minsPerStart to a full match even if the feed exceeds one", () => {
    // The archive harnesses build these records too. A 96 would otherwise blend
    // through to a player who is modelled as playing more than a whole match:
    // his season figure is 60, so capping first gives 0.65*90 + 0.35*60 = 79.5,
    // where letting 96 through would give 83.4.
    const w = XP_CONFIG.recentMinutesWeight;
    const sixty = el({ id: 1, team: 1, element_type: 3, starts: 10, minutes: 600 });
    const { mm } = minutesOf([sixty], form(1, 96, 96));
    expect(mm.get(1)!.minsPerStart).toBeCloseTo(w * 90 + (1 - w) * 60, 6);
    expect(mm.get(1)!.minsPerStart).toBeLessThan(90);
  });

  it("carries the reduction through share, and through to expected points", () => {
    // Two players identical in every published statistic and in how often they
    // start. They differ only in how long they stay on the pitch now.
    // Same club deliberately: on different clubs they would also be on
    // different sides of a home/away split, and the comparison would be
    // measuring that instead.
    const finisher = el({ id: 1, team: 1, element_type: 3, starts: 10, minutes: 900 });
    const hooked = el({ id: 2, team: 1, element_type: 3, starts: 10, minutes: 900 });
    const { xp, mm } = minutesOf(
      [finisher, hooked],
      new Map([
        [1, { startShare: 1, minsPerGame: 89, minsPerStart: 89 }],
        [2, { startShare: 1, minsPerGame: 55, minsPerStart: 55 }],
      ])
    );
    expect(mm.get(2)!.minsPerStart).toBeLessThan(mm.get(1)!.minsPerStart - 15);
    expect(mm.get(2)!.share).toBeLessThan(mm.get(1)!.share);
    // Fewer minutes on the pitch is fewer chances to score and a worse shot at
    // the sixty-minute appearance point, so it must cost expected points.
    expect(xp.get(2)!.next).toBeLessThan(xp.get(1)!.next);
  });

  it("does not resurrect a player with no season starts", () => {
    // Sub-only: `mm.minsPerStart` is 0 and, since he has started nothing
    // recently either, the record carries no minutes-per-start to raise it.
    // His minutes stay in `share`, where the sub-only branch put them.
    const subOnly = el({ id: 1, team: 1, element_type: 3, starts: 0, minutes: 150 });
    const { mm } = minutesOf([subOnly], form(0, 30, null));
    expect(mm.get(1)!.minsPerStart).toBe(0);
    // But they are not thrown away: 30 minutes a game is a real 0.333 share.
    expect(mm.get(1)!.share).toBeCloseTo(30 / 90, 6);
  });

  it("refuses a self-contradictory record rather than inventing a start", () => {
    // `minsPerStart` non-null with `startShare` zero cannot come out of any of
    // the three constructors, and if it ever did it would mean "he averages 80
    // minutes in the games he never started". Taking it at face value would
    // promote a player with no starts at all — season or recent — to a
    // 52-minute starter. The invariant is checked, not assumed.
    const subOnly = el({ id: 1, team: 1, element_type: 3, starts: 0, minutes: 150 });
    const { mm } = minutesOf([subOnly], form(0, 30, 80));
    expect(mm.get(1)!.minsPerStart).toBe(0);
  });
});
