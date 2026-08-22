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
 * revalidating", `...isStale ? [] : ['signal']`. Every path here is cached
 * after its first success, so the signal binds cold misses and nothing else.
 *
 * WHAT THAT DOES AND DOES NOT MEAN, measured against a stub that accepts the
 * connection and never answers:
 *
 *   cold miss, hung upstream ......... 502 at 10.04 s (deadline fires)
 *   entry stale, hung upstream ....... 200 at 0.04 s, the stale body
 *
 * So a reader is never made to wait: on a stale entry Next answers from the
 * cache immediately and refreshes behind it, which is `stale-while-revalidate`
 * doing its job. What is genuinely unbounded is that BACKGROUND refresh, which
 * neither this nor the signal can reach — but nothing is awaiting it and the
 * handler has already returned, so it cannot hold the response open.
 *
 * This function is therefore what makes the ten seconds a guarantee about the
 * path the route actually awaits, whether or not the signal survives to it.
 * The signal still earns its place: on a cold miss it closes the socket, which
 * racing a timer cannot do.
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
 * requests, never staler data. And the origin is not FPL in that case, because
 * the upstream fetch below is itself cached by Next for `ttl`.
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
  const ttl = cacheSeconds(joined);

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
    const upstream = await withDeadline(
      fetch(url, {
        headers: {
          "User-Agent": "fpl-optimizer (personal, non-commercial)",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        redirect: "error",
        next: { revalidate: ttl },
      }),
      UPSTREAM_TIMEOUT_MS
    );

    if (!upstream.ok) {
      // FPL returns 503/maintenance pages while the game updates.
      const status = upstream.status === 404 ? 404 : 503;
      return errorJson({ error: status === 404 ? "Not found" : "FPL is updating the game" }, status);
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return errorJson({ error: "FPL is updating the game" }, 503);
    }

    const data = await upstream.json();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": cacheControl(joined),
        "CDN-Cache-Control": cdnCacheControl(joined),
      },
    });
  } catch {
    return errorJson({ error: "Could not reach the FPL API" }, 502);
  }
}
