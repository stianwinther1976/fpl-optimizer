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
import { projectAll, XP_CONFIG } from "../src/lib/xp";
import { pickBestXi, optimize, buildLaunchSquad } from "../src/lib/optimizer";
import { isValidFormation, MAX_PER_CLUB, SQUAD_COMPOSITION, VALID_FORMATIONS } from "../src/lib/rules";
import { launchPool, LAUNCH_QUOTA } from "../src/lib/pool";

/**
 * The pool size to measure at. `QUOTA=210` scales the shipped per-position quota
 * to that total, preserving its shape, so the sweep recorded in `pool.ts` can be
 * re-run without editing the shipped file — which is how that table went stale
 * against the code the first time. Unset means "whatever ships".
 */
function sweepQuota(): Record<number, number> {
  const want = Number(process.env.QUOTA);
  if (!want || !Number.isFinite(want)) return LAUNCH_QUOTA;
  const base = Object.values(LAUNCH_QUOTA).reduce((a, b) => a + b, 0);
  const out: Record<number, number> = {};
  for (const [pos, n] of Object.entries(LAUNCH_QUOTA)) out[+pos] = Math.round((n * want) / base);
  return out;
}
import { setActiveCalibration, IDENTITY_FACTORS } from "../src/lib/calibration";
import type {
  Bootstrap,
  Element,
  ElementType,
  Fixture,
  OwnedPlayer,
  PastSeasonStats,
  RecentForm,
  Team,
} from "../src/lib/types";

const SEASON = process.env.SEASON ?? "2025-26";
// `OWNW=0` switches the pre-season ownership prior off, back to price alone;
// any other value sweeps its weight. Kept as an env switch for the same reason
// `QUOTA` is: the alternative is hand-editing `xp.ts` between runs, which is
// how a recorded table went stale against the code once already. Unset means
// whatever ships.
// `OHI` and `OGAMMA` sweep the shape of the market map the weight is applied
// to; without them a weight sweep cannot tell "the crowd is worth less" from
// "the curve is wrong".
const numEnv = (name: string): number | null => {
  const raw = process.env[name];
  // `Number("")` is 0 and finite, so an empty or blank value would silently set
  // the weight to zero and get recorded as a swept result. An unparseable one
  // must be loud rather than ignored, for the same reason.
  if (raw == null || raw.trim() === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name}=${raw} is not a number`);
  return v;
};
// Same generic override the backtest has. It is here mainly so the simulator's
// own NOISE can be measured: nudging a constant that should barely matter and
// watching the season total is the only way to know whether a +80 is a result
// or a different butterfly. Without it, a sweep run against this harness is
// silently a no-op, which is a worse failure than not having it at all.
//
// WHAT THAT MEASUREMENT SAYS, so nobody re-derives it from a single run.
//
// This harness replays a season one transfer decision at a time, and a single
// changed decision in October propagates to every squad thereafter. The season
// total is therefore a STEP FUNCTION of any input, with wide flat plateaus and
// occasional large jumps — not a smooth response you can read a gradient from.
//
// Sweeping `subProb`, which has nothing to do with anything else being tested,
// over 2024-25:
//
//   0.05  0.08  0.10  0.12  0.15  0.17  0.20  0.25  0.30
//   2200  2356  2345  2210  2148  2116  2121  2121  2123
//
// A 240-point range, non-monotone, from one irrelevant constant. Inside a
// plateau it is dead flat: 0.1500 through 0.1540 in steps of 0.0001 all return
// exactly 2148. So a null result here means nothing, and so does a +80.
//
// The corollary, learned the hard way: a placebo arm does not rescue this. Two
// were tried against the suspension term — the same discount applied to the
// wrong players, at matched prevalence, six seeds each. Both under-perturbed;
// most seeds returned the untouched season total to the point, because a random
// player is rarely near a decision boundary while a real one-booking-away
// player usually is. The real term then "beat" the placebos in three seasons of
// four — which is roughly a 1-in-9 event under the null anyway, not the 1-in-100
// an earlier draft of this comment claimed, and in any case an artefact of a
// null that perturbs less than the thing it is standing in for. Both the
// dramatic number and the inference were wrong; the conclusion below survives
// them because it never depended on either.
//
// Treat the season total as evidence only when it moves by several hundred
// across all four seasons in the same direction. Anything smaller belongs in
// the backtest's rank metrics or in a direct measurement against the archive.
//
// What the suspension term actually did to these totals, stated because the
// tempting summary — "sim totals unchanged" — is true only relative to the
// previous review round and invites the wrong reading:
//
//                2022-23  2023-24  2024-25  2025-26
//   before          2142     2361     2312     2106
//   after           2222     2447     2148     2150
//   delta            +80      +86     -164      +44
//
// Net +46 over four seasons, and one season worse by 7%. Nobody should read
// that as the term earning its place, and nobody should read the -164 as it
// failing either: both sit comfortably inside the 240-point range that
// `subProb` produces on its own in that very season. The case for the term is
// the direct archive measurement at the top of `suspensionMissProbs`, not this
// table. The table is here so that the -164 is on the record rather than
// discovered later by someone diffing the reports.
//
// Two limits of the sweep hook below, so a future sweep does not silently do
// nothing. It is placed BEFORE the dedicated OWNW/OHI/OGAMMA/GKOWNW/GKSLOT
// overrides, so those win on a key collision. And it only reaches top-level
// NUMERIC config keys, which means `bookingRate` and `banThresholds` — arrays —
// cannot be swept with it at all.
if (process.env.XPSET) {
  for (const kv of process.env.XPSET.split(",")) {
    const [k, v] = kv.split("=");
    const cfg = XP_CONFIG as unknown as Record<string, number>;
    if (!(k in cfg) || typeof cfg[k] !== "number") throw new Error(`XPSET: no numeric XP_CONFIG key "${k}"`);
    // Loud, not silent. `XPSET=gwDecay` or `XPSET=gwDecay=abc` used to write NaN
    // straight into the config, and a NaN there does not crash — it quietly
    // turns every projection into NaN and reports a season total built from
    // nothing. A sweep that fails has to fail visibly.
    const n = Number(v);
    if (v == null || v === "" || !Number.isFinite(n)) {
      throw new Error(`XPSET: "${k}" needs a finite numeric value, got "${v ?? ""}"`);
    }
    cfg[k] = n;
    console.log(`XPSET ${k}=${n}`);
  }
}
const ownW = numEnv("OWNW");
if (ownW != null) XP_CONFIG.priorPStartOwnWeight = ownW;
const ownHi = numEnv("OHI");
if (ownHi != null) XP_CONFIG.priorPStartOwnRange = [XP_CONFIG.priorPStartOwnRange[0], ownHi];
const ownGamma = numEnv("OGAMMA");
if (ownGamma != null) XP_CONFIG.priorPStartOwnGamma = ownGamma;
// `GKOWNW` and `GKSLOT` do the same job for the keeper depth chart. `GKSLOT`
// especially has to be swept here rather than offline: it scales every
// keeper's projected minutes at once, so it moves not just which keeper the
// chart prefers but whether a keeper is worth drafting against an outfielder,
// and no club-level accuracy measure can see that.
const gkOwnW = numEnv("GKOWNW");
if (gkOwnW != null) XP_CONFIG.gkPreseason = { ...XP_CONFIG.gkPreseason, ownWeight: gkOwnW };
const gkSlot = numEnv("GKSLOT");
if (gkSlot != null) XP_CONFIG.gkPreseason = { ...XP_CONFIG.gkPreseason, slotMass: gkSlot };
const gkBeta = numEnv("GKBETA");
if (gkBeta != null) XP_CONFIG.gkPreseason = { ...XP_CONFIG.gkPreseason, beta: gkBeta };
// A stand-in for the season's actual manager count, used only as a denominator
// for ownership.
//
// The first version of this comment said the exact figure did not matter because
// only relative order does. That is wrong, and wrong in a way worth keeping a
// note about: the value is rendered through `.toFixed(1)` to match what the FPL
// API publishes, which makes it a QUANTIZER, and the quantization grid moves
// with the denominator. Re-running 2023-24 against its real implied figure
// (~8.2e6 — Haaland's 7,200,159 selections were about 87% ownership, which 1e7
// renders as 72%) swaps 11 of the 420 players in the pool; 2024-25 and 2025-26
// move 4 and 5. That is inside the noise of anything measured here, but it is
// not zero, and "the scale cannot matter" was the kind of claim that stops
// people checking.
//
// The rounding is kept rather than dropped, because reproducing FPL's dense tie
// block at "0.0" is the whole reason the harness is a fair test of `launchPool`.
const TOTAL_PLAYERS = 1e7;
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
  yellows: number;
  saves: number;
  ict: number;
  xg: number;
  xa: number;
  value: number;
  /** How many managers owned him that week. Recorded at the deadline, so it is
   *  the crowd's pre-deadline view and contains no information about how the
   *  round then went — the same standing as `value` and `xp` beside it. It is
   *  what `launchPool` ranks by once FPL has wiped `starts`, so hardcoding it
   *  to zero left the pool sorting on price alone. */
  selected: number;
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
      yellows: +(r.yellow_cards || 0),
      saves: +r.saves,
      ict: +r.ict_index,
      xp: +r.xP || 0,
      teamName: r.team ?? "",
      xg: +(r.expected_goals || 0),
      xa: +(r.expected_assists || 0),
      value: +r.value,
      selected: +(r.selected || 0),
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
  const recentForm = new Map<number, RecentForm>();
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
        yellows: s.yellows + r.yellows,
        saves: s.saves + r.saves,
        ict: s.ict + r.ict,
        xg: s.xg + r.xg,
        xa: s.xa + r.xa,
      }),
      { minutes: 0, starts: 0, points: 0, goals: 0, assists: 0, bonus: 0, yellows: 0, saves: 0, ict: 0, xg: 0, xa: 0 }
    );
    const price = atG[0]?.value ?? past[past.length - 1]?.value ?? 50;
    // Ownership as of the round being projected, on the same footing as price.
    // `?? ` will not catch a row that exists with a blank `selected` column,
    // because line 198 parses that to 0 and 0 is not nullish — the player would
    // silently become 0.0%-owned instead of inheriting last week's figure. No
    // row in the current archive does this, but it is the same class of bug the
    // `deadline_time` note below was written about, so fall back on falsiness.
    const selected = atG[0]?.selected || past[past.length - 1]?.selected || 0;
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
    if (last5.length) {
      const started = last5.filter((r) => r.starts > 0);
      recentForm.set(id, {
        startShare: started.length / last5.length,
        minsPerGame: last5.reduce((s, r) => s + r.minutes, 0) / last5.length,
        minsPerStart:
          started.length > 0
            ? started.reduce((s, r) => s + r.minutes, 0) / started.length
            : null,
      });
    }
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
      selected_by_percent: ((selected / TOTAL_PLAYERS) * 100).toFixed(1),
      minutes: cum.minutes,
      starts: cum.starts,
      goals_scored: cum.goals,
      assists: cum.assists,
      clean_sheets: 0,
      goals_conceded: 0,
      bonus: cum.bonus,
      yellow_cards: cum.yellows,
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
    total_players: TOTAL_PLAYERS,
  };
  const fixtures: Fixture[] = fixturesBase.map((f) => ({
    ...f,
    finished: f.event < g,
    started: f.event < g,
    team_h_score: null,
    team_a_score: null,
  }));
  return { bootstrap, fixtures, recentForm, actual, minutesAt };
}



/** Actual points scored by a squad this GW: best XI (by projected xp) + captain,
 * with auto-subs and vice takeover applied on REAL minutes. */
function actualGwPoints(
  squadIds: number[],
  elById: Map<number, Element>,
  xpNext: (id: number) => number,
  actual: Map<number, number>,
  minutes: Map<number, number>,
  /** Optional accumulator: how often the bench was actually needed, and what it
   * contributed. Only read by the bench experiment below; the season sim itself
   * passes nothing and is unaffected. */
  out?: { subs: number; subPoints: number; blanks: number }
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
    if (out) out.blanks++;
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
      if (out) {
        out.subs++;
        out.subPoints += pts(b);
      }
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
    let previous = process.env.NO_PAST ? undefined : loadPreviousSeason(season);
    if (previous && process.env.POOL) {
      // POOL=1 measures what the app can actually see.
      //
      // Last season's record arrives one HTTP request per player, so the app
      // does not fetch all ~690 of them — `launchPool` chooses a few hundred
      // and everyone else is projected with no record at all. Handing
      // `previous` to the whole list, as the default run does, grades a model
      // that has strictly more information than the shipped one.
      //
      // The default is deliberately left unrestricted anyway, for two reasons.
      // It is the more sensitive instrument for a model change — under POOL
      // most of the cheap band is players the model cannot say anything about,
      // so real improvements get diluted by a constant. And every measurement
      // recorded in a comment in this repo was taken without it, so switching
      // the default would quietly invalidate all of them.
      //
      // What matters is that the two now agree where it counts. At the quota
      // this file's `launchPool` currently ships, POOL=1 reproduces the managed
      // total (8805), the set-and-forget total (6496) and the launch squad's
      // season points (6315) exactly; only `all` (.623 -> .594) and `cheapR`
      // (.577 -> .535) move, and they move because of players no squad
      // contains. The full sweep is recorded in `src/lib/pool.ts`.
      const keep = new Set(launchPool(s1.bootstrap.elements, sweepQuota()));
      const trimmed = new Map<number, PastSeasonStats>();
      for (const [id, v] of previous) if (keep.has(id)) trimmed.set(id, v);
      previous = trimmed;
    }
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
      // What the drafted XV went on to DO, as distinct from what it scored.
      //
      // A squad's season points is one sample and swings by hundreds on which
      // premium stayed fit — the comment above says so and then the file went on
      // to use it as the headline anyway. Minutes and starts are the same fifteen
      // players measured on a far less noisy scale, and they are the thing a
      // pre-season minutes model is actually claiming to predict. A change that
      // moves points by less than its own run-to-run spread but moves starts
      // consistently in every season has done something real.
      const seasonMins = new Map<number, number>();
      const seasonStarts = new Map<number, number>();
      for (const [id, rows] of season.byElement) {
        seasonPts.set(id, rows.reduce((t, r) => t + r.tp, 0));
        seasonMins.set(id, rows.reduce((t, r) => t + r.minutes, 0));
        seasonStarts.set(id, rows.reduce((t, r) => t + r.starts, 0));
      }
      // Every player in the game at GW1, with NO condition on how the season
      // turned out. There used to be a `.filter(e => seasonPts > 0 || cost >= 45)`
      // here, which reads like harmless noise-removal and is not: it deletes
      // precisely the cheap players the model was wrong to like, so the model is
      // never charged for its worst mistakes. On the honest pool the numbers are
      // materially lower, and `priceR` below exists so they can be read against
      // something — a projection that cannot beat sorting the list by price is
      // not adding anything.
      if (process.env.POOL_DIAG) {
        // How many of a season's best players the app never even looks up.
        //
        // The table in `src/lib/pool.ts` that these numbers back was taken at the
        // RETIRED quota of 210, so a bare `POOL_DIAG=1` today prints something
        // smaller than anything recorded there. Reproduce the recorded row with
        // `POOL_DIAG=1 QUOTA=210`; see `sweepQuota`.
        const keep = new Set(launchPool(s1.bootstrap.elements, sweepQuota()));
        const prevAll = loadPreviousSeason(season);
        const rows = s1.bootstrap.elements
          .filter((e) => e.element_type >= 1 && e.element_type <= 4)
          .map((e) => ({
            id: e.id, n: e.web_name, pos: e.element_type, price: e.now_cost,
            own: parseFloat(e.selected_by_percent) || 0,
            chg: e.cost_change_start ?? 0,
            inPool: keep.has(e.id),
            got: seasonPts.get(e.id) ?? 0,
            prevMin: prevAll?.get(e.id)?.minutes ?? 0,
          }))
          .sort((a, b) => b.got - a.got);
        const top = rows.slice(0, 150);
        console.log(JSON.stringify({
          diag: SEASON,
          poolN: keep.size,
          missedTop50: top.slice(0, 50).filter((r) => !r.inPool).length,
          missedTop150: top.filter((r) => !r.inPool).length,
          missed: top.filter((r) => !r.inPool).map((r) => ({
            n: r.n, pos: r.pos, price: r.price, own: r.own, chg: r.chg,
            got: r.got, prevMin: r.prevMin,
          })),
        }));
      }
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
        // MIDRANKS. Ties are not a corner case here, they are most of the data:
        // a season has about sixteen distinct prices and two hundred players at
        // the cheapest one, and a fifth of the pool finishes on exactly zero
        // points. Breaking ties by array index gives tied players distinct ranks
        // in BOTH vectors, in the same order, which manufactures agreement out
        // of nothing — and it flattered the price baseline hardest, because
        // price is the tied-est variable of the three. Correcting it costs the
        // model most of its apparent margin in 2022/23, the season its own
        // source comment calls the cleanest case.
        const rank = (key: "xp" | "price" | "got") => {
          const idx = a.map((_, i) => i).sort((i, j) => a[j][key] - a[i][key]);
          const r = new Array(a.length).fill(0);
          let i = 0;
          while (i < idx.length) {
            let j = i;
            while (j + 1 < idx.length && a[idx[j + 1]][key] === a[idx[i]][key]) j++;
            const mid = (i + j) / 2 + 1;
            for (let k = i; k <= j; k++) r[idx[k]] = mid;
            i = j + 1;
          }
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
      // Spearman over the whole pool is dominated by the easy comparisons. Most
      // pairs in it are a £12.5m forward against a £4.0m fourth-choice
      // defender, and getting those the right way round takes no model at all —
      // which is what `priceR` says. The decisions a draft actually turns on
      // are made WITHIN a price band, between players FPL has already declared
      // equivalent, and the pooled figure can rise while in-band ordering gets
      // worse.
      //
      // That is not hypothetical. Shrinking a thin player's own rate toward the
      // price prior necessarily compresses the gap between a productive and an
      // unproductive fringe player, because price is the thing they have in
      // common. These two bands are what says whether the compression costs
      // more than the stability buys, and `priceR` inside each band is the
      // baseline that makes them readable: within a band price barely varies,
      // so a model that has stopped adding information falls toward it.
      //
      // The first thing they were pointed at was that exact worry, raised in
      // review against the continuous price/model blend that replaced
      // `minMinutesForModel`. A two-player probe suggested the blend had cut
      // the separation between a productive and an unproductive £5.0m fringe
      // player from 1.89x to 1.51x, and that pooled Spearman was too coarse to
      // notice. Measured on the band it targets, the opposite is true —
      // threshold first, blend second:
      //
      //   cheapR (<= £5.5m)   2022-23  2023-24  2024-25  2025-26   mean
      //     threshold           0.453    0.554    0.608    0.617   0.558
      //     blend               0.458    0.577    0.630    0.643   0.577
      //   topR (dearest 150)
      //     threshold           0.387    0.438    0.443    0.373   0.410
      //     blend               0.387    0.434    0.440    0.376   0.409
      //
      // Better in all four seasons among the cheap players, flat among the
      // expensive ones. Compression and information loss are not the same
      // thing: shrinking a 400-minute sample toward the price prior discards
      // mostly noise, and the narrower ordering that survives is more accurate
      // than the wider one it replaced.
      const byPrice = [...cand].sort((a, b) => b.price - a.price);
      const cheap = cand.filter((c) => c.price <= 55);
      const top150 = byPrice.slice(0, 150);
      const bands = {
        cheapN: cheap.length,
        cheapR: +spearman(cheap).toFixed(3),
        cheapPriceR: +spearman(cheap, "price").toFixed(3),
        topR: +spearman(top150).toFixed(3),
        topPriceR: +spearman(top150, "price").toFixed(3),
      };
      // What the drafter is really judged on: of the 15 it could have picked,
      // how many season points did its actual 15 collect?
      console.log(JSON.stringify({
        rank: process.env.NO_PAST ? "nopast" : "past",
        season: SEASON, n: cand.length,
        all: +spearman(cand).toFixed(3),
        // The baseline the model has to beat to have earned its existence.
        priceR: +spearman(cand, "price").toFixed(3),
        ...byPos, ...split, ...bands,
        squadSeasonPts: launch.squad.reduce((t, e) => t + (seasonPts.get(e.id) ?? 0), 0),
        squadStarts: launch.squad.reduce((t, e) => t + (seasonStarts.get(e.id) ?? 0), 0),
        // How many of the fifteen turned out to be regulars, and how many never
        // got going at all. `< 900` is ten full matches: below that a pick was
        // not a rotation risk, it was a mistake about the role.
        squadRegulars: launch.squad.filter((e) => (seasonStarts.get(e.id) ?? 0) >= 25).length,
        squadFlops: launch.squad.filter((e) => (seasonMins.get(e.id) ?? 0) < 900).length,
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
        recentForm: st.recentForm,
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
            recentForm: st.recentForm,
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
      modelTotal += actualGwPoints(squad, elById, xpNext, st.actual, st.minutesAt);
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

  // -------------------------------------------------------------------------
  // "Best possible eleven, cheapest possible bench" — measured, not argued.
  //
  // The rejected-experiment note above `buildSquadWithinBudget` already shows
  // that judging swaps by best-XI score rather than sum-of-15 loses points on
  // the live model. But that experiment changed the OBJECTIVE OF A GREEDY
  // DOWNGRADE LOOP at bench weights of 0.15-0.85; it never built the extreme
  // squad — a genuine argmax over XI-only, where the bench is worth literally
  // nothing and the search is free to fill it with £4.0m players who will never
  // start a match. That squad is what people mean by "stack the eleven, punt
  // the bench", and it had never been played out over a real season.
  //
  // Both builders here see the SAME candidate pool (top 40 per position by
  // totalDiscounted, exactly what `buildSquadWithinBudget` uses) and the SAME
  // per-player values. The only thing that differs is what is being maximised,
  // which is the whole point: any gap is the objective, not the search.
  //
  // THE RESULT — and the first version of this comment got it badly wrong,
  // which is worth leaving in because the mistake is the instructive part.
  //
  // That version climbed from 3 seeds per objective and reported the single
  // squad that came back: 6673 -> 6296, "worse in three seasons of four". An
  // audit killed it. The XI-only climb had not converged (0.88/1.81/7.80 xP
  // short of what restarts reach, worst in exactly the season with the biggest
  // reported loss), and the squad it named was one arbitrary draw from a
  // distribution hundreds of points wide — in 2024-25, the 2nd worst of 30
  // equally valid XI-only optima. Both the magnitude AND the 3-of-4 count were
  // artefacts of where a 3-seed climb happened to land.
  //
  // Properly sampled — 240 jittered restarts, equal effort on both objectives,
  // every distinct optimum played out — the medians are:
  //
  //                          2022-23  2023-24  2024-25  2025-26   total
  //   sum-of-15    median       1806     1840     1474     1292    6412
  //   XI+captain   median       1812     1762     1393     1387    6354
  //   delta                       +6      -78      -81      +95     -58
  //   (family size)             5/9    12/26     4/45     7/21
  //
  // -58 points over four seasons, worse in two of four. The effect this
  // experiment was built to find is not there. Punting the bench is not
  // measurably wrong.
  //
  // What IS there, and is robust, is the size of everything else. Within a
  // single objective's family — squads that score the SAME on the thing they
  // were built to maximise — set-and-forget totals span:
  //
  //   sum-of-15    1683-1969   1351-1977   1379-1636   1206-1502
  //   XI+captain   1738-1968   1614-1843   1252-1751   1208-1578
  //
  // 230 to 626 points of spread, against a 6-to-95 point gap between the
  // objectives. WHICH players you buy outweighs WHAT RULE you bought them by,
  // by roughly an order of magnitude. Any conclusion drawn from one squad per
  // objective — which is what the first version of this comment was, and what
  // most published squad comparisons are — is reading noise.
  //
  // The bench mechanism is real even though the bottom line is not. Points
  // entering the total THROUGH an auto-sub, median per family:
  //
  //   sum-of-15     179      111       45       96     = 431
  //   XI+captain    131       52        9       71     = 263
  //
  // A punted bench really does forfeit ~40% of the auto-sub route, and at the
  // £17.5m floor the reserves are not merely cheap but non-playing (2024-25:
  // 9 points from the bench across an entire season). It is just that the money
  // saved buys a better eleven, and the two effects very nearly cancel. The
  // actionable version is therefore neither extreme: buy a bench that PLAYS,
  // not a bench that SCORES — cheap nailed-on starters, not third-choice
  // £4.0m reserves. That is roughly where the shipped builder already sits.
  //
  // `objVsRealSpearman` is the finding that limits all of this. Within a family,
  // ranking by the objective against ranking by real points scored comes out
  // -0.60/+0.43/-0.40/+0.64 for sum-of-15 and -0.17/-0.18/-0.02/+0.15 for
  // XI+captain: at or below zero in six of eight. Among squads the model
  // considers near-equivalent, a HIGHER projection does not buy more real
  // points. Both objectives are estimating through the same noise, which is why
  // choosing between them changes so little.
  //
  // Consistent with that: the shipped GREEDY builder scores 1806/1853/1445/1574
  // = 6678, ahead of both hill-climbed families' medians. A sharper search on a
  // noisy estimate concentrates the budget on whichever players the model is
  // most wrong about — the same conclusion the note above
  // `buildSquadWithinBudget` reached from the opposite direction.
  //
  // Caveats that stay: n=4 seasons; set-and-forget only, which is the harshest
  // regime for a punted bench because it cannot transfer away from a dead one
  // (the managed run for a MILDER version of this objective was measured
  // separately at 8729 -> 8516, and carries the same one-draw caveat this
  // rewrite was needed to fix). `benchFloorTrue` is 165 against the 175 this
  // experiment can reach, so a real punt is cheaper than anything built here —
  // which flatters the punt, and points the residual the same way.
  //
  // Run: SEASON=2024-25 BENCH=1 npx vitest run --config vitest.sim.config.ts \
  //        -t "cheapest bench" --disable-console-intercept
  // -------------------------------------------------------------------------
  it.runIf(!!process.env.BENCH)(
    "cheapest bench vs sum-of-15, played out over the real season",
    { timeout: 900_000 },
    () => {
      setActiveCalibration(IDENTITY_FACTORS);
      const season = loadSeason();
      const LAST = Math.min(season.lastRound, 38);
      const s1 = buildStateAt(1, season);
      const previous = process.env.NO_PAST ? undefined : loadPreviousSeason(season);

      const launch = buildLaunchSquad(s1.bootstrap, s1.fixtures, 1, 5, previous);
      const xp = launch.xp;
      const value = (id: number) => xp.get(id)?.totalDiscounted ?? 0;

      const pool: Record<number, Element[]> = { 1: [], 2: [], 3: [], 4: [] };
      for (const e of s1.bootstrap.elements) {
        if (e.status === "u") continue;
        if ((xp.get(e.id)?.total ?? 0) <= 0) continue;
        pool[e.element_type].push(e);
      }
      for (const p of [1, 2, 3, 4])
        pool[p] = pool[p].sort((a, b) => value(b.id) - value(a.id)).slice(0, 40);
      const MIN_PRICE: Record<number, number> = {};
      for (const p of [1, 2, 3, 4]) MIN_PRICE[p] = Math.min(...pool[p].map((e) => e.now_cost));
      const ALL = [pool[1], pool[2], pool[3], pool[4]].flat();

      const costOf = (squad: Element[]) => squad.reduce((a, e) => a + e.now_cost, 0);
      const isLegal = (squad: Element[]) => {
        if (squad.length !== 15) return false;
        const cnt: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
        const club = new Map<number, number>();
        for (const e of squad) {
          cnt[e.element_type]++;
          club.set(e.team, (club.get(e.team) ?? 0) + 1);
        }
        if (costOf(squad) > 1000) return false;
        for (const t of [1, 2, 3, 4] as ElementType[])
          if (cnt[t] !== SQUAD_COMPOSITION[t]) return false;
        return ![...club.values()].some((n) => n > MAX_PER_CLUB);
      };

      /** Legal 15 by an arbitrary ranking, with a reserve guard so the greedy
       * run cannot paint itself into a corner it can no longer afford to fill. */
      const greedy = (rank: (e: Element) => number, seed: Element[] = []) => {
        const squad = [...seed];
        const used = new Set(seed.map((e) => e.id));
        const need: Record<number, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
        const club = new Map<number, number>();
        let cost = 0;
        for (const e of seed) {
          need[e.element_type]--;
          club.set(e.team, (club.get(e.team) ?? 0) + 1);
          cost += e.now_cost;
        }
        if (Object.values(need).some((n) => n < 0)) return null;
        const reserveAfter = (pos: number) => {
          let r = 0;
          for (const p of [1, 2, 3, 4]) r += (need[p] - (p === pos ? 1 : 0)) * MIN_PRICE[p];
          return r;
        };
        for (const e of [...ALL].sort((a, b) => rank(b) - rank(a))) {
          if (Object.values(need).every((n) => n === 0)) break;
          if (used.has(e.id)) continue;
          const pos = e.element_type;
          if (need[pos] <= 0) continue;
          if ((club.get(e.team) ?? 0) >= MAX_PER_CLUB) continue;
          if (cost + e.now_cost + reserveAfter(pos) > 1000) continue;
          squad.push(e);
          used.add(e.id);
          need[pos]--;
          club.set(e.team, (club.get(e.team) ?? 0) + 1);
          cost += e.now_cost;
        }
        return Object.values(need).every((n) => n === 0) ? squad : null;
      };

      const canSwap = (squad: Element[], i: number, inEl: Element, cost: number) => {
        const out = squad[i];
        if (inEl.id === out.id) return false;
        if (inEl.element_type !== out.element_type) return false;
        if (squad.some((s, j) => j !== i && s.id === inEl.id)) return false;
        if (cost - out.now_cost + inEl.now_cost > 1000) return false;
        let n = 0;
        for (let j = 0; j < squad.length; j++) if (j !== i && squad[j].team === inEl.team) n++;
        return n < MAX_PER_CLUB;
      };

      /** Hill climb with paired swaps. The paired neighbourhood is not optional:
       * at exactly £100.0m every single upgrade is unaffordable and every single
       * downgrade loses points, so a budget-tight local optimum looks global. An
       * earlier version of this same climb in `ytcompare.test.ts` without it
       * under-reported the reachable optimum by 2.55 xP. */
      const climb = (objective: (squad: Element[]) => number, seeds: Element[][]) => {
        let bestSquad: Element[] | null = null;
        let bestScore = -Infinity;
        for (const start of seeds) {
          let squad = [...start];
          let cost = costOf(squad);
          if (!isLegal(squad)) continue;
          let cur = objective(squad);
          for (let iter = 0; iter < 300; iter++) {
            let improved = false;
            for (let i = 0; i < squad.length && !improved; i++) {
              for (const inEl of pool[squad[i].element_type]) {
                if (!canSwap(squad, i, inEl, cost)) continue;
                const trial = [...squad];
                trial[i] = inEl;
                const s = objective(trial);
                if (s > cur + 1e-9) {
                  cost = cost - squad[i].now_cost + inEl.now_cost;
                  squad = trial;
                  cur = s;
                  improved = true;
                  break;
                }
              }
            }
            if (improved) continue;
            for (let i = 0; i < squad.length && !improved; i++) {
              for (const cheap of pool[squad[i].element_type]) {
                if (cheap.now_cost >= squad[i].now_cost) continue;
                if (!canSwap(squad, i, cheap, cost)) continue;
                const mid = [...squad];
                mid[i] = cheap;
                const midCost = cost - squad[i].now_cost + cheap.now_cost;
                for (let j = 0; j < mid.length && !improved; j++) {
                  if (j === i) continue;
                  for (const up of pool[mid[j].element_type]) {
                    if (up.now_cost <= mid[j].now_cost) continue;
                    if (!canSwap(mid, j, up, midCost)) continue;
                    const trial = [...mid];
                    trial[j] = up;
                    const s = objective(trial);
                    if (s > cur + 1e-9) {
                      squad = trial;
                      cost = midCost - mid[j].now_cost + up.now_cost;
                      cur = s;
                      improved = true;
                      break;
                    }
                  }
                }
                if (improved) break;
              }
            }
            if (!improved) break;
          }
          if (cur > bestScore) {
            bestScore = cur;
            bestSquad = squad;
          }
        }
        return bestSquad;
      };

      const sum15 = (squad: Element[]) => squad.reduce((a, e) => a + value(e.id), 0);
      /** Named for what it IS. `pickBestXi().totalXp` adds the captain's xp a
       * second time, so this is XI + captain, not the bare eleven — the earlier
       * name `xiOnly` hid that the builder double-weights its single best
       * player. Kept as the objective anyway, because the captain's double score
       * is a real part of what an eleven returns; only the label was wrong. */
      const xiPlusCaptain = (squad: Element[]) => pickBestXi(squad, value).totalXp;

      // A deliberately bench-punting seed, so the XI-only climb starts from the
      // structure it is supposed to find rather than having to walk there.
      const cheapBenchSeed = (() => {
        // 3-4-3 benches 1 GK + 2 DEF + 1 MID: buy those four at the floor first.
        const cheapest = (pos: number, n: number, taken: Set<number>) =>
          [...pool[pos]]
            .sort((a, b) => a.now_cost - b.now_cost)
            .filter((e) => !taken.has(e.id))
            .slice(0, n);
        const taken = new Set<number>();
        const seed: Element[] = [];
        for (const [pos, n] of [
          [1, 1],
          [2, 2],
          [3, 1],
        ] as const)
          for (const e of cheapest(pos, n, taken)) {
            seed.push(e);
            taken.add(e.id);
          }
        return greedy((e) => value(e.id), seed);
      })();

      // ----------------------------------------------------------------
      // A FAMILY of local optima per objective, not one draw.
      //
      // The first version of this experiment climbed from 3 seeds per
      // objective and reported the single resulting squad. An audit showed
      // that was measuring the wrong thing twice over. The XI-only climb had
      // not converged (it was 0.88/0.00/1.81/7.80 xP short of what restarts
      // reach, worst in exactly the season with the largest reported loss),
      // and the squad it returned was one arbitrary draw from a distribution
      // ~300 real points wide — in 2024-25 the 2nd-worst of 30 equally-valid
      // XI-only optima. Both the headline magnitude and the "worse in 3 of 4
      // seasons" count were artefacts of where a 3-seed climb happened to land.
      //
      // So: jittered restarts, EQUAL effort on both objectives, every distinct
      // optimum played out, and the summary reported over the family. The
      // comparison is now median-to-median, which is what "should you build
      // this kind of squad" actually asks — not "is this one squad good".
      // ----------------------------------------------------------------
      let rngState = 20260726;
      const rand = () => (rngState = (rngState * 1103515245 + 12345) % 2147483648) / 2147483648;
      // 60 restarts with a +/-40% jitter left 2022-23 with a single sum-of-15
      // optimum and two XI-only ones, which the family-size guard below caught:
      // a median over n=1 is the one-draw reporting this rewrite exists to kill.
      // Wider jitter and more restarts, because the whole finding turns on the
      // WIDTH of these families and an under-sampled family looks narrow.
      const RESTARTS = Number(process.env.RESTARTS ?? 240);

      const family = (objective: (squad: Element[]) => number) => {
        const found = new Map<string, { squad: Element[]; obj: number }>();
        const add = (s: Element[] | null) => {
          if (!s) return;
          const climbed = climb(objective, [s]);
          if (!climbed) return;
          const key = climbed
            .map((e) => e.id)
            .sort((a, b) => a - b)
            .join(",");
          if (!found.has(key)) found.set(key, { squad: climbed, obj: objective(climbed) });
        };
        add(launch.squad);
        add(greedy((e) => value(e.id)));
        add(cheapBenchSeed);
        for (let r = 0; r < RESTARTS; r++) add(greedy((e) => value(e.id) * (0.3 + 1.4 * rand())));
        return [...found.values()].sort((a, b) => b.obj - a.obj);
      };

      const sum15Family = family(sum15);
      const xiFamily = family(xiPlusCaptain);
      expect(sum15Family.length, "sum-of-15 family is empty").toBeGreaterThan(0);
      expect(xiFamily.length, "XI-only family is empty").toBeGreaterThan(0);
      for (const f of [...sum15Family, ...xiFamily])
        expect(isLegal(f.squad), "a family member is not a legal squad").toBe(true);

      // The true bench floor, over ALL elements rather than the top-40 pool.
      // Taking it from the pool reported 175 and was simply wrong: the pool's
      // cheapest DEF is £4.5m against a true £4.0m, so a real punt is cheaper
      // than anything this experiment can build. That direction matters — it
      // means the punted squad measured here has a BETTER bench than an actual
      // punt, so any loss it records is an under-estimate.
      const trueMin: Record<number, number> = {};
      for (const p of [1, 2, 3, 4]) {
        const c = s1.bootstrap.elements.filter((e) => e.element_type === p).map((e) => e.now_cost);
        trueMin[p] = c.length ? Math.min(...c) : 0;
      }
      const floorBench = (mp: Record<number, number>) =>
        Math.min(
          ...VALID_FORMATIONS.map(
            ([d, m, f]) => mp[1] + (5 - d) * mp[2] + (5 - m) * mp[3] + (3 - f) * mp[4]
          )
        );

      interface Played {
        squad: Element[];
        obj: number;
        cost: number;
        benchCost: number;
        total: number;
        acc: { subs: number; subPoints: number; blanks: number };
        ids: number[];
      }
      const prep = (f: { squad: Element[]; obj: number }): Played => {
        const xi = pickBestXi(f.squad, value);
        return {
          ...f,
          cost: costOf(f.squad),
          benchCost: xi.bench.reduce((a, b) => a + b.element.now_cost, 0),
          total: 0,
          acc: { subs: 0, subPoints: 0, blanks: 0 },
          ids: f.squad.map((e) => e.id),
        };
      };
      // The app's actual squad, scored as its own row. It is NOT reliably a
      // member of the sum-of-15 family: the climb improves on it in two of the
      // four seasons, so looking it up by id inside the family returned null
      // there and the reference point silently vanished from the report.
      const shippedRow = prep({ squad: launch.squad, obj: sum15(launch.squad) });
      const played = { sum15: sum15Family.map(prep), xi: xiFamily.map(prep) };
      const everyone = [...played.sum15, ...played.xi, shippedRow];

      // Play every family member through the real season, set-and-forget.
      //
      // The weekly XI is picked by season points-per-game — except in GW1,
      // where `points_per_game` is 0 for EVERY player because no match has been
      // played. That left GW1's formation, XI and captain decided purely by
      // squad-array order through stable-sort tie-breaks, and it was not
      // symmetric: the bench-punt seed pushes £4.0m players into the low array
      // slots, so the punted squad captained its own reserve goalkeeper. It was
      // worth -35 points to the punt across the four seasons, none of it the
      // effect under study. GW1 now falls back to the model's own valuation,
      // which is what a manager actually has in front of them in GW1 anyway.
      for (let gw = 1; gw <= LAST; gw++) {
        const st = buildStateAt(gw, season);
        const elById = new Map(st.bootstrap.elements.map((e) => [e.id, e]));
        const rawPpg = (id: number) => parseFloat(elById.get(id)?.points_per_game ?? "0") || 0;
        const anyPpg = [...elById.keys()].some((id) => rawPpg(id) > 0);
        const rank = anyPpg ? rawPpg : value;
        for (const e of everyone)
          e.total += actualGwPoints(e.ids, elById, rank, st.actual, st.minutesAt, e.acc);
      }

      const stat = (rows: Played[], pick: (r: Played) => number) => {
        const v = rows.map(pick).sort((a, b) => a - b);
        const mid = Math.floor(v.length / 2);
        return {
          n: v.length,
          min: Math.round(v[0]),
          median: Math.round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2),
          mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
          max: Math.round(v[v.length - 1]),
        };
      };
      /** Does a higher score on the objective buy more real points WITHIN a
       * family? If this is negative the objective is not merely a worse target,
       * it is anti-correlated with the thing it is a proxy for. */
      const objVsReal = (rows: Played[]) => {
        if (rows.length < 3) return null;
        const rk = (xs: number[]) => {
          const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
          const r = new Array(xs.length).fill(0);
          idx.forEach(([, i], k) => (r[i] = k));
          return r;
        };
        const a = rk(rows.map((r) => r.obj));
        const b = rk(rows.map((r) => r.total));
        const n = rows.length;
        const d2 = a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);
        return +(1 - (6 * d2) / (n * (n * n - 1))).toFixed(3);
      };

      const summary = (label: string, rows: Played[]) => ({
        objective: label,
        objectiveScore: stat(rows, (r) => r.obj * 100),
        setAndForget: stat(rows, (r) => r.total),
        benchCost: stat(rows, (r) => r.benchCost),
        benchRoutePoints: stat(rows, (r) => r.acc.subPoints),
        objVsRealSpearman: objVsReal(rows),
      });

      console.log(
        JSON.stringify(
          {
            season: SEASON,
            gameweeks: LAST,
            restarts: RESTARTS,
            shippedGreedy: {
              setAndForget: Math.round(shippedRow.total),
              sum15: +sum15(launch.squad).toFixed(2),
              benchCost: shippedRow.benchCost,
              benchRoutePoints: shippedRow.acc.subPoints,
            },
            benchFloorPool: floorBench(MIN_PRICE),
            benchFloorTrue: floorBench(trueMin),
            families: [summary("sum-of-15", played.sum15), summary("XI+captain only", played.xi)],
          },
          null,
          1
        )
      );

      // Guards that keep the run meaningful rather than merely green.
      // The XI-only family must actually have punted the bench relative to the
      // sum-of-15 family, or the two labels name the same squads and the
      // comparison is vacuous.
      const medBench = (rows: Played[]) => stat(rows, (r) => r.benchCost).median;
      expect(medBench(played.xi)).toBeLessThan(medBench(played.sum15));
      // And each family must be a family, not one point: a single optimum means
      // the restarts did nothing and we are back to reporting one draw.
      expect(played.xi.length, "XI-only search found a single optimum").toBeGreaterThan(2);
      expect(played.sum15.length, "sum-of-15 search found a single optimum").toBeGreaterThan(2);
    }
  );
});
