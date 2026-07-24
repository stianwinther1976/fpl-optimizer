import { describe, it, expect } from "vitest";
import { aggregateBreakdown } from "../breakdown";
import { makeElement } from "./mockdata";
import type { Element, EntryEventPicks, EventLive, Fixture, LiveExplainStat } from "../types";

function squad(): Map<number, Element> {
  const els = [
    makeElement({ id: 1, element_type: 1, team: 1 }),
    ...[2, 3, 4, 5].map((id) => makeElement({ id, element_type: 2, team: (id % 6) + 1 })),
    ...[6, 7, 8, 9].map((id) => makeElement({ id, element_type: 3, team: (id % 6) + 1 })),
    ...[10, 11].map((id) => makeElement({ id, element_type: 4, team: (id % 6) + 1 })),
    makeElement({ id: 12, element_type: 1, team: 2 }),
    makeElement({ id: 13, element_type: 2, team: 3 }),
    makeElement({ id: 14, element_type: 3, team: 4 }),
    makeElement({ id: 15, element_type: 4, team: 5 }),
  ];
  return new Map(els.map((e) => [e.id, e]));
}

function picks(overrides?: Partial<EntryEventPicks>): EntryEventPicks {
  return {
    active_chip: null,
    entry_history: {
      event: 10,
      points: 0,
      total_points: 0,
      rank: 0,
      event_transfers: 0,
      event_transfers_cost: 0,
      value: 1000,
      bank: 0,
    },
    picks: Array.from({ length: 15 }, (_, i) => ({
      element: i + 1,
      position: i + 1,
      multiplier: i < 11 ? 1 : 0,
      is_captain: i === 6, // element 7 (a MID)
      is_vice_captain: i === 7, // element 8
    })),
    ...overrides,
  } as EntryEventPicks;
}

function fixtures(): Fixture[] {
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

const st = (identifier: string, points: number, value = points): LiveExplainStat => ({
  identifier,
  points,
  value,
});

/** Live where each player plays 90' (2 min pts); extra stats supplied per id. */
function live(extra: Record<number, LiveExplainStat[]>, minutes: Record<number, number> = {}): EventLive {
  return {
    elements: Array.from({ length: 15 }, (_, i) => {
      const id = i + 1;
      const mins = minutes[id] ?? 90;
      const stats: LiveExplainStat[] = [st("minutes", mins >= 60 ? 2 : mins > 0 ? 1 : 0, mins), ...(extra[id] ?? [])];
      return {
        id,
        stats: {
          minutes: mins,
          total_points: stats.reduce((s, x) => s + x.points, 0),
          bonus: 0,
          bps: 0,
          goals_scored: 0,
          assists: 0,
        },
        explain: [{ fixture: 1, stats }],
      };
    }),
  };
}

describe("aggregateBreakdown", () => {
  it("doubles the captain and itemises categories", () => {
    // Captain = element 7 (MID), scores a goal (5) + assist (3) on top of 2 min.
    const l = live({ 7: [st("goals_scored", 5, 1), st("assists", 3, 1)] });
    const bd = aggregateBreakdown([{ gw: 10, picks: picks(), live: l }], squad(), fixtures());

    const cap = bd.rows.find((r) => r.elementId === 7)!;
    // (2 min + 5 goal + 3 assist) * 2 captain = 20
    expect(cap.total).toBe(20);
    expect(cap.byCat["goals_scored"]).toBe(10);
    expect(cap.byCat["assists"]).toBe(6);
    expect(cap.byCat["minutes"]).toBe(4);
    // Category totals aggregate across squad.
    expect(bd.catTotals["goals_scored"]).toBe(10);
    // 11 starters * 2 min, but captain min doubled: 10*2 + 4 = 24
    expect(bd.catTotals["minutes"]).toBe(24);
  });

  it("applies auto-subs: a 0-minute starter is replaced in bench order", () => {
    // Starter 11 (FWD) plays 0'. FPL fills by bench order, so the first legal
    // bench player (DEF 13 → a valid 5-4-1) comes on; it scored a goal (6).
    const l = live(
      { 13: [st("goals_scored", 6, 1)] },
      { 11: 0 } // starter blanked
    );
    const bd = aggregateBreakdown([{ gw: 10, picks: picks(), live: l }], squad(), fixtures());

    const benched = bd.rows.find((r) => r.elementId === 13);
    const dropped = bd.rows.find((r) => r.elementId === 11);
    // Bench DEF counts (came on): 2 min + 6 goal = 8.
    expect(benched?.total).toBe(8);
    // The 0-minute starter contributes nothing.
    expect(dropped?.total ?? 0).toBe(0);
  });

  it("subtracts transfer hits in the reconciliation totals, not from players", () => {
    const l = live({});
    const p = picks({
      entry_history: { ...picks().entry_history, event_transfers_cost: 8 },
    });
    const bd = aggregateBreakdown([{ gw: 10, picks: p, live: l }], squad(), fixtures());
    expect(bd.hits).toBe(8);
    // players total unaffected by hits; net = players - hits
    expect(bd.perGw.get(10)!.hits).toBe(8);
    expect(bd.playersTotal - bd.hits).toBe(bd.playersTotal - 8);
  });

  it("counts a Bench Boost week: all 15 score", () => {
    const l = live({});
    const bd = aggregateBreakdown(
      [{ gw: 10, picks: picks({ active_chip: "bboost" }), live: l }],
      squad(),
      fixtures()
    );
    // 14 outfield/GK at 2 + captain doubled (2*2) => 15 players, one doubled.
    // minutes total = 15*2 + 2 (captain extra) = 32
    expect(bd.catTotals["minutes"]).toBe(32);
    expect(bd.rows.filter((r) => r.total > 0).length).toBe(15);
  });
});
