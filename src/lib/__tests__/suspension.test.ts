// A player on four bookings is one tackle from a one-match ban, and until that
// tackle lands his `status` is a blameless "a". The model used to treat him as
// certain to play for the whole planning horizon.
//
// Measured over the four archived seasons, among established starters (>=4
// starts in their last 5) who played the current round and were not sent off:
//
//                                        n    missed NEXT round      se
//   not one booking from a ban       16012          0.0837        0.0022
//   one from 5, but past match 19     1565          0.0799        0.0069
//   one from 10, but past match 32     126          0.0635        0.0217
//   one from 5, inside the window      465          0.2301        0.0195
//   one from 10, inside the window      52          0.1538        0.0500
//
// The two placebo rows carry most of the argument: same card counts, but their
// threshold window has shut so the cards cannot ban them, and they sit on the
// baseline. That is what a rule effect looks like and not what a "card
// collectors are different players" confound looks like.
//
// It is not a clean control, and the docstring on `suspensionMissProbs` says why
// at length: placebo membership requires taking more than 19 matches to reach
// four cards, which selects the slower card-collectors, and it is perfectly
// collinear with late season. Both biases push the placebo rate down, so 0.146
// is an upper bound on the effect rather than an unbiased estimate. The
// direction is not in doubt — the mechanism is a written rule — but the
// magnitude is softer than the standard errors suggest, and the tests below are
// written with tolerances that reflect that.
//
// The single most important property in this file is the FIRST test, and it is
// worth stating exactly rather than approximately. When the imminent gameweek
// gives a club ONE fixture, the term is a strict no-op: this week's starting
// eleven and captain cannot move because of it, by construction, because a ban
// FPL has already imposed arrives through `status` instead. When the imminent
// gameweek is a DOUBLE, the second leg is discounted, because a booking in the
// first leg really can cost the second. The first test asserts both halves —
// the earlier draft of it asserted only the first and read as a blanket
// guarantee that the code does not make and should not make.
//
// Mutation tested. Two mutations are survivable individually and caught only in
// combination: the `j < 1` and `j < need` guards in `suspensionMissProbs` each
// cover the other, so removing either alone changes no output, while removing
// both prices a suspension into an imminent single fixture and six tests here
// fail (re-counted by actually re-running the pair deletion after the last two
// tests were added — the number said four for a while, and said in the same
// breath that it had been counted rather than estimated, which is exactly the
// kind of claim that has to be refreshed when the file grows).
// That is recorded so a future reader does not mistake a survivable mutation
// for an untested line.

import { describe, expect, it } from "vitest";
import { suspensionAvail, suspensionMissProbs, XP_CONFIG, projectAll } from "../xp";
import type { Bootstrap, Element, Fixture, Team } from "../types";

/** `element_type` 2 is a defender; 1 GK, 3 MID, 4 FWD. */
function player(yellows: number, elementType = 2): Element {
  return { id: 1, team: 1, element_type: elementType, yellow_cards: yellows } as Element;
}

const DEF_RATE = 0.1684;

describe("suspensionAvail", () => {
  it("never touches an imminent single fixture, but does price an imminent double", () => {
    // The safety property. A ban he has ALREADY earned is FPL's to report via
    // status "s", and FPL knows whether it has been served; inferring a live
    // ban from the card count would mean guessing at service state and could
    // bench an available player. So a single imminent fixture is 1, exactly,
    // whatever the count.
    for (const y of [0, 4, 5, 9, 14, 20]) {
      expect(suspensionAvail(player(y), 0, 1, 10, 1)).toBe(1);
      expect(suspensionAvail(player(y), -1, 1, 10, 1)).toBe(1);
    }
    // But the guarantee is about service state, not about the calendar, and it
    // stops exactly where the reasoning stops. In an imminent DOUBLE he can be
    // booked in the first leg and banned for the second, which is a risk this
    // week's projection genuinely carries. One of two matches lost with
    // probability q, so the multiplier is 1 - q/2.
    const q = DEF_RATE;
    expect(suspensionAvail(player(4), 0, 2, 10, 1)).toBeCloseTo(1 - q / 2, 9);
    // And the exemption really is about the count, not about doubles: a man
    // nowhere near a threshold is untouched in a double as well.
    expect(suspensionAvail(player(0), 0, 2, 10, 1)).toBe(1);
  });

  it("prices one-away risk at the rate the archive actually shows", () => {
    // A nailed defender on four yellows, his club ten matches in, projected one
    // week out. The term must remove his per-match booking probability.
    const a = suspensionAvail(player(4), 1, 1, 10, 1);
    expect(a).toBeCloseTo(1 - DEF_RATE, 6);
    // What the term prices has to match what was measured OUT of model, and
    // that comparison is the point of this test rather than the line above,
    // which only restates the constant. In-window one-from-5 starters missed
    // the next round 0.2301 of the time against a 0.0837 baseline, so the
    // excess attributable to the ban is 0.1464 with a standard error of about
    // 0.021. The modelled excess must land inside two of those.
    const excess = 1 - a;
    const observed = 0.2301 - 0.0837;
    expect(Math.abs(excess - observed)).toBeLessThan(2 * 0.021);
  });

  it("stops caring once the threshold's window has closed", () => {
    // Five bookings only ban you if they land in the side's first 19 matches.
    // At 19 played, the fixture at offset 1 is match 20 and the booking that
    // would trigger it falls in match 20 as well — out of the window.
    expect(suspensionAvail(player(4), 1, 1, 15, 1)).toBeCloseTo(1 - DEF_RATE, 6);
    expect(suspensionAvail(player(4), 1, 1, 18, 1)).toBeCloseTo(1 - DEF_RATE, 6);
    expect(suspensionAvail(player(4), 1, 1, 19, 1)).toBe(1);
    expect(suspensionAvail(player(4), 1, 1, 30, 1)).toBe(1);
  });

  it("moves on to the next threshold rather than resetting", () => {
    // Five cards does not wipe the slate; it starts the walk to ten. A player
    // on 5 needs five more, which cannot happen inside a one-week horizon...
    expect(suspensionAvail(player(5), 1, 1, 10, 1)).toBe(1);
    // ...but a player on 9 is one away from the two-match ban, and that window
    // runs to match 32 rather than 19.
    expect(suspensionAvail(player(9), 1, 1, 25, 1)).toBeCloseTo(1 - DEF_RATE, 6);
    expect(suspensionAvail(player(9), 1, 1, 32, 1)).toBe(1);
  });

  it("charges bookings to starts, so a rotation player risks less", () => {
    // q = positional rate * P(he starts). A man who starts half the time picks
    // up cards at half the rate, so his ban risk halves with him.
    expect(suspensionAvail(player(4), 1, 1, 10, 0.5)).toBeCloseTo(1 - DEF_RATE * 0.5, 6);
    expect(suspensionAvail(player(4), 1, 1, 10, 0)).toBe(1);
  });

  it("uses the position's own booking rate", () => {
    // Keepers are booked at less than half the rate of outfielders, and the
    // difference is large enough that a shared rate would be wrong for both.
    const gk = 1 - suspensionAvail(player(4, 1), 1, 1, 10, 1);
    const def = 1 - suspensionAvail(player(4, 2), 1, 1, 10, 1);
    const mid = 1 - suspensionAvail(player(4, 3), 1, 1, 10, 1);
    const fwd = 1 - suspensionAvail(player(4, 4), 1, 1, 10, 1);
    expect(gk).toBeLessThan(fwd);
    expect(fwd).toBeLessThan(mid);
    expect(mid).toBeLessThan(def);
    expect(gk).toBeCloseTo(0.0762, 6);
    expect(def).toBeCloseTo(0.1684, 6);
  });

  it("spreads a single ban across the horizon instead of charging it twice", () => {
    // With one card needed, the ban lands at offset k exactly when the booking
    // arrives at offset k-1, so the risk at each offset is q(1-q)^(k-1): it
    // decays, because reaching offset k un-banned means he kept missing out on
    // the card. Summing the risks must stay below 1 — he serves one ban, not
    // one per week.
    let sum = 0;
    let prev = 1;
    for (let k = 1; k <= 6; k++) {
      const risk = 1 - suspensionAvail(player(4), k, 1, 5, 1);
      expect(risk).toBeCloseTo(DEF_RATE * Math.pow(1 - DEF_RATE, k - 1), 6);
      expect(risk).toBeLessThan(prev);
      prev = risk;
      sum += risk;
    }
    expect(sum).toBeLessThan(1);
  });

  it("needs as many matches as it needs cards", () => {
    // Two cards short of the line, he cannot be banned for next week at all,
    // and the week after requires both bookings to have landed.
    expect(suspensionAvail(player(3), 1, 1, 5, 1)).toBe(1);
    expect(1 - suspensionAvail(player(3), 2, 1, 5, 1)).toBeCloseTo(DEF_RATE * DEF_RATE, 6);
    // Three short: nothing for two weeks, then q^3.
    expect(suspensionAvail(player(2), 2, 1, 5, 1)).toBe(1);
    expect(1 - suspensionAvail(player(2), 3, 1, 5, 1)).toBeCloseTo(Math.pow(DEF_RATE, 3), 6);
  });

  it("charges a one-match ban once across a double gameweek", () => {
    // Two legs in one event. The earlier version of this term multiplied EVERY
    // fixture by the survival factor, which prices a ban that costs him both
    // matches — but a one-match ban costs one. Expected matches missed here is
    // the risk from the trigger falling in match 1 plus the risk from match 2,
    // and the multiplier is that divided by the two matches on offer.
    const q = DEF_RATE;
    const missed = q + q * (1 - q); // trigger in match 1, or match 2
    expect(suspensionAvail(player(4), 1, 2, 10, 1)).toBeCloseTo(1 - missed / 2, 6);
    // And the cost in points is strictly less than losing both legs...
    expect(suspensionAvail(player(4), 1, 2, 10, 1)).toBeGreaterThan(1 - q);
    // ...while still costing him more in TOTAL than a single fixture would,
    // because two matches are two chances to collect the card. Asserted against
    // the function, in expected-matches-missed: an earlier version of this line
    // compared the local `missed` to `q`, which is `q(1-q) > 0` and would pass
    // against a deleted implementation.
    const missedDouble = 2 * (1 - suspensionAvail(player(4), 1, 2, 10, 1));
    const missedSingle = 1 * (1 - suspensionAvail(player(4), 1, 1, 10, 1));
    expect(missedDouble).toBeGreaterThan(missedSingle);
  });

  it("charges the ban to the leg it is actually served in", () => {
    // The per-leg probabilities, which is what `projectAll` consumes. Averaging
    // them is only right when both legs are worth the same, and they rarely are.
    const q = DEF_RATE;
    // Imminent double: the first leg cannot be missed — the only booking that
    // could ban him for it has not been played yet — and the second carries q.
    expect(suspensionMissProbs(player(4), 0, 2, 10, 1)).toHaveLength(2);
    expect(suspensionMissProbs(player(4), 0, 2, 10, 1)[0]).toBe(0);
    expect(suspensionMissProbs(player(4), 0, 2, 10, 1)[1]).toBeCloseTo(q, 9);
    // A double later in the horizon: both legs are live, the second conditioned
    // on him having survived the first.
    const later = suspensionMissProbs(player(4), 3, 2, 10, 1);
    expect(later[0]).toBeCloseTo(q * Math.pow(1 - q, 2), 9);
    expect(later[1]).toBeCloseTo(q * Math.pow(1 - q, 3), 9);
    // A blank has no legs, so there is nothing to allocate. (The separate claim
    // that the SUMMARY of no legs is 1 rather than NaN is asserted further down,
    // against `suspensionAvail`, where it belongs; this line used to carry that
    // sentence next to an assertion that does not make it.)
    expect(suspensionMissProbs(player(4), 3, 0, 10, 1)).toEqual([]);
    // The summary really is the equal-weight mean of the parts. This is the
    // only relationship the two functions are allowed to have.
    for (const [before, n] of [
      [0, 1],
      [0, 2],
      [3, 1],
      [3, 2],
      [6, 3],
    ] as [number, number][]) {
      const probs = suspensionMissProbs(player(4), before, n, 10, 1);
      const mean = probs.reduce((a, b) => a + b, 0) / n;
      expect(suspensionAvail(player(4), before, n, 10, 1)).toBeCloseTo(1 - mean, 12);
    }
  });

  it("treats a blank gameweek as no matches rather than no risk", () => {
    // Nothing to miss, so the multiplier is 1 — but the caller must also not
    // advance the match counter, which is what the end-to-end test checks.
    expect(suspensionAvail(player(4), 3, 0, 10, 1)).toBe(1);
  });

  it("is silent when FPL does not supply a card count", () => {
    // `yellow_cards` is optional on `Element` because the field is not in every
    // feed the app can be pointed at — the demo fixture has no cards at all.
    // Absent must mean zero, not NaN and not a crash.
    const noField = { id: 1, team: 1, element_type: 2 } as Element;
    expect(suspensionAvail(noField, 1, 1, 10, 1)).toBe(1);
    expect(suspensionAvail(noField, 4, 1, 10, 1)).toBe(1);
    // Zero yellows behaves identically, which is the invariant that makes the
    // missing field safe rather than merely non-crashing.
    //
    // Checked at `matchesBefore = 5`, deliberately. The obvious place to check
    // it is a small number, and that is exactly where it proves nothing: with
    // zero cards `need` is 5, every trigger index below 5 is skipped, and both
    // sides are trivially 1 — the assertion would hold for a fallback of `?? 99`
    // just as happily. At 5 the two sides are a real q^5, and only a fallback of
    // genuinely zero produces it.
    const withField = suspensionAvail(player(0), 5, 1, 10, 1);
    expect(withField).toBeLessThan(1);
    expect(suspensionAvail(noField, 5, 1, 10, 1)).toBe(withField);
  });

  it("config lock: the booking rates and thresholds are the measured ones", () => {
    // A lock, not a measurement — it restates constants that live a few hundred
    // lines away and would notice a careless edit, nothing more. Named honestly
    // because the previous title promised a check against the archive and did
    // not deliver one; the actual archive comparison is in the one-away test.
    expect(XP_CONFIG.bookingRate).toEqual([0, 0.0762, 0.1684, 0.1651, 0.1118]);
    expect(XP_CONFIG.banThresholds).toEqual([
      [5, 19],
      [10, 32],
      [15, 38],
    ]);
  });
});

// ---- end to end: the term has to reach the projection, and only later weeks -

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

// Both players sit on team 1, so they are the same side of the same fixture in
// every round and nothing but the card count separates them.
const fixtures: Fixture[] = [11, 12, 13, 14].flatMap((event) =>
  Array.from({ length: 10 }, (_, i) => ({
    id: event * 100 + i,
    event,
    team_h: i * 2 + 1,
    team_a: i * 2 + 2,
    team_h_difficulty: 3,
    team_a_difficulty: 3,
    finished: false,
    started: false,
    kickoff_time: `2026-11-0${event - 10}T15:00:00Z`,
    team_h_score: null,
    team_a_score: null,
  }))
);

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

/** A nailed defender, differing from his twin only in his card count. */
function def(id: number, yellows: number): Element {
  return {
    id,
    team: 1,
    element_type: 2,
    starts: 10,
    minutes: 900,
    yellow_cards: yellows,
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

describe("suspension risk reaches expected points", () => {
  const bootstrap = {
    events,
    teams,
    elements: [def(1, 0), def(2, 4)],
    total_players: 1_167_938,
  } as unknown as Bootstrap;
  const xp = projectAll({ pastSeason: undefined, bootstrap, fixtures, nextEvent: 11, horizon: 4 });
  const clean = xp.get(1)!;
  const booked = xp.get(2)!;

  it("leaves this week's projection untouched when this week is a single fixture", () => {
    // The property the whole design rests on. Whatever happens to his horizon,
    // the man on four yellows is exactly as good a captain this week as his
    // identical twin on none. Note `toBe`, not `toBeCloseTo`: the claim is that
    // the multiplier is literally 1 and the arithmetic is bit-identical, which
    // is what lets the backtest reproduce byte for byte.
    expect(booked.next).toBe(clean.next);
    expect(booked.perGw.get(11)).toBe(clean.perGw.get(11));
  });

  it("does discount this week when this week is a double", () => {
    // The boundary of the guarantee above, and the reason its title now names
    // the single-fixture case. The exemption at offset 0 exists because a ban
    // already being served is FPL's to declare — it is NOT a promise to ignore
    // bookings that have not happened yet. Book him in the first leg of an
    // imminent double and he misses the second, this week, and the projection
    // has to say so.
    //
    // Found by measurement, not by reading: neutralising the term reproduced
    // the 2024-25 backtest byte for byte, and so did neutralising it for single
    // fixtures only, which put every offset-0 difference in double gameweeks.
    const extra: Fixture = {
      id: 11999,
      event: 11,
      team_h: 1,
      team_a: 20,
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      finished: false,
      started: false,
      // Earlier than the base GW11 fixture, so this one is leg ONE and the base
      // fixture is the leg at risk. Which way round they fall does not matter
      // here — every team in this world is built identical, so with both legs at
      // difficulty 3 the two are worth the same and the answer is q/2 either
      // way. The next test is the one where the order is load-bearing.
      kickoff_time: "2026-10-28T18:00:00Z",
      team_h_score: null,
      team_a_score: null,
    };
    const dgwNow = twins([...fixtures, extra]);
    // Both legs are against the same calibre of opponent here, so the leg that
    // is actually at risk — the second — is worth half the week, and losing it
    // with probability q costs a relative q/2. The unequal-leg case is the next
    // test; this one is deliberately the symmetric baseline for it.
    expect(rel(dgwNow, 11)).toBeCloseTo(DEF_RATE / 2, 3);
    // And it is the card count doing the work, not the extra fixture: the clean
    // twin gains points from the second leg rather than losing any, so his GW11
    // goes UP relative to the single-fixture week. (An earlier version of this
    // line claimed his total was "unchanged", asserted `> 0`, and read off the
    // single-fixture run — three different things, none of them the claim.)
    expect(dgwNow.get(1)!.perGw.get(11)!).toBeGreaterThan(
      twins(fixtures).get(1)!.perGw.get(11)!
    );
  });

  it("charges an unequal double against the leg the ban actually falls in", () => {
    // The reason `projectAll` consumes per-leg probabilities instead of one
    // averaged multiplier. In an imminent double the FIRST leg is safe and the
    // second is at risk, so what the ban costs depends on which of the two is
    // the better fixture — and averaging gets it wrong in both directions.
    //
    // Team 1's own GW11 fixture is against team 12 (mid-table by construction).
    // Add a second leg against team 20 and vary only its difficulty.
    const leg2 = (difficulty: number): Fixture => ({
      id: 11998,
      event: 11,
      team_h: 1,
      team_a: 20,
      team_h_difficulty: difficulty,
      team_a_difficulty: difficulty,
      finished: false,
      started: false,
      // Strictly AFTER the existing GW11 fixture (2026-11-01T15:00), so it
      // really is leg two — the leg the ban falls in. This date matters and was
      // wrong first time: at 2026-10-30 the sort in `makeFixtureIndex` correctly
      // made this the FIRST leg, the varied difficulty moved only the safe leg,
      // and every assertion below inverted. That inversion was itself the
      // evidence the sort works; the symmetric run (difficulty 3, both legs
      // equal) landed on exactly DEF_RATE / 2 either way, as it must.
      kickoff_time: "2026-11-01T18:00:00Z",
      team_h_score: null,
      team_a_score: null,
    });
    const easySecond = twins([...fixtures, leg2(2)]);
    const hardSecond = twins([...fixtures, leg2(5)]);

    // Every assertion below carries a MARGIN, and that is not decoration. The
    // first draft used bare `toBeGreaterThan`, and the mutation that reverts the
    // call site to the old averaged multiplier survived it: under that mutant
    // both numbers collapse to q/2, but they collapse to 0.08420000000000005 and
    // 0.08419999999999994, so a strict inequality on the pair and both halves of
    // the straddle all passed on floating-point dust. The real separation is
    // 0.0902 against 0.0719 either side of 0.0842 — two orders of magnitude
    // clear of the noise — so requiring real daylight costs nothing here and is
    // the difference between a test that means something and one that does not.
    const easy = rel(easySecond, 11);
    const hard = rel(hardSecond, 11);
    // The at-risk leg is worth more when it is the easy one, so the same ban
    // probability costs a larger share of the week.
    expect(easy - hard).toBeGreaterThan(0.01);
    // And the split straddles the equal-weight answer, which is what makes this
    // a real correction rather than a uniform rescaling. If the old averaged
    // multiplier were still in place both of these would sit at exactly q/2.
    expect(easy).toBeGreaterThan(DEF_RATE / 2 + 0.004);
    expect(hard).toBeLessThan(DEF_RATE / 2 - 0.004);
    // Sanity: it is still bounded by losing the whole leg outright.
    expect(easy).toBeLessThan(DEF_RATE);
  });

  it("discounts every later week, by a geometrically decaying amount", () => {
    // This assertion was written backwards first time and the model was right.
    // The intuition that says the shortfall should WIDEN is thinking of the
    // cumulative probability of having been banned by week k, which does rise.
    // But the quantity that discounts week k is the probability he is banned
    // FOR week k specifically, and a one-match ban falls in exactly one
    // fixture: getting as far as week k still available means he kept failing
    // to collect the card, so the per-week discount is q(1-q)^(k-1) and decays.
    // The unit test above asserts the same decay on the raw multiplier; if the
    // two ever disagree again, that one is the one to believe.
    const gaps = [12, 13, 14].map((gw) => clean.perGw.get(gw)! - booked.perGw.get(gw)!);
    for (const g of gaps) expect(g).toBeGreaterThan(0);
    expect(gaps[1]).toBeLessThan(gaps[0]);
    expect(gaps[2]).toBeLessThan(gaps[1]);
    // And the decay is the survival factor itself, not merely some shrinkage.
    // The fixtures are deliberately identical week to week, so the points ratio
    // between consecutive weeks isolates the availability term.
    expect(gaps[1] / gaps[0]).toBeCloseTo(1 - DEF_RATE, 4);
    expect(gaps[2] / gaps[1]).toBeCloseTo(1 - DEF_RATE, 4);
    // One ban, not one per week: the whole horizon costs less than a single
    // week's points even though three weeks are discounted.
    const total = gaps.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(clean.perGw.get(12)!);
    expect(booked.total).toBeLessThan(clean.total);
  });

  it("measures the window in the club's own completed matches", () => {
    // The cutoff is the SIDE'S 19th match, which is not the gameweek number and
    // not the league's average — a club with a game in hand crosses it a week
    // late. Nothing else in these tests could tell those apart, because the
    // synthetic fixture list has no finished games and the count falls back to
    // the finished-event count. So: give team 1 twenty-five completed matches
    // and check the two thresholds part company, which they can only do if the
    // number reaching `suspensionAvail` is the club's own.
    const played: Fixture[] = Array.from({ length: 25 }, (_, i) => ({
      id: 9000 + i,
      event: null,
      team_h: 1,
      team_a: (i % 19) + 2,
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      finished: true,
      started: true,
      kickoff_time: "2026-09-01T15:00:00Z",
      team_h_score: 1,
      team_a_score: 1,
    }));
    const late = projectAll({ pastSeason: undefined,
      bootstrap: {
        ...bootstrap,
        elements: [def(1, 0), def(2, 4), def(3, 9)],
      } as unknown as Bootstrap,
      fixtures: [...played, ...fixtures],
      nextEvent: 11,
      horizon: 4,
    });
    // Twenty-five matches in, the five-card window (first 19) has shut, so the
    // man on four is worth exactly what his clean twin is.
    expect(late.get(2)!.total).toBe(late.get(1)!.total);
    // The ten-card window runs to the 32nd and is still open, so the man on
    // nine is still discounted. If the count were the gameweek number (11) or
    // the finished-event count (10) or zero, the first assertion would fail.
    expect(late.get(3)!.total).toBeLessThan(late.get(1)!.total);
  });

  /** Relative discount between the booked twin and his clean one, in one week. */
  const rel = (m: ReturnType<typeof projectAll>, gw: number) =>
    1 - m.get(2)!.perGw.get(gw)! / m.get(1)!.perGw.get(gw)!;

  const twins = (fx: Fixture[]) =>
    projectAll({ pastSeason: undefined,
      bootstrap: { ...bootstrap, elements: [def(1, 0), def(2, 4)] } as unknown as Bootstrap,
      fixtures: fx,
      nextEvent: 11,
      horizon: 4,
    });

  it("spends a one-match ban on one leg of a double gameweek, not both", () => {
    // Team 1 plays twice in GW12. Two things change and they pull opposite
    // ways: two matches are two chances to collect the card, but a one-match
    // ban only costs one of the two legs. Netting them out, the RELATIVE hit to
    // the week must come down, not stay put — which is the bug this replaced,
    // where the survival factor multiplied both legs and charged the ban twice.
    const extra: Fixture = {
      id: 12999,
      event: 12,
      team_h: 1,
      team_a: 20,
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      finished: false,
      started: false,
      kickoff_time: "2026-11-04T18:00:00Z",
      team_h_score: null,
      team_a_score: null,
    };
    const single = twins(fixtures);
    const dgw = twins([...fixtures, extra]);
    const q = DEF_RATE;
    expect(rel(single, 12)).toBeCloseTo(q, 3);
    expect(rel(dgw, 12)).toBeCloseTo((q + q * (1 - q)) / 2, 3);
    expect(rel(dgw, 12)).toBeLessThan(rel(single, 12));

    // And the double must have MOVED THE CLOCK by two matches, so by GW13 he
    // has had three chances to be booked rather than two and the residual risk
    // of a ban still to come is correspondingly smaller.
    expect(rel(dgw, 13)).toBeCloseTo(q * Math.pow(1 - q, 2), 3);
    expect(rel(single, 13)).toBeCloseTo(q * (1 - q), 3);
  });

  it("does not advance the clock through a blank gameweek", () => {
    // Team 1 has no fixture in GW12, so GW13 is only his FIRST match from now:
    // the risk there is the undiscounted q, not q(1-q). If the counter ran on
    // events instead of matches this would silently be too low.
    const blanked = fixtures.filter((f) => !(f.event === 12 && (f.team_h === 1 || f.team_a === 1)));
    const blank = twins(blanked);
    expect(blank.get(1)!.perGw.get(12)).toBe(0);
    expect(rel(blank, 13)).toBeCloseTo(DEF_RATE, 3);
    expect(rel(blank, 13)).toBeGreaterThan(rel(twins(fixtures), 13));
  });

  it("does not charge cards to matches the player is already missing", () => {
    // A booking is collected on the pitch. A man FPL has flagged is less likely
    // to be on it, so he is less likely to walk into the ban — and the term has
    // to see that, or an injured player gets discounted twice for two different
    // reasons. Same four-yellow player, once fit and once doubtful; the
    // RELATIVE suspension hit must be smaller for the doubtful one.
    const doubtful = (id: number, yellows: number) =>
      ({ ...def(id, yellows), status: "d", chance_of_playing_next_round: 25 }) as unknown as Element;
    const flagged = projectAll({ pastSeason: undefined,
      bootstrap: {
        ...bootstrap,
        elements: [doubtful(1, 0), doubtful(2, 4)],
      } as unknown as Bootstrap,
      fixtures,
      nextEvent: 11,
      horizon: 4,
    });
    const fit = twins(fixtures);
    expect(rel(flagged, 12)).toBeGreaterThan(0);
    expect(rel(flagged, 12)).toBeLessThan(rel(fit, 12));
  });

  it("does nothing at all to a player who is not near a threshold", () => {
    const both = projectAll({ pastSeason: undefined,
      bootstrap: {
        ...bootstrap,
        elements: [def(1, 0), def(2, 2)],
      } as unknown as Bootstrap,
      fixtures,
      nextEvent: 11,
      horizon: 2,
    });
    // Two yellows needs three more cards in two matches — impossible, so the
    // projections must be identical to the last bit.
    expect(both.get(2)!.total).toBe(both.get(1)!.total);
  });
});
