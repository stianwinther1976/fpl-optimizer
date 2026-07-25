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

import type {
  Bootstrap,
  Element,
  Fixture,
  PastSeasonStats,
  SeasonWorkload,
  Team,
} from "./types";
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
  epThinMaxWeight: 0.7, // max blend weight on real-world signals when data is thin
  // How the thin-data anchor splits between FPL's ep_next and last season's
  // per-game output (both grounded in reality; both used when available).
  epShare: 0.55,
  pastSeasonShare: 0.45,
  // Pre-season, ep_next is MINUTES-BLIND: FPL hands an unplayed backup keeper
  // the same ~2.6 it gives a nailed midfielder. Before a ball is kicked the
  // ep anchor is therefore scaled by our own start probability, normalised so
  // that anyone at or above this pStart is left untouched.
  epMinutesBlindPStart: 0.8,
  // --- Own xG assessment (don't take API xG at face value) ---
  // Empirical-Bayes shrinkage: rates from small samples are pulled toward a
  // price/position prior worth `shrinkMins` minutes of evidence.
  shrinkMins: 450,
  /**
   * Fewest appearances a per-appearance rate is ever divided by, and fewest
   * minutes a per-90 points rate is ever divided by.
   *
   * A player with one minute and one appearance point is not a 90-points-per-90
   * player, but that is exactly what raw division says, and pre-season — when
   * last season's line is the ONLY evidence — that arithmetic put £4.0m squad
   * fillers with a single cameo above Salah in the launch drafter. These floors
   * make a tiny sample read as a tiny sample.
   */
  pointsPerAppearanceFloor: 5,
  pastPointsMinMinutes: 450,
  /** Points per 90 a player is regressed toward when his sample is thin. */
  priorPoints90: { 1: 3.2, 2: 3.2, 3: 3.4, 4: 3.4 } as Record<number, number>,
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
  /**
   * Chance a non-starter appears anyway.
   *
   * Applies to goalkeepers too, and a change to stop that was MEASURED AND
   * REJECTED — worth recording, because the argument for it is a good one and
   * somebody will make it again. It goes: an outfield substitution is routine,
   * whereas a substitute keeper comes on only if the starter is hurt mid-match
   * or sent off, which is on the order of 1-2% of fixtures rather than 15%, so
   * a flat 0.15 overstates a third-choice keeper's appearance odds by about
   * 8.5x. Every clause of that is true.
   *
   * It is nonetheless the wrong change, because the number is not doing the job
   * its name says. Sweeping a keeper-specific value against keeper Spearman on
   * the three archived seasons that have prior history:
   *
   *   gkSubProb  0.015  0.05   0.08   0.10   0.15   0.20   0.25
   *   2023-24    0.505  0.506  0.507  0.510  0.512  0.513  0.515
   *   2024-25    0.668  0.668  0.670  0.672  0.671  0.671  0.672
   *   2025-26    0.622  0.624  0.624  0.625  0.626  0.631  0.632
   *
   * Monotonically the wrong way. The reason is that a deputy keeper really does
   * play several league games in a normal season — the number one picks up a
   * knock in November and misses six weeks — and `pStart` cannot express that,
   * because it is computed once from the pre-season depth chart and does not
   * move. So `subProb` has been quietly carrying the probability of a
   * mid-season role change, which is a real effect of roughly the right size,
   * and removing it removes the only representation of that effect the model
   * has.
   *
   * The right fix is therefore not to this constant. It is a mid-season
   * role-change term for keepers, at which point this can drop to 0.015 and
   * mean what it says. Until that exists, 0.15 is load-bearing. Note also that
   * the sweep keeps improving above 0.15 and it is NOT being raised: the metric
   * is a ranking correlation and cannot see that inflating every backup
   * keeper's xP pushes the drafter toward paying for a bench keeper.
   */
  subProb: 0.15,
  recentStartsWeight: 0.65, // last ~5 games vs season starts share
  // --- Pre-season minutes (no game has been played yet) ---
  // Last season's STARTS out of 38, shrunk toward a price/position prior worth
  // `preseasonPriorGames` games of evidence. Shrinkage matters in both
  // directions: it stops a 38-start regular from being treated as a certainty,
  // and it stops a player with no Premier League history — a new signing, a
  // promoted club's regular — from being written off at zero.
  preseasonSeasonGames: 38,
  preseasonPriorGames: 6,
  preseasonMaxPStart: 0.97,
  /**
   * Pre-season allocation of a club's single goalkeeping shirt.
   *
   * Every other position is scored player-by-player, which is fine when a club
   * fields five midfielders but nonsense at keeper: a club carries 4.7 of them
   * on the FPL list and exactly one plays. Each keeper is scored, the scores are
   * turned into shares of one shirt, and the shares are what the projection uses.
   *
   * The numbers are fitted, not guessed. Over the 60 club-seasons in 2023/24,
   * 2024/25 and 2025/26 — comparing predicted share against the keeper's actual
   * starts/38 — these minimise Brier score at 0.050, against 0.12 for the flat
   * split this replaces. The optimum is a broad basin (0.050–0.052 across beta
   * 2.0–3.0 and mass 0.90–1.00) and leave-one-season-out refitting lands in the
   * same place, so this is a real effect rather than three seasons of noise.
   *
   * Worth knowing before trusting it too far: picking a club's number one from
   * pre-season information alone is right about 68% of the time, and right
   * within the top two 92% of the time. Hence a leading share near 0.65 rather
   * than the near-certainty the raw evidence gap often suggests — Sunderland's
   * Roefs, Burnley's Trafford and Spurs' Vicario were all unknowns who took the
   * shirt from a same-priced incumbent.
   */
  gkPreseason: {
    /** Softmax sharpness over keeper scores within a club. */
    beta: 2.5,
    /** Weight on last season's minutes, on top of price in £m. */
    minutesWeight: 0.6,
    /** Minutes above this add nothing — a full season is a full season. */
    minutesCap: 2000,
    /**
     * Total share of starts the club's keepers divide between them. Below 1
     * because cups, knocks and rotation take the shirt off the number one for
     * a few weeks of most seasons.
     */
    slotMass: 0.95,
  },
  // Prior P(start) at the position's typical price, moved by relative price:
  // FPL prices a squad filler at £4.0m and a nailed starter far above it.
  priorPStartBase: { 1: 0.5, 2: 0.5, 3: 0.5, 4: 0.5 } as Record<number, number>,
  // Steep enough that the bottom of the price ladder can actually reach the
  // floor. At slope 0.9 a £4.0m squad filler still came out at 0.32 — the range
  // was decorative. FPL's own pricing is the sharpest available statement about
  // who a club expects to play.
  priorPStartSlope: 1.6,
  priorPStartRange: [0.08, 0.9] as [number, number],
  /** Minutes per start assumed for a player with no last-season record. */
  preseasonUnknownMinsPerStart: 80,
  /** Weight of a season's evidence per year of age (0.55 = last season counts
   *  roughly twice what the one before it does). */
  preseasonSeasonDecay: 0.55,
  /** Start probability floors for set-piece duty. Clubs do not hand penalties
   *  or corners to squad players, so an order of 1 is a strong statement about
   *  a player's standing that his raw start count may not yet reflect — a
   *  regular who missed half of last season injured, for instance. */
  penaltyTakerPStart: 0.75,
  setPieceTakerPStart: 0.62,
  // --- Defensive contribution priors (used only when the whole league's DC
  // data is missing, i.e. the bootstrap has been reset for the new season) ---
  priorDc90: { 1: 0, 2: 5.5, 3: 4.0, 4: 1.5 } as Record<number, number>,
  // Availability recovery: how fast doubtful/injured players return to
  // fitness in later horizon GWs (geometric decay of the deficit)
  recoveryRate: 0.6,
  /** Availability in the first match after a stated return date, and how many
   *  days it takes to climb back to full. A player is named in the squad before
   *  he is trusted with 90 minutes. */
  returnRampStart: 0.35,
  returnRampDays: 21,
  // Horizon discounting: future GWs are less certain
  gwDecay: 0.88,
  // Availability by status when chance_of_playing is null
  statusProb: { a: 1, d: 0.5, i: 0, s: 0, u: 0, n: 0 } as Record<string, number>,
  /**
   * Minutes of evidence the price prior is worth, in the blend between the
   * stats model and the price-implied one.
   *
   * This replaces a threshold — `minMinutesForModel: 270`, "below this, lean on
   * the price prior" — and a threshold was the wrong shape for it. It made the
   * whole scoring formula a step function: 269 minutes of last-season evidence
   * projected 0.835 and 271 projected 0.479, so two minutes moved a player 74%,
   * and moved him DOWN for having more evidence. It sat exactly where fringe
   * squad player becomes rotation option, which is the £4.5-5.5m band where a
   * draft's marginal decisions actually live, and every other shrinkage in this
   * file is a smooth n/(n+k) blend already.
   *
   * A second defect went with it: the thin-side weights were 0.55 + 0.35 +
   * 0.25 = 1.15, a 15% uplift applied only to the players the model knows least
   * about, which nothing in the code claimed to intend. The complementary
   * weights below sum to 1 by construction.
   *
   * This change was first justified by a stronger claim than the evidence
   * supported, and the correction belongs on the record next to it. A price
   * sweep appeared to show an empty-record player OVERTAKING a proven 35-start
   * regular above about £9.5m (0.21x / 0.59x / 0.98x / 1.00x / 1.05x at £4.5m /
   * £6.5m / £8.5m / £9.5m / £12.5m). That sweep held the proven player's record
   * fixed at 145 points and 3100 minutes while varying his price, so by £12.5m
   * the comparator was not a proven premium but an overpriced one, and the
   * crossover was an artefact of the probe. Re-run with the record scaled to
   * the price, the unknown never wins at any point on the curve — 0.281 at
   * £4.5m rising to 0.774 at £12.5m, monotone and always below 1, on the
   * shipped code as well as this one.
   *
   * So the ordering was never inverted, and what justifies the change is the
   * step function itself plus the harness numbers: mean launch Spearman over
   * the four archived seasons 0.610 -> 0.623, squad points 6279 -> 6330, and
   * in-season 2024-25 rho 0.396 -> 0.419 with bias 0.088 -> 0.026.
   *
   * A third change was tried here and REJECTED on measurement, which is worth
   * recording so nobody re-proposes it. The price prior is multiplied by
   * availability but not by the minutes model, so a £9.0m player believed to
   * start a quarter of the time still collects the full price floor; scaling
   * the prior by `mm.share` looked obviously right and cost 0.556 -> 0.532
   * Spearman on 2022-23. The reason is that this branch only ever runs for
   * players with a thin record, and for those the minutes model is running on
   * the same absence of evidence the rates are — so the correction multiplies
   * one shrunk-to-prior guess by another and compounds the noise instead of
   * cancelling it. Price already encodes FPL's own view of a player's role.
   */
  priceBlendMins: 270,
  /**
   * Least weight the stats model is ever given against the price prior.
   *
   * Without it `n / (n + k)` reaches exactly zero and a player with no record is
   * scored on price alone, discarding fixture difficulty, venue, position and
   * the minutes model — none of which price knows, and all of which the model
   * still supplies when its rates are shrunk all the way to the positional
   * prior.
   *
   * Fitted rather than argued. Mean Spearman over the four archived seasons,
   * against 0.610 for the threshold this replaces:
   *
   *   floor  0     0.15   0.35   0.40   0.50   0.65
   *   mean   0.607 0.616  0.623  0.623  0.623  0.620
   *
   * A broad plateau over 0.35-0.65, which is what a real effect looks like, and
   * 0.40 is its centre. One caveat belongs on the record: 2022-23 pulls the
   * other way (0.579 at floor 0 down to 0.559 at 0.40) because it is the
   * earliest season in the archive, so no player in it has a preceding season
   * and all 573 run through this branch with zero evidence. That is a harness
   * artefact rather than a pre-season anyone will ever face; the three seasons
   * where thin players are the genuine minority — new signings, promoted-club
   * regulars, the population this branch exists for — all prefer the high floor,
   * 2025-26 most strongly at 0.617 -> 0.665.
   *
   * One objection to the whole blend deserves its answer here rather than in a
   * commit message, because it is the right objection and it was raised by a
   * reviewer who had not been told the answer. Shrinking a thin player's own
   * rate toward the price prior must COMPRESS the gap between a productive and
   * an unproductive fringe player, since price is what they have in common —
   * and pooled Spearman is dominated by £12.5m-vs-£4.0m comparisons that take
   * no model at all, so it could rise while the within-band ordering that a
   * draft actually turns on gets worse.
   *
   * So the harness was given a within-band Spearman (`cheapR` / `topR` in
   * `scripts/simulate.test.ts`) and the question was measured. Among players at
   * £5.5m and below — the population this branch exists for — the blend beats
   * the threshold in all four archived seasons, mean 0.558 -> 0.577. Among the
   * dearest 150 it is flat, 0.410 -> 0.409. Compression is not the same as
   * information loss: what a 400-minute sample mostly contains is noise.
   */
  priceBlendFloor: 0.4,
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
  /**
   * elementId -> last completed season's stat line (element-summary
   * history_past). The grounded pre-season signal for who actually played and
   * what they produced — and the ONLY such signal once FPL resets the
   * bootstrap counters for the new season.
   */
  pastSeason?: Map<number, PastSeasonStats>;
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
const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");

/**
 * The expected return date FPL writes into `news`, as a timestamp.
 *
 * The string looks like "Knee injury - Expected back 25 Sep". Without reading
 * it, every injury decays back to fitness on the same blind curve, so a
 * season-ending ACL is projected 87% fit five gameweeks out — and the launch
 * optimizer will happily spend £7.5m on him. Returns null when there is no
 * date, in which case the decay curve is still the best guess available.
 */
export function newsReturnTime(el: Element, seasonStartYear: number): number | null {
  const m = /expected back[^0-9]*(\d{1,2})\s+([A-Za-z]{3})/i.exec(el.news ?? "");
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS.indexOf(m[2].toLowerCase().slice(0, 3));
  if (month < 0) return null;
  // FPL omits the year. A season runs Aug–May, so a month before August belongs
  // to the following calendar year.
  const year = month < 7 ? seasonStartYear + 1 : seasonStartYear;
  return Date.UTC(year, month, day);
}

/**
 * Availability for a specific horizon offset (0 = next GW).
 * chance_of_playing_next_round applies, by definition, only to the next round;
 * a suspension is usually one match; injuries/doubts recover over time.
 */
export function availabilityAt(el: Element, offset: number, kickoff?: number | null): number {
  const cfg = XP_CONFIG;
  if (el.status === "u" || el.status === "n") return 0; // left club / unavailable
  if (el.status === "a") return 1;
  let a0: number;
  if (el.chance_of_playing_next_round != null) {
    a0 = clamp(el.chance_of_playing_next_round / 100, 0, 1);
  } else {
    a0 = cfg.statusProb[el.status] ?? 1;
  }
  // A stated return date beats any decay curve: before it he does not play, and
  // shortly after it he is easing back rather than instantly nailed.
  if (kickoff != null && (el.status === "i" || el.status === "d")) {
    const back = newsReturnTime(el, new Date(kickoff).getUTCMonth() >= 7
      ? new Date(kickoff).getUTCFullYear()
      : new Date(kickoff).getUTCFullYear() - 1);
    if (back != null) {
      const days = (kickoff - back) / 86_400_000;
      if (days < 0) return 0;
      return clamp(cfg.returnRampStart + (1 - cfg.returnRampStart) * (days / cfg.returnRampDays), 0, 1);
    }
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
  /**
   * Each club's overall rating relative to the league average.
   *
   * Pre-season this is the ONLY team-quality signal FPL still publishes: the
   * detailed attack/defence ratings are all zero, and FDR describes only the
   * opponent — so without this a promoted club's defender and an Arsenal
   * defender get identical clean-sheet odds, which is worth several points a
   * player across a launch squad.
   */
  ownQuality: Map<number, number>;
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
  // Overall ratings live on a 1-5 scale pre-season and ~1000-1400 in-season, so
  // they are used only as a ratio to the league mean — that works on both, and
  // collapses harmlessly to 1.0 when every club is rated the same.
  const overall = (t: Team) => (t.strength_overall_home + t.strength_overall_away) / 2;
  const meanOverall = avg(overall);
  const ownQuality = new Map<number, number>();
  for (const t of teams) {
    ownQuality.set(t.id, meanOverall > 0 ? overall(t) / meanOverall : 1);
  }
  return {
    usable: spread > 40,
    avgAttH,
    avgAttA,
    avgDefH,
    avgDefA,
    byTeam,
    gamesByTeam,
    playedGws,
    ownQuality,
  };
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
  /** Defensive actions per 90 — the count the +2 DC threshold is tested against. */
  dc90: number;
  /** Minutes the rates above were actually estimated from. */
  sampleMinutes: number;
  /** Points per 90 of that same sample (the season-form half of the form term). */
  samplePpg: number;
}

/**
 * Which stat line to reason from.
 *
 * In-season: the bootstrap element, always. Pre-season — and for anyone with no
 * minutes yet this season — the bootstrap is empty or stale, so last season's
 * `history_past` line is used instead. The switch is on minutes, not on a date,
 * so it degrades gracefully whenever FPL resets the counters.
 */
/**
 * Counting stats are optional on purpose. A season that predates a stat — xG
 * only goes back to 2022/23, defensive contribution to 2024/25 — must read as
 * "unknown", never as a hard zero: 3000 minutes of recorded zero xG would
 * regress a striker to nothing.
 */
interface StatLine {
  minutes: number;
  starts: number;
  goals?: number;
  assists?: number;
  xg?: number;
  xa?: number;
  ict?: number;
  bonus?: number;
  saves?: number;
  /** Points per APPEARANCE over the sample — the same unit as FPL's own
   *  `points_per_game`, so the two are interchangeable at the call site. Using
   *  points per 90 here instead would systematically flatter fringe players,
   *  who bank appearance points over very few minutes. */
  ppg: number;
  fromPast: boolean;
}

function statLine(el: Element, past: PastSeasonStats | undefined, preseason: boolean): StatLine {
  const cfg = XP_CONFIG;
  const minutes = el.minutes ?? 0;
  // Pre-season the bootstrap is at best a stale copy of the same season the
  // history line describes, and at worst half-wiped: FPL zeroes the columns one
  // at a time, so `minutes` can still read 3330 while `defensive_contribution`
  // and the xG columns have already gone. `history_past` is the complete,
  // stable record — prefer it outright rather than trusting a line that may be
  // mid-reset.
  if (past && past.minutes > 0 && (preseason || minutes <= 0)) {
    return {
      minutes: past.minutes,
      starts: past.starts ?? 0,
      goals: past.goals,
      assists: past.assists,
      xg: past.xg,
      xa: past.xa,
      ict: past.ict,
      bonus: past.bonus,
      saves: past.saves,
      // Appearances aren't published, but a player's minutes never fall below
      // his starts and rarely below ~55 per outing counting substitutions, so
      // this brackets the true count closely enough for a form term.
      //
      // The `pointsPerAppearanceFloor` term is what stops a cameo from reading
      // as superhuman: a player who came on for one minute and banked the
      // appearance point has "1 point in 1 appearance", and dividing by a raw
      // count would rate him a returning regular. Below a few full matches
      // there is no per-appearance rate worth quoting.
      ppg:
        past.points /
        Math.max(
          cfg.pointsPerAppearanceFloor,
          past.starts ?? 0,
          past.minutes / 70
        ),
      fromPast: true,
    };
  }
  // A player with real minutes and a literal 0.0 ICT index has not had a quiet
  // season — that column has been reset. Read it as unknown so the shrinkage
  // falls back to the prior instead of booking it as evidence of nothing.
  const ictRaw = parseFloat(el.ict_index);
  const reset = preseason && minutes > 0 && !(ictRaw > 0);
  return {
    minutes,
    starts: el.starts ?? 0,
    goals: reset ? undefined : (el.goals_scored ?? 0),
    assists: reset ? undefined : (el.assists ?? 0),
    xg: reset ? undefined : parseFloat(el.expected_goals) || 0,
    xa: reset ? undefined : parseFloat(el.expected_assists) || 0,
    ict: reset ? undefined : ictRaw || 0,
    bonus: reset ? undefined : (el.bonus ?? 0),
    saves: reset ? undefined : (el.saves ?? 0),
    ppg: parseFloat(el.points_per_game) || 0,
    fromPast: false,
  };
}

/**
 * Defensive actions per 90. FPL zeroes the bootstrap's `defensive_contribution`
 * for the new season well before it zeroes minutes, so pre-season the count has
 * to come from `history_past` — otherwise the +2 DC points silently vanish and
 * the model systematically under-rates centre-backs and defensive midfielders.
 */
function dcPer90(el: Element, past?: PastSeasonStats): number {
  const cur = el.defensive_contribution ?? 0;
  if (cur > 0 && el.minutes > 0) return (cur / el.minutes) * 90;
  const p = past?.defensiveContribution ?? 0;
  if (p > 0 && (past?.minutes ?? 0) > 0) return (p / past!.minutes) * 90;
  return -1; // unknown — caller decides whether to fall back to a prior
}

/**
 * Prior probability of starting, from price alone. Used where there is no
 * playing record to go on: a new signing from abroad, a promoted club's regular,
 * an academy graduate. FPL's own pricing is the only evidence of the role a
 * player was bought for, and it is a decent one.
 */
function priorPStart(el: Element): number {
  const cfg = XP_CONFIG;
  const t = el.element_type;
  const typical = cfg.typicalPriceM[t] ?? 6;
  const rel = el.now_cost / 10 / typical - 1;
  const [lo, hi] = cfg.priorPStartRange;
  return clamp((cfg.priorPStartBase[t] ?? 0.5) + cfg.priorPStartSlope * rel, lo, hi);
}

/**
 * Our own assessment of a player's attacking rates — the API's raw xG/xA is
 * shrunk for small samples, blended with actual output (finishing skill),
 * and adjusted for penalty & set-piece duty.
 */
function playerRates(el: Element, past?: PastSeasonStats, preseason = false): Rates {
  const cfg = XP_CONFIG;
  const t = el.element_type;
  const s = statLine(el, past, preseason);
  const priceM = el.now_cost / 10;
  const priceFactor = clamp(priceM / (cfg.typicalPriceM[t] ?? 6), 0.6, 2.2);
  const pXg = (cfg.priorXg90[t] ?? 0.1) * priceFactor;
  const pXa = (cfg.priorXa90[t] ?? 0.1) * priceFactor;
  const pIct = (cfg.priorIct90[t] ?? 6) * priceFactor;
  const pBonus = (cfg.priorBonus90[t] ?? 0.2) * priceFactor;

  // A stat the source didn't record contributes no evidence — it falls back to
  // the prior rather than counting as a season's worth of zeroes.
  const rate = (v: number | undefined, prior90: number) =>
    shrunk90(v ?? 0, v == null ? 0 : s.minutes, prior90);
  const xG90 = rate(s.xg, pXg);
  const xA90 = rate(s.xa, pXa);
  const goals90 = rate(s.goals, pXg);
  const assists90 = rate(s.assists, pXa);
  const ict90 = rate(s.ict, pIct);
  const bonus90 = rate(s.bonus, pBonus);
  const savesPrior = cfg.priorSaves90 * clamp(2 - priceFactor, 0.7, 1.3);
  const saves90 = t === 1 ? rate(s.saves, savesPrior) : 0;
  const rawDc = dcPer90(el, past);
  const dc90 = rawDc >= 0 ? rawDc : (cfg.priorDc90[t] ?? 0);

  // Finishing-skill blend: give actual conversion some weight once the
  // sample is meaningful (regressed, never fully trusted).
  const wFin = cfg.xgBlendGoalsWeight * Math.min(1, s.minutes / cfg.xgBlendMinMinutes);
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

  return {
    effXg90,
    effXa90,
    ict90,
    bonus90,
    saves90,
    dc90,
    sampleMinutes: s.minutes,
    samplePpg: s.ppg,
  };
}

interface MinutesModel {
  pStart: number;
  minsPerStart: number;
  share: number; // season minutes share (attacking output scales with this)
}

/**
 * A floor on start probability implied by set-piece duty.
 *
 * These fields are live pre-season when almost nothing else is, and they say
 * something the start count cannot: a club's designated penalty taker is, by
 * construction, someone the manager expects on the pitch. Only a floor — it
 * can lift a player the raw evidence under-rates, never lower anyone.
 */
function setPieceStartFloor(el: Element): number {
  const cfg = XP_CONFIG;
  let floor = 0;
  if (el.penalties_order === 1) floor = Math.max(floor, cfg.penaltyTakerPStart);
  if (el.direct_freekicks_order === 1 || el.corners_and_indirect_freekicks_order === 1) {
    floor = Math.max(floor, cfg.setPieceTakerPStart);
  }
  return floor;
}

/**
 * Which season a `history_past` row describes, counted backwards from the
 * season about to start. 0 = last season, 1 = the one before, and so on.
 *
 * Season names look like "2025/26"; the leading year is all we need. Returns
 * null for anything unparseable so the caller can fall back rather than
 * silently treating a bad row as recent.
 */
function seasonAge(seasonName: string | undefined, seasonStartYear: number): number | null {
  if (!seasonName) return null;
  const y = parseInt(seasonName.slice(0, 4), 10);
  if (!Number.isFinite(y)) return null;
  const age = seasonStartYear - 1 - y;
  // Checked on the way OUT as well as in. `seasonStartYear` is derived from a
  // date, and an unparseable date makes it NaN — which no caller's `?? 0`
  // rejects and no `<` comparison rejects either, so it propagates in silence.
  // Returning null forces the caller down its own no-evidence path instead.
  return Number.isFinite(age) ? age : null;
}

/**
 * How many games a player STARTED, when FPL didn't record starts.
 *
 * `starts` only exists from 2021/22. An older row still has minutes, and
 * minutes/80 is a serviceable estimate — far better than reading the absent
 * field as zero, which would rate a 3000-minute season below never having
 * played at all.
 */
function impliedStarts(row: SeasonWorkload): number {
  if (row.starts != null) return row.starts;
  return clamp(row.minutes / XP_CONFIG.preseasonUnknownMinsPerStart, 0, 38);
}

/**
 * Pre-season minutes: nobody has kicked a ball, so past seasons are the evidence
 * and price is the prior.
 *
 * Every completed season counts, weighted by how long ago it was. That single
 * mechanism handles the three profiles that all look like "no recent starts"
 * and are wildly different players:
 *
 *  - the fading squad player (35 starts, then 20, then 8) — recent evidence
 *    dominates, and he is correctly marked down;
 *  - the regular who lost last season to injury — the blank year counts against
 *    him, but three prior seasons of 34 starts stop him being written off;
 *  - the player who spent last season abroad or in the Championship — that
 *    season is simply ABSENT from the record, contributing no evidence either
 *    way, so his older seasons carry him at reduced confidence toward the prior.
 *
 * Absence of evidence and evidence of absence are different things, and getting
 * that distinction wrong is what makes a pre-season model draft the wrong £4.5m
 * defender.
 */
interface PreseasonEvidence {
  /** Effective games observed, after age-weighting. */
  games: number;
  /** Age-weighted starts. */
  starts: number;
  /** Age-weighted minutes. */
  minutes: number;
}

function preseasonEvidence(
  el: Element,
  past: PastSeasonStats | undefined,
  seasonStartYear: number
): PreseasonEvidence | null {
  const cfg = XP_CONFIG;
  const rows = past?.seasons ?? (past?.lastSeason ? [past.lastSeason] : []);
  if (past && rows.length > 0) {
    let games = 0;
    let starts = 0;
    let minutes = 0;
    for (const row of rows) {
      const age = seasonAge(row.seasonName, seasonStartYear) ?? 0;
      if (age < 0) continue; // a row for a season that hasn't finished
      const w = Math.pow(cfg.preseasonSeasonDecay, age);
      if (w < 0.05) continue; // ancient history, not worth the arithmetic
      games += w * cfg.preseasonSeasonGames;
      starts += w * impliedStarts(row);
      minutes += w * row.minutes;
    }
    return games > 0 ? { games, starts, minutes } : null;
  }
  if (past) {
    // No per-season breakdown, but a rate line survives: treat it as the one
    // season it came from, aged by its own season name. This keeps the model
    // working against a partially-populated record instead of silently
    // discarding the only evidence there is.
    if (past.minutes > 0) {
      const age = Math.max(0, seasonAge(past.seasonName, seasonStartYear) ?? 0);
      const w = Math.pow(cfg.preseasonSeasonDecay, age);
      return {
        games: cfg.preseasonSeasonGames,
        starts: impliedStarts({ minutes: past.minutes, starts: past.starts }) * w,
        minutes: past.minutes * w,
      };
    }
    // We looked and there is no Premier League record at all: a signing from
    // abroad, an academy graduate, a promoted club's regular. Price is the only
    // evidence of the role he was bought for.
    return null;
  }
  // We never looked. The bootstrap still carries last season's totals until FPL
  // zeroes them — real evidence while it lasts. But a bootstrap ZERO is
  // ambiguous between "played nothing" and "wasn't in the game", and that is
  // precisely the ambiguity only history_past can settle, so it is treated as
  // unknown rather than guessed at.
  const minutes = el.minutes ?? 0;
  if (minutes <= 0) return null;
  return {
    games: cfg.preseasonSeasonGames,
    starts: el.starts ?? clamp(minutes / cfg.preseasonUnknownMinsPerStart, 0, 38),
    minutes,
  };
}

function preseasonMinutes(
  el: Element,
  past: PastSeasonStats | undefined,
  seasonStartYear: number
): MinutesModel {
  const cfg = XP_CONFIG;
  const prior = priorPStart(el);
  const floor = setPieceStartFloor(el);
  const ev = preseasonEvidence(el, past, seasonStartYear);
  if (!ev) {
    const mps = cfg.preseasonUnknownMinsPerStart;
    const pStart = Math.max(prior, floor);
    return { pStart, minsPerStart: mps, share: clamp((pStart * mps) / 90, 0, 1) };
  }
  const k = cfg.preseasonPriorGames;
  const pStart = clamp(
    Math.max((ev.starts + prior * k) / (ev.games + k), floor),
    0,
    cfg.preseasonMaxPStart
  );
  // How much of a start he actually completes: being hooked on 60 every week is
  // itself a rotation signal, and it costs appearance and clean-sheet points.
  const minsPerStart = ev.starts > 0 ? clamp(ev.minutes / ev.starts, 45, 90) : 60;
  // A regular substitute plays real minutes that `pStart * minsPerStart` throws
  // away — 900 minutes off the bench is not the same player as 20. The observed
  // share is a floor, never a cap, so it can only rescue a genuine super-sub.
  const observedShare = ev.minutes / (ev.games * 90);
  const share = clamp(Math.max((pStart * minsPerStart) / 90, observedShare), 0, 1);
  return { pStart, minsPerStart, share };
}

/** Starts-based minutes model with a pre-season prior fallback. */
function minutesModel(
  el: Element,
  teamGames: number,
  recentStartShare?: number,
  past?: PastSeasonStats,
  seasonStartYear = new Date().getUTCFullYear()
): MinutesModel {
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
    // Pre-season: no games played by anyone. Judge on last season, not on a
    // flat prior that would rate a backup keeper like a nailed defender.
    return preseasonMinutes(el, past, seasonStartYear);
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

function kickoffTime(f: Fixture | undefined): number | null {
  if (!f?.kickoff_time) return null;
  const t = Date.parse(f.kickoff_time);
  return Number.isFinite(t) ? t : null;
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
  const avail = availabilityAt(el, gwOffset, kickoffTime(fixture));
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
    // FDR describes the OPPONENT only. Own-club quality has to come from the
    // overall ratings, or every defender in the league facing an equal-FDR tie
    // is given the same clean sheet — the single biggest pre-season distortion
    // after minutes, and one that systematically drafts promoted-club defenders.
    const q = st.ownQuality.get(el.team) ?? 1;
    attackMult = (cfg.attackMultByFdr[fdr] ?? 1) * venue * clamp(q, 0.65, 1.4);
    csProb = (cfg.csProbByFdr[fdr] ?? 0.3) * (isHome ? 1.1 : 0.9) * clamp(q, 0.45, 1.6);
    // Shots faced, for the keeper's save points, depend on BOTH sides: how weak
    // his own club is AND how strong the opponent is. This used to be `1 / q`
    // alone — own weakness only — which meant that in the FDR fallback, the
    // branch the app takes for the whole of pre-season because FPL zeroes the
    // detailed strength ratings over the summer, a keeper facing the champions
    // and a keeper facing the promoted side were given identical save
    // expectations. The opponent term is read off `gcPenaltyByFdr` normalised to
    // its own neutral rating rather than from a new table: goals conceded and
    // shots faced are the same underlying quantity, and a constant that nothing
    // fits is a constant nobody can defend.
    const oppByFdr =
      (cfg.gcPenaltyByFdr[fdr] ?? cfg.gcPenaltyByFdr[3]) / cfg.gcPenaltyByFdr[3];
    oppAttRatio = clamp(oppByFdr / Math.max(0.2, q), 0.6, 1.8);
  }
  csProb = clamp(csProb, 0, 0.9);

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
    else {
      // A weaker club concedes more against the same opponent — the mirror of
      // the clean-sheet adjustment above.
      const q = st.ownQuality.get(el.team) ?? 1;
      xp -=
        p60 *
        (cfg.gcPenaltyByFdr[fdr] ?? 0.5) *
        (isHome ? 0.9 : 1.1) *
        clamp(1 / Math.max(0.2, q), 0.6, 1.8);
    }
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

  // Defensive-contribution points: actions per 90 vs the +2 threshold.
  if (rates.dc90 > 0) {
    const threshold = el.element_type <= 2 ? cfg.dcThresholdDef : cfg.dcThresholdMid;
    xp += p60 * cfg.dcPoints * poissonTail(rates.dc90, threshold) * cfg.dcWeight;
  }

  // Form component: recency-weighted, fixture-adjusted (venue is already part
  // of attackMult — do not apply it twice).
  //
  // REJECTED, and recorded here because the objection is a good one and will be
  // raised again. Pre-season `el.form` is "0.0" for all 700-odd players — form
  // is a thirty-day rolling average and nothing has been played — and this file
  // twice elsewhere documents the sin of reading a placeholder zero as a
  // measurement. So the zero halves `formScore` for every player with a record,
  // and it does not cancel out: `model` is blended against a price prior that
  // is NOT halved, so the depression quietly hands the prior more weight than
  // it was tuned to have, hardest on the players whose form term is largest.
  //
  // That reasoning is correct and the conclusion drawn from it was still wrong.
  // Two corrections were implemented and measured over all four archived
  // seasons. B used `seasonPpg` alone when no team has kicked off; C dropped
  // the form term entirely pre-season (`model = xp`) on the grounds that there
  // is no form signal to weight.
  //
  //            managed   set&forget   launch-squad pts   all    cheapR   topR
  //   shipped    8805        6496            6315        .623    .577    .409
  //   B          8637        6351            6226        .623    .578    .410
  //   C          8783        6341            6171        .622    .576    .412
  //
  // Every ranking metric is flat to within 0.001 in both directions, which is
  // the finding: pre-season `points_per_game` is also "0.0", so `seasonPpg`
  // falls through to `rates.samplePpg` — last season's rate, which is already
  // inside `xp`. The form term carries no independent information in August at
  // any weight, and re-weighting a duplicate of a signal the model has already
  // used cannot sharpen a ranking. What the weight does change is how far the
  // blend leans on raw points-per-game versus the xG-driven rates, and raw
  // points regress harder; both departures from the accidental 0.5 cost points
  // on all three outcome measures. The halving is not a measurement error being
  // propagated, it is shrinkage of a redundant and more-regressive term, and it
  // happens to sit better than either principled alternative. Leaving it is the
  // measured choice, not an oversight.
  const recent = parseFloat(el.form) || 0;
  const seasonPpg = parseFloat(el.points_per_game) || rates.samplePpg;
  const formScore = cfg.recentFormShare * recent + (1 - cfg.recentFormShare) * seasonPpg;
  const fdrFormAdj = st.usable ? attackMult : (1 + (3 - fdr) * 0.1) * venue;
  const formXp = pPlay * formScore * clamp(fdrFormAdj, 0.65, 1.35);

  // How far to trust the model over the price prior. The sample in question is
  // the one the rates were estimated from, which pre-season is last season's
  // minutes rather than the bootstrap's zeroed counters.
  //
  // This used to be a threshold, and a threshold is the wrong shape for it. A
  // player on 269 sample minutes and a player on 271 differ by two minutes of
  // football and were handed to two different formulas; measured on a real pair
  // the step was 0.835 against 0.479, a 74% jump across a boundary that
  // corresponds to nothing. `n / (n + k)` says the same thing the threshold was
  // trying to say — thin sample, lean on price; thick sample, trust the model —
  // without the discontinuity, and it is the same shrinkage form already used
  // for the rates themselves, so it needs no new justification.
  //
  // The old weights on the thin side summed to 1.15 (0.55 prior + 0.35 xp +
  // 0.25 formXp), a fifteen percent uplift applied only to the players the model
  // knows least about and claimed nowhere. The two below are complementary and
  // sum to 1 by construction.
  //
  // What justifies it is the step and the harness, not the price-inversion
  // story an earlier version of this comment told — that one came from a probe
  // that varied price while holding the record fixed, and it does not survive a
  // fair sweep. See `priceBlendMins` for the retraction and the numbers.
  //
  // See `priceBlendFloor` for why w never reaches zero, and for the change that
  // was tried here and rejected on measurement.
  const w = Math.max(
    cfg.priceBlendFloor,
    rates.sampleMinutes / (rates.sampleMinutes + cfg.priceBlendMins)
  );
  const model = cfg.modelWeight * xp + cfg.formWeight * formXp;
  const priceM = el.now_cost / 10;
  const prior =
    Math.max(0.5, cfg.priceSlope * priceM + cfg.priceIntercept) *
    avail *
    (isHome ? 1.04 : 0.96);
  return Math.max(0, w * model + (1 - w) * prior);
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
  // Which season is about to start, taken from the fixture list rather than the
  // clock, so a backtest replaying 2023/24 ages that season's history correctly.
  //
  // Each candidate is PARSED before being accepted, rather than picked with
  // `??`. The earlier version chained `??`, which only rejects null and
  // undefined — so an empty-string deadline, which is exactly what a synthetic
  // event list contains, was taken as a valid date. `new Date("")` is an
  // Invalid Date and `getUTCFullYear()` on it is NaN, and NaN then walks
  // straight through every downstream guard: `?? 0` does not catch it, and both
  // `age < 0` and `w < 0.05` are FALSE for NaN, so nothing rejects it until
  // `games > 0` fails at the very end and `preseasonEvidence` returns null for
  // every player who has ever played. The pre-season minutes model — the single
  // largest signal there is before a ball is kicked — silently switched itself
  // off, and a nailed 3330-minute starter scored identically to a 300-minute
  // fringe player at the same price. Nothing failed; the numbers were simply
  // wrong, and every measurement taken against them was wrong too.
  const stamps = [
    events[0]?.deadline_time,
    ctx.fixtures.find((f) => f.kickoff_time)?.kickoff_time,
  ];
  const stamp = stamps.map((v) => (v ? Date.parse(v) : NaN)).find(Number.isFinite);
  const seasonStartYear = new Date(stamp ?? Date.now()).getUTCFullYear();

  // Exactly one goalkeeper starts per club per match, and a club lists four or
  // five of them. Scoring each in isolation — which is what the rest of the
  // model does, reasonably, for positions where a club fields several — is the
  // reason FPL's own ep_next rates a keeper with no career minutes at 2.6.
  //
  // The first attempt at this divided each club's keepers by their total, so
  // that they summed to one. That is arithmetically tidy and football nonsense:
  // with 4.7 keepers per club it dragged every keeper in the game down to about
  // 0.25 of a start, so a proven ever-present rated below an outfield reserve
  // and the drafter simply bought the two cheapest keepers in the league and
  // spent the change up front. Dividing preserves the ordering within a club
  // but destroys the level, and the level is what the squad optimiser compares.
  //
  // What follows instead allocates the one shirt by softmax over price and last
  // season's minutes — see `gkPreseason` for how the constants were fitted and
  // how much to trust them. Availability multiplies the weight rather than the
  // result, so a flagged number one hands his share to the deputy instead of
  // deleting it.
  //
  // Computed PER GAMEWEEK, not once. The first version of this took
  // `availabilityAt(el, 0)` — availability on the day the page is loaded — and
  // used that one number for the whole horizon. A club's first-choice keeper
  // with a knock and a stated return date two weeks out was therefore written
  // off for every gameweek in the projection, and his deputy was handed the
  // shirt permanently, which is not what the news item says at all. Availability
  // decays back toward 1 as the return date passes, and this now follows it.
  //
  // Note also what the weights do NOT do any more: they no longer multiply the
  // keeper's own availability into his share. `fixtureXp` already applies
  // `availabilityAt` to every player including keepers, so doing it here too
  // discounted a doubtful keeper twice, by the square of the same number. The
  // rival keepers' availability still appears in the DENOMINATOR, because that
  // is the part that does the real work: it is what moves the shirt to the
  // deputy rather than deleting it.
  const gkPStart = new Map<number, number[]>();
  {
    const g = cfg.gkPreseason;
    const byClub = new Map<number, { id: number; el: Element; score: number }[]>();
    for (const el of ctx.bootstrap.elements) {
      if (el.element_type !== 1) continue;
      const teamGames = st.gamesByTeam.get(el.team) ?? st.playedGws;
      // Pre-season only. Once real games exist, who the club actually picked is
      // a direct observation, and no inference from price beats watching.
      if (teamGames > 0) continue;
      // `PastSeasonStats.minutes` is NOT last season's minutes. It is built
      // from "the most recent season with actual pitch time", because the
      // per-90 RATES need a season the player actually played — a year lost to
      // injury should not erase what a striker can do. That is right for rates
      // and exactly wrong here. A keeper who was first choice in 2023/24 and
      // did not play a minute in 2024/25 carries `minutes: 3060` from two years
      // ago, so this handed him the shirt over the man who actually kept goal
      // all last season: the deposed keeper scored 2.0x too high and the
      // incumbent 0.71x too low, which is the whole allocation inverted.
      //
      // `preseasonEvidence` is the function that already answers this question
      // correctly everywhere else in the file — it walks every season on record
      // and weights them by `preseasonSeasonDecay ^ age`, so last season
      // dominates without a keeper's three seasons as an established number one
      // being thrown away because he missed the most recent one to injury. A
      // straight `lastSeason?.minutes` would fix the inversion but introduce
      // that second error in its place.
      //
      // And `preseasonEvidence.minutes` is a WEIGHTED SUM over every season on
      // record, not a per-season figure. Rows survive while `0.55^age >= 0.05`,
      // so six seasons multiply out to 2.16x a single one — while `minutesCap`
      // below is documented as "a full season is a full season" and set at
      // 2000. Handing the sum straight in compared a career total against a
      // one-season ceiling, which saturated the cap for anyone who had simply
      // been around: a career deputy on 1080 minutes a season for five years
      // reached it just as surely as a 3420-minute ever-present, and the two
      // then separated on price alone. Measured, a nailed number one against
      // that deputy at the same price went from 1.92x to 1.015x — the depth
      // chart flattened into a coin toss. Dividing by `ev.games` restores the
      // units, which is what every other caller of this function already does
      // (`ev.starts / ev.games`, `ev.minutes / (ev.games * 90)`).
      const ev = preseasonEvidence(el, ctx.pastSeason?.get(el.id), seasonStartYear);
      const mins = ev && ev.games > 0 ? (ev.minutes / ev.games) * cfg.preseasonSeasonGames : 0;
      const score =
        el.now_cost / 10 + (Math.min(mins, g.minutesCap) / g.minutesCap) * g.minutesWeight;
      const list = byClub.get(el.team) ?? [];
      list.push({ id: el.id, el, score });
      byClub.set(el.team, list);
    }
    for (const [teamId, list] of byClub) {
      const shares = list.map(() => new Array<number>(horizon).fill(0));
      for (let off = 0; off < horizon; off++) {
        const gw = ctx.nextEvent + off;
        const kickoff = kickoffTime(fxIndex.get(gw)?.get(teamId)?.[0]);
        const raw = list.map((k) => Math.exp(g.beta * k.score));
        const sum = list.reduce(
          (acc, k, i) => acc + availabilityAt(k.el, off, kickoff) * raw[i],
          0
        );
        if (!Number.isFinite(sum) || sum <= 0) continue;
        list.forEach((_, i) => {
          shares[i][off] = clamp((raw[i] / sum) * g.slotMass, 0, cfg.preseasonMaxPStart);
        });
      }
      list.forEach((k, i) => gkPStart.set(k.id, shares[i]));
    }
  }

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
    const past = ctx.pastSeason?.get(el.id);
    const teamGames = st.gamesByTeam.get(el.team) ?? st.playedGws;
    const preseason = teamGames <= 0;
    const rates = playerRates(el, past, preseason);
    let mm = minutesModel(el, teamGames, ctx.recentStarts?.get(el.id), past, seasonStartYear);
    // Replaces rather than adjusts the generic minutes model: for a keeper
    // pre-season the club's pecking order IS the minutes model. A keeper who
    // starts finishes the match, barring a red card, so minutes follow starts
    // directly instead of being modelled as a substitute's share. `mm` here is
    // the offset-0 view, used for the anchors; the per-gameweek view is applied
    // inside the loop below, where the fixture is known.
    const gkp = gkPStart.get(el.id);
    const gkMm = (off: number): MinutesModel | null => {
      if (!gkp) return null;
      const p = gkp[Math.min(off, gkp.length - 1)] ?? 0;
      return { pStart: p, minsPerStart: 90, share: p };
    };
    mm = gkMm(0) ?? mm;
    // Real-world anchors used while our own current-season data is thin:
    //  (a) FPL's own expected points (ep_next) — an independent projection.
    //  (b) Last season's per-game output — who actually played and delivered.
    // Both fade out as real games accrue this season.
    const epRaw = el.ep_next != null ? parseFloat(el.ep_next) : NaN;
    // Pre-season ep_next ignores minutes entirely — FPL gives a keeper with
    // zero career minutes the same 2.6 it gives a nailed midfielder — so it is
    // scaled by our own start probability before being used as an anchor.
    // A function of the minutes model rather than a constant, because for a
    // pre-season keeper the minutes model varies by gameweek — see `gkMm`. Every
    // outfield player gets the same `mm` at every offset, so this is identical
    // to the previous constant for them.
    const epFor = (m: MinutesModel) =>
      preseason ? epRaw * clamp(m.pStart / cfg.epMinutesBlindPStart, 0, 1) : epRaw;
    const epUsable = Number.isFinite(epRaw) && epRaw >= 0;
    // Pre-season the bootstrap's minutes are last season's (or zero), so
    // "games played this season" is zero by definition.
    const playedGames = preseason ? 0 : (el.minutes ?? 0) / 90;
    const thin = clamp((cfg.epThinGames - playedGames) / cfg.epThinGames, 0, 1);
    // Last season's per-90 output, scaled by the minutes we expect this season.
    // Scaling by expected minutes rather than by last season's own workload is
    // what stops a fringe player's flattering per-90 from anchoring him high.
    // Applied to EVERY player, including one with no previous season at all.
    // That is the point, and it was the fix for the worst structural fault this
    // model has had.
    //
    // The guard here used to be `if (past && past.minutes > 0)`, which sounds
    // careful and is in fact ruinous. It does not merely withhold an anchor from
    // a player with no record; it scores him with a DIFFERENT MACHINE. A player
    // with a record has 70% of his projection pulled toward this anchor and 30%
    // left to the fixture model; a player without one is 100% fixture model. The
    // optimiser then compares the two numbers as though they meant the same
    // thing, and they do not.
    //
    // Measured across 2022/23-2025/26, 573-690 candidates a season, ranking the
    // pre-season projection against the points each player went on to score:
    //
    //                       guarded      unguarded    price alone
    //   no previous season   0.19-0.23    0.46-0.53    0.44-0.51
    //   has previous season  0.53-0.60    0.53-0.60    0.34-0.43
    //   pooled               0.38-0.57    0.54-0.64    0.50-0.51
    //
    // Two things in that table matter more than the headline. The first is that
    // the middle row is IDENTICAL to three decimals either way: this is not a
    // change that trades one group off against another, it leaves the proven
    // players untouched and only stops mis-scoring the rest. The second is the
    // comparison the model owes the reader — against simply sorting the list by
    // price. Guarded, the model does not beat that: 0.49 pooled against price's
    // 0.50, so all the machinery is worth nothing over reading the price tags.
    // Unguarded it reaches 0.60. Drafted squads collect 6279 season points
    // across the four seasons against 5921.
    //
    // 2022/23 is the cleanest case, because no 2021/22 file exists here, so
    // EVERY player that season is a no-record player: 0.38 guarded, 0.54
    // unguarded, and the guarded version loses to price outright.
    //
    // Nothing is needed to fix it beyond deleting the guard, because the
    // shrinkage formula already degrades to exactly the right thing. With zero
    // minutes and zero points it returns `prior90` — the price-implied
    // expectation for the position — which is precisely what should be said
    // about a player nobody has seen. Evidence then MOVES a player away from
    // that prior rather than switching him to another scoring regime, and a
    // proven starter's advantage over an unknown lands where it belongs: in the
    // minutes model, via `mm.share` below.
    const priceFactor = clamp(
      el.now_cost / 10 / (cfg.typicalPriceM[el.element_type] ?? 6),
      0.6,
      2.2
    );
    const prior90 = (cfg.priorPoints90[el.element_type] ?? 3.3) * priceFactor;
    // Empirical Bayes, exactly as the attacking rates are treated. Raw division
    // here was the second-worst bug: a player with 1 minute and the 1
    // appearance point scored "90 points per 90", and at 70% weight that
    // drafted a squad of cameo-makers over proven starters.
    const sm = cfg.pastPointsMinMinutes;
    // `fetchPastSeason` does not hand back LAST season. It hands back the most
    // recent season in which the player actually got on the pitch, which for a
    // man who missed a whole campaign injured is the season before that, and for
    // someone returning from two years abroad is older still. That is the right
    // choice for the RATE — a cruciate ligament does not erase what a player can
    // do per 90 — and the wrong one for the CONFIDENCE, which is what was
    // happening here: a two-year-old season argued at exactly the same strength
    // as one that finished in May.
    //
    // The minutes model has never done this. `preseasonEvidence` weights each
    // past season by `preseasonSeasonDecay ^ age` and always has, so the model
    // was holding two contradictory opinions about the same row — stale enough
    // to discount when deciding whether he will play, fresh enough to trust at
    // full strength when deciding how well. Scaling the evidence, not the rate,
    // is what fixes it: multiplying `pastPts` and `pastMins` by the same weight
    // leaves the implied per-90 untouched and only changes how far it can pull
    // away from `prior90`. A season two years old therefore says the same thing
    // it always said, in a quieter voice, which is all anyone should want from
    // it.
    const anchorAge = Math.max(0, seasonAge(past?.seasonName, seasonStartYear) ?? 0);
    const anchorW = Math.pow(cfg.preseasonSeasonDecay, anchorAge);
    const pastMinsRaw = past?.minutes ?? 0;
    const pastMins = pastMinsRaw * anchorW;
    const pastPts = (pastMinsRaw > 0 ? (past?.points ?? 0) : 0) * anchorW;
    const per90 = (pastPts + prior90 * (sm / 90)) / ((pastMins + sm) / 90);
    const pastPerGameFor = (m: MinutesModel) => per90 * clamp(m.share, 0, 1);
    const pastUsable = Number.isFinite(per90) && per90 >= 0;
    const perGw = new Map<number, number>();
    for (let gw = ctx.nextEvent; gw < ctx.nextEvent + horizon && gw <= lastEvent; gw++) {
      const fx = fxIndex.get(gw)?.get(el.team) ?? [];
      let gwXp = 0;
      const off = gw - ctx.nextEvent;
      const mmGw = gkMm(off) ?? mm;
      for (const f of fx) {
        const isHome = f.team_h === el.team;
        gwXp += fixtureXp(el, f, isHome, off, st, rates, mmGw);
      }
      // Blend the real-world anchors — fixture-count aware (scale for DGWs,
      // skip on blanks). Build a combined target from ep_next and last season,
      // then pull the model toward it in proportion to how thin our data is.
      if ((epUsable || pastUsable) && fx.length > 0) {
        let tSum = 0;
        let tW = 0;
        if (epUsable) {
          tSum += cfg.epShare * epFor(mmGw) * fx.length;
          tW += cfg.epShare;
        }
        if (pastUsable) {
          // A FLAT share, deliberately — the same weight for a player with a
          // full season behind him and for one with nothing at all.
          //
          // The obvious refinement is to scale this by how much evidence is
          // actually behind it, so an empty record argues quietly and a full
          // season argues loudly. That was written, shipped, and then measured,
          // and it is worse: across 2022/23-2025/26 the flat share ranks better
          // in all four seasons (+0.005 to +0.008 Spearman each, 0.591 -> 0.597
          // pooled) and drafts squads worth 122 more season points.
          //
          // The reason is that the two things being weighed are not evidence and
          // the absence of evidence. With no minutes the anchor collapses to
          // `prior90` — the PRICE-implied expectation — and price is a forecast
          // made by people who watched pre-season, worth 0.50 Spearman entirely
          // on its own. The other side of the scale is `ep_next`, which is
          // minutes-blind: FPL rates an unplayed backup keeper the same ~2.6 it
          // gives a nailed midfielder. Discounting the price signal in order to
          // defer to a minutes-blind one is the wrong trade, and four seasons
          // say so.
          const w = cfg.pastSeasonShare;
          tSum += w * pastPerGameFor(mmGw) * fx.length;
          tW += w;
        }
        // The anchors are blind to availability: FPL's own ep_next is 0.0 for an
        // injured player but last season's per-game output is not, and pulling
        // 70% of the way toward it would hand a season-ending injury a healthy
        // score. `fixtureXp` already gates on availability; the target has to be
        // gated the same way or the blend leaks the points straight back in.
        const avail = availabilityAt(el, gw - ctx.nextEvent, kickoffTime(fx[0]));
        const target = (tW > 0 ? tSum / tW : gwXp) * avail;
        const isNext = gw === ctx.nextEvent;
        const w = isNext
          ? Math.max(cfg.epNextWeight, thin * cfg.epThinMaxWeight)
          : thin * cfg.epThinMaxWeight;
        if (w > 0) gwXp = (1 - w) * gwXp + w * target;
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
