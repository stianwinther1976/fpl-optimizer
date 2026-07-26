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
import { projectAll, XP_CONFIG, XP_DEBUG } from "../src/lib/xp";
import { repairStartsColumn } from "./archiveRepair";
import {
  applyGwOutcome,
  setActiveCalibration,
  IDENTITY_FACTORS,
  type CalibrationState,
  type GradedPlayer,
} from "../src/lib/calibration";
import type {
  Bootstrap,
  Element,
  ElementType,
  Fixture,
  RecentForm,
  Team,
} from "../src/lib/types";

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
  yellows: number;
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
    yellows: +(r.yellow_cards || 0),
    saves: +r.saves,
    ict: +r.ict_index,
    xg: +(r.expected_goals || 0),
    xa: +(r.expected_assists || 0),
    dc: +(r.defensive_contribution || 0),
    value: +r.value,
    vaastavXp: +(r.xP || 0),
  }));

  // See scripts/archiveRepair.ts — the 2022-23 dump's `starts` column is zero
  // for every player in gameweeks 1-15 while ~300 played, which silently voided
  // the model's best in-season minutes signal for that whole stretch. Unit
  // tested in src/lib/__tests__/archiveRepair.test.ts.
  const brokenRounds = repairStartsColumn(rows);
  if (brokenRounds.length) {
    console.log(
      `STARTS-COLUMN REPAIRED for ${SEASON}: rounds ${brokenRounds.join(",")} had zero starts and non-zero minutes; substituted minutes >= 45.`
    );
  }

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
  recentForm: Map<number, RecentForm>;
  actual: Map<number, number>;
  minutesAt: Map<number, number>;
  vaastav: Map<number, number>;
  form: Map<number, number>;
  ppg: Map<number, number>;
} {
  const { teams, meta, byElement } = season;
  const elements: Element[] = [];
  const recentForm = new Map<number, RecentForm>();
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
        yellows: s.yellows + r.yellows,
        saves: s.saves + r.saves,
        ict: s.ict + r.ict,
        xg: s.xg + r.xg,
        xa: s.xa + r.xa,
        dc: s.dc + r.dc,
      }),
      { minutes: 0, starts: 0, points: 0, goals: 0, assists: 0, bonus: 0, yellows: 0, saves: 0, ict: 0, xg: 0, xa: 0, dc: 0 }
    );
    const price = atG[0]?.value ?? past[past.length - 1]?.value ?? 50;
    const recent = past.slice(-4);
    const form = recent.length > 0 ? recent.reduce((s, r) => s + r.totalPoints, 0) / recent.length : 0;
    const played = past.filter((r) => r.minutes > 0).length;
    const ppg = played > 0 ? cum.points / played : 0;
    const last5 = past.slice(-5);
    if (last5.length > 0) {
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
      // FLAT FOR EVERY PLAYER, WHICH MAKES THIS HARNESS BLIND TO THE OWNERSHIP
      // FAMILY. `ownershipPercentiles` drops a position whose column carries no
      // order, so `priorPStartOwnWeight`, `priorPStartOwnGamma`,
      // `priorPStartOwnRange` and `gkPreseason.ownWeight` are all inert in
      // every `backtest-report-*.json` ever produced. A sweep of any of them
      // run through this file will report "no effect" and mean "not measured".
      // The archive does carry per-round `selected` (see `gws/gw*.csv`, which
      // the simulator reads), so this is a gap in the harness rather than in
      // the data; it has not been filled because the in-season backtest is not
      // where those weights were fitted. Fix it before quoting this report on
      // anything ownership-related.
      selected_by_percent: "0.0",
      minutes: cum.minutes,
      starts: cum.starts,
      goals_scored: cum.goals,
      assists: cum.assists,
      clean_sheets: 0,
      goals_conceded: 0,
      bonus: cum.bonus,
      // Read the scope of this carefully; an earlier version of this comment got
      // it wrong. This harness grades `p.next` at `horizon: 1`, so offset 0 is
      // the ONLY thing it ever sees, and the suspension term is a no-op there
      // for a SINGLE fixture — not for a double, where a booking in the first
      // leg can cost the second. The archives hold 42/23/10/10 team-doubles
      // across 2022-23 to 2025-26, and that is exactly why three of the four
      // `backtest-report-*.json` files moved when the term went in.
      //
      // 2023-24 did not move, and the reason is NOT that its doubles fall after
      // the five-card window shuts — an earlier version of this comment said so
      // and the fixture list contradicts it. Two of its 23 doubles are served at
      // team match 7, inside [5, 19], and six more at matches 25-28 are inside
      // the open [10, 32]; meanwhile 2024-25 and 2025-26 both moved with zero
      // doubles inside the five-card window at all. The discriminator is at
      // player level: nobody at a 2023-24 doubling club happened to be sitting
      // one card short of an open threshold. Which also sizes the claim
      // honestly — "three of four seasons move" rests on ten player-double
      // events in four seasons, so it shows the channel is live and nothing
      // more.
      //
      // So a green report here is weak evidence about one narrow channel —
      // suspension risk inside imminent double gameweeks — and says nothing
      // about the rest of the term. The simulator plans over five weeks and is
      // where the term can actually bite, though see the note there about what
      // that harness can and cannot resolve.
      yellow_cards: cum.yellows,
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
  return { bootstrap, fixtures, recentForm, actual, minutesAt, vaastav, form: formMap, ppg: ppgMap };
}

// ---------- metrics ---------------------------------------------------------
function spearman(pairs: [number, number][]): number {
  // MIDRANKS, for the same reason the launch simulator needs them, only more
  // so. Over a SINGLE gameweek the actual-points vector is mostly ties: a
  // majority of the pool does not play or plays and scores nothing, so they all
  // sit on the same value. Ranking those by array index gives them distinct
  // ranks in both vectors in the same order, which invents agreement out of
  // nothing and inflates every number this harness reports. Tied values must
  // share a rank; that is what makes the coefficient mean what it says.
  const rank = (vals: number[]) => {
    const idx = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    const ranks = new Array(vals.length).fill(0);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && vals[idx[j + 1]] === vals[idx[i]]) j++;
      const mid = (i + j) / 2;
      for (let k = i; k <= j; k++) ranks[idx[k]] = mid;
      i = j + 1;
    }
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
  nAll: number;
  mae: number;
  bias: number;
  rho: number;
  rhoAll: number;
  rhoPlayed: number;
  rhoAllForm: number;
  rhoPlayedForm: number;
  nPlayed: number;
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
/**
 * The instrument that produced `XP_CONFIG.p60Curve`.
 *
 * It is kept rather than deleted because the two constants in that config entry
 * are a measurement, and a measurement with no reproducible apparatus is just an
 * assertion. Re-run it per season with:
 *
 *   P60PROBE=1 SEASON=2024-25 npx vitest run -c vitest.backtest.config.ts \
 *     --disable-console-intercept -t "dumps"
 *
 * It writes `/tmp/p60-<SEASON>.csv` with one row per player-gameweek: the
 * model's OWN `pStart` and `minsPerStart` at prediction time (read out of
 * `XP_DEBUG.minutes`, i.e. through the real `projectAll` path rather than a
 * replica of it) beside what the player actually did that round. Fitting the
 * logistic on the rows where `started === 1` reproduces the curve.
 *
 * Reading the model's own state is the point. A table built from the season's
 * final minutes-per-start would condition on the outcome and leak, and would
 * flatter any curve fitted to it.
 *
 * Off by default — it costs ~37 full `buildStateAt` passes and writes to /tmp.
 */
describe(`${SEASON} p60 probe`, () => {
  it.runIf(process.env.P60PROBE)("dumps the model's own minsPerStart against outcomes", { timeout: 600_000 }, () => {
    const season = loadSeason();
    const out: string[] = [];
    for (let g = 2; g <= 38; g++) {
      const st = buildStateAt(g, season);
      XP_DEBUG.minutes = new Map();
      projectAll({
        bootstrap: st.bootstrap,
        fixtures: st.fixtures,
        nextEvent: g,
        horizon: 1,
        recentForm: st.recentForm,
      });
      const mmAll = XP_DEBUG.minutes!;
      XP_DEBUG.minutes = null;
      for (const [id, rows] of season.byElement) {
        const row = rows.find((r) => r.round === g);
        if (!row) continue;
        const mm = mmAll.get(id);
        if (!mm) continue;
        out.push(
          [id, g, mm.pStart.toFixed(4), mm.minsPerStart.toFixed(2), row.starts > 0 ? 1 : 0, row.minutes].join(",")
        );
      }
    }
    fs.writeFileSync(`/tmp/p60-${SEASON}.csv`, "element,round,pStart,minsPerStart,started,minutes\n" + out.join("\n"));
    console.log(`wrote /tmp/p60-${SEASON}.csv (${out.length} rows)`);
  });
});

describe(`${SEASON} season backtest`, () => {
  it("replays the season blind and grades the model", { timeout: 600_000 }, () => {
    const season = loadSeason();
    const START = 2;
    const END = 38;

    /**
     * How much of the last-five record the arm is allowed to see.
     *
     * `recentForm` carries three numbers on two independent axes — how OFTEN he
     * starts (`startShare`, plus `minsPerGame` for the substitute floor) and how
     * LONG he lasts once he does (`minsPerStart`). One boolean used to gate all
     * three, so the ablation could only say "the block helps" and the report
     * line called the whole thing "recent-starts", which was the name of only
     * one of the axes.
     *
     * `starts` supplies the record with `minsPerStart` nulled, which is exactly
     * the state the live fetch produces for a player who started none of his
     * last five: the minutes model then falls back to the season figure. So the
     * gap between `full` and `starts` is the measured-minutes term alone, and
     * the gap between `starts` and `none` is the start-share term alone.
     */
    type RecentMode = "full" | "starts" | "none";

    const recentFor = (st: ReturnType<typeof buildStateAt>, mode: RecentMode) => {
      if (mode === "none") return undefined;
      if (mode === "full") return st.recentForm;
      const stripped = new Map<number, RecentForm>();
      for (const [id, f] of st.recentForm) stripped.set(id, { ...f, minsPerStart: null });
      return stripped;
    };

    const run = (useCalibration: boolean, recentMode: RecentMode) => {
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
          recentForm: recentFor(st, recentMode),
        });

        // Two populations, and the difference between them is the whole reason
        // `rhoAll` exists.
        //
        // `graded` is the set the live app grades: predictions >= 1.0 pts. That
        // is the right population for mae, bias, calibration and the top-10
        // baselines, because it is the set a manager actually reads.
        //
        // It is the WRONG population for comparing one version of the model
        // against another, because the threshold is applied to the model's own
        // output, so improving the model changes who is in the sample. Measured
        // on 2022-23: the pre-`dfa053e` model put 331.8 players per gameweek
        // over 1.0 xP and scored rho 0.4346; the model that fixed the cameo bug
        // puts 261.7 over the line and scores 0.2784. That reads as a 0.15
        // regression and is the opposite of one. On the FIXED population below
        // — every player with a fixture row, 677.3 per gameweek, chosen without
        // consulting the model — the same two versions score 0.1597 and 0.6244.
        // The old model was handing >= 1.0 xP to a crowd of cameo players it had
        // no business rating: 124-149 extra players per gameweek, mean
        // cumulative minutes 23-36 against a population mean of 455-501, 82-86%
        // of them on zero minutes that week. Those wrong-but-low predictions sat
        // at percentile 18-32 by prediction and 27-35 by actual — bottom of both
        // rank vectors — and manufactured agreement. Removing them removed the
        // free correlation along with the error.
        //
        // One correction to that story, because an earlier version of this
        // comment applied it to the 0.1597 too and it does not fit there. 0.1597
        // is not a level, it is a mean over a bimodal series: twelve of the
        // thirty-seven 2022-23 gameweeks are NEGATIVE for the old model, and the
        // mean over the other twenty-five is 0.4250, in line with the other
        // seasons. Across GW5-17 the old model's correlation against cumulative
        // minutes runs -0.41 to -0.66 — at GW12 its mean prediction for players
        // with 700+ minutes was 0.193 and for players with ZERO minutes 0.861,
        // a four-and-a-half-fold inversion — and its count over 1.0 xP collapses
        // 509 -> 31 and snaps back to 573 by GW19. That is a severe localised
        // defect in the one season with no prior season in the archive, not the
        // same phenomenon as the threshold drift. The threshold argument stands
        // on the other three seasons and on the fixed-population table at the
        // assertions.
        //
        // So: `rho` is reported, and is honest about the set the app shows, but
        // it is NOT comparable across model versions and must never be used as
        // a regression bar. `rhoAll` is.
        const graded: { id: number; pred: number; act: number; pos: number }[] = [];
        const all: [number, number][] = [];
        const allIds: number[] = [];
        for (const [id, p] of xp) {
          if (!Number.isFinite(p.next)) continue;
          if (season.meta.get(id)!.element_type > 4) continue; // skip managers
          if (!st.actual.has(id)) continue; // no fixture rows that GW
          all.push([p.next, st.actual.get(id)!]);
          allIds.push(id);
          if (p.next < 1.0) continue;
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
        const rhoAll = spearman(all);
        // Same fixed population, but only the players who were on the pitch.
        // See the long note at the assertions: `rhoAll` turns out to be very
        // close to a did-he-appear detector, so this is the version that asks
        // whether the model can rank POINTS among players it already knows are
        // playing.
        const playedIdx = allIds
          .map((id, i) => i)
          .filter((i) => (st.minutesAt.get(allIds[i]) ?? 0) > 0);
        const rhoPlayed = playedIdx.length >= 30 ? spearman(playedIdx.map((i) => all[i])) : NaN;
        // Two baselines on those same two populations. A projection that cannot
        // out-rank the mean of a player's last four scores is not adding
        // anything, and the harness has to be able to see that.
        const fm = (i: number) => st.form.get(allIds[i]) ?? 0;
        const rhoAllForm = spearman(all.map((pair, i) => [fm(i), pair[1]]));
        const rhoPlayedForm =
          playedIdx.length >= 30
            ? spearman(playedIdx.map((i) => [fm(i), all[i][1]] as [number, number]))
            : NaN;

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
          nAll: all.length,
          mae,
          bias: sumA > 0 ? sumP / sumA - 1 : 0,
          rho,
          rhoAll,
          rhoPlayed,
          rhoAllForm,
          rhoPlayedForm,
          nPlayed: playedIdx.length,
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
        n: avg(evals.map((e) => e.n)),
        nAll: avg(evals.map((e) => e.nAll)),
        mae: avg(evals.map((e) => e.mae)),
        maeEarly: early.length ? avg(early.map((e) => e.mae)) : NaN,
        maeLate: avg(late.map((e) => e.mae)),
        bias: avg(evals.map((e) => e.bias)),
        biasLate: avg(late.map((e) => e.bias)),
        fitBias: avg(evals.map((e) => e.fitBias)),
        rho: avg(evals.map((e) => e.rho)),
        rhoAll: avg(evals.map((e) => e.rhoAll)),
        rhoPlayed: avg(evals.map((e) => e.rhoPlayed)),
        rhoAllForm: avg(evals.map((e) => e.rhoAllForm)),
        rhoPlayedForm: avg(evals.map((e) => e.rhoPlayedForm)),
        nPlayed: avg(evals.map((e) => e.nPlayed)),
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

    // The two ablation arms are only worth reporting if they differ in the way
    // they claim to. Checked structurally rather than through the metrics,
    // because the measured-minutes term turns out to be a wash — so a "starts"
    // arm silently identical to the full one would move the numbers by less
    // than the noise and no metric assertion could tell.
    {
      const probe = buildStateAt(START, season);
      const stripped = recentFor(probe, "starts")!;
      const whole = recentFor(probe, "full")!;
      const withMins = [...whole.values()].filter((f) => f.minsPerStart != null);
      expect(withMins.length).toBeGreaterThan(50);
      expect(stripped.size).toBe(whole.size);
      expect([...stripped.values()].every((f) => f.minsPerStart === null)).toBe(true);
      // and nothing else about the record was touched
      for (const [id, f] of whole) {
        expect(stripped.get(id)!.startShare).toBe(f.startShare);
        expect(stripped.get(id)!.minsPerGame).toBe(f.minsPerGame);
      }
      expect(recentFor(probe, "none")).toBeUndefined();
    }

    const full = run(true, "full");
    const noCal = run(false, "full");
    const noRecentMins = run(false, "starts");
    const noRecent = run(false, "none");

    const report = {
      full: summarize(full.evals, "full model + self-calibration"),
      noCal: summarize(noCal.evals, "model without calibration"),
      // Both ablations run WITHOUT calibration, so they are comparable to
      // `noCal` and to each other — not to `full`. Calibration is a feedback
      // loop that partly absorbs whatever the ablated term was contributing,
      // which would flatter every ablation against the calibrated arm.
      noRecentMins: summarize(noRecentMins.evals, "recent start-share only, season minutes-per-start"),
      noRecent: summarize(noRecent.evals, "no recent form at all"),
      finalFactors: full.cal.factors,
      perGw: full.evals.map((e) => ({
        gw: e.gw,
        n: e.n,
        nAll: e.nAll,
        mae: +e.mae.toFixed(3),
        bias: +e.bias.toFixed(3),
        rho: +e.rho.toFixed(3),
        rhoAll: +e.rhoAll.toFixed(3),
        rhoPlayed: +e.rhoPlayed.toFixed(3),
      })),
    };
    fs.writeFileSync(
      path.resolve(__dirname, `../backtest-report-${SEASON}.json`),
      JSON.stringify(report, null, 2)
    );
    console.log(
      JSON.stringify(
        {
          full: report.full,
          noCal: report.noCal,
          noRecentMins: report.noRecentMins,
          noRecent: report.noRecent,
          finalFactors: report.finalFactors,
        },
        null,
        2
      )
    );

    // What the optimizer actually uses is the RANKING — it must clearly beat
    // naive baselines, and calibrated bias must be small.
    expect(report.full.top10).toBeGreaterThan(report.full.top10Form);
    expect(report.full.top10).toBeGreaterThan(report.full.top10Ppg);
    expect(report.full.cap).toBeGreaterThan(report.full.capForm);
    // The ranking bar is on `rhoAll`, NOT on `rho`. `rho` is measured on the
    // set the model itself selected (pred >= 1.0), so it is not comparable
    // between two versions of the model and it moved the WRONG WAY when the
    // cameo bug was fixed. Measured, current model against the model at
    // `228626e`, on all four archived seasons:
    //
    //            rho (self-selected)      rhoAll (fixed population)
    //   2022-23  0.4346 -> 0.2784         0.1597 -> 0.6244
    //   2023-24  0.5396 -> 0.4132         0.5421 -> 0.6522
    //   2024-25  0.5669 -> 0.4193         0.5711 -> 0.6711
    //   2025-26  0.5633 -> 0.3944         0.5822 -> 0.6870
    //
    // `rho` says the model got worse in all four seasons. `rhoAll` says it got
    // better in all four. `rhoAll` is the one ranking a population that was
    // chosen without asking the model, so `rhoAll` is the one that means
    // something. The old 0.4 bar was set against `rho` values produced before
    // the cameo fix, and it was a bar that a genuine improvement could not
    // clear.
    //
    // 0.55 sits below the worst of the four (0.6244) with room for ordinary
    // season-to-season movement, and above every number the pre-fix model
    // managed.
    //
    // But `rhoAll` is a WEAK bar and this comment exists so nobody mistakes it
    // for a strong one. An adversarial review measured what it is actually
    // sensitive to, and the answer is mostly "did this player appear at all":
    // replacing the actual points vector with a binary played/did-not-play flag
    // — deleting every scrap of information about who SCORED — raises the
    // coefficient in all four seasons (+0.018 to +0.030). Ranking players by
    // cumulative minutes played so far this season, with `src/lib/xp.ts`
    // deleted entirely, scores 0.6464/0.6376/0.6495/0.6880 and clears 0.55 in
    // every season. Turning the minutes model off completely — every player
    // treated as certain to play ninety minutes — still leaves 0.65-0.67. The
    // bar catches gross vandalism only; the sweep says roughly 35-40% of the
    // ranking has to be replaced with noise before it fires.
    expect(report.full.rhoAll).toBeGreaterThan(0.55);

    // These are the bars that bite.
    //
    // `rhoPlayed` is the same model-independent population restricted to the
    // players who were on the pitch, so it asks the question the app is
    // actually for: among people who are playing, can the model rank points?
    // And it is graded against a baseline rather than a constant, because a
    // constant cannot tell "the model is good" from "the season was easy".
    // The baseline is the mean of a player's last four scores, which is one
    // line of code and is available to the harness at prediction time.
    //
    //            model rhoPlayed   form baseline    model rhoAll   form rhoAll
    //   2022-23      0.3018           0.2892           0.6244        0.6902
    //   2023-24      0.3603           0.2848           0.6522        0.6880
    //   2024-25      0.3765           0.3012           0.6711        0.7000
    //   2025-26      0.3432           0.2710           0.6870        0.7255
    //
    // Read that honestly: the model beats naive form at ranking points among
    // players who play, in all four seasons, and it LOSES to naive form on the
    // full population in all four seasons. Both are true and they are not in
    // tension — form is an excellent did-he-appear detector, because a player
    // with four recent scores is a player who has been playing, and that is the
    // axis `rhoAll` mostly measures. The appearance side is where this model is
    // weakest, and that is written here rather than hidden because the number
    // above it looks reassuring and is not.
    //
    // What `rhoPlayed` deliberately CANNOT see: anything about who plays. It
    // conditions on the pitch, so the minutes model is graded out of it. Two
    // mutations raise it — subProb 0.15 -> 0.9 in all four seasons, and
    // swapping modelWeight/formWeight from 0.8/0.2 to 0.2/0.8 in 2022-23 — and
    // neither is an improvement to the app. Do not read a rise here as a reason
    // to change a minutes constant; that is what the simulator and the
    // `top10`/`cap` baselines above are for.
    expect(report.full.rhoPlayed).toBeGreaterThan(report.full.rhoPlayedForm);
    expect(report.full.rhoPlayed).toBeGreaterThan(0.28);
    // `rho` is the self-selected set, kept as a loose floor. It cannot compare
    // versions, but it does move when something breaks: reverting the
    // `recentStartsWeight` to 0 puts it at 0.2464 and reddens this line,
    // which is more than `rhoAll` managed.
    expect(report.full.rho).toBeGreaterThan(0.25);
    expect(Math.abs(report.full.biasLate)).toBeLessThan(0.2);

    // The recent-form block has to earn its place. Measured against `noCal`,
    // which is the same arm with the block switched on:
    //
    //             rhoAll: noCal   start-share only   no recent form
    //   2022-23           0.6761       0.6760            0.6535
    //   2023-24           0.6565       0.6560            0.6353
    //   2024-25           0.6744       0.6742            0.6547
    //   2025-26           0.6903       0.6900            0.6718
    //
    // Read the two gaps separately, which is the whole reason the middle arm
    // exists. The start-share axis is worth +0.018 to +0.023 rhoAll in every
    // season — the largest single term in the minutes model. The measured
    // minutes-per-start axis is worth -0.0005 to +0.0003, i.e. nothing
    // distinguishable from zero, and `top10` agrees (-0.09, -0.07, -0.01,
    // +0.02). It is kept for the reason it was written — it is the quantity the
    // model actually asks for, and the reconstruction it replaced could not
    // represent a hooked starter at all — but no claim of a metric gain is made
    // for it, and this table is here so nobody makes one later.
    expect(report.noCal.rhoAll - report.noRecent.rhoAll).toBeGreaterThan(0.01);
    expect(report.noRecentMins.rhoAll - report.noRecent.rhoAll).toBeGreaterThan(0.01);
    // The other half of the split, asserted as the null result it is. If the
    // measured minutes-per-start term ever starts moving this by more than a
    // hundredth of rhoAll, something has changed and the table above is stale.
    expect(Math.abs(report.noCal.rhoAll - report.noRecentMins.rhoAll)).toBeLessThan(0.005);
  });
});
