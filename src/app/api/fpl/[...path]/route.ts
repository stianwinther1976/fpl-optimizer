// Proxy for the official FPL API. Required because fantasy.premierleague.com
// sends no CORS headers, so the browser can never call it directly.

import { NextRequest, NextResponse } from "next/server";

const FPL_BASE = process.env.FPL_API_BASE ?? "https://fantasy.premierleague.com/api";

/** How long to wait on FPL before giving up. See the note at the fetch below. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * A deadline the fetch cannot opt out of.
 *
 * `AbortSignal.timeout` DOES NOT ALWAYS SURVIVE. Next patches `fetch` and, when
 * it is REVALIDATING a stale Data Cache entry, strips the caller's signal —
 * `next/dist/server/lib/patch-fetch.js`: "don't pass through signal when
 * revalidating", `...isStale ? [] : ['signal']`. That mattered while every path
 * here went through the Data Cache; the upstream fetch is `no-store` now, so
 * nothing is ever revalidating and the signal binds every request. This
 * paragraph is kept because it is why the deadline below exists at all, and
 * because it is what a future `next: { revalidate }` would silently reinstate.
 *
 * AN EARLIER VERSION OF THIS COMMENT DREW THE OPPOSITE CONCLUSION FROM A
 * MEASUREMENT THAT WAS ITSELF CORRECT. It read:
 *
 *   entry stale, hung upstream ....... 200 at 0.04 s, the stale body
 *
 * and concluded that the background refresh "cannot hold the response open".
 * Both halves of that row reproduce — re-measured on the pre-fix build, the
 * status line and the complete stale body arrive at 6.5 ms. What the row does
 * not say is that the response is never TERMINATED: the transfer is chunked and
 * the zero-length terminating chunk never arrives, so the connection was still
 * open at 120 s and `fetch().json()` in a browser never resolves. A correction
 * in an earlier commit called the figure unreproducible, which was itself
 * wrong; the figure was right and the reading of it was not.
 *
 * Re-measured from a clean `git archive HEAD` export, production build, with
 * `FPL_API_BASE` pointed at a stub that accepts the connection and never
 * answers — prime `fixtures/` (ttl 25 s), wait 28 s, flip the stub to hang,
 * request again:
 *
 *   cold miss, hung upstream ......... 502 at 10.01 s (the deadline fires)
 *   entry stale, hung upstream ....... headers at 6.5 ms, never terminated,
 *                                      still open at 120 s
 *
 * Next awaits it. `withExecuteRevalidates` in
 * `next/dist/server/revalidation-utils.js` wraps the route handler and, in its
 * `finally`, awaits every revalidate registered during the request — including
 * the background refresh whose signal `patch-fetch` has just stripped. So the
 * one path where the deadline was believed not to matter was the one path with
 * no bound on it at all, and a reader whose entry had gone stale waited on FPL
 * for as long as the platform allowed.
 *
 * Hence `cache: "no-store"` at the fetch below: no Data Cache entry means no
 * revalidation to register, so both belts bind on every request. Measured on
 * the same harness, `no-store` build:
 *
 *   would-be-stale entry, hung upstream ... 502 at 10.01 s
 *   cold miss, hung upstream .............. 502 at 10.01 s
 *
 * The signal still earns its place: it closes the socket, which racing a timer
 * cannot do.
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("upstream timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Only allow known endpoint shapes — never a blind open proxy.
/*
 * `\d{1,10}` RATHER THAN `\d+`, so the key space is finite.
 *
 * Every distinct id is a distinct cache key at the edge and a distinct upstream
 * fetch, and unbounded digits make that space infinite: 200 concurrent
 * `element-summary/{n}` requests produced 200 upstream fetches with nothing
 * absorbing any of them. Ten digits is past every real FPL id (entries are in
 * the tens of millions, elements in the hundreds) and it costs nothing.
 */
const ID = "\\d{1,10}";
/** Exported so the allowlist can be asserted directly — see `route.test.ts`. */
export const ALLOWED: RegExp[] = [
  /^bootstrap-static\/$/,
  /^fixtures\/$/,
  new RegExp(`^entry/${ID}/$`),
  new RegExp(`^entry/${ID}/event/${ID}/picks/$`),
  new RegExp(`^entry/${ID}/history/$`),
  new RegExp(`^entry/${ID}/transfers/$`),
  new RegExp(`^element-summary/${ID}/$`),
  new RegExp(`^event/${ID}/live/$`),
  new RegExp(`^leagues-classic/${ID}/standings/$`),
];

// Cache lifetime (seconds) per endpoint type.
export function cacheSeconds(path: string): number {
  if (path.startsWith("bootstrap-static")) return 300;
  // Fixtures and live scores drive the in-play view (30s UI poll) — keep fresh.
  if (path.startsWith("fixtures")) return 25;
  if (path.includes("/live/")) return 25;
  if (path.includes("/history/") || path.includes("/transfers/")) return 300;
  // An element summary changes when a gameweek's results land and not otherwise
  // — the same volatility as the entry history above, and it was getting the
  // catch-all 120 for no reason beyond nobody having named it.
  if (path.startsWith("element-summary")) return 300;
  return 120;
}

/**
 * How long a stale answer may still be served while its refresh runs behind it.
 *
 * Every other endpoint here is fetched once per reader, so a cold miss costs
 * that reader one round trip. `element-summary` is fetched once per PLAYER —
 * the launch pool is the whole field — so a cold miss is not one round trip but
 * hundreds arriving together, against an API that rate-limits and whose refusals
 * degrade the model to a price prior. That asymmetry, not the data's freshness,
 * is what sets this: a summary is allowed to be served stale for as long as a
 * day, because the thing it could be stale ABOUT happens weekly, and the refresh
 * is already on its way to the next reader.
 */
export function staleSeconds(path: string): number {
  if (path.startsWith("element-summary")) return 86_400;
  return cacheSeconds(path) * 2;
}

/**
 * The whole `Cache-Control` header, built in one place so it can be tested.
 *
 * `max-age=0` IS LOAD-BEARING AND WAS MISSING. `s-maxage` binds shared caches
 * only; with `public` and no `max-age` a browser has been given no freshness
 * lifetime at all and falls back to HEURISTIC caching, picking its own — and
 * iOS Safari picks generously. The 30-second live poll was then answered out of
 * the phone's own store for minutes at a time, while `updatedAt` was stamped
 * "now" on every one of those hits: the app reported refreshing and had not.
 * Reported from a live match, and measured — the clock sat on 83' while FPL had
 * moved to 89'.
 *
 * Three attempts at the browser half got it wrong before it settled; the
 * history is in the note on `cacheControl`, and it is worth reading before
 * touching this again.
 */
export function cacheControl(path: string): string {
  /*
   * THE BROWSER'S HEADER. Three attempts got this wrong before it settled, and
   * the history is the useful part:
   *
   *  1. `public, s-maxage=N, stale-while-revalidate=M` — `s-maxage` binds
   *     SHARED caches only, so the browser had no freshness lifetime at all,
   *     fell back to heuristic caching and picked its own. iOS Safari picked
   *     minutes: the 30-second live poll was answered from the phone's own
   *     store while `updatedAt` was stamped "now" on every hit, so the clock
   *     sat on 83' while FPL had moved to 89'.
   *  2. `max-age=0` — did not finish the job, because `stale-while-revalidate`
   *     binds private caches too (Chrome, since M75), so `bootstrap-static/`
   *     could still be served ten minutes stale.
   *  3. `proxy-revalidate` — RFC 9111 §5.2.2.9 says it means `must-revalidate`
   *     "except that it does not apply to private caches". Exactly backwards:
   *     silent to the browser, and it forbade the CDN to serve stale.
   *
   * `no-cache` is the correct directive for the BROWSER: no reuse without
   * revalidation, no SWR loophole. It is unqualified, so by §5.2.2.4 it binds
   * shared caches as well — which is why the CDN gets its own header below
   * rather than relying on `s-maxage` surviving alongside it. `s-maxage`
   * overrides `max-age`/`Expires` (§5.2.2.10); it does not override `no-cache`.
   */
  return `public, no-cache, s-maxage=${cacheSeconds(path)}, stale-while-revalidate=${staleSeconds(path)}`;
}

/**
 * THE CDN'S HEADER, stated separately because the two layers want opposite
 * things and one header cannot say both.
 *
 * The reader's browser must never reuse a live feed without asking. The edge
 * must reuse aggressively, because a launch draft is ~420 element-summary
 * fetches and `staleSeconds` gives them a day of grace precisely so they do not
 * arrive at FPL's rate-limited API together.
 *
 * `CDN-Cache-Control` (RFC 9213 targeted caching) is how that is expressed:
 * a CDN that understands it uses this and ignores `Cache-Control`, and one that
 * does not falls back to `Cache-Control` — where `no-cache` makes it
 * revalidate. That fallback is the conservative direction: more origin
 * requests, never staler data.
 *
 * WHAT ABSORBS THOSE ORIGIN REQUESTS is no longer Next. This used to read "the
 * origin is not FPL in that case, because the upstream fetch below is itself
 * cached by Next for `ttl`", and that stopped being true the moment the
 * upstream fetch became `no-store`. For the live feeds it is now simply false
 * and accepted: they are small, they are asked for once every thirty seconds,
 * and answering "Refresh now" from a copy up to 25 seconds old is a defect the
 * owner has already reported. For `element-summary/`, where one reader
 * generates ~420 requests, `responseCache` above is what stands in the way —
 * see its note for why that path and no other.
 *
 * WHAT IS VERIFIED, AND WHAT IS NOT. Both headers were read off a real 200
 * from a local dev server (`FPL_API_BASE` pointed at `/api/demo`), so Next
 * emits them side by side and rewrites neither:
 *
 *     /api/fpl/fixtures         cache-control: public, no-cache, s-maxage=25,  stale-while-revalidate=50
 *                           cdn-cache-control: public,           s-maxage=25,  stale-while-revalidate=50
 *     /api/fpl/element-summary/1  cache-control: public, no-cache, s-maxage=300, stale-while-revalidate=86400
 *                           cdn-cache-control: public,           s-maxage=300, stale-while-revalidate=86400
 *
 * What that does NOT establish is the half that lives at the edge: this sandbox
 * cannot reach Vercel's or the RFC's documentation, so the RFC semantics above
 * are read from memory and Vercel's handling of `CDN-Cache-Control` is not
 * confirmed. Given three wrong attempts at the header beside it, treat that as
 * a claim to check rather than a fact — the deployed site's actual behaviour is
 * one `curl -I` away.
 */
export function cdnCacheControl(path: string): string {
  return `public, s-maxage=${cacheSeconds(path)}, stale-while-revalidate=${staleSeconds(path)}`;
}

/** What one upstream read produced, reduced so it can be shared between callers. */
type Upstream =
  | { kind: "ok"; data: unknown }
  | { kind: "error"; status: number; message: string };

/**
 * Reads in flight, keyed by upstream URL.
 *
 * WITH THE DATA CACHE GONE, NOTHING ELSE ABSORBS A BURST. The note on `ID`
 * above records 200 concurrent `element-summary/{n}` requests producing 200
 * upstream fetches; those are 200 distinct URLs and no cache would have merged
 * them, but a launch draft also has many readers asking for the SAME path at
 * the same moment, and `revalidate` used to fold those together. This is the
 * part of that worth keeping, and the only part that cannot hang: an entry
 * lives exactly as long as the fetch it names.
 *
 * A second caller joins the FIRST caller's deadline, which started earlier, so
 * it can see a failure sooner than ten seconds. That is the honest trade — it
 * is one request, not two, and it is bounded either way.
 *
 * Response caching itself is now entirely at the edge. That is where this file
 * already said the real cache lives: see `cdnCacheControl`, whose
 * `stale-while-revalidate` is what serves a reader while the origin is failing
 * — and unlike Next's, it does it without holding anyone's response open.
 */
const inflight = new Map<string, Promise<Upstream>>();

async function readUpstream(url: string): Promise<Upstream> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "fpl-optimizer (personal, non-commercial)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    redirect: "error",
    /*
     * NO DATA CACHE. See `withDeadline`: an entry Next considers stale is
     * refreshed inside the request, with the caller's signal stripped, and the
     * route module awaits that refresh before answering. Measured at 120
     * seconds and still going against a hung upstream. Opting out of the cache
     * is what makes the ten-second deadline true on every path.
     */
    cache: "no-store",
  });
  if (!res.ok) {
    // FPL returns 503/maintenance pages while the game updates.
    const status = res.status === 404 ? 404 : 503;
    return {
      kind: "error",
      status,
      message: status === 404 ? "Not found" : "FPL is updating the game",
    };
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { kind: "error", status: 503, message: "FPL is updating the game" };
  }
  // Inside the deadline on purpose: `fetch` resolving only means the HEADERS
  // arrived, so an upstream that sends them and then stalls the body would
  // otherwise be unbounded again — the same defect one layer down.
  return { kind: "ok", data: await res.json() };
}

/** One bounded read per URL at a time. */
export function fetchUpstream(url: string): Promise<Upstream> {
  const running = inflight.get(url);
  if (running) return running;
  const p = withDeadline(readUpstream(url), UPSTREAM_TIMEOUT_MS).finally(() => {
    inflight.delete(url);
  });
  inflight.set(url, p);
  return p;
}

/** Test-only: the number of reads currently in flight. */
export function inflightSize(): number {
  return inflight.size;
}

/**
 * A bounded origin-side memo, for element summaries and nothing else.
 *
 * DROPPING THE DATA CACHE TOOK THIS AWAY, and the comment on `cdnCacheControl`
 * below still claimed it was there ("the origin is not FPL in that case,
 * because the upstream fetch below is itself cached by Next"). Measured on a
 * production build, two readers asking for the same fifty summaries back to
 * back: 50 upstream fetches then 0 with the Data Cache, 50 then 50 without it.
 * A launch draft is ~420 summaries per reader, and `route.test.ts` and
 * CLAUDE.md both classify an FPL rate-limit here as a MODELLING failure — a
 * refused summary falls back to the price prior, which is the guess the whole
 * past-season path exists to replace — so this is not a latency question.
 *
 * ONLY `element-summary/`, deliberately. The live feeds are the reason the
 * Data Cache could not simply be kept: a memo would answer "Refresh now" from
 * a copy up to 25 seconds old, which is the defect the owner reported during a
 * match. Summaries have none of that shape — they change when results land,
 * `staleSeconds` already gives them a day of grace, and they are the only path
 * where one reader generates hundreds of requests.
 *
 * Measured on a production build against the stub, 50 summaries each: reader
 * one 50 upstream fetches, reader two 0. Five polls of `fixtures/` in the same
 * run made five upstream fetches, which is the half of this that must NOT
 * change. The ten-second deadline still binds every path — 502 at 10.01 s on a
 * cold miss, on an uncached summary and on a live feed — while a fresh memo hit
 * answers in 4 ms with the upstream hung, because it does not fetch at all.
 *
 * Sized from the payloads rather than guessed: on the 2026-08-21 snapshot the
 * 600 summaries are a median of 2.8 KB and 1.85 MB in total, and a full
 * season's rows are roughly ten times that, so a 900-entry ceiling is tens of
 * megabytes at worst. Insertion order is the LRU: a re-set moves the key to the
 * end, and the oldest is evicted from the front.
 *
 * Failures are never stored. That is the same rule `pastSeasonStore` states —
 * recording a miss would take back the drafter's "try them again" button — and
 * the same one `errorJson` follows for the browser.
 */
const MAX_CACHE_ENTRIES = 900;
const responseCache = new Map<string, { at: number; result: Upstream }>();

function memoable(path: string): boolean {
  return path.startsWith("element-summary");
}

function memoGet(url: string): { at: number; result: Upstream } | undefined {
  const hit = responseCache.get(url);
  if (!hit) return undefined;
  responseCache.delete(url);
  responseCache.set(url, hit);
  return hit;
}

function memoSet(url: string, result: Upstream): void {
  responseCache.delete(url);
  responseCache.set(url, { at: Date.now(), result });
  while (responseCache.size > MAX_CACHE_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest === undefined) break;
    responseCache.delete(oldest);
  }
}

/** Test-only. */
export function memoSize(): number {
  return responseCache.size;
}

/** Test-only. */
export function resetMemo(): void {
  responseCache.clear();
}

/**
 * An error, and never a cached one.
 *
 * The four error returns below carried NO cache directive at all — measured on
 * a production build, only `vary:`. That is the same shape as the bug the note
 * on `cacheControl` is about: with no freshness lifetime a browser is free to
 * fall back to heuristic caching and pick its own, and the one thing that must
 * not be remembered is "FPL is updating the game". Chromium was measured NOT
 * doing it — three fetches of a 404 made three requests — but that is one
 * browser, and `no-store` removes the guesswork rather than leaving it as a
 * belief about somebody else's software.
 */
function errorJson(body: { error: string }, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  let joined = path.join("/");
  if (!joined.endsWith("/")) joined += "/";

  if (!ALLOWED.some((re) => re.test(joined))) {
    return errorJson({ error: "Unknown endpoint" }, 400);
  }

  // Rebuild the upstream URL canonically — never forward raw query strings.
  // Only league standings take a (validated) parameter; anything else would
  // let clients mint unlimited cache entries and bypass the TTL.
  let search = "";
  if (new RegExp(`^leagues-classic/${ID}/standings/$`).test(joined)) {
    const page = req.nextUrl.searchParams.get("page_standings") ?? "1";
    search = `?page_standings=${/^\d{1,4}$/.test(page) ? page : "1"}`;
  }
  const url = `${FPL_BASE}/${joined}${search}`;

  try {
    /*
     * A HUNG UPSTREAM MUST NOT HOLD THE FUNCTION OPEN. There was no bound at
     * all: against a stub that never answers, this route never answered either
     * — measured at 45 seconds and still waiting — and it kept the upstream
     * socket open after the client had given up at 3. On a serverless host that
     * is the whole function duration burned per request, on every request, for
     * as long as FPL is unwell. Ten seconds is generous against an API that
     * normally answers in tens of milliseconds, and the `catch` below already
     * maps both the abort and the deadline to "Could not reach the FPL API".
     *
     * BOTH belts are needed — see `withDeadline` for why the signal alone
     * binds only cold misses.
     *
     * NEVER FOLLOW A REDIRECT, either. The upstream is fixed at module load and
     * every allowed path is literals and digits, so a visitor cannot point this
     * anywhere — but if FPL itself 302s to a maintenance page or a captive
     * portal, the default `follow` serves that body under OUR origin and labels
     * it publicly cacheable at the edge. Verified against a stub: the off-host
     * body came back 200 with `cdn-cache-control: public, s-maxage`. A proxy
     * with one known upstream has no business following anything.
     */
    const ok = (data: unknown) =>
      NextResponse.json(data, {
        headers: {
          "Cache-Control": cacheControl(joined),
          "CDN-Cache-Control": cdnCacheControl(joined),
        },
      });

    /*
     * The memo, on the one path that has one — see `responseCache`. The two
     * windows are the same numbers the headers publish, so the origin, the edge
     * and the browser all age an entry identically.
     *
     * The refresh behind a stale hit is deliberately NOT awaited: that is the
     * whole difference between this and Next's Data Cache, which awaits its own
     * background revalidation and held the response open for as long as FPL
     * took to answer. Best-effort is the correct guarantee here — a serverless
     * host may kill it, and the next request simply pays for the fetch.
     */
    const memo = memoable(joined) ? memoGet(url) : undefined;
    const age = memo ? Date.now() - memo.at : Infinity;
    const freshMs = cacheSeconds(joined) * 1000;
    const staleMs = staleSeconds(joined) * 1000;
    if (memo && memo.result.kind === "ok" && age < freshMs) return ok(memo.result.data);
    if (memo && memo.result.kind === "ok" && age < freshMs + staleMs) {
      void fetchUpstream(url)
        .then((r) => {
          if (r.kind === "ok") memoSet(url, r);
        })
        .catch(() => {});
      return ok(memo.result.data);
    }

    const result = await fetchUpstream(url);
    if (result.kind === "error") {
      // A stale copy beats an error, and this is the one place it exists.
      if (memo && memo.result.kind === "ok" && age < freshMs + staleMs) {
        return ok(memo.result.data);
      }
      return errorJson({ error: result.message }, result.status);
    }
    if (memoable(joined)) memoSet(url, result);
    return ok(result.data);
  } catch {
    return errorJson({ error: "Could not reach the FPL API" }, 502);
  }
}
