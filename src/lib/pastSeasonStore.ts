// One shared copy of last season's per-player record, for the whole app.
//
// This exists because the same player was being given two different scores in
// two places. The launch drafter fetched `history_past` and projected with it;
// the dashboard's pitch view and the calibration snapshot did not, and so ran a
// model with no idea who had actually started last season. Pre-season that is
// not a rounding difference — it is the entire signal. Worse, calibration was
// grading predictions the shipped drafter never made, so it was learning a
// correction for a model nobody used.
//
// The fetch is one HTTP request per player, so it is also the most expensive
// thing the app does. Caching it here means it happens once per session
// regardless of how many components want it.

import { fetchPastSeason, type PastSeasonFetch } from "./fpl";
import type { PastSeasonStats } from "./types";

let inflight: Promise<PastSeasonFetch> | null = null;
let cached: PastSeasonFetch | null = null;
let cachedIds: string | null = null;

const keyOf = (ids: number[]) => `${ids.length}:${[...ids].sort((a, b) => a - b)[0] ?? 0}`;

/**
 * Whatever has already been loaded, or null. Synchronous, for render paths that
 * must not block — they simply project without it until the load lands.
 */
export function cachedPastSeason(): Map<number, PastSeasonStats> | null {
  return cached && cached.data.size > 0 ? cached.data : null;
}

/** Coverage of the last completed load, for surfacing a gap to the user. */
export function pastSeasonCoverage(): { requested: number; failed: number } | null {
  return cached ? { requested: cached.requested, failed: cached.failed } : null;
}

/**
 * Load (once) the past-season record for `ids`. Concurrent callers share the
 * same request; a second call with the same id set returns the cached result.
 */
export function loadPastSeason(
  ids: number[],
  onProgress?: (done: number, total: number) => void
): Promise<PastSeasonFetch> {
  const key = keyOf(ids);
  // A COMPLETE result is cached and reused; a partial one is kept for rendering
  // but not treated as final.
  //
  // It used to be cached unconditionally, which made the drafter's "Re-draft to
  // try them again" message a lie: re-drafting recomputes the same pool, so the
  // same key hits the cache and returns the identical failure count without
  // issuing a single request. The user could press it forever and keep the same
  // price-prior squad until they reloaded the page. Both retries inside
  // `fetchPastSeason` are already spent by the time a player lands in `failed`,
  // so those lookups are genuinely gone until something asks again — and asking
  // again is exactly what the button claims to do.
  //
  // This is worth more now than it was: the pool doubled to 420, so a rate-limit
  // that used to clip a handful of requests has twice as much to clip.
  if (cached && cachedIds === key && cached.failed === 0) return Promise.resolve(cached);
  if (inflight && cachedIds === key) return inflight;
  cachedIds = key;
  inflight = fetchPastSeason(ids, 10, onProgress)
    .then((r) => {
      // Never trade a fuller result for a thinner one: a retry that goes worse
      // (offline, say) must not blank out records already on screen. On an exact
      // tie the newer result wins, which is unobservable — equal `data.size`
      // against an equal `requested` means an equal `failed` — and `>=` here is
      // a surviving equivalent mutant rather than a gap in the tests.
      //
      // Still missing, and worth naming: `fetchPastSeason` takes an
      // `AbortSignal` and nothing passes one. Changing entry id mid-fetch leaves
      // the previous 420 requests running alongside the new ones. Doubling the
      // pool doubled that window without making the plumbing any better.
      cached = cached && cachedIds === key && cached.data.size > r.data.size ? cached : r;
      return r;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test seam: forget everything loaded so far. */
export function resetPastSeasonStore(): void {
  inflight = null;
  cached = null;
  cachedIds = null;
}
