// Is the "Safety score (your rank band)" actually the reader's rank band?
//
// REPORTED FROM THE APP, GW2: own live score 45, GW average 29, and a rank-band
// median of 83 — nearly three times the average of the entire game. A median is
// a middle: half of any sample sits below it. For a band median to be 83 while
// the average is 29, either the sample is not the reader's band, or the sample
// is being scored wrong. Those are different bugs and this separates them.
//
// `LiveTab` computes `page = ceil(summary_overall_rank / 50)` and asks for
// `leagues-classic/314/standings/?page_standings=<page>`, then takes ~20 rows
// and scores them itself. NOTHING CHECKS THAT THE PAGE CAME BACK. If FPL caps
// deep pagination — league 314 has millions of pages — a clamped or empty
// response would silently hand the app the top of the world and it would print
// their median as the reader's peers.
//
// So this reports, for the real entry:
//
//  1. the rank, the page the app would ask for, and the ranks FPL actually
//     returns on that page. They either bracket the reader or they do not;
//  2. the same for a ladder of pages, to find where the parameter stops being
//     honoured, if it does;
//  3. the band's own gameweek points, off FPL's `event_total` and off each
//     entry's live `summary_event_points`, with the median — against the
//     gameweek average FPL publishes. If the band's median is near the average
//     the sample is fine and the app's SCORING is what inflates it; if the
//     band's median is itself ~83 the sample is not the reader's band.
//
// Publishes nothing. Reads only the public API.

const BASE = "https://fantasy.premierleague.com/api";

async function get(path) {
  const res = await fetch(`${BASE}/${path}`, {
    headers: {
      "User-Agent": "fpl-optimizer band probe (personal, non-commercial)",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const ct = res.headers.get("content-type") ?? "";
  return {
    ok: res.ok,
    status: res.status,
    body: res.ok && ct.includes("json") ? await res.json() : null,
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor(s.length / 2)];
};

async function main() {
  const ENTRY = process.env.FPL_ENTRY_ID ?? "946779";
  const LEAGUE = process.env.FPL_LEAGUE_ID ?? "314";

  const boot = await get("bootstrap-static/");
  const ev = boot.body?.events?.find((e) => e.is_current);
  const gw = ev?.id ?? null;
  console.log(`GW${gw} · average_entry_score=${ev?.average_entry_score ?? "-"} · highest=${ev?.highest_score ?? "-"}`);

  const entry = await get(`entry/${ENTRY}/`);
  if (!entry.ok || !entry.body) {
    console.log(`entry ${ENTRY}: ${entry.status} — inconclusive`);
    return;
  }
  const rank = entry.body.summary_overall_rank;
  const page = Math.max(1, Math.ceil(rank / 50));
  console.log(
    `entry ${ENTRY}: summary_overall_rank=${rank} · summary_event_points=${entry.body.summary_event_points} · app would ask page_standings=${page}`
  );

  // --- 1 & 2: does the page parameter reach that deep? -------------------
  console.log("\npage_standings ladder — what FPL actually returns:");
  console.log("  page       | rows | first rank  | last rank   | has_next");
  const pages = [...new Set([1, 100, 10_000, 100_000, page])].sort((a, b) => a - b);
  let bandRows = null;
  for (const p of pages) {
    const st = await get(`leagues-classic/${LEAGUE}/standings/?page_standings=${p}`);
    if (!st.ok || !st.body) {
      console.log(`  ${String(p).padEnd(10)} | ${st.status} — no body`);
      continue;
    }
    const rows = st.body.standings?.results ?? [];
    console.log(
      `  ${String(p).padEnd(10)} | ${String(rows.length).padStart(4)} | ${String(
        rows[0]?.rank ?? "-"
      ).padStart(11)} | ${String(rows.at(-1)?.rank ?? "-").padStart(11)} | ${
        st.body.standings?.has_next ?? "-"
      }`
    );
    if (p === page) bandRows = rows;
  }

  if (!bandRows || bandRows.length === 0) {
    console.log("\n  VERDICT: the app's page came back empty — the sample cannot be the reader's band.");
    return;
  }
  const brackets = bandRows[0].rank <= rank && rank <= bandRows.at(-1).rank;
  console.log(
    `\n  Does the app's page bracket rank ${rank}?  ${brackets ? "YES" : "NO — the sample is not the reader's band"}`
  );

  // --- 3: what does that band actually score this gameweek? ---------------
  const step = Math.max(1, Math.floor(bandRows.length / 20));
  const sample = bandRows.filter((_, i) => i % step === 0).slice(0, 20);
  console.log(`\nband sample of ${sample.length}, the same rows the app takes:`);
  console.log("  rank        | entry     | event_total | live summary_event_points");
  const stored = [];
  const livePts = [];
  for (const r of sample) {
    const e = await get(`entry/${r.entry}/`);
    const sep = e.body?.summary_event_points ?? null;
    stored.push(r.event_total);
    if (sep != null) livePts.push(sep);
    console.log(
      `  ${String(r.rank).padEnd(11)} | ${String(r.entry).padEnd(9)} | ${String(
        r.event_total
      ).padStart(11)} | ${String(sep ?? "-").padStart(25)}`
    );
  }
  console.log(`\n  median event_total          : ${median(stored)}`);
  console.log(`  median summary_event_points : ${median(livePts)}`);
  console.log(`  FPL's published GW average  : ${ev?.average_entry_score ?? "-"}`);
  console.log(
    "\n  READ IT LIKE THIS: `summary_event_points` is live and exact (it excludes\n" +
      "  provisional bonus, worth a few points, and nothing else). If its median is\n" +
      "  near the GW average, the SAMPLE is the reader's band and the app's own\n" +
      "  scoring of it is what inflates the safety score. If the median is itself\n" +
      "  far above the average, the sample is the wrong managers."
  );
}

main().catch((e) => console.log(`probe failed: ${e?.message ?? e}`));
