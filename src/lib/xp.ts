// Expected-points (xP) model.
// Every weight lives in XP_CONFIG so the model is easy to tune.
//
// Signal sources, in order of influence:
//  1. Underlying per-90 numbers (xG, xA) — but NOT taken at face value:
//     they are shrunk toward price/position priors when the sample is small
//     (empirical-Bayes), blended with actual goals/assists to capture
//     finishing skill, and topped up for penalty & set-piece duty.
//  2. Continuous opponent strength (attack/defence ratings, home/away
//     specific) with a Poisson clean-sheet model — not just FDR buckets.
//  3. A starts-based minutes model (probability of starting × minutes per
//     start), the single biggest driver of prediction accuracy.
//  4. Defensive-contribution points and GK save points.
//  5. Recency-weighted form as a small corrective, never the main signal.
//  6. FPL's own ep_next blended in lightly for the immediate gameweek.
//  7. A price-based prior early in the season when minutes are scarce
//     (price encodes FPL's own expectation of output).
//  8. Availability that is gameweek-aware: a one-match ban does not zero
//     a player's whole 5-GW horizon.

import type { Bootstrap, Element, Fixture, Team } from "./types";
import { activeCalibration, calibrationMultiplier } from "./calibration";

export const XP_CONFIG = {
  horizon: 5, // number of future GWs to project
  // Points per event, by element_type (1 GK, 2 DEF, 3 MID, 4 FWD)
  goalPoints: { 1: 10, 2: 6, 3: 5, 4: 4 } as Record<number, number>,
  assistPoints: 3,
  cleanSheetPoints: { 1: 4, 2: 4, 3: 1, 4: 0 } as Record<number, number>,
  appearancePoints: 2, // >= 60 min
  // Continuous opponent model (replaces FDR buckets when ratings exist)
  attackGamma: 1.1, // sensitivity of attacking output to opponent defence
  // Poisson clean-sheet model: lambdaGC = league avg goals conceded scaled by
  // opponent attack and OWN defence; csProb = exp(-lambda).
  leagueGoalsPerTeam: 1.4,
  csGamma: 1.2, // sensitivity of goals conceded to opponent attack
  defGamma: 1.0, // sensitivity of goals conceded to own defence
  homeGcScale: 0.92,
  awayGcScale: 1.1,
  // FDR fallback (used when strength ratings are missing/flat)
  csProbByFdr: { 1: 0.5, 2: 0.45, 3: 0.32, 4: 0.2, 5: 0.11 } as Record<number, number>,
  attackMultByFdr: { 1: 1.35, 2: 1.25, 3: 1.0, 4: 0.82, 5: 0.68 } as Record<number, number>,
  gcPenaltyByFdr: { 1: 0.2, 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9 } as Record<number, number>,
  homeBonus: 1.08,
  awayMalus: 0.94,
  // Bonus points: blend of actual bonus per 90 and the ICT proxy
  bonusPerIct90: 0.045,
  bonusActualWeight: 0.6,
  bonusCap: 1.5,
  // Defensive contribution: the API reports a COUNT of tackles/CBI(/recoveries)
  // per season; FPL awards +2 when a match count reaches the threshold.
  // Expected points = 2 × P(count ≥ threshold), Poisson on the per-90 rate.
  dcWeight: 1.0,
  dcPoints: 2,
  dcThresholdDef: 10, // GK/DEF
  dcThresholdMid: 12, // MID/FWD
  // GK save points: 1pt per 3 saves, scaled by opponent attack
  savesGamma: 0.5,
  savesCap: 1.5,
  // Blend between the underlying-stats model and form (stats dominate)
  modelWeight: 0.8,
  formWeight: 0.2,
  // Within "form": recent 30-day form vs season points-per-game
  recentFormShare: 0.5,
  // For the very next GW, blend in FPL's own ep_next (lightly) once we have
  // our own data. When data is thin (pre-season / first weeks), lean on it
  // HARD — it's FPL's own model, an independent second opinion that's already
  // scaled to real points and values premiums correctly.
  epNextWeight: 0.15,
  epThinGames: 3, // fewer games than this = "thin data"
  epThinMaxWeight: 0.7, // max weight on FPL's ep_next when we have zero data
  // --- Own xG assessment (don't take API xG at face value) ---
  // Empirical-Bayes shrinkage: rates from small samples are pulled toward a
  // price/position prior worth `shrinkMins` minutes of evidence.
  shrinkMins: 450,
  // Finishing-skill blend: goals90 gets up to this weight vs xG90 once the
  // sample reaches xgBlendMinMinutes.
  xgBlendGoalsWeight: 0.3,
  xgBlendMinMinutes: 900,
  // Penalty & set-piece duty top-ups (per game, on top of season xG/xA)
  penXgPerGame: 0.09,
  pen2Share: 0.25,
  setPieceXaBoost: 0.04,
  // Position priors per 90, scaled by price (used for shrinkage & pre-season)
  priorXg90: { 1: 0.005, 2: 0.05, 3: 0.22, 4: 0.38 } as Record<number, number>,
  priorXa90: { 1: 0.01, 2: 0.09, 3: 0.17, 4: 0.12 } as Record<number, number>,
  priorIct90: { 1: 4, 2: 6, 3: 8, 4: 9 } as Record<number, number>,
  priorBonus90: { 1: 0.15, 2: 0.18, 3: 0.22, 4: 0.25 } as Record<number, number>,
  priorSaves90: 3.0,
  typicalPriceM: { 1: 4.8, 2: 5.0, 3: 6.5, 4: 6.5 } as Record<number, number>,
  // Minutes model
  subProb: 0.15, // chance a non-starter comes off the bench
  recentStartsWeight: 0.65, // last ~5 games vs season starts share
  // Availability recovery: how fast doubtful/injured players return to
  // fitness in later horizon GWs (geometric decay of the deficit)
  recoveryRate: 0.6,
  // Horizon discounting: future GWs are less certain
  gwDecay: 0.88,
  // Availability by status when chance_of_playing is null
  statusProb: { a: 1, d: 0.5, i: 0, s: 0, u: 0, n: 0 } as Record<string, number>,
  minMinutesForModel: 270, // below this, lean on the price prior
  // Price prior: xp ≈ priceSlope * price(£m) + priceIntercept
  priceSlope: 0.5,
  priceIntercept: -0.4,
};

export interface PlayerXp {
  elementId: number;
  perGw: Map<number, number>; // event id -> xP (undiscounted, for display)
  total: number; // raw sum over horizon
  totalDiscounted: number; // decayed sum — use for transfer decisions
  next: number; // xP next GW
}

export interface XpContext {
  bootstrap: Bootstrap;
  fixtures: Fixture[];
  nextEvent: number;
  horizon?: number;
  /**
   * elementId -> share of the team's last ~5 games the player STARTED
   * (from the element-summary endpoint). The best minutes predictor there is:
   * a player who just became a nailed starter — or just lost his place —
   * is priced correctly within a week instead of a month.
   */
  recentStarts?: Map<number, number>;
}

/** Fixtures for a team in a given event (0, 1 or 2 = DGW). */
export function teamFixtures(fixtures: Fixture[], teamId: number, event: number): Fixture[] {
  return fixtures.filter((f) => f.event === event && (f.team_h === teamId || f.team_a === teamId));
}

/** event -> team -> fixtures, so projectAll avoids O(players×horizon×fixtures) scans. */
export function makeFixtureIndex(fixtures: Fixture[]): Map<number, Map<number, Fixture[]>> {
  const idx = new Map<number, Map<number, Fixture[]>>();
  for (const f of fixtures) {
    if (f.event == null) continue;
    let byTeam = idx.get(f.event);
    if (!byTeam) {
      byTeam = new Map();
      idx.set(f.event, byTeam);
    }
    for (const t of [f.team_h, f.team_a]) {
      const arr = byTeam.get(t);
      if (arr) arr.push(f);
      else byTeam.set(t, [f]);
    }
  }
  return idx;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** P(N >= k) for N ~ Poisson(lambda). */
function poissonTail(lambda: number, k: number): number {
  if (lambda <= 0) return 0;
  let term = Math.exp(-lambda);
  let cdf = term;
  for (let i = 1; i < k; i++) {
    term *= lambda / i;
    cdf += term;
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

/**
 * Availability for a specific horizon offset (0 = next GW).
 * chance_of_playing_next_round applies, by definition, only to the next round;
 * a suspension is usually one match; injuries/doubts recover over time.
 */
export function availabilityAt(el: Element, offset: number): number {
  const cfg = XP_CONFIG;
  if (el.status === "u" || el.status === "n") return 0; // left club / unavailable
  if (el.status === "a") return 1;
  let a0: number;
  if (el.chance_of_playing_next_round != null) {
    a0 = clamp(el.chance_of_playing_next_round / 100, 0, 1);
  } else {
    a0 = cfg.statusProb[el.status] ?? 1;
  }
  if (offset <= 0) return a0;
  if (el.status === "s") return Math.max(a0, 0.9); // bans are usually one match
  // injured / doubtful: deficit decays geometrically toward fit
  return 1 - (1 - a0) * Math.pow(cfg.recoveryRate, offset);
}

interface StrengthTables {
  usable: boolean;
  avgAttH: number;
  avgAttA: number;
  avgDefH: number;
  avgDefA: number;
  byTeam: Map<number, Team>;
  gamesByTeam: Map<number, number>; // finished fixtures per team
  playedGws: number; // fallback when the fixtures list lacks finished games
}

function buildStrengths(bootstrap: Bootstrap, fixtures: Fixture[]): StrengthTables {
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
  const gamesByTeam = new Map<number, number>();
  for (const f of fixtures) {
    if (!f.finished) continue;
    gamesByTeam.set(f.team_h, (gamesByTeam.get(f.team_h) ?? 0) + 1);
    gamesByTeam.set(f.team_a, (gamesByTeam.get(f.team_a) ?? 0) + 1);
  }
  const playedGws = bootstrap.events.filter((e) => e.finished).length;
  return { usable: spread > 40, avgAttH, avgAttA, avgDefH, avgDefA, byTeam, gamesByTeam, playedGws };
}

/** Empirical-Bayes per-90 rate: season total shrunk toward a prior. */
function shrunk90(seasonTotal: number, minutes: number, prior90: number): number {
  const sm = XP_CONFIG.shrinkMins;
  return (seasonTotal + prior90 * (sm / 90)) / ((minutes + sm) / 90);
}

interface Rates {
  effXg90: number;
  effXa90: number;
  ict90: number;
  bonus90: number;
  saves90: number;
}

/**
 * Our own assessment of a player's attacking rates — the API's raw xG/xA is
 * shrunk for small samples, blended with actual output (finishing skill),
 * and adjusted for penalty & set-piece duty.
 */
function playerRates(el: Element): Rates {
  const cfg = XP_CONFIG;
  const t = el.element_type;
  const priceM = el.now_cost / 10;
  const priceFactor = clamp(priceM / (cfg.typicalPriceM[t] ?? 6), 0.6, 2.2);
  const pXg = (cfg.priorXg90[t] ?? 0.1) * priceFactor;
  const pXa = (cfg.priorXa90[t] ?? 0.1) * priceFactor;
  const pIct = (cfg.priorIct90[t] ?? 6) * priceFactor;
  const pBonus = (cfg.priorBonus90[t] ?? 0.2) * priceFactor;

  const xG90 = shrunk90(parseFloat(el.expected_goals) || 0, el.minutes, pXg);
  const xA90 = shrunk90(parseFloat(el.expected_assists) || 0, el.minutes, pXa);
  const goals90 = shrunk90(el.goals_scored || 0, el.minutes, pXg);
  const assists90 = shrunk90(el.assists || 0, el.minutes, pXa);
  const ict90 = shrunk90(parseFloat(el.ict_index) || 0, el.minutes, pIct);
  const bonus90 = shrunk90(el.bonus || 0, el.minutes, pBonus);
  const savesPrior = cfg.priorSaves90 * clamp(2 - priceFactor, 0.7, 1.3);
  const saves90 = t === 1 ? shrunk90(el.saves ?? 0, el.minutes, savesPrior) : 0;

  // Finishing-skill blend: give actual conversion some weight once the
  // sample is meaningful (regressed, never fully trusted).
  const wFin = cfg.xgBlendGoalsWeight * Math.min(1, el.minutes / cfg.xgBlendMinMinutes);
  let effXg90 = (1 - wFin) * xG90 + wFin * goals90;
  let effXa90 = (1 - wFin) * xA90 + wFin * assists90;

  // Penalty duty: the season xG of an established taker already contains
  // penalties, so only a haircut top-up is added.
  if (el.penalties_order === 1) effXg90 += cfg.penXgPerGame * 0.5;
  else if (el.penalties_order === 2) effXg90 += cfg.penXgPerGame * cfg.pen2Share * 0.5;
  // Set-piece delivery boosts assist potential.
  const spOrder = Math.min(
    el.corners_and_indirect_freekicks_order ?? 99,
    el.direct_freekicks_order ?? 99
  );
  if (spOrder === 1) effXa90 += cfg.setPieceXaBoost;
  else if (spOrder === 2) effXa90 += cfg.setPieceXaBoost / 2;

  return { effXg90, effXa90, ict90, bonus90, saves90 };
}

interface MinutesModel {
  pStart: number;
  minsPerStart: number;
  share: number; // season minutes share (attacking output scales with this)
}

/** Starts-based minutes model with a pre-season prior fallback. */
function minutesModel(el: Element, teamGames: number, recentStartShare?: number): MinutesModel {
  const starts = el.starts ?? 0;
  let mm: MinutesModel;
  if (teamGames > 0 && starts > 0) {
    mm = {
      pStart: clamp(starts / teamGames, 0, 1),
      minsPerStart: Math.min(90, el.minutes / starts),
      share: clamp(el.minutes / (teamGames * 90), 0, 1),
    };
  } else if (teamGames > 0) {
    // Sub-only (or no data): low start odds, minutes share carries what we know.
    mm = { pStart: 0, minsPerStart: 0, share: clamp(el.minutes / (teamGames * 90), 0, 1) };
  } else {
    return { pStart: 0.7, minsPerStart: 90, share: 0.7 }; // pre-season neutral prior
  }
  // Recency: what happened in the last ~5 team games outweighs the season
  // average (a new nailed starter, a lost place, a returning injury).
  if (recentStartShare != null) {
    const w = XP_CONFIG.recentStartsWeight;
    const pStart = clamp(w * recentStartShare + (1 - w) * mm.pStart, 0, 1);
    const minsPerStart = mm.minsPerStart > 0 ? mm.minsPerStart : recentStartShare > 0 ? 75 : 0;
    return {
      pStart,
      minsPerStart,
      share: clamp((pStart * minsPerStart) / 90, 0, 1),
    };
  }
  return mm;
}

/** xP for one player in one specific fixture. */
function fixtureXp(
  el: Element,
  fixture: Fixture,
  isHome: boolean,
  gwOffset: number,
  st: StrengthTables,
  rates: Rates,
  mm: MinutesModel
): number {
  const cfg = XP_CONFIG;
  const avail = availabilityAt(el, gwOffset);
  if (avail === 0) return 0;
  const p60 = avail * mm.pStart * (mm.minsPerStart >= 60 ? 1 : (mm.minsPerStart / 60) * 0.5);
  const pPlay = avail * Math.min(1, mm.pStart + cfg.subProb);
  const xMins = avail * Math.min(1, mm.share + 0.03); // attacking-minutes share

  const venue = isHome ? cfg.homeBonus : cfg.awayMalus;
  const fdr = isHome ? fixture.team_h_difficulty : fixture.team_a_difficulty;
  const oppId = isHome ? fixture.team_a : fixture.team_h;
  const opp = st.byTeam.get(oppId);
  const own = st.byTeam.get(el.team);

  // Opponent model: continuous strength ratings when available, FDR fallback.
  let attackMult: number;
  let csProb: number;
  let lambdaGC: number | null = null; // expected goals conceded (Poisson model)
  let oppAttRatio = 1; // opponent attack vs league average (for saves)
  if (st.usable && opp && own) {
    // Opponent plays at the opposite venue: if we're home, their away ratings apply.
    const oppDef = isHome ? opp.strength_defence_away : opp.strength_defence_home;
    const oppAtt = isHome ? opp.strength_attack_away : opp.strength_attack_home;
    const ownDef = isHome ? own.strength_defence_home : own.strength_defence_away;
    const avgDef = isHome ? st.avgDefA : st.avgDefH;
    const avgAtt = isHome ? st.avgAttA : st.avgAttH;
    const avgOwnDef = isHome ? st.avgDefH : st.avgDefA;
    attackMult = Math.pow(avgDef / Math.max(1, oppDef), cfg.attackGamma) * venue;
    oppAttRatio = Math.max(0.2, oppAtt / Math.max(1, avgAtt));
    lambdaGC =
      cfg.leagueGoalsPerTeam *
      Math.pow(oppAttRatio, cfg.csGamma) *
      Math.pow(avgOwnDef / Math.max(1, ownDef), cfg.defGamma) *
      (isHome ? cfg.homeGcScale : cfg.awayGcScale);
    csProb = Math.exp(-lambdaGC);
  } else {
    attackMult = (cfg.attackMultByFdr[fdr] ?? 1) * venue;
    csProb = (cfg.csProbByFdr[fdr] ?? 0.3) * (isHome ? 1.1 : 0.9);
  }

  const goalPts = cfg.goalPoints[el.element_type];
  const csPts = cfg.cleanSheetPoints[el.element_type];

  let xp = 0;
  xp += p60 * cfg.appearancePoints + (pPlay - p60) * 1;
  xp += xMins * (rates.effXg90 * goalPts + rates.effXa90 * cfg.assistPoints) * attackMult;
  xp += p60 * csProb * csPts;
  if (el.element_type <= 2) {
    // Goals-conceded penalty: exactly -1 per 2 conceded under the Poisson
    // model, FDR table fallback otherwise.
    if (lambdaGC != null) xp -= p60 * (lambdaGC / 2);
    else xp -= p60 * (cfg.gcPenaltyByFdr[fdr] ?? 0.5) * (isHome ? 0.9 : 1.1);
  }
  // GK save points: 1 per 3 saves, more against strong attacks.
  if (el.element_type === 1 && rates.saves90 > 0) {
    xp += p60 * Math.min(cfg.savesCap, (rates.saves90 / 3) * Math.pow(oppAttRatio, cfg.savesGamma));
  }
  // Bonus points: actual bonus rate blended with the ICT proxy.
  const bonusExp =
    cfg.bonusActualWeight * rates.bonus90 +
    (1 - cfg.bonusActualWeight) * rates.ict90 * cfg.bonusPerIct90;
  xp += p60 * Math.min(cfg.bonusCap, bonusExp) * clamp(attackMult, 0.8, 1.2);

  // Defensive-contribution points: the API count per 90 vs the +2 threshold.
  if (el.defensive_contribution != null && el.defensive_contribution > 0) {
    const dcCount90 = (el.defensive_contribution / Math.max(el.minutes, 1)) * 90;
    const threshold = el.element_type <= 2 ? cfg.dcThresholdDef : cfg.dcThresholdMid;
    xp += p60 * cfg.dcPoints * poissonTail(dcCount90, threshold) * cfg.dcWeight;
  }

  // Form component: recency-weighted, fixture-adjusted (venue is already part
  // of attackMult — do not apply it twice).
  const recent = parseFloat(el.form) || 0;
  const seasonPpg = parseFloat(el.points_per_game) || 0;
  const formScore = cfg.recentFormShare * recent + (1 - cfg.recentFormShare) * seasonPpg;
  const fdrFormAdj = st.usable ? attackMult : (1 + (3 - fdr) * 0.1) * venue;
  const formXp = pPlay * formScore * clamp(fdrFormAdj, 0.65, 1.35);

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
  const lastEvent = events.length > 0 ? events[events.length - 1].id : 38;
  const st = buildStrengths(ctx.bootstrap, ctx.fixtures);
  const fxIndex = makeFixtureIndex(ctx.fixtures);
  const cal = activeCalibration(); // self-learned correction from past GWs
  const result = new Map<number, PlayerXp>();

  for (const el of ctx.bootstrap.elements) {
    // Only the four outfield/keeper positions score in the normal way. FPL's
    // "manager" elements (element_type 5, the Assistant Manager chip) don't
    // fit the model and aren't squad players — project them as zero.
    if (el.element_type < 1 || el.element_type > 4) {
      result.set(el.id, {
        elementId: el.id,
        perGw: new Map(),
        total: 0,
        totalDiscounted: 0,
        next: 0,
      });
      continue;
    }
    const rates = playerRates(el);
    const mm = minutesModel(
      el,
      st.gamesByTeam.get(el.team) ?? st.playedGws,
      ctx.recentStarts?.get(el.id)
    );
    // FPL's own expected points (ep_next) — an independent projection. Weight
    // it by how little of our OWN data we have: dominant pre-season, minor once
    // real games accrue.
    const ep = el.ep_next != null ? parseFloat(el.ep_next) : NaN;
    const epUsable = Number.isFinite(ep) && ep >= 0;
    const playedGames = (el.minutes ?? 0) / 90;
    const thin = clamp((cfg.epThinGames - playedGames) / cfg.epThinGames, 0, 1);
    const perGw = new Map<number, number>();
    for (let gw = ctx.nextEvent; gw < ctx.nextEvent + horizon && gw <= lastEvent; gw++) {
      const fx = fxIndex.get(gw)?.get(el.team) ?? [];
      let gwXp = 0;
      for (const f of fx) {
        const isHome = f.team_h === el.team;
        gwXp += fixtureXp(el, f, isHome, gw - ctx.nextEvent, st, rates, mm);
      }
      // Blend FPL's own projection — fixture-count aware (scale for DGWs, skip
      // on blanks). The immediate GW always gets at least the light base
      // weight; every horizon GW leans on ep_next while our data is thin, so
      // pre-season the anchor is FPL's own realistic, premium-aware estimate.
      if (epUsable && fx.length > 0) {
        const isNext = gw === ctx.nextEvent;
        const w = isNext
          ? Math.max(cfg.epNextWeight, thin * cfg.epThinMaxWeight)
          : thin * cfg.epThinMaxWeight;
        if (w > 0) gwXp = (1 - w) * gwXp + w * ep * fx.length;
      }
      // Calibration: multiply by the correction learned from grading our own
      // past predictions against what actually happened.
      gwXp *= calibrationMultiplier(cal, el.element_type);
      perGw.set(gw, Number.isFinite(gwXp) ? gwXp : 0);
    }
    let total = 0;
    let totalDiscounted = 0;
    for (const [gw, v] of perGw) {
      total += v;
      totalDiscounted += v * Math.pow(cfg.gwDecay, gw - ctx.nextEvent);
    }
    result.set(el.id, {
      elementId: el.id,
      perGw,
      total,
      totalDiscounted,
      next: perGw.get(ctx.nextEvent) ?? 0,
    });
  }
  return result;
}
