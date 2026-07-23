import { describe, it, expect } from "vitest";
import { projectAutoSubs } from "../live";
import { availabilityAt } from "../xp";
import { makeElement } from "./mockdata";
import type { Element, EventLive, Fixture, Pick } from "../types";

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

describe("availabilityAt", () => {
  it("suspension zeroes only the next GW, not the horizon", () => {
    const el = makeElement({ id: 1, status: "s", chance_of_playing_next_round: 0 });
    expect(availabilityAt(el, 0)).toBe(0);
    expect(availabilityAt(el, 1)).toBeGreaterThanOrEqual(0.9);
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
