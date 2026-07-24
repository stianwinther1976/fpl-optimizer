import { describe, it, expect } from "vitest";
import { currentSeasonName, toArchive } from "../seasonArchive";
import { makeElement } from "./mockdata";
import type { Element, Event, Team } from "../types";
import type { SeasonBreakdown } from "../breakdown";

const ev = (id: number, deadline: string): Event =>
  ({
    id,
    name: `Gameweek ${id}`,
    deadline_time: deadline,
    finished: true,
    is_current: false,
    is_next: false,
    average_entry_score: 50,
    highest_score: 100,
  }) as Event;

describe("currentSeasonName", () => {
  it("labels an August kickoff as YYYY/YY", () => {
    expect(currentSeasonName([ev(2, "2026-08-22T10:00:00Z"), ev(1, "2026-08-15T10:00:00Z")])).toBe(
      "2026/27"
    );
  });

  it("uses gameweek 1, not whichever event comes first in the array", () => {
    expect(currentSeasonName([ev(38, "2027-05-20T14:00:00Z"), ev(1, "2026-08-15T10:00:00Z")])).toBe(
      "2026/27"
    );
  });

  it("rolls the century correctly", () => {
    expect(currentSeasonName([ev(1, "2099-08-14T10:00:00Z")])).toBe("2099/00");
  });

  it("returns null without a usable deadline", () => {
    expect(currentSeasonName([])).toBeNull();
    expect(currentSeasonName([ev(1, "not-a-date")])).toBeNull();
  });
});

describe("toArchive", () => {
  const teams: Team[] = [
    { id: 1, name: "Arsenal", short_name: "ARS", strength: 4 } as Team,
    { id: 2, name: "Brentford", short_name: "BRE", strength: 3 } as Team,
  ];
  const elements = new Map<number, Element>([
    [10, makeElement({ id: 10, element_type: 3, team: 1, web_name: "Saka" })],
    [11, makeElement({ id: 11, element_type: 2, team: 2, web_name: "Ajer" })],
    [12, makeElement({ id: 12, element_type: 4, team: 1, web_name: "Unused" })],
  ]);

  const bd: SeasonBreakdown = {
    gws: [1, 2],
    rows: [
      {
        elementId: 10,
        total: 24,
        minutesPlayed: 180,
        apps: 2,
        byCat: { minutes: 4, goals_scored: 10, bonus: 6, assists: 4 },
        byGw: new Map(),
        byGwCat: new Map(),
      },
      {
        elementId: 11,
        total: 6,
        minutesPlayed: 90,
        apps: 1,
        byCat: { minutes: 2, clean_sheets: 4 },
        byGw: new Map(),
        byGwCat: new Map(),
      },
      // Never featured: dropped from the archive to keep it small.
      {
        elementId: 12,
        total: 0,
        minutesPlayed: 0,
        apps: 0,
        byCat: {},
        byGw: new Map(),
        byGwCat: new Map(),
      },
    ],
    catTotals: { minutes: 6, goals_scored: 10, bonus: 6, assists: 4, clean_sheets: 4 },
    playersTotal: 30,
    hits: 8,
    perGw: new Map(),
  };

  it("denormalises names and teams so element-id reuse can't corrupt it", () => {
    const a = toArchive(946779, "2026/27", bd, elements, teams, 1000);
    expect(a.players).toHaveLength(2);
    expect(a.players[0]).toMatchObject({ name: "Saka", pos: 3, team: "ARS", total: 24, apps: 2 });
    expect(a.players[1]).toMatchObject({ name: "Ajer", pos: 2, team: "BRE" });
    expect(a.entryId).toBe(946779);
    expect(a.gwsPlayed).toBe(2);
  });

  it("carries the category totals and hit cost through unchanged", () => {
    const a = toArchive(1, "2026/27", bd, elements, teams, 1000);
    expect(a.catTotals["goals_scored"]).toBe(10);
    expect(a.hits).toBe(8);
    expect(a.playersTotal - a.hits).toBe(22);
  });

  it("copies byCat rather than aliasing the live breakdown", () => {
    const a = toArchive(1, "2026/27", bd, elements, teams, 1000);
    a.players[0].byCat["goals_scored"] = 999;
    expect(bd.rows[0].byCat["goals_scored"]).toBe(10);
  });
});
