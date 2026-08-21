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
 * Deliberately NOT `must-revalidate`, which binds shared caches too and would
 * cost the `stale-while-revalidate` window that keeps a cold miss off the
 * reader's critical path.
 */
export function cacheControl(path: string): string {
  return `public, max-age=0, s-maxage=${cacheSeconds(path)}, stale-while-revalidate=${staleSeconds(path)}`;
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
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the FPL API" }, { status: 502 });
  }
}
