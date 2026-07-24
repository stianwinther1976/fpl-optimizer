/**
 * Season backtest: replay 2025/26 pretending each gameweek hasn't happened,
 * run the REAL production model on the reconstructed pre-GW state, then grade
 * against what actually happened.
 *
 * Run: npx vitest run scripts/backtest.test.ts
 * Data: ../fpl-data/data/2025-26 (vaastav/Fantasy-Premier-League dataset)
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { projectAll } from "../src/lib/xp";
import {
  applyGwOutcome,
  setActiveCalibration,
  IDENTITY_FACTORS,
  type CalibrationState,
  type GradedPlayer,
} from "../src/lib/calibration";
import type { Bootstrap, Element, ElementType, Fixture, Team } from "../src/lib/types";

// Season under test — override with SEASON=2024-25 to backtest a different year.
const SEASON = process.env.SEASON ?? "2025-26";
const DATA = path.resolve(__dirname, `../../fpl-data/data/${SEASON}`);

// ---------- tiny CSV parser (handles quoted fields with commas/JSON) --------
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

// ---------- load season data ------------------------------------------------
interface GwRow {
  element: number;
  round: number;
  minutes: number;
  starts: number;
  totalPoints: number;
  goals: number;
  assists: number;
  bonus: number;
  saves: number;
  ict: number;
  xg: number;
  xa: number;
  dc: number;
  value: number;
  vaastavXp: number;
}

function loadSeason() {
  const teamsRaw = parseCsv(fs.readFileSync(path.join(DATA, "teams.csv"), "utf8"));
  const teams: Team[] = teamsRaw.map((t) => ({
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

  const playersRaw = parseCsv(fs.readFileSync(path.join(DATA, "players_raw.csv"), "utf8"));
  const meta = new Map(
    playersRaw.map((p) => [
      +p.id,
      {
        web_name: p.web_name,
        team: +p.team,
        element_type: +p.element_type as ElementType,
        penalties_order: p.penalties_order ? +p.penalties_order : null,
        corners: p.corners_and_indirect_freekicks_order
          ? +p.corners_and_indirect_freekicks_order
          : null,
        fk: p.direct_freekicks_order ? +p.direct_freekicks_order : null,
      },
    ])
  );

  const fxRaw = parseCsv(fs.readFileSync(path.join(DATA, "fixtures.csv"), "utf8"));
  const fixturesBase = fxRaw
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
  const rows: GwRow[] = gwRaw.map((r) => ({
    element: +r.element,
    round: +r.round,
    minutes: +r.minutes,
    starts: +(r.starts || 0),
    totalPoints: +r.total_points,
    goals: +r.goals_scored,
    assists: +r.assists,
    bonus: +r.bonus,
    saves: +r.saves,
    ict: +r.ict_index,
    xg: +(r.expected_goals || 0),
    xa: +(r.expected_assists || 0),
    dc: +(r.defensive_contribution || 0),
    value: +r.value,
    vaastavXp: +(r.xP || 0),
  }));

  // rows indexed by element, sorted by round
  const byElement = new Map<number, GwRow[]>();
  for (const r of rows) {
    const arr = byElement.get(r.element);
    if (arr) arr.push(r);
    else byElement.set(r.element, [r]);
  }
  for (const arr of byElement.values()) arr.sort((a, b) => a.round - b.round);

  return { teams, meta, fixturesBase, byElement };
}

// ---------- reconstruct the world as it looked before GW g ------------------
function buildStateAt(
  g: number,
  season: ReturnType<typeof loadSeason>
): {
  bootstrap: Bootstrap;
  fixtures: Fixture[];
  recentStarts: Map<number, number>;
  actual: Map<number, number>;
  minutesAt: Map<number, number>;
  vaastav: Map<number, number>;
  form: Map<number, number>;
  ppg: Map<number, number>;
} {
  const { teams, meta, byElement } = season;
  const elements: Element[] = [];
  const recentStarts = new Map<number, number>();
  const actual = new Map<number, number>();
  const minutesAt = new Map<number, number>();
  const vaastav = new Map<number, number>();
  const formMap = new Map<number, number>();
  const ppgMap = new Map<number, number>();

  for (const [id, all] of byElement) {
    const m = meta.get(id);
    if (!m) continue;
    const past = all.filter((r) => r.round < g);
    const atG = all.filter((r) => r.round === g);
    if (past.length === 0 && atG.length === 0) continue;

    const cum = past.reduce(
      (s, r) => ({
        minutes: s.minutes + r.minutes,
        starts: s.starts + r.starts,
        points: s.points + r.totalPoints,
        goals: s.goals + r.goals,
        assists: s.assists + r.assists,
        bonus: s.bonus + r.bonus,
        saves: s.saves + r.saves,
        ict: s.ict + r.ict,
        xg: s.xg + r.xg,
        xa: s.xa + r.xa,
        dc: s.dc + r.dc,
      }),
      { minutes: 0, starts: 0, points: 0, goals: 0, assists: 0, bonus: 0, saves: 0, ict: 0, xg: 0, xa: 0, dc: 0 }
    );
    const price = atG[0]?.value ?? past[past.length - 1]?.value ?? 50;
    const recent = past.slice(-4);
    const form = recent.length > 0 ? recent.reduce((s, r) => s + r.totalPoints, 0) / recent.length : 0;
    const played = past.filter((r) => r.minutes > 0).length;
    const ppg = played > 0 ? cum.points / played : 0;
    const last5 = past.slice(-5);
    if (last5.length > 0) {
      recentStarts.set(id, last5.filter((r) => r.starts > 0).length / last5.length);
    }
    if (atG.length > 0) {
      actual.set(id, atG.reduce((s, r) => s + r.totalPoints, 0));
      minutesAt.set(id, atG.reduce((s, r) => s + r.minutes, 0));
      vaastav.set(id, atG[0].vaastavXp);
    }
    formMap.set(id, form);
    ppgMap.set(id, ppg);

    elements.push({
      id,
      web_name: m.web_name,
      first_name: "",
      second_name: m.web_name,
      team: m.team,
      element_type: m.element_type,
      now_cost: price,
      cost_change_start: 0,
      form: form.toFixed(1),
      points_per_game: ppg.toFixed(1),
      total_points: cum.points,
      event_points: 0,
      status: "a", // historical availability unknown — the model flies blind here
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
      defensive_contribution: cum.dc,
      ep_next: null,
      penalties_order: m.penalties_order,
      corners_and_indirect_freekicks_order: m.corners,
      direct_freekicks_order: m.fk,
      saves: cum.saves,
    });
  }

  const bootstrap: Bootstrap = {
    events: Array.from({ length: 38 }, (_, i) => ({
      id: i + 1,
      name: `Gameweek ${i + 1}`,
      deadline_time: "",
      finished: i + 1 < g,
      is_current: i + 1 === g - 1,
      is_next: i + 1 === g,
      average_entry_score: 0,
      highest_score: null,
    })),
    teams,
    elements,
    total_players: 10_000_000,
  };
  const fixtures: Fixture[] = season.fixturesBase.map((f) => ({
    ...f,
    finished: f.event < g,
    started: f.event < g,
    team_h_score: null,
    team_a_score: null,
  }));
  return { bootstrap, fixtures, recentStarts, actual, minutesAt, vaastav, form: formMap, ppg: ppgMap };
}

// ---------- metrics ---------------------------------------------------------
function spearman(pairs: [number, number][]): number {
  const rank = (vals: number[]) => {
    const idx = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(vals.length).fill(0);
    idx.forEach(([, orig], r) => (ranks[orig] = r));
    return ranks;
  };
  const ra = rank(pairs.map((p) => p[0]));
  const rb = rank(pairs.map((p) => p[1]));
  const n = pairs.length;
  const ma = ra.reduce((s, v) => s + v, 0) / n;
  const mb = rb.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}

interface GwEval {
  gw: number;
  n: number;
  mae: number;
  bias: number;
  rho: number;
  top10Actual: number;
  top10Form: number;
  top10Ppg: number;
  top10Vaastav: number;
  capActual: number;
  capForm: number;
  bestPossibleCap: number;
  maeForm: number;
  maeVaastav: number;
  fitBias: number;
}

describe(`${SEASON} season backtest`, () => {
  it("replays the season blind and grades the model", { timeout: 600_000 }, () => {
    const season = loadSeason();
    const START = 2;
    const END = 38;

    const run = (useCalibration: boolean, useRecentStarts: boolean) => {
      let cal: CalibrationState = { factors: IDENTITY_FACTORS, log: [], reconciled: [] };
      setActiveCalibration(IDENTITY_FACTORS);
      const evals: GwEval[] = [];
      for (let g = START; g <= END; g++) {
        const st = buildStateAt(g, season);
        if (useCalibration) setActiveCalibration(cal.factors);
        const xp = projectAll({
          bootstrap: st.bootstrap,
          fixtures: st.fixtures,
          nextEvent: g,
          horizon: 1,
          recentStarts: useRecentStarts ? st.recentStarts : undefined,
        });

        // Grade the same set the live app grades: predictions >= 1.0 pts.
        const graded: { id: number; pred: number; act: number; pos: number }[] = [];
        for (const [id, p] of xp) {
          if (!Number.isFinite(p.next) || p.next < 1.0) continue;
          if (season.meta.get(id)!.element_type > 4) continue; // skip managers
          if (!st.actual.has(id)) continue; // no fixture rows that GW
          graded.push({
            id,
            pred: p.next,
            act: st.actual.get(id)!,
            pos: season.meta.get(id)!.element_type,
          });
        }
        if (graded.length < 30) continue;

        const mae = graded.reduce((s, e) => s + Math.abs(e.pred - e.act), 0) / graded.length;
        const sumP = graded.reduce((s, e) => s + e.pred, 0);
        const sumA = graded.reduce((s, e) => s + e.act, 0);
        // Bias among players who actually played: isolates model inflation
        // from the backtest's availability blindness (injuries unknown).
        const playedSet = graded.filter((e) => (st.minutesAt.get(e.id) ?? 0) > 0);
        const fitBias =
          playedSet.reduce((s, e) => s + e.act, 0) > 0
            ? playedSet.reduce((s, e) => s + e.pred, 0) / playedSet.reduce((s, e) => s + e.act, 0) - 1
            : 0;
        const rho = spearman(graded.map((e) => [e.pred, e.act]));

        const topByMap = (m: Map<number, number>) =>
          graded
            .slice()
            .sort((a, b) => (m.get(b.id) ?? 0) - (m.get(a.id) ?? 0))
            .slice(0, 10)
            .reduce((s, e) => s + e.act, 0) / 10;
        const top10Actual =
          graded.slice().sort((a, b) => b.pred - a.pred).slice(0, 10).reduce((s, e) => s + e.act, 0) /
          10;
        const capPick = graded.slice().sort((a, b) => b.pred - a.pred)[0];
        const capFormPick = graded
          .slice()
          .sort((a, b) => (st.form.get(b.id) ?? 0) - (st.form.get(a.id) ?? 0))[0];
        const bestCap = Math.max(...graded.map((e) => e.act));

        const maeForm =
          graded.reduce((s, e) => s + Math.abs((st.form.get(e.id) ?? 0) - e.act), 0) /
          graded.length;
        const maeVaastav =
          graded.reduce((s, e) => s + Math.abs((st.vaastav.get(e.id) ?? 0) - e.act), 0) /
          graded.length;

        evals.push({
          gw: g,
          n: graded.length,
          mae,
          bias: sumA > 0 ? sumP / sumA - 1 : 0,
          rho,
          top10Actual,
          top10Form: topByMap(st.form),
          top10Ppg: topByMap(st.ppg),
          top10Vaastav: topByMap(st.vaastav),
          capActual: capPick.act,
          capForm: capFormPick.act,
          bestPossibleCap: bestCap,
          maeForm,
          maeVaastav,
          fitBias,
        });

        if (useCalibration) {
          const entries: GradedPlayer[] = graded.map((e) => ({
            pos: e.pos,
            pred: e.pred,
            actual: e.act,
          }));
          cal = applyGwOutcome(cal, g, entries, 0);
        }
      }
      setActiveCalibration(IDENTITY_FACTORS);
      return { evals, cal };
    };

    const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const summarize = (evals: GwEval[], label: string) => {
      const late = evals.filter((e) => e.gw >= 8);
      const early = evals.filter((e) => e.gw < 8);
      return {
        label,
        gws: evals.length,
        mae: avg(evals.map((e) => e.mae)),
        maeEarly: early.length ? avg(early.map((e) => e.mae)) : NaN,
        maeLate: avg(late.map((e) => e.mae)),
        bias: avg(evals.map((e) => e.bias)),
        biasLate: avg(late.map((e) => e.bias)),
        fitBias: avg(evals.map((e) => e.fitBias)),
        rho: avg(evals.map((e) => e.rho)),
        top10: avg(evals.map((e) => e.top10Actual)),
        top10Form: avg(evals.map((e) => e.top10Form)),
        top10Ppg: avg(evals.map((e) => e.top10Ppg)),
        top10Vaastav: avg(evals.map((e) => e.top10Vaastav)),
        cap: avg(evals.map((e) => e.capActual)),
        capForm: avg(evals.map((e) => e.capForm)),
        bestCap: avg(evals.map((e) => e.bestPossibleCap)),
        maeForm: avg(evals.map((e) => e.maeForm)),
        maeVaastav: avg(evals.map((e) => e.maeVaastav)),
      };
    };

    const full = run(true, true);
    const noCal = run(false, true);
    const noRecent = run(false, false);

    const report = {
      full: summarize(full.evals, "full model + self-calibration"),
      noCal: summarize(noCal.evals, "model without calibration"),
      noRecent: summarize(noRecent.evals, "without recent-starts"),
      finalFactors: full.cal.factors,
      perGw: full.evals.map((e) => ({
        gw: e.gw,
        n: e.n,
        mae: +e.mae.toFixed(3),
        bias: +e.bias.toFixed(3),
        rho: +e.rho.toFixed(3),
      })),
    };
    fs.writeFileSync(
      path.resolve(__dirname, `../backtest-report-${SEASON}.json`),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify({ full: report.full, noCal: report.noCal, noRecent: report.noRecent, finalFactors: report.finalFactors }, null, 2));

    // What the optimizer actually uses is the RANKING — it must clearly beat
    // naive baselines, and calibrated bias must be small.
    expect(report.full.top10).toBeGreaterThan(report.full.top10Form);
    expect(report.full.top10).toBeGreaterThan(report.full.top10Ppg);
    expect(report.full.cap).toBeGreaterThan(report.full.capForm);
    expect(report.full.rho).toBeGreaterThan(0.4);
    expect(Math.abs(report.full.biasLate)).toBeLessThan(0.2);
  });
});
