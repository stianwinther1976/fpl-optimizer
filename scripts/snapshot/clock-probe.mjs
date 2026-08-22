// Watch the live FPL feeds tick, and print what they actually do.
//
// WHY THIS EXISTS. `matchMinute` reads `fixtures[].minutes` and treats it as
// the match clock. The comment there cites a measurement on ARS v COV — 89 at
// the 89th minute, then 90 for the rest of a match that ran to 94 — but NO
// SNAPSHOT IN THIS REPO CONTAINS AN IN-PLAY FIXTURE (380 fixtures in each of
// the two taken so far; `started && !finished_provisional` is 0 in both). So
// that figure cannot be reproduced here and the assumption under the whole
// live view is unverified.
//
// It matters because a reader watched a match reach the hour mark with the
// card reading 2', and later saw a finished 2-0 rendering 55'. Two explanations
// fit equally well and the app cannot tell them apart from the inside:
//
//   1. the payload we were handed was old, or
//   2. `minutes` does not advance in anything like real time.
//
// If it is (2), no amount of cache work makes the Live tab live and the clock
// needs a different source. So this measures, and asserts nothing.
//
// It publishes NOTHING and writes NOTHING. Everything goes to the job log,
// which is the whole point: the sandbox this repo is developed from cannot
// reach fantasy.premierleague.com, but a runner can, and the log comes back.
//
// Three things are recorded per sample, and the third is the one that settles
// it:
//
//   - `fixtures[].minutes`, the field the app reads;
//   - `max(live.elements[].stats.minutes)` over the players in that fixture,
//     an INDEPENDENT clock from a different endpoint. A player who is on for
//     the whole match has played the match's minutes. If this moves while the
//     other stands still, the answer is (2) and the fix is to change source;
//   - FPL's own response headers (`age`, `date`, `x-cache`, `cache-control`),
//     which say whether their edge is serving us something it cached earlier.
//     If `age` climbs while the body stands still, the answer is (1) and it is
//     upstream of everything this repo controls.

const BASE = "https://fantasy.premierleague.com/api";
const EVERY_MS = Number(process.env.PROBE_INTERVAL_MS ?? 20_000);
const RUN_MS = Number(process.env.PROBE_RUN_MS ?? 12 * 60_000);

async function get(path) {
  const res = await fetch(`${BASE}/${path}`, {
    headers: {
      "User-Agent": "fpl-optimizer clock probe (personal, non-commercial)",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const h = res.headers;
  return {
    ok: res.ok,
    status: res.status,
    // Deliberately raw. Reading these wrong is how the caching work went four
    // rounds; print them and let the log be the record.
    meta: {
      age: h.get("age"),
      date: h.get("date"),
      xCache: h.get("x-cache") ?? h.get("cf-cache-status"),
      cacheControl: h.get("cache-control"),
      etag: h.get("etag"),
    },
    body: res.ok && (h.get("content-type") ?? "").includes("json") ? await res.json() : null,
  };
}

const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);

async function main() {
  const boot = await get("bootstrap-static/");
  if (!boot.ok || !boot.body) {
    console.log(`bootstrap failed: ${boot.status}`);
    process.exit(0);
  }
  const teams = new Map(boot.body.teams.map((t) => [t.id, t.short_name]));
  const event = boot.body.events.find((e) => e.is_current)?.id;
  if (event == null) {
    console.log("no current event — nothing in play, nothing to measure");
    process.exit(0);
  }
  console.log(`GW${event} · sampling every ${EVERY_MS / 1000}s for ${RUN_MS / 60_000} min`);
  console.log(
    "wall     | fixture      | fx.minutes | live.max(min) | score | started/prov/fin | fx.age live.age"
  );

  const started = Date.now();
  let n = 0;
  while (Date.now() - started < RUN_MS) {
    const [fx, live] = await Promise.all([get("fixtures/"), get(`event/${event}/live/`)]);
    const wall = hhmmss(Date.now());
    if (!fx.ok || !fx.body) {
      console.log(`${wall} | fixtures ${fx.status} ${JSON.stringify(fx.meta)}`);
    } else {
      const inPlay = fx.body.filter((f) => f.event === event && f.started && !f.finished);
      if (inPlay.length === 0) {
        console.log(`${wall} | nothing in play (age fx=${fx.meta.age} live=${live.meta.age})`);
      }
      // Player minutes per fixture, from `explain[].fixture` — `stats` alone is
      // a GAMEWEEK total and would be wrong in a double.
      const perFixture = new Map();
      for (const el of live.body?.elements ?? []) {
        for (const ex of el.explain ?? []) {
          const cur = perFixture.get(ex.fixture) ?? 0;
          const mins = el.stats?.minutes ?? 0;
          if (mins > cur) perFixture.set(ex.fixture, mins);
        }
      }
      for (const f of inPlay) {
        const name = `${teams.get(f.team_h)}-${teams.get(f.team_a)}`.padEnd(12);
        const flags = `${f.started ? 1 : 0}/${f.finished_provisional ? 1 : 0}/${f.finished ? 1 : 0}`;
        console.log(
          `${wall} | ${name} | ${String(f.minutes).padStart(10)} | ${String(
            perFixture.get(f.id) ?? "-"
          ).padStart(13)} | ${f.team_h_score}-${f.team_a_score}   | ${flags}            | ${
            fx.meta.age ?? "-"
          } ${live.meta.age ?? "-"}`
        );
      }
    }
    n++;
    const wait = EVERY_MS - ((Date.now() - started) % EVERY_MS);
    await new Promise((r) => setTimeout(r, wait));
  }
  console.log(`done — ${n} samples`);
}

main().catch((e) => {
  console.log(`probe failed: ${e?.message ?? e}`);
  process.exit(0);
});
