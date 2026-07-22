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
function cacheSeconds(path: string): number {
  if (path.startsWith("bootstrap-static")) return 300;
  if (path.startsWith("fixtures")) return 300;
  if (path.includes("/live/")) return 60;
  if (path.includes("/history/") || path.includes("/transfers/")) return 300;
  return 120;
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

  const search = req.nextUrl.search ?? "";
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
        "Cache-Control": `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the FPL API" }, { status: 502 });
  }
}
