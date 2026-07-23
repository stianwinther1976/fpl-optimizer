// Expected-points (xP) model.
// Every weight lives in XP_CONFIG so the model is easy to tune.
//
// Signal sources, in order of influence:
//  1. Per-90 underlying numbers (xG, xA) scaled by continuous opponent
//     strength (attack/defence ratings, home/away specific) — not just FDR.
//  2. Recency-weighted form (FPL's 30-day form counts more than season PPG).
//  3. Defensive-contribution points where the API provides them.
//  4. Availability: status flags, chance-of-playing, minutes share.
//  5. A price-based prior early in the season when minutes are scarce
//     (price encodes FPL's own expectation of output).
//  6. FPL's own ep_next blended in for the immediate gameweek.

import type { Bootstrap, Element, Fixture, Team } from "./types";

export const XP_CONFIG = {
  horizon: 5, // number of future GWs to project
  // Points per event, by element_type (1 GK, 2 DEF, 3 MID, 4 FWD)
  goalPoints: { 1: 10, 2: 6, 3: 5, 4: 4 } as Record<number, number>,
  assistPoints: 3,
  cleanSheetPoints: { 1: 4, 2: 4, 3: 1, 4: 0 } as Record<number, number>,
  appearancePoints: 2, // >= 60 min
  // Continuous opponent model (replaces FDR buckets when ratings exist)
  attackGamma: 1.1, // sensitivity of attacking output to opponent defence
  csBase: 0.31, // league-average clean-sheet probability
  csGamma: 1.5, // sensitivity of CS odds to opponent attack
  csMin: 0.05,
  csMax: 0.6,
  // FDR fallback (used when strength ratings are missing/flat)
  csProbByFdr: { 1: 0.5, 2: 0.45, 3: 0.32, 4: 0.2, 5: 0.11 } as Record<number, number>,
  attackMultByFdr: { 1: 1.35, 2: 1.25, 3: 1.0, 4: 0.82, 5: 0.68 } as Record<number, number>,
  homeBonus: 1.08,
  awayMalus: 0.94,
  gcPenaltyByFdr: { 1: 0.2, 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9 } as Record<number, number>,
  // Bonus points expectation from ICT per 90
  bonusPerIct90: 0.045,
  bonusCap: 1.2,
  // Defensive contribution: expected points per full match from season rate
  dcWeight: 1.0,
  dcCap: 1.6,
  // Blend between per-90 model and form
  modelWeight: 0.6,
  formWeight: 0.4,
  // Within "form": recent 30-day form vs season points-per-game
  recentFormShare: 0.65,
  // For the very next GW, blend in FPL's own ep_next
  epNextWeight: 0.35,
  // Availability by status when chance_of_playing is null
  statusProb: { a: 1, d: 0.5, i: 0, s: 0, u: 0, n: 0 } as Record<string, number>,
  minMinutesForModel: 270, // below this, lean on the price prior
  // Price prior: xp ≈ priceSlope * price(£m) + priceIntercept
  priceSlope: 0.5,
  priceIntercept: -0.4,
};

export interface PlayerXp {
  elementId: number;
  perGw: Map<number, number>; // event id -> xP
  total: number; // sum over horizon
  next: number; // xP next GW
}

export interface XpContext {
  bootstrap: Bootstrap;
  fixtures: Fixture[];
  nextEvent: number;
  horizon?: number;
}

/** Fixtures for a team in a given event (0, 1 or 2 = DGW). */
export function teamFixtures(fixtures: Fixture[], teamId: number, event: number): Fixture[] {
  return fixtures.filter((f) => f.event === event && (f.team_h === teamId || f.team_a === teamId));
}

function availability(el: Element): number {
  const c = XP_CONFIG.statusProb[el.status] ?? 1;
  if (el.chance_of_playing_next_round != null) {
    return Math.min(c === 0 ? 0 : 1, el.chance_of_playing_next_round / 100);
  }
  return c;
}

/** Probability-weighted share of minutes (0..1) based on season minutes. */
function minutesShare(el: Element, playedGws: number): number {
  if (playedGws <= 0) return 0.7; // pre-season: neutral prior
  const share = el.minutes / (playedGws * 90);
  return Math.max(0, Math.min(1, share));
}

interface StrengthTables {
  usable: boolean;
  avgAttH: number;
  avgAttA: number;
  avgDefH: number;
  avgDefA: number;
  byTeam: Map<number, Team>;
}

function buildStrengths(bootstrap: Bootstrap): StrengthTables {
  const teams = bootstrap.teams;
  const byTeam = new Map(teams.map((t) => [t.id, t]));
  const avg = (f: (t: Team) => number) =>
    teams.reduce((s, t) => s + f(t), 0) / Math.max(1, teams.length);
  const avgAttH = avg((t) => t.strength_attack_home);
  const avgAttA = avg((t) => t.strength_attack_away);
  const avgDefH = avg((t) => t.strength_defence_home);
  const avgDefA = avg((t) => t.strength_defence_away);
  // Ratings are "usable" when they actually vary between teams.
  const spread =
    Math.max(...teams.map((t) => t.strength_attack_home)) -
    Math.min(...teams.map((t) => t.strength_attack_home));
  return { usable: spread > 40, avgAttH, avgAttA, avgDefH, avgDefA, byTeam };
}

/** xP for one player in one specific fixture. */
function fixtureXp(
  el: Element,
  fixture: Fixture,
  isHome: boolean,
  playedGws: number,
  st: StrengthTables
): number {
  const cfg = XP_CONFIG;
  const avail = availability(el);
  if (avail === 0) return 0;
  const share = minutesShare(el, playedGws);
  const pPlay = avail * Math.min(1, share + 0.15);
  const p60 = avail * share;

  const venue = isHome ? cfg.homeBonus : cfg.awayMalus;
  const fdr = isHome ? fixture.team_h_difficulty : fixture.team_a_difficulty;
  const oppId = isHome ? fixture.team_a : fixture.team_h;
  const opp = st.byTeam.get(oppId);

  // Opponent model: continuous strength ratings when available, FDR fallback.
  let attackMult: number;
  let csProb: number;
  if (st.usable && opp) {
    // Opponent plays at the opposite venue: if we're home, their away ratings apply.
    const oppDef = isHome ? opp.strength_defence_away : opp.strength_defence_home;
    const oppAtt = isHome ? opp.strength_attack_away : opp.strength_attack_home;
    const avgDef = isHome ? st.avgDefA : st.avgDefH;
    const avgAtt = isHome ? st.avgAttA : st.avgAttH;
    attackMult = Math.pow(avgDef / Math.max(1, oppDef), cfg.attackGamma) * venue;
    csProb = Math.min(
      cfg.csMax,
      Math.max(cfg.csMin, cfg.csBase * Math.pow(avgAtt / Math.max(1, oppAtt), cfg.csGamma))
    );
  } else {
    attackMult = (cfg.attackMultByFdr[fdr] ?? 1) * venue;
    csProb = (cfg.csProbByFdr[fdr] ?? 0.3) * (isHome ? 1.1 : 0.9);
  }

  const min90 = Math.max(el.minutes, 1);
  const xG90 = ((parseFloat(el.expected_goals) || 0) / min90) * 90;
  const xA90 = ((parseFloat(el.expected_assists) || 0) / min90) * 90;
  const ict90 = ((parseFloat(el.ict_index) || 0) / min90) * 90;

  const goalPts = cfg.goalPoints[el.element_type];
  const csPts = cfg.cleanSheetPoints[el.element_type];

  let xp = 0;
  xp += p60 * cfg.appearancePoints + (pPlay - p60) * 1;
  xp += p60 * (xG90 * goalPts + xA90 * cfg.assistPoints) * attackMult;
  xp += p60 * csProb * csPts;
  if (el.element_type <= 2) {
    // Expected goals-conceded penalty scales inversely with CS odds.
    xp -= p60 * (cfg.gcPenaltyByFdr[fdr] ?? 0.5) * (isHome ? 0.9 : 1.1);
  }
  xp += p60 * Math.min(cfg.bonusCap, ict90 * cfg.bonusPerIct90);

  // Defensive-contribution points (season rate per full match), if the API exposes them.
  if (el.defensive_contribution != null && el.defensive_contribution > 0) {
    const dcPerMatch = (el.defensive_contribution / min90) * 90;
    xp += p60 * Math.min(cfg.dcCap, dcPerMatch * cfg.dcWeight);
  }

  // Form component: recency-weighted (30-day form counts more than season PPG).
  const recent = parseFloat(el.form) || 0;
  const seasonPpg = parseFloat(el.points_per_game) || 0;
  const formScore = cfg.recentFormShare * recent + (1 - cfg.recentFormShare) * seasonPpg;
  const fdrFormAdj = st.usable ? attackMult / venue : 1 + (3 - fdr) * 0.1;
  const formXp = pPlay * formScore * Math.min(1.35, Math.max(0.65, fdrFormAdj)) * venue;

  const enoughData = el.minutes >= cfg.minMinutesForModel;
  if (enoughData) {
    return Math.max(0, cfg.modelWeight * xp + cfg.formWeight * formXp);
  }
  // Early season / new signing: lean on the price prior (price encodes
  // FPL's own expectation) blended with whatever thin data exists.
  const priceM = el.now_cost / 10;
  const prior = Math.max(0.5, cfg.priceSlope * priceM + cfg.priceIntercept) * avail;
  const thin = 0.35 * xp + 0.25 * formXp;
  return Math.max(0, 0.55 * prior * (isHome ? 1.04 : 0.96) + thin);
}

/** Full xP projection for every element over the horizon. */
export function projectAll(ctx: XpContext): Map<number, PlayerXp> {
  const cfg = XP_CONFIG;
  const horizon = ctx.horizon ?? cfg.horizon;
  const events = ctx.bootstrap.events;
  const playedGws = events.filter((e) => e.finished).length;
  const lastEvent = events.length > 0 ? events[events.length - 1].id : 38;
  const st = buildStrengths(ctx.bootstrap);
  const result = new Map<number, PlayerXp>();

  for (const el of ctx.bootstrap.elements) {
    const perGw = new Map<number, number>();
    for (let gw = ctx.nextEvent; gw < ctx.nextEvent + horizon && gw <= lastEvent; gw++) {
      let gwXp = 0;
      for (const f of teamFixtures(ctx.fixtures, el.team, gw)) {
        const isHome = f.team_h === el.team;
        gwXp += fixtureXp(el, f, isHome, playedGws, st);
      }
      // Blend FPL's own projection for the immediate GW
      if (gw === ctx.nextEvent && el.ep_next != null) {
        const ep = parseFloat(el.ep_next);
        if (!Number.isNaN(ep)) {
          gwXp = (1 - cfg.epNextWeight) * gwXp + cfg.epNextWeight * Math.max(0, ep);
        }
      }
      perGw.set(gw, gwXp);
    }
    let total = 0;
    for (const v of perGw.values()) total += v;
    result.set(el.id, {
      elementId: el.id,
      perGw,
      total,
      next: perGw.get(ctx.nextEvent) ?? 0,
    });
  }
  return result;
}
