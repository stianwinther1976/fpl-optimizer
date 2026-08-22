// Demo-mode API: serves the synthetic mid-season universe (GW20 just played)
// using the same endpoint shapes as the real FPL proxy.

import { NextRequest, NextResponse } from "next/server";
import { makeDemoUniverse } from "@/lib/demo";

/*
 * ONE UNIVERSE PER TICK, NOT ONE PER REQUEST.
 *
 * `makeDemoUniverse` plays twenty gameweeks of a three-hundred-player league:
 * it builds every team sheet, scores every match, awards every bonus point,
 * assembles ten squads and samples twenty-four more to derive the field
 * average. That is 80-190ms of CPU, and it was being done again for every
 * single request — a dashboard load fires the bootstrap, the fixtures, the
 * entry, the history, the picks, a live feed and an element summary per player
 * card, so opening the demo cost one to three seconds of server time rebuilding
 * an identical object six or seven times over.
 *
 * The universe is a pure function of `now`, so it is cached against a coarse
 * bucket and the work happens once per bucket instead of once per fetch.
 *
 * The bucket is NOT what keeps the demo live, and the comment here used to
 * claim it was: "the minute in an in-play fixture still advances". It does not.
 * Every kickoff is pinned relative to `now` — the in-play ones at `now` minus
 * 73 minutes — so the clock and the fixture move together and the match renders
 * at 58' forever, at any `now` whatsoever. That is deliberate (a demo that
 * drifts out of its own in-play window stops demonstrating the live feed), and
 * it is the reason every SCORE, rank, price and league place in the universe is
 * invariant in `now`. Not quite everything is: `thisSeasonStart` and
 * `seasonLabel` read the calendar off GW1's date, so the season a card is
 * labelled with does turn over, once a year, on a day nobody will be watching.
 *
 * So the bucket buys one thing only: a bound on how stale the object may be if
 * that invariance is ever broken more seriously — a new fixture pinned to an
 * absolute date, a deadline that finally passes. Fifteen seconds is cheap
 * insurance against a future edit, not a live clock.
 */
const TICK_MS = 15_000;
let cached: { tick: number; universe: ReturnType<typeof makeDemoUniverse> } | null = null;
const demoUniverse = (now: number) => {
  const tick = Math.floor(now / TICK_MS);
  if (!cached || cached.tick !== tick) cached = { tick, universe: makeDemoUniverse(tick * TICK_MS) };
  return cached.universe;
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  let joined = path.join("/");
  if (!joined.endsWith("/")) joined += "/";

  const u = demoUniverse(Date.now());

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
  // AND BOUNDED, like `live` below. `picksFor` clamps with
  // `max(1, min(CURRENT_GW, gw))`, so GW0 answered with GW1's picks and
  // GW99999999 with GW20's — the same defect the note on `live` says was fixed
  // there, left in place one endpoint over. The real API 404s a gameweek that
  // has not been played, and a demo that answers where the real one refuses is
  // a demo that stops being a rehearsal.
  else if (/^entry\/\d+\/event\/\d+\/picks\/$/.test(joined)) {
    const seg = joined.split("/");
    const gw = parseInt(seg[3], 10);
    if (gw >= 1 && gw <= u.currentEvent) body = u.picksFor(parseInt(seg[1], 10), gw);
  }
  // Per-entry too. This served the demo manager's own season — his points, his
  // ranks, his chips — to every id that asked, so the nine rivals in the
  // mini-league shared one identical history and any rival card opened on the
  // reader's own numbers.
  else if (/^entry\/\d+\/history\/$/.test(joined))
    body = u.historyFor(parseInt(joined.split("/")[1], 10));
  // And the last two endpoints that were still throwing the id away. With
  // `picks` and `history` per-entry and these two not, the API contradicted
  // itself about the same manager: a rival's card opened on "Demo Manager" and
  // his 1,152 points above a pitch and a season belonging to somebody else.
  else if (/^entry\/\d+\/transfers\/$/.test(joined))
    body = u.transfersFor(parseInt(joined.split("/")[1], 10));
  else if (/^entry\/\d+\/$/.test(joined)) body = u.entryFor(parseInt(joined.split("/")[1], 10));
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
