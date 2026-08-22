// Ask what a manager's score IS, according to each place that reports one.
//
// A reader saw "Total points 3" in the header, "3 pts" on the Latest GW card
// and "7 pts" on the Live tab, all at once, and said the 3 matched nothing.
// Three candidate explanations, and they need different fixes:
//
//   1. FPL's stored figures lag a live gameweek, so 3 is an old 7;
//   2. FPL's stored figures EXCLUDE provisional bonus, so 3 and 7 differ by
//      exactly the bonus the app is projecting;
//   3. the app's 7 is inflated — the shipped build projects bonus from the
//      first minute of a match, which is a known defect awaiting deploy.
//
// This separates them by printing, every 20 seconds:
//
//   entry.summary_event_points        FPL's stored gameweek score
//   entry.summary_overall_points      FPL's stored cumulative total
//   picks.entry_history.points        the same gameweek score, other endpoint
//   xiSum                             sum of `total_points` over the effective
//                                     XI from `event/{gw}/live/`, captain
//                                     doubled, NO bonus term at all
//   bpsTop                            how much provisional bonus the fixtures'
//                                     own `stats` would award those players
//
// If FPL's figures equal `xiSum` and both climb together, it is (2) and the
// gap is bonus. If they trail `xiSum` and catch up in steps, it is (1). If
// `xiSum` alone explains neither, the app is adding something of its own.
//
// Publishes nothing. Entry ids come from FPL_ENTRY_IDS, comma separated.

const BASE = "https://fantasy.premierleague.com/api";
const IDS = (process.env.FPL_ENTRY_IDS ?? "1,2,3")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const EVERY_MS = Number(process.env.PROBE_INTERVAL_MS ?? 20_000);
const RUN_MS = Number(process.env.PROBE_RUN_MS ?? 10 * 60_000);

async function get(path) {
  const res = await fetch(`${BASE}/${path}`, {
    headers: {
      "User-Agent": "fpl-optimizer entry probe (personal, non-commercial)",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const ct = res.headers.get("content-type") ?? "";
  return {
    ok: res.ok,
    status: res.status,
    age: res.headers.get("age"),
    body: res.ok && ct.includes("json") ? await res.json() : null,
  };
}

const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);

async function main() {
  const boot = await get("bootstrap-static/");
  const event = boot.body?.events?.find((e) => e.is_current)?.id;
  if (event == null) {
    console.log("no current event — nothing to measure");
    return;
  }
  console.log(`GW${event} · entries ${IDS.join(",")} · every ${EVERY_MS / 1000}s`);
  console.log("wall     | entry   | sum.ev | sum.tot | hist.pts | xiSum | bonus | ages e/p/l");

  const started = Date.now();
  while (Date.now() - started < RUN_MS) {
    const live = await get(`event/${event}/live/`);
    const pointsOf = new Map((live.body?.elements ?? []).map((e) => [e.id, e.stats.total_points]));
    // Provisional bonus straight off the fixtures' own per-fixture `stats`,
    // for matches at full time only — the one state where the ladder is final.
    const fx = await get("fixtures/");
    const bonusOf = new Map();
    for (const f of fx.body ?? []) {
      if (f.event !== event || !f.finished_provisional || f.finished) continue;
      const bps = (f.stats ?? []).find((s) => s.identifier === "bps");
      if (!bps) continue;
      const rows = [...(bps.h ?? []), ...(bps.a ?? [])].sort((x, y) => y.value - x.value);
      const award = [3, 2, 1];
      let i = 0;
      while (i < rows.length && i < 3) {
        const tied = rows.filter((r) => r.value === rows[i].value);
        const pts = award[i] ?? 0;
        for (const t of tied) bonusOf.set(t.element, pts);
        i += tied.length;
      }
    }
    for (const id of IDS) {
      const [entry, picks] = await Promise.all([
        get(`entry/${id}/`),
        get(`entry/${id}/event/${event}/picks/`),
      ]);
      if (!entry.ok || !picks.ok) {
        console.log(`${hhmmss(Date.now())} | ${id} | entry ${entry.status} picks ${picks.status}`);
        continue;
      }
      let xiSum = 0;
      let bonusSum = 0;
      for (const pk of picks.body.picks ?? []) {
        if (pk.multiplier < 1) continue;
        xiSum += (pointsOf.get(pk.element) ?? 0) * pk.multiplier;
        bonusSum += (bonusOf.get(pk.element) ?? 0) * pk.multiplier;
      }
      const eh = picks.body.entry_history ?? {};
      console.log(
        `${hhmmss(Date.now())} | ${String(id).padEnd(7)} | ${String(
          entry.body.summary_event_points
        ).padStart(6)} | ${String(entry.body.summary_overall_points).padStart(7)} | ${String(
          eh.points
        ).padStart(8)} | ${String(xiSum).padStart(5)} | ${String(bonusSum).padStart(5)} | ${
          entry.age ?? "-"
        }/${picks.age ?? "-"}/${live.age ?? "-"}`
      );
    }
    const wait = EVERY_MS - ((Date.now() - started) % EVERY_MS);
    await new Promise((r) => setTimeout(r, wait));
  }
  // ---- The assumption under `liveLeagueTotal`, checked rather than believed.
  //
  // That helper computes a rival's live total as `total - event_total + live`,
  // where `total - event_total` is meant to be the total BEFORE this gameweek.
  // That is only sound if the two fields come from the same snapshot and mean
  // what they say. If FPL published `event_total` as 0 while `total` carried
  // the gameweek — plausible, and unverified — then in GW1 the helper would
  // DOUBLE every total on the table.
  //
  // GW1 is the cleanest possible test: nothing precedes it, so `total` and
  // `event_total` must be equal for every row, and `total - event_total` must
  // be 0. League 314 is the global "Overall" league and needs no permission.
  const LEAGUE = process.env.FPL_LEAGUE_ID ?? "314";
  const st = await get(`leagues-classic/${LEAGUE}/standings/`);
  if (!st.ok || !st.body) {
    console.log(`standings ${LEAGUE}: ${st.status}`);
  } else {
    const rows = st.body.standings?.results ?? [];
    console.log(`standings ${LEAGUE} · GW${event} · ${rows.length} rows · age=${st.age ?? "-"}`);
    console.log("  entry | total | event_total | total-event_total");
    let mismatched = 0;
    for (const r of rows.slice(0, 12)) {
      console.log(
        `  ${String(r.entry).padEnd(9)} | ${String(r.total).padStart(5)} | ${String(
          r.event_total
        ).padStart(11)} | ${String(r.total - r.event_total).padStart(6)}`
      );
    }
    for (const r of rows) if (r.total !== r.event_total) mismatched++;
    console.log(
      `  rows where total !== event_total: ${mismatched}/${rows.length}` +
        (event === 1
          ? mismatched === 0
            ? "  => GW1 holds, the subtraction is sound"
            : "  => GW1 BROKEN, `liveLeagueTotal` would be wrong"
          : "  (only decisive in GW1)")
    );
  }

  console.log("done");
}

main().catch((e) => console.log(`probe failed: ${e?.message ?? e}`));
