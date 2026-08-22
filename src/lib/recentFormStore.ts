/**
 * The recent line-up form the app has fetched, held where every consumer can
 * see it.
 *
 * WHY THIS EXISTS, WHICH IS THE SAME REASON `pastSeasonStore` DOES. The Stats
 * table and the Optimize panel were quoting different five-gameweek xP for the
 * same player in one page load — WHU Keeper 1 at 13.8 on one tab and 14.5 on
 * the other, with nothing on either screen to distinguish them, on a player the
 * transfer plan was recommending selling. `StatsTable`'s header says that
 * "two projections, one player" defect was closed by handing it the Dashboard's
 * `xpOf`; it was not, it was moved. `xpOf` projects without `recentForm` while
 * `OptimizePanel` fetches line-ups and projects with it, so the two agree on
 * every player whose recent starts match the model's prior and disagree on the
 * rest — which is precisely the population recent form exists to correct.
 *
 * `OptimizePanel` held the map in component state, so nothing outside it could
 * read it. Holding it here lets the Dashboard's projection pick it up the
 * moment it lands, the same way `pastSeasonStore` already works, and the two
 * numbers become one number.
 *
 * NOT A CACHE OF THE TRANSPORT. `fetchRecentForm` already dedupes its round
 * trips through `fetchSummaries`; what is held here is the reduced result, so
 * that a consumer which never asked for it can still use what somebody else's
 * request produced.
 */
import { currentFeed } from "./fpl";
import type { RecentForm } from "./types";

let cached: Map<number, RecentForm> | null = null;
let cachedFeed: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

/**
 * A snapshot that changes exactly when `cachedRecentForm()` changes.
 *
 * The feed is part of it for the same reason it is part of
 * `pastSeasonVersion`: element ids are not unique across feeds, `setDemoMode`
 * lives in `fpl.ts` and cannot notify this module without a cycle, and a bare
 * counter would stand still across a switch while the value went stale.
 */
export function recentFormVersion(): string {
  return `${currentFeed()}|${version}`;
}

export function subscribeRecentForm(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** What has been fetched, or null under a different feed or before any fetch. */
export function cachedRecentForm(): Map<number, RecentForm> | null {
  return cachedFeed === currentFeed() ? cached : null;
}

/**
 * Record a fetched map.
 *
 * MERGES RATHER THAN REPLACES, because two callers ask for different sets: the
 * Optimize panel wants the squad plus the top fifteen per position, and a
 * future caller may want fewer. Replacing would let a narrower request delete
 * records a wider one had already paid for — the same mistake
 * `pastSeasonStore` documents at length and guards against.
 */
export function setRecentForm(map: Map<number, RecentForm>, feed: string): void {
  /*
   * `feed` IS THE FEED THE DATA CAME FROM, AND THE CALLER HAS TO SAY.
   *
   * This used to stamp `currentFeed()` at WRITE time, which is a different
   * feed from the one the fetch ran under whenever the reader navigates
   * mid-flight. `fetchRecentForm` is hundreds of element-summary round trips
   * with no abort signal, and `setDemoMode` flips synchronously on navigation
   * (`src/app/page.tsx`), so: press Optimize on `/team/N`, open the demo while
   * it runs, and the load lands to find `cachedFeed !== "demo"`, clears, stamps
   * itself "demo" and files real footballers' start shares under demo ids.
   * `Dashboard` then reads them straight into its projection through
   * `cachedRecentForm()`.
   *
   * Reproduced directly: `setDemoMode(false)`, build a map, `setDemoMode(true)`,
   * `setRecentForm(map)` — and `cachedRecentForm()` under the demo returned
   * `{42 => {startShare: 1, minsPerGame: 90}}` for a player it had never
   * fetched. The read path was feed-gated from the start; the WRITE path was
   * the hole, and the module's own header claims it works "the way
   * `pastSeasonStore` already does", which records its key at commit time.
   *
   * A load overtaken by a feed switch is therefore dropped rather than filed
   * under whatever is current now. That is the same conclusion
   * `pastSeasonStore`'s `loadSeq` reaches for a superseded load.
   */
  if (feed !== currentFeed()) return;
  if (cachedFeed !== feed) {
    cached = null;
    cachedFeed = feed;
  }
  const next = new Map(cached ?? []);
  for (const [id, v] of map) next.set(id, v);
  cached = next;
  version++;
  for (const cb of [...listeners]) cb();
}

/** Drop everything. For tests, and for a feed switch that wants to be explicit. */
export function resetRecentForm(): void {
  cached = null;
  cachedFeed = null;
  version++;
  for (const cb of [...listeners]) cb();
}
