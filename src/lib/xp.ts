// Expected-points (xP) model.
// Every weight lives in XP_CONFIG so the model is easy to tune.

import type { Bootstrap, Element, Fixture } from "./types";

export const XP_CONFIG = {
  horizon: 5, // number of future GWs to project
  // Points per event, by element_type (1 GK, 2 DEF, 3 MID, 4 FWD)
  goalPoints: { 1: 10, 2: 6, 3: 5, 4: 4 } as Record<number, number>,
  assistPoints: 3,
  cleanSheetPoints: { 1: 4, 2: 4, 3: 1, 4: 0 } as Record<number, number>,
  appearancePoints: 2, // >= 60 min
  // Clean-sheet base probability by fixture difficulty (FDR 1-5)
  csProbByFdr: { 1: 0.5, 2: 0.45, 3: 0.32, 4: 0.2, 5: 0.11 } as Record<number, number>,
  // Attacking output multiplier by FDR
  attackMultByFdr: { 1: 1.35, 2: 1.25, 3: 1.0, 4: 0.82, 5: 0.68 } as Record<number, number>,
  homeBonus: 1.08, // multiplier for home fixtures
  awayMalus: 0.94,
  // Expected goals-conceded penalty (GK/DEF lose 1 pt per 2 conceded)
  gcPenaltyByFdr: { 1: 0.2, 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9 } as Record<number, number>,
  // Bonus points expectation: scaled from ICT index per 90
  bonusPerIct90: 0.045,
  bonusCap: 1.2,
  // Blend between per-90 model and recent form (points per game)
  modelWeight: 0.6,
  formWeight: 0.4,
  // For the very next GW, blend in FPL's own ep_next
  epNextWeight: 0.35,
  // Availability by status when chance_of_playing is null
  statusProb: { a: 1, d: 0.5, i: 0, s: 0, u: 0, n: 0 } as Record<string, number>,
  minMinutesForModel: 270, // below this, lean on price-based prior
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

/** xP for one player in one specific fixture. */
function fixtureXp(el: Element, fixture: Fixture, isHome: boolean, playedGws: number): number {
  const cfg = XP_CONFIG;
  const fdr = isHome ? fixture.team_h_difficulty : fixture.team_a_difficulty;
  const venue = isHome ? cfg.homeBonus : cfg.awayMalus;
  const avail = availability(el);
  if (avail === 0) return 0;
  const share = minutesShare(el, playedGws);
  const pPlay = avail * Math.min(1, share + 0.15);
  const p60 = avail * share;

  const min90 = Math.max(el.minutes, 1);
  const xG90 = (parseFloat(el.expected_goals) || 0) / min90 * 90;
  const xA90 = (parseFloat(el.expected_assists) || 0) / min90 * 90;
  const ict90 = (parseFloat(el.ict_index) || 0) / min90 * 90;

  const attackMult = (cfg.attackMultByFdr[fdr] ?? 1) * venue;
  const goalPts = cfg.goalPoints[el.element_type];
  const csPts = cfg.cleanSheetPoints[el.element_type];
  const csProb = (cfg.csProbByFdr[fdr] ?? 0.3) * (isHome ? 1.1 : 0.9);

  let xp = 0;
  xp += p60 * cfg.appearancePoints + (pPlay - p60) * 1; // 2 pts >=60min, 1 pt otherwise
  xp += p60 * (xG90 * goalPts + xA90 * cfg.assistPoints) * attackMult;
  xp += p60 * csProb * csPts;
  if (el.element_type <= 2) {
    xp -= p60 * (cfg.gcPenaltyByFdr[fdr] ?? 0.5) * (isHome ? 0.9 : 1.1);
  }
  xp += p60 * Math.min(cfg.bonusCap, ict90 * cfg.bonusPerIct90);

  // Blend with recent form (ppg already includes bonus, cards etc.)
  const ppg = parseFloat(el.points_per_game) || 0;
  const fdrFormAdj = 1 + (3 - fdr) * 0.1;
  const formXp = pPlay * ppg * fdrFormAdj * venue;

  const enoughData = el.minutes >= cfg.minMinutesForModel;
  const wModel = enoughData ? cfg.modelWeight : 0.35;
  const wForm = 1 - wModel;
  return Math.max(0, wModel * xp + wForm * formXp);
}

/** Full xP projection for every element over the horizon. */
export function projectAll(ctx: XpContext): Map<number, PlayerXp> {
  const cfg = XP_CONFIG;
  const horizon = ctx.horizon ?? cfg.horizon;
  const events = ctx.bootstrap.events;
  const playedGws = events.filter((e) => e.finished).length;
  const lastEvent = events.length > 0 ? events[events.length - 1].id : 38;
  const result = new Map<number, PlayerXp>();

  for (const el of ctx.bootstrap.elements) {
    const perGw = new Map<number, number>();
    for (let gw = ctx.nextEvent; gw < ctx.nextEvent + horizon && gw <= lastEvent; gw++) {
      let gwXp = 0;
      for (const f of teamFixtures(ctx.fixtures, el.team, gw)) {
        const isHome = f.team_h === el.team;
        gwXp += fixtureXp(el, f, isHome, playedGws);
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
