import { describe, it, expect } from "vitest";
import { matchMinute, projectAutoSubs, provisionalBonus } from "../live";
import { availabilityAt, XP_CONFIG } from "../xp";
import { makeElement } from "./mockdata";
import type { Bootstrap, Element, EventLive, Fixture, Pick } from "../types";

// Squad: GK(1) + 4 DEF + 4 MID + 2 FWD starters, bench: GK, DEF, MID, FWD
function makeSquad(): Map<number, Element> {
  const els = [
    makeElement({ id: 1, element_type: 1, team: 1 }), // GK starter
    ...[2, 3, 4, 5].map((id) => makeElement({ id, element_type: 2, team: (id % 6) + 1 })),
    ...[6, 7, 8, 9].map((id) => makeElement({ id, element_type: 3, team: (id % 6) + 1 })),
    ...[10, 11].map((id) => makeElement({ id, element_type: 4, team: (id % 6) + 1 })),
    makeElement({ id: 12, element_type: 1, team: 2 }), // bench GK
    makeElement({ id: 13, element_type: 2, team: 3 }),
    makeElement({ id: 14, element_type: 3, team: 4 }),
    makeElement({ id: 15, element_type: 4, team: 5 }),
  ];
  return new Map(els.map((e) => [e.id, e]));
}

function makePicks(): Pick[] {
  return Array.from({ length: 15 }, (_, i) => ({
    element: i + 1,
    position: i + 1,
    multiplier: i < 11 ? 1 : 0,
    is_captain: i === 7,
    is_vice_captain: i === 8,
  }));
}

// All 6 clubs play one finished fixture in GW 10.
function makeFinishedFixtures(): Fixture[] {
  return [1, 3, 5].map((h, i) => ({
    id: i + 1,
    event: 10,
    team_h: h,
    team_a: h + 1,
    team_h_difficulty: 3,
    team_a_difficulty: 3,
    kickoff_time: "2026-01-01T15:00:00Z",
    finished: true,
    started: true,
    team_h_score: 1,
    team_a_score: 0,
  }));
}

function makeLive(minutesById: Record<number, number>): EventLive {
  return {
    elements: Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      stats: {
        minutes: minutesById[i + 1] ?? 90,
        total_points: 2,
        bonus: 0,
        bps: 10,
        goals_scored: 0,
        assists: 0,
      },
    })),
  };
}

describe("projectAutoSubs", () => {
  const elements = makeSquad();
  const picks = makePicks();
  const fixtures = makeFinishedFixtures();

  it("no subs when everyone played", () => {
    const res = projectAutoSubs(picks, elements, makeLive({}), fixtures, 10);
    expect(res.out).toEqual([]);
    expect(res.effectiveXi.length).toBe(11);
  });

  it("replaces a blanked outfield starter with the first eligible bench player", () => {
    const res = projectAutoSubs(picks, elements, makeLive({ 6: 0 }), fixtures, 10);
    expect(res.out).toEqual([6]);
    expect(res.in).toEqual([13]); // first outfield bench player (bench GK skipped)
    expect(res.effectiveXi).toContain(13);
    expect(res.effectiveXi).not.toContain(6);
  });

  it("GK can only be replaced by the bench GK", () => {
    const res = projectAutoSubs(picks, elements, makeLive({ 1: 0 }), fixtures, 10);
    expect(res.out).toEqual([1]);
    expect(res.in).toEqual([12]);
  });

  it("skips bench players who also blanked", () => {
    const res = projectAutoSubs(picks, elements, makeLive({ 6: 0, 13: 0 }), fixtures, 10);
    expect(res.in).toEqual([14]);
  });

  it("respects formation limits (cannot drop below 1 FWD)", () => {
    // Both FWD starters blank; bench has only one FWD (15) plus DEF/MID.
    // First FWD out -> DEF 13 comes on only if formation stays legal
    // (4 DEF -> 5 DEF, 1 FWD left: 5-4-1 is legal). Second FWD out -> would
    // leave 0 FWDs with a MID sub, so only the FWD (15) may replace them.
    const res = projectAutoSubs(picks, elements, makeLive({ 10: 0, 11: 0 }), fixtures, 10);
    const types = res.effectiveXi.map((id) => elements.get(id)!.element_type);
    expect(types.filter((t) => t === 4).length).toBeGreaterThanOrEqual(1);
    expect(types.filter((t) => t === 1).length).toBe(1);
  });

  it("no sub while the starter's fixture is still in play", () => {
    const inPlay = fixtures.map((f) => (f.team_h === 5 ? { ...f, finished: false } : f));
    // Element 6 is on team 1... element with team 5: id 15 bench. Use starter 4 (team 5).
    const res = projectAutoSubs(picks, elements, makeLive({ 4: 0 }), inPlay, 10);
    expect(res.out).toEqual([]);
  });
});

describe("provisionalBonus", () => {
  // Two clubs, one in-play fixture, four players with distinct BPS.
  const bootstrap = {
    elements: [
      makeElement({ id: 1, team: 1 }),
      makeElement({ id: 2, team: 1 }),
      makeElement({ id: 3, team: 2 }),
      makeElement({ id: 4, team: 2 }),
    ],
  } as Bootstrap;

  const inPlay: Fixture[] = [
    {
      id: 1,
      event: 10,
      team_h: 1,
      team_a: 2,
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      kickoff_time: "2026-01-01T15:00:00Z",
      finished: false,
      started: true,
      team_h_score: 1,
      team_a_score: 0,
    },
  ];

  /** bpsById -> live feed; `awarded` puts FPL's own bonus into `explain`. */
  const live = (bpsById: Record<number, number>, awarded: Record<number, number> = {}): EventLive => ({
    elements: Object.entries(bpsById).map(([id, bps]) => {
      const elId = Number(id);
      const bonus = awarded[elId] ?? 0;
      return {
        id: elId,
        stats: { minutes: 90, total_points: 2 + bonus, bonus, bps, goals_scored: 0, assists: 0 },
        explain: [
          {
            fixture: 1,
            stats: [
              { identifier: "minutes", points: 2, value: 90 },
              ...(bonus > 0 ? [{ identifier: "bonus", points: bonus, value: bps }] : []),
            ],
          },
        ],
      };
    }),
  });

  it("projects 3/2/1 while FPL has awarded nothing yet", () => {
    const res = provisionalBonus(bootstrap, inPlay, live({ 1: 30, 2: 25, 3: 20, 4: 5 }), 10);
    expect(res.byElement.get(1)).toBe(3);
    expect(res.byElement.get(2)).toBe(2);
    expect(res.byElement.get(3)).toBe(1);
    expect(res.byElement.has(4)).toBe(false);
  });

  it("adds nothing once FPL's own projected bonus is already in the feed", () => {
    // From 2026/27 FPL publishes bonus past the 20-minute mark, and it is inside
    // total_points. Adding our projection on top would double-count it.
    const res = provisionalBonus(
      bootstrap,
      inPlay,
      live({ 1: 30, 2: 25, 3: 20, 4: 5 }, { 1: 3, 2: 2, 3: 1 }),
      10
    );
    expect(res.byElement.size).toBe(0);
  });

  it("tops up only the difference when BPS has moved past what FPL awarded", () => {
    // FPL's snapshot had this player on 1 bonus; live BPS now has him top.
    const res = provisionalBonus(
      bootstrap,
      inPlay,
      live({ 1: 30, 2: 25, 3: 20, 4: 5 }, { 1: 1 }),
      10
    );
    expect(res.byElement.get(1)).toBe(2);
    expect(res.byElement.get(2)).toBe(2);
  });

  it("shares the higher bonus on a tie and skips the slot below", () => {
    const res = provisionalBonus(bootstrap, inPlay, live({ 1: 30, 2: 30, 3: 20, 4: 5 }), 10);
    expect(res.byElement.get(1)).toBe(3);
    expect(res.byElement.get(2)).toBe(3);
    expect(res.byElement.get(3)).toBe(1);
  });

  it("ignores fixtures that are finished or not yet started", () => {
    const done = inPlay.map((f) => ({ ...f, finished: true }));
    expect(provisionalBonus(bootstrap, done, live({ 1: 30, 2: 25 }), 10).byElement.size).toBe(0);
    const notStarted = inPlay.map((f) => ({ ...f, started: false }));
    expect(provisionalBonus(bootstrap, notStarted, live({ 1: 30 }), 10).byElement.size).toBe(0);
  });
});

describe("availabilityAt", () => {
  it("suspension zeroes the next GW and recovers over the horizon", () => {
    const el = makeElement({ id: 1, status: "s", chance_of_playing_next_round: 0 });
    expect(availabilityAt(el, 0)).toBe(0);
    // Rises, but not to near-certainty in one gameweek: ~1 ban in 3 among
    // established starters runs beyond a single match.
    const a1 = availabilityAt(el, 1);
    expect(a1).toBeGreaterThan(0.4);
    expect(a1).toBeLessThan(0.8);
    expect(availabilityAt(el, 3)).toBeGreaterThan(a1);
  });

  it("does not treat a multi-match ban as if it were over next week", () => {
    // The shipped rule was `Math.max(a0, 0.9)` for every offset > 0, which
    // asserts a one-match ban with 90% confidence at every horizon. Measured
    // over 2022-23..2025-26 (n=96 established starters sent off), 32% miss
    // more than one round, so offset 1 must be well below 0.9.
    const el = makeElement({ id: 1, status: "s", chance_of_playing_next_round: 0 });
    expect(availabilityAt(el, 1)).toBeLessThan(0.8);
  });

  it("reads a stated ban end date out of the news", () => {
    // FPL writes "Suspended until 17 Jan", not "Expected back 17 Jan", so a
    // regex anchored only on the injury phrasing sees no date at all.
    const el = makeElement({
      id: 1, status: "s", chance_of_playing_next_round: 0,
      news: "Suspended until 17 Jan",
    });
    const before = Date.UTC(2023, 0, 10);
    const after = Date.UTC(2023, 0, 24);
    expect(availabilityAt(el, 1, before)).toBe(0);
    // A ban is a legal absence, not a fitness one: once it expires he is
    // match-fit immediately and must NOT be put on the injury return ramp.
    expect(availabilityAt(el, 1, after)).toBe(1);
  });

  it("does not project an undated injury back to near-full fitness", () => {
    // "Knee injury - Unknown return date" carries no date, so the decay curve
    // is all that runs. Asymptoting to 1 put such a player at 0.87 four
    // gameweeks out — the exact failure newsReturnTime exists to prevent.
    const el = makeElement({
      id: 1, status: "i", chance_of_playing_next_round: 0,
      news: "Knee injury - Unknown return date",
    });
    const t = Date.UTC(2024, 9, 5);
    expect(availabilityAt(el, 4, t)).toBeLessThan(0.7);
    // The second bar here used to read `< 0.8`, which asserted nothing at all:
    // this path asymptotes to `recoveryCeiling`, and that is 0.75, so no offset
    // can ever reach 0.8 whatever the decay does. Deleting the entire ramp and
    // returning the ceiling flat would have passed it. What is worth pinning is
    // the SHAPE — a curve that climbs monotonically and is still short of the
    // ceiling eight gameweeks out — so the numbers are pinned directly.
    expect(availabilityAt(el, 4, t)).toBeCloseTo(0.6528, 4);
    expect(availabilityAt(el, 8, t)).toBeCloseTo(0.7374, 4);
    expect(availabilityAt(el, 8, t)).toBeLessThan(XP_CONFIG.recoveryCeiling);
    expect(availabilityAt(el, 8, t)).toBeGreaterThan(availabilityAt(el, 4, t));
  });

  it("brings a dated returnee back on a ramp, not a switch", () => {
    // `returnRampStart` and `returnRampDays` were entirely unpinned: every test
    // that touched this path asserted an inequality both settings satisfied, so
    // 0.35/21 could have been 0.9/3 — a switch — and the suite stayed green.
    // The claim they encode is that a player named in the squad for the first
    // match after an injury is not yet trusted with 90 minutes, and that the
    // trust returns over about three weeks. Both halves are asserted here.
    const el = makeElement({
      id: 1, status: "i", chance_of_playing_next_round: 0,
      news: "Hamstring injury - Expected back 17 Jan",
    });
    const on = (d: number) => availabilityAt(el, 1, Date.UTC(2023, 0, d));
    expect(on(10)).toBe(0);
    // The day he is due back is the START of the ramp, not the end of it.
    expect(on(17)).toBeCloseTo(XP_CONFIG.returnRampStart, 10);
    expect(on(17)).toBeCloseTo(0.35, 10);
    // Linear from there. A third of the way through: 0.35 + 0.65 * 7/21.
    expect(on(24)).toBeCloseTo(0.5667, 4);
    expect(on(31)).toBeCloseTo(0.7833, 4);
    // And full only once the whole ramp has run — 17 Jan + 21 days.
    expect(on(37)).toBeLessThan(1);
    expect(on(38)).toBe(1);
  });

  it("never drags a mildly doubtful player down to the recovery ceiling", () => {
    // The ceiling is a target the deficit closes toward, not a clamp.
    const el = makeElement({ id: 1, status: "d", chance_of_playing_next_round: 90 });
    expect(availabilityAt(el, 3)).toBeGreaterThanOrEqual(0.9);
  });
  it("injured players recover gradually", () => {
    const el = makeElement({ id: 1, status: "i", chance_of_playing_next_round: 0 });
    expect(availabilityAt(el, 0)).toBe(0);
    const a1 = availabilityAt(el, 1);
    const a3 = availabilityAt(el, 3);
    expect(a1).toBeGreaterThan(0);
    expect(a3).toBeGreaterThan(a1);
  });
  it("positive chance_of_playing overrides a zero status mapping", () => {
    const el = makeElement({ id: 1, status: "i", chance_of_playing_next_round: 75 });
    expect(availabilityAt(el, 0)).toBe(0.75);
  });
  it("players who left the club stay at zero", () => {
    const el = makeElement({ id: 1, status: "u", chance_of_playing_next_round: 100 });
    expect(availabilityAt(el, 3)).toBe(0);
  });
});

/*
 * THE CLOCK RAN FAST, AND THAT MADE A CORRECT SCORE LOOK STALE.
 *
 * `matchMinute` estimated the minute from `now - kickoff` with a flat fifteen
 * minutes knocked off past the hour, ignoring the `minutes` FPL publishes on
 * every fixture — which the `Fixture` type did not even declare. Measured live
 * on ARS v COV in GW1 2026-27 at 20:16:59Z: FPL published 54, the estimate said
 * 61. A reader who knew a goal had gone in on 50 minutes saw a clock reading 52
 * beside a score without it and reported the SCORE as stale. It was not.
 */
describe("matchMinute", () => {
  const KO = "2026-08-21T19:00:00Z";
  const fx = (over: Partial<Fixture>): Fixture =>
    ({
      id: 1,
      event: 1,
      team_h: 1,
      team_a: 2,
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      kickoff_time: KO,
      finished: false,
      started: true,
      team_h_score: 3,
      team_a_score: 0,
      ...over,
    }) as Fixture;

  it("reads the published clock rather than the wall clock", () => {
    // The measured case, exactly: 76 minutes of wall clock, 54 on the pitch.
    const now = new Date("2026-08-21T20:16:00Z");
    expect(matchMinute(fx({ minutes: 54 }), now)).toBe("54'");
  });

  it("no longer runs ahead of the match it is describing", () => {
    // What the estimate produced for that same moment, and must not again.
    const now = new Date("2026-08-21T20:16:00Z");
    expect(matchMinute(fx({ minutes: 54 }), now)).not.toBe("61'");
  });

  it("is unmoved by wall-clock time the match did not spend playing", () => {
    // Stoppage, a VAR check, a delayed restart: all add to `now - kickoff` and
    // none of them to the match clock. The estimate could only ever err one way.
    const a = matchMinute(fx({ minutes: 54 }), new Date("2026-08-21T20:16:00Z"));
    const b = matchMinute(fx({ minutes: 54 }), new Date("2026-08-21T20:31:00Z"));
    expect(a).toBe(b);
  });

  it("falls back to the estimate only while the feed still says nothing", () => {
    // A started match reading 0 minutes is a real state for a minute or so.
    const now = new Date("2026-08-21T19:20:00Z");
    expect(matchMinute(fx({ minutes: 0 }), now)).toBe("20'");
    expect(matchMinute(fx({ minutes: undefined }), now)).toBe("20'");
  });

  it("prefers a published clock even when the estimate would agree", () => {
    // Guards the ORDER, not just the output: an implementation that computed
    // the estimate first and only consulted `minutes` on failure would pass a
    // test where the two happen to match.
    const now = new Date("2026-08-21T19:20:00Z");
    expect(matchMinute(fx({ minutes: 7 }), now)).toBe("7'");
  });

  it("does not trust the network's word that a number is a number", () => {
    // A string "54" would render as "54'" by luck here and poison arithmetic in
    // any later caller.
    const now = new Date("2026-08-21T19:20:00Z");
    expect(matchMinute(fx({ minutes: "54" as unknown as number }), now)).toBe("20'");
    expect(matchMinute(fx({ minutes: NaN }), now)).toBe("20'");
  });

  it("still calls a finished match finished, published clock or not", () => {
    expect(matchMinute(fx({ finished: true, minutes: 90 }), new Date())).toBe("FT");
    expect(matchMinute(fx({ started: false, minutes: 0 }), new Date())).toBe("");
  });

  it("says 90+ rather than claiming the match is exactly on 90", () => {
    /*
     * FPL stops counting at 90. Measured on ARS v COV: the feed read 89 in the
     * 89th minute and then 90 for the rest of a match that ran to 94, so the
     * app showed "90'" through four more minutes of football. That was queried,
     * and rightly — it is a claim the data cannot support.
     */
    const now = new Date("2026-08-21T20:16:00Z");
    expect(matchMinute(fx({ minutes: 90 }), now)).toBe("90+'");
    expect(matchMinute(fx({ minutes: 94 }), now)).toBe("90+'");
    // And below the cap the exact minute is still exact.
    expect(matchMinute(fx({ minutes: 89 }), now)).toBe("89'");
  });

  it("does not lie about a runaway value either", () => {
    const now = new Date("2026-08-21T20:16:00Z");
    expect(matchMinute(fx({ minutes: 400 }), now)).toBe("120+'");
  });

  it("calls full time at the whistle, not when the bonus is settled", () => {
    /*
     * `finished` means BONUS CONFIRMED. `finished_provisional` is the final
     * whistle, and after a Saturday afternoon the two are hours apart — for
     * that whole window the clock had nothing to tell it the match was over.
     * Measured four minutes after full time on ARS v COV: minutes 90, finished
     * false, finished_provisional false — FPL had not caught up yet, but when
     * it does it sets the provisional flag first.
     */
    const now = new Date("2026-08-21T21:30:00Z");
    expect(matchMinute(fx({ finished: false, finished_provisional: true, minutes: 90 }), now)).toBe("FT");
    // Still ticking while neither flag is set.
    expect(matchMinute(fx({ finished: false, finished_provisional: false, minutes: 62 }), now)).toBe("62'");
  });
});

/*
 * DOUBLE GAMEWEEKS, WHERE EVERY FIGURE IN THE LIVE FEED CHANGES MEANING.
 *
 * `stats.bps` and `stats.minutes` are gameweek TOTALS across all of a player's
 * fixtures. Read as if they described one match they produced three separate
 * wrong answers, each confirmed by probe before the fix.
 */
describe("provisionalBonus across a double gameweek", () => {
  const bootstrap = {
    elements: [1, 2, 3].map((id) => makeElement({ id, team: id === 3 ? 2 : 1 })),
  } as Bootstrap;

  const fx = (id: number, finished: boolean): Fixture =>
    ({
      id,
      event: 10,
      team_h: 1,
      team_a: 2,
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      kickoff_time: "2026-01-01T15:00:00Z",
      finished,
      started: true,
      team_h_score: 1,
      team_a_score: 0,
    }) as Fixture;

  /** Per-fixture legs: id -> [{fixture, minutes, bonus}], plus a GW bps total. */
  const feed = (
    spec: Record<number, { bps: number; legs: { fixture: number; minutes: number; bonus?: number }[] }>
  ): EventLive => ({
    elements: Object.entries(spec).map(([id, s]) => ({
      id: Number(id),
      stats: {
        minutes: s.legs.reduce((a, l) => a + l.minutes, 0),
        total_points: 0,
        bonus: 0,
        bps: s.bps,
        goals_scored: 0,
        assists: 0,
      },
      explain: s.legs.map((l) => ({
        fixture: l.fixture,
        stats: [
          { identifier: "minutes", points: l.minutes >= 60 ? 2 : 1, value: l.minutes },
          ...(l.bonus ? [{ identifier: "bonus", points: l.bonus, value: l.bonus }] : []),
        ],
      })),
    })),
  });

  it("does not award a live leg to someone who is not playing in it", () => {
    /*
     * Element 1 banked 45 BPS in a finished leg 1 and has not come on in leg 2.
     * Ranked on his gameweek total he topped leg 2 and took 3 provisional
     * bonus for a match he was not in, pushing the man actually leading it
     * down to 2.
     *
     * Note this fixture also trips the abstention below, so the assertion is
     * that he gets nothing — which is the point either way: the wrong three
     * players must not be shown carrying bonus.
     */
    const res = provisionalBonus(
      bootstrap,
      [fx(1, true), fx(2, false)],
      feed({
        1: { bps: 45, legs: [{ fixture: 1, minutes: 90 }] },
        2: { bps: 20, legs: [{ fixture: 1, minutes: 90 }, { fixture: 2, minutes: 60 }] },
        3: { bps: 18, legs: [{ fixture: 2, minutes: 60 }] },
      }),
      10
    );
    expect(res.byElement.has(1)).toBe(false);
  });

  it("abstains when a gameweek-total BPS cannot rank the match", () => {
    // Element 2 played both legs, so his BPS includes points banked elsewhere
    // and the 3/2/1 order in leg 2 is not a reading of leg 2. Projecting a
    // confident wrong ladder is worse than projecting nothing.
    const res = provisionalBonus(
      bootstrap,
      [fx(1, true), fx(2, false)],
      feed({
        1: { bps: 45, legs: [{ fixture: 1, minutes: 90 }] },
        2: { bps: 20, legs: [{ fixture: 1, minutes: 90 }, { fixture: 2, minutes: 60 }] },
        3: { bps: 18, legs: [{ fixture: 2, minutes: 60 }] },
      }),
      10
    );
    expect(res.byElement.size).toBe(0);
  });

  it("credits nobody from two legs, because both of his fixtures abstain", () => {
    /*
     * `Math.max` used to credit a player top of both legs with 3 where FPL
     * pays 3 + 3. That branch is now UNREACHABLE and this test says so rather
     * than pretending to cover it: being in two legs is exactly what makes
     * both fixtures abstain, so no player can be credited twice. The `+` in
     * the source is kept for the day per-fixture BPS makes the abstention
     * unnecessary — see the comment there.
     */
    const res = provisionalBonus(
      bootstrap,
      [fx(1, false), fx(2, false)],
      feed({
        1: { bps: 40, legs: [{ fixture: 1, minutes: 90 }] },
        2: { bps: 40, legs: [{ fixture: 2, minutes: 90 }] },
        3: { bps: 10, legs: [{ fixture: 1, minutes: 90 }, { fixture: 2, minutes: 90 }] },
      }),
      10
    );
    // Element 3 is in both legs, so both fixtures abstain — including for
    // elements 1 and 2, who each played only one.
    expect(res.byElement.size).toBe(0);
  });

  it("nets off bonus per leg, so a settled leg does not cancel a live one", () => {
    /*
     * The already-awarded scan summed `explain` over the whole gameweek, so a
     * finished leg's CONFIRMED 3 was subtracted from the live leg's projection
     * and the points the reader is on course for vanished from the total.
     * Element 1 plays only leg 2 here, but carries confirmed bonus from... no:
     * he plays one leg. Element 2's confirmed leg-1 bonus must not touch him.
     */
    const res = provisionalBonus(
      bootstrap,
      [fx(1, true), fx(2, false)],
      feed({
        1: { bps: 40, legs: [{ fixture: 2, minutes: 90 }] },
        2: { bps: 50, legs: [{ fixture: 1, minutes: 90, bonus: 3 }] },
        3: { bps: 10, legs: [{ fixture: 2, minutes: 90 }] },
      }),
      10
    );
    // Leg 2 is the only projectable one; element 1 leads it and is unaffected
    // by element 2's settled bonus in a different match.
    expect(res.byElement.get(1)).toBe(3);
    expect(res.byElement.get(3)).toBe(2);
  });
});
