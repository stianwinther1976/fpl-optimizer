// Does the live feed know about a goal before `fixtures/` does?
//
// The match clock moved to `event/{gw}/live/` because FPL holds `fixtures/` at
// its own edge for 300 seconds against roughly 90 for the live feed (probe run
// 32577720199). The SCORE still comes from `fixtures/` and therefore inherits
// that same five-minute window — a reader watched 0-0 while the match was 2-0.
//
// The obvious move is to derive the score the same way the clock now is:
// `explain[].stats` carries `goals_scored` per player per fixture, and
// `own_goals` counts against the scorer's own side. But EVERY FIXTURE IN THE
// EARLIER PROBE WINDOW WAS 0-0, so there is no evidence that the live-derived
// figure actually leads. This repo does not ship arithmetic on that.
//
// So: sample both, side by side, over a match with goals in it, and print the
// two. If `live` reaches a scoreline before `fx` does, and never runs ahead of
// the real one, the source is worth changing. If they move together, the score
// gains nothing from the switch and should stay where it is.
//
// Deliberately short — five minutes — because a job's log cannot be read until
// the job ends, and a fast answer is the whole point.

const BASE = "https://fantasy.premierleague.com/api";
const EVERY_MS = 20_000;
const RUN_MS = Number(process.env.SCORE_RUN_MS ?? 5 * 60_000);

async function get(path) {
  const res = await fetch(`${BASE}/${path}`, {
    headers: {
      "User-Agent": "fpl-optimizer score probe (personal, non-commercial)",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const ct = res.headers.get("content-type") ?? "";
  return {
    ok: res.ok,
    age: res.headers.get("age"),
    body: res.ok && ct.includes("json") ? await res.json() : null,
  };
}

const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);

async function main() {
  const boot = await get("bootstrap-static/");
  const event = boot.body?.events?.find((e) => e.is_current)?.id;
  if (event == null) return console.log("no current event");
  const teams = new Map(boot.body.teams.map((t) => [t.id, t.short_name]));
  const teamOfElement = new Map(boot.body.elements.map((e) => [e.id, e.team]));
  console.log(`GW${event} · fx score vs live-derived score · every 20s`);
  console.log("wall     | fixture      | fx    | live  | agree | age fx/live");

  const started = Date.now();
  while (Date.now() - started < RUN_MS) {
    const [fx, live] = await Promise.all([get("fixtures/"), get(`event/${event}/live/`)]);
    const wall = hhmmss(Date.now());
    const inPlay = (fx.body ?? []).filter((f) => f.event === event && f.started && !f.finished);
    if (inPlay.length === 0) {
      console.log(`${wall} | nothing in play`);
    }
    // Goals per fixture per side, from `explain`. A goal counts for the
    // scorer's own club; an own goal counts for the opponent.
    const goals = new Map(); // fixtureId -> Map(teamId -> goals)
    for (const el of live.body?.elements ?? []) {
      for (const ex of el.explain ?? []) {
        const club = teamOfElement.get(el.id);
        if (club == null) continue;
        const f = inPlay.find((x) => x.id === ex.fixture);
        if (!f) continue;
        const other = f.team_h === club ? f.team_a : f.team_h;
        let byTeam = goals.get(ex.fixture);
        if (!byTeam) goals.set(ex.fixture, (byTeam = new Map()));
        for (const st of ex.stats ?? []) {
          if (st.identifier === "goals_scored") {
            byTeam.set(club, (byTeam.get(club) ?? 0) + (st.value ?? 0));
          } else if (st.identifier === "own_goals") {
            byTeam.set(other, (byTeam.get(other) ?? 0) + (st.value ?? 0));
          }
        }
      }
    }
    for (const f of inPlay) {
      const g = goals.get(f.id) ?? new Map();
      const lh = g.get(f.team_h) ?? 0;
      const la = g.get(f.team_a) ?? 0;
      const fxs = `${f.team_h_score}-${f.team_a_score}`;
      const lvs = `${lh}-${la}`;
      console.log(
        `${wall} | ${`${teams.get(f.team_h)}-${teams.get(f.team_a)}`.padEnd(12)} | ${fxs.padEnd(
          5
        )} | ${lvs.padEnd(5)} | ${fxs === lvs ? "yes" : "NO "}   | ${fx.age ?? "-"}/${live.age ?? "-"}`
      );
    }
    const wait = EVERY_MS - ((Date.now() - started) % EVERY_MS);
    await new Promise((r) => setTimeout(r, wait));
  }
  console.log("done");
}

main().catch((e) => console.log(`probe failed: ${e?.message ?? e}`));
