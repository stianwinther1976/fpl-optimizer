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

  if (body == null) {
    return NextResponse.json({ error: "Unknown demo endpoint" }, { status: 404 });
  }
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
