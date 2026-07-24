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
import type { Bootstrap, Element, ElementType, Fixture, OwnedPlayer, Team } from "../src/lib/types";

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
        penalties_order: p.penalties_order ? +p.penalties_order : null,
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
  return { teams, meta, fixturesBase, byElement, lastRound };
}

type Season = ReturnType<typeof loadSeason>;

function buildStateAt(g: number, season: Season) {
  const { teams, meta, fixturesBase, byElement } = season;
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
      team: m.team,
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
      ep_next: null,
      penalties_order: m.penalties_order,
      saves: cum.saves,
    });
  }
  const bootstrap: Bootstrap = {
    events: Array.from({ length: season.lastRound }, (_, i) => ({
      id: i + 1,
      name: `GW${i + 1}`,
      deadline_time: "",
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
    const launch = buildLaunchSquad(s1.bootstrap, s1.fixtures, 1, 5);
    const squad = launch.squad.map((e) => e.id);
    let bank = 1000 - launch.squad.reduce((sum, e) => sum + e.now_cost, 0);
    let ft = 1;
    const buyPrice = new Map<number, number>(launch.squad.map((e) => [e.id, e.now_cost]));

    let modelTotal = 0;
    const setForgetSquad = [...squad];
    let setForgetTotal = 0;
    let transfersMade = 0;

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
