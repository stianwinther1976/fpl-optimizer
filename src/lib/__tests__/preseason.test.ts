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
import { projectAll, XP_CONFIG, XP_DEBUG } from "../xp";
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
    // Both clubs get their real deputy here, because a keeper's pre-season
    // projection is a share of one shirt and a share needs someone to share
    // with. An earlier version of this test listed each keeper alone at his
    // club, which is a squad the bootstrap cannot produce — every Premier
    // League club registers three to five — and it quietly asked the model to
    // rank two men who were never competing for the same place.
    //
    // WHAT THIS TEST USED TO ASSERT, AND WHY IT NO LONGER DOES.
    // It also asserted that Darlow (£4.5m, 20 starts last season) outscores
    // his clubmate Meslier (£5.0m, registered all season, never picked) — the
    // intuition being that a real record must beat a price tag. Two things
    // were wrong with that. First, it only passed because the fixture gave
    // Darlow `points: 900` for a single season, roughly five times the highest
    // score any goalkeeper has ever posted; the per-90 anchor that typo
    // produced was carrying the assertion, not the record. Second, and worse,
    // the claim is not supported by the archive. Scanning 2023-24 through
    // 2025-26 for the exact conflict — a pricier keeper with fewer prior-season
    // starts than a cheaper clubmate who had a real record (>= 10 starts) —
    // turns up five instances in three seasons:
    //
    //   2023-24  Vicario  £5.0 (0 prior)  vs Forster  £4.0 (13)  -> pricier
    //   2023-24  Neto     £4.5 (0)        vs Travers  £4.0 (11)  -> pricier
    //   2023-24  Radu     £4.5 (2)        vs Travers  £4.0 (11)  -> cheaper
    //   2024-25  Pope     £5.0 (15)       vs Dubravka £4.5 (22)  -> pricier
    //   2025-26  Weiss    £4.5 (0)        vs Dubravka £4.0 (10)  -> cheaper
    //
    // Three to two for price, and the Radu row is a third-choice keeper being
    // compared to a second-choice at a club where Neto started 32 — noise from
    // pairing every keeper against every other. Five cases split almost evenly
    // is not evidence for either side, and it is nowhere near enough to hang a
    // regression bar on. So the assertion is gone rather than being nursed to
    // green, and `gkPreseason.minutesWeight` stays at 0 (see the sweep recorded
    // in its header doc, which reached the same verdict from the full
    // population rather than from this conditional slice).
    const rayaDeputy = el({
      id: 2, web_name: "Setford", team: 1, element_type: 1, now_cost: 40, selected_by_percent: "0.2",
    });
    const meslierRival = el({
      id: 4, web_name: "Darlow", team: 13, element_type: 1, now_cost: 45, selected_by_percent: "4.0",
    });
    const raya = el({
      id: 1, web_name: "Raya", team: 1, element_type: 1, now_cost: 60, selected_by_percent: "15.0",
      minutes: 3330, starts: 37, total_points: 162, points_per_game: "4.4",
      ep_next: "4.0", bonus: 11, ict_index: "57.5", saves: 95,
    });
    const backup = el({
      id: 3, web_name: "Meslier", team: 13, element_type: 1, now_cost: 50, selected_by_percent: "1.0",
      ep_next: "2.6",
    });
    const past = new Map<number, PastSeasonStats>([
      [1, {
        points: 162, minutes: 3330, starts: 37, saves: 95, bonus: 11, ict: 57.5,
        plSeasons: 1, seasonName: "2025/26",
        seasons: [{ seasonName: "2025/26", minutes: 3330, starts: 37 }],
      }],
      // Registered all season, never picked.
      [3, {
        points: 0, minutes: 0, plSeasons: 1,
        seasons: [{ seasonName: "2025/26", minutes: 0, starts: 0 }],
      }],
      [2, { points: 0, minutes: 0, plSeasons: 1,
        seasons: [{ seasonName: "2025/26", minutes: 0, starts: 0 }] }],
      [4, { points: 88, minutes: 1800, starts: 20, saves: 60, plSeasons: 1,
        seasonName: "2025/26",
        seasons: [{ seasonName: "2025/26", minutes: 1800, starts: 20 }] }],
    ]);
    function run(p: Map<number, PastSeasonStats>) {
      XP_DEBUG.minutes = new Map();
      try {
        const x = project([raya, rayaDeputy, backup, meslierRival], p);
        return { xp: x, sh: new Map([...XP_DEBUG.minutes!].map(([k, v]) => [k, v.pStart])) };
      } finally {
        XP_DEBUG.minutes = null;
      }
    }
    const { xp, sh } = run(past);

    // A genuine number one — most expensive keeper at his club by £2.0m, and
    // owned by fifteen percent of the game — takes essentially the whole shirt.
    // Measured 0.9498 against a `slotMass` of 0.95, i.e. all of it.
    expect(sh.get(1)!).toBeGreaterThan(0.9);
    // A keeper who has never played a minute does not. Measured 0.5126: the
    // chart reads Leeds as an open contest, which is the honest answer when
    // price says one thing (£5.0m vs £4.5m) and ownership says the other
    // (1.0% vs 4.0%) and, per the table above, neither has earned the right to
    // overrule the other.
    expect(sh.get(3)!).toBeLessThan(0.6);

    // A NOTE ON A BAR THIS TEST DELIBERATELY DOES NOT ASSERT.
    // Raya outscores Meslier 4.055 to 1.744, a ratio of 2.33, while their
    // shares are only 1.85 apart. It is tempting to assert that 2.33 and call
    // the surplus proof that a keeper's record still counts even with
    // `minutesWeight` at 0. It is not. Grafting Raya's exact record onto
    // Meslier — same club, same fixture, same price, same ownership, so the
    // shares do not move at all — lifts him from 1.744 to only 1.892. The
    // record is worth 8.5%. The other 16% is that Raya's club is at home in
    // GW1 at difficulty 2 while Meslier's travels at difficulty 3, which is a
    // statement about the fixture list and nothing to do with either man.
    // Asserting the 2.33 would have shipped a fixture test wearing a record
    // test's name.
    //
    // So the record is measured where it is actually visible: the same player,
    // at the same club, in the same gameweek, with and without a career behind
    // him. 1.0847 measured; the bar is 1.05.
    //
    // WHICH CHANNEL CARRIES IT — established by mutation, after three guesses
    // at it turned out to be wrong. Forcing `saves90` to the price prior,
    // zeroing `savesCap`, making `rate()` return `prior90` unconditionally,
    // pinning `priceBlendFloor` to 1 so the record cannot move how far the
    // model is trusted, and dropping `rates.samplePpg` from `seasonPpg` ALL
    // leave this test green. So does disabling `statLine`'s `history_past`
    // branch outright, which is the result that gave it away: if blocking the
    // record's main read changes the answer by 0.0005, the record is arriving
    // somewhere else. It arrives at the `per90` past-points anchor in
    // `projectAll`, which reads `past` directly and never goes through
    // `statLine` at all. Three mutations there kill this test — zeroing
    // `pastMinsRaw`, forcing `anchorW` to 0, and inflating
    // `pastPointsMinMinutes` so the anchor can never leave `prior90`.
    //
    // Worth stating plainly, because it is the answer to "surely the history
    // says whether he starts": for a goalkeeper it does not, and by design.
    // The record sets how good he is, through one anchor. Whether he plays is
    // left entirely to price and ownership, and the sweep in `gkPreseason`'s
    // header is why.
    const withRecord = run(new Map([...past, [3, past.get(1)!]]));
    expect(withRecord.xp.get(3)!.next).toBeGreaterThan(xp.get(3)!.next * 1.05);
    // And it really is invisible in the allocation: identical shares.
    expect(withRecord.sh.get(3)!).toBe(sh.get(3)!);
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
    // ON THE HONESTY OF THIS FIXTURE. 1800 minutes with zero starts does not
    // happen. The real maximum across 2022-23..2025-26 for any player with
    // `starts == 0` is 332 minutes (Ahamada, 2023-24), and the next four are
    // 266, 214, 202 and 174 — 1800 would need 38 substitute appearances
    // averaging 47 minutes each. An earlier version of this comment defended
    // the fixture by saying "900 minutes off the bench is not 20 minutes",
    // which is 2.7x the observed maximum and not a defence of anything.
    //
    // It is kept anyway, because it is a controlled contrast rather than a
    // scouting report: holding minutes exactly equal is the only way to make
    // `starts` the sole difference, and an unrealistic level does not weaken
    // that — it makes the bar harder, since the sub's 1800 minutes argue for
    // him as loudly as the starter's do. What it cannot do on its own is show
    // the distinction survives at levels that actually occur, so the second
    // pair below runs the same comparison at the real ceiling: 330 minutes
    // each, four starts against none, which is a fringe starter beside a
    // genuine bench player. Measured 1.776 on the synthetic pair and 1.313 on
    // the realistic one, against a bar of 1.15 for both.
    const line = { points: 80, goals: 6, assists: 4, xg: 5.0, xa: 3.5, bonus: 8, ict: 90 };
    const past = new Map<number, PastSeasonStats>([
      [1, { ...line, minutes: 1800, starts: 20, seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 1800, starts: 20 }] }],
      [2, { ...line, minutes: 1800, starts: 0, seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 1800, starts: 0 }] }],
    ]);
    const xp = project([starter, sub], past);
    const realLine = { points: 14, goals: 1, assists: 1, xg: 0.9, xa: 0.7, bonus: 1, ict: 16 };
    const xpReal = project([starter, sub], new Map<number, PastSeasonStats>([
      [1, { ...realLine, minutes: 330, starts: 4, seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 330, starts: 4 }] }],
      [2, { ...realLine, minutes: 330, starts: 0, seasonName: "2025/26", plSeasons: 1,
            seasons: [{ seasonName: "2025/26", minutes: 330, starts: 0 }] }],
    ]));
    expect(xp.get(1)!.next).toBeGreaterThan(xp.get(2)!.next * 1.15);
    expect(xpReal.get(1)!.next).toBeGreaterThan(xpReal.get(2)!.next * 1.15);
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

  it("listens to the crowd only at the top of the ownership order", () => {
    // `priorPStartOwnGamma` was free. Every other test in this block either
    // sets it to 1 by hand, to isolate the range mapping, or asserts an
    // ordering that any positive exponent satisfies — so the shipped 2.6 could
    // have been 1.0 and the suite stayed green, which would have turned a
    // deliberately convex signal into a linear one without a word of warning.
    //
    // Convex is the claim. Ownership at the 50th percentile of a position is
    // not "half a vote of confidence": it is the ordinary state of an ordinary
    // squad player, and the archived seasons only separate on minutes at the
    // TOP of the order (1385 minutes in the least-owned quarter against 2087 in
    // the top decile — the gap between the 25th and the 75th is a fraction of
    // that). So the map has to stay near the floor for most of its domain and
    // climb late. Five players, evenly ranked, everything but ownership equal.
    const c = crowd([0.1, 1.0, 3.0, 9.0, 25.0]);
    XP_DEBUG.minutes = new Map();
    let v: number[];
    try {
      project(c.elements, c.past);
      v = [1, 2, 3, 4, 5].map((i) => XP_DEBUG.minutes!.get(i)!.pStart);
    } finally {
      XP_DEBUG.minutes = null;
    }
    // The ends are the ends whatever the exponent does — they are q = 0 and
    // q = 1 — so the shape lives entirely in where the middle sits between them.
    const span = v[4] - v[0];
    expect(span).toBeGreaterThan(0);
    const at = (i: number) => (v[i] - v[0]) / span;
    // Measured 0.16494 and 0.47339, which are exactly 0.5^2.6 and 0.75^2.6.
    // A linear map puts them at 0.50 and 0.75.
    expect(at(2)).toBeCloseTo(Math.pow(0.5, XP_CONFIG.priorPStartOwnGamma), 4);
    expect(at(2)).toBeCloseTo(0.1649, 3);
    expect(at(3)).toBeCloseTo(0.4734, 3);
    expect(at(2)).toBeLessThan(0.25);
  });

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

  it("abstains on an unreadable ownership column instead of calling it zero", () => {
    // `parseFloat("") || 0` and `parseFloat(undefined) || 0` are both 0, and 0
    // is a REAL VALUE here — the bottom of the position's ownership order. So a
    // parse failure used to arrive at the prior as a confident statement that
    // the crowd had rejected the player, which is the single worst thing a
    // missing field can be turned into. The four below are otherwise identical
    // and the crowd genuinely separates them; blanking one man's column must
    // silence the whole position, not sink him to the foot of it.
    const good = crowd([0.1, 1.0, 5.0, 20.0]);
    const broken = crowd([0.1, 1.0, 5.0, 20.0]);
    broken.elements[1] = { ...broken.elements[1], selected_by_percent: "" };
    const gx = project(good.elements, good.past);
    const bx = project(broken.elements, broken.past);
    // The signal is on in the good run...
    expect(gx.get(4)!.next).toBeGreaterThan(gx.get(1)!.next);
    // ...and off in the broken one, for everyone, rather than on with the
    // blanked player pinned to the floor.
    const alone = crowd([4.0]);
    const ax = project(alone.elements, alone.past);
    expect(bx.get(1)!.next).toBe(ax.get(1)!.next);
    expect(bx.get(4)!.next).toBe(bx.get(1)!.next);
    // The demote-on-failure bug puts the blanked man BELOW the 0.1%-owned one,
    // and leaves the other three separated. Both halves are asserted because
    // either alone is satisfiable by a rule that is still wrong.
    expect(bx.get(2)!.next).toBe(bx.get(1)!.next);
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

  // `own` supplies live `selected_by_percent` for the pair. Left off, every
  // keeper carries `el()`'s default — one identical string — and
  // `ownershipPercentiles` drops position 1 entirely, so `gkPreseason.ownWeight`
  // contributes nothing and no assertion made through this helper can constrain
  // it. Tests that are about the RECORD want that isolation. The confidence
  // ceiling below does not, and says so.
  function keepers(past: Map<number, PastSeasonStats>, own?: readonly [string, string]) {
    // Two keepers at the same club, so the allocator has a choice to make.
    const a = el({ id: 1, web_name: "GK A", team: 1, element_type: 1, now_cost: 50, ep_next: "3.0",
                   ...(own ? { selected_by_percent: own[0] } : {}) });
    const b = el({ id: 2, web_name: "GK B", team: 1, element_type: 1, now_cost: 50, ep_next: "3.0",
                   ...(own ? { selected_by_percent: own[1] } : {}) });
    // Two more clubs' worth of keepers, purely so the league-wide ownership
    // order the percentile is taken against has ends to it. They are at other
    // clubs and so never compete with the pair for the shirt.
    const filler = own
      ? ["0.1", "9.0"].map((o, i) =>
          el({ id: 10 + i, web_name: `GK F${i}`, team: 2 + i, element_type: 1, now_cost: 45,
               ep_next: "3.0", selected_by_percent: o }))
      : [];
    const xp = project([a, b, ...filler], past);
    return [xp.get(1)!.next, xp.get(2)!.next] as const;
  }

  /** The same fixture, read as the allocator's conditional shares. */
  function keeperShares(past: Map<number, PastSeasonStats>, own?: readonly [string, string]) {
    XP_DEBUG.minutes = new Map();
    try {
      keepers(past, own);
      const m = XP_DEBUG.minutes!;
      return [m.get(1)!.pStart, m.get(2)!.pStart] as const;
    } finally {
      XP_DEBUG.minutes = null;
    }
  }

  /**
   * The three tests that used to live here asked which SOURCE of a player's
   * record the model reads — `PastSeasonStats.minutes` (the most recent season
   * he actually played, which for a deposed keeper is two years old),
   * `lastSeason.minutes`, or the age-weighted walk in `preseasonEvidence`. They
   * were written against the keeper depth chart because that was where the bug
   * was found.
   *
   * They do not belong here any more, and moving them was not a way of avoiding
   * a red bar. With `gkPreseason.minutesWeight: 0` the depth chart does not read
   * a keeper's record at all, and `gkMm` REPLACES the generic minutes model for
   * a pre-season keeper rather than adjusting it — so `preseasonEvidence` is
   * dead code on this path. A test asserting the chart reads the right record
   * source would have been asserting something the code no longer does, and the
   * only way to make it pass would have been to re-introduce the term that three
   * seasons of outcomes say is harmful.
   *
   * The question is still live for every outfield player, where
   * `preseasonMinutes` reads exactly the same evidence. So the fixtures moved to
   * `pre-season record source` below, unchanged in substance, and assert on
   * `pStart` directly rather than on a downstream xP — which also removes a
   * confound the originals had: two keepers on equal shares still separate on
   * their per-90 scoring rates, so a broken chart could be masked by a deputy
   * with a flattering points-per-minute record.
   */
  it("does not hand out the shirt more confidently than the evidence allows", () => {
    // Every other assertion in this block is one-sided, so doubling `beta` or
    // `minutesWeight` — making the allocator far SHARPER than intended —
    // survives all of them. That direction is a named modelling error, not a
    // harmless retune: `gkPreseason`'s own comment records that picking a
    // club's number one from pre-season information alone is right 47 times in
    // 60, and cites Roefs, Trafford and Vicario as unknowns who took the shirt
    // off a same-priced incumbent. `slotMass: 0.95` says the same thing — even
    // a nailed keeper loses a few weeks to cups and knocks.
    //
    // So the clearest evidence gap the allocator can be shown — four full
    // seasons against a keeper who has never played a minute, and the crowd
    // agreeing — should still not produce near-certainty.
    //
    // The crowd has to be in the picture for this to be a ceiling at all. With
    // the pair left at the default ownership the position is dropped from the
    // percentile map, `ownWeight` multiplies nothing, and `ownWeight: 40` —
    // which reads 0.97 against 0.02 on a real depth chart — passed this suite
    // untouched. Ownership of 12% against 0.5% is an ordinary pre-season split
    // for a settled number one and his deputy, and it is what makes the number
    // below sensitive to all three sharpness knobs at once.
    const seasons = ["2022/23", "2023/24", "2024/25", "2025/26"];
    const past = new Map<number, PastSeasonStats>([
      [1, { points: 140, minutes: 3420, starts: 38, seasonName: "2025/26", plSeasons: 4,
            lastSeason: { seasonName: "2025/26", minutes: 3420, starts: 38 },
            seasons: seasons.map((s) => ({ seasonName: s, minutes: 3420, starts: 38 })) }],
      [2, { points: 0, minutes: 0, starts: 0, seasonName: "2025/26", plSeasons: 4,
            lastSeason: { seasonName: "2025/26", minutes: 0, starts: 0 },
            seasons: seasons.map((s) => ({ seasonName: s, minutes: 0, starts: 0 })) }],
    ]);
    const [nailed, never] = keepers(past, ["12.0", "0.5"]);
    // Measured 6.88. The bar was 6, set when the allocator still read a record
    // and the same fixture came out at 5.2 — so this moved, and the honest
    // account of why is that the number it was guarding changed underneath it,
    // not that the guard was wrong. `gkPreseason.ownWeight`'s comment records
    // the alternative that was rejected: dropping `ownWeight` 1.5 -> 1.0 turns
    // this green without argument, and that is fitting a constant to a bar this
    // repo set for itself rather than to an outcome.
    //
    // What it now guards is narrower than the name suggests, and the name is
    // kept because the direction it protects is the same. The chart no longer
    // reads a record at all, so 6.88 is produced ENTIRELY by `beta` and
    // `ownWeight` acting on a 12%-against-0.5% ownership split. It is a
    // sharpness guard on those two constants: doubling either sails past 7.5.
    // It is NOT a calibration statement, and it cannot be — see the test below
    // for the part of this fixture the chart genuinely ignores.
    expect(nailed).toBeGreaterThan(never * 1.5);
    expect(nailed).toBeLessThan(never * 7.5);
  });

  it("allocates the shirt without reading the keepers' records at all", () => {
    // `gkPreseason.minutesWeight: 0` is a deletion, and a deleted term needs a
    // test or it grows back. Four seasons as an ever-present against four
    // seasons of nothing is the largest record gap this fixture can express,
    // and the allocator's shares must not move by so much as a float when it is
    // taken away — because the chart is price and ownership and nothing else.
    //
    // This is the constant that three archived seasons argued hardest about.
    // Every weight above zero made the chart worse on every horizon: Brier at a
    // five-gameweek horizon .0557 / .0607 / .0661 / .0715 / .0816 / .0967 at
    // weights 0 / 0.2 / 0.4 / 0.6 / 1.0 / 2.4, club-level accuracy 48 / 47 / 46
    // / 46 / 46 / 43 out of 60. Seven gated variants, a start-RATE term, a
    // recency-only term, a saturating floor and a bare never-played indicator
    // were all tried; none beat a flat zero, and the two that came closest
    // collapsed onto the baseline to four decimals once confidence was matched.
    // The reason is redundancy, not irrelevance: a keeper who played every game
    // is priced up and owned, so the record is already in the score twice.
    const seasons = ["2022/23", "2023/24", "2024/25", "2025/26"];
    const past = new Map<number, PastSeasonStats>([
      [1, { points: 140, minutes: 3420, starts: 38, seasonName: "2025/26", plSeasons: 4,
            lastSeason: { seasonName: "2025/26", minutes: 3420, starts: 38 },
            seasons: seasons.map((s) => ({ seasonName: s, minutes: 3420, starts: 38 })) }],
      [2, { points: 0, minutes: 0, starts: 0, seasonName: "2025/26", plSeasons: 4,
            lastSeason: { seasonName: "2025/26", minutes: 0, starts: 0 },
            seasons: seasons.map((s) => ({ seasonName: s, minutes: 0, starts: 0 })) }],
    ]);
    const withRecord = keeperShares(past, ["12.0", "0.5"]);
    const without = keeperShares(new Map(), ["12.0", "0.5"]);
    expect(withRecord[0]).toBe(without[0]);
    expect(withRecord[1]).toBe(without[1]);
    // And the projections are NOT equal — 3.354 against 2.948 for the nailed
    // keeper — because a proven keeper's saves and clean sheets still feed the
    // per-90 anchors. Minutes are what the chart is blind to, and only minutes.
    // Without this line the test above would also pass if the record had been
    // dropped from the projection entirely.
    const [ratedWith] = keepers(past, ["12.0", "0.5"]);
    const [ratedWithout] = keepers(new Map(), ["12.0", "0.5"]);
    expect(ratedWith).toBeGreaterThan(ratedWithout * 1.1);
  });

  /**
   * Two keepers at one club on identical prices and identical (empty) records,
   * separated only by where the crowd has put them. Every other test in this
   * block leaves `selected_by_percent` at its default, which is the same string
   * for every player — so `ownershipPercentiles` drops the position entirely and
   * none of them exercise this at all.
   */
  function rivals(ownA: string, ownB: string, filler: string[] = ["0.1", "9.0"]) {
    const a = el({
      id: 1, web_name: "GK A", team: 1, element_type: 1, now_cost: 50,
      ep_next: "3.0", selected_by_percent: ownA,
    });
    const b = el({
      id: 2, web_name: "GK B", team: 1, element_type: 1, now_cost: 50,
      ep_next: "3.0", selected_by_percent: ownB,
    });
    // A percentile is a rank against the whole position, so the position needs
    // ends for the two rivals to sit between. These two play elsewhere.
    const rest = filler.map((o, i) =>
      el({
        id: 10 + i, web_name: `GK F${i}`, team: 2 + i, element_type: 1, now_cost: 45,
        ep_next: "3.0", selected_by_percent: o,
      })
    );
    const xp = project([a, b, ...rest]);
    return [xp.get(1)!.next, xp.get(2)!.next] as const;
  }

  /**
   * The same fixture read one layer earlier. `rivals` returns finished xP,
   * which is a share multiplied by everything else a keeper scores for; the
   * conservation property below is a property of the SHARE alone, so it has to
   * be read off `XP_DEBUG` rather than inferred from the projection.
   */
  function rivalShares(ownA: string, ownB: string) {
    XP_DEBUG.minutes = new Map();
    try {
      rivals(ownA, ownB);
      const m = XP_DEBUG.minutes!;
      return [m.get(1)!.pStart, m.get(2)!.pStart] as const;
    } finally {
      XP_DEBUG.minutes = null;
    }
  }

  it("gives the shirt to the keeper the crowd has picked when nothing else can tell them apart", () => {
    // The case the depth chart was worst at and the case that matters most in
    // July: a promoted club registers two keepers at £4.5m, neither has a
    // Premier League minute, and price and record have nothing left to say.
    // Ownership does — by GW1 a million managers have watched the friendlies.
    // Measured over the three archived seasons with a prior season to read,
    // at the W=5 window that decides in `gkPreseason.ownWeight`: with the term
    // at zero the score picks a club's real number one 40 times in 60, and
    // with it 48 (14 -> 16, 14 -> 16, 12 -> 16 by season), while the share it
    // hands the right man goes .546 to .692. An earlier draft said 47 and
    // ".569 to .680"; 47 contradicted the sweep table in `ownWeight` itself,
    // which has 48/60 at this setting, and .569 is 2024/25 alone quoted as
    // though it were the three seasons pooled. See `gkPreseason.ownWeight`.
    const [loved, ignored] = rivals("12.0", "0.4");
    expect(loved).toBeGreaterThan(ignored * 1.5);
  });

  it("moves the shirt between the rivals rather than handing out a bonus", () => {
    // The distinction a one-sided assertion cannot see. This is a SHARE of one
    // club's starts, so what the crowd gives one keeper it must take from the
    // other: adding the term to the finished xP instead of to the score inside
    // the softmax would lift the popular keeper exactly as far while leaving
    // his rival untouched, and pass the test above.
    //
    // THIS TEST DID NOT ACTUALLY CATCH THAT, WHICH IS THE WHOLE REASON THE
    // ASSERTIONS BELOW LOOK THE WAY THEY DO. Implementing the exact mutation
    // this comment describes — pull `crowd` out of the softmax score, carry it
    // on the list entry, and re-apply it afterwards as a one-sided multiplier
    // on the finished conditional share — left this test GREEN and reddened a
    // different one instead. The reason is that `ignored < evenB` compares a
    // 0.4%-owned keeper against a 3.0%-owned keeper, so it is satisfied by the
    // two keepers simply being owned differently; it never checks that the
    // shirt is conserved. Measured shares:
    //
    //                            GK A     GK B
    //     shipped, even         0.4750   0.4750
    //     shipped, lopsided     0.9231   0.0269
    //     bonus mutant, even    0.5925   0.5925
    //     bonus mutant, lopsided 0.9700  0.5160
    //
    // Under the mutant the rival barely moves, 0.5925 to 0.5160, and the old
    // assertion read that as "the shirt moved". The mutant also gives the pair
    // 1.486 of one shirt between them, which is the thing that is actually
    // wrong with it and the thing worth asserting.
    const [evenA, evenB] = rivalShares("3.0", "3.0");
    const [loved, ignored] = rivalShares("12.0", "0.4");
    expect(loved).toBeGreaterThan(evenA);
    // Not merely lower: the rival has to give up most of what he had. Shipped
    // 0.0269 against 0.4750 is a ratio of 0.057; the bonus mutant reads 0.871.
    expect(ignored).toBeLessThan(evenB * 0.2);
    // And conservation, which is the property a post-hoc bonus cannot have at
    // all. Both keepers are fully available here, so the pair must cover
    // exactly `slotMass` however the crowd splits it.
    const mass = XP_CONFIG.gkPreseason.slotMass;
    expect(evenA + evenB).toBeCloseTo(mass, 10);
    expect(loved + ignored).toBeCloseTo(mass, 10);
  });

  it("hands a doubtful number one's start probability to his deputy, not to nobody", () => {
    // The allocator's whole point, and it was quietly broken. The softmax
    // denominator weights each keeper by availability, so a doubtful incumbent
    // shrinks it and every rival's share goes up — but what is stored is a
    // share CONDITIONAL on being fit, because `fixtureXp` multiplies
    // availability back in afterwards. A dominant keeper at 50% therefore has
    // a conditional share above 1 (1.632 for the pair below), which is not a
    // bug, it is what multiplies back to a sensible 0.816.
    //
    // Clamping that conditional to `preseasonMaxPStart` deleted the difference.
    // The pair covered 0.60 of a shirt between them instead of 0.95, and the
    // third of a start that went missing was the DEPUTY'S — the one player
    // whose entire claim on a squad place is that the incumbent is doubtful.
    // Measured: the deputy gained 1.9x from his rival's flag where he should
    // have gained 6.45x — the figure the mass-conservation assertions below
    // quote, and an earlier draft said 7.3 here and 6.45 thirty lines down,
    // two numbers for one quantity inside one test.
    const past = new Map<number, PastSeasonStats>([
      [1, { points: 140, minutes: 3420, starts: 38, seasonName: "2025/26", plSeasons: 1,
            lastSeason: { seasonName: "2025/26", minutes: 3420, starts: 38 },
            seasons: [{ seasonName: "2025/26", minutes: 3420, starts: 38 }] }],
      [2, { points: 0, minutes: 0, starts: 0, seasonName: "2025/26", plSeasons: 1,
            lastSeason: { seasonName: "2025/26", minutes: 0, starts: 0 },
            seasons: [{ seasonName: "2025/26", minutes: 0, starts: 0 }] }],
    ]);
    const pair = (flag: Partial<Element>) => {
      const one = el({
        id: 1, web_name: "GK One", team: 1, element_type: 1, now_cost: 55,
        ep_next: "3.0", ...flag,
      });
      const two = el({
        id: 2, web_name: "GK Two", team: 1, element_type: 1, now_cost: 45,
        ep_next: "3.0",
      });
      XP_DEBUG.minutes = new Map();
      try {
        const xp = project([one, two], past);
        const m = XP_DEBUG.minutes!;
        return {
          // The CONDITIONAL share the allocator stored, which is what the bug
          // was in, and the finished projection, which is what the user sees.
          p: [m.get(1)!.pStart, m.get(2)!.pStart] as const,
          xp: [xp.get(1)!.next, xp.get(2)!.next] as const,
        };
      } finally { XP_DEBUG.minutes = null; }
    };
    const fit = pair({});
    const doubt = pair({ status: "d", chance_of_playing_next_round: 50 });
    // The invariant, and the cleanest statement of the bug: one club has
    // `slotMass` starts to give away, so the shares WEIGHTED BY AVAILABILITY
    // must add up to it whether anyone is flagged or not. Measured exactly:
    //
    //   fit    1.00*0.8779 + 1.00*0.0721 = 0.9500
    //   doubt  0.50*0.9700 + 1.00*0.4650 = 0.9500
    //
    // Clamping the conditional to `preseasonMaxPStart` without redistributing
    // the overflow left the flagged pair covering 0.60 of a shirt, and the
    // third of a start that went missing was the DEPUTY'S — the one player
    // whose entire claim on a squad place is that the incumbent is doubtful.
    const mass = XP_CONFIG.gkPreseason.slotMass;
    expect(fit.p[0] * 1 + fit.p[1] * 1).toBeCloseTo(mass, 10);
    expect(doubt.p[0] * 0.5 + doubt.p[1] * 1).toBeCloseTo(mass, 10);
    // The incumbent's conditional share is ABOVE his fit share (0.97 against
    // 0.878) and that is not a bug: it is a share conditional on being fit,
    // which `fixtureXp` multiplies availability back into afterwards. What the
    // user sees is the projection, and that halves.
    expect(doubt.xp[0]).toBeLessThan(fit.xp[0] * 0.7);
    expect(doubt.xp[0]).toBeGreaterThan(fit.xp[0] * 0.4);
    // The deputy is the other half of the assertion. A coin flip on the
    // incumbent should put him near half a shirt, not leave him on scraps:
    // 0.0721 to 0.4650, a factor of 6.45.
    expect(doubt.p[1]).toBeGreaterThan(fit.p[1] * 4);
  });
});

/**
 * Which record the pre-season minutes model reads, asked of an outfield player.
 *
 * These three fixtures were originally written against the goalkeeper depth
 * chart, which is where the bug was found and fixed. The chart no longer reads a
 * record at all (`gkPreseason.minutesWeight: 0`), but `preseasonMinutes` still
 * does, for every one of the ~600 outfield players in a draft — so this is where
 * the regression has to live to mean anything.
 *
 * They assert on `pStart` out of `XP_DEBUG` rather than on a projected xP. The
 * originals compared two players' finished projections, which mixes the minutes
 * model together with their per-90 scoring rates; a fringe player with a
 * flattering points-per-minute record could carry the assertion on his own.
 */
describe("pre-season record source", () => {
  // A midfielder, so `preseasonMinutes` runs rather than the keeper chart, and
  // at one club so nothing else competes for the reading. Prices are equal
  // throughout: `priorPStart` is a function of price and ownership, and holding
  // both fixed is what leaves the record as the only thing that can move.
  function midfielders(past: Map<number, PastSeasonStats>) {
    XP_DEBUG.minutes = new Map();
    try {
      const a = el({ id: 1, web_name: "MID A", team: 1, element_type: 3, now_cost: 55, ep_next: "3.0" });
      const b = el({ id: 2, web_name: "MID B", team: 1, element_type: 3, now_cost: 55, ep_next: "3.0" });
      project([a, b], past);
      const m = XP_DEBUG.minutes!;
      return [m.get(1)!.pStart, m.get(2)!.pStart] as const;
    } finally {
      XP_DEBUG.minutes = null;
    }
  }

  it("reads last season, not the last season the player happened to play", () => {
    // `PastSeasonStats.minutes` is the most recent season the player ACTUALLY
    // PLAYED, because the per-90 rates need a season with pitch time in it. For
    // a player who lost his place that is two years old, and reading it here
    // handed him the shirt over the man who has it now.
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
    const [deposed, incumbent] = midfielders(past);
    // Measured pStart 0.643 against 0.312. The age weighting is 0.55 a season,
    // so the deposed player's 34 starts survive at 18.7 against the incumbent's
    // 40.2 — a real gap, not a wipeout, which is the right answer for someone
    // who was a regular fifteen months ago. The lower bound is half the
    // assertion: a rule that simply ignored anything before last season would
    // clear the ratio easily and put him at 0.035, and the next test is what
    // that costs.
    expect(incumbent).toBeGreaterThan(deposed * 1.5);
    expect(deposed).toBeGreaterThan(0.25);
  });

  it("does not throw away an established regular who missed one season injured", () => {
    // The reason this reads age-weighted evidence rather than simply
    // `lastSeason.minutes`: a player with three seasons as a starter who lost
    // the most recent to injury is not the same as a career substitute, and a
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
    const [established, deputy] = midfielders(past);
    // The three candidate sources, re-measured on these two fixtures by
    // swapping the source inside `preseasonMinutes` and reading `pStart` back
    // out. Columns are incumbent-over-deposed (previous test) and
    // established-over-deputy (this one):
    //
    //   PastSeasonStats.minutes    1.11    5.25   <- the bug: cannot separate
    //   lastSeason.minutes        25.95    0.20   <- fixes one, inverts this
    //   age-weighted evidence      2.06    5.35   <- both right
    //
    // Read the middle row before touching this. `lastSeason` looks like the
    // obvious one-token fix for the deposed case and is spectacular at it — and
    // it rates a man with three seasons as a starter at a FIFTH of a career
    // substitute's odds, because one injured year is the only year it can see.
    // The top row is the original bug: 1.11x is not a judgement, it is a
    // coin toss between a player who has the shirt and one who lost it.
    expect(established).toBeGreaterThan(deputy * 2);
  });

  it("shrinks an ever-present downward, not just a fringe player upward", () => {
    // The rejection record for the ONE-SIDED PRIOR FLOOR, which was proposed
    // twice and is the kind of change that looks free. See `preseasonMinutes`
    // for the argument; this is the fixture that makes it fail.
    //
    // A cheap ever-present is the case. 38 starts in 38 games is a rate of
    // 1.000 and the price prior for a GBP 4.5m midfielder is 0.080, so the
    // convex blend at k = 6 returns (38 + 0.080 * 6) / 44 = 0.8745. Under
    // `max(rate, prior)` it returns 1.000, clipped to `preseasonMaxPStart` =
    // 0.970 — the model would be claiming a GBP 4.5m player starts 37 of 38.
    // Nobody does; last season's 38 is the tail of a distribution, not its
    // mean, and shrinkage is what turns one into the other.
    const evenPresent = (cost: number) => {
      XP_DEBUG.minutes = new Map();
      try {
        const a = el({ id: 1, web_name: "EP", team: 1, element_type: 3, now_cost: cost, ep_next: "3.0" });
        project([a], new Map<number, PastSeasonStats>([
          [1, { points: 150, minutes: 3420, starts: 38, seasonName: "2025/26", plSeasons: 1,
                lastSeason: { seasonName: "2025/26", minutes: 3420, starts: 38 },
                seasons: [{ seasonName: "2025/26", minutes: 3420, starts: 38 }] }],
        ]));
        return XP_DEBUG.minutes!.get(1)!.pStart;
      } finally {
        XP_DEBUG.minutes = null;
      }
    };
    expect(evenPresent(45)).toBeCloseTo(0.8745, 4);
    expect(evenPresent(55)).toBeCloseTo(0.8983, 4);
    // The bar that kills the mutant. A one-sided floor cannot land below the
    // observed rate, so it reads 0.970 for both of these.
    expect(evenPresent(45)).toBeLessThan(0.92);
    expect(evenPresent(45)).toBeLessThan(XP_CONFIG.preseasonMaxPStart - 0.05);
    // And the direction is the whole point: the prior pulls him DOWN. Every
    // other test of this blend has the prior pulling somebody up, which is the
    // half a one-sided floor keeps.
    expect(evenPresent(45)).toBeLessThan(38 / 38);
    // A premium ever-present is NOT a valid fixture for this, and the fixture
    // choice is load-bearing: at GBP 11.0m the prior is high enough that the
    // blend and the floor agree at 0.970 and the mutation survives.
    expect(evenPresent(110)).toBeCloseTo(XP_CONFIG.preseasonMaxPStart, 10);
  });

  it("does not let a long career read as a nailed one", () => {
    // A substitute playing a third of every season for five years accumulates a
    // bigger age-weighted MINUTES SUM than a nailed starter has in one season.
    // Any comparison of that sum against an absolute threshold therefore reads
    // him as a regular — which is exactly the bug this fixture was written for,
    // when the keeper chart compared it against `minutesCap: 2000`, a ceiling
    // whose own comment said "a full season is a full season".
    //
    // `preseasonMinutes` is immune by construction, because it divides the sum
    // by the matching `games` sum and so only ever sees a RATE. That is worth a
    // test rather than a comment: the sums are right there on `ev`, the
    // temptation to threshold one of them directly is what caused the original
    // bug, and this fixture is the one that catches it. Five seasons of 1080
    // minutes decay to weights of 1, 0.55, 0.3025, 0.1664 and 0.0915, so the
    // deputy's weighted minutes come to 2279 — over `minutesCap: 2000`, and
    // over any single season he ever played. An earlier draft said 2334, which
    // is the SIX-season sum this fixture does not have. Neither fixture above
    // reaches it: the deposed starter in the first sums to 1683 and the career
    // deputy in the second to 540, so a rule that thresholded the sum would
    // have passed both and failed only here. (That draft said "leave him at
    // 540 and 1683", which silently swapped which player it meant — 1683 is
    // the deposed man of fixture one, whose deputy sums to 3618.)
    const seasons = ["2021/22", "2022/23", "2023/24", "2024/25", "2025/26"];
    const past = new Map<number, PastSeasonStats>([
      [1, { points: 140, minutes: 3420, starts: 38, seasonName: "2025/26", plSeasons: 5,
            lastSeason: { seasonName: "2025/26", minutes: 3420, starts: 38 },
            seasons: seasons.map((s) => ({ seasonName: s, minutes: 3420, starts: 38 })) }],
      [2, { points: 45, minutes: 1080, starts: 12, seasonName: "2025/26", plSeasons: 5,
            lastSeason: { seasonName: "2025/26", minutes: 1080, starts: 12 },
            seasons: seasons.map((s) => ({ seasonName: s, minutes: 1080, starts: 12 })) }],
    ]);
    const [nailed, deputy] = midfielders(past);
    // Measured 0.948 against 0.311.
    expect(nailed).toBeGreaterThan(deputy * 1.5);
  });
});

describe("pre-season club start mass", () => {
  // Eleven shirts have to go SOMEWHERE. `priorPStart` scores a record-less
  // player against the LEAGUE-wide price and ownership order, which is a
  // statement about how good he is, not about whether he plays — so a club the
  // market has priced cheaply ends up with about six starters and a club it
  // has priced dearly with about eleven. Measured over the three informative
  // archive seasons (2023-24, 2024-25, 2025-26; 2022-23 has no prior season on
  // the archive and is uninformative), the sum of `pStart` over a club's
  // outfielders was 10.5-11.2 for established clubs and 4.4-6.4 for promoted
  // ones, against ~10 realised everywhere.
  //
  // The fixtures below are the smallest thing that reproduces that: two clubs
  // with identical squad SHAPES that differ only in what the market thinks of
  // them.

  const PROMOTED = 1; // cheap, nobody has a Premier League record
  const ESTABLISHED = 7; // eleven nailed regulars on the books

  /** A club of `n` outfielders on a descending price ladder from `top`. */
  function club(teamId: number, idBase: number, n: number, top: number): Element[] {
    return Array.from({ length: n }, (_, i) =>
      el({
        id: idBase + i,
        web_name: `T${teamId}P${i}`,
        team: teamId,
        element_type: ((i % 3) + 2) as 2 | 3 | 4,
        now_cost: Math.max(40, top - i * 3),
      })
    );
  }

  /** 38-start records for the first `n` ids of a club. */
  function nailed(ids: number[]): Map<number, PastSeasonStats> {
    return new Map(
      ids.map((id) => [
        id,
        {
          points: 130,
          minutes: 3200,
          starts: 36,
          seasonName: "2025/26",
          plSeasons: 1,
          lastSeason: { seasonName: "2025/26", minutes: 3200, starts: 36 },
          seasons: [{ seasonName: "2025/26", minutes: 3200, starts: 36 }],
        } satisfies PastSeasonStats,
      ])
    );
  }

  // Promoted: 18 record-less outfielders, £4.0m-£5.5m. Established: the same
  // 18 shapes, but £5.0m-£10.1m and the top NINE with a full season behind
  // them. Both get the two keepers every club registers, so the depth chart
  // has something to allocate.
  //
  // Nine and not eleven, deliberately. The established club has to be over the
  // target by LESS than its own record-less players are worth, or a rule that
  // normalised downward as well as up would find nothing to take and the
  // up-only test below could not fail. At eleven the club's surplus was 3.58
  // against 3.28 of movable mass and the down-normalising mutant was a silent
  // no-op; at nine the surplus is smaller than the movable mass and the mutant
  // scales those players to a quarter of their value.
  const promoted = club(PROMOTED, 100, 18, 55);
  const established = club(ESTABLISHED, 200, 18, 101);
  const keepers = [
    el({ id: 90, web_name: "GK A1", team: PROMOTED, element_type: 1, now_cost: 45 }),
    el({ id: 91, web_name: "GK A2", team: PROMOTED, element_type: 1, now_cost: 40 }),
    el({ id: 92, web_name: "GK B1", team: ESTABLISHED, element_type: 1, now_cost: 55 }),
    el({ id: 93, web_name: "GK B2", team: ESTABLISHED, element_type: 1, now_cost: 40 }),
  ];
  const elements = [...promoted, ...established, ...keepers];
  const past = nailed(Array.from({ length: 9 }, (_, i) => 200 + i));

  /** elementId -> shipped `pStart`, read out of the shipped call. */
  function pStarts(): Map<number, number> {
    XP_DEBUG.minutes = new Map();
    try {
      project(elements, past);
      return new Map([...XP_DEBUG.minutes].map(([id, m]) => [id, m.pStart]));
    } finally {
      XP_DEBUG.minutes = null;
    }
  }

  /** The same, with the mechanism switched off — the control every claim here
   *  is stated against. */
  function baseline(): Map<number, number> {
    const before = XP_CONFIG.preseasonClubStartMass;
    try {
      XP_CONFIG.preseasonClubStartMass = 0;
      return pStarts();
    } finally {
      XP_CONFIG.preseasonClubStartMass = before;
    }
  }

  const sum = (p: Map<number, number>, ids: Element[]) =>
    ids.reduce((s, e) => s + (p.get(e.id) ?? 0), 0);

  it("gives a club the league has priced cheaply a full eleven's worth of starts", () => {
    // The headline. Without this the promoted club fields about six men.
    const before = sum(baseline(), promoted);
    const after = sum(pStarts(), promoted);
    expect(before).toBeLessThan(8);
    expect(after).toBeCloseTo(XP_CONFIG.preseasonClubStartMass, 1);
    // Pinned to the LITERAL, because every other assertion in this block reads
    // the target back out of the config and so holds for any value at all —
    // including 0, which switches the mechanism off. The value is not a free
    // parameter: it is the measured number of a match's ten outfield starts
    // that go to players already on their club's GW1 element list (9.597 over
    // 60 club-seasons; the goalkeeper control returns 0.993 against a known 1).
    // The docstring on `preseasonClubStartMass` carries the derivation, the
    // per-season Brier, and the refuted alternatives. Change one, change both.
    expect(XP_CONFIG.preseasonClubStartMass).toBeCloseTo(9.6, 10);
    expect(after).toBeGreaterThan(9);
    expect(after).toBeLessThan(10);
  });

  it("leaves a club that already has eleven starters alone", () => {
    // Up only. Making the sum an equality instead of a floor would pull the
    // established club DOWN to the target, and that costs accuracy on the
    // players the model actually drafts: measured over the three informative
    // seasons, allowing both directions moved has-record Brier from .1945 to
    // .1965 while the floor-only rule left it untouched.
    const before = baseline();
    const after = pStarts();
    expect(sum(before, established)).toBeGreaterThan(XP_CONFIG.preseasonClubStartMass);
    for (const e of established) expect(after.get(e.id)).toBe(before.get(e.id));
  });

  it("takes the shortfall out of the record-less players, not the known ones", () => {
    // A club can be short AND contain regulars — a promoted side that kept a
    // Premier League veteran, or an established side that sold half its squad.
    // The deficit is evidence about the players nothing is known about, so
    // spreading it over a man with 36 starts on the books would overwrite the
    // one number that was measured rather than guessed. Absorbing it into the
    // record-less players alone landed pool Brier at .1953; spreading it over
    // everyone landed .1967, worse than doing nothing to the record-less.
    const mixedTeam = 12;
    const mixed = club(mixedTeam, 300, 18, 55);
    const mixedPast = nailed([300, 301, 302]);
    const withMixed = [...elements, ...mixed];
    const allPast = new Map([...past, ...mixedPast]);
    const run = () => {
      XP_DEBUG.minutes = new Map();
      try {
        projectAll({
          bootstrap: {
            events: [{ id: 1, name: "Gameweek 1", deadline_time: "2026-08-21T17:30:00Z",
                       finished: false, is_current: false, is_next: true,
                       average_entry_score: 0, highest_score: null }],
            teams, elements: withMixed, total_players: 1_167_938,
          } as unknown as Bootstrap,
          fixtures, nextEvent: 1, horizon: 1, pastSeason: allPast,
        });
        return new Map([...XP_DEBUG.minutes].map(([id, m]) => [id, m.pStart]));
      } finally {
        XP_DEBUG.minutes = null;
      }
    };
    const cfg = XP_CONFIG;
    const keep = cfg.preseasonClubStartMass;
    let off: Map<number, number>;
    try {
      cfg.preseasonClubStartMass = 0;
      off = run();
    } finally {
      cfg.preseasonClubStartMass = keep;
    }
    const on = run();
    // The three with a record are untouched...
    for (const id of [300, 301, 302]) expect(on.get(id)).toBe(off.get(id));
    // ...and the club still reaches the target, so the deficit went somewhere.
    expect(mixed.reduce((s, e) => s + on.get(e.id)!, 0)).toBeCloseTo(keep, 1);
    expect(on.get(303)!).toBeGreaterThan(off.get(303)! * 1.2);
  });

  it("will not find eleven starters in a squad that has not got eleven players", () => {
    // The rule is an accounting identity over a real squad, and it stops being
    // one the moment the list it is handed is not a squad. Asked to find ten
    // starts among three men it multiplies all three by about eight and pins
    // them at the ceiling — which is not a correction, it is the deletion of
    // every distinction the rest of the model paid for in evidence. A live
    // bootstrap never gets near this — the archive's end-of-season lists carry
    // 26-50 outfielders per club, and the GW1 bootstrap this actually runs
    // against carries 22-39 — but a partial one can, and the whole reason this
    // guard exists is that without it four unrelated tests silently changed
    // their answers, every one of them a TWO-man fixture: "lets an ancient rate
    // line decay out instead of freezing it forever" in this file, and "does
    // not rate an unknown above a proven regular of the same price", "separates
    // two unknowns by price when FPL offers no estimate" and "does not read a
    // season without a starts column as a season of no starts" in
    // `preseasonPipeline.test.ts`. An earlier draft said six, and said "two-
    // and three-man fixtures" when all four are two-man.
    const tiny = [
      el({ id: 500, web_name: "Tiny A", team: 3, element_type: 3, now_cost: 55 }),
      el({ id: 501, web_name: "Tiny B", team: 3, element_type: 3, now_cost: 45 }),
      el({ id: 502, web_name: "Tiny C", team: 3, element_type: 2, now_cost: 40 }),
    ];
    const run = (mass: number) => {
      const keep = XP_CONFIG.preseasonClubStartMass;
      XP_DEBUG.minutes = new Map();
      try {
        XP_CONFIG.preseasonClubStartMass = mass;
        project([...elements, ...tiny], past);
        return new Map([...XP_DEBUG.minutes].map(([id, m]) => [id, m.pStart]));
      } finally {
        XP_DEBUG.minutes = null;
        XP_CONFIG.preseasonClubStartMass = keep;
      }
    };
    const off = run(0);
    const on = run(XP_CONFIG.preseasonClubStartMass);
    for (const e of tiny) expect(on.get(e.id)).toBe(off.get(e.id));
    // ...while a club that IS a squad, in the same bootstrap and the same call,
    // is corrected as usual. The guard is about the club, not about the run.
    expect(sum(on, promoted)).toBeCloseTo(XP_CONFIG.preseasonClubStartMass, 1);
  });

  it("keeps the market's ordering inside the club", () => {
    // Proportional, not flat. The prior knows nothing about who plays but it
    // does know who the market rates, and a flat top-up would throw that away
    // by handing the £4.0m man and the £5.5m man the same lift.
    const before = baseline();
    const after = pStarts();
    const max = XP_CONFIG.preseasonMaxPStart;
    // One multiplier for everyone the ceiling does not bind on. That IS
    // proportionality, and a flat top-up cannot fake it.
    const free = promoted.filter((e) => after.get(e.id)! < max - 1e-9);
    const k = after.get(free[0].id)! / before.get(free[0].id)!;
    expect(k).toBeGreaterThan(1);
    for (const e of free) expect(after.get(e.id)! / before.get(e.id)!).toBeCloseTo(k, 6);
    // And the order the market gave survives end to end — ties only where the
    // ceiling has flattened two players onto it.
    for (const a of promoted) {
      for (const b of promoted) {
        if (before.get(a.id)! > before.get(b.id)!) {
          expect(after.get(a.id)!).toBeGreaterThanOrEqual(after.get(b.id)! - 1e-9);
        }
      }
    }
  });

  it("never lifts anyone past the ceiling, and does not lose the overflow", () => {
    // Nobody starts every game. The redistribution loop exists so that clipping
    // the leaders does not quietly bin what was clipped: a club whose top
    // players hit the ceiling must reach the target by pushing the remainder
    // further down the ladder, not by landing short. A single scaling pass with
    // a clamp on the end passes every other test in this block and undershoots
    // here by exactly the overflow.
    const before = baseline();
    const after = pStarts();
    const max = XP_CONFIG.preseasonMaxPStart;
    const pinned = promoted.filter((e) => after.get(e.id)! >= max - 1e-9);
    // If nothing reaches the ceiling the rest of this proves nothing.
    expect(pinned.length).toBeGreaterThan(0);
    for (const e of promoted) expect(after.get(e.id)!).toBeLessThanOrEqual(max + 1e-9);
    // Everyone else is lifted by MORE than the single-pass multiplier...
    const onePass = XP_CONFIG.preseasonClubStartMass / sum(before, promoted);
    const spare = promoted.find((e) => after.get(e.id)! < max - 1e-9)!;
    expect(after.get(spare.id)! / before.get(spare.id)!).toBeGreaterThan(onePass);
    // ...and the club total is exact, not short by what the ceiling took.
    expect(sum(after, promoted)).toBeCloseTo(XP_CONFIG.preseasonClubStartMass, 6);
    // The ceiling itself, pinned to the literal for the same reason the target
    // is above: `max` is read out of the config, so every bar in this block
    // that mentions it is satisfied by any value in (0, 1]. 0.97 is the claim
    // that nobody starts every game he is fit for — an ever-present misses
    // about one in 33 through squad rotation alone — and it is load-bearing:
    // the redistribution loop below only exists because it bites.
    expect(max).toBeCloseTo(0.97, 10);
    expect(pinned.every((e) => Math.abs(after.get(e.id)! - 0.97) < 1e-9)).toBe(true);
  });

  it("does nothing once the season is under way", () => {
    // Strictly a pre-season rule. It exists because nobody has kicked a ball;
    // the moment anybody has, the club's real starters are observable and the
    // sum being short is no longer an accounting error — it is a rotating
    // squad, correctly described. Leaving the rule on would go on inflating the
    // men who are visibly being left out week after week, which is precisely
    // the group the in-season model has just learned something about.
    //
    // The fixture has to be SHORT, and short in the specific way that only
    // happens in-season, for this to prove anything. Three matches into the
    // season the promoted club has fielded none of these eighteen: their club
    // sums to zero against a target of ten, the largest deficit the rule can
    // ever see. It is also the one it must not touch, because "he has not
    // played" is now an observation and not an absence of evidence.
    //
    // Giving them a minute each instead would prove nothing: a bootstrap
    // minutes count is itself evidence (`preseasonEvidence`'s last branch), so
    // they would be exempt for a second reason and the gate could be deleted
    // without any test noticing.
    const played = elements.map((e) =>
      e.team === PROMOTED && e.element_type !== 1 ? e : el({ ...e, minutes: 270, starts: 3 })
    );
    const inSeason = [1, 2, 3].flatMap((ev) =>
      fixtures.map((f) => ({ ...f, id: f.id + ev * 100, event: ev, finished: true, started: true }))
    );
    XP_DEBUG.minutes = new Map();
    let p: Map<number, number>;
    try {
      projectAll({
        bootstrap: {
          events: [1, 2, 3, 4].map((id) => ({
            id, name: `Gameweek ${id}`, deadline_time: "2026-08-21T17:30:00Z",
            finished: id < 4, is_current: false, is_next: id === 4,
            average_entry_score: id < 4 ? 50 : 0, highest_score: id < 4 ? 120 : null,
          })),
          teams, elements: played, total_players: 1_167_938,
        } as unknown as Bootstrap,
        fixtures: inSeason,
        nextEvent: 4,
        horizon: 1,
        pastSeason: past,
      });
      p = new Map([...XP_DEBUG.minutes].map(([id, m]) => [id, m.pStart]));
    } finally {
      XP_DEBUG.minutes = null;
    }
    // Nobody played, and nobody is talked back up to having played.
    for (const e of promoted) expect(p.get(e.id)!).toBe(0);
    expect(sum(p, promoted)).toBe(0);
  });
});
