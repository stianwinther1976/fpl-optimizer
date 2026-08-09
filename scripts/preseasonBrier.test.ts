/**
 * PRE-SEASON MINUTES HARNESS.
 *
 * The in-season backtest (`scripts/backtest.test.ts`) starts at GW2 and never
 * passes a `pastSeason`, so it cannot see the pre-season path at all: every
 * constant under "pre-season" in `XP_CONFIG` is invisible to it, and a change
 * to `preseasonEvidence`, `preseasonMinutes`, `impliedStarts` or
 * `clubStartMass` produces a completely green backtest with zero report churn.
 * Several of those constants nevertheless carry measured tables in their doc
 * comments. The apparatus that produced them was never checked in.
 *
 * `preseasonClubStartMass` says it out loud about a different constant — "a
 * measurement with no reproducible apparatus is just an assertion" — and then
 * the pre-season measurements were left in exactly that state. This file is
 * that apparatus.
 *
 * WHAT IT DOES. For each archived season it reconstructs the state as it stood
 * at the GW1 deadline — element list, GW1 prices, GW1 ownership, prior-season
 * histories assembled from the earlier archives — runs the REAL `projectAll`,
 * reads each player's `pStart` out of `XP_DEBUG.minutes`, and scores it against
 * whether he actually started, one row per player-gameweek over GW1-5.
 *
 *   npx vitest run -c vitest.preseason.config.ts --disable-console-intercept
 *
 * The protocol matches the one the config comments quote: launch pool, outfield
 * only, GW1-5, pooled over the seasons that have at least one prior season on
 * the archive (2023/24 onward — 2022/23 has none and is uninformative).
 *
 * TWO LIMITS TO READ BEFORE QUOTING IT.
 *
 *  1. The archive begins at 2022/23, so a 2023/24 run sees one prior season
 *     where the live model sees six. `preseasonSeasonDecay` weights the sixth
 *     at 0.05, so this is not nothing: a veteran's record is thinner here than
 *     in production, and "record-less" is a slightly larger group. It applies
 *     identically to every variant, so comparisons are sound; absolute Brier is
 *     not the live model's.
 *  2. `starts` is read straight from the archive, which records it honestly
 *     from 2022/23 on. The live API reports `starts: 0` for every season up to
 *     2021/22 — see `XP_CONFIG.startsRecordedFrom`. That defect therefore
 *     cannot appear here at all, which is why the fix for it is justified by
 *     the snapshot counts rather than by this harness.
 */
import { beforeAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { projectAll, XP_CONFIG, XP_DEBUG } from "../src/lib/xp";
import { launchPool } from "../src/lib/pool";
import { fetchPastSeason } from "../src/lib/fpl";
import type {
  Bootstrap,
  Element,
  ElementType,
  Fixture,
  PastSeasonStats,
  Team,
} from "../src/lib/types";

const ROOT = path.resolve(__dirname, "../../fpl-data/data");

/** Seasons to score. Each needs at least one earlier season on the archive. */
const SEASONS = (process.env.PRESEASONS ?? "2023-24,2024-25,2025-26").split(",");

/** How many gameweeks of outcome each pre-season projection is graded against. */
const GRADE_GWS = Number(process.env.PRESEASON_GWS ?? 5);

// ---------- CSV ------------------------------------------------------------
// Deliberately a copy of the parser in `backtest.test.ts` rather than a shared
// import. That file is a validated instrument whose reports are committed;
// refactoring it to share code with a new harness would put churn into it for
// no measurement gain.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = r[i] ?? ""));
    return o;
  });
}

const csv = (season: string, ...rel: string[]) =>
  parseCsv(fs.readFileSync(path.join(ROOT, season, ...rel), "utf8"));

/** "2024-25" -> 2024. The archive's folder names are the season's start year. */
const startYear = (season: string) => parseInt(season.slice(0, 4), 10);

/** Every archived season strictly older than `season`, newest first. */
function priorSeasons(season: string): string[] {
  return fs
    .readdirSync(ROOT)
    .filter((d) => /^\d{4}-\d{2}$/.test(d) && startYear(d) < startYear(season))
    .sort((a, b) => startYear(b) - startYear(a));
}

// ---------- season totals by player CODE ------------------------------------
/**
 * A player's whole-season line from a completed season, keyed by `code`.
 *
 * `code` and not `id`: FPL renumbers `id` every summer, so joining seasons on
 * it silently pairs one player's history onto another's. `web_name` is worse
 * still — it is not unique and it changes.
 */
interface SeasonLine {
  minutes: number;
  starts: number;
  points: number;
  goals: number;
  assists: number;
  bonus: number;
  ict: number;
  saves: number;
  xg: number;
  xa: number;
}

function seasonLinesByCode(season: string): Map<number, SeasonLine> {
  const out = new Map<number, SeasonLine>();
  for (const p of csv(season, "players_raw.csv")) {
    const code = +p.code;
    if (!Number.isFinite(code)) continue;
    out.set(code, {
      minutes: +p.minutes || 0,
      starts: +p.starts || 0,
      points: +p.total_points || 0,
      goals: +p.goals_scored || 0,
      assists: +p.assists || 0,
      bonus: +p.bonus || 0,
      ict: +p.ict_index || 0,
      saves: +p.saves || 0,
      xg: +(p.expected_goals || 0),
      xa: +(p.expected_assists || 0),
    });
  }
  return out;
}

// ---------- the GW1 state ---------------------------------------------------
interface PreseasonState {
  bootstrap: Bootstrap;
  fixtures: Fixture[];
  pastSeason: Map<number, PastSeasonStats>;
  /** elementId -> rounds in 1..GRADE_GWS he started (a DGW can contribute 2). */
  started: Map<number, Map<number, boolean>>;
  /** Rounds that actually exist in the archive, within the grading window. */
  rounds: number[];
  /** Whether this season's element list could be filtered to the GW1 squad. */
  joinFiltered: boolean;
}

function buildPreseasonState(season: string): PreseasonState {
  const teams: Team[] = csv(season, "teams.csv").map((t) => ({
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

  const raw = csv(season, "players_raw.csv");

  // GW1 price and GW1 ownership, which is the whole reason this harness exists
  // separately from the backtest: `buildStateAt` sets `selected_by_percent` to
  // a flat "0.0" for every player and says so, which makes it blind to the
  // entire ownership family — and `priorPStart`, the thing under test here,
  // is built on ownership percentiles.
  const gw1 = csv(season, "gws", "gw1.csv");
  const priceAt1 = new Map<number, number>();
  const selectedAt1 = new Map<number, number>();
  for (const r of gw1) {
    const id = +r.element;
    if (!priceAt1.has(id)) priceAt1.set(id, +r.value || 0);
    if (!selectedAt1.has(id)) selectedAt1.set(id, +r.selected || 0);
  }
  // The archive stores `selected` as a headcount; the bootstrap field the model
  // reads is a percentage. Every manager picks exactly fifteen players, so the
  // headcounts sum to 15x the number of managers — an identity, not an
  // estimate, and it does not need `total_players` (which the archive's
  // per-round dumps do not carry).
  let selectedTotal = 0;
  for (const v of selectedAt1.values()) selectedTotal += v;
  const managers = selectedTotal / 15;

  // WHO WAS ON THE ELEMENT LIST AT THE GW1 DEADLINE.
  //
  // `players_raw.csv` is the END-OF-SEASON dump, so it contains January
  // signings who were not selectable in August. Leaving them in is not a
  // rounding error: `clubStartMass` fires on the SUM of a club's `pStart`
  // against a target, so every extra body raises the sum and stops the
  // mechanism firing. Measured, the difference is the whole regime — with the
  // unfiltered list only 14 of 60 club-seasons are short of target, against 12
  // of 20 clubs in the live 2026/27 snapshot.
  //
  // BOTH SIDES OF THAT COMPARISON ARE ALL-OUTFIELD, and an earlier version put
  // 15 of 20 on the right-hand side, which is the LAUNCH-POOL live figure. The
  // `LIVE=1` block prints both and warns against exactly this substitution: a
  // pool-only sum is structurally short, because `clubStartMass` allocates
  // over the whole element list, so summing a subset must come out under
  // target. Comparing a full-list count against a pool-only one overstates the
  // live shortfall and makes the archive look unrepresentative when it is not.
  //
  // `team_join_date` answers the question directly and is present from 2024-25
  // on. 2023-24 does not carry it, so that season keeps the unfiltered list;
  // the bias there is conservative, since a club wrongly judged to have enough
  // start mass is a club this mechanism never touches.
  const firstKick = csv(season, "fixtures.csv")
    .map((f) => f.kickoff_time)
    .filter(Boolean)
    .sort()[0];
  const hasJoinDate = raw.some((p) => p.team_join_date && p.team_join_date !== "None");
  const joinedByGw1 = (p: Record<string, string>): boolean => {
    const d = p.team_join_date;
    if (!d || d === "None" || !firstKick) return true;
    return d <= firstKick.slice(0, 10);
  };

  const elements: Element[] = [];
  for (const p of raw) {
    const id = +p.id;
    const type = +p.element_type as ElementType;
    if (!(type >= 1 && type <= 4)) continue;
    if (hasJoinDate && !joinedByGw1(p)) continue;
    // A player with no GW1 row was not in a matchday squad that week. He is
    // still on the element list and still selectable, so he belongs in the
    // population; his end-of-season price is the only one on record and is
    // used as a fallback. Ownership falls back to zero rather than to his
    // end-of-season figure, because a late-season bandwagon is an outcome.
    // The 50 is a fallback for a missing `now_cost` column, and it used to be
    // written `?? +p.now_cost ?? 50`, which could never produce it: `+x` returns
    // a number for every input, so the second `??` was dead and a missing column
    // yielded `NaN` — a price that then propagated silently into every prior in
    // the run. `Number.isFinite` is the test that was meant.
    const eosPrice = +p.now_cost;
    const price = priceAt1.get(id) ?? (Number.isFinite(eosPrice) ? eosPrice : 50);
    const ownPct = managers > 0 ? (100 * (selectedAt1.get(id) ?? 0)) / managers : 0;
    elements.push({
      id,
      web_name: p.web_name,
      first_name: "",
      second_name: p.web_name,
      team: +p.team,
      element_type: type,
      now_cost: price,
      // Frozen until the GW1 deadline in the real game, so zero is correct
      // rather than merely unavailable.
      cost_change_start: 0,
      // EVERY IN-SEASON COUNTER IS ZERO, AND THAT IS THE POINT. FPL wipes them
      // in July and the model's pre-season branch keys on exactly that
      // (`teamGames <= 0`). Filling any of these from `players_raw.csv` would
      // be filling them with the season's OUTCOME.
      form: "0.0",
      points_per_game: "0.0",
      total_points: 0,
      event_points: 0,
      status: "a",
      news: "",
      chance_of_playing_next_round: null,
      selected_by_percent: ownPct.toFixed(1),
      minutes: 0,
      starts: 0,
      goals_scored: 0,
      assists: 0,
      clean_sheets: 0,
      goals_conceded: 0,
      bonus: 0,
      yellow_cards: 0,
      ict_index: "0.0",
      expected_goals: "0",
      expected_assists: "0",
      expected_goal_involvements: "0",
      expected_goals_conceded: "0",
      defensive_contribution: 0,
      ep_next: null,
      // Set-piece order is a genuine pre-season signal (it is published before
      // a ball is kicked) and `priorPStart` uses it as a one-sided floor.
      penalties_order: p.penalties_order ? +p.penalties_order : null,
      corners_and_indirect_freekicks_order: p.corners_and_indirect_freekicks_order
        ? +p.corners_and_indirect_freekicks_order
        : null,
      direct_freekicks_order: p.direct_freekicks_order ? +p.direct_freekicks_order : null,
      saves: 0,
    });
  }

  const fixtures: Fixture[] = csv(season, "fixtures.csv")
    .filter((f) => f.event !== "")
    .map((f) => ({
      id: +f.id,
      event: +f.event,
      team_h: +f.team_h,
      team_a: +f.team_a,
      team_h_difficulty: +f.team_h_difficulty,
      team_a_difficulty: +f.team_a_difficulty,
      kickoff_time: f.kickoff_time || null,
      finished: false,
      started: false,
      team_h_score: null,
      team_a_score: null,
    }));

  const bootstrap: Bootstrap = {
    // `deadline_time` is left empty exactly as `buildStateAt` leaves it, so
    // `seasonStartYear` resolves off the first fixture's kickoff instead. That
    // path is load-bearing and documented at the top of `projectAll`; a
    // synthetic non-empty date here would hide a regression in it.
    events: Array.from({ length: 38 }, (_, i) => ({
      id: i + 1,
      name: `Gameweek ${i + 1}`,
      deadline_time: "",
      finished: false,
      is_current: false,
      is_next: i === 0,
      average_entry_score: 0,
      highest_score: null,
    })),
    teams,
    elements,
    total_players: Math.round(managers) || 10_000_000,
  };

  // ---- prior-season histories, joined on `code` ----------------------------
  const codeOf = new Map<number, number>();
  for (const p of raw) codeOf.set(+p.id, +p.code);
  const priors = priorSeasons(season).map((s) => ({ name: s, lines: seasonLinesByCode(s) }));

  const pastSeason = new Map<number, PastSeasonStats>();
  for (const el of elements) {
    const code = codeOf.get(el.id);
    if (code == null) continue;
    const seasons: { seasonName: string; minutes: number; starts: number }[] = [];
    let newest: (SeasonLine & { name: string }) | null = null;
    for (const p of priors) {
      const line = p.lines.get(code);
      if (!line) continue;
      seasons.push({ seasonName: p.name, minutes: line.minutes, starts: line.starts });
      if (newest == null) newest = { ...line, name: p.name };
    }
    // A player absent from every prior archive has NO Premier League record on
    // this harness's evidence, and the model must be told that as a fact rather
    // than left to infer it from a missing key — `preseasonEvidence` treats an
    // absent `pastSeason` entry as "we never looked" and falls back to the
    // bootstrap counters, which are zero here. Those two states produce
    // different answers and only one of them is true.
    pastSeason.set(el.id, {
      seasonName: newest?.name,
      points: newest?.points ?? 0,
      minutes: newest?.minutes ?? 0,
      starts: newest?.starts,
      goals: newest?.goals,
      assists: newest?.assists,
      bonus: newest?.bonus,
      ict: newest?.ict,
      saves: newest?.saves,
      xg: newest?.xg,
      xa: newest?.xa,
      plSeasons: seasons.length,
      seasons: seasons.length > 0 ? seasons : undefined,
    });
  }

  // ---- outcomes ------------------------------------------------------------
  const started = new Map<number, Map<number, boolean>>();
  const rounds: number[] = [];
  for (let g = 1; g <= GRADE_GWS; g++) {
    const file = path.join(ROOT, season, "gws", `gw${g}.csv`);
    if (!fs.existsSync(file)) continue;
    const rowsG = csv(season, "gws", `gw${g}.csv`);
    if (rowsG.length === 0) continue;
    rounds.push(g);
    for (const r of rowsG) {
      const id = +r.element;
      const m = started.get(id) ?? new Map<number, boolean>();
      // A double gameweek gives one player two rows in one round. "Did he
      // start this round" is one question, so the rows are OR-ed rather than
      // counted; counting them would weight a DGW player twice in the Brier.
      m.set(g, (m.get(g) ?? false) || (+r.starts || 0) > 0);
      started.set(id, m);
    }
  }

  return { bootstrap, fixtures, pastSeason, started, rounds, joinFiltered: hasJoinDate };
}

// ---------- scoring ---------------------------------------------------------
interface Row {
  season: string;
  club: number;
  element: number;
  round: number;
  p: number;
  y: number;
  hasEvidence: boolean;
}

function score(rows: Row[]): { n: number; brier: number; mean: number; obs: number } {
  if (rows.length === 0) return { n: 0, brier: NaN, mean: NaN, obs: NaN };
  let s = 0;
  let mp = 0;
  let my = 0;
  for (const r of rows) {
    s += (r.p - r.y) ** 2;
    mp += r.p;
    my += r.y;
  }
  return { n: rows.length, brier: s / rows.length, mean: mp / rows.length, obs: my / rows.length };
}

/**
 * Paired bootstrap over the difference in Brier, clustered on CLUB-SEASON.
 *
 * Clustered because the thing under test is a club-level accounting rule: every
 * player at a club moves together when it fires, so resampling players
 * independently would treat twenty correlated rows as twenty facts and report
 * an interval several times too tight.
 *
 * The RNG is seeded rather than `Math.random` so that a re-run reproduces the
 * interval exactly. It is mulberry32, and the choice is not cosmetic: the
 * obvious textbook LCG (`seed = (seed * 1103515245 + 12345) & 0x7fffffff`) is
 * arithmetically WRONG in JavaScript. `seed * 1103515245` reaches ~2.4e18,
 * far past `Number.MAX_SAFE_INTEGER` (9.007e15), so the product is rounded to
 * the nearest representable double BEFORE the mask is applied — and the bits
 * that rounding destroys are exactly the low bits the mask keeps. Measured, it
 * cycled with period 10,466 and its 60-bucket histogram spanned 3322..5004
 * against 4000 expected (±16σ). Every interval this file printed before
 * 2026-07-30 came from that generator and had to be regenerated.
 *
 * mulberry32 stays inside int32 throughout by using `Math.imul`, so no
 * intermediate ever leaves the exactly-representable range.
 */
function pairedBootstrap(a: Row[], b: Row[], iters = 4000): { mean: number; lo: number; hi: number } {
  if (a.length !== b.length) {
    throw new Error(`pairedBootstrap needs aligned rows: ${a.length} vs ${b.length}`);
  }
  const key = (r: Row) => `${r.season}#${r.club}`;
  const groups = new Map<string, { da: number; db: number; n: number }>();
  for (let i = 0; i < a.length; i++) {
    const k = key(a[i]);
    const g = groups.get(k) ?? { da: 0, db: 0, n: 0 };
    g.da += (a[i].p - a[i].y) ** 2;
    g.db += (b[i].p - b[i].y) ** 2;
    g.n++;
    groups.set(k, g);
  }
  const gs = [...groups.values()];
  let seed = 20260730;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const diffs: number[] = [];
  for (let it = 0; it < iters; it++) {
    let da = 0;
    let db = 0;
    let n = 0;
    for (let i = 0; i < gs.length; i++) {
      const g = gs[Math.floor(rnd() * gs.length)];
      da += g.da;
      db += g.db;
      n += g.n;
    }
    diffs.push(n > 0 ? (db - da) / n : 0);
  }
  diffs.sort((x, y) => x - y);
  let da = 0;
  let db = 0;
  let n = 0;
  for (const g of gs) {
    da += g.da;
    db += g.db;
    n += g.n;
  }
  return {
    mean: (db - da) / n,
    lo: diffs[Math.floor(0.025 * iters)],
    hi: diffs[Math.floor(0.975 * iters)],
  };
}

/** One pass of the real model over one season's GW1 state. */
function runSeason(season: string, st: PreseasonState): Row[] {
  const poolIds = new Set(launchPool(st.bootstrap.elements));
  XP_DEBUG.minutes = new Map();
  projectAll({
    bootstrap: st.bootstrap,
    fixtures: st.fixtures,
    nextEvent: 1,
    horizon: 1,
    pastSeason: st.pastSeason,
  });
  const mm = XP_DEBUG.minutes!;
  XP_DEBUG.minutes = null;

  const rows: Row[] = [];
  for (const el of st.bootstrap.elements) {
    // Outfield only: the keeper depth chart is a separate mechanism with its
    // own normalisation, and `clubStartMass` explicitly excludes keepers to
    // avoid counting the same shirt twice.
    if (el.element_type < 2 || el.element_type > 4) continue;
    if (!poolIds.has(el.id)) continue;
    const m = mm.get(el.id);
    if (!m) continue;
    for (const g of st.rounds) {
      rows.push({
        season,
        club: el.team,
        element: el.id,
        round: g,
        p: m.pStart,
        y: st.started.get(el.id)?.get(g) ? 1 : 0,
        hasEvidence:
          (m as unknown as { hasEvidence?: boolean }).hasEvidence === true,
      });
    }
  }
  return rows;
}

describe("pre-season minutes model", () => {
  const states = new Map<string, PreseasonState>();
  const stateOf = (s: string) => {
    let st = states.get(s);
    if (!st) {
      st = buildPreseasonState(s);
      states.set(s, st);
    }
    return st;
  };

  /**
   * A guard on the apparatus itself, not on the model.
   *
   * Every number this file reports is worthless if the reconstructed GW1 state
   * is wrong, and the failure mode is silent: a mis-parsed ownership column or
   * a season whose `gw1.csv` is empty produces a clean run and a meaningless
   * Brier. These are the four properties that would have caught the mistakes
   * actually made while building it.
   */
  it("reconstructs a GW1 state that is pre-season, priced and owned", () => {
    for (const s of SEASONS) {
      const st = stateOf(s);
      const out = st.bootstrap.elements.filter((e) => e.element_type >= 2);
      expect(st.rounds.length, `${s}: graded rounds`).toBeGreaterThanOrEqual(5);
      // No in-season counter may be populated, or the model is not pre-season.
      expect(out.every((e) => e.minutes === 0 && e.starts === 0 && e.total_points === 0)).toBe(true);
      // Ownership must carry ORDER. This is the exact gap documented in
      // `buildStateAt`, where the column is flat and silently disables the
      // whole ownership family.
      const own = out.map((e) => parseFloat(e.selected_by_percent));
      expect(new Set(own.map((o) => o.toFixed(1))).size, `${s}: distinct ownership`).toBeGreaterThan(20);
      expect(Math.max(...own), `${s}: max ownership %`).toBeGreaterThan(10);
      expect(Math.max(...own), `${s}: max ownership %`).toBeLessThan(101);
      // Prices must be GW1 prices, which for outfielders always span 3.8-15.0.
      const cost = out.map((e) => e.now_cost);
      expect(Math.min(...cost)).toBeGreaterThanOrEqual(35);
      expect(Math.max(...cost)).toBeLessThanOrEqual(160);
      // A prior-season record must actually have been joined, or every player
      // is record-less and the harness is measuring the price prior alone.
      const withRecord = [...st.pastSeason.values()].filter((p) => (p.plSeasons ?? 0) > 0);
      expect(withRecord.length, `${s}: players with a prior season`).toBeGreaterThan(200);
    }
  });

  /**
   * How many clubs the correction can actually reach, measured with it OFF.
   *
   * This is the harness's own regime check. `clubStartMass` only fires on a
   * club whose outfielders' `pStart` sums BELOW the target, so a population
   * that quietly inflates those sums measures a mechanism that mostly does not
   * run — which is precisely the bug the `team_join_date` filter fixes.
   */
  it("reports how many clubs are short of target", { timeout: 900_000 }, () => {
    const original = XP_CONFIG.preseasonClubStartMass;
    try {
      XP_CONFIG.preseasonClubStartMass = 0; // mechanism off
      console.log(`\nCLUBS BELOW TARGET ${original} (mechanism off, full squad, outfield)`);
      for (const s of SEASONS) {
        const st = stateOf(s);
        XP_DEBUG.minutes = new Map();
        projectAll({
          bootstrap: st.bootstrap,
          fixtures: st.fixtures,
          nextEvent: 1,
          horizon: 1,
          pastSeason: st.pastSeason,
        });
        const mm = XP_DEBUG.minutes!;
        XP_DEBUG.minutes = null;
        const mass = new Map<number, number>();
        const size = new Map<number, number>();
        for (const el of st.bootstrap.elements) {
          if (el.element_type < 2 || el.element_type > 4) continue;
          const m = mm.get(el.id);
          if (!m) continue;
          mass.set(el.team, (mass.get(el.team) ?? 0) + m.pStart);
          size.set(el.team, (size.get(el.team) ?? 0) + 1);
        }
        const vals = [...mass.values()].sort((a, b) => a - b);
        const short = vals.filter((v) => v < original).length;
        const sizes = [...size.values()].sort((a, b) => a - b);
        console.log(
          `  ${s}  joinFiltered=${String(st.joinFiltered).padEnd(5)} clubs=${vals.length} ` +
            `short=${short} min=${vals[0].toFixed(2)} median=${vals[Math.floor(vals.length / 2)].toFixed(2)} ` +
            `max=${vals[vals.length - 1].toFixed(2)} outfieldPerClub=${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)}` +
            ` (range ${sizes[0]}-${sizes[sizes.length - 1]})`
        );
        // The FULL per-club list, not just min/median/max. An audit found the
        // `preseasonClubStartMass` doc block quoting a twenty-club table for
        // 2023/24 in which not one value reproduced, and the summary line
        // above was not enough to catch it: three order statistics agreeing is
        // consistent with seventeen wrong numbers in between.
        const short2 = new Map<string, number>();
        for (const [team, v] of mass) {
          const t = st.bootstrap.teams.find((x) => x.id === team);
          short2.set(t?.short_name ?? String(team), v);
        }
        console.log(
          "    " +
            [...short2.entries()]
              .sort((a, b) => a[1] - b[1])
              .map(([n, v]) => `${n} ${v.toFixed(2)}`)
              .join("  ")
        );
      }
    } finally {
      XP_CONFIG.preseasonClubStartMass = original;
    }
    expect(true).toBe(true);
  });

  it("scores the shipped model and prints the table", { timeout: 900_000 }, () => {
    const all: Row[] = [];
    const perSeason: { season: string; all: ReturnType<typeof score>; ev: ReturnType<typeof score>; no: ReturnType<typeof score> }[] = [];
    for (const s of SEASONS) {
      const rows = runSeason(s, stateOf(s));
      all.push(...rows);
      perSeason.push({
        season: s,
        all: score(rows),
        ev: score(rows.filter((r) => r.hasEvidence)),
        no: score(rows.filter((r) => !r.hasEvidence)),
      });
    }
    const pooled = score(all);
    const ev = score(all.filter((r) => r.hasEvidence));
    const no = score(all.filter((r) => !r.hasEvidence));

    console.log(
      `\nSHIPPED MODEL — pStart vs realised "started", launch pool, outfield, GW1-${GRADE_GWS}`
    );
    console.log(
      `${"season".padEnd(9)}${"n".padStart(6)}${"Brier".padStart(9)}${"pred".padStart(8)}${"obs".padStart(8)}` +
        `${"n(ev)".padStart(7)}${"Brier(ev)".padStart(11)}${"n(no)".padStart(7)}${"Brier(no)".padStart(11)}`
    );
    for (const r of perSeason) {
      console.log(
        `${r.season.padEnd(9)}${String(r.all.n).padStart(6)}${r.all.brier.toFixed(4).padStart(9)}` +
          `${r.all.mean.toFixed(4).padStart(8)}${r.all.obs.toFixed(4).padStart(8)}` +
          `${String(r.ev.n).padStart(7)}${r.ev.brier.toFixed(4).padStart(11)}` +
          `${String(r.no.n).padStart(7)}${r.no.brier.toFixed(4).padStart(11)}`
      );
    }
    console.log(
      `${"POOLED".padEnd(9)}${String(pooled.n).padStart(6)}${pooled.brier.toFixed(4).padStart(9)}` +
        `${pooled.mean.toFixed(4).padStart(8)}${pooled.obs.toFixed(4).padStart(8)}` +
        `${String(ev.n).padStart(7)}${ev.brier.toFixed(4).padStart(11)}` +
        `${String(no.n).padStart(7)}${no.brier.toFixed(4).padStart(11)}`
    );

    // Calibration by predicted decile, which is where a redistribution rule
    // does its damage: a rule that pins a handful of unknowns at the ceiling
    // shows up as a top bucket predicting far above what it observes.
    console.log(`\ncalibration (pooled)`);
    console.log(`${"bucket".padEnd(12)}${"n".padStart(7)}${"pred".padStart(8)}${"obs".padStart(8)}`);
    for (let b = 0; b < 10; b++) {
      const lo = b / 10;
      const hi = (b + 1) / 10;
      const inB = all.filter((r) => r.p >= lo && (b === 9 ? r.p <= hi : r.p < hi));
      if (inB.length === 0) continue;
      const sc = score(inB);
      console.log(
        `${`${lo.toFixed(1)}-${hi.toFixed(1)}`.padEnd(12)}${String(sc.n).padStart(7)}` +
          `${sc.mean.toFixed(4).padStart(8)}${sc.obs.toFixed(4).padStart(8)}`
      );
    }

    // The pooled sample size the config comments quote, as a tripwire: if the
    // pool, the archive or the grading window changes, the recorded tables stop
    // being comparable and this is where that becomes visible.
    expect(pooled.n).toBeGreaterThan(4000);
    expect(pooled.brier).toBeLessThan(0.25);
  });

  /**
   * Calibration of the RECORD-LESS group alone, by predicted bucket.
   *
   * The eighteen shapes swept in `preseasonClubStartMass` all vary how the
   * lift is DISTRIBUTED — top-N-only, powers of `priorPStart`, caps on how many
   * players may receive it. None of them varies the CEILING the lift may reach,
   * which is `preseasonMaxPStart` and is shared with proven ever-presents. This
   * table is what says whether that ceiling is the thing that is wrong.
   */
  it("prints record-less calibration", { timeout: 900_000 }, () => {
    const all: Row[] = [];
    for (const s of SEASONS) all.push(...runSeason(s, stateOf(s)));
    const no = all.filter((r) => !r.hasEvidence);
    console.log(`\nRECORD-LESS calibration (pooled, n=${no.length})`);
    console.log(`${"bucket".padEnd(12)}${"n".padStart(7)}${"pred".padStart(8)}${"obs".padStart(8)}`);
    const edges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.001];
    for (let i = 0; i < edges.length - 1; i++) {
      const inB = no.filter((r) => r.p >= edges[i] && r.p < edges[i + 1]);
      if (inB.length === 0) continue;
      const sc = score(inB);
      console.log(
        `${`${edges[i].toFixed(2)}-${edges[i + 1].toFixed(2)}`.padEnd(12)}${String(sc.n).padStart(7)}` +
          `${sc.mean.toFixed(4).padStart(8)}${sc.obs.toFixed(4).padStart(8)}`
      );
    }
    expect(no.length).toBeGreaterThan(500);
  });

  /**
   * How much of the ten-shirt identity the mechanism can actually SEE.
   *
   * Run with SHIRT_COUNT=1. This is the apparatus behind the "why 9.6 and not
   * 10" paragraph in the `preseasonClubStartMass` doc block, and it exists
   * because an audit found that paragraph quoting four figures — 9.775, 9.597,
   * 9.43 and a 0.993 goalkeeper control — that appear nowhere in the repo and
   * could not be re-derived by anyone reading it.
   *
   * The question. Ten outfielders start every match; that is an identity. But
   * `clubStartMass` can only allocate over the element list it can see at the
   * GW1 deadline, and some of those ten shirts go to players who are not on it
   * yet — window signings, mostly. So the target should be ten MINUS the part
   * of the identity that is invisible at the deadline, and that residual is an
   * empirical quantity, not a football one.
   *
   * The control is the point. The same count run on goalkeepers, where one
   * shirt per match is equally an identity, has a known answer of 1.000. If
   * the ALL-players count does not return 10.000 and 1.000 the instrument is
   * broken and the visible counts mean nothing, so both are printed first and
   * the test asserts on them.
   *
   * Denominator is club-matches: two per fixture, counted off the distinct
   * fixture ids in the graded rounds rather than off `fixtures.csv`, so that a
   * postponed or unplayed match cannot inflate it.
   */
  it.runIf(process.env.SHIRT_COUNT)(
    "counts the shirts visible on the GW1 element list",
    { timeout: 900_000 },
    () => {
      console.log(`\nSHIRTS PER CLUB-MATCH, GW1-${GRADE_GWS} (archive)`);
      console.log(
        `${"season".padEnd(9)}${"matches".padStart(8)}${"ALL out".padStart(9)}${"ALL gk".padStart(8)}` +
          `${"visible".padStart(9)}${"vis gk".padStart(8)}${"at short clubs".padStart(16)}`
      );
      const pooled = { m: 0, ao: 0, ag: 0, vo: 0, vg: 0, sm: 0, so: 0 };
      for (const s of SEASONS) {
        const st = stateOf(s);
        const typeOf = new Map(st.bootstrap.elements.map((e) => [e.id, e.element_type]));
        // The club is read off the MATCH ROW, not off the element list. On
        // 2023-24 the element list is the end-of-season dump, so it records a
        // January signing at the club he ENDED at, and attributing his August
        // matches there invents club-fixture pairs that never existed — it
        // inflated the short-club denominator from 20 to 39 before this was
        // fixed. `teams.csv` maps the row's club name onto the model's id.
        const idOfName = new Map(
          csv(s, "teams.csv").map((t) => [t.name, +t.id] as const)
        );

        // Which clubs the rule actually reaches: mechanism OFF, sum < target.
        const original = XP_CONFIG.preseasonClubStartMass;
        const mass = new Map<number, number>();
        try {
          XP_CONFIG.preseasonClubStartMass = 0;
          XP_DEBUG.minutes = new Map();
          projectAll({
            bootstrap: st.bootstrap, fixtures: st.fixtures,
            nextEvent: 1, horizon: 1, pastSeason: st.pastSeason,
          });
          const mm = XP_DEBUG.minutes!;
          XP_DEBUG.minutes = null;
          for (const el of st.bootstrap.elements) {
            if (el.element_type < 2 || el.element_type > 4) continue;
            const m = mm.get(el.id);
            if (m) mass.set(el.team, (mass.get(el.team) ?? 0) + m.pStart);
          }
        } finally {
          XP_CONFIG.preseasonClubStartMass = original;
        }
        const isShort = (team: number) => (mass.get(team) ?? 0) < original;

        const fixtureIds = new Set<string>();
        let allOut = 0, allGk = 0, visOut = 0, visGk = 0;
        const shortMatches = new Set<string>();
        let shortVisOut = 0;
        for (const g of st.rounds) {
          for (const r of csv(s, "gws", `gw${g}.csv`)) {
            const n = +r.starts || 0;
            fixtureIds.add(r.fixture);
            // CSV `position` covers players absent from the GW1 list; the
            // bootstrap `element_type` is the model's own view and is used
            // wherever it exists, so "visible" and "all" agree on what a
            // goalkeeper is.
            const t = typeOf.get(+r.element);
            const isGk = t != null ? t === 1 : r.position === "GK";
            if (isGk) allGk += n; else allOut += n;
            if (t == null) continue;
            if (isGk) visGk += n; else visOut += n;
            const team = idOfName.get(r.team);
            if (team != null && isShort(team) && !isGk) {
              shortVisOut += n;
              shortMatches.add(`${team}:${r.fixture}`);
            }
          }
        }
        const cm = fixtureIds.size * 2;
        pooled.m += cm; pooled.ao += allOut; pooled.ag += allGk;
        pooled.vo += visOut; pooled.vg += visGk;
        pooled.sm += shortMatches.size; pooled.so += shortVisOut;
        console.log(
          `${s.padEnd(9)}${String(cm).padStart(8)}${(allOut / cm).toFixed(3).padStart(9)}` +
            `${(allGk / cm).toFixed(3).padStart(8)}${(visOut / cm).toFixed(3).padStart(9)}` +
            `${(visGk / cm).toFixed(3).padStart(8)}` +
            `${(shortVisOut / (shortMatches.size || 1)).toFixed(3).padStart(11)}${` (${shortMatches.size})`.padStart(5)}`
        );
      }
      console.log(
        `${"POOLED".padEnd(9)}${String(pooled.m).padStart(8)}${(pooled.ao / pooled.m).toFixed(3).padStart(9)}` +
          `${(pooled.ag / pooled.m).toFixed(3).padStart(8)}${(pooled.vo / pooled.m).toFixed(3).padStart(9)}` +
          `${(pooled.vg / pooled.m).toFixed(3).padStart(8)}` +
          `${(pooled.so / (pooled.sm || 1)).toFixed(3).padStart(11)}${` (${pooled.sm})`.padStart(5)}`
      );
      // The instrument check. If these two drift off 10 and 1 the visible
      // counts above are not measuring what the doc block says they measure.
      expect(pooled.ao / pooled.m).toBeCloseTo(10, 2);
      expect(pooled.ag / pooled.m).toBeCloseTo(1, 2);
    }
  );

  /**
   * The `preseasonClubStartMass` target sweep.
   *
   * Run with MASS_SWEEP=1. This regenerates the table quoted in the
   * `preseasonClubStartMass` doc block in `xp.ts`, and it exists because that
   * table was the LAST figure in the pre-season config with no checked-in
   * apparatus behind it. An audit found the block quoting `n = 5619` where
   * every other table on the identical protocol says 5680; there was no way to
   * re-run the sweep and find out which was right, which is precisely the
   * failure mode. It is 5680 — the same pooled population as everything else.
   *
   * Target 0 is the mechanism switched off, since `players.length < target`
   * can never trip and `want > 0` is false at a target of zero.
   *
   * BOTH REGIMES ARE PRINTED, and that is not thoroughness for its own sake.
   * The ceiling sweep had to force the clamp off because the clamp masked the
   * parameter under test; the lesson generalises to "a sweep of one constant
   * is only meaningful once you say what the others were doing". A target
   * sweep in the shipped regime answers "what does the model I ship do as the
   * target moves", and a target sweep with the record-less ceiling and clamp
   * lifted answers "what is the club-accounting mechanism worth on its own".
   * They are different questions with different answers, and a doc block that
   * quotes one row without saying which is unreproducible by construction.
   */
  it.runIf(process.env.MASS_SWEEP)(
    "sweeps the club start-mass target",
    { timeout: 900_000 },
    () => {
      const o = {
        mass: XP_CONFIG.preseasonClubStartMass,
        cap: XP_CONFIG.preseasonRecordlessMaxPStart,
        glob: XP_CONFIG.preseasonRecordlessGlobalCap,
      };
      try {
        const targets = (
          process.env.MASSES ?? "0,7.0,7.5,8.0,9.0,9.5,9.6,10.0,10.5,11.0"
        )
          .split(",")
          .map(Number);
        const runAt = (t: number) => {
          XP_CONFIG.preseasonClubStartMass = t;
          const rows: Row[] = [];
          for (const s of SEASONS) rows.push(...runSeason(s, stateOf(s)));
          return rows;
        };
        for (const isolate of [false, true]) {
          XP_CONFIG.preseasonRecordlessMaxPStart = isolate ? XP_CONFIG.preseasonMaxPStart : o.cap;
          XP_CONFIG.preseasonRecordlessGlobalCap = isolate ? 1 : o.glob;
          // Baseline is the SHIPPED target, so the "vs 9.6" column answers the
          // only question the config actually has to defend: is any other
          // target distinguishable from the one that ships?
          const base = runAt(o.mass);
          console.log(
            `\nCLUB START-MASS TARGET SWEEP — ${isolate ? "MECHANISM ISOLATED (record-less ceiling and clamp OFF)" : "SHIPPED REGIME"}` +
              ` (ceiling ${XP_CONFIG.preseasonRecordlessMaxPStart}, clamp ${XP_CONFIG.preseasonRecordlessGlobalCap}, scope ${XP_CONFIG.preseasonClubStartMassScope})`
          );
          console.log(
            `${"target".padEnd(8)}${"n".padStart(6)}${"Brier".padStart(10)}` +
              `${"Brier(no)".padStart(11)}` +
              SEASONS.map((s) => s.padStart(9)).join("") +
              `${`vs ${o.mass}`.padStart(11)}${"95% CI".padStart(24)}`
          );
          for (const t of targets) {
            const rows = runAt(t);
            const a = score(rows);
            const n = score(rows.filter((r) => !r.hasEvidence));
            const bs = pairedBootstrap(base, rows);
            console.log(
              `${t.toFixed(1).padEnd(8)}${String(a.n).padStart(6)}${a.brier.toFixed(5).padStart(10)}` +
                `${n.brier.toFixed(5).padStart(11)}` +
                SEASONS.map((s) =>
                  score(rows.filter((r) => r.season === s)).brier.toFixed(4).padStart(9)
                ).join("") +
                `${bs.mean.toFixed(5).padStart(11)}` +
                `${`[${bs.lo.toFixed(5)}, ${bs.hi.toFixed(5)}]`.padStart(24)}`
            );
          }
        }
      } finally {
        XP_CONFIG.preseasonClubStartMass = o.mass;
        XP_CONFIG.preseasonRecordlessMaxPStart = o.cap;
        XP_CONFIG.preseasonRecordlessGlobalCap = o.glob;
      }
    }
  );

  /**
   * The record-less ceiling sweep, with and without spill.
   *
   * Run with CEILING_SWEEP=1. Every cell is a full re-run of the real model
   * over the same reconstructed state, so the only thing that differs between
   * cells is the constant under test.
   *
   * The cap grid defaults to 0.50-0.97 and is overridable: `CAPS=0.2,0.3,0.45`
   * prints rows the default grid cannot reach. The doc block in `xp.ts` quotes
   * rows from below 0.50, so reproducing it needs the wider grid.
   *
   * `preseasonRecordlessGlobalCap` IS FORCED TO 1 FOR THE WHOLE SWEEP, and
   * that is the fix for a bug an audit caught rather than a stylistic choice.
   * The shipped clamp is 0.55, and while it is live every record-less player
   * is already held at or below 0.55 by `preseasonMinutes` before the club
   * accounting ever sees him — so a "ceiling sweep" run in the shipped regime
   * measures nothing above 0.55 at all, prints a flat plateau because the
   * plateau is an artefact of the clamp, and REFUTES the doc block it is meant
   * to regenerate. Isolating one parameter means switching the other off.
   */
  it.runIf(process.env.CEILING_SWEEP)(
    "sweeps the record-less ceiling",
    { timeout: 900_000 },
    () => {
      const o = {
        cap: XP_CONFIG.preseasonRecordlessMaxPStart,
        spill: XP_CONFIG.preseasonClubStartMassSpill,
        glob: XP_CONFIG.preseasonRecordlessGlobalCap,
      };
      const runAll = (cap: number, spill: boolean) => {
        XP_CONFIG.preseasonRecordlessMaxPStart = cap;
        XP_CONFIG.preseasonClubStartMassSpill = spill;
        XP_CONFIG.preseasonRecordlessGlobalCap = 1;
        const rows: Row[] = [];
        for (const s of SEASONS) rows.push(...runSeason(s, stateOf(s)));
        return rows;
      };
      try {
        const caps = (
          process.env.CAPS ?? "0.5,0.55,0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.97"
        )
          .split(",")
          .map(Number);
        const base = runAll(0.97, false);
        console.log(`\nRECORD-LESS CEILING SWEEP (target ${XP_CONFIG.preseasonClubStartMass}, scope ${XP_CONFIG.preseasonClubStartMassScope})`);
        console.log(
          `${"cap".padEnd(6)}${"spill".padEnd(7)}${"Brier".padStart(9)}${"Brier(ev)".padStart(11)}${"Brier(no)".padStart(11)}` +
            `${"23-24".padStart(8)}${"24-25".padStart(8)}${"25-26".padStart(8)}${"vs base".padStart(10)}${"95% CI".padStart(24)}`
        );
        for (const spill of [false, true]) {
          for (const cap of caps) {
            const rows = runAll(cap, spill);
            const a = score(rows);
            const e = score(rows.filter((r) => r.hasEvidence));
            const n = score(rows.filter((r) => !r.hasEvidence));
            const per = SEASONS.map((s) => score(rows.filter((r) => r.season === s)).brier);
            const bs = pairedBootstrap(base, rows);
            console.log(
              `${cap.toFixed(2).padEnd(6)}${String(spill).padEnd(7)}${a.brier.toFixed(4).padStart(9)}` +
                `${e.brier.toFixed(4).padStart(11)}${n.brier.toFixed(4).padStart(11)}` +
                per.map((v) => v.toFixed(4).padStart(8)).join("") +
                `${bs.mean.toFixed(5).padStart(10)}` +
                `${`[${bs.lo.toFixed(5)}, ${bs.hi.toFixed(5)}]`.padStart(24)}`
            );
          }
        }
      } finally {
        XP_CONFIG.preseasonRecordlessMaxPStart = o.cap;
        XP_CONFIG.preseasonClubStartMassSpill = o.spill;
        XP_CONFIG.preseasonRecordlessGlobalCap = o.glob;
      }
    }
  );

  /**
   * Is the record-less CEILING just a proxy for a global record-less clamp?
   *
   * The ceiling only fires inside a club that is short of `preseasonClubStartMass`
   * — 10 and 11 of 20 on the two archive seasons that carry `team_join_date`,
   * which is the column that makes the reconstructed population a GW1 one
   * rather than an end-of-season dump. 2023/24 does not carry it and is not
   * comparable; an earlier version of this sentence said "10 or 11 of 20 on
   * this archive" and read as if it covered all three. If the real defect is that record-less
   * `pStart` is over-dispersed everywhere, a clamp in `preseasonMinutes` that
   * applies to every club alike should beat it, and the ceiling should be
   * dropped in its favour rather than shipped alongside it.
   */
  it.runIf(process.env.GLOBAL_SWEEP)(
    "compares the club-conditional ceiling against a global record-less clamp",
    { timeout: 900_000 },
    () => {
      const o = {
        cap: XP_CONFIG.preseasonRecordlessMaxPStart,
        glob: XP_CONFIG.preseasonRecordlessGlobalCap,
      };
      const runAll = (cap: number, glob: number) => {
        XP_CONFIG.preseasonRecordlessMaxPStart = cap;
        XP_CONFIG.preseasonRecordlessGlobalCap = glob;
        const rows: Row[] = [];
        for (const s of SEASONS) rows.push(...runSeason(s, stateOf(s)));
        return rows;
      };
      try {
        const base = runAll(0.97, 1);
        const cells: [string, number, number][] = [
          ["shipped", 0.97, 1],
          ["ceiling .55", 0.55, 1],
          ["global .90", 0.97, 0.9],
          ["global .80", 0.97, 0.8],
          ["global .70", 0.97, 0.7],
          ["global .60", 0.97, 0.6],
          ["global .55", 0.97, 0.55],
          ["global .50", 0.97, 0.5],
          ["global .40", 0.97, 0.4],
          ["both .55", 0.55, 0.55],
          ["both .55/.70", 0.55, 0.7],
        ];
        console.log("\nCLUB-CONDITIONAL CEILING vs GLOBAL RECORD-LESS CLAMP");
        console.log(
          `${"variant".padEnd(14)}${"Brier".padStart(9)}${"Brier(ev)".padStart(11)}${"Brier(no)".padStart(11)}` +
            `${"23-24".padStart(8)}${"24-25".padStart(8)}${"25-26".padStart(8)}${"vs base".padStart(10)}${"95% CI".padStart(24)}`
        );
        for (const [name, cap, glob] of cells) {
          const rows = runAll(cap, glob);
          const a = score(rows);
          const e = score(rows.filter((r) => r.hasEvidence));
          const n = score(rows.filter((r) => !r.hasEvidence));
          const per = SEASONS.map((s) => score(rows.filter((r) => r.season === s)).brier);
          const bs = pairedBootstrap(base, rows);
          console.log(
            `${name.padEnd(14)}${a.brier.toFixed(4).padStart(9)}${e.brier.toFixed(4).padStart(11)}` +
              `${n.brier.toFixed(4).padStart(11)}` +
              per.map((v) => v.toFixed(4).padStart(8)).join("") +
              `${bs.mean.toFixed(5).padStart(10)}` +
              `${`[${bs.lo.toFixed(5)}, ${bs.hi.toFixed(5)}]`.padStart(24)}`
          );
        }
      } finally {
        XP_CONFIG.preseasonRecordlessMaxPStart = o.cap;
        XP_CONFIG.preseasonRecordlessGlobalCap = o.glob;
      }
    }
  );

  /**
   * Does exempting designated set-piece takers from the record-less cap pay?
   *
   * The cap distrusts `priorPStart`, which is price and ownership. A set-piece
   * order of 1 is the club's own team sheet and not the market's guess, so the
   * argument for exempting it is prior to the Brier — but the Brier still has
   * to be checked, because a rule that is well motivated and also costly is
   * still costly.
   */
  it.runIf(process.env.SETPIECE_SWEEP)(
    "measures the set-piece exemption to the record-less cap",
    { timeout: 900_000 },
    () => {
      const o = XP_CONFIG.preseasonRecordlessCapExemptsSetPieces;
      const runAll = (on: boolean) => {
        XP_CONFIG.preseasonRecordlessCapExemptsSetPieces = on;
        const rows: Row[] = [];
        for (const s of SEASONS) rows.push(...runSeason(s, stateOf(s)));
        return rows;
      };
      try {
        const off = runAll(false);
        const on = runAll(true);
        console.log("\nSET-PIECE EXEMPTION TO THE RECORD-LESS CAP");
        console.log(
          `${"exempt".padEnd(8)}${"n".padStart(7)}${"Brier".padStart(9)}${"Brier(ev)".padStart(11)}` +
            `${"Brier(no)".padStart(11)}${"23-24".padStart(8)}${"24-25".padStart(8)}${"25-26".padStart(8)}`
        );
        for (const [name, rows] of [
          ["no", off],
          ["yes", on],
        ] as const) {
          const a = score(rows);
          const e = score(rows.filter((r) => r.hasEvidence));
          const n = score(rows.filter((r) => !r.hasEvidence));
          const per = SEASONS.map((s) => score(rows.filter((r) => r.season === s)).brier);
          console.log(
            `${name.padEnd(8)}${String(a.n).padStart(7)}${a.brier.toFixed(4).padStart(9)}` +
              `${e.brier.toFixed(4).padStart(11)}${n.brier.toFixed(4).padStart(11)}` +
              per.map((v) => v.toFixed(4).padStart(8)).join("")
          );
        }
        const bs = pairedBootstrap(off, on);
        console.log(
          `paired bootstrap (exempt minus not; negative favours exempting): ` +
            `${bs.mean.toFixed(5)} [${bs.lo.toFixed(5)}, ${bs.hi.toFixed(5)}]`
        );
        // How big is the affected population at all? A rule that moves nobody
        // cannot be justified on a Brier either way, and saying so is the point.
        let moved = 0;
        const byId = new Map(off.map((r) => [`${r.season}#${r.element}#${r.round}`, r.p]));
        let obsMoved = 0;
        let nMoved = 0;
        for (const r of on) {
          const p0 = byId.get(`${r.season}#${r.element}#${r.round}`);
          if (p0 != null && Math.abs(p0 - r.p) > 1e-9) {
            moved++;
            obsMoved += r.y;
            nMoved++;
          }
        }
        console.log(
          `rows whose pStart moved: ${moved} of ${on.length}` +
            (nMoved ? `   observed start rate on them: ${(obsMoved / nMoved).toFixed(4)}` : "")
        );
      } finally {
        XP_CONFIG.preseasonRecordlessCapExemptsSetPieces = o;
      }
    }
  );

  /**
   * The rule the GLOBAL_SWEEP comparison actually points at.
   *
   * `global X` alone (clamp in `preseasonMinutes`, ceiling still 0.97) is NOT a
   * club-blind rule, because the clamp is applied before `clubStartMass` runs
   * and the lift puts the clamped players straight back up in exactly the clubs
   * that are short. Setting BOTH constants to the same X is the club-blind
   * rule: a record-less player is never rated above X, for any reason, in any
   * club. This sweeps that single constant and reports it against both rivals.
   */
  it.runIf(process.env.UNIFORM_SWEEP)(
    "sweeps a single uniform record-less cap",
    { timeout: 900_000 },
    () => {
      const o = {
        cap: XP_CONFIG.preseasonRecordlessMaxPStart,
        glob: XP_CONFIG.preseasonRecordlessGlobalCap,
      };
      const runAll = (cap: number, glob: number) => {
        XP_CONFIG.preseasonRecordlessMaxPStart = cap;
        XP_CONFIG.preseasonRecordlessGlobalCap = glob;
        const rows: Row[] = [];
        for (const s of SEASONS) rows.push(...runSeason(s, stateOf(s)));
        return rows;
      };
      try {
        const base = runAll(0.97, 1);
        const ceilingOnly = runAll(0.55, 1);
        console.log("\nUNIFORM RECORD-LESS CAP (both constants set to X)");
        console.log(
          `${"X".padEnd(6)}${"Brier".padStart(9)}${"Brier(ev)".padStart(11)}${"Brier(no)".padStart(11)}` +
            `${"23-24".padStart(8)}${"24-25".padStart(8)}${"25-26".padStart(8)}` +
            `${"vs .97".padStart(10)}${"95% CI".padStart(23)}` +
            `${"vs ceil.55".padStart(11)}${"95% CI".padStart(23)}`
        );
        const uniform = new Map<number, Row[]>();
        for (const x of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.9]) {
          const rows = runAll(x, x);
          uniform.set(x, rows);
          const a = score(rows);
          const e = score(rows.filter((r) => r.hasEvidence));
          const n = score(rows.filter((r) => !r.hasEvidence));
          const per = SEASONS.map((s) => score(rows.filter((r) => r.season === s)).brier);
          const vb = pairedBootstrap(base, rows);
          const vc = pairedBootstrap(ceilingOnly, rows);
          console.log(
            `${x.toFixed(2).padEnd(6)}${a.brier.toFixed(4).padStart(9)}${e.brier.toFixed(4).padStart(11)}` +
              `${n.brier.toFixed(4).padStart(11)}` +
              per.map((v) => v.toFixed(4).padStart(8)).join("") +
              `${vb.mean.toFixed(5).padStart(10)}${`[${vb.lo.toFixed(5)}, ${vb.hi.toFixed(5)}]`.padStart(23)}` +
              `${vc.mean.toFixed(5).padStart(11)}${`[${vc.lo.toFixed(5)}, ${vc.hi.toFixed(5)}]`.padStart(23)}`
          );
        }
        // Leave-one-season-out on the uniform constant, so the shipped value is
        // not just the argmin of the sample it is quoted against.
        console.log("\nLEAVE-ONE-SEASON-OUT, UNIFORM CAP");
        for (const held of SEASONS) {
          let best = { x: 0, brier: Infinity };
          for (const [x, rows] of uniform) {
            const fit = score(rows.filter((r) => r.season !== held));
            if (fit.brier < best.brier) best = { x, brier: fit.brier };
          }
          const out = score(uniform.get(best.x)!.filter((r) => r.season === held));
          const ref = score(ceilingOnly.filter((r) => r.season === held));
          console.log(
            `  held out ${held}  argmin(fit) ${best.x.toFixed(2)}  ` +
              `held-out ${out.brier.toFixed(4)}   (ceiling-only .55 on the same rows: ${ref.brier.toFixed(4)})`
          );
        }
        // What the uniform rule costs in club accounting: it is a harder cap,
        // so more clubs finish below `preseasonClubStartMass`.
        for (const x of [0.55]) {
          XP_CONFIG.preseasonRecordlessMaxPStart = x;
          XP_CONFIG.preseasonRecordlessGlobalCap = x;
          for (const s of SEASONS) {
            const st = stateOf(s);
            XP_DEBUG.minutes = new Map();
            projectAll({
              bootstrap: st.bootstrap,
              fixtures: st.fixtures,
              nextEvent: 1,
              horizon: 1,
              pastSeason: st.pastSeason,
            });
            const mm = XP_DEBUG.minutes!;
            XP_DEBUG.minutes = null;
            const sums = new Map<number, number>();
            for (const el of st.bootstrap.elements) {
              if (el.element_type < 2 || el.element_type > 4) continue;
              const m = mm.get(el.id);
              if (m) sums.set(el.team, (sums.get(el.team) ?? 0) + m.pStart);
            }
            const vals = [...sums.values()].sort((p, q) => p - q);
            const short = vals.filter((v) => v < XP_CONFIG.preseasonClubStartMass - 1e-6);
            console.log(
              `  uniform ${x} — ${s}: min ${vals[0].toFixed(2)} max ${vals[vals.length - 1].toFixed(2)}` +
                `  below target: ${short.length}` +
                (short.length ? ` [${short.map((v) => v.toFixed(2)).join(", ")}]` : "")
            );
          }
        }
      } finally {
        XP_CONFIG.preseasonRecordlessMaxPStart = o.cap;
        XP_CONFIG.preseasonRecordlessGlobalCap = o.glob;
      }
    }
  );

  /**
   * Everything the shipped doc blocks assert, regenerated in one pass.
   *
   * Run with FINAL=1. It exists because an audit found four separate claims in
   * `xp.ts` that were stated without a live measurement behind them, or with a
   * measurement that had drifted: "corroborated out of sample", "sums to at
   * least 9.6", "15 of 20 clubs live", and the cap-vs-cap significance story.
   * Each block below regenerates exactly one of them.
   *
   * EVERY BLOCK HERE RUNS WITH `preseasonRecordlessGlobalCap` FORCED TO 1.
   * The four tables are all about `preseasonRecordlessMaxPStart` — what the
   * CLUB-CONDITIONAL ceiling buys, where it binds, whether 0.55 is
   * distinguishable from its neighbours — and none of those questions has an
   * answer while a 0.55 clamp upstream is already holding every record-less
   * player at or below 0.55 no matter what the ceiling is set to.
   *
   * An earlier version did not do this, and it was not a harmless omission:
   * run in the shipped regime the sweep flattens (every cap from 0.40 to 0.97
   * scores identically, because none of them binds on anything the clamp has
   * not already taken), the reach table counts clamp victims as ceiling
   * victims and reports 7/7/13 clubs instead of 1/5/7, and the whole thing
   * silently CONTRADICTS the doc blocks it was written to regenerate. A
   * harness that refutes the shipped documentation is either a real finding or
   * a broken harness, and here it was the second. Isolate one parameter by
   * switching the other off, then read the tables.
   *
   * The shipped COMBINATION — clamp and ceiling together, which is what the
   * app actually runs — is measured by UNIFORM_SWEEP and GLOBAL_SWEEP, not
   * here.
   */
  it.runIf(process.env.FINAL)(
    "regenerates every claim the shipped doc blocks make",
    { timeout: 1_800_000 },
    () => {
      const o = XP_CONFIG.preseasonRecordlessMaxPStart;
      const oGlob = XP_CONFIG.preseasonRecordlessGlobalCap;
      XP_CONFIG.preseasonRecordlessGlobalCap = 1;
      const runAll = (cap: number, seasons: string[]) => {
        XP_CONFIG.preseasonRecordlessMaxPStart = cap;
        const rows: Row[] = [];
        for (const s of seasons) rows.push(...runSeason(s, stateOf(s)));
        return rows;
      };
      const caps = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.9, 0.97];
      try {
        // Cache one full-population run per cap; every block below reads these.
        const byCap = new Map<number, Row[]>();
        for (const c of caps) byCap.set(c, runAll(c, SEASONS));

        // (1) LEAVE-ONE-SEASON-OUT. Pick the cap on two seasons, report the
        // Brier it earns on the third. This replaces a sentence that claimed
        // out-of-sample corroboration but quoted the fitting sample.
        console.log("\nLEAVE-ONE-SEASON-OUT CAP SELECTION");
        console.log(
          `${"held out".padEnd(10)}${"argmin(fit)".padStart(12)}${"fit Brier".padStart(11)}` +
            `${"held-out".padStart(11)}${"held-out@.97".padStart(14)}`
        );
        for (const held of SEASONS) {
          let best = { cap: 0, brier: Infinity };
          for (const c of caps) {
            const fit = score(byCap.get(c)!.filter((r) => r.season !== held));
            if (fit.brier < best.brier) best = { cap: c, brier: fit.brier };
          }
          const out = score(byCap.get(best.cap)!.filter((r) => r.season === held));
          const ref = score(byCap.get(0.97)!.filter((r) => r.season === held));
          console.log(
            `${held.padEnd(10)}${best.cap.toFixed(2).padStart(12)}${best.brier.toFixed(4).padStart(11)}` +
              `${out.brier.toFixed(4).padStart(11)}${ref.brier.toFixed(4).padStart(14)}`
          );
        }
        console.log("per-season argmin over the full cap grid:");
        for (const s of SEASONS) {
          let best = { cap: 0, brier: Infinity };
          for (const c of caps) {
            const b = score(byCap.get(c)!.filter((r) => r.season === s));
            if (b.brier < best.brier) best = { cap: c, brier: b.brier };
          }
          console.log(`  ${s}  argmin ${best.cap.toFixed(2)}  ${best.brier.toFixed(4)}`);
        }

        // (2) CAP vs CAP. Is the plateau flat, or is 0.55 distinguishable from
        // its neighbours? Every comparison is against the shipped 0.55.
        console.log("\nCAP-vs-CAP PAIRED BOOTSTRAP (positive = that cap is WORSE than .55)");
        const ship = byCap.get(0.55)!;
        for (const c of caps) {
          if (c === 0.55) continue;
          const bs = pairedBootstrap(byCap.get(c)!, ship);
          const sig = bs.lo > 0 || bs.hi < 0 ? "  <-- distinguishable" : "";
          console.log(
            `  .55 vs ${c.toFixed(2)}  ${(-bs.mean).toFixed(5).padStart(9)} ` +
              `[${(-bs.hi).toFixed(5)}, ${(-bs.lo).toFixed(5)}]${sig}`
          );
        }

        // (3) HOW MANY CLUBS THE CEILING ACTUALLY BINDS IN, and what each
        // club's start mass sums to once it has. The doc claimed "at least
        // 9.6" and "15 of 20 clubs"; both are measured here instead.
        console.log("\nCEILING REACH AND POST-CEILING CLUB SUMS (cap .55)");
        XP_CONFIG.preseasonRecordlessMaxPStart = 0.55;
        for (const s of SEASONS) {
          const st = stateOf(s);
          XP_DEBUG.minutes = new Map();
          projectAll({
            bootstrap: st.bootstrap,
            fixtures: st.fixtures,
            nextEvent: 1,
            horizon: 1,
            pastSeason: st.pastSeason,
          });
          const mm = XP_DEBUG.minutes!;
          XP_DEBUG.minutes = null;
          const sums = new Map<number, number>();
          const bound = new Set<number>();
          let pinned = 0;
          for (const el of st.bootstrap.elements) {
            if (el.element_type < 2 || el.element_type > 4) continue;
            const m = mm.get(el.id);
            if (!m) continue;
            sums.set(el.team, (sums.get(el.team) ?? 0) + m.pStart);
            const ev = (m as unknown as { hasEvidence?: boolean }).hasEvidence === true;
            if (!ev && Math.abs(m.pStart - 0.55) < 1e-6) {
              pinned++;
              bound.add(el.team);
            }
          }
          const vals = [...sums.values()].sort((x, y) => x - y);
          const short = vals.filter((v) => v < XP_CONFIG.preseasonClubStartMass - 1e-6);
          console.log(
            `  ${s}  clubs where the ceiling binds: ${bound.size}/${sums.size}` +
              `   players pinned at .55: ${pinned}`
          );
          console.log(
            `      club start-mass: min ${vals[0].toFixed(2)} max ${vals[vals.length - 1].toFixed(2)}` +
              `   below target (${XP_CONFIG.preseasonClubStartMass}): ${short.length}` +
              (short.length ? ` [${short.map((v) => v.toFixed(2)).join(", ")}]` : "")
          );
        }
      } finally {
        XP_CONFIG.preseasonRecordlessMaxPStart = o;
        XP_CONFIG.preseasonRecordlessGlobalCap = oGlob;
      }
    }
  );

  /**
   * THE APPARATUS BEHIND THE "UP ONLY" BULLET.
   *
   * Run with DOWN_NORM=1. It flips `preseasonClubStartMassDown`, which scales a
   * club that is OVER `preseasonClubStartMass` back down to it, and scores both
   * regimes on identical state.
   *
   * This block exists because that bullet quoted three numbers — has-record
   * "unchanged to six decimals at .194480", record-less ".2174 to .2312",
   * pooled ".1989 to .2016" — and there was no switch in the model to produce
   * any of them. An audit could not reproduce them and neither could I. Two
   * things were wrong with them beyond being uncheckable: .1989 comes from a
   * run at target 10.0 over the `players_raw.csv` end-of-season population,
   * where the shipped protocol prints .1958 — and it is the POPULATION that
   * accounts for nearly all of that, since `MASS_SWEEP=1` moves 9.6 to 10.0 for
   * only +.0001 — and .194480 is a has-record figure from the same off-regime
   * run while the shipped `Brier(ev)` is .1970. So all three were measured under a
   * configuration the model no longer runs, and were then quoted as if they
   * were live baselines.
   *
   * The QUALITATIVE claim in that bullet was nonetheless the one part that was
   * sound, and it is worth separating: because `primary` excludes anyone with a
   * record under the shipped scope, no proven starter is reachable in either
   * direction, so `Brier(ev)` MUST be identical between the two regimes. That
   * is a structural prediction, not a measurement, and this block asserts it
   * rather than printing it — if it ever fails, the scope filter has been
   * broken and the whole UP ONLY argument goes with it.
   *
   * The paired bootstrap is clustered on club-season like every other one here.
   */
  it.runIf(process.env.DOWN_NORM)(
    "compares up-only against down-normalisation",
    { timeout: 900_000 },
    () => {
      const original = XP_CONFIG.preseasonClubStartMassDown;
      const runAll = (down: boolean) => {
        XP_CONFIG.preseasonClubStartMassDown = down;
        const rows: Row[] = [];
        for (const s of SEASONS) rows.push(...runSeason(s, stateOf(s)));
        return rows;
      };
      try {
        const up = runAll(false);
        const both = runAll(true);
        console.log(
          `\nUP ONLY vs DOWN-NORMALISATION, target ${XP_CONFIG.preseasonClubStartMass}` +
            `, scope ${XP_CONFIG.preseasonClubStartMassScope}`
        );
        console.log(
          `${"regime".padEnd(14)}${"n".padStart(7)}${"Brier".padStart(10)}` +
            `${"Brier(ev)".padStart(12)}${"Brier(no)".padStart(12)}`
        );
        for (const [name, rows] of [
          ["up only", up],
          ["+ down", both],
        ] as const) {
          const a = score(rows);
          const e = score(rows.filter((r) => r.hasEvidence));
          const n = score(rows.filter((r) => !r.hasEvidence));
          console.log(
            `${name.padEnd(14)}${String(a.n).padStart(7)}${a.brier.toFixed(5).padStart(10)}` +
              `${e.brier.toFixed(6).padStart(12)}${n.brier.toFixed(5).padStart(12)}`
          );
        }
        for (const s of SEASONS) {
          const r1 = score(up.filter((r) => r.season === s));
          const r2 = score(both.filter((r) => r.season === s));
          console.log(
            `  ${s}  up only ${r1.brier.toFixed(5)}   + down ${r2.brier.toFixed(5)}`
          );
        }
        // How many players the extra branch actually reaches, so a null result
        // cannot be a silently inert mechanism.
        const upP = new Map(up.map((r) => [`${r.season}:${r.element}:${r.round}`, r.p]));
        let moved = 0;
        const movedIds = new Set<number>();
        for (const r of both) {
          const k = `${r.season}:${r.element}:${r.round}`;
          const q = upP.get(k);
          if (q != null && Math.abs(q - r.p) > 1e-12) {
            moved++;
            movedIds.add(r.element);
          }
        }
        console.log(
          `rows moved by down-normalisation: ${moved} of ${both.length}` +
            ` (${movedIds.size} distinct players)`
        );
        const bs = pairedBootstrap(up, both);
        console.log(
          `paired bootstrap (down minus up, positive favours UP ONLY): ` +
            `${bs.mean.toFixed(5)} [${bs.lo.toFixed(5)}, ${bs.hi.toFixed(5)}]`
        );
        // Pooled dilutes: 4700 of the 5680 rows are has-record and CANNOT move,
        // so a real effect on the 980 that can is averaged against five sixths
        // of exact zeroes. The record-less interval is the one that answers the
        // question the bullet is actually asking.
        const bsNo = pairedBootstrap(
          up.filter((r) => !r.hasEvidence),
          both.filter((r) => !r.hasEvidence)
        );
        console.log(
          `paired bootstrap, RECORD-LESS only (n=${up.filter((r) => !r.hasEvidence).length}): ` +
            `${bsNo.mean.toFixed(5)} [${bsNo.lo.toFixed(5)}, ${bsNo.hi.toFixed(5)}]`
        );
        // AND THE SAME ARGUMENT ONE STEP FURTHER, because the paragraph above
        // is easy to make and then stop making too early. Most of the 980
        // record-less rows do not move either — only 200 do — so the
        // record-less figure is diluted by roughly the same factor the pooled
        // one is. An audit caught this block committing exactly the error its
        // own comment warns against, one line later. These two lines are the
        // undiluted reading: what the rule does to the rows it touches.
        const movedKeys = new Set<string>();
        for (const r of both) {
          const k = `${r.season}:${r.element}:${r.round}`;
          const q = upP.get(k);
          if (q != null && Math.abs(q - r.p) > 1e-12) movedKeys.add(k);
        }
        const onlyMoved = (rows: Row[]) =>
          rows.filter((r) => movedKeys.has(`${r.season}:${r.element}:${r.round}`));
        const mUp = score(onlyMoved(up));
        const mDown = score(onlyMoved(both));
        console.log(
          `ON THE MOVED ROWS ONLY (n=${mUp.n}): Brier up ${mUp.brier.toFixed(5)}` +
            ` -> down ${mDown.brier.toFixed(5)}   (delta ${(mDown.brier - mUp.brier).toFixed(5)})`
        );
        console.log(
          `  mean pStart up ${mUp.mean.toFixed(4)} -> down ${mDown.mean.toFixed(4)}` +
            `, observed start rate ${mUp.obs.toFixed(4)}`
        );
        // The structural prediction, asserted rather than reported. Under the
        // shipped `recordless` scope no player with a record enters `primary`, so the
        // has-record Brier cannot move. Under scope "all" it can, and then this
        // assertion is not the right one — hence the guard.
        if (XP_CONFIG.preseasonClubStartMassScope === "recordless") {
          expect(score(both.filter((r) => r.hasEvidence)).brier).toBeCloseTo(
            score(up.filter((r) => r.hasEvidence)).brier,
            12
          );
          // And the mechanism must not be inert, or the line above is vacuous.
          expect(moved).toBeGreaterThan(0);
        }
      } finally {
        XP_CONFIG.preseasonClubStartMassDown = original;
      }
    }
  );

  /**
   * The comparison `clubStartMass` asks for in its own doc block: "Anyone
   * revisiting this should start here."
   *
   * Run with SCOPE_SWEEP=1. It flips `preseasonClubStartMassScope` between the
   * two settings and scores both on identical state, then reports a paired
   * bootstrap clustered on club-season.
   */
  it.runIf(process.env.SCOPE_SWEEP)(
    "compares club start-mass scopes",
    { timeout: 900_000 },
    () => {
      const original = XP_CONFIG.preseasonClubStartMassScope;
      const runAll = (scope: typeof original) => {
        XP_CONFIG.preseasonClubStartMassScope = scope;
        const rows: Row[] = [];
        for (const s of SEASONS) rows.push(...runSeason(s, stateOf(s)));
        return rows;
      };
      try {
        const recordless = runAll("recordless");
        const spread = runAll("all");
        console.log(`\nCLUB START-MASS SCOPE, target ${XP_CONFIG.preseasonClubStartMass}`);
        console.log(`${"scope".padEnd(12)}${"n".padStart(7)}${"Brier".padStart(9)}${"Brier(ev)".padStart(11)}${"Brier(no)".padStart(11)}`);
        for (const [name, rows] of [
          ["recordless", recordless],
          ["all", spread],
        ] as const) {
          const a = score(rows);
          const e = score(rows.filter((r) => r.hasEvidence));
          const n = score(rows.filter((r) => !r.hasEvidence));
          console.log(
            `${name.padEnd(12)}${String(a.n).padStart(7)}${a.brier.toFixed(4).padStart(9)}` +
              `${e.brier.toFixed(4).padStart(11)}${n.brier.toFixed(4).padStart(11)}`
          );
        }
        for (const s of SEASONS) {
          const r1 = score(recordless.filter((r) => r.season === s));
          const r2 = score(spread.filter((r) => r.season === s));
          console.log(`  ${s}  recordless ${r1.brier.toFixed(4)}   all ${r2.brier.toFixed(4)}`);
        }
        const bs = pairedBootstrap(recordless, spread);
        console.log(
          `paired bootstrap (all minus recordless, negative favours "all"): ` +
            `${bs.mean.toFixed(5)} [${bs.lo.toFixed(5)}, ${bs.hi.toFixed(5)}]`
        );
        // How many players each scope pins at the ceiling, which is the
        // complaint that started this.
        for (const [name, rows] of [
          ["recordless", recordless],
          ["all", spread],
        ] as const) {
          const pinned = new Set(
            rows.filter((r) => r.p >= XP_CONFIG.preseasonMaxPStart - 1e-9).map((r) => r.element)
          );
          const obs = score(rows.filter((r) => r.p >= XP_CONFIG.preseasonMaxPStart - 1e-9));
          console.log(
            `${name.padEnd(12)} pinned at cap: ${pinned.size} players, observed start rate ${
              Number.isNaN(obs.obs) ? "n/a" : obs.obs.toFixed(4)
            }`
          );
        }
      } finally {
        XP_CONFIG.preseasonClubStartMassScope = original;
      }
    }
  );
});

/**
 * THE LIVE-SNAPSHOT HALF OF THE APPARATUS.
 *
 * Everything above scores the model against the archive. But several of the
 * doc blocks in `xp.ts` do not quote archive numbers at all — they quote the
 * live 2026/27 snapshot: how many clubs are short of `preseasonClubStartMass`,
 * which players the record-less rule moves and by how much, what the starts
 * defect cost Targett, whether the recommended launch squad changes. Those
 * were measured with throwaway probe files that were deleted after use, which
 * put every one of them back into the state this file's own header calls out:
 * "a measurement with no reproducible apparatus is just an assertion".
 *
 * An audit made exactly that finding, and it was right on the substance before
 * it was right on the principle. The 27-mover paragraph in
 * `preseasonRecordlessGlobalCap` was wrong three separate ways, and it was
 * wrong because the deleted probe printed the 15 players the PRIOR CLAMP moved
 * and the paragraph described all 27 — nobody could check it, so nobody did.
 *
 *   LIVE=1 npx vitest run -c vitest.preseason.config.ts --disable-console-intercept
 *
 * This half needs the snapshot at ../fpl-live/snapshot rather than the CSV
 * archive, so it skips cleanly when the snapshot is absent instead of failing.
 */
/** Only the parts of an element-summary this block reads. */
type SnapSummary = {
  history_past?: { season_name: string; minutes: number; starts?: number }[];
};

const SNAP = path.resolve(__dirname, "../../fpl-live/snapshot");
const HAVE_SNAP = fs.existsSync(path.join(SNAP, "bootstrap-static.json"));

describe.runIf(process.env.LIVE && HAVE_SNAP)("live 2026/27 snapshot", () => {
  /*
   * `runIf(false)` SKIPS THE TESTS, NOT THE BODY.
   *
   * Vitest executes a describe callback to build the suite tree and only then
   * decides not to run it, so everything at this level happens whether or not
   * the snapshot exists. An unguarded `readFileSync` here therefore throws
   * during COLLECTION, which fails the whole FILE — taking the archive-based
   * suites above it down with it, none of which need a snapshot at all.
   *
   * That is not hypothetical. It is exactly what happens on a runner that has
   * `../fpl-data` and not `../fpl-live`, which is the arrangement
   * `.github/workflows/measure.yml` creates: the first run of it failed here
   * with ENOENT before a single archive test had been collected. On a laptop
   * with both directories present the bug is invisible.
   *
   * The fallbacks only have to be CONSTRUCTIBLE, never correct: when
   * `HAVE_SNAP` is false this suite does not run, so nothing reads them.
   */
  const readSnap = <T,>(f: string, fallback: T): T =>
    HAVE_SNAP ? (JSON.parse(fs.readFileSync(path.join(SNAP, f), "utf8")) as T) : fallback;
  const bootstrap = readSnap<Bootstrap>("bootstrap-static.json", {
    events: [],
    teams: [],
    elements: [],
    total_players: 0,
  });
  const fixtures = readSnap<Fixture[]>("fixtures.json", []);
  const summaries = readSnap<Record<string, SnapSummary>>("element-summaries.json", {});
  const clubOf = new Map(bootstrap.teams.map((t) => [t.id, t.short_name]));

  /** `fetchPastSeason` goes through `fetch`; serve it from the snapshot. */
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const m = /element-summary\/(\d+)\//.exec(String(input));
    if (!m) throw new Error(`unstubbed fetch: ${String(input)}`);
    const body = summaries[m[1]];
    if (body === undefined) return new Response("null", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const nextEvent = bootstrap.events.find((e) => e.is_next)?.id ?? 1;
  const pool = launchPool(bootstrap.elements);
  const poolSet = new Set(pool);
  let past: Map<number, PastSeasonStats>;

  beforeAll(async () => {
    past = (await fetchPastSeason(pool, 16)).data;
  }, 900_000);

  /** Every pooled player's minutes model under the current XP_CONFIG. */
  const project = () => {
    XP_DEBUG.minutes = new Map();
    try {
      projectAll({ bootstrap, fixtures, nextEvent, horizon: 8, pastSeason: past });
      return new Map(
        [...XP_DEBUG.minutes].map(([id, m]) => [
          id,
          {
            p: m.pStart,
            ev: (m as unknown as { hasEvidence?: boolean }).hasEvidence === true,
          },
        ])
      );
    } finally {
      XP_DEBUG.minutes = null;
    }
  };

  /** Run `f` with config overrides, restoring every key afterwards. */
  const withCfg = <T,>(over: Partial<typeof XP_CONFIG>, f: () => T): T => {
    const keys = Object.keys(over) as (keyof typeof XP_CONFIG)[];
    const saved = keys.map((k) => [k, XP_CONFIG[k]] as const);
    Object.assign(XP_CONFIG, over);
    try {
      return f();
    } finally {
      for (const [k, v] of saved) (XP_CONFIG as Record<string, unknown>)[k as string] = v;
    }
  };

  /** The two enforcement points, switched off. */
  const NO_RULE = {
    preseasonRecordlessGlobalCap: 1,
    preseasonRecordlessMaxPStart: XP_CONFIG.preseasonMaxPStart,
  } as const;

  it("counts the starts-recorded break", () => {
    // Regenerates the table in `XP_CONFIG.startsRecordedFrom`. An audit noted
    // it stopped at 2024/25 while the snapshot carries 2025/26 too.
    // Over EVERY element summary in the snapshot, which is the population the
    // doc block names — not the launch pool, which gives smaller counts.
    const rows = new Map<string, { n: number; pos: number; zeroWithMins: number }>();
    for (const s of Object.values(summaries)) {
      for (const h of s?.history_past ?? []) {
        const r = rows.get(h.season_name) ?? { n: 0, pos: 0, zeroWithMins: 0 };
        r.n++;
        if ((h.starts ?? 0) > 0) r.pos++;
        else if (h.minutes > 0) r.zeroWithMins++;
        rows.set(h.season_name, r);
      }
    }
    console.log("\nSTARTS RECORDED BY SEASON (all element summaries, 2026/27 snapshot)");
    console.log(
      `${"season".padEnd(11)}${"rows".padStart(6)}${"starts > 0".padStart(12)}` +
        `${"starts == 0 with minutes > 0".padStart(30)}`
    );
    for (const s of [...rows.keys()].sort())
      console.log(
        `${s.padEnd(11)}${String(rows.get(s)!.n).padStart(6)}` +
          `${String(rows.get(s)!.pos).padStart(12)}${String(rows.get(s)!.zeroWithMins).padStart(30)}`
      );
    expect(rows.size).toBeGreaterThan(4);
  });

  it("measures what the starts defect cost", () => {
    // Regenerates the Targett paragraph in `startsRecordedFrom`, including the
    // minutes figure, which an audit could not reconstruct from either his
    // career total or his in-window total.
    const targett = bootstrap.elements.find((e) => /Targett/i.test(e.web_name));
    const broken = withCfg({ startsRecordedFrom: 1900 }, project);
    const fixed = project();
    if (targett) {
      const hp = summaries[targett.id]?.history_past ?? [];
      const career = hp.reduce((a, h) => a + h.minutes, 0);
      const inWindow = hp
        .filter((h) => parseInt(h.season_name.slice(0, 4), 10) >= XP_CONFIG.startsRecordedFrom)
        .reduce((a, h) => a + h.minutes, 0);
      // Every candidate reading of "credited minutes", because the doc quoted a
      // figure that matches none of them and nobody could tell which was meant.
      const y0 = XP_CONFIG.preseasonSeasonGames && 2026;
      const decayed = hp.reduce(
        (a, h) =>
          a +
          h.minutes * Math.pow(XP_CONFIG.preseasonSeasonDecay, y0 - 1 - parseInt(h.season_name.slice(0, 4), 10)),
        0
      );
      const p = past.get(targett.id);
      console.log(
        `\nTARGETT (${clubOf.get(targett.team)})  pStart ${broken.get(targett.id)?.p.toFixed(3)}` +
          ` -> ${fixed.get(targett.id)?.p.toFixed(3)}`
      );
      console.log(
        `  minutes: career ${career}  in-window(>=${XP_CONFIG.startsRecordedFrom}) ${inWindow}` +
          `  decay-weighted ${decayed.toFixed(0)}  last-season (PastSeasonStats.minutes) ${p?.minutes ?? "n/a"}`
      );
      console.log(`  seasons on record: ${hp.map((h) => `${h.season_name}:${h.minutes}`).join(" ")}`);
    }
    // Club sums with the defect restored. The `startsRecordedFrom` paragraph
    // names IPS and HUL, and it means the RAW sums — the deficit the mechanism
    // is then handed — so the mechanism has to be off to see them.
    const sums = (mm: ReturnType<typeof project>, poolOnly: boolean) => {
      const s = new Map<number, number>();
      for (const el of bootstrap.elements) {
        if (el.element_type < 2 || el.element_type > 4) continue;
        if (poolOnly && !poolSet.has(el.id)) continue;
        const m = mm.get(el.id);
        if (m) s.set(el.team, (s.get(el.team) ?? 0) + m.p);
      }
      return s;
    };
    const rawBroken = withCfg({ startsRecordedFrom: 1900, preseasonClubStartMass: 0 }, project);
    const rawFixed = withCfg({ preseasonClubStartMass: 0 }, project);
    for (const [label, b, f] of [
      ["mechanism OFF (the raw deficit)", rawBroken, rawFixed],
      ["mechanism ON (what the squad sees)", broken, fixed],
    ] as const) {
      for (const poolOnly of [false, true]) {
        const bs = sums(b, poolOnly);
        const fs2 = sums(f, poolOnly);
        console.log(
          `\nCLUB START MASS, starts defect restored -> fixed  [${label}, ${
            poolOnly ? "LAUNCH POOL ONLY" : "ALL OUTFIELD"
          }]`
        );
        for (const [t, v] of [...bs].sort((x, y) => x[1] - y[1]).slice(0, 6))
          console.log(
            `  ${(clubOf.get(t) ?? "?").padEnd(5)} ${v.toFixed(2)}  ->  ${fs2.get(t)!.toFixed(2)}`
          );
      }
    }
    expect(fixed.size).toBeGreaterThan(300);
  });

  it("counts the clubs short of the start-mass target", () => {
    // Regenerates the "12 of 20 on the live snapshot" bullet in the
    // `clubStartMass` header AND the "TOWARD, NOT TO" paragraph in
    // `preseasonClubStartMass`. Both regimes are printed because an audit
    // found the two paragraphs quoting figures from DIFFERENT regimes twenty
    // lines apart, which is how the ordering came out inverted.
    const sums = (mm: ReturnType<typeof project>, poolOnly: boolean) => {
      const s = new Map<number, number>();
      for (const el of bootstrap.elements) {
        if (el.element_type < 2 || el.element_type > 4) continue;
        if (poolOnly && !poolSet.has(el.id)) continue;
        const m = mm.get(el.id);
        if (m) s.set(el.team, (s.get(el.team) ?? 0) + m.p);
      }
      return [...s].map(([t, v]) => [clubOf.get(t) ?? "?", v] as const).sort((a, b) => a[1] - b[1]);
    };
    const variants: [string, () => ReturnType<typeof project>][] = [
      ["mechanism OFF", () => withCfg({ preseasonClubStartMass: 0 }, project)],
      ["mechanism ON, rule OFF", () => withCfg(NO_RULE, project)],
      ["shipped", project],
    ];
    for (const poolOnly of [false, true]) {
      console.log(
        `\nCLUBS SHORT OF preseasonClubStartMass (outfield, ${poolOnly ? "LAUNCH POOL ONLY" : "ALL OUTFIELD"})`
      );
      if (poolOnly)
        console.log(
          "  (structurally short and NOT a shortfall measure: `clubStartMass` allocates over\n" +
            "   the whole element list, so summing a subset of it must come out under target.\n" +
            "   Quote the ALL OUTFIELD block. An audit found two doc paragraphs twenty lines\n" +
            "   apart quoting one regime each, which is how the club ordering came out inverted.)"
        );
      for (const [name, run] of variants) {
        const rows = sums(run(), poolOnly);
        const short = rows.filter(([, v]) => v < XP_CONFIG.preseasonClubStartMass - 1e-6);
        console.log(
          `  ${name.padEnd(24)} short ${String(short.length).padStart(2)}/20   ` +
            short.map(([c, v]) => `${c} ${v.toFixed(2)}`).join(", ")
        );
      }
    }
    expect(sums(project(), false).length).toBe(20);
  });

  it("lists every player the record-less rule moves", () => {
    // Regenerates the paragraph in `preseasonRecordlessGlobalCap` that
    // characterises the movers. The deleted probe printed only the players the
    // PRIOR CLAMP moved that the lift ceiling did not — 15 of the 27 — and the
    // paragraph generalised from that subset to all 27 and got it wrong three
    // ways. Every mover is printed here, tagged with which point moved him.
    const none = withCfg(NO_RULE, project);
    const ceilOnly = withCfg({ preseasonRecordlessGlobalCap: 1 }, project);
    const shipped = project();
    const moved = (a: typeof none, b: typeof none) =>
      [...b].filter(([id, v]) => poolSet.has(id) && Math.abs(v.p - (a.get(id)?.p ?? v.p)) > 1e-6);

    const recordless = [...shipped].filter(([id, v]) => poolSet.has(id) && !v.ev).length;
    console.log(`\nlaunch pool ${pool.length} of ${bootstrap.elements.length} elements`);
    console.log(`record-less in pool: ${recordless}`);
    console.log(`moved by the ceiling alone : ${moved(none, ceilOnly).length}`);
    console.log(`moved by the shipped rule  : ${moved(none, shipped).length}`);
    console.log(`moved by the clamp only    : ${moved(ceilOnly, shipped).length}`);

    // A player can be moved by both points, so these are not exclusive tags.
    const byCeiling = new Set(moved(none, ceilOnly).map(([id]) => id));
    const byClamp = new Set(moved(ceilOnly, shipped).map(([id]) => id));
    const rows = moved(none, shipped)
      .map(([id, v]) => {
        const el = bootstrap.elements.find((e) => e.id === id)!;
        const tag = [byCeiling.has(id) && "ceiling", byClamp.has(id) && "clamp"]
          .filter(Boolean)
          .join("+");
        return { el, before: none.get(id)!.p, after: v.p, tag };
      })
      .sort((a, b) => b.after - b.before - (a.after - a.before));
    console.log(`\nEVERY MOVER (${rows.length}), sorted by signed change:`);
    for (const r of rows)
      console.log(
        `  ${r.el.web_name.padEnd(18)}${(clubOf.get(r.el.team) ?? "?").padEnd(5)}` +
          `£${(r.el.now_cost / 10).toFixed(1)}  own ${r.el.selected_by_percent.padStart(5)}%  ` +
          `${r.before.toFixed(3)} -> ${r.after.toFixed(3)}  ${r.tag}`
      );
    const up = rows.filter((r) => r.after > r.before).length;
    console.log(
      `\nlifted ${up}, cut ${rows.length - up};  price range £${(
        Math.min(...rows.map((r) => r.el.now_cost)) / 10
      ).toFixed(1)}-${(Math.max(...rows.map((r) => r.el.now_cost)) / 10).toFixed(1)};  ` +
        `max ownership ${Math.max(...rows.map((r) => parseFloat(r.el.selected_by_percent))).toFixed(1)}%;  ` +
        `clubs ${[...new Set(rows.map((r) => clubOf.get(r.el.team)))].sort().join(" ")}`
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("measures the record-less goalkeepers the rule deliberately skips", () => {
    // Pins the live evidence behind the KEEPERS ARE OUT OF SCOPE paragraph in
    // `preseasonRecordlessGlobalCap`.
    const shipped = project();
    const gks = bootstrap.elements
      .filter((e) => e.element_type === 1 && shipped.get(e.id) && !shipped.get(e.id)!.ev)
      .map((e) => ({ e, p: shipped.get(e.id)!.p }))
      .sort((a, b) => b.p - a.p);
    const inPool = gks.filter((g) => poolSet.has(g.e.id));
    const cap = XP_CONFIG.preseasonRecordlessGlobalCap;
    console.log(`\nRECORD-LESS GOALKEEPERS: ${gks.length} total, ${inPool.length} in pool`);
    console.log(`  above the ${cap} cap: ${gks.filter((g) => g.p > cap + 1e-9).length}`);
    for (const g of gks.slice(0, 5))
      console.log(
        `  ${g.e.web_name.padEnd(18)}${(clubOf.get(g.e.team) ?? "?").padEnd(5)}${g.p.toFixed(3)}` +
          (poolSet.has(g.e.id) ? "  (in pool)" : "")
      );
    expect(gks.length).toBeGreaterThan(0);
  });

  it("checks whether the rule changes the recommended launch squad", async () => {
    const { buildLaunchSquad } = await import("../src/lib/optimizer");
    const build = () => {
      const s = buildLaunchSquad(bootstrap, fixtures, nextEvent, 8, past);
      return {
        ids: s.squad.map((e) => e.id).sort((a, b) => a - b),
        names: s.squad
          .map((e) => `${e.web_name}(${clubOf.get(e.team)},${(e.now_cost / 10).toFixed(1)})`)
          .join(" "),
        cost: s.cost,
        xi: s.xi.starters.map((x) => x.element.id).sort((a, b) => a - b),
      };
    };
    const none = withCfg(NO_RULE, build);
    const ceil = withCfg({ preseasonRecordlessGlobalCap: 1 }, build);
    const shipped = build();
    const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    console.log(`\nsquad identical, no-rule vs ceiling-only : ${same(none.ids, ceil.ids)}`);
    console.log(`squad identical, ceiling-only vs shipped : ${same(ceil.ids, shipped.ids)}`);
    console.log(`XI identical,    ceiling-only vs shipped : ${same(ceil.xi, shipped.xi)}`);
    console.log(`\nno-rule £${(none.cost / 10).toFixed(1)}  ${none.names}`);
    console.log(`\nceiling £${(ceil.cost / 10).toFixed(1)}  ${ceil.names}`);
    console.log(`\nshipped £${(shipped.cost / 10).toFixed(1)}  ${shipped.names}`);
    expect(shipped.ids.length).toBe(15);
  }, 900_000);
});
