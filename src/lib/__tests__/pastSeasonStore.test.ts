// The shared cache for last season's per-player record.
//
// One HTTP request per player makes this the most expensive thing the app does,
// so it is cached hard — and caching hard is exactly what made it lie. These
// tests pin the difference between "we already have this" and "we already tried
// this and it went badly", which are not the same claim.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PastSeasonFetch } from "../fpl";

const fetchPastSeason = vi.hoisted(() => vi.fn());
const currentFeed = vi.hoisted(() => vi.fn(() => "real" as "real" | "demo"));
vi.mock("../fpl", () => ({ fetchPastSeason, currentFeed }));

const {
  loadPastSeason,
  cachedPastSeason,
  pastSeasonCoverage,
  pastSeasonVersion,
  subscribePastSeason,
  resetPastSeasonStore,
} = await import("../pastSeasonStore");

/** `n` players fetched of `requested`, the rest failed. */
function result(n: number, requested: number): PastSeasonFetch {
  const data = new Map();
  for (let i = 1; i <= n; i++) {
    data.set(i, { points: 100, minutes: 2000, starts: 25 });
  }
  return { data, requested, failed: requested - n } as unknown as PastSeasonFetch;
}

const IDS = Array.from({ length: 420 }, (_, i) => i + 1);

describe("loadPastSeason", () => {
  beforeEach(() => {
    resetPastSeasonStore();
    fetchPastSeason.mockReset();
    currentFeed.mockReturnValue("real");
  });

  it("fetches once for a complete result", () => {
    fetchPastSeason.mockResolvedValue(result(420, 420));
    return loadPastSeason(IDS)
      .then(() => loadPastSeason(IDS))
      .then((r) => {
        expect(fetchPastSeason).toHaveBeenCalledTimes(1);
        expect(r.failed).toBe(0);
      });
  });

  it("really retries after a partial failure", async () => {
    // The drafter tells the user "Re-draft to try them again" when some lookups
    // fail. Re-drafting recomputes the identical pool, so it arrives here with
    // the identical key — and a cache that stored the partial result answered it
    // instantly with the same failure count, having issued no request at all.
    // The button did nothing, forever, until the page was reloaded, and the user
    // kept a squad drafted off the price prior while being told it could be
    // fixed by clicking.
    fetchPastSeason.mockResolvedValueOnce(result(333, 420));
    const first = await loadPastSeason(IDS);
    expect(first.failed).toBe(87);

    fetchPastSeason.mockResolvedValueOnce(result(420, 420));
    const second = await loadPastSeason(IDS);
    expect(fetchPastSeason).toHaveBeenCalledTimes(2);
    expect(second.failed).toBe(0);

    // And once it is whole, it stops asking.
    await loadPastSeason(IDS);
    expect(fetchPastSeason).toHaveBeenCalledTimes(2);
  });

  it("keeps showing the partial records while the retry is in flight", async () => {
    // Retrying must not blank the pitch. Everything already looked up stays
    // readable to the synchronous render path throughout.
    fetchPastSeason.mockResolvedValueOnce(result(333, 420));
    await loadPastSeason(IDS);
    expect(cachedPastSeason()?.size).toBe(333);

    let release: (v: PastSeasonFetch) => void = () => {};
    fetchPastSeason.mockReturnValueOnce(
      new Promise<PastSeasonFetch>((r) => {
        release = r;
      })
    );
    const pending = loadPastSeason(IDS);
    expect(cachedPastSeason()?.size).toBe(333);
    release(result(420, 420));
    await pending;
    expect(cachedPastSeason()?.size).toBe(420);
  });

  it("does not trade a fuller record for a thinner one", async () => {
    // A retry that goes WORSE — the user has gone offline between clicks — must
    // not throw away records already on screen. Without this the second result
    // overwrites unconditionally and the pitch loses 333 players' history to a
    // click that was meant to add to it.
    fetchPastSeason.mockResolvedValueOnce(result(333, 420));
    await loadPastSeason(IDS);
    fetchPastSeason.mockResolvedValueOnce(result(4, 420));
    await loadPastSeason(IDS);
    expect(cachedPastSeason()?.size).toBe(333);
  });

  it("shares one request between concurrent callers", async () => {
    // The dashboard and the drafter both want this on the same render.
    fetchPastSeason.mockResolvedValue(result(420, 420));
    const [a, b] = await Promise.all([loadPastSeason(IDS), loadPastSeason(IDS)]);
    expect(fetchPastSeason).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});

/*
 * ELEMENT IDS ARE NOT UNIQUE ACROSS FEEDS.
 *
 * The demo's three hundred players are ids 1..300, and so are three hundred
 * real footballers. The cache key was built from the pool size and its lowest
 * id, which both universes can easily agree on, so a session that looked at a
 * real team and then opened the demo could be handed real men's seasons — real
 * minutes, real xG, real starts — to project the demo's players with. Nothing
 * threw and nothing looked broken; the demo simply started quoting somebody
 * else's football.
 */
describe("the past-season cache keeps the two feeds apart", () => {
  beforeEach(() => {
    resetPastSeasonStore();
    fetchPastSeason.mockReset();
    currentFeed.mockReturnValue("real");
  });

  it("does not read a real season into the demo", async () => {
    fetchPastSeason.mockResolvedValue(result(420, 420));
    await loadPastSeason(IDS);
    expect(cachedPastSeason()?.size).toBe(420);
    expect(pastSeasonCoverage()).toEqual({ requested: 420, failed: 0 });

    // The reader opens /team/999999.
    currentFeed.mockReturnValue("demo");
    expect(cachedPastSeason()).toBeNull();
    expect(pastSeasonCoverage()).toBeNull();

    // And back again — his own records are still there, unfetched a second time.
    currentFeed.mockReturnValue("real");
    expect(cachedPastSeason()?.size).toBe(420);
    expect(fetchPastSeason).toHaveBeenCalledTimes(1);
  });

  it("fetches again for the other feed rather than reusing a same-shaped pool", async () => {
    // Identical pool size, identical lowest id — everything the old key looked
    // at. Only the feed differs, which is the whole of the difference.
    fetchPastSeason.mockResolvedValue(result(420, 420));
    await loadPastSeason(IDS);
    currentFeed.mockReturnValue("demo");
    await loadPastSeason(IDS);
    expect(fetchPastSeason).toHaveBeenCalledTimes(2);
  });

  it("does not hold the other feed's records over a thinner load of its own", async () => {
    // The "never trade a fuller record for a thinner one" rule, asked to
    // compare two universes. 420 real players beat 300 demo ones on size every
    // time, so the rule that exists to protect the pitch would have kept
    // repopulating it from the wrong feed.
    fetchPastSeason.mockResolvedValueOnce(result(420, 420));
    await loadPastSeason(IDS);

    currentFeed.mockReturnValue("demo");
    const demoIds = Array.from({ length: 300 }, (_, i) => i + 1);
    fetchPastSeason.mockResolvedValueOnce(result(300, 300));
    await loadPastSeason(demoIds);
    expect(cachedPastSeason()?.size).toBe(300);
  });

  it("does not show the previous feed's records while its own load is in flight", async () => {
    // The window that made this more than theoretical: the key of the load in
    // flight and the key of the records on hand were one variable, so for the
    // length of the fetch the store answered with the wrong universe.
    fetchPastSeason.mockResolvedValueOnce(result(420, 420));
    await loadPastSeason(IDS);

    currentFeed.mockReturnValue("demo");
    let release: (v: PastSeasonFetch) => void = () => {};
    fetchPastSeason.mockReturnValueOnce(
      new Promise<PastSeasonFetch>((r) => {
        release = r;
      })
    );
    const pending = loadPastSeason(IDS);
    expect(cachedPastSeason()).toBeNull();
    release(result(420, 420));
    await pending;
    expect(cachedPastSeason()?.size).toBe(420);
  });
});

/*
 * NOTHING HERE CANCELS.
 *
 * `fetchPastSeason` accepts an `AbortSignal` and no caller passes one, so
 * switching entry — or feed — leaves four hundred requests running alongside
 * the four hundred that replaced them, and they land in whatever order the
 * network chooses. Every rule in this store is written as if loads finish in
 * the order they started. These are the cases where they do not.
 */
describe("a load that has been overtaken does not get to write", () => {
  beforeEach(() => {
    resetPastSeasonStore();
    fetchPastSeason.mockReset();
    currentFeed.mockReturnValue("real");
  });

  /** A fetch whose settling this test controls. */
  function deferred() {
    let release: (v: PastSeasonFetch) => void = () => {};
    fetchPastSeason.mockReturnValueOnce(
      new Promise<PastSeasonFetch>((r) => {
        release = r;
      })
    );
    return { release: (v: PastSeasonFetch) => release(v) };
  }

  it("does not let a stale feed's late arrival evict the current one", async () => {
    // The real load is still in the air when the reader opens the demo. The
    // demo's own records arrive and are correct — and then the slow real load
    // lands. It cannot be shown (the feed prefix sees to that), but it used to
    // overwrite anyway, leaving the demo with nothing at all and no second load
    // coming, because as far as the store was concerned it had already asked.
    const real = deferred();
    const realLoad = loadPastSeason(IDS);

    currentFeed.mockReturnValue("demo");
    const demoIds = Array.from({ length: 300 }, (_, i) => i + 1);
    fetchPastSeason.mockResolvedValueOnce(result(300, 300));
    await loadPastSeason(demoIds);
    expect(cachedPastSeason()?.size).toBe(300);

    real.release(result(420, 420));
    await realLoad;
    expect(cachedPastSeason()?.size).toBe(300);
  });

  it("does not blank an in-flight load when an older one settles under the same key", async () => {
    // Two loads can share a key without being the same load. Clearing
    // `inflight` on a key match therefore lets the first settle and cancel the
    // third — after which the next caller finds nothing in flight and pays for
    // a fourth fetch of four hundred players, and so does the one after that.
    const first = deferred();
    const firstLoad = loadPastSeason(IDS);

    currentFeed.mockReturnValue("demo");
    fetchPastSeason.mockResolvedValueOnce(result(300, 300));
    await loadPastSeason(Array.from({ length: 300 }, (_, i) => i + 1));

    currentFeed.mockReturnValue("real");
    const third = deferred();
    const thirdLoad = loadPastSeason(IDS);

    // Partial, so it cannot be answered from the cache and the question of
    // what is in flight is the only thing deciding the next caller's fate.
    first.release(result(333, 420));
    await firstLoad;

    // Same key, load still running: this must join it, not start a fourth.
    const joined = loadPastSeason(IDS);
    expect(fetchPastSeason).toHaveBeenCalledTimes(3);
    expect(joined).toBe(thirdLoad);
    third.release(result(420, 420));
    await joined;
    expect(cachedPastSeason()?.size).toBe(420);
  });

  it("does not seed the next test from a fetch left in the air", async () => {
    // `resetPastSeasonStore` is the only isolation this module has. It nulled
    // four variables and left the pending `.then` holding its key, so any test
    // that forgot to settle its deferred would quietly fill the NEXT test's
    // cache from `beforeEach`, and the failure would land on innocent code.
    const stale = deferred();
    const staleLoad = loadPastSeason(IDS);
    resetPastSeasonStore();
    stale.release(result(420, 420));
    await staleLoad;
    expect(cachedPastSeason()).toBeNull();
    expect(pastSeasonCoverage()).toBeNull();
  });

  it("leaves nothing behind when the fetch fails", async () => {
    fetchPastSeason.mockRejectedValueOnce(new Error("offline"));
    await expect(loadPastSeason(IDS)).rejects.toThrow("offline");
    expect(cachedPastSeason()).toBeNull();

    // And the next attempt is a real one, not a replay of the failure.
    fetchPastSeason.mockResolvedValueOnce(result(420, 420));
    await loadPastSeason(IDS);
    expect(cachedPastSeason()?.size).toBe(420);
    expect(fetchPastSeason).toHaveBeenCalledTimes(2);
  });
});

describe("the store says when its records move", () => {
  beforeEach(() => {
    resetPastSeasonStore();
    fetchPastSeason.mockReset();
    currentFeed.mockReturnValue("real");
  });

  it("notifies on every change, not just the first", async () => {
    // The dashboard used to bump its own counter, once, straight after its own
    // load. Every other way the cache can fill — a partial load later completed,
    // or the drafter succeeding where the dashboard failed — left the pitch
    // projecting without last season while the squad beside it used it.
    const seen: string[] = [];
    const off = subscribePastSeason(() => seen.push(pastSeasonVersion()));

    fetchPastSeason.mockResolvedValueOnce(result(333, 420));
    await loadPastSeason(IDS);
    fetchPastSeason.mockResolvedValueOnce(result(420, 420));
    await loadPastSeason(IDS);

    expect(seen.length).toBe(2);
    expect(seen[1]).not.toBe(seen[0]);

    off();
    fetchPastSeason.mockResolvedValueOnce(result(420, 420));
    resetPastSeasonStore();
    await loadPastSeason(IDS);
    expect(seen.length).toBe(2);
  });

  it("tells its listeners when it is emptied, not just when it is filled", async () => {
    // `resetPastSeasonStore` bumped the version and told nobody. No production
    // caller resets, so it cost nothing — but a store whose contract holds only
    // on the paths someone checked is a store nobody can reason about.
    fetchPastSeason.mockResolvedValueOnce(result(420, 420));
    await loadPastSeason(IDS);
    const seen: string[] = [];
    const off = subscribePastSeason(() => seen.push(pastSeasonVersion()));
    resetPastSeasonStore();
    expect(seen.length).toBe(1);
    expect(cachedPastSeason()).toBeNull();
    off();
  });

  it("changes its snapshot when the feed changes under it", async () => {
    /*
     * The snapshot describes what `cachedPastSeason()` will answer, and that
     * answer depends on the feed as well as on the records — a real-feed map is
     * invisible to the demo and vice versa. `setDemoMode` lives in `fpl.ts` and
     * cannot notify this store (the import would be a cycle), so a bare counter
     * stood still across the switch while the value it claimed to describe went
     * from a full map to null, and any consumer keying on it kept a projection
     * built from the other universe's players.
     */
    fetchPastSeason.mockResolvedValueOnce(result(420, 420));
    await loadPastSeason(IDS);
    const real = pastSeasonVersion();
    expect(cachedPastSeason()?.size).toBe(420);

    currentFeed.mockReturnValue("demo");
    expect(pastSeasonVersion()).not.toBe(real);
    expect(cachedPastSeason()).toBeNull();

    currentFeed.mockReturnValue("real");
    expect(pastSeasonVersion()).toBe(real);
  });

  it("stays quiet when a result is rejected as thinner", async () => {
    fetchPastSeason.mockResolvedValueOnce(result(333, 420));
    await loadPastSeason(IDS);
    const before = pastSeasonVersion();
    fetchPastSeason.mockResolvedValueOnce(result(4, 420));
    await loadPastSeason(IDS);
    expect(pastSeasonVersion()).toBe(before);
    expect(cachedPastSeason()?.size).toBe(333);
  });
});
