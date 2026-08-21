import { describe, it, expect, beforeEach } from "vitest";
import { getRecentTeams, saveRecentTeam, removeRecentTeam } from "../recent";

/*
 * There is no jsdom here, so storage is stubbed the way `lineup.test.ts` does
 * it. The point of these is the removal path: until it existed, a team the
 * reader had opened once could only be got off the front page by opening five
 * others to evict it, or by clearing site data — which also takes the theme,
 * the saved line-up calls and the calibration record with it.
 */
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const KEY = "fpl-recent-teams";
const team = (id: number) => ({ id, name: `Team ${id}`, manager: `Manager ${id}` });

describe("removeRecentTeam", () => {
  beforeEach(() => store.clear());

  it("drops the one named and keeps the rest in order", () => {
    saveRecentTeam(team(1));
    saveRecentTeam(team(2));
    saveRecentTeam(team(3));
    // Most recent first.
    expect(getRecentTeams().map((t) => t.id)).toEqual([3, 2, 1]);
    expect(removeRecentTeam(2).map((t) => t.id)).toEqual([3, 1]);
    expect(getRecentTeams().map((t) => t.id)).toEqual([3, 1]);
  });

  it("returns the surviving list rather than making the caller re-read", () => {
    saveRecentTeam(team(1));
    saveRecentTeam(team(2));
    const left = removeRecentTeam(1);
    expect(left.map((t) => t.id)).toEqual([2]);
  });

  it("clears the key when the last team goes, rather than storing []", () => {
    saveRecentTeam(team(1));
    expect(removeRecentTeam(1)).toEqual([]);
    // A stored "[]" is a value that parses to nothing on every later visit.
    expect(store.has(KEY)).toBe(false);
    expect(getRecentTeams()).toEqual([]);
  });

  it("is a no-op for an id that is not in the list", () => {
    saveRecentTeam(team(1));
    expect(removeRecentTeam(99).map((t) => t.id)).toEqual([1]);
    expect(getRecentTeams().map((t) => t.id)).toEqual([1]);
  });

  it("removes only the id given, never one that merely looks like it", () => {
    saveRecentTeam(team(1));
    saveRecentTeam(team(11));
    saveRecentTeam(team(111));
    expect(removeRecentTeam(11).map((t) => t.id)).toEqual([111, 1]);
  });

  it("still reports the list when the write throws", () => {
    // A blocked or full store must not leave the screen showing a team the
    // reader just removed — the returned list is what gets rendered.
    saveRecentTeam(team(1));
    saveRecentTeam(team(2));
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
    });
    expect(removeRecentTeam(1).map((t) => t.id)).toEqual([2]);
    Object.defineProperty(globalThis, "localStorage", real);
  });

  it("re-adds a removed team when it is opened again", () => {
    // Removal is a convenience, not a tombstone, and the copy says so.
    saveRecentTeam(team(1));
    removeRecentTeam(1);
    saveRecentTeam(team(1));
    expect(getRecentTeams().map((t) => t.id)).toEqual([1]);
  });
});
