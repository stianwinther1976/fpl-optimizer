import { describe, it, expect } from "vitest";
import { projectAutoSubs, provisionalBonus } from "../live";
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
