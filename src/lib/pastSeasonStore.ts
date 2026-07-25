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
  if (cached && cachedIds === key) return Promise.resolve(cached);
  if (inflight && cachedIds === key) return inflight;
  cachedIds = key;
  inflight = fetchPastSeason(ids, 10, onProgress)
    .then((r) => {
      cached = r;
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
