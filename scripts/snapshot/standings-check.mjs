// Does `total - event_total` actually give a manager's total BEFORE this
// gameweek?
//
// The league table's "Total" column is FPL's stored cumulative and lags the
// live GW column beside it; in GW1, where the two are the same number by
// definition, it showed 5 beside a live 7. The obvious fix is
// `total - event_total + live`.
//
// It is only sound if both fields come from the same snapshot and mean what
// they say. If FPL publishes `event_total` as 0 while `total` already carries
// the gameweek, that arithmetic DOUBLES every total on the table.
//
// GW1 is the cleanest possible test: nothing precedes it, so `total` and
// `event_total` must be equal on every row and the difference must be 0.
// League 314 is the global "Overall" league and needs no permission.
//
// It runs FIRST and on its own, because the two long probes beside it once
// pushed a 22-minute script past the job's 20-minute cap and this check, which
// sat at the end, never ran twice in a row.

const BASE = "https://fantasy.premierleague.com/api";

async function get(path) {
  const res = await fetch(`${BASE}/${path}`, {
    headers: {
      "User-Agent": "fpl-optimizer standings check (personal, non-commercial)",
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

async function main() {
  const boot = await get("bootstrap-static/");
  const event = boot.body?.events?.find((e) => e.is_current)?.id ?? null;
  const LEAGUE = process.env.FPL_LEAGUE_ID ?? "314";
  const st = await get(`leagues-classic/${LEAGUE}/standings/`);
  if (!st.ok || !st.body) {
    console.log(`standings ${LEAGUE}: ${st.status} — inconclusive`);
    return;
  }
  const rows = st.body.standings?.results ?? [];
  console.log(`GW${event} · league ${LEAGUE} · ${rows.length} rows · age=${st.age ?? "-"}`);
  console.log("  entry     | total | event_total | difference");
  for (const r of rows.slice(0, 10)) {
    console.log(
      `  ${String(r.entry).padEnd(9)} | ${String(r.total).padStart(5)} | ${String(
        r.event_total
      ).padStart(11)} | ${String(r.total - r.event_total).padStart(10)}`
    );
  }
  const mismatched = rows.filter((r) => r.total !== r.event_total).length;
  console.log(`  rows where total !== event_total: ${mismatched}/${rows.length}`);
  if (event === 1) {
    console.log(
      mismatched === 0
        ? "  VERDICT: GW1 holds — `total - event_total` is 0 everywhere, the subtraction is sound."
        : "  VERDICT: BROKEN — the subtraction would not give the pre-gameweek total."
    );
  } else {
    console.log(`  VERDICT: only decisive in GW1; current event is ${event}.`);
  }
}

main().catch((e) => console.log(`check failed: ${e?.message ?? e}`));
