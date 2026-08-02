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
  // Per-entry, because the mini-league asks for each rival's team by id. This
  // used to hand back the demo manager's picks whatever id was requested, so
  // every rival's live score came out identical to his.
  // Per-entry AND per-gameweek. Both segments used to be thrown away: the id,
  // so every rival in the mini-league was served the demo manager's own team
  // and scored exactly what he did; and the gameweek, so the Team tab's time
  // machine drew the GW20 pitch under a GW15 caption and disagreed with the
  // history row beside it.
  else if (/^entry\/\d+\/event\/\d+\/picks\/$/.test(joined)) {
    const seg = joined.split("/");
    body = u.picksFor(parseInt(seg[1], 10), parseInt(seg[3], 10));
  }
  // Per-entry too. This served the demo manager's own season — his points, his
  // ranks, his chips — to every id that asked, so the nine rivals in the
  // mini-league shared one identical history and any rival card opened on the
  // reader's own numbers.
  else if (/^entry\/\d+\/history\/$/.test(joined))
    body = u.historyFor(parseInt(joined.split("/")[1], 10));
  else if (/^entry\/\d+\/transfers\/$/.test(joined)) body = u.transfers;
  else if (/^entry\/\d+\/$/.test(joined)) body = u.entry;
  // A season has 38 gameweeks and no more. Outside that the request is not for
  // a week the demo declines to describe, it is not for a week at all, and a
  // 404 says so — `liveFor` used to answer GW99 with GW20's scores.
  else if (/^event\/\d+\/live\/$/.test(joined)) {
    const gw = parseInt(joined.split("/")[1], 10);
    if (gw >= 1 && gw <= 38) body = u.liveFor(gw);
  }
  else if (/^leagues-classic\/\d+\/standings\/$/.test(joined))
    body = u.leagueFor(parseInt(joined.split("/")[1], 10));
  // The per-GW history now comes off the same match feeds that produced the
  // player's season totals. It used to be invented from the element id, so the
  // recent-starts model was fed a rotation pattern that contradicted both the
  // player's own minutes and every live score he had.
  else if (/^element-summary\/\d+\/$/.test(joined))
    body = u.elementHistory(parseInt(joined.split("/")[1], 10));

  if (body == null) {
    return NextResponse.json({ error: "Unknown demo endpoint" }, { status: 404 });
  }
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
