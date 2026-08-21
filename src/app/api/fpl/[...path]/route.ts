// Proxy for the official FPL API. Required because fantasy.premierleague.com
// sends no CORS headers, so the browser can never call it directly.

import { NextRequest, NextResponse } from "next/server";

const FPL_BASE = process.env.FPL_API_BASE ?? "https://fantasy.premierleague.com/api";

// Only allow known endpoint shapes — never a blind open proxy.
const ALLOWED: RegExp[] = [
  /^bootstrap-static\/$/,
  /^fixtures\/$/,
  /^entry\/\d+\/$/,
  /^entry\/\d+\/event\/\d+\/picks\/$/,
  /^entry\/\d+\/history\/$/,
  /^entry\/\d+\/transfers\/$/,
  /^element-summary\/\d+\/$/,
  /^event\/\d+\/live\/$/,
  /^leagues-classic\/\d+\/standings\/$/,
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  let joined = path.join("/");
  if (!joined.endsWith("/")) joined += "/";

  if (!ALLOWED.some((re) => re.test(joined))) {
    return NextResponse.json({ error: "Unknown endpoint" }, { status: 400 });
  }

  // Rebuild the upstream URL canonically — never forward raw query strings.
  // Only league standings take a (validated) parameter; anything else would
  // let clients mint unlimited cache entries and bypass the TTL.
  let search = "";
  if (/^leagues-classic\/\d+\/standings\/$/.test(joined)) {
    const page = req.nextUrl.searchParams.get("page_standings") ?? "1";
    search = `?page_standings=${/^\d{1,4}$/.test(page) ? page : "1"}`;
  }
  const url = `${FPL_BASE}/${joined}${search}`;
  const ttl = cacheSeconds(joined);

  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "fpl-optimizer (personal, non-commercial)",
        Accept: "application/json",
      },
      next: { revalidate: ttl },
    });

    if (!upstream.ok) {
      // FPL returns 503/maintenance pages while the game updates.
      const status = upstream.status === 404 ? 404 : 503;
      return NextResponse.json(
        { error: status === 404 ? "Not found" : "FPL is updating the game" },
        { status }
      );
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return NextResponse.json({ error: "FPL is updating the game" }, { status: 503 });
    }

    const data = await upstream.json();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": cacheControl(joined),
        "CDN-Cache-Control": cdnCacheControl(joined),
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the FPL API" }, { status: 502 });
  }
}
