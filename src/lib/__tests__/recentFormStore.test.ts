// The store `OptimizePanel` publishes into and `Dashboard` reads from, so the
// two stop quoting different five-gameweek xP for the same player.
//
// What is pinned here is the one thing element ids make dangerous: the demo
// numbers its players 1..300 and so do three hundred real footballers, so a
// record fetched under one feed must never be read under the other.

import { afterEach, describe, expect, it } from "vitest";
import { setDemoMode } from "../fpl";
import {
  cachedRecentForm,
  recentFormVersion,
  resetRecentForm,
  setRecentForm,
  subscribeRecentForm,
} from "../recentFormStore";
import type { RecentForm } from "../types";

const rec = (startShare: number): RecentForm =>
  ({ startShare, minsPerGame: 90 * startShare, minsPerStart: 90 }) as RecentForm;

afterEach(() => {
  resetRecentForm();
  setDemoMode(false);
});

describe("a record belongs to the feed it was fetched from", () => {
  it("drops a load that a feed switch overtook", () => {
    /*
     * THE READ PATH WAS GATED AND THE WRITE PATH WAS NOT.
     *
     * `fetchRecentForm` is hundreds of element-summary round trips with no
     * abort signal, and `setDemoMode` flips synchronously on navigation. So:
     * press Optimize on `/team/N`, open the demo while it runs, and the load
     * lands under the demo — where stamping `currentFeed()` at WRITE time filed
     * real footballers' start shares under demo ids, for `Dashboard` to read
     * straight into its projection.
     */
    setDemoMode(false);
    const fetchedUnder = "real";
    const map = new Map([[42, rec(1)]]);
    setDemoMode(true);
    setRecentForm(map, fetchedUnder);
    expect(cachedRecentForm()).toBeNull();
    // And it did not quietly land under the real feed either — the load is
    // gone, not relocated.
    setDemoMode(false);
    expect(cachedRecentForm()).toBeNull();
  });

  it("keeps a load that finished under the feed it started on", () => {
    setDemoMode(true);
    setRecentForm(new Map([[42, rec(1)]]), "demo");
    expect(cachedRecentForm()?.get(42)?.startShare).toBe(1);
    // Still invisible to the other feed.
    setDemoMode(false);
    expect(cachedRecentForm()).toBeNull();
  });

  it("merges rather than replaces, so a narrow request cannot delete a wide one", () => {
    setDemoMode(false);
    setRecentForm(new Map([[1, rec(1)], [2, rec(0.5)]]), "real");
    setRecentForm(new Map([[2, rec(0.25)]]), "real");
    const m = cachedRecentForm()!;
    expect(m.size).toBe(2);
    expect(m.get(1)?.startShare).toBe(1);
    expect(m.get(2)?.startShare).toBe(0.25);
  });
});

describe("the version is a usable useSyncExternalStore snapshot", () => {
  it("is stable while nothing changes and moves on every write", () => {
    setDemoMode(false);
    const a = recentFormVersion();
    expect(recentFormVersion()).toBe(a);
    setRecentForm(new Map([[1, rec(1)]]), "real");
    const b = recentFormVersion();
    expect(b).not.toBe(a);
    expect(recentFormVersion()).toBe(b);
  });

  it("changes on a feed switch, which no counter of its own would catch", () => {
    setDemoMode(false);
    const real = recentFormVersion();
    setDemoMode(true);
    expect(recentFormVersion()).not.toBe(real);
  });

  it("tells subscribers about a write, and stops when they leave", () => {
    setDemoMode(false);
    let n = 0;
    const off = subscribeRecentForm(() => n++);
    setRecentForm(new Map([[1, rec(1)]]), "real");
    expect(n).toBe(1);
    off();
    setRecentForm(new Map([[2, rec(1)]]), "real");
    expect(n).toBe(1);
  });

  it("does not notify for a load it dropped", () => {
    // A dropped load changed nothing, so waking every consumer to re-project
    // would be a re-render with no new information behind it.
    setDemoMode(true);
    let n = 0;
    const off = subscribeRecentForm(() => n++);
    setRecentForm(new Map([[1, rec(1)]]), "real");
    off();
    expect(n).toBe(0);
  });
});
