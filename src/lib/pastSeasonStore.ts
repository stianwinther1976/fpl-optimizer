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

import { currentFeed, fetchPastSeason, type PastSeasonFetch } from "./fpl";
import type { PastSeasonStats } from "./types";

let inflight: Promise<PastSeasonFetch> | null = null;
let cached: PastSeasonFetch | null = null;
/** Key of the load in flight — or, if none is, of the last one requested. */
let cachedIds: string | null = null;
/*
 * Serial number of the most recently STARTED load. A key cannot do this job:
 * keys repeat. Switch feed and switch back, or let the pool shrink and grow
 * again, and the load that has just been overtaken is carrying the same key as
 * the one that overtook it — so the "is this still mine?" test below waved it
 * through, and the size comparison after it could let a stale answer beat the
 * fresher one it was supposed to be superseded by. Nothing cancels (no caller
 * passes an `AbortSignal`), so those four hundred requests really do land.
 */
let loadSeq = 0;
/*
 * Key of the records actually SITTING IN `cached`, which is not the same thing.
 * `cachedIds` moves the moment a new load starts; the records it describes do
 * not arrive until that load lands. One variable was doing both jobs, so during
 * every in-flight load the store claimed the old records belonged to the new
 * key — and once the two keys could name different FEEDS, that window was long
 * enough to serve a whole real-football season to the demo, and to let the
 * "never trade a fuller record for a thinner one" rule below prefer a 420-man
 * real result over the 300-man demo one that had just replaced it.
 */
let cachedKey: string | null = null;
/*
 * Bumped every time `cached` changes. React has no way to see module state
 * move, so every consumer had invented its own signal for "the record has
 * landed" — the dashboard a `pastReady` counter bumped in exactly one place,
 * the stats table nothing at all. A counter bumped in one place is only right
 * if the cache changes in one place, and it does not: a partial load followed
 * by a full one, or a failed dashboard load followed by a successful drafter
 * one, both change it with nobody watching. Then the pitch shows a projection
 * built without last season while the drafter beside it used it — the very
 * split this store exists to close, one level up.
 */
let version = 0;
const listeners = new Set<() => void>();

/**
 * A snapshot of what `cachedPastSeason()` will answer. It changes whenever that
 * answer changes, and it is safe both as a React dependency and as a
 * `useSyncExternalStore` snapshot — same value in, `Object.is`-equal out, no
 * allocation the caller can tell apart.
 *
 * THE FEED IS PART OF IT, and a bare counter was wrong to leave it out.
 * `cachedPastSeason` returns null for records fetched under a different feed
 * (`cacheIsCurrentFeed`), and the feed is flipped by `setDemoMode` in `fpl.ts`,
 * which is outside this module and cannot notify it — an import the other way
 * would be a cycle. So the counter could stand still across a demo/real switch
 * while the value it claims to describe went from a full map to null. Folding
 * the feed into the snapshot means any render that happens after the switch —
 * and one always does, because switching feed reloads the team — reads a
 * different snapshot and recomputes. Nothing has to be notified for the value
 * to be right; it only has to be looked at.
 */
export function pastSeasonVersion(): string {
  return `${currentFeed()}|${version}`;
}

/** Call back whenever the held records change. Returns an unsubscribe. */
export function subscribePastSeason(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function commit(r: PastSeasonFetch, key: string): void {
  cached = r;
  cachedKey = key;
  version++;
  for (const cb of [...listeners]) cb();
}

/*
 * THE FEED IS PART OF THE KEY, because element ids are not unique across feeds.
 *
 * The key was `${ids.length}:${lowestId}` and nothing else. Demo players are
 * ids 1..300; so are three hundred real footballers. A visitor who looked at
 * their own team and then opened `/team/999999` was one matching pool size away
 * from having real men's last-season records — real minutes, real xG, real
 * starts — handed to the demo's projection under the demo's names, and the
 * demo's whole point is that every number in it can be traced back to a match
 * it played. Nothing crashed and nothing looked wrong; the demo simply began
 * quoting somebody else's season.
 *
 * The feed is not threaded through the callers on purpose. A parameter is a
 * promise each call site has to keep, and the two that read this store
 * synchronously had already failed to keep the equivalent one — the dashboard
 * gated the LOAD on `!demo` and left the READ ungated, which is exactly the
 * leak. `currentFeed()` is the same switch `get()` uses to choose the URL, so
 * the cache cannot disagree with the feed the rows came from.
 */
const keyOf = (ids: number[]) =>
  `${currentFeed()}|${ids.length}:${[...ids].sort((a, b) => a - b)[0] ?? 0}`;

/** Were the records in `cached` taken from the feed the app is reading now? */
const cacheIsCurrentFeed = () => cachedKey != null && cachedKey.startsWith(`${currentFeed()}|`);

/**
 * Whatever has already been loaded FOR THE CURRENT FEED, or null. Synchronous,
 * for render paths that must not block — they simply project without it until
 * the load lands.
 */
export function cachedPastSeason(): Map<number, PastSeasonStats> | null {
  if (!cacheIsCurrentFeed()) return null;
  return cached && cached.data.size > 0 ? cached.data : null;
}

/** Coverage of the last completed load, for surfacing a gap to the user. */
export function pastSeasonCoverage(): { requested: number; failed: number } | null {
  if (!cacheIsCurrentFeed()) return null;
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
  if (cached && cachedKey === key && cached.failed === 0) return Promise.resolve(cached);
  if (inflight && cachedIds === key) return inflight;
  cachedIds = key;
  const seq = ++loadSeq;
  const p: Promise<PastSeasonFetch> = fetchPastSeason(ids, 10, onProgress)
    .then((r) => {
      /*
       * A SUPERSEDED LOAD DOES NOT GET TO WRITE.
       *
       * Nothing here cancels: `fetchPastSeason` takes an `AbortSignal` and no
       * caller passes one, so switching entry — or feed — leaves the previous
       * four hundred requests running alongside the new ones, and they land in
       * whatever order the network feels like. The earlier load landing LAST
       * used to win, because the "fuller vs thinner" test below compares
       * `cachedKey` and a stale key never matches, so `keep` was forced false
       * and the old universe's records were written over the new one's. The
       * feed prefix then correctly refused to show them — leaving the demo with
       * nothing at all and no second load coming.
       *
       * `loadSeq` names the load that started most recently, so this is the one
       * test that distinguishes "mine" from "overtaken". It was `cachedIds !==
       * key`, which is the same idea addressed to the wrong identity: two
       * different loads can share a key (K1 → K2 → K1, which is what a
       * demo/real/demo round trip is), and then the first K1 settles, finds its
       * own key still parked in `cachedIds`, and commits over the third. A
       * serial number cannot repeat, so it cannot be mistaken for a successor.
       * It also makes `resetPastSeasonStore` real: reset bumps the counter, so a
       * fetch still in the air when a test tears down can no longer seed the
       * next test.
       */
      if (seq !== loadSeq) return r;
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
      // "Fuller" is only a comparison between two answers to the SAME question.
      // The guard is on `cachedKey` — the key the held records were fetched
      // under — not on `cachedIds`, which by now names this load. Compared
      // against the wrong key, 420 real players beat 300 demo ones and the
      // rule that exists to protect the pitch quietly repopulated it from the
      // other universe.
      const keep = cached !== null && cachedKey === key && cached.data.size > r.data.size;
      if (!keep) commit(r, key);
      return r;
    })
    .finally(() => {
      // Only if it is still MINE — and identity is the only thing that says so.
      // This compared KEYS, which two different loads can share: a load for the
      // demo starts and finishes while a load for the real feed is in the air,
      // the reader switches back, a third load starts under the first one's
      // key — and then the first one settles and blanks the third, which is
      // still running. The next caller finds no in-flight promise and pays for
      // a fourth fetch of four hundred players.
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/** Test seam: forget everything loaded so far. */
export function resetPastSeasonStore(): void {
  inflight = null;
  cached = null;
  cachedIds = null;
  cachedKey = null;
  // A load already in the air is now nobody's, which is what "forget
  // everything" has to mean if it is going to hold between tests.
  loadSeq++;
  // Bumping the version without telling the listeners was a half-measure that
  // read like a whole one: `subscribePastSeason` promises a callback whenever
  // the held records change, and this changes them to nothing. No production
  // caller resets, so it cost nothing — but a contract that is honoured only on
  // the paths someone happened to check is not a contract.
  version++;
  for (const cb of [...listeners]) cb();
}
