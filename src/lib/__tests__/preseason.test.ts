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
import { projectAll, XP_CONFIG } from "../xp";
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

  it("does not treat a super-sub's minutes as a starter's minutes", () => {
    // The one comparison nobody had written, and the one the whole pre-season
    // minutes model exists to get right. Two players with an IDENTICAL minutes
    // total, one who got there by starting twenty games and one who got there
    // in thirty-four cameos. Everything FPL publishes about them pre-season is
    // the same; only `starts` differs.
    //
    // Every other test in this file varies minutes and starts together, so
    // `starts` could be deleted from every fixture in the file and all of them
    // still pass — the assertions were being carried by the minutes. That is
    // exactly the failure mode a regression test is supposed to catch, and it
    // was not being caught.
    //
    // The bar is deliberately modest. `share` takes `max(pStart * minsPerStart
    // / 90, observedShare)`, and the observed share is the same 0.526 for both,
    // so the separation is carried by `p60` and `pPlay` alone — a starter
    // completes an hour and collects the two-point appearance bonus, a
    // substitute mostly does not. The floor is a deliberate design choice (900
    // minutes off the bench is not 20 minutes) and this test pins the size of
    // what survives it rather than pretending the floor is not there.
    const starter = el({
      id: 1, web_name: "Starter", team: 1, element_type: 3, now_cost: 55,
      ep_next: "2.5",
    });
    const sub = el({
      id: 2, web_name: "Supersub", team: 1, element_type: 3, now_cost: 55,
      ep_next: "2.5",
    });
    const line = { points: 80, goals: 6, assists: 4, xg: 5.0, xa: 3.5, bonus: 8, ict: 90 };
    const past = new Map<number, PastSeasonStats>([
      [1, { ...line, minutes: 1800, starts: 20, seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 1800, starts: 20 }] }],
      [2, { ...line, minutes: 1800, starts: 0, seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 1800, starts: 0 }] }],
    ]);
    const xp = project([starter, sub], past);
    expect(xp.get(1)!.next).toBeGreaterThan(xp.get(2)!.next * 1.15);
  });

  it("ages a stale record by trusting it less, not by pretending he was benched", () => {
    // The rate-line fallback in `preseasonEvidence`: a record with no
    // per-season breakdown, only totals and the season they came from. It
    // weighted `starts` and `minutes` by the age decay and left `games` at a
    // flat 38 — and every consumer divides by `games`. So a two-season-old
    // ever-present arrived as "0.30 of a season's starts spread over a full 38
    // games", which is not an aged record, it is a made-up bad one.
    //
    // Both players below have the identical line. Only the season it is
    // attributed to differs, and the fixture's deadline is in 2026, so one is
    // last season and the other is two years older. Ageing must cost the older
    // man something — the prior is worth 6 games against 38 — but not the
    // collapse the bug produced.
    const recent = el({
      id: 1, web_name: "Recent", team: 1, element_type: 3, now_cost: 55, ep_next: "2.5",
    });
    const stale = el({
      id: 2, web_name: "Stale", team: 1, element_type: 3, now_cost: 55, ep_next: "2.5",
    });
    const line = { points: 150, minutes: 3060, starts: 34, goals: 10, assists: 8, xg: 9, xa: 7 };
    // No `seasons` array at all — this is the branch under test.
    const past = new Map<number, PastSeasonStats>([
      [1, { ...line, seasonName: "2025/26", plSeasons: 1 }],
      [2, { ...line, seasonName: "2023/24", plSeasons: 1 }],
    ]);
    const xp = project([recent, stale], past);
    const a = xp.get(1)!.next;
    const b = xp.get(2)!.next;
    expect(b).toBeLessThan(a);
    // With the denominator left unweighted this ratio was close to 3. Shrinking
    // toward a price prior worth six games cannot legitimately halve a
    // 34-start season.
    expect(a).toBeLessThan(b * 1.35);
  });

  it("lets an ancient rate line decay out instead of freezing it forever", () => {
    // The other half of the fix above, and the hazard it created. Once `games`
    // is aged along with `minutes`, `observedShare = minutes / (games * 90)`
    // stops depending on the age at all — a ratio does not care how little you
    // believe both halves of it — and `share` takes that observed value as a
    // FLOOR. So a 3060-minute season from eight years ago, aged to a weight of
    // 0.008, still asserted that the man plays 89% of every available minute.
    //
    // The multi-season branch has always dropped rows below a weight of 0.05.
    // This branch now does the same, and the assertion is against a player with
    // no Premier League record at all: once the evidence is that old, having it
    // must be worth the same as not having it.
    const line = { points: 150, minutes: 3060, starts: 34, goals: 10, assists: 8, xg: 9, xa: 7 };
    const ancient = el({
      id: 1, web_name: "Ancient", team: 1, element_type: 3, now_cost: 55, ep_next: "2.5",
    });
    const unknown = el({
      id: 2, web_name: "Unknown", team: 1, element_type: 3, now_cost: 55, ep_next: "2.5",
    });
    const past = new Map<number, PastSeasonStats>([
      [1, { ...line, seasonName: "2018/19", plSeasons: 1 }],
    ]);
    const xp = project([ancient, unknown], past);
    // Not equality: the scoring-rate terms read the same aged line by their own
    // route and shrink it as well, so the man with the ancient record lands a
    // shade BELOW the one with no record. What is pinned is the minutes side —
    // an eight-year-old season must not buy a starter's share. Leave the
    // cut-off out and he comes back at nearly double the unknown player.
    expect(xp.get(1)!.next).toBeLessThan(xp.get(2)!.next);
    expect(xp.get(1)!.next).toBeGreaterThan(xp.get(2)!.next * 0.8);
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

describe("pre-season ownership prior", () => {
  // `selected_by_percent` is the only field on the bootstrap generated after
  // last season ended. Everything else here is a record from May or a price set
  // in June; ownership is five weeks of managers watching friendlies, reading
  // team news and hearing a manager say a player is not in his plans. It enters
  // as a prior on P(start) — never as a multiplier on points — because a crowd
  // that likes a player is evidence he has been seen in an XI, not evidence he
  // will score.

  /** `n` interchangeable midfielders, differing only in ownership. */
  function crowd(
    own: number[],
    now_cost = 55
  ): { elements: Element[]; past: Map<number, PastSeasonStats> } {
    const line = { points: 70, minutes: 1500, starts: 17, goals: 5, assists: 4, xg: 4, xa: 3 };
    const past = new Map<number, PastSeasonStats>();
    const elements = own.map((o, i) => {
      past.set(i + 1, {
        ...line, seasonName: "2025/26", plSeasons: 1,
        seasons: [{ seasonName: "2025/26", minutes: line.minutes, starts: line.starts }],
      });
      // All at the same club on purpose: GW1 fixture difficulty varies by team
      // and would otherwise swamp the thing being measured. An earlier draft
      // spread them across four clubs and the 1.0%-owned player came out below
      // the 0.1%-owned one — not because the prior was broken, but because one
      // of them was away at a difficulty-5 side.
      return el({
        id: i + 1, web_name: `M${i + 1}`, team: 1, element_type: 3,
        now_cost, ep_next: "2.5", selected_by_percent: o.toFixed(1),
      });
    });
    return { elements, past };
  }

  it("prefers the player the market has spent five weeks looking at", () => {
    // Identical price, identical record, identical everything FPL publishes —
    // except that one of them is in 20% of squads and one is in a fiftieth of a
    // percent. Bucketing four archived seasons by prior-season minutes and then
    // by GW1 ownership within each bucket, this season's minutes rise with
    // ownership in every bucket: for players on 1500-2500 prior minutes, from
    // 1385 in the least-owned quarter to 2087 in the top decile.
    const { elements, past } = crowd([0.0, 0.1, 1.0, 20.0]);
    const xp = project(elements, past);
    const got = elements.map((e) => xp.get(e.id)!.next);
    expect(got[3]).toBeGreaterThan(got[2]);
    expect(got[2]).toBeGreaterThan(got[1]);
    expect(got[1]).toBeGreaterThan(got[0]);
  });

  it("reads ownership as a rank, so the size of the game does not change the answer", () => {
    // The load-bearing property, and the reason this is a percentile rather
    // than the percentage itself. FPL's manager count grows by about a million
    // a year, so the same player is a different number in 2022 and in 2025, and
    // the backtest has to reconstruct the figure from a raw selection count
    // over an ESTIMATE of that year's total. Anything that read the percentage
    // directly would be measured on the archive at one scale and shipped at
    // another.
    //
    // The two sets below are not a rescaling of each other, deliberately. An
    // earlier version tripled every figure, which sounds like the right test
    // and is not: dividing by the position maximum — a normalised PERCENTAGE,
    // the exact thing this must not be — is itself invariant to scaling, so it
    // passed. Only the ORDER is shared here, and nothing else; any reading of
    // the magnitudes gives a different answer.
    const a = crowd([0.1, 0.5, 2.0, 9.0]);
    const b = crowd([0.3, 4.0, 5.0, 30.0]);
    const xa = project(a.elements, a.past);
    const xb = project(b.elements, b.past);
    for (const e of a.elements) expect(xb.get(e.id)!.next).toBe(xa.get(e.id)!.next);
  });

  it("ranks a player against his own position, not against the whole game", () => {
    // Ownership is not comparable across positions — a 6%-owned goalkeeper is
    // his club's number one, a 6%-owned midfielder is a differential — so the
    // order is read within `element_type` and nowhere else. Nothing else in
    // this describe block would notice if the position loop were removed,
    // because every fixture in it is midfielders only.
    //
    // Two midfielders and two defenders on the same two ownership figures.
    // Rank them globally and the midfielders stop being 0 and 1 of their own
    // position and become joint-lowest and joint-highest of four, which moves
    // both of them; rank them within position and the defenders are simply not
    // there.
    const mids = crowd([0.1, 5.0]);
    const withDefs = crowd([0.1, 5.0]);
    const defs = [0.1, 5.0].map((o, i) =>
      el({
        id: 10 + i, web_name: `D${i + 1}`, team: 1, element_type: 2,
        now_cost: 45, ep_next: "2.5", selected_by_percent: o.toFixed(1),
      })
    );
    const xm = project(mids.elements, mids.past);
    const xd = project([...withDefs.elements, ...defs], withDefs.past);
    for (const e of mids.elements) expect(xd.get(e.id)!.next).toBe(xm.get(e.id)!.next);
  });

  it("puts the ends of a position at the ends of the range, whatever its size", () => {
    // The percentile is `rank / (n - 1)`, so the least owned player in a
    // position is 0 and the most owned is 1 — and that has to hold for a
    // position of two as well as a position of eighty, because the divisor is
    // the only thing that differs between them. Every other test here compares
    // fixtures of the SAME size, where any consistent reparametrisation —
    // `/ n`, `/ (n + 1)`, or a factor of a half across the board — cancels out
    // and passes. Those mutations halve the signal in production and are
    // invisible without this.
    const two = crowd([0.1, 9.0]);
    const five = crowd([0.1, 2.0, 3.0, 4.0, 9.0]);
    const x2 = project(two.elements, two.past);
    const x5 = project(five.elements, five.past);
    expect(x5.get(5)!.next).toBe(x2.get(2)!.next);
    expect(x5.get(1)!.next).toBe(x2.get(1)!.next);
  });

  it("does not go deaf to the crowd at the top of the price list", () => {
    // The price prior is unbounded above — it passes 1.1 for a £8.9m
    // midfielder — while the blended result is clamped to [0.08, 0.9]. Blend
    // first and clamp afterwards and every premium comes out pinned at 0.9 no
    // matter where the market has him: an £11.0m midfielder scored identically
    // at the 1st percentile of ownership and the 99th, and since the clamp
    // only bites upward the crowd could cast doubt on a premium but never
    // confirm one. These four are priced where that used to happen.
    const { elements, past } = crowd([0.1, 1.0, 5.0, 25.0], 110);
    const xp = project(elements, past);
    const got = elements.map((e) => xp.get(e.id)!.next);
    expect(got[3]).toBeGreaterThan(got[2]);
    expect(got[2]).toBeGreaterThan(got[1]);
    expect(got[1]).toBeGreaterThan(got[0]);
  });

  it("puts the most owned player at the top of the market range and the least at the bottom", () => {
    // The endpoint test above pins that the ends are the ends RELATIVE to each
    // other, which any consistent rescaling of the percentile survives —
    // halving it everywhere quietly halves the whole signal and passes. This
    // pins them absolutely, by collapsing the range to a single value and
    // showing the extremes were already there.
    //
    // With gamma 1 and weight 1 the prior IS the market map, so a position
    // whose range is [lo, hi] must give its most owned player exactly what a
    // range of [hi, hi] gives him, and its least owned exactly what [lo, lo]
    // gives him. Nothing else in the fixture changes.
    const cfg = XP_CONFIG;
    const before = [cfg.priorPStartOwnRange, cfg.priorPStartOwnGamma, cfg.priorPStartOwnWeight] as const;
    try {
      cfg.priorPStartOwnGamma = 1;
      cfg.priorPStartOwnWeight = 1;
      const run = (range: [number, number]) => {
        cfg.priorPStartOwnRange = range;
        const c = crowd([0.1, 1.0, 5.0, 20.0]);
        return project(c.elements, c.past);
      };
      const spread = run([0.08, 0.9]);
      const allTop = run([0.9, 0.9]);
      const allBottom = run([0.08, 0.08]);
      expect(spread.get(4)!.next).toBe(allTop.get(4)!.next);
      expect(spread.get(1)!.next).toBe(allBottom.get(1)!.next);
    } finally {
      [cfg.priorPStartOwnRange, cfg.priorPStartOwnGamma, cfg.priorPStartOwnWeight] = before;
    }
  });

  it("switches off completely at weight zero", () => {
    // `priorPStartOwnWeight` is swept from the harness, and `OWNW=0` is the
    // control every measured claim about this prior is stated against. So the
    // meaning of zero is load-bearing even though the shipped VALUE of the
    // weight deliberately is not pinned by any test: swapping the two sides of
    // the blend is an exact no-op at 0.5 and passes everything else in this
    // file, while silently turning the control run into a price-free model.
    const spread = crowd([0.0, 0.1, 1.0, 20.0]);
    const flat = crowd([5.0, 5.0, 5.0, 5.0]);
    const before = XP_CONFIG.priorPStartOwnWeight;
    try {
      XP_CONFIG.priorPStartOwnWeight = 0;
      const xs = project(spread.elements, spread.past);
      const xf = project(flat.elements, flat.past);
      for (const e of spread.elements) expect(xs.get(e.id)!.next).toBe(xf.get(e.id)!.next);
    } finally {
      XP_CONFIG.priorPStartOwnWeight = before;
    }
  });

  it("does not invent an order inside FPL's rounding", () => {
    // Ownership is published to one decimal, so at GW1 well over a third of a
    // position sits at exactly "0.0" — and it is the cheap tail, precisely
    // where a made-up ordering would do the most damage. A tie is a tie: the
    // crowd has not distinguished them, so neither may the model.
    const { elements, past } = crowd([0.0, 0.0, 0.0, 6.0]);
    const xp = project(elements, past);
    expect(xp.get(2)!.next).toBe(xp.get(1)!.next);
    expect(xp.get(3)!.next).toBe(xp.get(1)!.next);
    expect(xp.get(4)!.next).toBeGreaterThan(xp.get(1)!.next);
  });

  it("puts a tied block at its middle rather than at its foot", () => {
    // The test above pins that ties agree with each other, which every
    // plausible tie rule satisfies — including the wrong ones. Replacing the
    // mid-rank `(i + j) / 2` with the block's first index `i` leaves that test
    // green while quietly demoting every tied player to the bottom of his own
    // block, and at GW1 the tied block is a third of the position. So this
    // pins the LEVEL, not just the agreement.
    //
    // Five otherwise identical midfielders. Break the ties and they occupy
    // percentiles 0, .25, .5, .75, 1; leave the bottom three tied and all
    // three sit at the average of the ranks they cover — .25, which is
    // exactly where the middle one of them would have been anyway. Reading a
    // tie as "all of them are bottom of the position" would put them at 0.
    const tied = crowd([0.0, 0.0, 0.0, 4.0, 5.0]);
    const distinct = crowd([1.0, 2.0, 3.0, 4.0, 5.0]);
    const xt = project(tied.elements, tied.past);
    const xd = project(distinct.elements, distinct.past);
    expect(xt.get(1)!.next).toBe(xd.get(2)!.next);
    expect(xt.get(1)!.next).toBeGreaterThan(xd.get(1)!.next);
  });

  it("leaves a position alone when its ownership carries no information at all", () => {
    // A fixture, a mock or a harness with a constant ownership string must not
    // have every player's prior quietly dragged halfway to the middle of the
    // market range on no evidence. Flat ownership means the signal is switched
    // off, not that everyone is average — which is why `ownershipPercentiles`
    // omits such a position from its map rather than filling it with 0.5.
    //
    // The reference has to be a projection where the ownership column provably
    // does nothing, and comparing one flat set against another flat set is not
    // that: drop the guard and both sides get 0.5, so they still agree and the
    // test passes having measured nothing. A position of ONE is the honest
    // reference — there is no ownership ORDER to read, by a different branch —
    // and a lone player must score exactly what he scores in a crowd that is
    // all on the same number.
    const flat = crowd([4.0, 4.0, 4.0, 4.0]);
    const alone = crowd([4.0]);
    const xf = project(flat.elements, flat.past);
    const xa = project(alone.elements, alone.past);
    expect(xf.get(1)!.next).toBe(xa.get(1)!.next);
    // And the value being pinned is not accidentally the mid-market one: a
    // player the crowd HAS put in the middle of this position scores something
    // else, so the assertion above has teeth.
    const ranked = crowd([1.0, 2.0, 3.0, 4.0, 5.0]);
    const xr = project(ranked.elements, ranked.past);
    expect(xr.get(3)!.next).not.toBe(xa.get(1)!.next);
  });

  it("still lets a record outrank the crowd", () => {
    // The prior is a prior. A player who started 34 games last season and is
    // owned by nobody must still project above one who started none and is
    // owned by a fifth of the game — otherwise this has stopped being a
    // shrinkage term and become a popularity contest.
    const proven = el({
      id: 1, web_name: "Proven", team: 1, element_type: 3, now_cost: 55,
      ep_next: "2.5", selected_by_percent: "0.1",
    });
    const popular = el({
      id: 2, web_name: "Popular", team: 2, element_type: 3, now_cost: 55,
      ep_next: "2.5", selected_by_percent: "20.0",
    });
    const past = new Map<number, PastSeasonStats>([
      [1, { points: 150, minutes: 3060, starts: 34, goals: 10, assists: 8, xg: 9, xa: 7,
            seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 3060, starts: 34 }] }],
      [2, { points: 4, minutes: 90, starts: 0, seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 90, starts: 0 }] }],
    ]);
    const xp = project([proven, popular], past);
    expect(xp.get(1)!.next).toBeGreaterThan(xp.get(2)!.next * 2);
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

  it("keeps reading `form`, even though the reset makes it useless", () => {
    // This one pins a decision rather than a property, so it needs its reason
    // written down. `form` is a thirty-day rolling average, so pre-season it is
    // "0.0" for all 700-odd players, and averaging that placeholder in with
    // points-per-game halves the form term for everyone with a record. That
    // looks exactly like the placeholder-as-measurement bug this file fixes
    // twice elsewhere, and it does not cancel out — the price prior it is
    // blended against is not halved.
    //
    // Both principled repairs were implemented and measured over four archived
    // seasons and both cost points; the table is in `xp.ts` above `formScore`.
    // The short version is that pre-season `points_per_game` is "0.0" as well,
    // so the term falls through to last season's rate, which `xp` has already
    // used — there is no independent signal to weight, only a duplicate that
    // regresses harder, and the accidental halving shrinks it usefully.
    //
    // So the assertion is deliberately the awkward one: `form` must still reach
    // the model. Special-casing pre-season by either route makes these two
    // players identical and this fails.
    const rec = (): PastSeasonStats => ({
      points: 190, minutes: 3100, starts: 35, goals: 12, assists: 9, xg: 10.5,
      xa: 8.1, bonus: 22, ict: 320, seasonName: "2025/26", plSeasons: 1,
      seasons: [{ seasonName: "2025/26", minutes: 3100, starts: 35 }],
    });
    // Same club, so identical fixture; identical record; only `form` differs.
    const carried = el({ id: 1, web_name: "Carried", team: 12, element_type: 3, now_cost: 70, ep_next: "3.0", form: "5.0" });
    const wiped = el({ id: 2, web_name: "Wiped", team: 12, element_type: 3, now_cost: 70, ep_next: "3.0", form: "0.0" });
    const past = new Map<number, PastSeasonStats>([[1, rec()], [2, rec()]]);
    const xp = project([carried, wiped], past);
    // Measured 1.0396. Either repair pins it at exactly 1.0000.
    expect(xp.get(1)!.next / xp.get(2)!.next).toBeGreaterThan(1.02);
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
    //
    // What it measures is the SLOPE, not the step, and the difference matters.
    // A bound on "no step bigger than X%" is really a bound on how fine the
    // grid is: this curve genuinely climbs 0.446 -> 0.723 across the first 600
    // minutes, so on a 30-minute grid the honest steps are already 3-5% and any
    // bar loose enough to admit them is too loose to catch much else. Dividing
    // by the spacing turns steps into slopes, and a discontinuity is then not a
    // large slope but an OUTLIER slope — one interval where the curve moves at
    // a completely different rate from its neighbours.
    //
    // `starts` is carried as a fraction of minutes rather than a rounded count
    // on purpose. Rounding put the largest jump in the whole sweep at 45
    // minutes, where the fixture's own `Math.round(m / 90)` flipped starts from
    // 0 to 1 — the test's arithmetic, not the model's, and 12x the model's real
    // movement across the same interval.
    const mins: number[] = [];
    for (let m = 0; m <= 600; m += 30) mins.push(m);
    mins.push(269, 271); // straddle the old threshold on a fine grid too
    mins.sort((a, b) => a - b);
    const scores = mins.map((m, i) => fringe(i + 1, m, m / 90));
    const slopes: number[] = [];
    for (let i = 1; i < scores.length; i++) {
      slopes.push(Math.abs(scores[i] - scores[i - 1]) / (mins[i] - mins[i - 1]));
    }
    const sorted = [...slopes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const worst = sorted[sorted.length - 1];
    // Measured 1.52. Putting the threshold back makes it 384 — the two-minute
    // interval from 269 to 271 moves the player further than the other 600
    // minutes put together. The bar at 4 has room for a real retune on one side
    // and two orders of magnitude of margin against the regression on the other.
    expect(worst / median).toBeLessThan(4);
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
    //
    // The shape is a difference of differences rather than a bare ratio. An
    // earlier version asserted `easy > hard * 1.01` against a measured 1.0183 —
    // 0.8pp of headroom on a 1.8pp effect, so any downward retune of the floor
    // would have broken it without anything actually regressing. The control
    // pair fixes that: teams 1 and 12 both host at difficulty 2, so whatever
    // the floor is worth, THEY must stay level. The claim is that the fixture
    // gap is large next to the noise floor, which is scale-free.
    const at = (id: number, team: number) =>
      el({ id, web_name: `P${id}`, team, element_type: 3, now_cost: 50, ep_next: "2.0" });
    const xp = project([at(1, 1), at(2, 11), at(3, 12)]);
    const easy = xp.get(1)!.next;   // team 1 hosts at difficulty 2
    const hard = xp.get(2)!.next;   // team 11 hosts at difficulty 4
    const control = xp.get(3)!.next; // team 12 also hosts at difficulty 2
    const noise = Math.abs(easy - control);
    // Measured: easy 0.6873, hard 0.6752, control 0.6873. The control pair is
    // identical to the last digit, so the noise floor is 0 and the ratio below
    // is infinite; the guard keeps it finite for the assertion's sake.
    expect(easy - hard).toBeGreaterThan(Math.max(noise, 1e-6) * 5);
    // Worth noting for later that two FDR buckets apart moving a thin player
    // only 1.8% looks weak against `attackMultByFdr` of 1.25 vs 0.82; the
    // reason is that an empty record leaves almost everything sitting in the
    // appearance term, which no fixture multiplier touches. That is a separate
    // question from whether the floor should exist.
    expect(easy).toBeGreaterThan(hard);
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

  it("does not let a long career flatten the depth chart", () => {
    // The unit bug the two tests above were blind to. `preseasonEvidence`
    // returns a weighted SUM over every season on record — rows survive while
    // `0.55^age >= 0.05`, so six seasons multiply out to 2.16x a single one —
    // and the allocator compared it against `minutesCap: 2000`, a ceiling whose
    // own comment says "a full season is a full season".
    //
    // A career deputy playing a third of every season for five years therefore
    // saturated a one-season cap just as completely as an ever-present, and the
    // two then separated on price alone. Neither test above catches it: their
    // deputies sit at 540 and 1683 weighted minutes, both under 2000. This one
    // puts the deputy at 2334, over it.
    const seasons = ["2021/22", "2022/23", "2023/24", "2024/25", "2025/26"];
    const past = new Map<number, PastSeasonStats>([
      [1, { points: 140, minutes: 3420, starts: 38, seasonName: "2025/26", plSeasons: 5,
            lastSeason: { seasonName: "2025/26", minutes: 3420, starts: 38 },
            seasons: seasons.map((s) => ({ seasonName: s, minutes: 3420, starts: 38 })) }],
      [2, { points: 45, minutes: 1080, starts: 12, seasonName: "2025/26", plSeasons: 5,
            lastSeason: { seasonName: "2025/26", minutes: 1080, starts: 12 },
            seasons: seasons.map((s) => ({ seasonName: s, minutes: 1080, starts: 12 })) }],
    ]);
    const [nailed, deputy] = keepers(past);
    // Measured 1.92x with the units fixed, 1.015x with the raw sum — the shirt
    // was being split down the middle between a club's number one and his
    // backup. The bar sits at 1.5 to leave room for retuning `minutesWeight`
    // while still killing anything close to the coin toss.
    expect(nailed).toBeGreaterThan(deputy * 1.5);
  });

  it("does not hand out the shirt more confidently than the evidence allows", () => {
    // Every other assertion in this block is one-sided, so doubling `beta` or
    // `minutesWeight` — making the allocator far SHARPER than intended —
    // survives all of them. That direction is a named modelling error, not a
    // harmless retune: `gkPreseason`'s own comment records that picking a
    // club's number one from pre-season information alone is right about 68%
    // of the time, and cites Roefs, Trafford and Vicario as unknowns who took
    // the shirt off a same-priced incumbent. `slotMass: 0.95` says the same
    // thing — even a nailed keeper loses a few weeks to cups and knocks.
    //
    // So the clearest evidence gap the allocator can be shown — four full
    // seasons against a keeper who has never played a minute — should still
    // not produce near-certainty. Measured 3.27x. The ceiling is 4.0x, which
    // is where it bites: beta 2.5 -> 3.5 gives 4.48x and doubling either beta
    // or `minutesWeight` gives 6.13x, so both die, and the shipped value keeps
    // 22% of headroom.
    const seasons = ["2022/23", "2023/24", "2024/25", "2025/26"];
    const past = new Map<number, PastSeasonStats>([
      [1, { points: 140, minutes: 3420, starts: 38, seasonName: "2025/26", plSeasons: 4,
            lastSeason: { seasonName: "2025/26", minutes: 3420, starts: 38 },
            seasons: seasons.map((s) => ({ seasonName: s, minutes: 3420, starts: 38 })) }],
      [2, { points: 0, minutes: 0, starts: 0, seasonName: "2025/26", plSeasons: 4,
            lastSeason: { seasonName: "2025/26", minutes: 0, starts: 0 },
            seasons: seasons.map((s) => ({ seasonName: s, minutes: 0, starts: 0 })) }],
    ]);
    const [nailed, never] = keepers(past);
    expect(nailed).toBeGreaterThan(never * 1.5);
    expect(nailed).toBeLessThan(never * 4);
  });
});
