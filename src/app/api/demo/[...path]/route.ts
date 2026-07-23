// Demo-mode API: serves the synthetic mid-season universe (GW20 just played)
// using the same endpoint shapes as the real FPL proxy.

import { NextRequest, NextResponse } from "next/server";
import { makeDemoUniverse } from "@/lib/demo";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  let joined = path.join("/");
  if (!joined.endsWith("/")) joined += "/";

  const u = makeDemoUniverse(Date.now());

  let body: unknown = null;
  if (/^bootstrap-static\/$/.test(joined)) body = u.bootstrap;
  else if (/^fixtures\/$/.test(joined)) body = u.fixtures;
  else if (/^entry\/\d+\/event\/\d+\/picks\/$/.test(joined)) body = u.picks;
  else if (/^entry\/\d+\/history\/$/.test(joined)) body = u.history;
  else if (/^entry\/\d+\/transfers\/$/.test(joined)) body = u.transfers;
  else if (/^entry\/\d+\/$/.test(joined)) body = u.entry;
  else if (/^event\/\d+\/live\/$/.test(joined)) body = u.live;
  else if (/^leagues-classic\/\d+\/standings\/$/.test(joined)) body = u.league;
  else if (/^element-summary\/\d+\/$/.test(joined)) {
    // Synthetic per-GW history: deterministic from the element id so the
    // recent-starts model and PlayerModal have something realistic to chew on.
    const id = parseInt(joined.split("/")[1], 10);
    const el = u.bootstrap.elements.find((e) => e.id === id);
    const played = u.bootstrap.events.filter((e) => e.finished).map((e) => e.id);
    const rows = played.map((round) => {
      const benched = (id * 7 + round) % 9 === 0; // ~1 in 9 games rotated
      const minutes = benched ? ((id + round) % 2 === 0 ? 0 : 23) : 90;
      const pts = benched
        ? minutes > 0
          ? 1
          : 0
        : 2 + ((id * 13 + round * 5) % 9) - (el && el.element_type === 1 ? 1 : 0);
      return {
        element: id,
        round,
        minutes,
        starts: benched ? 0 : 1,
        total_points: Math.max(0, pts),
        opponent_team: ((id + round) % u.bootstrap.teams.length) + 1,
        was_home: (id + round) % 2 === 0,
      };
    });
    body = { history: rows };
  }

  if (body == null) {
    return NextResponse.json({ error: "Unknown demo endpoint" }, { status: 404 });
  }
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
