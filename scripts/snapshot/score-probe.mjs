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
// 0 runs the reconciliation pass only, which needs no match in play.
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

/**
 * Goals per fixture per side, derived from `explain`.
 *
 * ONE IMPLEMENTATION, used by both the reconciliation pass and the live
 * comparison. Two copies that agree is how a probe ends up proving its own
 * arithmetic against itself.
 *
 * A goal counts for the scorer's own club; an OWN goal counts for the
 * opponent, which is the term a naive sum gets wrong and the reason the
 * reconciliation below is worth running at all.
 */
function goalsByFixture(live, teamOfElement, fixtures) {
  const goals = new Map(); // fixtureId -> Map(teamId -> goals)
  for (const el of live?.elements ?? []) {
    for (const ex of el.explain ?? []) {
      const club = teamOfElement.get(el.id);
      if (club == null) continue;
      const f = fixtures.find((x) => x.id === ex.fixture);
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
  return goals;
}

async function main() {
  const boot = await get("bootstrap-static/");
  const event = boot.body?.events?.find((e) => e.is_current)?.id;
  if (event == null) return console.log("no current event");
  const teams = new Map(boot.body.teams.map((t) => [t.id, t.short_name]));
  const teamOfElement = new Map(boot.body.elements.map((e) => [e.id, e.team]));
  console.log(`GW${event} · fx score vs live-derived score · every 20s`);
  console.log("wall     | fixture      | fx    | live  | agree | age fx/live");

  const both = async () => {
    const [fx, live] = await Promise.all([get("fixtures/"), get(`event/${event}/live/`)]);
    return { fx, live };
  };
  let { fx, live } = await both();

  // ---- HALF THE QUESTION CAN BE ANSWERED WITHOUT A MATCH IN PLAY.
  //
  // Two separate things have to hold before the score could move to the live
  // feed, and only one of them needs live football:
  //
  //   1. the arithmetic must be RIGHT — summing `goals_scored` from `explain`,
  //      with `own_goals` counted against the scorer's own side, must
  //      reproduce a finished fixture's `team_h_score`/`team_a_score` exactly;
  //   2. it must be FRESHER than `fixtures/`, which needs a live match.
  //
  // (1) is checkable against any finished gameweek, right now, and if it fails
  // the idea is dead and (2) never needs asking. Run it first and always.
  {
    // `finished_provisional`, NOT `finished`. `finished` means BONUS CONFIRMED,
    // and this pass wants matches that have ENDED. Measured on 2026-08-23 at
    // 19:24Z: all nine of GW1's played fixtures read `finished: false` two days
    // after kick-off, so filtering on it found ZERO and reported itself
    // inconclusive while the answer sat in the very next loop. The same
    // distinction is documented in CLAUDE.md and has shipped as a defect twice.
    const fin = (fx.body ?? []).filter(
      (f) => f.event === event && (f.finished_provisional || f.finished)
    );
    console.log(`reconcile: ${fin.length} ended fixtures in GW${event}`);
    let mismatched = 0;
    for (const f of fin) {
      const g = goalsByFixture(live.body, teamOfElement, [f]);
      const byTeam = g.get(f.id) ?? new Map();
      const lh = byTeam.get(f.team_h) ?? 0;
      const la = byTeam.get(f.team_a) ?? 0;
      const ok = lh === f.team_h_score && la === f.team_a_score;
      if (!ok) mismatched++;
      console.log(
        `  ${`${teams.get(f.team_h)}-${teams.get(f.team_a)}`.padEnd(12)} | fx ${f.team_h_score}-${
          f.team_a_score
        } | live ${lh}-${la} | ${ok ? "match" : "MISMATCH"}`
      );
    }
    console.log(
      fin.length === 0
        ? "  VERDICT: no ended fixtures yet — inconclusive."
        : mismatched === 0
          ? `  VERDICT: the arithmetic reproduces every finished score (${fin.length}/${fin.length}). Only freshness is left to prove.`
          : `  VERDICT: BROKEN — ${mismatched}/${fin.length} do not reconcile. Deriving the score is not viable.`
    );
  }

  const started = Date.now();
  while (Date.now() - started < RUN_MS) {
    ({ fx, live } = await both());
    const wall = hhmmss(Date.now());
    const inPlay = (fx.body ?? []).filter((f) => f.event === event && f.started && !f.finished);
    if (inPlay.length === 0) {
      console.log(`${wall} | nothing in play`);
    }
    const goals = goalsByFixture(live.body, teamOfElement, inPlay);
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
