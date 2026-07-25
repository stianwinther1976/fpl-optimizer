// Pre-season behaviour of the xP model.
//
// Before a ball is kicked there is no current-season data at all, and FPL's own
// feed is misleading in specific, verifiable ways: every strength rating is 0,
// `form` is "0.0", `defensive_contribution` has already been zeroed, and
// `ep_next` ignores minutes entirely (an unplayed backup keeper is given 2.6,
// the same as a nailed midfielder). Every number below was read from the live
// 2026/27 API on 2026-07-25.
//
// These tests pin the properties that matter for drafting a launch squad:
// the model must know who starts.

import { describe, expect, it } from "vitest";
import { projectAll } from "../xp";
import type { Bootstrap, Element, Fixture, PastSeasonStats, Team } from "../types";

// 20 real teams. Detailed attack/defence ratings are ALL ZERO pre-season, so
// the model falls back to FDR buckets — reproduced faithfully here.
const teams: Team[] = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  name: `Team ${i + 1}`,
  short_name: `T${i + 1}`,
  strength: 3,
  strength_overall_home: 3,
  strength_overall_away: 3,
  strength_attack_home: 0,
  strength_attack_away: 0,
  strength_defence_home: 0,
  strength_defence_away: 0,
}));

// Real GW1 pairings and difficulties.
const FX: [number, number, number, number][] = [
  [1, 7, 2, 5], [11, 16, 4, 2], [9, 8, 3, 3], [12, 20, 2, 2], [18, 13, 2, 3],
  [4, 19, 3, 3], [5, 2, 3, 3], [15, 3, 3, 5], [17, 14, 4, 3], [10, 6, 4, 3],
];
const fixtures: Fixture[] = FX.map(([h, a, hd, ad], i) => ({
  id: i + 1,
  event: 1,
  team_h: h,
  team_a: a,
  team_h_difficulty: hd,
  team_a_difficulty: ad,
  finished: false,
  started: false,
  kickoff_time: "2026-08-22T14:00:00Z",
  team_h_score: null,
  team_a_score: null,
}));

function el(p: Partial<Element> & Pick<Element, "id" | "web_name" | "team" | "element_type" | "now_cost">): Element {
  return {
    first_name: "",
    second_name: "",
    cost_change_start: 0,
    form: "0.0", // pre-season: zero for everyone
    event_points: 0,
    status: "a",
    news: "",
    chance_of_playing_next_round: null,
    selected_by_percent: "5.0",
    minutes: 0,
    starts: 0,
    total_points: 0,
    points_per_game: "0.0",
    goals_scored: 0,
    assists: 0,
    clean_sheets: 0,
    goals_conceded: 0,
    bonus: 0,
    ict_index: "0.0",
    expected_goals: "0.00",
    expected_assists: "0.00",
    expected_goal_involvements: "0.00",
    expected_goals_conceded: "0.00",
    defensive_contribution: 0, // FPL zeroes this before it zeroes minutes
    ep_next: "2.5",
    ...p,
  } as Element;
}

function project(elements: Element[], pastSeason?: Map<number, PastSeasonStats>) {
  const bootstrap = {
    events: [
      {
        id: 1,
        name: "Gameweek 1",
        deadline_time: "2026-08-21T17:30:00Z",
        finished: false,
        is_current: false,
        is_next: true,
        average_entry_score: 0,
        highest_score: null,
      },
    ],
    teams,
    elements,
    total_players: 1_167_938,
  } as unknown as Bootstrap;
  return projectAll({ bootstrap, fixtures, nextEvent: 1, horizon: 1, pastSeason });
}

describe("pre-season minutes model", () => {
  it("separates a nailed starter from a rotation player at the same price", () => {
    // Identical in every respect FPL publishes pre-season — price, ep_next,
    // points per game. Only last season's starts differ.
    const nailed = el({
      id: 1, web_name: "Nailed", team: 1, element_type: 2, now_cost: 55,
      minutes: 3420, starts: 38, total_points: 152, points_per_game: "4.0",
      ep_next: "3.0", bonus: 18, ict_index: "100.0",
      expected_goals: "2.0", expected_assists: "2.0",
    });
    const rotation = el({
      id: 2, web_name: "Rotation", team: 1, element_type: 2, now_cost: 55,
      minutes: 1260, starts: 14, total_points: 56, points_per_game: "4.0",
      ep_next: "3.0", bonus: 7, ict_index: "37.0",
      expected_goals: "0.74", expected_assists: "0.74",
    });
    const xp = project([nailed, rotation]);
    const a = xp.get(1)!.next;
    const b = xp.get(2)!.next;
    // Not a hair's breadth: ~38 starts vs ~14 is most of a season of evidence.
    expect(a).toBeGreaterThan(b * 1.5);
  });

  it("does not rate a keeper who has never played like a first-choice keeper", () => {
    // Live values: Raya 3330 min / 37 starts / ep_next 4.0 at £6.0m;
    // Meslier 0 min / 0 starts / ep_next 2.6 at £5.0m. FPL's own ep_next puts
    // Meslier above several nailed midfielders — the model must not follow it.
    //
    // The record has to be looked up for this to be knowable at all. Price
    // alone cannot separate them: a £5.0m keeper is what a mid-table club pays
    // for its number one, and refusing to guess from price is deliberate.
    //
    // Both clubs get their real deputy here, because a keeper's pre-season
    // projection is a share of one shirt and a share needs someone to share
    // with. An earlier version of this test listed each keeper alone at his
    // club, which is a squad the bootstrap cannot produce — every Premier
    // League club registers three to five — and it quietly asked the model to
    // rank two men who were never competing for the same place.
    const rayaDeputy = el({
      id: 2, web_name: "Setford", team: 1, element_type: 1, now_cost: 40,
    });
    const meslierRival = el({
      id: 4, web_name: "Darlow", team: 13, element_type: 1, now_cost: 45,
    });
    const raya = el({
      id: 1, web_name: "Raya", team: 1, element_type: 1, now_cost: 60,
      minutes: 3330, starts: 37, total_points: 162, points_per_game: "4.4",
      ep_next: "4.0", bonus: 11, ict_index: "57.5", saves: 95,
    });
    const backup = el({
      id: 3, web_name: "Meslier", team: 13, element_type: 1, now_cost: 50,
      ep_next: "2.6",
    });
    const past = new Map<number, PastSeasonStats>([
      [1, {
        points: 162, minutes: 3330, starts: 37, saves: 95, bonus: 11, ict: 57.5,
        plSeasons: 1, seasonName: "2025/26",
        seasons: [{ seasonName: "2025/26", minutes: 3330, starts: 37 }],
      }],
      // Registered all season, never picked. That is evidence, and it is the
      // opposite of the "no record at all" of a new signing.
      [3, {
        points: 0, minutes: 0, plSeasons: 1,
        seasons: [{ seasonName: "2025/26", minutes: 0, starts: 0 }],
      }],
      [2, { points: 0, minutes: 0, plSeasons: 1,
        seasons: [{ seasonName: "2025/26", minutes: 0, starts: 0 }] }],
      [4, { points: 900, minutes: 1800, starts: 20, saves: 60, plSeasons: 1,
        seasonName: "2025/26",
        seasons: [{ seasonName: "2025/26", minutes: 1800, starts: 20 }] }],
    ]);
    const xp = project([raya, rayaDeputy, backup, meslierRival], past);
    // Comfortably clear, but not the 3x this asserted when a keeper's rivals
    // were missing from the fixture. Meslier is £5.0m against a £4.5m deputy,
    // and the fitted allocation (see `gkPreseason`) makes price the loudest
    // pre-season signal about who a club expects to pick — so it puts the two
    // of them close to even and Meslier's zero-minute record does the rest.
    // Talking him down further would be a claim the three seasons of outcome
    // data behind those constants do not support.
    expect(xp.get(1)!.next).toBeGreaterThan(2.5 * xp.get(3)!.next);
    // And the reason is competition he loses, not the position being written
    // off: his own club's deputy, who actually played, outscores him.
    expect(xp.get(4)!.next).toBeGreaterThan(xp.get(3)!.next * 2);
  });

  it("gives a player with no Premier League record a price-based estimate, not zero", () => {
    // A marquee signing from abroad has no history_past at all. Writing him off
    // would be as wrong as trusting him blindly.
    const signing = el({
      id: 1, web_name: "New signing", team: 1, element_type: 3, now_cost: 85, ep_next: "3.5",
    });
    const filler = el({
      id: 2, web_name: "Squad filler", team: 1, element_type: 3, now_cost: 45, ep_next: "1.5",
    });
    const xp = project([signing, filler]);
    expect(xp.get(1)!.next).toBeGreaterThan(1.5);
    expect(xp.get(1)!.next).toBeGreaterThan(xp.get(2)!.next * 1.5);
  });
});

describe("pre-season defensive contribution", () => {
  it("credits DC from last season even though the bootstrap has been zeroed", () => {
    // Two identical centre-backs; only last season's defensive-action count
    // differs. Saliba's real 2025/26 line is 193 actions in 2614 minutes.
    const base = {
      team: 1, element_type: 2 as const, now_cost: 55, minutes: 2614, starts: 30,
      total_points: 137, points_per_game: "4.4", ep_next: "2.5",
    };
    const high = el({ id: 1, web_name: "High DC", ...base });
    const low = el({ id: 2, web_name: "Low DC", ...base });
    const past = new Map<number, PastSeasonStats>([
      [1, { points: 137, minutes: 2614, starts: 30, defensiveContribution: 193,
            seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 2614, starts: 30 }] }],
      [2, { points: 137, minutes: 2614, starts: 30, defensiveContribution: 40,
            seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 2614, starts: 30 }] }],
    ]);
    const xp = project([high, low], past);
    expect(xp.get(1)!.next).toBeGreaterThan(xp.get(2)!.next);
  });
});

describe("survives FPL's summer reset of the bootstrap", () => {
  it("still ranks players correctly when every bootstrap counter is zero", () => {
    // Some weeks before GW1, FPL wipes minutes/starts/points too. From then on
    // element-summary's history_past is the only record of who plays.
    const a = el({ id: 1, web_name: "Nailed", team: 1, element_type: 3, now_cost: 70, ep_next: "3.0" });
    const b = el({ id: 2, web_name: "Fringe", team: 1, element_type: 3, now_cost: 70, ep_next: "3.0" });
    const past = new Map<number, PastSeasonStats>([
      [1, { points: 190, minutes: 3100, starts: 35, goals: 12, assists: 9, xg: 10.5, xa: 8.1, bonus: 22, ict: 320,
            seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 3100, starts: 35 }] }],
      [2, { points: 34, minutes: 620, starts: 5, goals: 1, assists: 1, xg: 1.2, xa: 0.9, bonus: 2, ict: 45,
            seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 620, starts: 5 }] }],
    ]);
    const xp = project([a, b], past);
    expect(xp.get(1)!.next).toBeGreaterThan(xp.get(2)!.next * 2);
  });

  it("does not read a season that predates a stat as a season of zeroes", () => {
    // history_past rows before 2022/23 carry no xG. Treating that as "0 xG in
    // 3000 minutes" would regress a proven striker to nothing.
    const withXg = el({ id: 1, web_name: "With xG", team: 1, element_type: 4, now_cost: 80, ep_next: "3.0" });
    const noXg = el({ id: 2, web_name: "No xG field", team: 1, element_type: 4, now_cost: 80, ep_next: "3.0" });
    const past = new Map<number, PastSeasonStats>([
      [1, { points: 180, minutes: 3000, starts: 34, goals: 18, assists: 6, xg: 16.0, xa: 5.0,
            seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 3000, starts: 34 }] }],
      // Older season: the xG column did not exist yet, so it is absent — and
      // `starts` is absent for the same reason.
      [2, { points: 180, minutes: 3000, seasonName: "2020/21", plSeasons: 1,
            seasons: [{ seasonName: "2020/21", minutes: 3000 }] }],
    ]);
    const xp = project([withXg, noXg], past);
    // The one with no recorded xG falls back to the price prior, so he lands
    // lower than a proven scorer but nowhere near zero.
    expect(xp.get(2)!.next).toBeGreaterThan(xp.get(1)!.next * 0.5);
  });
});

describe("price/model blend is continuous in the size of the record", () => {
  // The blend between our stats model and FPL's price-implied prior used to be
  // a threshold — `minMinutesForModel: 270` — which made the whole scoring
  // formula a step function. 269 minutes of last-season evidence projected
  // 0.835 and 271 projected 0.479: two minutes moved a player 74%, and moved
  // him DOWN for having more evidence. It sat exactly in the £4.5-5.5m band
  // where a draft's marginal calls live.
  //
  // These pin the shape of the replacement rather than its coefficients, so
  // retuning `priceBlendMins` or `priceBlendFloor` does not break them.

  function fringe(id: number, minutes: number, starts: number) {
    const e = el({
      id, web_name: `P${id}`, team: 1, element_type: 3, now_cost: 50,
      ep_next: "2.0",
    });
    const past = new Map<number, PastSeasonStats>([
      [id, { points: Math.round(minutes / 25), minutes, starts,
             seasonName: "2025/26", plSeasons: 1,
             seasons: [{ seasonName: "2025/26", minutes, starts }] }],
    ]);
    return project([e], past).get(id)!.next;
  }

  it("does not jump across the old 270-minute boundary", () => {
    const below = fringe(1, 269, 3);
    const above = fringe(2, 271, 3);
    // Two minutes of extra evidence is worth vanishingly little. The old
    // threshold moved this pair by 74%; anything above a couple of percent
    // means a discontinuity has been reintroduced.
    expect(Math.abs(above - below) / below).toBeLessThan(0.02);
  });

  it("rewards a bigger record when the whole record grows", () => {
    // Note what is NOT asserted: monotonicity in minutes alone. Raising minutes
    // while holding starts fixed can lower a fringe player's score, and that is
    // correct — extra evidence shifts weight off the price prior and onto his
    // own (worse-than-price) model rate. Evidence winning over price is the
    // point of the blend, not a bug in it. What must rise is the score for a
    // record that grows as a whole.
    const scores = [1, 2, 5, 10, 20, 30, 38].map((k, i) =>
      fringe(i + 1, k * 90, k)
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
  });

  it("moves smoothly across the whole fringe range", () => {
    // The continuity check above only pins the one boundary that used to break.
    // This one says no OTHER boundary has been introduced anywhere in the band
    // where a draft's marginal calls are made.
    const mins = [0, 45, 90, 135, 180, 225, 269, 271, 315, 360, 405, 450];
    const scores = mins.map((m, i) => fringe(i + 1, m, Math.round(m / 90)));
    for (let i = 1; i < scores.length; i++) {
      const step = Math.abs(scores[i] - scores[i - 1]) / scores[i - 1];
      expect(step).toBeLessThan(0.1);
    }
  });

  it("still lets the fixture move a player with an empty record", () => {
    // `priceBlendFloor` exists so the weight on the model never reaches zero.
    // At zero, a player with no history is scored on price alone — position,
    // opponent and clean-sheet odds all discarded, none of which price knows.
    //
    // Both are at HOME deliberately. The price prior carries its own venue
    // multiplier, so an easy-home-vs-hard-away pair separates even at floor 0
    // and would have tested nothing. Same venue, same price, same empty record:
    // the only thing left that can tell them apart is the model term.
    const easy = el({ id: 1, web_name: "Easy", team: 1, element_type: 3, now_cost: 50, ep_next: "2.0" });
    const hard = el({ id: 2, web_name: "Hard", team: 11, element_type: 3, now_cost: 50, ep_next: "2.0" });
    const xp = project([easy, hard]);
    // Team 1 hosts at difficulty 2; team 11 hosts at difficulty 4. Measured
    // separation is 0.687 vs 0.675 — 1.8%, which is all the floor buys and is
    // deliberately all this asserts. Worth noting for later that two FDR
    // buckets apart moving a thin player less than two percent looks weak
    // against `attackMultByFdr` of 1.25 vs 0.82; the reason is that an empty
    // record leaves almost everything sitting in the appearance term, which no
    // fixture multiplier touches. That is a separate question from whether the
    // floor should exist.
    expect(xp.get(1)!.next).toBeGreaterThan(xp.get(2)!.next * 1.01);
  });
});

describe("pre-season goalkeeper depth chart", () => {
  // The keeper allocator is the one place the model assigns a shirt rather than
  // scoring a player, and it runs ONLY pre-season, so nothing in the season-long
  // harness exercises it against a multi-season record. That is not incidental:
  // the archive gives every player exactly one previous season, so `minutes`,
  // `lastSeason.minutes` and the age-weighted total are all the same number
  // there, and the whole class of bug below is invisible to it. These tests are
  // the only cover it has.

  function keepers(past: Map<number, PastSeasonStats>) {
    // Two keepers at the same club, so the allocator has a choice to make.
    const a = el({ id: 1, web_name: "GK A", team: 1, element_type: 1, now_cost: 50, ep_next: "3.0" });
    const b = el({ id: 2, web_name: "GK B", team: 1, element_type: 1, now_cost: 50, ep_next: "3.0" });
    const xp = project([a, b], past);
    return [xp.get(1)!.next, xp.get(2)!.next] as const;
  }

  it("gives the shirt to last season's keeper, not one deposed two years ago", () => {
    // `PastSeasonStats.minutes` is the most recent season the player ACTUALLY
    // PLAYED, because the per-90 rates need a season with pitch time in it. For
    // a deposed keeper that is two years old, and reading it here handed him the
    // gloves over the man who kept goal all last season.
    const past = new Map<number, PastSeasonStats>([
      // Deposed: first choice in 2024/25, did not play in 2025/26.
      [1, { points: 130, minutes: 3060, starts: 34, seasonName: "2024/25", plSeasons: 2,
            lastSeason: { seasonName: "2025/26", minutes: 0, starts: 0 },
            seasons: [
              { seasonName: "2024/25", minutes: 3060, starts: 34 },
              { seasonName: "2025/26", minutes: 0, starts: 0 },
            ] }],
      // Incumbent: took the shirt last season and kept it.
      [2, { points: 140, minutes: 3420, starts: 38, seasonName: "2025/26", plSeasons: 2,
            lastSeason: { seasonName: "2025/26", minutes: 3420, starts: 38 },
            seasons: [
              { seasonName: "2024/25", minutes: 360, starts: 4 },
              { seasonName: "2025/26", minutes: 3420, starts: 38 },
            ] }],
    ]);
    const [deposed, incumbent] = keepers(past);
    // 1.243x measured. Modest, because `gkPreseason` deliberately leans on
    // price and both keepers here cost £5.0m — the record only has
    // `minutesWeight: 0.6` to move with. The bar is what matters: before the
    // fix the ratio was 0.993, i.e. the deposed keeper was very slightly
    // AHEAD.
    expect(incumbent).toBeGreaterThan(deposed * 1.15);
  });

  it("does not throw away an established keeper who missed one season injured", () => {
    // The reason this reads age-weighted evidence rather than simply
    // `lastSeason.minutes`: a keeper with three seasons as a number one who lost
    // the most recent to injury is not the same as a career deputy, and a
    // last-season-only rule cannot tell them apart.
    const past = new Map<number, PastSeasonStats>([
      // Three seasons nailed, then a blank year.
      [1, { points: 140, minutes: 3420, starts: 38, seasonName: "2024/25", plSeasons: 4,
            lastSeason: { seasonName: "2025/26", minutes: 0, starts: 0 },
            seasons: [
              { seasonName: "2022/23", minutes: 3420, starts: 38 },
              { seasonName: "2023/24", minutes: 3420, starts: 38 },
              { seasonName: "2024/25", minutes: 3420, starts: 38 },
              { seasonName: "2025/26", minutes: 0, starts: 0 },
            ] }],
      // Career deputy who covered those same blank weeks and nothing else.
      [2, { points: 30, minutes: 540, starts: 6, seasonName: "2025/26", plSeasons: 4,
            lastSeason: { seasonName: "2025/26", minutes: 540, starts: 6 },
            seasons: [
              { seasonName: "2022/23", minutes: 0, starts: 0 },
              { seasonName: "2023/24", minutes: 0, starts: 0 },
              { seasonName: "2024/25", minutes: 0, starts: 0 },
              { seasonName: "2025/26", minutes: 540, starts: 6 },
            ] }],
    ]);
    const [established, deputy] = keepers(past);
    // The three candidate sources, measured on this pair and on the deposed
    // pair above (incumbent-over-deposed / established-over-deputy):
    //
    //   PastSeasonStats.minutes   0.993   2.456    <- the bug: deposed wins
    //   lastSeason.minutes        3.987   0.652    <- fixes one, breaks this
    //   age-weighted evidence     1.243   2.456    <- both right
    //
    // The middle row is why this reads `preseasonEvidence` rather than the
    // obvious one-token change.
    expect(established).toBeGreaterThan(deputy * 2);
  });
});
