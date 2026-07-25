/**
 * Full-season simulation: play a whole season as a "model manager" and count
 * the ACTUAL points the chosen team scored each gameweek.
 *
 * Rules of the simulation (kept deliberately conservative & transparent):
 *  - Start GW1 with the model's £100m launch squad (pre-season info only).
 *  - Each GW: up to the available free transfers, no −4 hits, no chips.
 *    A transfer is made only if the model projects it improves the squad.
 *  - Best XI + captain chosen by the model each GW; official auto-subs and
 *    vice-captain takeover applied using the players' REAL minutes that week.
 *  - Selling price = current price (ignores the 50% sell tax) — a small
 *    simplification that slightly helps team value but not weekly points.
 *
 * Baseline: the same GW1 squad played "set & forget" — never transfer, always
 * captain the player with the best season points-per-game so far. Isolates
 * what the model's weekly decisions actually add.
 *
 * Run: SEASON=2024-25 npx vitest run --config vitest.sim.config.ts
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { projectAll } from "../src/lib/xp";
import { pickBestXi, optimize, buildLaunchSquad } from "../src/lib/optimizer";
import { isValidFormation } from "../src/lib/rules";
import { setActiveCalibration, IDENTITY_FACTORS } from "../src/lib/calibration";
import type {
  Bootstrap,
  Element,
  ElementType,
  Fixture,
  OwnedPlayer,
  PastSeasonStats,
  Team,
} from "../src/lib/types";

const SEASON = process.env.SEASON ?? "2025-26";
const DATA = path.resolve(__dirname, `../../fpl-data/data/${SEASON}`);

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let f = "";
  let row: string[] = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      f = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else f += c;
  }
  if (f !== "" || row.length > 0) {
    row.push(f);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  const h = rows[0];
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    h.forEach((k, i) => (o[k] = r[i] ?? ""));
    return o;
  });
}

interface Row {
  element: number;
  round: number;
  minutes: number;
  starts: number;
  tp: number;
  goals: number;
  assists: number;
  bonus: number;
  saves: number;
  ict: number;
  xg: number;
  xa: number;
  value: number;
  /** FPL's own expected-points estimate for that gameweek — the `ep_next` the
   *  live app reads. Without it the backtest runs a model the app never ships:
   *  `epShare` is 0.55 of the thin-data anchor, so leaving it null hands the
   *  whole anchor to last season's output and flatters any change made to it. */
  xp: number;
  /** The club he was registered at THAT WEEK, as the CSV writes it — a display
   *  name ("Sheffield Utd"), not an id. An earlier version of this field read
   *  `+r.team`, which is `NaN` for every row and silently became 0, so the
   *  correction it was added to make was never actually applied.
   *  `players_raw.csv` is an end-of-season file, so taking the club from there
   *  puts two dozen players a
   *  season at the club they were sold to in January from GW1 onward — wrong
   *  fixtures, wrong opponent strength, and a corrupted goalkeeper allocation,
   *  which pools by club. */
  teamName: string;
}

function loadSeason() {
  const teams: Team[] = parseCsv(fs.readFileSync(path.join(DATA, "teams.csv"), "utf8")).map((t) => ({
    id: +t.id,
    name: t.name,
    short_name: t.short_name,
    strength: +t.strength,
    strength_overall_home: +t.strength_overall_home,
    strength_overall_away: +t.strength_overall_away,
    strength_attack_home: +t.strength_attack_home,
    strength_attack_away: +t.strength_attack_away,
    strength_defence_home: +t.strength_defence_home,
    strength_defence_away: +t.strength_defence_away,
  }));
  const meta = new Map(
    parseCsv(fs.readFileSync(path.join(DATA, "players_raw.csv"), "utf8")).map((p) => [
      +p.id,
      {
        web_name: p.web_name,
        team: +p.team,
        element_type: +p.element_type as ElementType,
        // Deliberately NOT read from `players_raw.csv`. That file is an
        // end-of-season snapshot, so a player who inherited the penalties in
        // January is recorded as the taker and the harness would credit him
        // from GW1 — which is partly an outcome label for "who turned out to be
        // the club's main threat". It is worth 13% of the drafted squad's
        // season points, and almost nothing on rank correlation, so a
        // rank-only check does not notice it.
        penalties_order: null,
        // Stable across seasons; `id` is not. This is how a GW1 element is
        // matched to his record from the year before.
        code: +p.code,
      },
    ])
  );
  const fixturesBase = parseCsv(fs.readFileSync(path.join(DATA, "fixtures.csv"), "utf8"))
    .filter((f) => f.event !== "")
    .map((f) => ({
      id: +f.id,
      event: +f.event,
      team_h: +f.team_h,
      team_a: +f.team_a,
      team_h_difficulty: +f.team_h_difficulty,
      team_a_difficulty: +f.team_a_difficulty,
      kickoff_time: f.kickoff_time || null,
    }));
  const gwRaw = parseCsv(fs.readFileSync(path.join(DATA, "gws", "merged_gw.csv"), "utf8"));
  const byElement = new Map<number, Row[]>();
  for (const r of gwRaw) {
    const row: Row = {
      element: +r.element,
      round: +r.round,
      minutes: +r.minutes,
      starts: +(r.starts || 0),
      tp: +r.total_points,
      goals: +r.goals_scored,
      assists: +r.assists,
      bonus: +r.bonus,
      saves: +r.saves,
      ict: +r.ict_index,
      xp: +r.xP || 0,
      teamName: r.team ?? "",
      xg: +(r.expected_goals || 0),
      xa: +(r.expected_assists || 0),
      value: +r.value,
    };
    const a = byElement.get(row.element);
    if (a) a.push(row);
    else byElement.set(row.element, [row]);
  }
  for (const arr of byElement.values()) arr.sort((a, b) => a.round - b.round);
  const lastRound = Math.max(...gwRaw.map((r) => +r.round));
  // `merged_gw` names the club; the model wants the id. Both the full name and
  // the short name are indexed because the CSV has used each in different
  // seasons, and an unmatched name falls back to the end-of-season club rather
  // than to nothing.
  const teamIdByName = new Map<string, number>();
  for (const t of teams) {
    teamIdByName.set(t.name, t.id);
    teamIdByName.set(t.short_name, t.id);
  }
  return { teams, meta, fixturesBase, byElement, lastRound, teamIdByName };
}

type Season = ReturnType<typeof loadSeason>;

/**
 * Last season's record for every player in THIS season's game — the same thing
 * `fetchPastSeason` pulls from element-summary in the live app, rebuilt here
 * from the previous season's end-of-year snapshot.
 *
 * Without this the launch backtest measured a model the app does not ship: at
 * GW1 there is no current-season data at all, so a projection with no past
 * record is running almost entirely on price. Matching is by `code`, which
 * follows the player across seasons; `id` does not.
 */
function loadPreviousSeason(season: Season): Map<number, PastSeasonStats> | undefined {
  const [y1, y2] = SEASON.split("-").map((n) => +n);
  if (!Number.isFinite(y1) || !Number.isFinite(y2)) return undefined;
  const prevDir = path.resolve(__dirname, `../../fpl-data/data/${y1 - 1}-${String(y2 - 1).padStart(2, "0")}`);
  const file = path.join(prevDir, "players_raw.csv");
  if (!fs.existsSync(file)) return undefined;
  const prevName = `${y1 - 1}/${String(y2 - 1).padStart(2, "0")}`;
  const byCode = new Map<number, Record<string, string>>();
  for (const r of parseCsv(fs.readFileSync(file, "utf8"))) byCode.set(+r.code, r);

  const out = new Map<number, PastSeasonStats>();
  for (const [id, m] of season.meta) {
    if (m.element_type < 1 || m.element_type > 4) continue;
    const r = byCode.get(m.code);
    if (!r) {
      // Looked and found nothing: a new arrival. That is itself a signal, and
      // the live fetcher records it the same way.
      out.set(id, { points: 0, minutes: 0, plSeasons: 0, seasons: [] });
      continue;
    }
    const minutes = +r.minutes || 0;
    const starts = r.starts === "" || r.starts == null ? undefined : +r.starts;
    const dc = r.defensive_contribution === "" || r.defensive_contribution == null
      ? undefined
      : +r.defensive_contribution;
    out.set(id, {
      seasonName: prevName,
      points: +r.total_points || 0,
      minutes,
      starts,
      defensiveContribution: dc,
      goals: +r.goals_scored || 0,
      assists: +r.assists || 0,
      xg: r.expected_goals === "" ? undefined : +r.expected_goals,
      xa: r.expected_assists === "" ? undefined : +r.expected_assists,
      bonus: +r.bonus || 0,
      ict: +r.ict_index || 0,
      saves: +r.saves || 0,
      plSeasons: 1,
      lastSeason: { seasonName: prevName, minutes, starts },
      seasons: [{ seasonName: prevName, minutes, starts }],
    });
  }
  return out;
}

function buildStateAt(g: number, season: Season) {
  const { teams, meta, fixturesBase, byElement, teamIdByName } = season;
  const elements: Element[] = [];
  const recentStarts = new Map<number, number>();
  const actual = new Map<number, number>();
  const minutesAt = new Map<number, number>();
  for (const [id, all] of byElement) {
    const m = meta.get(id);
    if (!m || m.element_type < 1 || m.element_type > 4) continue;
    const past = all.filter((r) => r.round < g);
    const atG = all.filter((r) => r.round === g);
    if (past.length === 0 && atG.length === 0) continue;
    const cum = past.reduce(
      (s, r) => ({
        minutes: s.minutes + r.minutes,
        starts: s.starts + r.starts,
        points: s.points + r.tp,
        goals: s.goals + r.goals,
        assists: s.assists + r.assists,
        bonus: s.bonus + r.bonus,
        saves: s.saves + r.saves,
        ict: s.ict + r.ict,
        xg: s.xg + r.xg,
        xa: s.xa + r.xa,
      }),
      { minutes: 0, starts: 0, points: 0, goals: 0, assists: 0, bonus: 0, saves: 0, ict: 0, xg: 0, xa: 0 }
    );
    const price = atG[0]?.value ?? past[past.length - 1]?.value ?? 50;
    // The club as of the week being projected, falling back to the last week he
    // appeared and only then to the end-of-season file.
    const teamName = atG[0]?.teamName || past[past.length - 1]?.teamName || "";
    const team = teamIdByName.get(teamName) ?? m.team;
    // FPL's own published estimate for the round about to be played. It is set
    // before the deadline, so reading it at the state that precedes round `g` is
    // information the live app genuinely has. Roughly a fifth of round-1 rows
    // carry no value; those stay null, exactly as a live blank would.
    const epRaw = atG[0]?.xp ?? 0;
    const ep_next = epRaw > 0 ? epRaw.toFixed(1) : null;
    const recent = past.slice(-4);
    const form = recent.length ? recent.reduce((s, r) => s + r.tp, 0) / recent.length : 0;
    const played = past.filter((r) => r.minutes > 0).length;
    const ppg = played ? cum.points / played : 0;
    const last5 = past.slice(-5);
    if (last5.length) recentStarts.set(id, last5.filter((r) => r.starts > 0).length / last5.length);
    if (atG.length) {
      actual.set(id, atG.reduce((s, r) => s + r.tp, 0));
      minutesAt.set(id, atG.reduce((s, r) => s + r.minutes, 0));
    }
    elements.push({
      id,
      web_name: m.web_name,
      first_name: "",
      second_name: m.web_name,
      team,
      element_type: m.element_type,
      now_cost: price,
      cost_change_start: 0,
      form: form.toFixed(1),
      points_per_game: ppg.toFixed(1),
      total_points: cum.points,
      event_points: 0,
      status: "a",
      news: "",
      chance_of_playing_next_round: null,
      selected_by_percent: "0.0",
      minutes: cum.minutes,
      starts: cum.starts,
      goals_scored: cum.goals,
      assists: cum.assists,
      clean_sheets: 0,
      goals_conceded: 0,
      bonus: cum.bonus,
      ict_index: cum.ict.toFixed(1),
      expected_goals: cum.xg.toFixed(2),
      expected_assists: cum.xa.toFixed(2),
      expected_goal_involvements: (cum.xg + cum.xa).toFixed(2),
      expected_goals_conceded: "0",
      defensive_contribution: 0,
      ep_next,
      penalties_order: m.penalties_order,
      saves: cum.saves,
    });
  }
  // A real deadline per gameweek, an hour and a half before that round's first
  // kickoff. It used to be the empty string, and `""` is not null or undefined,
  // so the `??` chain in `projectAll` accepted it, `new Date("")` produced an
  // Invalid Date, and `getUTCFullYear()` produced NaN. NaN passes every `< `
  // guard downstream, so the pre-season minutes model was switched off for every
  // player in every backtest this harness has ever run — silently, with no error
  // and no obviously wrong number. Every measurement taken before this line
  // existed was taken against a model the app does not ship.
  const firstKickoff = new Map<number, string>();
  for (const f of fixturesBase) {
    if (!f.kickoff_time) continue;
    const cur = firstKickoff.get(f.event);
    if (!cur || f.kickoff_time < cur) firstKickoff.set(f.event, f.kickoff_time);
  }
  const deadlineFor = (ev: number) => {
    const k = firstKickoff.get(ev) ?? firstKickoff.get(1);
    const t = k ? Date.parse(k) : NaN;
    return Number.isFinite(t)
      ? new Date(t - 90 * 60 * 1000).toISOString()
      : `${SEASON.slice(0, 4)}-08-10T17:30:00Z`;
  };
  const bootstrap: Bootstrap = {
    events: Array.from({ length: season.lastRound }, (_, i) => ({
      id: i + 1,
      name: `GW${i + 1}`,
      deadline_time: deadlineFor(i + 1),
      finished: i + 1 < g,
      is_current: i + 1 === g - 1,
      is_next: i + 1 === g,
      average_entry_score: 0,
      highest_score: null,
    })),
    teams,
    elements,
    total_players: 1e7,
  };
  const fixtures: Fixture[] = fixturesBase.map((f) => ({
    ...f,
    finished: f.event < g,
    started: f.event < g,
    team_h_score: null,
    team_a_score: null,
  }));
  return { bootstrap, fixtures, recentStarts, actual, minutesAt };
}



/** Actual points scored by a squad this GW: best XI (by projected xp) + captain,
 * with auto-subs and vice takeover applied on REAL minutes. */
function actualGwPoints(
  squadIds: number[],
  elById: Map<number, Element>,
  xpNext: (id: number) => number,
  actual: Map<number, number>,
  minutes: Map<number, number>
): number {
  const squad = squadIds.map((id) => elById.get(id)!).filter(Boolean);
  const xi = pickBestXi(squad, xpNext);
  const starterIds = xi.starters.map((s) => s.element.id);
  const benchIds = xi.bench.map((s) => s.element.id);
  const typeOf = (id: number) => elById.get(id)!.element_type;
  const mins = (id: number) => minutes.get(id) ?? 0;
  const pts = (id: number) => actual.get(id) ?? 0;

  // Auto-subs: replace a 0-minute starter with the first eligible bench player.
  const effective = [...starterIds];
  const usedBench = new Set<number>();
  for (let i = 0; i < effective.length; i++) {
    const sid = effective[i];
    if (mins(sid) > 0) continue;
    const sType = typeOf(sid);
    for (const b of benchIds) {
      if (usedBench.has(b) || mins(b) === 0) continue;
      const bType = typeOf(b);
      if ((sType === 1) !== (bType === 1)) continue;
      const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
      for (const id of effective) counts[typeOf(id)]++;
      counts[sType]--;
      counts[bType]++;
      if (counts[1] !== 1 || !isValidFormation(counts[2], counts[3], counts[4])) continue;
      effective[i] = b;
      usedBench.add(b);
      break;
    }
  }

  let total = effective.reduce((s, id) => s + pts(id), 0);
  // Captain (vice takes over if captain didn't play).
  const cap = xi.captain?.element.id ?? null;
  const vice = xi.vice?.element.id ?? null;
  if (cap != null && effective.includes(cap) && mins(cap) > 0) total += pts(cap);
  else if (vice != null && effective.includes(vice) && mins(vice) > 0) total += pts(vice);
  return total;
}

describe(`${SEASON} full-season simulation`, () => {
  it("plays the season and counts actual points", { timeout: 900_000 }, () => {
    setActiveCalibration(IDENTITY_FACTORS);
    const season = loadSeason();
    const LAST = Math.min(season.lastRound, 38);

    // GW1 launch squad from pre-season info.
    const s1 = buildStateAt(1, season);
    const previous = process.env.NO_PAST ? undefined : loadPreviousSeason(season);
    const launch = buildLaunchSquad(s1.bootstrap, s1.fixtures, 1, 5, previous);
    const squad = launch.squad.map((e) => e.id);
    if (process.env.DUMP_LAUNCH) {
      console.log(JSON.stringify({
        cost: launch.cost,
        gk: s1.bootstrap.elements
          .filter((e) => e.element_type === 1)
          .map((e) => ({ n: e.web_name, p: e.now_cost,
            xp: +(launch.xp.get(e.id)?.next ?? 0).toFixed(2),
            prevMin: previous?.get(e.id)?.minutes ?? null }))
          .sort((a, b) => b.xp - a.xp)
          .slice(0, 12),
        squad: launch.squad.map((e) => ({
          n: e.web_name, pos: e.element_type, p: e.now_cost,
          xp: +(launch.xp.get(e.id)?.next ?? 0).toFixed(2),
          prevMin: previous?.get(e.id)?.minutes ?? null,
          prevStarts: previous?.get(e.id)?.starts ?? null,
        })),
      }, null, 1));
    }

    // Sanity assertions on the launch squad itself, not just on the points it
    // eventually scored. Both of these caught real bugs that every unit test
    // and the type checker were happy with, and both were only visible here.
    //
    // The first: a per-90 rate taken by plain division turned a one-minute
    // substitute appearance into ninety points per ninety, and the drafter
    // bought a squad of them at 28 projected points a head.
    // Named for what it is: the HIGHEST projection in the drafted squad, not the
    // lowest. The bound is 9 rather than the 12 it was written with, because the
    // best player in the whole pool projects between 6.1 and 7.0 across the four
    // seasons — a ceiling of 12 left 80% headroom above anything the model can
    // legitimately produce, so a milder version of the same bug would have walked
    // straight through it.
    const best = launch.squad.reduce(
      (w, e) => Math.max(w, launch.xp.get(e.id)?.next ?? 0), 0
    );
    expect(best).toBeLessThan(9);
    // The second: normalising each club's keepers so they summed to one start
    // divided every keeper in the game by about four, so none of them could
    // clear two points and the drafter simply bought the two cheapest in the
    // league. A squad's first-choice keeper has to be worth paying for.
    // Only asserted on the shipped configuration: NO_PAST is a diagnostic that
    // strips the record deliberately, and a keeper judged on price alone is
    // legitimately harder to tell apart from his deputy.
    if (previous) {
      const gkXp = launch.squad
        .filter((e) => e.element_type === 1)
        .map((e) => launch.xp.get(e.id)?.next ?? 0);
      expect(Math.max(...gkXp)).toBeGreaterThan(2.5);
    }
    if (process.env.RANK) {
      // A single squad's season total is one sample and swings by hundreds of
      // points on which premium happened to stay fit. To ask whether the
      // pre-season projection is actually BETTER, score every plausible pick
      // against what he went on to do — a few hundred samples instead of one.
      const seasonPts = new Map<number, number>();
      for (const [id, rows] of season.byElement) {
        seasonPts.set(id, rows.reduce((t, r) => t + r.tp, 0));
      }
      // Every player in the game at GW1, with NO condition on how the season
      // turned out. There used to be a `.filter(e => seasonPts > 0 || cost >= 45)`
      // here, which reads like harmless noise-removal and is not: it deletes
      // precisely the cheap players the model was wrong to like, so the model is
      // never charged for its worst mistakes. On the honest pool the numbers are
      // materially lower, and `priceR` below exists so they can be read against
      // something — a projection that cannot beat sorting the list by price is
      // not adding anything.
      const cand = s1.bootstrap.elements
        .filter((e) => e.element_type >= 1 && e.element_type <= 4)
        .map((e) => ({
          id: e.id, pos: e.element_type,
          xp: launch.xp.get(e.id)?.next ?? 0,
          price: e.now_cost,
          got: seasonPts.get(e.id) ?? 0,
        }));
      type Cand = { xp: number; price: number; got: number };
      const spearman = (a: Cand[], pred: "xp" | "price" = "xp") => {
        const rank = (key: "xp" | "price" | "got") => {
          const idx = a.map((_, i) => i).sort((i, j) => a[j][key] - a[i][key]);
          const r = new Array(a.length).fill(0);
          idx.forEach((v, k) => (r[v] = k + 1));
          return r;
        };
        const x = rank(pred), y = rank("got"), n = a.length;
        const mx = (n + 1) / 2;
        let num = 0, dx = 0, dy = 0;
        for (let i = 0; i < n; i++) {
          num += (x[i] - mx) * (y[i] - mx);
          dx += (x[i] - mx) ** 2; dy += (y[i] - mx) ** 2;
        }
        return num / Math.sqrt(dx * dy);
      };
      const byPos: Record<string, number> = {};
      for (const pos of [1, 2, 3, 4]) {
        const sub = cand.filter((c) => c.pos === pos);
        byPos[`p${pos}`] = +spearman(sub).toFixed(3);
      }
      // Split by whether the player HAS a previous season at all. If each half
      // ranks well on its own but the pooled figure collapses, the fault is not
      // the ranking — it is that the two halves are scored on different scales
      // and interleave wrongly when merged.
      const has = cand.filter((c) => (previous?.get(c.id)?.minutes ?? 0) > 0);
      const non = cand.filter((c) => (previous?.get(c.id)?.minutes ?? 0) <= 0);
      const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
      const split = {
        hasN: has.length, hasR: +spearman(has).toFixed(3),
        hasXp: +mean(has.map((c) => c.xp)).toFixed(2),
        hasGot: +mean(has.map((c) => c.got)).toFixed(1),
        hasPriceR: +spearman(has, "price").toFixed(3),
        nonN: non.length, nonR: +spearman(non).toFixed(3),
        nonPriceR: +spearman(non, "price").toFixed(3),
        nonXp: +mean(non.map((c) => c.xp)).toFixed(2),
        nonGot: +mean(non.map((c) => c.got)).toFixed(1),
      };
      // What the drafter is really judged on: of the 15 it could have picked,
      // how many season points did its actual 15 collect?
      console.log(JSON.stringify({
        rank: process.env.NO_PAST ? "nopast" : "past",
        season: SEASON, n: cand.length,
        all: +spearman(cand).toFixed(3),
        // The baseline the model has to beat to have earned its existence.
        priceR: +spearman(cand, "price").toFixed(3),
        ...byPos, ...split,
        squadSeasonPts: launch.squad.reduce((t, e) => t + (seasonPts.get(e.id) ?? 0), 0),
      }));
    }
    let bank = 1000 - launch.squad.reduce((sum, e) => sum + e.now_cost, 0);
    let ft = 1;
    const buyPrice = new Map<number, number>(launch.squad.map((e) => [e.id, e.now_cost]));

    let modelTotal = 0;
    const setForgetSquad = [...squad];
    let setForgetTotal = 0;
    let transfersMade = 0;
    // Projected XI xP (incl. captain) vs realized — to calibrate the
    // "realistic team score" display factor.
    let projectedXiTotal = 0;

    for (let gw = 1; gw <= LAST; gw++) {
      const st = buildStateAt(gw, season);
      const elById = new Map(st.bootstrap.elements.map((e) => [e.id, e]));
      const xp = projectAll({
        bootstrap: st.bootstrap,
        fixtures: st.fixtures,
        nextEvent: gw,
        horizon: 5,
        recentStarts: st.recentStarts,
      });
      const xpNext = (id: number) => xp.get(id)?.next ?? 0;

      // --- Transfers (model manager), GW2+; free transfers only, no hits ---
      if (gw > 1) {
        const owned: OwnedPlayer[] = squad
          .map((id) => elById.get(id))
          .filter((e): e is Element => !!e)
          .map((e) => ({
            element: e,
            purchasePrice: buyPrice.get(e.id) ?? e.now_cost,
            sellPrice: e.now_cost, // simplification: no sell tax
            pickPosition: 1,
            isCaptain: false,
            isViceCaptain: false,
          }));
        if (owned.length === 15) {
          const res = optimize({
            bootstrap: st.bootstrap,
            fixtures: st.fixtures,
            owned,
            bank,
            freeTransfers: Math.min(ft, 2),
            nextEvent: gw,
            horizon: 5,
            maxTransfers: Math.min(ft, 2),
            recentStarts: st.recentStarts,
          });
          const free = res.plans.filter((p) => p.hitCost === 0 && p.gainVsKeep > 0.5);
          const best = free.sort((a, b) => b.gainVsKeep - a.gainVsKeep)[0];
          if (best) {
            for (const m of best.transfers) {
              const idx = squad.indexOf(m.out.id);
              if (idx < 0) continue;
              squad[idx] = m.in.id;
              bank += m.outSell - m.inCost;
              buyPrice.set(m.in.id, m.inCost);
              transfersMade++;
            }
            ft = Math.max(0, ft - best.transfers.length);
          }
        }
        ft = Math.min(5, ft + 1);
      }

      // --- Score the gameweek (both managers) ---
      projectedXiTotal += pickBestXi(
        squad.map((id) => elById.get(id)!).filter(Boolean),
        xpNext
      ).totalXp;
      modelTotal += actualGwPoints(squad, elById, xpNext, st.actual, st.minutes ?? st.minutesAt);
      // Set & forget: captain by best season PPG, else same engine.
      const ppgNext = (id: number) => parseFloat(elById.get(id)?.points_per_game ?? "0") || 0;
      setForgetTotal += actualGwPoints(
        setForgetSquad,
        new Map(buildStateAt(gw, season).bootstrap.elements.map((e) => [e.id, e])),
        ppgNext,
        st.actual,
        st.minutesAt
      );
    }

    const report = {
      season: SEASON,
      gameweeks: LAST,
      modelManagerPoints: Math.round(modelTotal),
      setAndForgetPoints: Math.round(setForgetTotal),
      transfersMade,
      perGwModel: (modelTotal / LAST).toFixed(1),
      projectedXiTotal: Math.round(projectedXiTotal),
      // How much higher realized XI points ran vs projected xP.
      realizedVsProjected: (modelTotal / projectedXiTotal).toFixed(3),
    };
    fs.writeFileSync(
      path.resolve(__dirname, `../sim-report-${SEASON}.json`),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report));

    expect(report.modelManagerPoints).toBeGreaterThan(report.setAndForgetPoints * 0.8);
    expect(report.modelManagerPoints).toBeGreaterThan(1500);
  });
});
