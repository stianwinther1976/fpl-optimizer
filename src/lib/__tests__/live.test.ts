import { describe, it, expect } from "vitest";
import {
  bandMedianScore,
  liveEntryScore,
  fixtureLines,
  matchMinute,
  projectAutoSubs,
  provisionalBonus,
  isInPlay,
  squadMatchState,
  liveMatchMinutes,
  feedStallMs,
  advanceFeedWatch,
  liveSignature,
  FEED_STALL_MS,
} from "../live";
import { availabilityAt, XP_CONFIG } from "../xp";
import { makeElement } from "./mockdata";
import type { Bootstrap, Element, EntryEventPicks, EventLive, Fixture, Pick } from "../types";

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
      /*
       * FULL TIME, BONUS NOT YET CONFIRMED — the one state `provisionalBonus`
       * serves, and the state these tests used to skip.
       *
       * They ran on `started && !finished`, which is any minute of a live
       * match, because that was the function's gate. It projected 3/2/1 from
       * minute one, so at minute two the BPS table held a couple of completed
       * passes and whoever topped it was awarded points of pure noise: reported
       * from a live match, B.Fernandes captained showed 6 where FPL showed 2 —
       * one appearance point plus a projected 2, doubled for the armband.
       *
       * The tests asserted the same belief the code held, which is why seven of
       * them passed throughout.
       */
      finished: false,
      finished_provisional: true,
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

  it("does not put phantom points on a captain two minutes into a match", () => {
    /*
     * THE REPORT, REPRODUCED. At minute two the BPS table holds a couple of
     * completed passes; the old gate projected 3/2/1 off it from the first
     * minute. B.Fernandes had one appearance point, a projected 2 on top, and
     * the armband doubled the pair: the app showed 6 where FPL showed 2.
     */
    const twoMinutesIn = inPlay.map((f) => ({
      ...f,
      finished_provisional: false,
      minutes: 2,
    }));
    const early = provisionalBonus(bootstrap, twoMinutesIn, live({ 1: 3, 2: 2 }), 10);
    expect(early.byElement.size).toBe(0);
    // And the same ladder at full time IS read, so the fix removes the noise
    // and not the feature.
    const atFullTime = provisionalBonus(bootstrap, inPlay, live({ 1: 3, 2: 2 }), 10);
    expect(atFullTime.byElement.get(1)).toBe(3);
  });

  it("ignores fixtures that are confirmed, unstarted, or STILL IN PLAY", () => {
    const done = inPlay.map((f) => ({ ...f, finished: true }));
    expect(provisionalBonus(bootstrap, done, live({ 1: 30, 2: 25 }), 10).byElement.size).toBe(0);
    const notStarted = inPlay.map((f) => ({ ...f, started: false, finished_provisional: false }));
    expect(provisionalBonus(bootstrap, notStarted, live({ 1: 30 }), 10).byElement.size).toBe(0);
    /*
     * The one this was missing. A match under way has a BPS table that is still
     * moving, and reading 3/2/1 off it is a forecast — which this app does not
     * put into a total it presents as the reader's score, least of all one the
     * captain then doubles.
     */
    const running = inPlay.map((f) => ({ ...f, finished_provisional: false }));
    expect(provisionalBonus(bootstrap, running, live({ 1: 30, 2: 25 }), 10).byElement.size).toBe(0);
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

  /*
   * `finished` is BONUS CONFIRMED. Both legs have been played either way, so
   * `finished_provisional` is true on both — that is the state a double
   * gameweek is actually read in, and the state `provisionalBonus` now
   * requires: full time, confirmation outstanding.
   */
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
      finished_provisional: true,
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

  it("reads the fixture's own BPS ladder when FPL publishes one", () => {
    /*
     * THE ABSTENTION EXISTED BECAUSE THE TYPE WAS MISSING A FIELD.
     *
     * `provisionalBonus` blanked out every double gameweek on the stated
     * premise that "FPL publishes BPS only as a gameweek total". It does not:
     * `fixtures/` carries a per-fixture `stats` array with a `bps` row per
     * player who appeared, split home and away. Read off the real snapshot
     * (2026-08-21, GW1 fixture 1): 30 rows for the 30 players who appeared,
     * −8 to 41, and the top three are exactly the three the `bonus` rows pay
     * 3, 2 and 1.
     *
     * Here element 1 banked 45 BPS in a finished leg 1 and did not appear in
     * leg 2. On gameweek totals he outranks everyone and the fixture abstains.
     * With leg 2's own ladder he is simply not in it, and the two men actually
     * on the pitch get their bonus.
     */
    const withBps = (f: Fixture, rows: [number, number][]): Fixture => ({
      ...f,
      stats: [{ identifier: "bps", h: rows.map(([element, value]) => ({ element, value })), a: [] }],
    });
    const res = provisionalBonus(
      bootstrap,
      [fx(1, true), withBps(fx(2, false), [[2, 20], [3, 26]])],
      feed({
        1: { bps: 45, legs: [{ fixture: 1, minutes: 90 }] },
        2: { bps: 65, legs: [{ fixture: 1, minutes: 90 }, { fixture: 2, minutes: 60 }] },
        3: { bps: 26, legs: [{ fixture: 2, minutes: 60 }] },
      }),
      10
    );
    expect(res.byElement.get(1), "not on the pitch for leg 2").toBeUndefined();
    expect(res.byElement.get(3), "leads leg 2's own ladder").toBe(3);
    expect(res.byElement.get(2), "second in leg 2's own ladder").toBe(2);
  });

  it("treats an EMPTY bps row as no ladder at all", () => {
    /*
     * FPL emits identifiers with both arrays empty — `own_goals`, `red_cards`,
     * `penalties_saved` and `penalties_missed` all are on the snapshot's own
     * fixture 1 — so `bps` may arrive that way. A size-0 Map that reads as "we
     * have a ladder" selected the gameweek-total ranking AND skipped the
     * abstention, silently re-enabling the exact bug this block removes:
     * element 2's 65 BPS is banked in leg 1 and he was handed 3 for leg 2.
     */
    const empty = (f: Fixture): Fixture => ({
      ...f,
      stats: [{ identifier: "bps", h: [], a: [] }],
    });
    const res = provisionalBonus(
      bootstrap,
      [fx(1, true), empty(fx(2, false))],
      feed({
        1: { bps: 45, legs: [{ fixture: 1, minutes: 90 }] },
        2: { bps: 65, legs: [{ fixture: 1, minutes: 90 }, { fixture: 2, minutes: 60 }] },
        3: { bps: 26, legs: [{ fixture: 2, minutes: 60 }] },
      }),
      10
    );
    expect(res.byElement.size).toBe(0);
  });

  it("keeps a zero-BPS player in the ladder, since FPL omits his row", () => {
    /*
     * Measured on the 2026-08-21 snapshot: 31 players appeared in fixture 1 and
     * 30 have `bps` rows — FPL omits zero-valued entries, so a keeper who
     * played 90 minutes for 1 point and 0 BPS is simply absent. "No row means
     * he did not appear" was the stated justification for dropping the minutes
     * cross-check, and it is false. Zero can take the third bonus point in a
     * match where only two players score any BPS at all.
     */
    const withBps = (f: Fixture, rows: [number, number][]): Fixture => ({
      ...f,
      stats: [{ identifier: "bps", h: rows.map(([element, value]) => ({ element, value })), a: [] }],
    });
    const res = provisionalBonus(
      bootstrap,
      // Only elements 1 and 2 have rows; element 3 played and is on zero.
      [withBps(fx(1, false), [[1, 30], [2, 20]])],
      feed({
        1: { bps: 30, legs: [{ fixture: 1, minutes: 90 }] },
        2: { bps: 20, legs: [{ fixture: 1, minutes: 90 }] },
        3: { bps: 0, legs: [{ fixture: 1, minutes: 90 }] },
      }),
      10
    );
    expect(res.byElement.get(1)).toBe(3);
    expect(res.byElement.get(2)).toBe(2);
    expect(res.byElement.get(3), "third place on zero BPS").toBe(1);
  });

  it("still abstains on gameweek totals when the fixture publishes no ladder", () => {
    // The fix must not depend on `stats` being there. FPL may only populate it
    // from the final whistle — that could not be checked from where this was
    // written — so a fixture without it falls through to exactly the previous
    // behaviour, which for a two-leg participant is to say nothing.
    const res = provisionalBonus(
      bootstrap,
      [fx(1, true), fx(2, false)],
      feed({
        1: { bps: 45, legs: [{ fixture: 1, minutes: 90 }] },
        2: { bps: 65, legs: [{ fixture: 1, minutes: 90 }, { fixture: 2, minutes: 60 }] },
        3: { bps: 26, legs: [{ fixture: 2, minutes: 60 }] },
      }),
      10
    );
    expect(res.byElement.size).toBe(0);
  });

  it("pays a player who leads both legs twice, as FPL does", () => {
    /*
     * Unreachable until now: being credited from two legs meant playing two,
     * which made both fixtures abstain. With each fixture carrying its own
     * ladder the branch has a reachable input, and `Math.max` would credit 3
     * where FPL pays 3 + 3.
     */
    const withBps = (f: Fixture, rows: [number, number][]): Fixture => ({
      ...f,
      stats: [{ identifier: "bps", h: rows.map(([element, value]) => ({ element, value })), a: [] }],
    });
    const res = provisionalBonus(
      bootstrap,
      [withBps(fx(1, false), [[2, 40], [1, 10]]), withBps(fx(2, false), [[2, 33], [3, 12]])],
      feed({
        1: { bps: 10, legs: [{ fixture: 1, minutes: 90 }] },
        2: { bps: 73, legs: [{ fixture: 1, minutes: 90 }, { fixture: 2, minutes: 60 }] },
        3: { bps: 12, legs: [{ fixture: 2, minutes: 60 }] },
      }),
      10
    );
    expect(res.byElement.get(2)).toBe(6);
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

  it("does not fall back to gameweek minutes for a leg not yet itemised", () => {
    /*
     * `explain` for a second leg is ABSENT ENTIRELY between kickoff and FPL's
     * first stats update for it — no element carries a row for that fixture id.
     * The old fallback tested `inThis`, i.e. "does this FIXTURE have rows", so
     * it saw undefined and put the whole gameweek's minutes back in play:
     * probe-confirmed, both leg-1 players were handed provisional bonus for a
     * match they were not in, and the leg-1 bonus already confirmed for one of
     * them was counted twice on top. The test has to be "does this FEED itemise
     * at all", which is a different question.
     */
    const leg1Only = (id: number, bps: number, bonus: number) => ({
      id,
      stats: { minutes: 90, total_points: 0, bonus, bps, goals_scored: 0, assists: 0 },
      explain: [
        {
          fixture: 100,
          stats: [
            { identifier: "minutes", points: 2, value: 90 },
            ...(bonus ? [{ identifier: "bonus", points: bonus, value: bonus }] : []),
          ],
        },
      ],
    });
    const live: EventLive = {
      // Nobody has an `explain` row for fixture 101 yet.
      elements: [leg1Only(1, 45, 3), leg1Only(2, 40, 2), leg1Only(3, 12, 0)],
    };
    const res = provisionalBonus(bootstrap, [fx(100, true), fx(101, false)], live, 10);
    // The in-play leg has nobody itemised in it, so it projects nothing at all
    // rather than borrowing the finished leg's team sheet.
    expect(res.byElement.size).toBe(0);
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

describe("isInPlay", () => {
  const f = (over: Partial<Fixture>) =>
    ({ started: true, finished: false, ...over }) as Fixture;

  it("is false once the whistle has gone, even before bonus is settled", () => {
    // `started && !finished` stayed true for hours after full time, so a
    // finished match was styled as in-play beside a clock already reading FT.
    expect(isInPlay(f({ finished_provisional: true }))).toBe(false);
    expect(isInPlay(f({ finished: true }))).toBe(false);
  });

  it("is true while the match is actually running", () => {
    expect(isInPlay(f({ finished_provisional: false }))).toBe(true);
    expect(isInPlay(f({}))).toBe(true);
  });

  it("is false before kickoff", () => {
    expect(isInPlay(f({ started: false }))).toBe(false);
  });
});

describe("fixtureLines reads one match, not the gameweek", () => {
  const bootstrap = { elements: [1, 2, 3].map((id) => makeElement({ id, team: id === 3 ? 2 : 1 })) } as Bootstrap;
  void bootstrap;

  const fx = (id: number, stats?: Fixture["stats"]): Fixture =>
    ({
      id,
      event: 10,
      team_h: 1,
      team_a: 2,
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      kickoff_time: "2026-01-01T15:00:00Z",
      // Full time, bonus unconfirmed — the only state `provisionalBonus` reads.
      finished: false,
      finished_provisional: true,
      started: true,
      team_h_score: 1,
      team_a_score: 0,
      stats,
    }) as Fixture;

  const feed = (
    spec: Record<number, { bps: number; legs: { fixture: number; minutes: number; points: number }[] }>
  ): EventLive => ({
    elements: Object.entries(spec).map(([id, s]) => ({
      id: Number(id),
      stats: {
        minutes: s.legs.reduce((a, l) => a + l.minutes, 0),
        total_points: s.legs.reduce((a, l) => a + l.points, 0),
        bonus: 0,
        bps: s.bps,
        goals_scored: 0,
        assists: 0,
      },
      explain: s.legs.map((l) => ({
        fixture: l.fixture,
        stats: [{ identifier: "minutes", points: l.points, value: l.minutes }],
      })),
    })),
  }) as unknown as EventLive;

  const dgw = feed({
    1: { bps: 45, legs: [{ fixture: 1, minutes: 90, points: 9 }] },
    2: { bps: 65, legs: [{ fixture: 1, minutes: 90, points: 8 }, { fixture: 2, minutes: 60, points: 3 }] },
    3: { bps: 26, legs: [{ fixture: 2, minutes: 60, points: 5 }] },
  });

  it("leaves out a player who did not appear in this leg", () => {
    /*
     * Read off gameweek totals, the leg-2 sheet listed element 1 — who only
     * played leg 1 — as a top performer in leg 2, at 90 minutes he did not play
     * there, ranked on 45 BPS he did not earn there.
     */
    const lines = fixtureLines(fx(2), dgw);
    expect(lines.has(1)).toBe(false);
    // Element 2 played BOTH legs, so his gameweek BPS is not this fixture's and
    // there is no ladder to read it from: null, meaning "no data".
    expect(lines.get(2)).toEqual({ minutes: 60, points: 3, bps: null });
    // Element 3 played only this one, so the gameweek total IS this fixture's.
    // Returning null there threw away a number that was always correct.
    expect(lines.get(3)).toEqual({ minutes: 60, points: 5, bps: 26 });
  });

  it("does not add two legs' minutes together", () => {
    // 90 + 60 = 150 across the gameweek; 90 in leg 1 and 60 in leg 2.
    expect(fixtureLines(fx(1), dgw).get(2)!.minutes).toBe(90);
    expect(fixtureLines(fx(2), dgw).get(2)!.minutes).toBe(60);
  });

  it("uses the fixture's own BPS ladder when it publishes one", () => {
    const withBps = fx(2, [
      { identifier: "bps", h: [{ element: 2, value: 20 }], a: [{ element: 3, value: 26 }] },
    ]);
    const lines = fixtureLines(withBps, dgw);
    expect(lines.get(2)!.bps).toBe(20);
    expect(lines.get(3)!.bps).toBe(26);
  });

  it("falls back to gameweek totals when the feed itemises nothing", () => {
    // A stub feed, or a single-fixture gameweek — where the two agree anyway.
    const flat = {
      elements: [
        { id: 1, stats: { minutes: 90, total_points: 9, bonus: 0, bps: 45, goals_scored: 0, assists: 0 } },
      ],
    } as unknown as EventLive;
    expect(fixtureLines(fx(1), flat).get(1)).toEqual({ minutes: 90, points: 9, bps: 45 });
  });

  it("returns nothing at all without a live feed", () => {
    expect(fixtureLines(fx(1), null).size).toBe(0);
  });
});


describe("the safety score compares like with like", () => {
  /*
   * The reader's own total on this tab is `(raw + projectedBonus) * multiplier`
   * and the rank-band benchmark was `stats.total_points` alone. Through the
   * window CLAUDE.md describes as "hours apart" — final whistle to bonus
   * confirmation — that credits the reader two to eight points it credits
   * nobody they are being compared against, and the tab then prints "you're N
   * above; on course to climb".
   *
   * It does not bite on the demo, whose in-play fixtures itemise bonus in
   * `explain` so `provisionalBonus` returns an empty map, which is why it could
   * only be found by reading the two code paths against each other.
   */
  const elements = makeSquad();
  const fixtures = makeFinishedFixtures();
  const entry = (id: number, chip: string | null = null): EntryEventPicks =>
    ({
      active_chip: chip,
      picks: makePicks(),
      entry_history: { event: 10, points: 0, event_transfers_cost: 0 },
      entry: id,
    }) as unknown as EntryEventPicks;

  const five = [1, 2, 3, 4, 5].map((i) => entry(i));

  it("counts projected bonus for rivals, exactly as it does for the reader", () => {
    const live = makeLive({});
    const without = bandMedianScore(five, elements, live, fixtures, 10, null)!;
    // Three points of provisional bonus to a player in everyone's XI.
    const with_ = bandMedianScore(five, elements, live, fixtures, 10, new Map([[1, 3]]))!;
    expect(without).toBeGreaterThan(0);
    expect(with_).toBe(without + 3);
  });

  it("doubles a captain's projected bonus, like any other point", () => {
    const live = makeLive({});
    const base = bandMedianScore(five, elements, live, fixtures, 10, null)!;
    // Element 8 is the captain in `makePicks`, but the multiplier there is 1 —
    // so give one rival a real armband and check it through the pick.
    const capped = five.map((p) => ({
      ...p,
      picks: p.picks.map((pk) => (pk.element === 8 ? { ...pk, multiplier: 2 } : pk)),
    }));
    const noBonus = bandMedianScore(capped, elements, live, fixtures, 10, null)!;
    const withBonus = bandMedianScore(capped, elements, live, fixtures, 10, new Map([[8, 3]]))!;
    expect(withBonus - noBonus).toBe(6);
    expect(noBonus).toBe(base + 2);
  });

  it("moves the armband to the vice when the captain does not play", () => {
    /*
     * The reader's own total promotes the vice once the captain can no longer
     * play; this used to take `pk.multiplier` off the picks payload, which is
     * what FPL recorded at the DEADLINE. So the reader got the takeover and the
     * benchmark never did — the same direction as the bonus gap that was fixed
     * beside it, and the commit that fixed that asserted "everything else in
     * this comparison is already symmetric".
     *
     * `makePicks` captains element 8 and vice-captains element 9, both at
     * multiplier 1, so the armband is given explicitly here.
     */
    const capped = five.map((p) => ({
      ...p,
      picks: p.picks.map((pk) => (pk.element === 8 ? { ...pk, multiplier: 2 } : pk)),
    }));
    /*
     * Captain (element 8) on zero minutes, vice (element 9) playing. The
     * auto-sub projection already drops the captain out of the effective XI,
     * so the takeover fires on `subs.out` alone and `gwDone` is not what
     * decides it — eleven players count either way. What changes is that the
     * VICE is doubled: 11 x 2 = 22 without the takeover, 24 with it.
     */
    const blank = makeLive({ 8: 0 });
    expect(bandMedianScore(capped, elements, blank, fixtures, 10, null, false)).toBe(24);
    expect(bandMedianScore(capped, elements, blank, fixtures, 10, null, true)).toBe(24);
    // And with everyone playing there is no takeover, so the captain keeps the
    // armband and the vice counts once — the same 24, by a different route.
    expect(bandMedianScore(capped, elements, makeLive({}), fixtures, 10, null, false)).toBe(24);
  });

  it("does not promote a vice who has not played either", () => {
    const capped = five.map((p) => ({
      ...p,
      picks: p.picks.map((pk) => (pk.element === 8 ? { ...pk, multiplier: 2 } : pk)),
    }));
    // Both blank: the captain's armband stays where it is and is simply worth
    // nothing, which is what FPL does. Two players out of the eleven, both
    // replaced by 2-point substitutes, so the total is the plain 22.
    const bothBlank = makeLive({ 8: 0, 9: 0 });
    expect(bandMedianScore(capped, elements, bothBlank, fixtures, 10, null, true)).toBe(22);
    expect(bandMedianScore(capped, elements, bothBlank, fixtures, 10, null, false)).toBe(22);
  });

  it("nets the hit off, on both sides of the comparison", () => {
    const live = makeLive({});
    const plain = bandMedianScore(five, elements, live, fixtures, 10, null)!;
    const hit = five.map((p) => ({
      ...p,
      entry_history: { ...p.entry_history, event_transfers_cost: 4 },
    }));
    expect(bandMedianScore(hit, elements, live, fixtures, 10, null)).toBe(plain - 4);
  });

  it("refuses to call three managers a rank band", () => {
    expect(bandMedianScore(five.slice(0, 3), elements, makeLive({}), fixtures, 10, null)).toBeNull();
  });

  it("takes the bench too under Bench Boost", () => {
    const live = makeLive({});
    const plain = bandMedianScore(five, elements, live, fixtures, 10, null)!;
    const bb = [1, 2, 3, 4, 5].map((i) => entry(i, "bboost"));
    // Four more players at two points each.
    expect(bandMedianScore(bb, elements, live, fixtures, 10, null)).toBe(plain + 8);
  });
});


describe("one definition of a manager's live score", () => {
  /*
   * Three tabs computed this three different ways. The Live tab had provisional
   * bonus and the vice-captain takeover; the Team pitch corner had the takeover
   * and no bonus; the Mini-league row had neither, for the reader and for every
   * rival. Measured on the demo squad at GW20, identical inputs:
   *
   *                                          Live   Team pitch   Mini-league
   *   demo as shipped                          48       48           48
   *   bonus awarded but not yet confirmed      48       46           46
   *   captain blanked, vice played             53       53           52
   *
   * The first row agrees only because `demo.ts` itemises bonus into `explain`
   * for in-play fixtures, so `provisionalBonus` returns an empty map there.
   */
  const elements = makeSquad();
  const fixtures = makeFinishedFixtures();
  const entry = (over: Partial<EntryEventPicks> = {}): EntryEventPicks =>
    ({
      active_chip: null,
      picks: makePicks().map((pk) => (pk.element === 8 ? { ...pk, multiplier: 2 } : pk)),
      entry_history: { event: 10, points: 0, event_transfers_cost: 0 },
      entry: 1,
      ...over,
    }) as unknown as EntryEventPicks;

  it("counts provisional bonus", () => {
    const live = makeLive({});
    const plain = liveEntryScore(entry(), elements, live, fixtures, 10, null);
    const withBonus = liveEntryScore(entry(), elements, live, fixtures, 10, new Map([[1, 3]]));
    expect(withBonus - plain).toBe(3);
  });

  it("moves the armband, and doubles the bonus under it", () => {
    const blank = makeLive({ 8: 0 });
    const noTakeover = liveEntryScore(entry(), elements, blank, fixtures, 10, null, false);
    // The auto-sub already drops the captain, so what the takeover adds is the
    // vice's second multiple.
    const withVice = new Map([[9, 3]]);
    expect(liveEntryScore(entry(), elements, blank, fixtures, 10, withVice, false)).toBe(
      noTakeover + 6
    );
  });

  it("is net of the hit", () => {
    const live = makeLive({});
    const plain = liveEntryScore(entry(), elements, live, fixtures, 10, null);
    const hit = entry({
      entry_history: { event: 10, points: 0, event_transfers_cost: 8 },
    } as Partial<EntryEventPicks>);
    expect(liveEntryScore(hit, elements, live, fixtures, 10, null)).toBe(plain - 8);
  });

  it("is what bandMedianScore takes the median of", () => {
    const live = makeLive({});
    const five = [1, 2, 3, 4, 5].map(() => entry());
    const one = liveEntryScore(five[0], elements, live, fixtures, 10, null);
    expect(bandMedianScore(five, elements, live, fixtures, 10, null)).toBe(one);
  });
});

describe("feedStallMs — a 200 does not mean the data moved", () => {
  const T0 = 1_700_000_000_000;
  // One poll: fold the payload in, then ask how long it has been still.
  let watch = { sig: "", at: T0 };
  const step = (w: { sig: string; at: number }, fixtures: Fixture[], event: number, now: number) => {
    watch = advanceFeedWatch(w, fixtures, event, now);
    w.sig = watch.sig;
    w.at = watch.at;
    return feedStallMs(watch, now);
  };

  const fx = (over: Partial<Fixture>): Fixture =>
    ({
      id: 1,
      event: 1,
      started: true,
      finished: false,
      finished_provisional: false,
      minutes: 10,
      team_h: 1,
      team_a: 2,
      team_h_score: 0,
      team_a_score: 0,
      kickoff_time: new Date(T0).toISOString(),
      stats: [],
      ...over,
    }) as Fixture;

  it("is null while the clock advances", () => {
    const w = { sig: "", at: T0 };
    expect(step(w, [fx({ minutes: 10 })], 1, T0)).toBeNull();
    expect(step(w, [fx({ minutes: 11 })], 1, T0 + 60_000)).toBeNull();
    // Even long after the first sighting, because the signature keeps changing.
    expect(step(w, [fx({ minutes: 30 })], 1, T0 + 60 * 60_000)).toBeNull();
  });

  it("is null while a score moves even if the clock does not", () => {
    const w = { sig: "", at: T0 };
    step(w, [fx({ minutes: 45 })], 1, T0);
    expect(
      step(w, [fx({ minutes: 45, team_h_score: 1 })], 1, T0 + 30 * 60_000)
    ).toBeNull();
  });

  it("tolerates half time, which legitimately freezes the clock at 45", () => {
    const w = { sig: "", at: T0 };
    step(w, [fx({ minutes: 45 })], 1, T0);
    // 15 minutes is the Laws of the Game cap; this must not cry wolf.
    expect(step(w, [fx({ minutes: 45 })], 1, T0 + 15 * 60_000)).toBeNull();
    expect(step(w, [fx({ minutes: 45 })], 1, T0 + 19 * 60_000)).toBeNull();
  });

  it("reports a feed that has stopped moving past the bound", () => {
    const w = { sig: "", at: T0 };
    step(w, [fx({ minutes: 55 })], 1, T0);
    expect(step(w, [fx({ minutes: 55 })], 1, T0 + FEED_STALL_MS)).toBe(FEED_STALL_MS);
    // The observed case: a finished 2-0 still rendering 55'.
    const held = 45 * 60_000;
    expect(step(w, [fx({ minutes: 55, team_h_score: 2 })], 1, T0 + held)).toBeNull();
  });

  it("resets rather than accusing when no match is in play", () => {
    const w = { sig: "", at: T0 };
    step(w, [fx({ minutes: 55 })], 1, T0);
    // Between kick-offs the signature is empty; that is not a stall.
    expect(step(w, [fx({ finished_provisional: true })], 1, T0 + 60 * 60_000)).toBeNull();
    expect(w.at).toBe(T0 + 60 * 60_000);
  });

  it("ignores fixtures from another gameweek", () => {
    const w = { sig: "", at: T0 };
    expect(liveSignature([fx({ event: 2, minutes: 70 })], 1)).toBe("");
    expect(step(w, [fx({ event: 2 })], 1, T0 + 60 * 60_000)).toBeNull();
  });

  it("does not go stale on fixture ORDER, which the API does not promise", () => {
    const a = fx({ id: 1, minutes: 10 });
    const b = fx({ id: 2, minutes: 20 });
    expect(liveSignature([a, b], 1)).toBe(liveSignature([b, a], 1));
  });

  it("tolerates stoppage at 90, where the clock legitimately stops", () => {
    // `minutes` caps at 90 and holds there for the rest of a match that runs
    // to 94 — measured, see `matchMinute`. Stoppage cannot outlast the bound.
    const w = { sig: "", at: T0 };
    step(w, [fx({ minutes: 90 })], 1, T0);
    expect(step(w, [fx({ minutes: 90 })], 1, T0 + 19 * 60_000)).toBeNull();
  });

  it("still reports a stall at 90 once stoppage cannot explain it", () => {
    // The whistle flips `finished_provisional`. Half an hour on 90 with the
    // flag still down is the feed, not the football.
    const w = { sig: "", at: T0 };
    step(w, [fx({ minutes: 90 })], 1, T0);
    expect(step(w, [fx({ minutes: 90 })], 1, T0 + 30 * 60_000)).toBe(30 * 60_000);
  });

  it("drops out of the in-play set once the whistle goes", () => {
    // Not a stall — there is nothing left to be stale ABOUT, and the reset
    // matters so the wait for the next kick-off does not accumulate.
    const w = { sig: "", at: T0 };
    step(w, [fx({ minutes: 90 })], 1, T0);
    expect(
      step(w, [fx({ minutes: 90, finished_provisional: true })], 1, T0 + 25 * 60_000)
    ).toBeNull();
    expect(w.sig).toBe("");
  });
});

describe("liveMatchMinutes — the fresher of FPL's two clocks", () => {
  const el = (id: number, minutes: number, fixtures: number[]) =>
    ({
      id,
      stats: { minutes },
      explain: fixtures.map((fixture) => ({ fixture, stats: [] })),
    }) as unknown as EventLive["elements"][number];
  const live = (els: EventLive["elements"]) => ({ elements: els }) as EventLive;

  it("takes the highest minutes among that fixture's players", () => {
    // Someone playing the whole match reads the match clock; a substitute does
    // not, so the max is the fixture's minute and the min is nobody's.
    expect(liveMatchMinutes(live([el(1, 16, [7]), el(2, 4, [7])]), 7)).toBe(16);
  });

  it("ignores players from other fixtures", () => {
    expect(liveMatchMinutes(live([el(1, 90, [8]), el(2, 16, [7])]), 7)).toBe(16);
  });

  it("REFUSES a player with two legs, whose minutes are a gameweek total", () => {
    /*
     * The trap this whole function has to survive. `stats.minutes` is summed
     * across the gameweek, so a player who banked 90 in leg 1 would report 90
     * for a leg 2 ten minutes old — and the clock would read "90+'" on a match
     * that had barely started.
     */
    expect(liveMatchMinutes(live([el(1, 97, [6, 7])]), 7)).toBeNull();
    // The single-leg player beside him is still a valid reading.
    expect(liveMatchMinutes(live([el(1, 97, [6, 7]), el(2, 11, [7])]), 7)).toBe(11);
  });

  it("is null when nothing can answer, so the caller can fall back", () => {
    expect(liveMatchMinutes(null, 7)).toBeNull();
    expect(liveMatchMinutes(live([]), 7)).toBeNull();
    expect(liveMatchMinutes(live([el(1, 20, [])]), 7)).toBeNull();
  });

  it("survives a non-numeric minutes field off the network", () => {
    const junk = { id: 1, stats: { minutes: "16" }, explain: [{ fixture: 7, stats: [] }] };
    expect(liveMatchMinutes(live([junk] as unknown as EventLive["elements"]), 7)).toBeNull();
  });
});

describe("matchMinute prefers whichever clock was refreshed most recently", () => {
  const fx = (minutes: number): Fixture =>
    ({
      id: 7,
      event: 1,
      started: true,
      finished: false,
      finished_provisional: false,
      minutes,
      kickoff_time: "2026-08-22T14:00:00Z",
    }) as Fixture;

  it("uses the live clock when it leads the fixtures one", () => {
    // The measured case: IPS-SUN at 14:18:11Z, 18 minutes played.
    expect(matchMinute(fx(10), undefined, 16)).toBe("16'");
  });

  it("keeps the fixtures clock when IT leads", () => {
    // Both are lower bounds; neither can run ahead of the match.
    expect(matchMinute(fx(13), undefined, 12)).toBe("13'");
  });

  it("falls back cleanly when the live feed cannot answer", () => {
    expect(matchMinute(fx(10), undefined, null)).toBe("10'");
    expect(matchMinute(fx(10), undefined)).toBe("10'");
  });

  it("still caps at 90+ and still calls full time off the flags", () => {
    expect(matchMinute(fx(88), undefined, 93)).toBe("90+'");
    const done = { ...fx(90), finished_provisional: true } as Fixture;
    expect(matchMinute(done, undefined, 94)).toBe("FT");
  });

  it("does not let the live clock start a match FPL has not started", () => {
    const notStarted = { ...fx(0), started: false } as Fixture;
    expect(matchMinute(notStarted, undefined, 12)).toBe("");
  });
});

describe("squadMatchState — how much football is still to come", () => {
  const els = makeSquad();
  // makeSquad's teams: GK id1 -> team1; ids 2-5 -> teams 3,4,5,0->6? see helper.
  const teamOf = (id: number) => els.get(id)!.team;

  const fixture = (
    id: number,
    home: number,
    away: number,
    state: "todo" | "live" | "done"
  ): Fixture =>
    ({
      id,
      event: 1,
      team_h: home,
      team_a: away,
      started: state !== "todo",
      finished: state === "done",
      finished_provisional: state === "done",
      minutes: state === "todo" ? 0 : 90,
      kickoff_time: "2026-08-22T14:00:00Z",
      team_h_score: 0,
      team_a_score: 0,
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      stats: [],
    }) as Fixture;

  const liveAll = (): EventLive =>
    ({
      elements: [...els.keys()].map((id) => ({
        id,
        stats: { minutes: 90, total_points: 2 },
        explain: [],
      })),
    }) as unknown as EventLive;

  it("counts every counting player exactly once", () => {
    const picks = makePicks();
    const teams = [...new Set([...els.values()].map((e) => e.team))];
    const fixtures = teams.map((t, i) => fixture(100 + i, t, 90 + i, "live"));
    const st = squadMatchState(
      { picks, active_chip: null, entry_history: { event_transfers_cost: 0 } } as EntryEventPicks,
      els,
      liveAll(),
      fixtures,
      1
    );
    // The eleven that count, no more: the bench is not in play for anybody.
    expect(st.inPlay + st.toStart + st.played + st.blank).toBe(11);
    expect(st.inPlay).toBe(11);
  });

  it("counts all fifteen under Bench Boost", () => {
    const picks = makePicks();
    const teams = [...new Set([...els.values()].map((e) => e.team))];
    const fixtures = teams.map((t, i) => fixture(100 + i, t, 90 + i, "todo"));
    const st = squadMatchState(
      {
        picks,
        active_chip: "bboost",
        entry_history: { event_transfers_cost: 0 },
      } as EntryEventPicks,
      els,
      liveAll(),
      fixtures,
      1
    );
    expect(st.toStart).toBe(15);
  });

  it("separates running, waiting and finished", () => {
    const picks = makePicks();
    const teams = [...new Set([...els.values()].map((e) => e.team))];
    const fixtures = teams.map((t, i) =>
      fixture(100 + i, t, 90 + i, i === 0 ? "live" : i === 1 ? "todo" : "done")
    );
    const st = squadMatchState(
      { picks, active_chip: null, entry_history: { event_transfers_cost: 0 } } as EntryEventPicks,
      els,
      liveAll(),
      fixtures,
      1
    );
    expect(st.inPlay).toBeGreaterThan(0);
    expect(st.toStart).toBeGreaterThan(0);
    expect(st.played).toBeGreaterThan(0);
  });

  it("reports a blank club separately instead of calling it finished", () => {
    // No fixture at all is neither waiting nor played, and folding it into
    // "played" would tell a reader their week was over when it never started.
    const picks = makePicks();
    const st = squadMatchState(
      { picks, active_chip: null, entry_history: { event_transfers_cost: 0 } } as EntryEventPicks,
      els,
      liveAll(),
      [],
      1
    );
    expect(st.blank).toBe(11);
    expect(st.played).toBe(0);
  });

  it("calls a double gameweek in play while either leg is running", () => {
    const picks = makePicks();
    const t = teamOf(1);
    const st = squadMatchState(
      { picks, active_chip: null, entry_history: { event_transfers_cost: 0 } } as EntryEventPicks,
      els,
      liveAll(),
      [fixture(1, t, 99, "done"), fixture(2, t, 98, "live")],
      1
    );
    expect(st.inPlay).toBeGreaterThan(0);
  });

  it("prefers IN PLAY over TO START when a double has both", () => {
    /*
     * A man on the pitch right now who also has a second match later is
     * playing, not waiting. Ordering the two checks the other way round reads
     * as "yet to kick off" for someone visibly on the field — and the first
     * version of the test above could not tell the difference, because both
     * its legs had already started. It survived the mutation.
     */
    const picks = makePicks();
    const t = teamOf(1);
    const st = squadMatchState(
      { picks, active_chip: null, entry_history: { event_transfers_cost: 0 } } as EntryEventPicks,
      els,
      liveAll(),
      [fixture(1, t, 99, "live"), fixture(2, t, 98, "todo")],
      1
    );
    // Two of the eleven share that club in `makeSquad`; the count is not the
    // point. Nobody being called "yet to kick off" is.
    expect(st.toStart).toBe(0);
    expect(st.inPlay).toBeGreaterThan(0);
  });

  it("ignores fixtures from other gameweeks", () => {
    const picks = makePicks();
    const t = teamOf(1);
    const other = { ...fixture(1, t, 99, "live"), event: 2 } as Fixture;
    const st = squadMatchState(
      { picks, active_chip: null, entry_history: { event_transfers_cost: 0 } } as EntryEventPicks,
      els,
      liveAll(),
      [other],
      1
    );
    expect(st.inPlay).toBe(0);
    expect(st.blank).toBe(11);
  });
});
