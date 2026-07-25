// The shared cache for last season's per-player record.
//
// One HTTP request per player makes this the most expensive thing the app does,
// so it is cached hard — and caching hard is exactly what made it lie. These
// tests pin the difference between "we already have this" and "we already tried
// this and it went badly", which are not the same claim.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PastSeasonFetch } from "../fpl";

const fetchPastSeason = vi.hoisted(() => vi.fn());
vi.mock("../fpl", () => ({ fetchPastSeason }));

const { loadPastSeason, cachedPastSeason, resetPastSeasonStore } = await import(
  "../pastSeasonStore"
);

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
