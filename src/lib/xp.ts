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
  RecentForm,
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
  /**
   * The same recency correction, applied to the OTHER axis. `recentStartsWeight`
   * only ever moved `pStart`; `minsPerStart` stayed at the season-long
   * `minutes / starts`, so a player who used to finish matches and is now hooked
   * on the hour was priced on how long he played in August. Measured against
   * actual minutes on the full population (Spearman, mean over gameweeks):
   *
   *              model  recentStarts  form   recentMinutes
   *   2022-23   0.7428     0.7381    0.7411     0.7789
   *   2023-24   0.7349     0.7310    0.7457     0.7806
   *   2024-25   0.7374     0.7350    0.7493     0.7806
   *   2025-26   0.7561     0.7481    0.7719     0.7946
   *
   * Mean minutes over the last five team games is a better minutes predictor
   * than the whole composite the model was building, in every season, and the
   * start-share term the model did consume was the WEAKEST of the four.
   */
  recentMinutesWeight: 0.65,
  /**
   * P(plays 60+ | he started), as a function of the model's own minutes-per-
   * start. This is the appearance point, and it multiplies the clean sheet and
   * the keeper's save term as well, so it is one of the most load-bearing
   * numbers in the projection.
   *
   * It used to be a step: 1.0 at 60 minutes or more, and `(mps/60)*0.5` below.
   * Both halves are wrong, and the step in between is worse than either: 59
   * minutes scored 0.492 and 60 scored 1.000, so a single minute of drift in
   * `minsPerStart` — now a fast-moving quantity — doubled a player's appearance
   * points. The curve was measured through the real projection path, not a
   * replica: the backtest was instrumented to dump the model's own
   * `minsPerStart` for every player-gameweek of 2023-24, 2024-25 and 2025-26
   * alongside what actually happened, and these two constants are the
   * maximum-likelihood logistic over the 23,158 rows where the player really
   * did start.
   *
   *      mps    n     true    fitted   old step
   *     60-65   245   0.800   0.798    1.000
   *     65-70   556   0.824   0.842    1.000
   *     70-75  1213   0.879   0.879    1.000
   *     75-80  2268   0.892   0.908    1.000
   *     80-85  4004   0.924   0.930    1.000
   *     85-90  7329   0.948   0.948    1.000
   *     90     7350   0.963   0.961    1.000
   *
   * The headline is that certainty was never justified: even a man who averages
   * a full ninety minutes gets substituted, sent off or injured before the hour
   * in about one start in twenty-seven. Averaged over all 23,158 starts the old
   * step overstated this probability by 3.3 percentage points, on a term that
   * every outfield player's floor is built from.
   *
   * Below 60 the fit is deliberately NOT pinned to the measurement. Only 171 of
   * the 23,158 rows are down there, they read ~0.82 against a fitted 0.61-0.74,
   * and raising a curve to meet 171 rows would be fitting noise on the exact
   * population — the hooked-at-halftime rotation player — where being wrong is
   * most expensive. The fit is left conservative there.
   */
  p60Curve: { intercept: -2.441, slope: 0.061 },
  /**
   * P(booked | he starts the match), by position. Not fitted — these are the
   * raw rates over every start in the four archived seasons, and they are the
   * only free quantity in the suspension term.
   *
   *          pooled    22-23   23-24   24-25   25-26      n
   *   GK     0.0762    0.076   0.078   0.079   0.072    2768
   *   DEF    0.1684    0.165   0.175   0.171   0.162   11412
   *   MID    0.1651    0.149   0.180   0.170   0.155   13246
   *   FWD    0.1118    0.117   0.117   0.111   0.104    3024
   *
   * Indexed by `element_type`, so the leading 0 is a placeholder.
   *
   * Deliberately NOT per-player. A dedicated hatchet man is booked far more
   * often than the positional average, but a player's own card count over a
   * partial season is a handful of events, and the shrinkage machinery that
   * would be needed to use it safely is a much larger change than the effect
   * being chased. The positional rate holds its shape across four seasons —
   * always GK lowest, FWD next, DEF and MID clear at the top — which is the
   * argument for using it. Its LEVEL is less settled than that ordering: GK and
   * FWD move by under a point season to season, DEF by 1.3 and MID by 3.1
   * (0.149 to 0.180, about +/-9% of the pooled figure). An earlier version of
   * this comment said "stable to about a point" for all four, which the table
   * directly above it contradicts for MID.
   */
  bookingRate: [0, 0.0762, 0.1684, 0.1651, 0.1118],
  /**
   * The Premier League's accumulation thresholds: `[cards, byTeamMatch]`.
   * Five bookings in the side's first 19 matches is a one-match ban; ten by
   * their 32nd is two matches; fifteen by the end of the season is three.
   * Verified against premierleague.com rather than taken from memory, and
   * re-checked for a fourth tier: there is no 20-card threshold in the Premier
   * League's own schedule, so this list is complete rather than truncated.
   *
   * All three are read, but each is priced as a ONE-match ban, so the deeper
   * two are deliberately understated. Measured over the four archived seasons,
   * three players a season reach ten inside the window and none has ever
   * reached fifteen, which is too thin to calibrate a longer ban against; see
   * `suspensionMissProbs`. The [15, 38] row is in fact inert as a window check —
   * the ban is served in match j+1, which must exist, so the trigger match is at
   * most 37 — and is kept for the shape of the rule rather than its effect.
   */
  banThresholds: [
    [5, 19],
    [10, 32],
    [15, 38],
  ] as [number, number][],
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
   * HOW THESE WERE MEASURED, because an earlier version of this comment was
   * wrong about it twice. The scoring set is the 60 club-seasons in 2023/24,
   * 2024/25 and 2025/26 that have a prior season to read, carry two or more
   * keepers on the GW1 list, and have at least one start between them. Every
   * figure below comes from calling THIS function through the real projection,
   * not from a Python replica of the scoring rule: the replica's evidence term
   * was not the same as this one — it took the age-weighted mean of each
   * season's total minutes, where this takes age-weighted minutes-per-game
   * times 38, and it skipped seasons a player was absent from where this counts
   * them as zeroes — and every headline number it produced was wrong, in both
   * directions. The target is each keeper's own realised start fraction, not
   * normalised within the club and not scaled by `slotMass`. Scaling the target
   * by `slotMass` grades the model against its own assumption; that was the
   * first error.
   *
   * The second was the window. This projects the next five gameweeks. Grading
   * it against `starts / 38` asks it a question about May that it never
   * answers, and the two windows do not agree — `slotMass` in particular is
   * justified by one and not the other. W=5 below means the fraction of GW1-5
   * started; W=38 means the season. Where they disagree, W=5 is the one that
   * governs, and it is said explicitly each time.
   *
   * Worth knowing before trusting any of it: picking a club's number one from
   * pre-season information alone is right 48 times in 60 over GW1-5, and 46 in
   * 60 over the season. Two earlier versions of this comment claimed 47/60 for
   * a configuration that really scores 44/60, which is the sort of thing a
   * replica does to you.
   *
   * What this whole block is and is not worth: it improves the pre-season
   * keeper ranking, and in all four archived seasons it drafts a byte-identical
   * squad. Nothing here has ever been shown to change a team sheet. It changes
   * which keeper the model would tell you to pick if you asked it, and the
   * evidence that it changes it for the better is the accuracy and calibration
   * below, not a points total. The simulator cannot see any of these constants:
   * across `beta` 1.2 to 3.0 and `slotMass` 0.85 to 0.95 the drafted squad is
   * identical in all four seasons and the Spearman moves inside .0018. That is
   * why they are fitted against the archive's realised starts, and it is also
   * the reason to be modest about all of it.
   */
  gkPreseason: {
    /**
     * Softmax sharpness over keeper scores within a club.
     *
     * Stays at 2.5, having survived a serious attempt to lower it. The attempt
     * is recorded because the reasoning was sound and the conclusion was not.
     *
     * The case for lowering it: at 2.5 the chart reads 0.806 on the keeper it
     * names number one, and that man goes on to start 0.639 of the season —
     * over-confident by +0.167. Brier against the season-long target falls
     * monotonically from .0710 at beta 3.5 to .0542 at beta 1.25. A chart that
     * picks right 46 times in 60 is not obviously entitled to read 0.81.
     *
     * Three things killed it. First, the over-confidence is not spread evenly:
     * split the 60 clubs into quartiles by how far apart the top two keepers'
     * SCORES sit, and the residual is worst in the smallest-gap quartile
     * (+0.286) — where the model's top-scoring keeper actually started FEWER
     * games than his rival, accuracy 0.33. No value of beta fixes a sign error.
     * Dropping 2.5 to 1.25 moves that quartile's mean prediction from 0.55 to
     * 0.52 and leaves the mistake exactly where it was.
     *
     * Second, the fault was locatable and fixable: it was `minutesWeight`, see
     * below. With that at 0 the chart reads 0.751 for a man who starts 0.760
     * over GW1-5 — a calibration gap of -0.009, from +0.092 — at beta 2.5,
     * untouched. Beta was absorbing a signal error, and retuning it would have
     * buried the error rather than fixed it.
     *
     * Third, on the horizon this actually projects the Brier surface is flat
     * between beta 1.25 and 2.0 (.0657 / .0642 / .0643 / .0653), which is
     * inside noise on 60 clusters. There was never enough there to justify the
     * change on its own.
     *
     * Beta is a monotone transform of the score, so accuracy does not move with
     * it at all — 46/60 at every value tried. Anything beta appears to buy is a
     * confidence statement, never a better pick.
     */
    beta: 2.5,
    /**
     * Weight on last season's minutes, on top of price in £m.
     *
     * ZERO, and this is the finding the rest of the block is organised around.
     * The term is left in the code rather than deleted so the measurement can
     * be reproduced by moving one number, and because `minutesCap` below is
     * only meaningful alongside it.
     *
     * The keeper's own career record, read through `preseasonEvidence`, makes
     * this chart WORSE at every weight tried, on every horizon, in every
     * partition of the sample:
     *
     *   minutesWeight     0     0.2    0.4    0.6    1.0    2.4
     *   Brier (W=5)     .0557  .0607  .0661  .0715  .0816  .0967
     *
     *   at minutesWeight   0        0.6 (was shipped)
     *   W=5   accuracy   48/60      46/60
     *         Brier      .0559      .0726
     *         gap        -0.009     +0.092
     *   W=38  accuracy   46/60      44/60
     *         Brier      .0528      .0670
     *         gap        +0.166 -> +0.105
     *
     * The two shipped-column Brier figures above read .0682 and .0633 until a
     * review re-derived them: they had been produced against a ONE-SEASON
     * record, while the live path reads the age-weighted MULTI-SEASON record
     * out of `preseasonEvidence`. On the code that actually runs they are .0726
     * and .0670. The w=0 column is unaffected — the record does not enter it —
     * so the correction only widens the margin the conclusion rests on, which
     * is exactly why it is worth stating rather than quietly patching: a
     * mistake that happens to favour the answer you already reached is the one
     * you are least likely to catch.
     *
     * The `gap` rows are the calibration fingerprint and are the reason this is
     * a signal problem rather than a tuning one. `gap` is mean predicted share
     * for the club's real number one minus his realised start fraction, so a
     * negative gap is under-confidence and a positive one over-confidence. At
     * W=5 the term flips a small under-confidence (-0.009) into a large
     * over-confidence (+0.092): it is not adding information and then needing
     * cooling, it is manufacturing certainty about the wrong keeper. Turning
     * `beta` down would move both columns together and cannot repair that.
     *
     * NINE SHAPES, 100+ CONFIGURATIONS, AND NONE OF THEM WORKS. Before settling
     * on zero the record was tried as: raw minutes, minutes per game, start
     * rate, a log of minutes, a cap-and-normalise, a rank within the club, a
     * difference against the club's best, a gate on the crowd being quiet, and
     * a two-sided version that could demote as well as promote. Sweeping each
     * across weights, the baseline at w=0 was at or above the best W=5 Brier of
     * EVERY shape at EVERY weight, and the two closest candidates collapsed
     * onto the baseline to four decimals once matched on confidence. There is
     * no version of "read the keeper's record" that pays here, which is a
     * stronger statement than "this particular version does not".
     *
     * The degenerate case the shapes were meant to rescue happens ONCE IN 60
     * CLUB-SEASONS. With price and ownership the whole score, two keepers who
     * are identical on both get an exact 50/50 — Brighton 2024/25, Steele and
     * Verbruggen, both GBP 4.5m, both 0.5% owned. And there the coin flip was
     * nearly right: the realised GW1-5 split was 2 starts to 3, so a 50/50
     * scored a Brier of about 0.01 on the single club-season where the
     * pathology bites. A rescue worth 0.01 on one club-season is not worth
     * .0167 of Brier on the other 59.
     *
     * Paired clustered bootstrap over the 60 club-seasons, 50k resamples:
     * ΔBrier -0.0105 at W=5, CI [-0.0219, -0.0011]; -0.0093 at W=38, CI
     * [-0.0174, -0.0027]. Leave-one-season-out prefers 0 on the held-out season
     * in 3 of 3 at W=38 and 2 of 3 at W=5, the exception losing by .0008.
     *
     * It is not a disguised beta reduction. Matching configurations on
     * confidence — picking, at each weight, the one whose mean predicted share
     * is nearest 0.78 — accuracy still falls monotonically (48, 47, 46, 46, 46,
     * 43 of 60) while Brier rises (.0568 to .0991). Accuracy is invariant to
     * beta and to any monotone rescaling, so this is a signal problem and not a
     * temperature problem.
     *
     * WHY, which is the part worth keeping. Last season's minutes back the
     * OUTGOING incumbent. The four picks that flip when the term is removed:
     * West Ham 2023/24 backed Fabianski's 3111 prior minutes over Areola, who
     * started 0.82; Palace 2023/24 backed Guaita's 2430 over Johnstone, who
     * started 0.53; United 2025/26 backed Onana's 3060 over Bayindir. Three
     * right, one wrong (Brighton 2024/25, where Verbruggen was correct and the
     * chart now prefers Steele). The rest of the gain is deconfidencing men who
     * had lost the shirt by August: Lloris predicted 0.73 and started 0.00,
     * Ederson 0.90 and 0.00, Neto 0.87 and 0.05. This is the same failure the
     * `priorPStartOwnWeight` comment describes for outfield players — the
     * record was not wrong, it was answering a question about a situation that
     * no longer existed — and at keeper it is fatal rather than merely costly,
     * because a keeper who has lost his place plays nothing at all.
     *
     * The obvious rescue was tested and does not work. "Let the record speak
     * only where the crowd is silent" predicts the term should help in
     * crowd-quiet clubs. It does not: partitioning by how far apart the crowd
     * puts the club's keepers, Brier rises with this weight in BOTH halves
     * (quiet, n=21: .0731 -> .0882; loud, n=39: .0463 -> .0571). Explicit
     * gating was implemented and measured seven ways, and not one variant beat
     * a flat zero at either horizon. An ORACLE that picks the best weight per
     * club in hindsight — an upper bound on any implementable rule — buys
     * .0040 of Brier and one club. There is nothing there to capture.
     *
     * Silence does not make this signal correct. It only removes the crowd,
     * which was the thing overruling it: Palace and United above are both
     * crowd-quiet clubs, and both are cases where the record is wrong.
     */
    minutesWeight: 0,
    /**
     * Minutes above this add nothing — a full season is a full season. Inert
     * while `minutesWeight` is 0, and kept for whoever revisits that. Swept at
     * the old weight it never earned its range: Brier at W=5 was .0643 / .0658
     * / .0682 / .0668 / .0618 for caps of 800 / 1200 / 2000 / 3420 / 6000, so
     * both ends beat the middle and the setting that gives the term the most
     * discriminating power was the worst one. That is the shape of a term
     * carrying no signal, and it is the first place the finding above showed up.
     */
    minutesCap: 2000,
    /**
     * Weight on where the crowd has put the keeper in the ownership order,
     * added in the same units as price. See `priorPStartOwnWeight` for why
     * ownership is worth reading at all; a depth chart is where it is worth
     * the most, because "who is the number one" is precisely the question a
     * million managers spend pre-season answering and precisely the one price
     * answers worst. Two keepers at a promoted club arrive at £4.5m each.
     *
     * With `minutesWeight` at 0 this and price are the whole score. Measured
     * over the 60 club-seasons:
     *
     *   ownWeight       0.75    1.0    1.25    1.5     2.0
     *   W=5  accuracy   49/60  48/60  47/60  48/60   48/60
     *        Brier      .0599  .0571  .0559  .0559   .0579
     *        gap        -.095  -.052  -.012  -.009   +.017
     *   W=38 accuracy   47/60  46/60  45/60  46/60   47/60
     *        Brier      .0511  .0504  .0512  .0528   .0571
     *        gap        +.018  +.061  +.095  +.105   +.127
     *
     * The two windows disagree and W=5 decides, because W=5 is what leaves this
     * function. At 1.5 the chart is at the Brier minimum for that window and
     * very nearly perfectly calibrated (-0.009). Dropping to 1.0 costs .0012 of
     * Brier, which is noise, and moves the calibration gap to -0.052 — the
     * model would begin systematically under-selling its own pick by five
     * points of start share. Bootstrap puts the probability that 1.0 has the
     * smaller absolute gap at 0.244.
     *
     * It was tempting to take 1.0 anyway, because it turns the ceiling
     * assertion in `preseason.test.ts` green without argument. That is fitting
     * a constant to a bar this repo set for itself, and the bar was wrong — see
     * that test. Leave-one-season-out picks 1.0, 2.0 and 1.25 on the three
     * held-out seasons at W=5, which is to say it picks nothing; the surface is
     * flat between 1.0 and 1.5 and the data does not choose. Calibration does.
     *
     * Whether it is really the crowd doing the work: 5 of the 7 picks the term
     * newly gets right are same-price pairs, where price cannot speak at all.
     * Where price already decides, it adds +2 of 39. It is not double-counting
     * price. But it is not a small voice either — the median crowd-term gap
     * inside a club is 0.602 against a median price gap of 0.50, and with the
     * minutes term gone those two are now the entire score, so this is the
     * loudest thing in the function.
     *
     * The curve is `priorPStartOwnGamma`, deliberately reused rather than given
     * its own constant, and the reason is not that the shape does not reach
     * inside a club — an earlier version of this comment argued that, and it is
     * backwards. What `q^gamma` does here is scale CONFIDENCE by league
     * position: two keepers separated by the same ownership distance are spaced
     * far apart near the top of the league's keeper order and pressed together
     * near the bottom. That is the desired behaviour, because the crowd's
     * opinion of who keeps for a title contender is worth more than its opinion
     * of who keeps for a newly promoted club. The alternative was tested — a
     * club-relative crowd term, which normalises the gap within the club and so
     * discards exactly that scaling. It measures better offline and worse in
     * the simulator (.6303 and .6283 against .6315), which is the clearest
     * evidence available that the league-wide curve is carrying something the
     * club-level score cannot see. Rejected on that basis, not on a decimal.
     */
    ownWeight: 1.5,
    /**
     * Total share of starts the club's keepers divide between them. Below 1
     * because cups, knocks and rotation take the shirt off the number one, and
     * because a keeper who was not on the GW1 list sometimes takes it: a
     * mid-season signing, a loan, an academy call-up.
     *
     * 0.95 is right for the five gameweeks this projects, and is NOT the
     * season-long figure. Measuring the fraction of a club's league games
     * started by keepers who were on that club's GW1 list:
     *
     *   window    GW1    1-3    1-5    1-10   1-19   1-38
     *   coverage  1.000  .983   .963   .942   .920   .883
     *
     * An earlier version of this comment quoted 0.9364, "exactly 1.0 for 50 of
     * the 60 clubs", and that number is an artefact worth remembering. It came
     * from grouping the end-of-season `players_raw.csv` by `team_code`, which
     * is the player's club in MAY: a keeper who moved in January carries his
     * new club's code together with his old club's starts. Contamination is
     * +0.053, concentrated in seven clubs — Arsenal 2023/24 reads 1.000 against
     * a true 0.158, because Raya arrived on loan from Brentford — and it is
     * self-evidently broken, since Arsenal 2024/25 came out at 1.053 and a
     * coverage figure above 1.0 is impossible. Counted properly, from round-1
     * `merged_gw` rows using that week's club, the season figure is 0.883 with
     * 46 of 60 clubs at exactly 1.0.
     *
     * The Brier surface agrees with the horizon reading: at W=5 it is .0590 /
     * .0570 / .0559 / .0557 across 0.85 / 0.90 / 0.95 / 1.00, flat with its
     * optimum at 0.95-1.00, while at W=38 it falls monotonically toward 0.85.
     * Two windows, two answers, and the projection's own horizon picks 0.95.
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
  /**
   * How much of the pre-season start prior comes from where the crowd has put
   * its money rather than from where the club has put its price tag.
   *
   * `selected_by_percent` was already fetched, already displayed, and never
   * once read by this file. It is the only field on the bootstrap that carries
   * information generated AFTER last season ended: five weeks of pre-season
   * friendlies, of announced transfers, of a manager saying in a press
   * conference that a player is not in his plans. Every other input here is
   * either last season's record or a price set in June.
   *
   * That matters because the model's characteristic failure is a
   * discontinuity. Of the launch picks that finished a season under 1000
   * minutes, nine of ten had a prior season of 2339+ minutes and 29+ starts —
   * the record was not wrong, it was answering a question about a situation
   * that no longer existed. Bucketing four archived seasons by prior-season
   * minutes and then, WITHIN each bucket, by GW1 ownership percentile:
   *
   *   prior mins    own pct 0-.25   .25-.5   .5-.75   .75-.9   .9-1
   *     >= 2500          1817        2073     2554     2335     2647
   *     1500-2500        1385        1363     1814     1939     2087
   *      500-1500         675        1127     1056     1271     1527
   *      < 500            102         262      322      544      814
   *
   * (this season's minutes, mean). Monotone in every row, and steepest where
   * the record is thinnest — which is precisely the shape of a prior, and the
   * reason this enters as a prior on P(start) and not as a multiplier on
   * points. A crowd that likes a player is not evidence he will score; it is
   * evidence that somebody has seen him named in a pre-season XI.
   *
   * The weight was swept over the four archived seasons —
   * `OWNW=<w> OHI=<hi> OGAMMA=<g> RANK=1 POOL=1 SEASON=<s> npx vitest run -c
   * vitest.sim.config.ts` — jointly with the shape of the map it is applied to,
   * because a weight sweep on its own cannot tell "the crowd is worth less"
   * from "the curve is wrong". Spearman of projected xP against what players
   * actually went on to score, means over the four seasons (n ≈ 573-690 each).
   * Weight, at the shipped shape:
   *
   *   OWNW        0     0.25     0.4      0.5     0.6     0.75      1
   *   all      .5927   .6182   .6242   .6272   .6292   .6238   .6085
   *   cheapR   .5328   .5680   .5755   .5790   .5815   .5725   .5500
   *   nonR     .4555   .5108   .5150   .5168   .5185   .5102   .4675
   *   topR     .4097   .4235   .4290   .4327   .4377   .4455   .4560
   *   priceR   .5145   .5145   .5145   .5145   .5145   .5145   .5145
   *
   * Gamma, at w = 0.5:
   *
   *   OGAMMA    1.35     1.8     2.2     2.6     3.0     3.5     4.5     6.0
   *   all      .6218   .6248   .6265   .6272   .6270   .6265   .6245   .6208
   *   cheapR   .5765   .5765   .5783   .5790   .5793   .5782   .5753   .5705
   *   nonR     .5115   .5157   .5162   .5168   .5170   .5160   .5117   .5048
   *
   * `nonR` is players with no previous season at all, where the prior is doing
   * all of the work; `topR` is the price-dominated band and is the one series
   * that keeps climbing to w = 1, which is not a reason to go there — it is
   * 60-odd players a season against 600. `priceR` is the control: price is not
   * touched by any of this and does not move by a digit, so the movement above
   * is the projection's and not the harness's.
   *
   * Two of those numbers were chosen against the metric rather than with it,
   * and both deserve saying out loud. w = 0.6 scores higher on every
   * correlation than the 0.5 that ships (.6292 vs .6272) — and drafts squads
   * that start LESS: 1046 starts against 1104 over the three seasons whose
   * `starts` column is trustworthy, with flops up from 7 to 9. Getting real
   * starters into the fifteen is the point of the exercise, so a starts
   * diagnostic that moves by 58 outranks a correlation that moves by .0020.
   * Likewise the market top: pushing it from 0.7 to 0.9 buys .6272 -> .6280,
   * almost all of it in `topR`, but 0.7 is what the archive's start rates
   * actually say (below) and .0008 is well inside the season-to-season spread.
   * Fitting the range to the metric it is scored by would be fitting twice.
   *
   * What is NOT claimed: the auto-drafted XV barely moves. Squad season points
   * over the four seasons go 6315 -> 6437, set-and-forget 6496 -> 6529, managed
   * 8805 -> 8682. Those are single squads, they swing by hundreds on which
   * premium stayed fit (2022-23 alone runs 1538/1908/1611/1614/1484/1810/1720
   * across the seven weights, with no trend in it at all), and they disagree in
   * sign with each other — managed goes DOWN while the other two go up. The
   * starts diagnostic moves 1094 -> 1104 with `squadRegulars` and `squadFlops`
   * unchanged, and 2024-25 drafts a byte-identical XV at every weight. So: the
   * ordering of 600 players improves consistently and measurably, and the
   * fifteen that get picked out of it do not visibly change. Both halves of
   * that are the record.
   *
   * And one thing the sweep could not see at all: the backtest harness sets
   * `penalties_order: null` and never populates any set-piece order field, so
   * `setPieceStartFloor` returns 0 for every player in every run above. In the
   * live game it fires for something like 60-100 players — exactly the ones
   * whose start probability is least in doubt. Every figure in these tables is
   * therefore measured with the floor switched off, and how the floor and this
   * prior interact is untested by anything here.
   *
   * Neither this weight nor `priorPStartOwnGamma` is pinned by a test, and no
   * test should pretend to pin them: every value in (0, 1] gives the same
   * behaviour the tests assert (more owned -> higher prior, ties equal, rank
   * not percentage), so a test that failed on 0.6 would be pinning an
   * arithmetic accident rather than a property. The tables above are what
   * justify the numbers; the tests guard the shape.
   */
  priorPStartOwnWeight: 0.5,
  /**
   * Market-implied P(start) at the bottom and top of a position's ownership
   * order, with the curve between them. Read off the same archive: the least
   * owned quarter of a position averages about 4 starts of 38 and the top
   * decile about 25, so the range is roughly [0.1, 0.66] and slightly convex.
   * The top is deliberately NOT `priorPStartRange`'s 0.9 — the most owned
   * players in a position still lose weeks to injury, and 0.9 would be
   * claiming the crowd can see that coming.
   */
  priorPStartOwnRange: [0.08, 0.7] as [number, number],
  /**
   * Convexity of the curve between those two ends. 2.6, not the 1.35 this
   * shipped with, and the correction is worth more than the tuning: at 1.35 the
   * curve ran roughly 0.10 high across the whole upper half of the ownership
   * order, because `oLo` and `oHi` were read off the archive as BUCKET MEANS
   * (bottom quarter, top decile) and then installed as the values at percentile
   * 0 and 1. A bucket mean sits at the middle of its bucket, so pinning it to
   * the edge stretches everything between. Bending the curve is the cheap fix;
   * it peaks at 2.6 and falls away by 4.5 (table above), so this is a maximum
   * rather than a ramp that was stopped somewhere convenient.
   */
  priorPStartOwnGamma: 2.6,
  /** Minutes per start assumed for a player with no last-season record. */
  preseasonUnknownMinsPerStart: 80,
  /**
   * The first season, by the leading year of its name, whose `history_past` row
   * carries a real `starts` figure.
   *
   * `impliedStarts` has always meant to impute starts from minutes when FPL did
   * not record them, and `fetchPastSeason` says so out loud ("Absent is NOT
   * zero: a 3000-minute 2020/21 season read as '0 starts' would rate the player
   * below someone who has never played at all"). Both were guarding against
   * `null`. The API does not send `null` — it sends `0`. Counted over the
   * element summaries in the 2026/27 snapshot:
   *
   *     season     rows   starts > 0   starts == 0 with minutes > 0
   *     2019/20     105            0                             92
   *     2020/21     146            0                            121
   *     2021/22     168            0                            145
   *     2022/23     233          186                             12
   *     2023/24     277          226                             17
   *     2024/25     347          294                             24
   *     2025/26     454          369                             35
   *
   * The break is total and it is at 2022/23: not one row of 2021/22 or earlier
   * reports a start, and from 2022/23 on the field behaves normally (the
   * remaining zeros there are genuine substitutes). So a zero on an older row
   * is missing data and a zero on a newer one is a fact, and only the season
   * name can tell them apart — which is why this is a year and not a
   * minutes threshold. A threshold would have to decide that a 400-minute
   * substitute in 2024/25 secretly started five games.
   *
   * Who this was costing: a player whose Premier League career ended before
   * 2022/23 and who is back via a promoted club. Targett (HUL) is the case, and
   * his record is a clean instance of the defect — 3404 minutes in 2020/21 and
   * 2871 in 2021/22, every one of them reported with `starts: 0`, then 697
   * minutes across the three recorded seasons since. He came out of the broken
   * model at `pStart` 0.031 and comes out of the fixed one at 0.090.
   *
   * ON "CREDITED MINUTES", because an earlier version of this paragraph quoted
   * 6295 of them and an audit could not reconstruct the figure from anything.
   * It cannot: his career total is 12280, the total inside the recorded-starts
   * window is 697, the decay-weighted total the model actually leans on is 656,
   * and `PastSeasonStats.minutes` — last season only — is 20. 6295 is none of
   * these and matches no combination anyone has been able to name. A quantity
   * that cannot be pointed at in the code is not a measurement, so it is gone
   * rather than adjusted, and the four readings above are printed side by side
   * by `scripts/preseasonBrier.test.ts` with `LIVE=1` precisely so the next
   * person does not have to guess which one a number in this file means.
   *
   * AND THE CLUB-LEVEL DAMAGE IS SMALLER THAN THIS PARAGRAPH USED TO CLAIM.
   * The old text put Ipswich at 5.76 of the 9.6 it should and Hull at 6.16.
   * Neither figure reproduces in any regime, and the ordering is backwards in
   * all of them: Hull is the club Targett plays for, so Hull is the club the
   * defect hurts most. Measured on the raw sums with `clubStartMass` switched
   * off, all outfielders, defect restored -> fixed: HUL 4.52 -> 5.04, COV
   * 4.86 -> 4.86, IPS 6.00 -> 6.06. So the fix is worth half a start to Hull,
   * a rounding error to Ipswich, and nothing at all to Coventry, whose
   * record-less players are record-less for the ordinary reason rather than
   * this one.
   *
   * The mechanism downstream is still the reason it matters — `clubStartMass`
   * hands a club's missing start mass to whoever has no record at all, so an
   * understated deficit is not a wash, it is a transfer from the returning
   * regular to the unknown next to him. But the transfer is worth tenths, and
   * saying so is the difference between a documented measurement and a
   * remembered impression.
   */
  startsRecordedFrom: 2022,
  /**
   * Outfield starts a club hands out per match: eleven shirts minus the
   * keeper's. Pre-season, a club short of this has its outfielders' `pStart`
   * lifted TOWARD it — see `clubStartMass` for the mechanism and for why only
   * the players with NO Premier League record absorb the difference.
   *
   * TOWARD, NOT TO. This comment used to say the sum is "made to sum to at
   * least this", which is false, and then it blamed the wrong thing for making
   * it false. All figures below are the LIVE 2026/27 SNAPSHOT, ALL OUTFIELDERS,
   * regenerated by `scripts/preseasonBrier.test.ts` with `LIVE=1`:
   *
   *     mechanism off ............ 12 of 20 clubs short
   *     mechanism on, ceiling and clamp off ...  3 short: FUL 7.65 BOU 8.48 EVE 9.59
   *     shipped .................................  3 short: FUL 7.65 BOU 8.06 EVE 8.75
   *
   * THE COUNT IS THREE ON BOTH SIDES OF THE RECORD-LESS RULE. The old text
   * attributed the shortfall to `preseasonRecordlessMaxPStart` arriving, and
   * the arithmetic refuses: the mechanism closed 12 clubs down to 3 before that
   * constant existed and closes 12 down to the same 3 with it. What the rule
   * changes is the DEPTH of two of the three shortfalls (BOU 8.48 -> 8.06, EVE
   * 9.59 -> 8.75), not whether they exist.
   *
   * The real reason "at least" was never true is FUL, which sits at 7.65 under
   * every one of the three settings including the mechanism at full strength.
   * Fulham is short and has nobody record-less to lift, so there is no one for
   * the deficit to be allocated to and no ceiling involved in refusing it. A
   * club whose record-less players all hit the 0.55 ceiling is the SECOND way
   * to be left short — real, and what BOU and EVE show — but it is the smaller
   * effect and it is not the one that broke the invariant.
   *
   * (On the archive the shipped setting leaves 2024/25 with one club at 9.11
   * and 2025/26 with three at 8.47, 8.72 and 9.52; `FINAL=1` prints those.)
   *
   * Either way the trade is intended: the target is an accounting identity, but
   * it is not evidence about any particular player, and it is not worth
   * manufacturing a near-nailed starter out of nothing to make the books
   * balance.
   *
   * THE SWEEP. Run `scripts/preseasonBrier.test.ts` with `MASS_SWEEP=1`.
   * Protocol: through `projectAll` at the GW1 state, scoring the stored
   * `pStart` against realised "started" per player-gameweek over GW1-5, launch
   * pool, outfield, pooled over 2023/24-2025/26, n = 5680. Paired bootstrap,
   * 4000 resamples clustered on club-season, against the shipped target.
   *
   *     target   Brier   Brier(no)   23-24  24-25  25-26   vs 9.6 [95% CI]
   *      0      .19719    .19811     .2002  .1911  .2001   +.00141 [+.00011, +.00294]
   *      7.0    .19684    .19607     .2002  .1901  .2001   +.00106 [-.00002, +.00222]
   *      7.5    .19665    .19495     .2001  .1898  .2000   +.00086 [-.00013, +.00193]
   *      8.0    .19631    .19299     .1997  .1894  .1996   +.00053 [-.00033, +.00144]
   *      9.0    .19576    .18979     .1990  .1888  .1993   -.00003 [-.00066, +.00066]
   *      9.5    .19581    .19012     .1986  .1889  .1998   +.00003 [-.00018, +.00026]
   *      9.6    .19578    .18995     .1986  .1888  .1999    baseline
   *     10.0    .19588    .19052     .1984  .1888  .2003   +.00010 [-.00041, +.00059]
   *     10.5    .19669    .19520     .1981  .1903  .2015   +.00091 [+.00005, +.00181]
   *     11.0    .19781    .20167     .1986  .1926  .2022   +.00202 [+.00074, +.00338]
   *
   * READ THE CONFIDENCE INTERVALS, NOT THE FOURTH DECIMAL. Every target from
   * 7.0 to 10.0 is statistically indistinguishable from 9.6. What the data
   * actually separates is the two ends: switching the mechanism OFF is
   * measurably worse (+.00141, CI clear of zero), and pushing the target to
   * 10.5 or beyond is measurably worse (+.00091, +.00202). Between those the
   * sweep is a plateau, and 9.0 being the numeric argmin by .00002 is noise.
   *
   * THIS TABLE REPLACES ONE THAT REPRODUCED IN NO REGIME AT ALL, and the
   * corrections are not cosmetic — the old text drew conclusions the numbers
   * now refuse. It read:
   *
   *     target    0    7.0   7.5   8.0   9.0   9.5   9.6  10.0  10.5  11.0
   *     Brier  .2019 .1980 .1972 .1970 .1967 .1972 .1975 .1989 .2024 .2055
   *
   * and around it, four claims that are all false on measurement. (a) "Ten
   * sits on the rising edge and gives back .0022 of the .0030 the mechanism is
   * worth" — the mechanism is worth .00141, ten gives back .00010 of it, and
   * ten is inside the plateau. (b) "The sweep's own optimum is 9.0, and 9.0 is
   * NOT what ships, because it loses in 2025/26 taken alone" — 9.0 WINS in
   * 2025/26 (.1993 against 9.6's .1999). (c) "At 9.6 the mechanism wins in
   * each of the three seasons separately (.2017 / .1867 / .2039 against 10's
   * .2029 / .1895 / .2043)" — against 10, 9.6 loses 2023/24, ties 2024/25 and
   * wins 2025/26, and none of those six figures reproduce. (d) "a paired
   * bootstrap puts 9.6 against 10 at -0.00146 [-0.00277, -0.00041]" — it is
   * +0.00010 [-0.00041, +0.00059], which crosses zero. The population was also
   * quoted as n = 5619 where every other table on the identical protocol says
   * 5680; 5680 is right. None of this was checkable before `MASS_SWEEP=1`
   * existed, which is the actual lesson: the table had no apparatus behind it.
   *
   * THE MECHANISM IS WORTH NOTHING WITHOUT THE RECORD-LESS CEILING, which the
   * old block never measured and which changes how this constant should be
   * understood. `MASS_SWEEP=1` prints a second table with the record-less
   * ceiling and clamp lifted, isolating the club-accounting rule:
   *
   *     target   Brier                    vs 9.6 [95% CI]
   *      0      .19786                   -.00082 [-.00293, +.00103]
   *      7.5    .19779                   -.00088 [-.00296, +.00092]
   *      9.0    .19835                   -.00032 [-.00121, +.00050]
   *      9.6    .19867                    baseline
   *     10.0    .19960                   +.00093 [+.00007, +.00196]
   *     10.5    .20130                   +.00263 [+.00091, +.00469]
   *     11.0    .20408                   +.00541 [+.00297, +.00832]
   *
   * The point estimate at 9.6 is .00081 worse than switching off, and the
   * interval on that comparison crosses zero — so state it as "buys nothing",
   * NOT as "is harmful", which is what an earlier draft of this paragraph said
   * and is more than the CI supports. (Writing that draft twenty lines under a
   * heading reading READ THE CONFIDENCE INTERVALS is the reason this note
   * exists.) What the isolated table separates is only the upper end: at 10.0
   * and above the uncapped rule is measurably worse than at 9.6.
   *
   * The conclusion survives the weaker reading. Club accounting on its own is
   * indistinguishable from not doing it at all, anywhere in 0-9.6; the +.00141
   * in the first table is therefore not the value of club accounting, it is
   * the value of club accounting AND a ceiling on who may absorb it, and
   * neither half delivers it alone. Uncapped, allocating a club's deficit
   * inflates unknowns into near-nailed starters and gives back on them what
   * the club-level correction gains. Changing `preseasonRecordlessMaxPStart`
   * therefore invalidates this sweep, and vice versa.
   *
   * WHY THE SHIPPED VALUE IS 9.6 AND WHY IT IS NOT A FITTED NUMBER.
   * Ten outfielders start every match; that is an identity and it is not in
   * doubt. But the identity this mechanism can act on is not the whole of it,
   * because the mechanism can only allocate over the element list it can see
   * at the deadline, and some of those ten shirts go to players who are not on
   * it yet. Run `scripts/preseasonBrier.test.ts` with `SHIRT_COUNT=1`. Starts
   * per club-match over GW1-5, denominator counted off distinct fixture ids in
   * the graded rounds:
   *
   *     season   club-matches   ALL out   ALL gk   visible out   visible gk
   *     2023-24       98         10.000    1.000     10.000        1.000
   *     2024-25      100         10.000    1.000      9.620        0.900
   *     2025-26      100         10.000    1.000      9.440        0.980
   *     POOLED       298         10.000    1.000      9.685        0.960
   *
   * THE CONTROL COLUMNS ARE THE POINT. Counted over ALL players the method
   * returns 10.000 and 1.000 to three decimals in every season, which are the
   * two identities, so the instrument is measuring what it claims to. The test
   * asserts on both; if either drifts, the visible columns mean nothing.
   *
   * The visible outfield count is 9.685 pooled, and the visible GOALKEEPER
   * count is 0.960 against a known 1 — the same 3-4% invisibility showing up
   * on a quantity where the true answer is known independently. So the
   * residual is real and it is roughly a twentieth of a shirt per club-match.
   * Read 2023-24 as an artefact, not evidence: its element list is the
   * unfiltered end-of-season dump (see `team_join_date` in the harness), so
   * every starter is on it BY CONSTRUCTION and 10.000 is what that season
   * must return. On the two seasons whose list is a genuine GW1 one the
   * visible count is 9.620 and 9.440, and at the clubs this rule actually
   * reaches, 9.400 and 9.236.
   *
   * So 9.6 is the visible part of the ten-shirt identity: at the top of the
   * range the two honest seasons give and just under the pooled 9.685.
   *
   * (Every figure in this paragraph replaces one that had no apparatus behind
   * it and did not reproduce: 9.775 pooled, 9.597 at reached clubs, 9.43 at
   * clubs short by a full start, and a 0.993 goalkeeper control. The last was
   * the load-bearing one — a control that lands on 0.993 says the residual is
   * measurement noise and the target should be 10, and the true 0.960 says
   * the residual is real. The old numbers were also mutually inconsistent
   * with `preseason.test.ts`, which attached 9.597 to the pooled population
   * rather than to the reached clubs.)
   *
   * AND THE SWEEP IS WHAT LICENSES TAKING THAT NUMBER RATHER THAN FITTING ONE.
   * This is the argument the old text tried to make out of a false table and
   * got backwards; the true table makes it more cleanly. The sweep does not
   * separate anything between 7.0 and 10.0, so there is no fitted value to
   * prefer — choosing the argmin here would be choosing noise, and the .00002
   * that separates 9.0 from 9.6 is exactly that. What the sweep DOES establish
   * is a corridor: the mechanism has to be on, and the target has to stay
   * under about 10.5. 9.6 is the football number and it sits inside the
   * corridor with room on both sides, which is the most a sweep of this power
   * can say for any value in it. Set to 0 to switch the mechanism off.
   *
   * A SHARPER ALLOCATION WAS TRIED HERE AND REFUTED. The motivating reading
   * was that the total is fine and the SHAPE is wrong: real clubs concentrate
   * ten shirts on thirteen or fourteen men, while this rule spreads the
   * deficit proportionally across every record-less outfielder, including
   * squad filler and youth who will not play at all. The descriptive half of
   * that is true — the top five record-less players hold 0.533 of the
   * predicted mass against 0.638 realised — but the conclusion drawn from it
   * is backwards.
   *
   * CAVEAT, AND IT APPLIES TO EVERY FIGURE IN THE REST OF THIS PARAGRAPH. The
   * decomposition below was run against a "9-to-10 damage" that the corrected
   * sweep above no longer finds: 9.6 to 10.0 is +.00010 [-.00041, +.00059],
   * which crosses zero, so there is no damage left to apportion and shares of
   * it cannot mean what they meant when this was written. The shape harness
   * (eighteen shapes over fourteen targets) is also not checked in and cannot
   * be re-run, so unlike the sweep above these numbers could not be corrected,
   * only flagged. They are kept because the CONCLUSION is unaffected and is
   * the part that matters operationally — proportional was never beaten by any
   * concentrating shape, on any target, and the bootstrap cleared none of
   * them, so nothing here argues for changing the rule. Treat the table as a
   * record of what was tried, not as a live measurement, and re-derive it
   * before building anything on it.
   *
   * Cutting the 9-to-10 damage by within-club rank (ranked ex ante, because
   * ranking by realised starts would be circular) put 113% of it in ranks 1
   * and 2 and about 8% in ranks 7 and below:
   *
   *     rank      n    p@9   p@10    obs   share of damage
   *     1        53   .497   .612   .536       +6.39
   *     2        36   .398   .490   .388       +7.70
   *     3-6      58   .368   .414   .437       -2.59
   *     7-14     50   .333   .372   .312       +0.64
   *     15+      28   .207   .232   .159       +0.34
   *
   * The head is already over-predicted at 10 (rank 1: .601 against .502
   * observed), so sharpening drives the wrong players further wrong. Eighteen
   * shapes were swept over fourteen targets — top-N-only, powers of
   * `priorPStart`, and caps on how many players may receive lift. At target 10
   * the best of all eighteen is the shipped proportional rule, and every
   * concentrating shape's own optimum moves DOWN to 7.5-8.0 rather than up
   * toward 10. A paired bootstrap clears none of them (top-16 at 10 against
   * proportional at 10: -0.00000 [-0.00097, +0.00113]), and under
   * leave-one-season-out the freely chosen shape never beats the proportional
   * rule held out. The tail is nearly free; there is nothing to win here.
   *
   * WHY IT IS NEEDED. `priorPStart` maps a player onto the LEAGUE-WIDE price
   * and ownership order, and a promoted club's entire XI sits at the bottom of
   * that order. Measured with the mechanism off, across the three seasons with
   * a prior season on the archive, the sum of `pStart` over a promoted club's
   * outfielders came to 5.50-8.56 (the nine promoted club-seasons in the table
   * below) against the ten the league actually gives every club alike. The
   * model was giving a promoted club six or seven outfield starters
   * where the league gives it ten, so every player at that club was marked
   * down: over GW1-5 the promoted clubs' pool players were predicted 0.194,
   * 0.245 and 0.227 against a realised 0.347, 0.426 and 0.434 — gaps of
   * -0.153, -0.181 and -0.208 on n = 53, 46 and 47. Nought of them was ever
   * drafted, in any of the three seasons, with the mechanism on or off.
   *
   * It is NOT a "promoted club" rule and deliberately does not look for one.
   * `strength` does not identify promotion — Wolves were a 2 in 2025/26
   * without being promoted and Leeds and Sunderland were 3s with — and the
   * clubs that need the correction are not only the promoted three. An earlier
   * version of this comment put an established club at 10.5-11.2 and offered
   * Bournemouth 2023/24, at 6.09 with 21 record-less players in a 29-man list,
   * as the one counter-example. Every number in that sentence was wrong —
   * Bournemouth summed to 8.45 with 5 record-less players in 29, and were 8th
   * lowest of 20, not the shortest — and the framing was wrong with them,
   * because established clubs do not sit above the target as a class.
   *
   * THE REPLACEMENT NUMBERS WERE WRONG TOO, which is why the tables below are
   * now printed by the harness on every default run rather than transcribed.
   * A second audit checked the twenty-club table this paragraph used to carry
   * for 2023/24 and found that not one of the twenty values reproduced in any
   * regime; the summary line the harness did print (min, median, max) had
   * agreed, which is exactly consistent with seventeen wrong numbers between
   * them. `scripts/preseasonBrier.test.ts` now prints the full per-club list.
   * With the mechanism off, all outfielders:
   *
   *     2023-24  short 4/20   SHU 7.26  BUR 7.72  LUT 8.56  EVE 9.60
   *              WOL 9.76  BOU 9.93  NFO 10.27  CRY 10.55  BHA 10.70
   *              WHU 10.75  BRE 11.25  MCI 11.55  AVL 11.88  LIV 11.93
   *              MUN 12.10  FUL 12.30  NEW 12.67  TOT 13.00  CHE 13.31  ARS 13.32
   *
   *     2024-25  short 10/20  IPS 5.50  LEI 7.38  SOU 8.13  FUL 8.36
   *              WOL 8.72  NFO 8.78  CRY 8.83  BOU 9.08  EVE 9.49  MUN 9.54
   *              CHE 9.83  BHA 9.89  LIV 10.02  BRE 10.27  AVL 10.52
   *              ARS 11.05  NEW 11.32  TOT 11.72  WHU 11.80  MCI 12.10
   *
   *     2025-26  short 11/20  SUN 7.02  WOL 7.34  BUR 7.54  LEE 7.71
   *              BRE 7.76  EVE 7.89  BOU 8.54  CRY 8.60  NFO 9.40  FUL 9.52
   *              WHU 9.54  AVL 9.73  NEW 10.04  BHA 11.01  CHE 11.25
   *              LIV 11.62  MUN 11.84  MCI 12.16  TOT 12.34  ARS 12.35
   *
   * 2023-24 IS NOT COMPARABLE TO THE OTHER TWO and its 4/20 should not be
   * averaged in. That season's element list is the unfiltered end-of-season
   * dump, so January signings inflate every club's sum and suppress the count
   * — which is the whole reason the `team_join_date` filter exists.
   *
   * The point survives on the two comparable seasons and is now stronger than
   * the version built on the false table. Established clubs do not sit above
   * the target as a class: of the 25 short club-seasons above, 16 belong to
   * established clubs and only 9 to the promoted three. Wolves are short in all three (9.76, 8.72, 7.34 — not
   * short in 2023/24, but that season under-counts everyone), Everton in
   * 2024/25 and 2025/26 (9.49, 7.89), Crystal Palace and Forest and
   * Bournemouth in both filtered seasons. None is anywhere near promotion.
   * The conclusion outlived its example, and on better evidence than the
   * example gave it: what the correction keys on is
   * the thing that actually causes the shortfall, which is how much start
   * probability a club's own squad has failed to account for, and that is a
   * property of squads and not of promotion.
   */
  preseasonClubStartMass: 9.6,
  /**
   * WHO absorbs a club's missing start mass: only the players with no Premier
   * League record (`"recordless"`), or every outfielder in proportion to what
   * `priorPStart` already gave him (`"all"`).
   *
   * This exists as a knob because the doc block on `clubStartMass` used to
   * record a measurement that DISAGREED with what ships and closed by saying
   * "anyone revisiting this should start here" — and the apparatus behind it had
   * never been checked in, so revisiting it meant rebuilding it from nothing.
   * That is now done. The two scopes measure as the same rule (-0.00017, CI
   * [-0.00167, +0.00117]) and the knob stays executable so the next person can
   * confirm that in a minute rather than a week.
   *
   * See `scripts/preseasonBrier.test.ts`, run with `SCOPE_SWEEP=1`.
   */
  preseasonClubStartMassScope: "recordless" as "recordless" | "all",
  /**
   * ONE HALF OF THE RECORD-LESS CEILING: the highest `pStart` a club's
   * start-mass deficit may LIFT a record-less player to. `preseasonMaxPStart`
   * (0.97) still governs everyone the model has a record for.
   *
   * It is deliberately equal to `preseasonRecordlessGlobalCap`, which applies
   * the same number to the player's own prior before any lift happens. Together
   * they are a single club-blind rule — a player with no Premier League record
   * is never projected above 0.55, for any reason, in any club — and neither
   * half is sufficient alone. That doc block carries the decomposition and the
   * evidence for shipping both; read the two together and change them together.
   *
   * WHY A RECORD-LESS PLAYER NEEDS HIS OWN CEILING AT ALL. `clubStartMass`
   * divides a club's missing start probability among the players whose absence
   * from the record created the gap. It is accounting, not evidence: nothing
   * about the arithmetic knows whether the man it lands on is a first-choice
   * signing or a fifth-choice squad filler. Letting that arithmetic carry a
   * player the model has no Premier League record for all the way to 0.97
   * asserts he is as nailed as an ever-present who earned the number, on
   * strictly less information than the model normally demands for a tenth of it.
   *
   * WHAT IT WAS COSTING. Record-less calibration before the change, pooled over
   * 2023/24-2025/26, launch pool, outfield, GW1-5 (n=980):
   *
   *     bucket        n    pred     obs
   *     0.60-0.70    45  0.6403  0.4222
   *     0.70-0.80    45  0.7609  0.6222
   *     0.80-0.90    15  0.8412  0.4667
   *     0.95-1.00    45  0.9700  0.4667
   *
   * The top bucket is 45 player-gameweeks the model called near-certain starts
   * and which started 47% of the time. `preseasonMaxPStart`'s own calibration on
   * the has-record group has no such tail; this is specific to the group with no
   * record, and it is the accounting rule that puts them there.
   *
   * THE SWEEP, this half alone (global cap inert at 1). Each row is a full
   * re-run of the real model over the same reconstructed GW1 state, so only
   * this constant differs. `vs base` is a paired bootstrap against 0.97,
   * clustered on club-season, 4000 draws:
   *
   *     cap    Brier  Brier(ev)  Brier(no)   23-24   24-25   25-26   vs base            95% CI
   *     0.20  0.1981     0.1970     0.2031  0.2015  0.1921  0.2004  -0.00061  [-0.00278, +0.00129]
   *     0.30  0.1975     0.1970     0.1998  0.2008  0.1912  0.2004  -0.00118  [-0.00339, +0.00072]
   *     0.40  0.1968     0.1970     0.1961  0.2002  0.1901  0.2001  -0.00183  [-0.00399, +0.00007]
   *     0.45  0.1966     0.1970     0.1946  0.1999  0.1898  0.1999  -0.00209  [-0.00414, -0.00026]
   *     0.50  0.1965     0.1970     0.1938  0.1998  0.1896  0.1998  -0.00222  [-0.00422, -0.00050]
   *     0.55  0.1965     0.1970     0.1939  0.1998  0.1895  0.1999  -0.00221  [-0.00409, -0.00061]
   *     0.60  0.1966     0.1970     0.1946  0.1998  0.1898  0.2000  -0.00209  [-0.00384, -0.00064]
   *     0.70  0.1969     0.1970     0.1963  0.2002  0.1899  0.2004  -0.00179  [-0.00327, -0.00055]
   *     0.80  0.1974     0.1970     0.1991  0.2007  0.1901  0.2011  -0.00131  [-0.00238, -0.00044]
   *     0.90  0.1981     0.1970     0.2036  0.2014  0.1907  0.2021  -0.00053  [-0.00100, -0.00017]
   *     0.97  0.1987     0.1970     0.2067  0.2016  0.1913  0.2030   0.00000
   *
   * The curve is a genuine interior optimum rather than a slide toward zero:
   * below 0.45 it turns and gives the gain back, so the lift itself is doing
   * real work and only its reach was wrong. `Brier(ev)` is 0.1970 in every row —
   * the change does not touch a single player the model has a record for, which
   * is the invariant `clubStartMass`'s `movable` filter is supposed to enforce
   * and here confirms end to end.
   *
   * 0.55 SHIPS, NOT THE ARGMIN, AND THE PLATEAU IS THE REASON. Against 0.55,
   * paired bootstrap, positive meaning the other cap is worse:
   *
   *     .55 vs .40  +0.00038  [-0.00039, +0.00121]
   *     .55 vs .45  +0.00012  [-0.00044, +0.00070]
   *     .55 vs .50  -0.00001  [-0.00034, +0.00031]
   *     .55 vs .60  +0.00012  [-0.00019, +0.00047]
   *     .55 vs .70  +0.00042  [-0.00027, +0.00116]
   *     .55 vs .80  +0.00090  [-0.00010, +0.00204]
   *     .55 vs .90  +0.00168  [+0.00032, +0.00324]   distinguishable
   *     .55 vs .97  +0.00221  [+0.00061, +0.00409]   distinguishable
   *
   * Nothing from 0.40 to 0.80 is distinguishable from anything else in that
   * range. What the data supports is "well below 0.9", not a third decimal; the
   * value is the middle of the flat region rather than its argmin so that a
   * one-parameter sweep on 5680 rows is not read as a fit.
   *
   * OUT OF SAMPLE. Choosing the cap on two seasons and scoring the third:
   *
   *     held out   argmin(fit)   held-out Brier   same rows at 0.97
   *     2023-24        0.50          0.1998            0.2016
   *     2024-25        0.50          0.1896            0.1913
   *     2025-26        0.55          0.1999            0.2030
   *
   * Every held-out season improves, and the fitted cap lands inside the plateau
   * all three times. (An earlier version of this block claimed corroboration
   * "out of sample" from record-less players pinned at the old ceiling starting
   * 52% of the time. That was wrong twice over: those are the same 980 rows the
   * sweep was fitted on, and the rate is 46.7%, which the calibration table
   * three paragraphs above already said.)
   *
   * @see preseasonRecordlessGlobalCap — the other half, and the decomposition.
   */
  preseasonRecordlessMaxPStart: 0.55,
  /**
   * Whether mass the record-less players cannot legitimately hold, once
   * `preseasonRecordlessMaxPStart` binds, is passed to the rest of the squad.
   *
   * OFF, AND MEASURED OFF. Lowering the record-less ceiling to 0.55 leaves some
   * clubs unable to absorb their whole deficit, so the question of where the
   * remainder goes is real and the mechanism does fire. It just does not pay.
   * At the shipped cap and everywhere near it, spilling moves pooled Brier by
   * under 0.0001 and in the wrong direction (cap 0.55: -0.00221 without,
   * -0.00216 with; cap 0.50: -0.00222 / -0.00216; cap 0.60: -0.00209 /
   * -0.00206), while perturbing `Brier(ev)` off 0.1970 — it buys nothing and
   * costs the invariant that this correction never reaches a player the model
   * already scores on evidence.
   *
   * The difference is only small NEAR THE SHIPPED CAP, and an earlier version
   * of this block overreached by calling it small "at every cap". It is not: at
   * cap 0.30 spilling moves -0.00118 to -0.00139 and at 0.20 -0.00061 to
   * -0.00142, because a hard enough ceiling leaves a large remainder and where
   * that remainder goes starts to matter. Both of those caps are far outside
   * the plateau and neither is a candidate, but the claim as written was wrong
   * and the mechanism is not uniformly inert.
   *
   * It stays executable rather than deleted so that verdict is reproducible;
   * `scripts/preseasonBrier.test.ts` with `CEILING_SWEEP=1` prints both halves.
   */
  preseasonClubStartMassSpill: false,
  /**
   * Whether a club whose start mass is ABOVE `preseasonClubStartMass` is scaled
   * back down to it, instead of being left alone.
   *
   * OFF, AND MEASURED OFF — see the UP ONLY bullet on `clubStartMass` for the
   * table. This flag exists because that bullet did not have one. It carried
   * three figures with no apparatus behind them; an audit could neither
   * reproduce them nor re-run them, because there was no way to switch the
   * behaviour on. That is the same defect this file has now caught four times,
   * and the fix is the same one `preseasonClubStartMassSpill` and
   * `preseasonRecordlessCapExemptsSetPieces` already apply: keep the refuted
   * branch executable so the refutation stays checkable.
   *
   * The mechanism is the existing `allocate` running with a negative `need`.
   * `primary` still excludes anyone with a record under the shipped scope, so
   * the rule's reach is unchanged in that respect; it does NOT keep the
   * ceiling test, which is an upward test and would otherwise make anyone
   * already pinned at his cap immune to being scaled down. See the comment on
   * `movable` — getting that wrong once made the refuted branch weaker than the
   * thing it is supposed to be refuting.
   *
   * ONE THING DOES NOT SURVIVE THE FLIP. `preseasonMinutes`'s caller restores
   * the observed `share` floor with a `max` that is only sound while
   * `clubStartMass` is up-only. With this ON, `pStart` can fall below the value
   * that produced `mm.share` and the `max` will hold the stale larger share.
   * That is tolerable for a measurement scored on `pStart` — the Brier harness
   * reads nothing else — and is the reason this stays a measurement switch
   * rather than a candidate setting.
   *
   * Regenerate with `DOWN_NORM=1` in `scripts/preseasonBrier.test.ts`.
   */
  preseasonClubStartMassDown: false,
  /**
   * THE OTHER HALF OF THE RECORD-LESS CEILING: the same number applied in
   * `preseasonMinutes` to a record-less player's OWN prior, before any club
   * accounting runs. Kept equal to `preseasonRecordlessMaxPStart` at 0.55.
   *
   * THIS IS ONE RULE WITH TWO ENFORCEMENT POINTS, NOT TWO PARAMETERS. The rule
   * is "an OUTFIELDER with no Premier League record is never projected above
   * 0.55". It needs both points because each alone has a hole:
   *
   *  - The lift ceiling alone leaves untouched every record-less player at a
   *    club that is NOT short of `preseasonClubStartMass`. Measured on this
   *    archive the ceiling binds in 1, 5 and 7 clubs of 20 across the three
   *    seasons — so on its own it is not a statement about record-less players
   *    at all, it is a statement about record-less players at understaffed
   *    clubs, which is not a distinction anything in football justifies.
   *  - The prior clamp alone is simply UNDONE. It fires before `clubStartMass`,
   *    and `clubStartMass` lifts the clamped players straight back toward 0.97
   *    in precisely the short clubs. That is why the "global" rows below barely
   *    move: they are not measuring a club-blind clamp, they are measuring a
   *    clamp that survives only where nothing needed lifting.
   *
   * AN EARLIER VERSION OF THIS BLOCK REJECTED THE CLAMP on the strength of
   * those "global" rows, describing them as the club-blind alternative. They
   * are not, and two of the three reasons given were wrong on their own terms.
   * The club-blind rule is the `both` row.
   *
   *     variant        Brier  Brier(no)   23-24   24-25   25-26   vs base            95% CI
   *     shipped       0.1987     0.2067  0.2016  0.1913  0.2030   0.00000
   *     ceiling .55   0.1965     0.1939  0.1998  0.1895  0.1999  -0.00221  [-0.00409, -0.00061]
   *     global .70    0.1985     0.2058  0.2012  0.1913  0.2030  -0.00016  [-0.00041, +0.00002]
   *     global .55    0.1981     0.2033  0.1998  0.1910  0.2033  -0.00059  [-0.00161, +0.00017]
   *     global .40    0.1977     0.2011  0.1991  0.1896  0.2044  -0.00097  [-0.00304, +0.00068]
   *     both .55      0.1958     0.1899  0.1986  0.1888  0.1999  -0.00289  [-0.00550, -0.00071]
   *
   * SWEEPING THE UNIFORM RULE — one constant, both enforcement points, so the
   * column is a single free parameter and not a pair. `vs ceil` is a paired
   * bootstrap against the lift-ceiling-only rule at 0.55:
   *
   *     X     Brier  Brier(ev)  Brier(no)   23-24   24-25   25-26   vs ceil            95% CI
   *     0.35 0.1978     0.1970     0.2016  0.2002  0.1895  0.2036  +0.00134  [-0.00097, +0.00360]
   *     0.40 0.1966     0.1970     0.1946  0.1990  0.1888  0.2019  +0.00012  [-0.00183, +0.00193]
   *     0.45 0.1960     0.1970     0.1910  0.1985  0.1884  0.2008  -0.00050  [-0.00212, +0.00091]
   *     0.50 0.1958     0.1970     0.1900  0.1984  0.1887  0.2001  -0.00067  [-0.00197, +0.00041]
   *     0.55 0.1958     0.1970     0.1899  0.1986  0.1888  0.1999  -0.00068  [-0.00171, +0.00013]
   *     0.60 0.1960     0.1970     0.1912  0.1988  0.1891  0.1999  -0.00047  [-0.00127, +0.00020]
   *     0.70 0.1967     0.1970     0.1950  0.1999  0.1897  0.2003  +0.00019  [-0.00054, +0.00094]
   *     0.90 0.1981     0.1970     0.2036  0.2014  0.1907  0.2021  +0.00168  [+0.00032, +0.00324]
   *
   * WHY IT SHIPS ON AN INCREMENT THAT IS NOT SIGNIFICANT. Be clear that it is
   * not: -0.00068 [-0.00171, +0.00013] over the lift ceiling alone, and
   * leave-one-season-out splits 2-1 (held-out 2023/24 0.1986 vs 0.1998 and
   * 2024/25 0.1888 vs 0.1895 favour uniform; 2025/26 0.2008 vs 0.1999 does
   * not). The Brier is not the argument. The argument is that the uniform rule
   * is the SIMPLER of the two and the one that can be stated without reference
   * to an implementation detail — the alternative has to be described as "a cap
   * that applies only when your club's accounting happens to be short", which
   * no one would propose on purpose. It also costs nothing elsewhere:
   * `Brier(ev)` stays 0.1970, and club start-mass sums land identically
   * (2023/24 min 9.60, 2024/25 9.11, 2025/26 8.47) because the lift ceiling was
   * already the binding constraint in exactly those clubs.
   *
   * WHAT IT ACTUALLY DOES TO THE 2026/27 LAUNCH SQUAD: nothing, and that is
   * worth stating plainly rather than leaving a reader to assume a Brier
   * improvement bought a better team. On the live snapshot the launch pool
   * holds 399 players of whom 37 are record-less; the rule moves 27 of them —
   * 14 up and 13 down — and the recommended fifteen and the recommended XI are
   * IDENTICAL under all three configurations (no rule, lift ceiling only,
   * shipped). `LIVE=1 npx vitest run -c vitest.preseason.config.ts` prints all
   * 27 with club, price, ownership and both `pStart` values.
   *
   * THE CHARACTERISATION THAT USED TO BE HERE WAS WRONG THREE WAYS, and how it
   * got wrong is the more useful half. It said "every one of the twenty-seven
   * is a GBP 4.0-5.5m promoted-club player owned by under 2% of managers".
   * Measured:
   *
   *  - PRICE. The range is GBP 4.0-6.0. Rodriguez (BOU, GBP 6.0m) is outside
   *    the stated band, and he is the largest single cut in the list
   *    (0.970 -> 0.550).
   *  - CLUBS. Six clubs are represented — BOU, COV, EVE, HUL, IPS, LEE — and
   *    only COV, HUL and IPS were promoted. Hackney (EVE) and Muharemovic
   *    (LEE) are record-less at established clubs, which is the ordinary case
   *    of a signing from abroad and not a promotion artefact at all.
   *  - OWNERSHIP. van Ewijk (COV, GBP 4.0m) is owned by 16.9% of managers and
   *    the rule cuts him from 0.854 to 0.550. He is the single most-owned
   *    player the rule touches and he sits at the 96th percentile of ownership
   *    in the whole pool. "Under 2%" is not a near miss on him, it is the
   *    opposite of the truth, and he is the reason this paragraph matters:
   *    the rule is not confined to players nobody holds.
   *
   * The paragraph was wrong because the throwaway probe that produced it
   * printed the fifteen players the PRIOR CLAMP moved that the lift ceiling did
   * not, and the sentence generalised from that subset to all 27. Every one of
   * those fifteen genuinely was a cheap, thinly-owned promoted-club player, so
   * the claim was true of what was on screen and false of what it asserted. The
   * probe was then deleted, which is why it took an audit rather than a re-read
   * to catch. The measurement lives in `scripts/preseasonBrier.test.ts` now.
   *
   * (For the record, since the old text is quoted elsewhere: of the 15 the
   * clamp reaches beyond the ceiling, three are clamped downward — Wright
   * (COV), Crooks (HUL) and Rudoni (COV), all sitting on a set-piece floor —
   * and the other twelve rise slightly, because the start mass those three give
   * up is redistributed to their own team-mates.)
   *
   * A FLAT CEILING IS A FLAT CEILING, and the two ends of that list are the
   * caveat: van Ewijk at the 96th ownership percentile and Rodriguez at the
   * 12th both land on exactly 0.550. The rule does not claim these two men are
   * equally likely to start. It claims neither has a Premier League record, so
   * neither has evidence the model can rank them on above that line, and
   * ownership is a fact about managers rather than about team sheets. When
   * team news arrives the in-season path takes over and the question stops
   * being hypothetical.
   *
   * So this is a fix to the tail of the pool, not to the top of it. It matters
   * because the optimiser is a search over the whole pool and a player rated
   * 0.97 on a price tag is a candidate for every bench slot and every downgrade
   * the transfer planner considers all season; it does not matter for the team
   * the app recommends today.
   *
   * THE ONE ADVERSE NUMBER, recorded rather than buried. Re-running the season
   * simulator, three of the four archive seasons draft a bit-identical launch
   * squad and only the projected totals move by 6 points in 2000. 2022/23 does
   * not: the model manager gains 33 points (2222 -> 2255) and the
   * set-and-forget squad LOSES 67 (1803 -> 1736). That season is the one where
   * the archive holds no prior season at all, so every single player in it is
   * record-less and the cap flattens the entire pool to 0.55 — which is exactly
   * the case the rule was never meant to arbitrate, and the reason the Brier
   * harness excludes 2022/23 as uninformative. It is a real number and it went
   * the wrong way; it is also measured on a fixture where the rule degenerates.
   *
   * KEEPERS ARE OUT OF SCOPE, ON PURPOSE, and the word "outfielder" above is
   * doing real work rather than hedging. `preseasonMinutes` does clamp a
   * record-less keeper like anyone else, and then the keeper block in
   * `projectAll` throws that clamp away wholesale — `mm = gkMm(0) ?? mm`
   * REPLACES the minutes model rather than adjusting it, and the depth chart's
   * own redistribution loop caps at `preseasonMaxPStart` with no record-less
   * awareness at all. An audit found this and called it a hole. It is not:
   *
   *  - The cap exists to distrust `priorPStart`, which turns a price tag into
   *    an ABSOLUTE start probability with nothing competitive constraining it.
   *    A record-less GBP 6.0m midfielder can be his club's tenth-choice
   *    attacker and the prior cannot tell.
   *  - The keeper depth chart is not that. It is a ZERO-SUM allocation of one
   *    shirt among a club's keepers, and the shirt is worn by somebody whether
   *    or not the league has seen him before. Capping a promoted club's
   *    first-choice keeper at 0.55 does not express doubt about him, it hands
   *    0.4 of a start to his DEPUTY, who is a worse bet by every signal the
   *    depth chart has. That is a strictly worse projection, not a cautious one.
   *
   * The distinction is that within a club the keeper ordering is identified by
   * price and ownership even with no record on either man, because the question
   * is only "which of these two", never "does either play at all".
   *
   * Latent on the live snapshot in any case. There are 24 record-less keepers
   * in the 2026/27 bootstrap and 2 of them are inside the launch pool; the
   * highest is Butland (HUL) at 0.509, and Dovin (COV) at 0.484 is the highest
   * one pooled. ZERO sit above 0.55, so the exemption changes nothing today; it
   * is documented, pinned by a unit test, and regenerated by
   * `scripts/preseasonBrier.test.ts` with `LIVE=1`, so that it stays a decision
   * rather than becoming an accident the first time a promoted club's number
   * one is priced up.
   *
   * The two constants are kept separate rather than collapsed into one so this
   * decomposition stays reproducible: `scripts/preseasonBrier.test.ts` with
   * `GLOBAL_SWEEP=1` prints the first table and `UNIFORM_SWEEP=1` the second.
   * A unit test pins them equal. If you change one, change both.
   */
  preseasonRecordlessGlobalCap: 0.55,
  /**
   * Whether a record-less player who is his club's DESIGNATED first-choice
   * penalty or set-piece taker keeps `setPieceStartFloor` when the record-less
   * cap would otherwise pull him below it.
   *
   * OFF — PROPOSED ON A GOOD ARGUMENT, MEASURED, AND REFUTED. The argument was
   * that the cap exists to distrust `priorPStart`, which is price and ownership
   * and therefore the market's guess, whereas a set-piece order of 1 is the
   * club's own team sheet published by FPL, and no manager nominates a
   * fifth-choice squad filler to take his penalties. It looked like the one
   * piece of role evidence available for exactly the group the cap otherwise
   * leaves with nothing to go on.
   *
   *     exempt        n    Brier  Brier(ev)  Brier(no)   23-24   24-25   25-26
   *     no         5680   0.1958     0.1970     0.1899  0.1986  0.1888  0.1999
   *     yes        5680   0.1966     0.1970     0.1946  0.2001  0.1893  0.2002
   *
   *     paired bootstrap, exempt minus not: +0.00081 [+0.00007, +0.00178]
   *
   * It is worse, in all three seasons, and the interval excludes zero — one of
   * the few comparisons in this whole workstream that is distinguishable at
   * all. The reason is in the population: 400 player-gameweeks move, and they
   * started 34.5% of the time. Against a floor of 0.62 or 0.75 that is not a
   * near miss, it is the opposite of the claim.
   *
   * WHY THE ARGUMENT WAS WRONG, since it is a tempting one and will be made
   * again. A set-piece order says who takes the penalty GIVEN that he is on the
   * pitch. It is silent on whether he is. Among players with no Premier League
   * record the two come apart hard, because that group is dominated by promoted
   * clubs, and a promoted club's designated penalty taker is typically its best
   * Championship player — the man most likely to be replaced when the club
   * spends, and least likely to hold a place at the new level. The observed
   * 34.5% is that story. Note it sits BELOW the 0.55 cap, not above it, so
   * these players are if anything over-rated at the cap already; that is left
   * alone rather than fitted, on 400 rows.
   *
   * Kept executable rather than deleted so the verdict is reproducible:
   * `scripts/preseasonBrier.test.ts` with `SETPIECE_SWEEP=1`.
   */
  preseasonRecordlessCapExemptsSetPieces: false,
  // A DISCOUNT ON A PLAYER WHO CHANGED CLUB WAS TESTED HERE AND REJECTED.
  // The proposal was to scale a mover's `games`, `starts` and `minutes`
  // together in `preseasonEvidence` — leaving `starts / games` alone and only
  // weakening how hard his record pulls against the price prior, i.e. "we are
  // less sure about him" rather than "he will play less". Measured on the three
  // archive seasons that have a prior season (2023/24-2025/26; 2022/23 has none
  // and is uninformative) against realised GW1-5 start fraction, residual =
  // observed minus predicted, launch pool, outfield:
  //
  //     all players with a record                906    +0.006
  //     changed club (previous-season-club proxy) 90    +0.079
  //     ...of those, last season's starts >= 20   42    -0.006
  //
  // The whole-group number has the WRONG SIGN — a mover starts MORE than the
  // model says — and it is entirely a thin-record effect. Split by last
  // season's starts, movers run +0.277 (0-4 starts), +0.163 (5-14), +0.061
  // (15-24), -0.084 (25+) against stayers at +0.058, +0.035, +0.010, -0.069;
  // at 25+ starts, the only place a trust multiplier moves anything worth
  // moving, mover and stayer are the same number. Restricted to a real record
  // the difference is -0.006, 95% CI [-0.109, +0.115] clustered on club-season,
  // and its leave-one-season-out values change sign (-0.021, -0.008, +0.013).
  //
  // The apparent whole-group effect is the proxy, not football: flagging anyone
  // whose round-1 club differs between seasons sweeps in every JANUARY mover of
  // the previous season, whose record is split across two clubs and depressed
  // at both. FPL's `team_join_date` is not the escape — it exists in two of the
  // archive's seasons and is read from an END-OF-SEASON snapshot, so it flags
  // Isak (Newcastle, join 2025-09), Wissa (Brentford, 2025-09), Sterling
  // (Chelsea, 2024-08) and Eze (Palace, 2025-08) as summer arrivals at clubs
  // they already played for, and those four are exactly the players whose GW1-5
  // start fraction collapsed because a transfer saga was running. That
  // manufactures a -0.220 "mover penalty" out of nothing. So: no effect to fit,
  // and no field on which to fit it.
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
  /**
   * How far an undated injury or doubt recovers within the horizon.
   *
   * The decay this multiplies used to run `1 - (1 - a0) * rate^offset`, which
   * asymptotes to 1: given enough gameweeks, every flagged player is projected
   * fully fit. That is false, and measurably so. Over 2022-23..2025-26, taking
   * every run of consecutive blank rounds by an established starter (2,051
   * runs) and tracking forward, P(play) plateaus well short of the ceiling for
   * that population. Normalising by a matched never-absent control — necessary
   * because selecting on a high recent start rate regresses downward on its own
   * (0.904 -> 0.778 over ten rounds with no absence at all) — the recovered
   * fraction settles at roughly:
   *
   *   offset          1     2     3     4
   *   measured     0.42  0.51  0.58  0.62   (runs already 3-4 rounds long)
   *   old code     0.40  0.64  0.78  0.87
   *   this         0.30  0.48  0.59  0.65
   *
   * The old form is close at offset 1 and then diverges badly; a ceiling fixes
   * the shape rather than the first point. 0.75 is the round number inside the
   * plateau band — short absences settle near 0.78, absences already six rounds
   * old near 0.45 — and it is deliberately at the optimistic end of that band,
   * because this branch also catches players whose blank rounds were rotation
   * rather than injury.
   *
   * Applied as a target the deficit closes toward, not as a clamp: a player
   * already above it (`chance_of_playing` 80, say) is never dragged DOWN to
   * 0.75, he simply stops climbing.
   */
  recoveryCeiling: 0.75,
  /**
   * Availability at horizon offsets 1, 2, 3, 4+ for a player serving a ban
   * whose end date is not stated in `news`. See `availabilityAt` for the
   * measurement these come from.
   */
  banAvail: [0.62, 0.77, 0.88, 0.95] as number[],
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

/**
 * Diagnostic sink for the minutes model, off by default.
 *
 * The minutes model is the single largest pre-season signal and NOTHING in
 * `PlayerXp` exposes it — a study of `pStart` calibration therefore either
 * reimplements the rule in the measuring script (which is how two rounds of
 * constants were fitted against a replica that had silently diverged) or it
 * reads the shipped value out of the shipped call. This is the second option.
 * Set `.minutes` to a Map before calling `projectAll` and every element's
 * final `MinutesModel` lands in it, after the keeper depth chart has had its
 * say and with the flag saying whether the shrinkage branch or the no-record
 * branch produced it.
 *
 * Null in production: one `Map.set` per element per projection is not free and
 * nothing in the app reads it.
 */
export const XP_DEBUG: {
  minutes: Map<number, MinutesModel & { hasEvidence: boolean; preseason: boolean }> | null;
} = { minutes: null };

export interface XpContext {
  bootstrap: Bootstrap;
  fixtures: Fixture[];
  nextEvent: number;
  horizon?: number;
  /**
   * elementId -> what he has been doing in the team's last ~5 games (from the
   * element-summary endpoint). The best minutes predictor there is: a player
   * who just became a nailed starter — or just lost his place, or is being
   * hooked on the hour — is priced correctly within a week instead of a month.
   */
  recentForm?: Map<number, RecentForm>;
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
  // Chronological order within an event. This used to be whatever order the
  // fixture list happened to arrive in, which was fine while the only consumers
  // counted the legs or summed them. It stopped being fine when the suspension
  // term started pricing the legs of a double ASYMMETRICALLY: a booking in the
  // first leg can cost the second, but not the reverse, so "first" has to mean
  // first in time and not first in the array.
  //
  // This is NOT order-immaterial for the pre-existing consumers, and an earlier
  // version of this comment claimed it was. Two of them — the keeper depth chart
  // and the anchor blend's `avail` — take `[0]` as a representative kickoff and
  // hand it to `availabilityAt`, which branches on that timestamp against
  // `newsReturnTime` for statuses "i", "d" and "s". For a flagged player in a
  // double, which leg is `[0]` really can change the answer. The justification
  // is therefore empirical rather than structural: with the suspension term
  // neutralised and this sort left live, all four `backtest-report-*.json`
  // reproduce the pre-sort files byte for byte, as do the sim reports. Inert on
  // the evidence base, not inert by construction.
  for (const byTeam of idx.values()) {
    for (const arr of byTeam.values()) {
      // An unknown kickoff sorts last rather than throwing the order away: a
      // fixture with no time is usually one that has not been scheduled yet,
      // which really is the later of the two. The explicit equality branch is
      // load-bearing, not noise: two untimed legs would otherwise compare
      // `Infinity - Infinity` = NaN, and arrival order would survive only
      // because the spec coerces a NaN comparator result to +0. Sorting is
      // stable by ECMA-262 since ES2019 — a language guarantee, not a V8 one,
      // as this comment previously implied — so equal keys keep their order.
      if (arr.length > 1) {
        arr.sort((a, b) => {
          const ka = kickoffTime(a) ?? Infinity;
          const kb = kickoffTime(b) ?? Infinity;
          return ka === kb ? 0 : ka - kb;
        });
      }
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
  // FPL writes two different phrasings for the same fact. Injuries read
  // "Knee injury - Expected back 25 Sep"; bans read "Suspended until 17 Jan".
  // Matching only the first threw away every stated ban end date in the
  // archive: 11 of the 13 suspended players across 2022-23..2025-26 state one,
  // and the two that do not are both Mudryk rows reading "Suspended - unknown
  // return date", which no pattern could have read anyway. (An earlier draft
  // said 12 of 13.)
  const m = /(?:expected back|suspended until)[^0-9]*(\d{1,2})\s+([A-Za-z]{3})/i.exec(el.news ?? "");
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
  if (kickoff != null && (el.status === "i" || el.status === "d" || el.status === "s")) {
    const back = newsReturnTime(el, new Date(kickoff).getUTCMonth() >= 7
      ? new Date(kickoff).getUTCFullYear()
      : new Date(kickoff).getUTCFullYear() - 1);
    if (back != null) {
      const days = (kickoff - back) / 86_400_000;
      if (days < 0) return 0;
      // A ban is a legal absence, not a fitness one. A suspended player trains
      // all week and is match-fit the day his ban expires, so the return ramp —
      // which exists because a body coming back from injury is eased in — must
      // NOT be applied to him. Before the stated date he is unavailable; after
      // it he is simply available.
      if (el.status === "s") return 1;
      return clamp(cfg.returnRampStart + (1 - cfg.returnRampStart) * (days / cfg.returnRampDays), 0, 1);
    }
  }
  if (offset <= 0) return a0;
  if (el.status === "s") {
    // "Bans are usually one match" was half right and shipped as if it were
    // certain: 0.9 at every future offset says the ban is over by the next
    // gameweek with 90% confidence, forever. Measured over 2022-23..2025-26,
    // among established starters (>=60% of the prior 6 rounds) who were sent
    // off, the number of subsequent rounds missed is 0: 14.6%, 1: 53.1%,
    // 2: 12.5%, 3: 9.4%, 4+: 10.4% (n=96; the same population's baseline rate
    // of missing >1 round for any reason is 4.2%, so this is red-attributable).
    // Conditioning on the ban costing at least the imminent round — which is
    // what status "s" plus a zero playing chance asserts — the cumulative
    // probability he is back by offset k gives the schedule below. Three-match
    // bans for violent conduct and serious foul play are why the tail is fat.
    const sched = cfg.banAvail;
    return Math.max(a0, sched[Math.min(offset, sched.length) - 1]);
  }
  // Injured / doubtful: the deficit decays geometrically, but toward
  // `recoveryCeiling` rather than toward 1. The old form asymptoted to full
  // fitness, which is why a player flagged injured with no stated return date
  // reached 0.87 availability four gameweeks out — the exact failure the
  // `newsReturnTime` docstring says it exists to prevent, still live for the
  // ~32% of flagged players whose news carries no parseable date at all.
  const target = Math.max(a0, cfg.recoveryCeiling);
  return a0 + (target - a0) * (1 - Math.pow(cfg.recoveryRate, offset));
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
function priorPStart(el: Element, ownPct?: number): number {
  const cfg = XP_CONFIG;
  const t = el.element_type;
  const typical = cfg.typicalPriceM[t] ?? 6;
  const rel = el.now_cost / 10 / typical - 1;
  const [lo, hi] = cfg.priorPStartRange;
  // Clamped BEFORE the blend, not after, and that ordering is the whole
  // difference between a weight that means something and one that does not.
  // The raw price term is unbounded above — it passes 1.1 at £8.9m for a
  // midfielder — so blending raw and clamping the result left every premium
  // pinned at `hi` no matter where the crowd had put him: an £8.0m defender
  // came out 0.900 at the 1st percentile of ownership and 0.900 at the 99th.
  // The ownership term was not weighted down for those players, it was
  // switched off, and since the clamp only bites upward the crowd could cast
  // doubt on a premium (via `oHi` = 0.7 < `hi` = 0.9) but never confirm one.
  const price = clamp((cfg.priorPStartBase[t] ?? 0.5) + cfg.priorPStartSlope * rel, lo, hi);
  // No usable ownership order for this position — see `ownershipPercentiles`.
  // Price alone, exactly as before.
  if (ownPct == null) return price;
  const [oLo, oHi] = cfg.priorPStartOwnRange;
  const market = oLo + (oHi - oLo) * Math.pow(clamp(ownPct, 0, 1), cfg.priorPStartOwnGamma);
  const w = cfg.priorPStartOwnWeight;
  return clamp((1 - w) * price + w * market, lo, hi);
}

/**
 * Where each player sits in his own position's ownership order, as a percentile
 * in [0, 1]. Feeds the pre-season start prior; see `priorPStartOwnWeight`.
 *
 * A RANK, not the percentage itself, and that is the load-bearing choice.
 * `selected_by_percent` is a share of a manager count that grows by a million
 * or so a year, so the same player is a different number in 2022 and in 2025,
 * and the backtest harness has to reconstruct it from a raw `selected` count
 * divided by an estimate of that year's total. A percentile is invariant to
 * every one of those, so what is measured on the archive is what ships. It is
 * also the statistic the evidence is actually in: the in-band correlation that
 * started this was a Spearman.
 *
 * Ties share a mid-rank. FPL publishes ownership to one decimal, so at GW1 well
 * over a third of a position sits at exactly "0.0" — the cheap tail, where this
 * signal would otherwise be inventing an order out of rounding. They all get
 * the same percentile, which is the honest answer: the crowd has not
 * distinguished them.
 *
 * A position whose ownership does not vary at all is left out of the map
 * entirely rather than given a flat 0.5. That is not a hypothetical: a fixture
 * harness or a mock with a constant ownership string would otherwise have every
 * player's prior dragged halfway to the middle of the market range, silently,
 * on no information.
 *
 * Must be handed the COMPLETE bootstrap, never a filtered pool. A percentile is
 * a statement about a denominator: rank a player against the 420 the drafter
 * shortlisted and the least owned of them lands at 0.0, when against all 700-odd
 * he is at 0.4 and the shortlist itself was the crowd's opinion of him. The one
 * caller is `projectAll`, which passes `ctx.bootstrap.elements` whole; anything
 * that starts passing a subset has to compute this before the filter, not
 * after.
 */
function ownershipPercentiles(elements: Element[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const pos of [1, 2, 3, 4]) {
    const inPos = elements.filter((e) => e.element_type === pos);
    if (inPos.length < 2) continue;
    // ABSTAIN, DO NOT DEMOTE. This used to read `parseFloat(...) || 0`, which
    // turns a missing or malformed field into a real 0.0% and therefore into
    // the BOTTOM of the position's order — the model would then act on a
    // confident statement that nobody owns him, sourced from a parse failure.
    // Ownership is a signal the model can do without, and every consumer of
    // this map already handles an absent entry, so the honest answer to "we
    // could not read it" is to say nothing about that position at all.
    //
    // Dropping the whole position rather than the one player is deliberate and
    // is relied on elsewhere: a percentile is a rank against everyone in the
    // position, so a partial map would rank the survivors against a silently
    // smaller field. The goalkeeper depth chart in particular reasons from
    // "within a club it is all keepers or none" to conclude that a missing
    // percentile cannot advantage one keeper over his club rival by accident.
    const raw = (e: Element) => parseFloat(e.selected_by_percent);
    if (inPos.some((e) => !Number.isFinite(raw(e)))) continue;
    const own = (e: Element) => raw(e);
    const sorted = [...inPos].sort((a, b) => own(a) - own(b));
    const n = sorted.length;
    if (own(sorted[0]) === own(sorted[n - 1])) continue;
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && own(sorted[j + 1]) === own(sorted[i])) j++;
      const pct = (i + j) / 2 / (n - 1);
      for (let k = i; k <= j; k++) out.set(sorted[k].id, pct);
      i = j + 1;
    }
  }
  return out;
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
 * Did FPL actually record this row's `starts`, or is the number we were handed
 * an artefact of the field not existing yet?
 *
 * The distinction is not cosmetic: `impliedStarts` reads an unrecorded row's
 * minutes instead, and reading a 2779-minute season as zero starts rates the
 * player below someone who has never kicked a ball. See
 * `XP_CONFIG.startsRecordedFrom` for the counts that place the cut-off.
 *
 * Three cases are NOT missing data and must survive this untouched:
 *  - a positive count, at any age — nothing about an old row makes a recorded
 *    start disappear, and imputing over it would overwrite evidence with an
 *    estimate;
 *  - zero starts alongside zero minutes, which is consistent and is exactly the
 *    "in the game, never played" record the model needs to see as such;
 *  - zero starts on a row from `startsRecordedFrom` onwards, which is a real
 *    substitute and whose minutes must not be laundered into starts.
 */
function startsUnrecorded(row: SeasonWorkload): boolean {
  if (row.starts == null) return true;
  if (row.starts > 0 || row.minutes <= 0) return false;
  // An unparseable or absent season name leaves no way to date the row, so the
  // recorded value stands. Every production path supplies one (`fetchPastSeason`
  // copies `season_name` onto all three shapes it builds), which is what keeps
  // this from being the branch that quietly decides the answer.
  const year = row.seasonName ? parseInt(row.seasonName.slice(0, 4), 10) : NaN;
  return Number.isFinite(year) && year < XP_CONFIG.startsRecordedFrom;
}

/**
 * How many games a player STARTED, using minutes as the estimate when FPL
 * didn't record starts.
 *
 * minutes/80 is a serviceable stand-in — far better than reading a missing
 * field as zero.
 */
function impliedStarts(row: SeasonWorkload): number {
  if (!startsUnrecorded(row)) return row.starts ?? 0;
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
      // `games` is weighted too, and that is not cosmetic. Every consumer of
      // this struct divides by it — `ev.starts / ev.games`, `ev.minutes /
      // (ev.games * 90)` — so weighting the numerators and leaving the
      // denominator at a flat 38 does not age the evidence, it DILUTES it: a
      // two-season-old record came out with 0.55x the starts spread over the
      // full 38 games, which is a claim that the player was benched, not a
      // claim that we are less sure. At age 2 it put `pStart` about 2.5x too
      // low. Age is supposed to shrink a record toward the prior, and shrinking
      // toward the prior means less evidence, not worse evidence.
      //
      // Which is exactly why this branch now needs the same ancient-history
      // cut-off the multi-season branch has above, and did not before. With a
      // flat denominator, `observedShare = minutes / (games * 90)` decayed with
      // the record and a seven-year-old season floored `share` at nothing.
      // Weighting the denominator makes that ratio w-INVARIANT: the same
      // 3060-minute line from 2018/19 now floors `share` at 0.895 forever,
      // because a ratio does not care how little you believe both halves of it.
      // Shrinking `pStart` toward the prior and then letting an un-shrunk floor
      // overwrite the answer is not shrinkage at all.
      if (w < 0.05) return null;
      return {
        games: cfg.preseasonSeasonGames * w,
        // `seasonName` is carried into the row rather than dropped: without it
        // `impliedStarts` cannot date the record, and an undated zero is read
        // as a real zero. This branch describes a pre-2022/23 season as often
        // as any other.
        starts:
          impliedStarts({
            seasonName: past.seasonName,
            minutes: past.minutes,
            starts: past.starts,
          }) * w,
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
  seasonStartYear: number,
  ownPct?: number
): MinutesModel {
  const cfg = XP_CONFIG;
  const prior = priorPStart(el, ownPct);
  const floor = setPieceStartFloor(el);
  const ev = preseasonEvidence(el, past, seasonStartYear);
  if (!ev) {
    const mps = cfg.preseasonUnknownMinsPerStart;
    // THE RECORD-LESS CAP BINDS THE SET-PIECE FLOOR TOO. It was proposed that
    // it should not — that a designated penalty taker has role evidence even
    // without a Premier League record — and measured, the exemption is worse in
    // all three archive seasons by a distinguishable margin, because the 400
    // player-gameweeks it moves started 34.5% of the time. See
    // `preseasonRecordlessCapExemptsSetPieces`, which keeps the losing branch
    // executable, for why the argument fails.
    const capped = cfg.preseasonRecordlessCapExemptsSetPieces
      ? Math.max(Math.min(prior, cfg.preseasonRecordlessGlobalCap), floor)
      : Math.min(Math.max(prior, floor), cfg.preseasonRecordlessGlobalCap);
    const pStart = clamp(capped, 0, 1);
    return { pStart, minsPerStart: mps, share: clamp((pStart * mps) / 90, 0, 1) };
  }
  const k = cfg.preseasonPriorGames;
  // A CONVEX COMBINATION, and it has to stay one. Writing it out:
  //
  //     (ev.starts + prior * k) / (ev.games + k)
  //   = w * (ev.starts / ev.games) + (1 - w) * prior,   w = ev.games / (ev.games + k)
  //
  // so the answer always lies BETWEEN the observed rate and the prior, and
  // which side it moves toward is decided by how much evidence there is, not
  // by which number happens to be bigger.
  //
  // A ONE-SIDED FLOOR WAS PROPOSED TWICE AND IS REJECTED. Both forms —
  // replacing the blend with `max(rate, prior)`, and keeping the blend but
  // flooring it at the observed rate — delete the downward half of the
  // shrinkage, on the intuition that a player's own record should never be
  // used against him. The intuition is wrong, and it is wrong in exactly the
  // place that costs points. Shrinkage is not a penalty; it is the correction
  // for the fact that an observed rate estimated on 38 games overshoots, and
  // last season's ever-presents are the group it overshoots hardest for,
  // because being an ever-present is partly luck with injuries and rotation
  // and luck does not repeat. A GBP 4.5m midfielder who started all 38 comes
  // out of the blend at 0.8745 and out of a one-sided floor at 0.970, the cap
  // — the model would be asserting he starts 37 of 38 again. He does not, and
  // the difference is not free: `clubStartMass` below allocates one club's ten
  // shirts in proportion to these numbers, so inflating the men who already
  // have the most takes the correction away from precisely the squad players
  // it exists to find. See the regression test "shrinks an ever-present
  // downward, not just a fringe player upward"; the narrow form of the mutation
  // is the one to try first, since the wide form fails half the file and can
  // be waved away as obviously broken.
  //
  // `floor` below is a genuine one-sided term and does not contradict this.
  // Set-piece duty is EXTERNAL evidence, not the same record read twice.
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

/**
 * Redistributes a club's missing pre-season start probability onto the players
 * whose absence from the record is what created the gap. See
 * `preseasonClubStartMass` for the measurement that motivates it.
 *
 * Ten outfielders start every match. `priorPStart` cannot know that, because it
 * scores each player against the LEAGUE's price and ownership order rather than
 * against his own club's, so a club made of players the league has priced
 * cheaply comes out with six starters and a club of expensive ones with
 * thirteen. This puts the missing mass back.
 *
 * Three choices in here are load-bearing, and each was measured against the
 * alternative on the pool, 2023/24-2025/26 (Brier on "started", lower better):
 *
 *  - UP ONLY. A club over the target is left alone. Measured with
 *    `DOWN_NORM=1`, which flips `preseasonClubStartMassDown`:
 *
 *      regime        n      Brier    Brier(ev)   Brier(no)
 *      up only     5680    .19578     .197000     .18995
 *      + down      5680    .20318     .197000     .23283
 *
 *      per season   23-24    24-25    25-26
 *      up only     .19857   .18876   .19988
 *      + down      .21058   .18834   .21030
 *
 *      paired bootstrap (down minus up, positive favours UP ONLY)
 *        pooled                +.00740 [+.00282, +.01209]
 *        record-less only      +.04289 [+.01646, +.07725]
 *
 *      on the 400 moved rows only
 *        Brier      .15725 -> .26232
 *        mean pStart .3090 -> .0478,  observed start rate .2825
 *
 *    Down-normalisation is worse, and distinguishably so: neither interval
 *    crosses zero. QUOTE THE THIRD BLOCK, NOT JUST THE SECOND. The rule moves
 *    400 of 5680 rows and 75 players, so even the record-less figure is four
 *    fifths exact zeroes; .043 is the diluted reading and .105 is what the rule
 *    does to what it touches.
 *
 *    THE MECHANISM IS OVERSHOOT, NOT DIRECTION. On the rows it reaches, up-only
 *    already sits slightly HIGH — .3090 predicted against .2825 observed — so
 *    there was a case to be made that some correction downward was owed. What
 *    down-normalisation actually does is replace a 9% overshoot with a
 *    six-fold undershoot, .0478 against .2825, because a club's surplus is
 *    typically larger than its record-less players are worth and the whole of
 *    it comes out of them. It loses on magnitude, not on sign, and no smaller
 *    version of it has been measured.
 *
 *    (An earlier draft of this paragraph explained the loss by asserting that a
 *    deep squad's unknowns are new signings who start MORE than an unknown at a
 *    thin club. That is a story, not a measurement; it was stated as flat fact
 *    with nothing behind it, and an audit that split the record-less rows on
 *    club depth reported the pooled difference going the other way. It is
 *    withdrawn rather than reversed — the counter-measurement is not checked in
 *    either, and the two lines above are measured and are enough to explain the
 *    result without it.)
 *
 *    2024/25 goes very slightly the other way (.18876 to .18834). Ten of its
 *    twenty clubs are BELOW target, so the branch has little to bite on, and
 *    one season inside the noise is what that should look like. It is reported
 *    rather than dropped because dropping the one cell that disagrees is how
 *    tables in this file went wrong before.
 *
 *    THE `Brier(ev)` COLUMN IS A CONTROL, NOT A RESULT. It is identical to six
 *    decimals because it MUST be: `primary` excludes anyone with a record under
 *    the shipped scope, so no proven starter is reachable in either direction.
 *    The harness asserts on that rather than printing it, so a broken scope
 *    filter fails loudly instead of quietly widening what this rule touches.
 *    (`primary`, not `movable` — an earlier draft of this line named the
 *    latter, which has no scope test in it at all. Under `spill`, `movable` is
 *    made ENTIRELY of has-record players, so the sentence was true of the
 *    shipped configuration by accident rather than by the reason it gave.)
 *
 *    ALL THREE FIGURES THIS BULLET USED TO QUOTE WERE OFF-REGIME. It said the
 *    has-record group was "unchanged to six decimals at .194480", the
 *    record-less group went ".2174 to .2312" and the pool ".1989 to .2016".
 *    The shipped baselines are .1970 and .18995 and .19578. The .1989 is the
 *    same off-regime pooled figure the RECORD-LESS bullet below traces: target
 *    10.0 AND the `players_raw.csv` end-of-season population. The target alone
 *    accounts for almost none of the gap — `MASS_SWEEP=1` puts 9.6 at .19578
 *    and 10.0 at .19588 — so the population is doing the work, and an earlier
 *    version of this sentence blamed the target for all of it. So the
 *    numbers were measured under a configuration the model no longer runs and
 *    were then quoted as live baselines — and none of it could be re-run,
 *    because until `preseasonClubStartMassDown` existed there was no way to
 *    turn the behaviour on. The direction survived the re-measurement and the
 *    magnitudes did not — the record-less cost is five times what was claimed.
 *
 *    AND THE SWITCH UNDER-FIRED TWICE BEFORE IT MEASURED ANYTHING, which is
 *    the part of this worth keeping. Both drafts produced a comfortable answer
 *    and both were comfortable for the same reason: the mechanism being
 *    refuted had been quietly crippled, and a crippled alternative flatters
 *    whatever it is compared against.
 *
 *      draft   the defect                              moved   pooled bootstrap
 *      1st     reused `allocate`'s ceiling test,        105   +.00048 [-.00014,
 *              which excludes anyone already AT his            +.00146]
 *              cap — when scaling DOWN that is
 *              precisely the record-less players a
 *              deep club is full of
 *      2nd     kept `want2 <= 0` as a break, which      200   +.00242 [+.00033,
 *              reads as "nothing left to place"                +.00509]
 *              going up and as "the surplus exceeds
 *              the pool" going down; a no-op on 22
 *              of 35 eligible club-seasons
 *      3rd     — (shipped measurement)                  400   +.00740 [+.00282,
 *                                                              +.01209]
 *
 *    The first draft's reading was "buys nothing", both intervals crossing
 *    zero, and it would have been written up as settled. The second's headline
 *    example was Arsenal 2023/24, cited two paragraphs below as the
 *    over-allocated tail — and it was one of the 22 clubs the branch never
 *    touched. Each is reproducible with a one-token edit to `allocate`: drop
 *    `need < 0 ||` from `movable` for the first, and restore `want2 <= 0` to
 *    the unconditional `break` for the second. They are recorded as recipes
 *    rather than flags because they are defects, not alternatives — nothing
 *    here argues they are worth keeping executable, only worth remembering.
 *
 *    The over-allocated tail is real (Arsenal 2023/24 summed to 13.32) but the
 *    model is not wrong about those individuals, only about the sum, and there
 *    is no evidence here for which of them to demote.
 *
 *  - RECORD-LESS PLAYERS ONLY absorb the deficit. This bullet has carried three
 *    different sets of numbers and it is worth saying why, because the lesson is
 *    not about the scope at all.
 *
 *    The original claim was .1953 for record-less-only against .1967 for
 *    spreading over everyone. Rebuilding the apparatus (`preseasonBrier.test.ts`
 *    — it had never been checked in) reversed the sign: .1989 against .1971, the
 *    rejected alternative ahead by .0018. Two defects were behind that, and both
 *    are now fixed. The .1989 figure was measured at a target of 10.0 and never
 *    updated when `preseasonClubStartMass` moved to 9.6. And the population it
 *    was measured on came from `players_raw.csv`, which is the END-OF-SEASON
 *    dump: January signings inflated every club's summed `pStart` above target,
 *    so the correction hardly fired and the comparison was between two rules
 *    that were both mostly asleep. Filtering on `team_join_date` moves the
 *    archive into the same regime as a live August bootstrap — 10 and 11 clubs
 *    of 20 below target on the two archive seasons that carry the column,
 *    against 12 of 20 on the live 2026/27 snapshot (COV 4.86, HUL 5.04, IPS
 *    6.06, FUL 7.65, BOU 7.74, EVE 8.03, then six clubs between 9.1 and 9.6).
 *    An earlier version of this bullet said 15 of 20; that number was never
 *    measured and does not reproduce.
 *
 *    THE SNAPSHOT FIGURES ARE ALL OUTFIELDERS WITH THE MECHANISM OFF, and the
 *    regime has to be stated because there are four of them and they disagree.
 *    Summing over the LAUNCH POOL instead gives 15 of 20 and a different
 *    ordering, and it is the wrong measure however natural it looks: this rule
 *    allocates over a club's whole element list, so summing a subset of that
 *    list must come out under target and "short" stops meaning anything. Two
 *    paragraphs in this file were quoting one regime each, twenty lines apart,
 *    which is how the club ordering came out inverted in one of them.
 *    `LIVE=1` prints all four regimes side by side.
 *
 *    Measured properly, at target 9.6 on the joined-by-GW1 population with
 *    `preseasonRecordlessMaxPStart` at 0.55, the two scopes are the same rule:
 *
 *        scope           n   Brier  Brier(ev)  Brier(no)   23-24   24-25   25-26
 *        recordless   5680  0.1958     0.1970     0.1899  0.1986  0.1888  0.1999
 *        all          5680  0.1956     0.1969     0.1893  0.1989  0.1881  0.1997
 *
 *        paired bootstrap, "all" minus "recordless": -0.00017 [-0.00167, +0.00117]
 *
 *    So the Brier no longer argues against what ships, and record-less-only
 *    keeps the seat on the argument it always had: a club is short precisely
 *    where its squad has no record, and confining the correction to the players
 *    the model already admits it cannot score keeps it from reaching the ones it
 *    scores well. `Brier(ev)` moving at all under `"all"` is that reach showing
 *    up. The real defect the rebuild found was never the scope — it was the
 *    ceiling, and it is fixed under `preseasonRecordlessMaxPStart`.
 *
 *  - PROPORTIONAL, not flat. The deficit is shared in ratio to each player's
 *    existing `pStart`, so the price-and-ownership ordering `priorPStart`
 *    established inside the club is preserved and only the level moves. A flat
 *    share would tell a promoted club's £4.0m fifth-choice striker and its
 *    £5.5m captain that they are equally likely to play.
 *
 * The cap is redistributive rather than destructive, for the same reason the
 * keeper depth chart's is: probability taken off a player who has hit
 * `preseasonMaxPStart` belongs to someone, and the someone is whoever still
 * has room. Returns only the players whose `pStart` changes.
 */
function clubStartMass(
  players: { id: number; pStart: number; hasEvidence: boolean }[],
  target: number,
  maxPStart: number,
  scope: "recordless" | "all" = "recordless",
  recordlessMax: number = maxPStart,
  spill = false,
  down = false
): Map<number, number> {
  const out = new Map<number, number>();
  // "This club will field ten outfielders" says nothing about a set that does
  // not contain ten candidates. A real bootstrap never trips this — the archive
  // seasons list 22-50 outfielders per club (27-50 on 2023-24, whose list is
  // the unfiltered end-of-season dump, and 25-37 and 22-40 on the two seasons
  // filtered to a genuine GW1 squad; `preseasonBrier.test.ts` prints the range
  // per season, and an earlier version of this line quoted the 2023-24 figure
  // for all three) — but a partial squad does, and there the rule stops being
  // an accounting identity and becomes an
  // extrapolation: told to find ten starts among two men it multiplies both by
  // twelve and pins them at the ceiling, which erases the very ordering the
  // rest of the model spent its evidence establishing.
  if (players.length < target) return out;
  const total = players.reduce((s, p) => s + p.pStart, 0);
  const want = target - total;
  // UP ONLY unless `down` is set, which only the measurement harness sets. A
  // club already at or over target returns here having moved nobody; see
  // `preseasonClubStartMassDown` for why the refuted branch stays reachable.
  // (Written as a negation of the old guard rather than `want === 0 || ...` so
  // that a NaN target still returns early, as it always did.)
  if (!(want > 0) && !(down && want < 0)) return out;

  /**
   * A player's own ceiling, which is NOT the same number for everyone.
   *
   * `maxPStart` is what the model will say about a player it has evidence
   * about: an ever-present who came through `preseasonMinutes` at the top of
   * his club's order. A record-less player has, by construction, no evidence
   * that he starts at all — his `pStart` is a price-and-ownership prior — and
   * letting a club's accounting deficit push him to the SAME ceiling asserts
   * that an unowned unknown is as nailed as a proven starter. See
   * `preseasonRecordlessMaxPStart` for the calibration table that measures it.
   *
   * THERE IS DELIBERATELY NO SET-PIECE TERM HERE, and an earlier version of
   * this block carried one — `Math.max(recordlessMax, p.setPieceFloor ?? 0)` —
   * on the argument that a designated penalty taker would otherwise arrive at
   * `pStart` 0.75, be excluded from `movable` for sitting above a 0.55 cap, and
   * be frozen out of a lift his club's accounting says he should share in. That
   * argument describes a real hazard and the term did not avert it: the term
   * was a NO-OP in every configuration, including the one it was written for,
   * and an audit killed it by mutation. The proof is two lines.
   *
   * With `preseasonRecordlessCapExemptsSetPieces` ON, `preseasonMinutes`
   * returns `max(min(prior, globalCap), floor)`, which is `>= floor`
   * unconditionally. Either `recordlessMax > floor`, in which case the `max`
   * changes nothing and the two forms are literally equal; or `floor >=
   * recordlessMax`, in which case the term makes `capOf` at most `floor`, and
   * `pStart < capOf` needs `pStart < floor`, which cannot happen. Without the
   * term `capOf <= floor <= pStart`, so he is not movable either. He is not
   * movable under EITHER form, so the branch the term exists to reach is
   * unreachable. With the exemption OFF — what ships — `setPieceFloor` was
   * passed in as a literal 0 and the term was dead twice over.
   *
   * So a set-piece taker is frozen at his floor regardless, and that is the
   * behaviour `preseasonRecordlessCapExemptsSetPieces` was measured at and
   * refuted at. Restoring a set-piece exemption means changing this function,
   * not restoring one line to it.
   */
  const capOf = (p: { hasEvidence: boolean }) =>
    p.hasEvidence ? maxPStart : Math.min(maxPStart, recordlessMax);

  /**
   * Scale `pool` up so the club reaches its target, respecting each player's
   * own ceiling, and return whatever mass could not be placed.
   *
   * Repeated because capping one player raises the multiplier for the rest and
   * can push the next man over in turn. It terminates: every pass either
   * finishes or caps somebody, and a capped player never becomes movable again.
   *
   * `need` is negative only under `preseasonClubStartMassDown`. In the ordinary
   * case that path needs no separate code — `k` comes out below 1, so nothing
   * can exceed its ceiling, `capped` is empty on the first pass and the loop
   * returns after one scaling. There is ONE place that assumed `need >= 0` and
   * it is marked below: `want2 <= 0` reads as "nothing left to place" going up
   * and as "the surplus exceeds the whole pool" going down, and the two want
   * opposite handling.
   */
  const allocate = (pool: typeof players, need: number): number => {
    // A player already at or above his own ceiling is not movable. Dropping him
    // rather than capping him is what keeps this function UP ONLY, and that is
    // load-bearing in two places: the doc block above claims no player is ever
    // moved downward, and the `liftedPStart` block in `preseasonMinutes`'s
    // caller reinstates the observed `share` floor with a `max` that is only
    // safe while `lifted >= mm.pStart`. (Both hold for every shipped setting.
    // `preseasonClubStartMassDown` breaks the second on purpose and is a
    // harness-only switch for that reason; its doc block says so.)
    //
    // It only became reachable when `recordlessMax` arrived. While every cap
    // equalled `maxPStart`, `preseasonMinutes` had already clamped `pStart`
    // there, so `capOf(p) >= p.pStart` held for everyone and the old
    // `p.pStart > 0` filter was up-only by accident. With a record-less ceiling
    // below `maxPStart`, a record-less player whose own evidence-free prior
    // sits above it would have been PUSHED DOWN to it — and only in clubs that
    // happen to be short of target, since a club at target returns early. That
    // is a different intervention wearing this one's name: not "cap how far the
    // deficit may carry a man" but "clamp record-less players, in some clubs".
    // If clamping is what is wanted it belongs in `preseasonMinutes`, where it
    // would apply to every club alike and could be measured as itself.
    // THE CEILING TEST IS AN UPWARD TEST AND IS DROPPED WHEN SCALING DOWN. A
    // ceiling says "do not let a club's accounting carry this man higher than
    // his evidence supports"; it has nothing to say about moving him lower, and
    // reading it as a two-sided membership test makes a player pinned at his
    // cap immune to down-normalisation. That is not a harmless conservatism —
    // it would have made the measurement behind the UP ONLY bullet weaker than
    // the alternative it claims to refute, and on the fixture in "leaves a club
    // that already has eleven starters alone" it makes the down branch a
    // complete no-op, because every record-less player at an expensive club
    // arrives at 0.55 already. `need < 0` only happens under
    // `preseasonClubStartMassDown`, so nothing shipped takes this path.
    let movable = pool.filter((p) => p.pStart > 0 && (need < 0 || p.pStart < capOf(p)));
    let want2 = need + movable.reduce((s, p) => s + p.pStart, 0);
    for (let pass = 0; pass <= players.length; pass++) {
      const base = movable.reduce((s, p) => s + p.pStart, 0);
      if (base <= 0) break;
      // WANTED MASS AT OR BELOW ZERO MEANS DIFFERENT THINGS IN THE TWO
      // DIRECTIONS, and reading it the upward way in the downward case is how
      // this switch was first made to under-fire. Going up it means "there is
      // nothing left to place", so stopping is right. Going down it means the
      // club's surplus is larger than everything this pool holds — and
      // stopping then writes NOTHING, leaving the club exactly where it was.
      //
      // That is not conservatism, it is silent inertness, and it lands on
      // precisely the clubs the branch exists to test: an audit measured the
      // first version as a no-op on 22 of 35 eligible club-seasons, including
      // Arsenal 2023/24, which is the very example the UP ONLY bullet cites as
      // the over-allocated tail. A refutation whose mechanism skips its own
      // headline case is not a refutation. Shed everything the pool has and
      // report what could not be shed.
      if (want2 <= 0) {
        if (need >= 0) break;
        for (const p of movable) out.set(p.id, 0);
        // ZERO, NOT `-want2`, EVEN THOUGH `-want2` IS THE TRUE UNSHED SURPLUS.
        // The only consumer of this return value is `spill`, and `spill` is
        // refused under `down` because "still this far OVER target" is not
        // something an upward allocator can absorb. So the honest number would
        // be dead on arrival — the first draft returned it and a mutation to 0
        // survived the whole suite, which is the definition. Returning 0 also
        // fails safe: if the spill guard is ever relaxed, this does nothing
        // rather than pushing the has-record players UP to soak a surplus.
        return 0;
      }
      const k = want2 / base;
      const capped = movable.filter((p) => p.pStart * k > capOf(p));
      if (capped.length === 0) {
        for (const p of movable) out.set(p.id, p.pStart * k);
        return 0;
      }
      for (const p of capped) {
        out.set(p.id, capOf(p));
        want2 -= capOf(p);
      }
      movable = movable.filter((p) => p.pStart * k <= capOf(p));
    }
    // Everyone left is at his ceiling. What is still wanted is the mass the
    // club is short by that this pool cannot legitimately hold.
    return Math.max(0, want2 - movable.reduce((s, p) => s + p.pStart, 0));
  };

  const primary = players.filter((p) => (scope === "all" || !p.hasEvidence) && p.pStart > 0);
  if (primary.length === 0) return out;
  const leftover = allocate(primary, want);

  // SPILL. With a record-less ceiling in force, a club whose squad is short but
  // whose record-less players are few — the shape that produces the pathology
  // this ceiling exists for, a settled club with one or two unknowns — cannot
  // reach its target through them without saying something false about them.
  // The remainder then has two possible homes: nowhere, which leaves the club
  // asserting it will field fewer than ten outfielders, or the rest of the
  // squad, which is where the shirts actually go. Spilling is off unless asked
  // for, because it reaches players the model already scores on evidence and
  // that is the objection that kept the correction record-less-only.
  // NOT UNDER `down`. A leftover from a downward pass means "the club is still
  // this far OVER target", and `allocate` only ever moves a pool toward the
  // mass it is handed — so passing it on would push the has-record players UP
  // to absorb a surplus. The two features are independent and their
  // composition is not defined; refusing it is cheaper than defining it, and
  // `preseasonClubStartMassDown` is a measurement switch that no shipped
  // configuration reaches. (Before the `want2 <= 0` case above was fixed the
  // leftover was provably always 0 here, so this was inert rather than
  // correct.)
  if (spill && leftover > 1e-9 && scope !== "all" && !down) {
    const rest = players.filter((p) => p.hasEvidence && p.pStart > 0);
    // The players already placed keep the values they were given; `allocate`
    // writes `out` per player, and `rest` is disjoint from `primary` here.
    if (rest.length > 0) allocate(rest, leftover);
  }
  return out;
}

/** Starts-based minutes model with a pre-season prior fallback. */
function minutesModel(
  el: Element,
  teamGames: number,
  recent?: RecentForm,
  past?: PastSeasonStats,
  seasonStartYear = new Date().getUTCFullYear(),
  ownPct?: number
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
    return preseasonMinutes(el, past, seasonStartYear, ownPct);
  }
  // Recency: what happened in the last ~5 team games outweighs the season
  // average (a new nailed starter, a lost place, a returning injury).
  if (recent != null) {
    const w = XP_CONFIG.recentStartsWeight;
    const pStart = clamp(w * recent.startShare + (1 - w) * mm.pStart, 0, 1);
    let minsPerStart = mm.minsPerStart > 0 ? mm.minsPerStart : recent.startShare > 0 ? 75 : 0;
    // Recent minutes, on the axis the start share does not touch. `minsPerStart`
    // is MEASURED over the rounds he started, not reconstructed by dividing his
    // per-game minutes by his start share — that quotient charged every bench
    // minute to the starts and promoted exactly the substitute the start share
    // exists to demote. Null when he started none of the last five, in which
    // case there is nothing to say about how long his starts last and his
    // minutes are carried by the depressed `pStart` and the floor below.
    // The second condition enforces the record's invariant rather than the
    // arithmetic: `minsPerStart` is non-null EXACTLY when `startShare > 0`, and
    // the line above therefore leaves the running value at 0 only for a player
    // with no starts anywhere — for whom a minutes-per-start figure is a
    // contradiction. Three independent places build these records (the live
    // fetch, the backtest and the simulator), so the invariant is checked here
    // rather than assumed.
    const wm = XP_CONFIG.recentMinutesWeight;
    if (recent.minsPerStart != null && minsPerStart > 0) {
      // Clamped at a full match because the archive harnesses feed this too and
      // 90 is the domain boundary. Both sides of the blend are then within
      // [0, 90], so the result is as well and needs no second clamp.
      const recentMps = clamp(recent.minsPerStart, 0, 90);
      minsPerStart = wm * recentMps + (1 - wm) * minsPerStart;
    }
    // The same one-sided floor the PRE-SEASON path has carried all along (see
    // `observedShare` above): a regular substitute plays real minutes that
    // `pStart * minsPerStart` throws away. In-season that omission was worse
    // than pre-season, because this branch OVERWRITES the season `share` the
    // block above computed from actual minutes: a player who has never started
    // came out at `{0, 0, 0}` and was modelled at the 0.03 floor in `xMins`,
    // however many minutes he was really playing. A floor can only ever raise a
    // player, so nobody who does start is demoted by it.
    const subFloor = mm.pStart === 0 ? recent.minsPerGame / 90 : 0;
    const share = Math.max((pStart * minsPerStart) / 90, subFloor);
    return { pStart, minsPerStart, share: clamp(share, 0, 1) };
  }
  return mm;
}

/**
 * P(on the pitch at 60 minutes | he started), from `minsPerStart`.
 *
 * See `XP_CONFIG.p60Curve` for where the two constants come from. Zero is
 * returned unchanged rather than fed to the curve: `minsPerStart === 0` is the
 * model's "he does not start" state, not a claim that his starts last no time,
 * and it always arrives with `pStart === 0` beside it.
 */
export function p60GivenStart(minsPerStart: number): number {
  if (minsPerStart <= 0) return 0;
  const c = XP_CONFIG.p60Curve;
  return 1 / (1 + Math.exp(-(c.intercept + c.slope * minsPerStart)));
}

/**
 * Availability multiplier for a yellow-card ban the player has NOT yet earned.
 *
 * A man on four bookings is one tackle away from missing a match, and until
 * that tackle happens his `status` is a blameless "a" and the model treats him
 * as certain to play for the whole horizon. Measured over the four archived
 * seasons, among established starters (>=4 starts in their last 5) who played
 * the current round and were not sent off in it:
 *
 *                                          n    missed NEXT round      se
 *   not one booking from a ban         16012          0.0837        0.0022
 *   one from 5, but past match 19       1565          0.0799        0.0069
 *   one from 10, but past match 32       126          0.0635        0.0217
 *   one from 5, inside the window        465          0.2301        0.0195
 *   one from 10, inside the window        52          0.1538        0.0500
 *
 * The two middle rows are most of the reason to believe the rest. They are the
 * placebo arm: players carrying the same card count, whose threshold window has
 * closed so that count cannot ban them. They sit on the baseline, which is what
 * you would expect if the top rows are the RULE biting and not a confound about
 * the sort of player who collects bookings. An earlier version of this table
 * pooled the in-window and out-of-window cases and reported 0.2362 and 0.1370;
 * that was diluted by the placebo group and is superseded by the split above.
 *
 * The placebo is good but it is not a clean experiment, and an earlier draft of
 * this comment claimed it was. Membership is not random in two ways. A player
 * needs MORE than 19 matches to reach four cards to land in the placebo group,
 * so by construction it holds the slower card-collectors — the lower-q half of
 * the same population. And the split is collinear with the calendar: every
 * placebo observation is late-season, where rotation and dead rubbers move the
 * baseline, while the 0.0837 row pools the whole year. Both push the placebo
 * rate DOWN relative to a perfectly matched control, so the 0.146 gap is an
 * upper bound on the effect rather than an unbiased estimate of it. It is a
 * large gap and the mechanism is a written rule, so the direction is not in
 * doubt; the magnitude carries more uncertainty than the standard errors say.
 *
 * A related caution about the arithmetic below. It is the law of total
 * probability applied to a partition of the same sample, so it CANNOT fail —
 * for a real effect or a spurious one — and a previous version of this comment
 * presented it as "predicted against observed" corroboration, which it is not.
 * What it does show is the composition: nearly all of the excess is carried by
 * the players who actually got booked, at a conditional miss rate near 1. That
 * rules out the alternative story in which one-from-a-ban players are simply
 * rested, which would spread the excess across booked and unbooked alike:
 *
 *   one from 5:   P(card)=0.1591, miss|card=0.9865, miss|none=0.0870
 *   one from 10:  P(card)=0.1538, miss|card=0.8750, miss|none=0.0227
 *
 * A booked player on the line misses the next round essentially always, and an
 * unbooked one reverts to roughly the baseline. That is a ban, not a rotation
 * policy, and it is the shape this function encodes.
 *
 * Two places where the pricing is knowingly off its own measurement, both
 * recorded rather than tuned away. At five cards the term charges the full
 * q = 0.1684 while the measured excess is 0.2301 - 0.0837 = 0.1464, so it runs
 * about 15% hot — within a standard error, and in the direction the placebo
 * bias above says the measurement is understated, but hot. At ten the row is
 * thin (52 observations, 8 of them bookings) and its excess of 0.070 +/- 0.050
 * sits below the 0.165 charged. Neither gap justifies a separate fitted rate on
 * samples this size; both are the weakest part of the term.
 *
 * What is modelled is only the FORWARD risk. State that precisely, because the
 * loose version of it is wrong: when the imminent event is a SINGLE fixture the
 * multiplier is exactly 1, bit for bit, so this week's eleven and captain cannot
 * move. When the imminent event is a DOUBLE, the second leg is discounted — he
 * can be booked in the first leg and banned for the second, and pretending
 * otherwise would be a modelling error rather than a safety guarantee.
 *
 * That boundary was found by measurement, not by reading the code. Neutralising
 * the term entirely reproduces the PRE-CHANGE backtest reports byte for byte;
 * neutralising it for singles only leaves the post-change ones unchanged. Read
 * that as ONE experiment and its complement rather than as three independent
 * measurements — an earlier draft of this comment presented it as a triple, and
 * the second half is forced once the first holds. The backtest grades offset 0
 * and nothing else, so it puts every single offset-0 difference in doubles.
 *
 * Three of the four season reports move and 2023-24 does not, but the reason is
 * not the one first written here. It is NOT that 2023-24's doubles fall after
 * the five-card window has shut: two of its 23 team-doubles sit at team match 7,
 * squarely inside [5, 19], and six more at matches 25-28 sit inside the open
 * [10, 32]. Meanwhile the 2024-25 and 2025-26 reports both moved with ZERO
 * doubles inside the five-card window, entirely through the ten-card threshold.
 * The actual discriminator is player-level: no player at a 2023-24 doubling club
 * happened to be one card short of an open threshold. Which also sets the honest
 * scale of "three of four seasons move" — it rests on ten player-double-events
 * across four seasons (7, 0, 1, 2), so it is a demonstration that the channel is
 * live, not a measurement of how much it is worth.
 *
 * The corollary for the backtest is worth stating where someone will trip over
 * it: a green accuracy report there is NOT silence about this term. Doubles are
 * the one channel by which it can reach that harness, so the report is weak
 * evidence about exactly that channel and nothing about the rest.
 *
 * A ban that has already been incurred is FPL's own business: it sets `status` to
 * "s", `availabilityAt` handles it, and it knows whether the ban has been
 * served. Inferring a live ban from the card count instead would mean tracking
 * service state from match history, and getting that wrong benches a player who
 * is available. The count is trusted for what it unambiguously says — how far
 * he is from the line — and nothing more.
 *
 * The arithmetic is a negative binomial, counted in the club's MATCHES rather
 * than in gameweeks. Writing q for his per-match booking probability and `need`
 * for the cards still required, the need-th booking arrives in match j with
 * probability C(j-1, need-1) q^need (1-q)^(j-need), and the ban is then served
 * in match j+1. This function returns one probability PER LEG, and counting in
 * matches rather than events is what makes a double gameweek come out right in
 * both directions: two matches are two chances to be booked, and a one-match ban
 * costs one leg rather than both. Which leg matters, so the legs are not
 * interchangeable and `projectAll` weights each by what that fixture is worth;
 * `suspensionAvail` is the equal-weight summary and is exact only when the legs
 * are.
 *
 * One ban per threshold: reaching the NEXT one inside a planning horizon needs
 * five more cards and is not modelled. Nor is the fact that the ten-card
 * threshold carries two matches and the fifteen-card one three — all three are
 * priced as one match, which understates the two deeper ones.
 *
 * How rare, measured rather than guessed, over the four archived seasons: three
 * players a season reach ten cards inside the window, and NOBODY reached fifteen
 * in any of the four — the highest season totals are 14, 13, 12 and 12. So the
 * [15, 38] row has never once fired against the evidence base, and the [10, 32]
 * row fires for about three players a year. An earlier version of this comment
 * said "thirteen times a season" at ten and "about one player a season" at
 * fifteen; the first was the count of one-from-ten player-ROUNDS divided by four
 * (a man sitting on nine for six weeks is six rows, not six players) and the
 * second was simply wrong. Corrected here because it argues the same conclusion
 * more strongly: modelling two- and three-match bans properly would be fitting
 * machinery to events that have not happened.
 *
 * Three known conservatisms, all deliberate. Bookings are charged only to
 * starts, so a rotation player's risk is understated by roughly the substitute
 * half of his appearances (a substitute is booked at 0.0725 against a starter's
 * 0.1547). The two deeper thresholds are priced as one-match bans. And the ban
 * is always charged against the next Premier League fixture, when from January
 * it may instead be served in a cup tie that costs no FPL points at all — that
 * one runs the other way, and is an over-charge.
 *
 * A note for whoever tidies this later: the `j < 1` and `j < need` guards are
 * each redundant GIVEN the other, and mutation testing duly found both
 * survivable one at a time. They are not redundant together, and deleting both
 * is caught. With neither, an imminent single fixture evaluates the binomial at
 * C(-1, 0) = 1 and (1-q)^(-1), i.e. q/(1-q) — a positive suspension risk
 * charged to the one gameweek this function must leave alone. Keep both.
 *
 * @param matchesBefore   club matches between now and this event, exclusive.
 *                        0 for the imminent event, which is what makes this
 *                        function a no-op there when that event is a single.
 * @param matchesThis     club matches IN this event: 1 normally, 2 in a double,
 *                        0 in a blank.
 * @param teamGamesPlayed matches his club has already completed
 * @param pStart          P(he starts) — already multiplied by his declared
 *                        availability, so a man FPL has ruled out collects no
 *                        cards in the matches he is going to miss.
 */
export function suspensionMissProbs(
  el: Element,
  matchesBefore: number,
  matchesThis: number,
  teamGamesPlayed: number,
  pStart: number
): number[] {
  if (matchesThis <= 0) return [];
  const out = new Array<number>(matchesThis).fill(0);
  const yellows = el.yellow_cards ?? 0;
  const q = clamp((XP_CONFIG.bookingRate[el.element_type] ?? 0) * clamp(pStart, 0, 1), 0, 1);
  if (q <= 0) return out;

  // The first threshold he has not already passed. Passing one does not clear
  // the count — five cards then puts him on the road to ten — so this is a
  // strict "which line is next", not a reset.
  const t = XP_CONFIG.banThresholds.find(([cards]) => yellows < cards);
  if (!t) return out;
  const [cards, byMatch] = t;
  const need = cards - yellows;

  for (let p = 0; p < matchesThis; p++) {
    // `j` indexes the match whose booking triggers the ban; the ban is served in
    // match `j + 1`, which is leg `p` of this event.
    const j = matchesBefore + p;
    if (j < 1) continue; // the trigger would have to be a match already played
    if (j < need) continue; // too few matches so far to have collected the cards
    if (teamGamesPlayed + j > byMatch) continue; // outside the threshold's window
    // C(j - 1, need - 1) q^need (1-q)^(j - need)
    let coeff = 1;
    for (let i = 0; i < need - 1; i++) coeff = (coeff * (j - 1 - i)) / (i + 1);
    out[p] = coeff * Math.pow(q, need) * Math.pow(1 - q, j - need);
  }
  return out;
}

/**
 * The same risk collapsed to a single multiplier, weighting every leg of the
 * event equally. Exact for a single fixture and for a double whose two legs are
 * worth the same; `projectAll` does not use it, because a double's legs are
 * generally NOT worth the same and the leg at risk is specifically the later
 * one. Kept because it is the honest one-number summary of the term, and most
 * of the arithmetic unit tests are written against it — but not all of them, as
 * this comment used to claim: the per-leg allocation is asserted directly
 * against `suspensionMissProbs`, which is the only way to see it at all.
 */
export function suspensionAvail(
  el: Element,
  matchesBefore: number,
  matchesThis: number,
  teamGamesPlayed: number,
  pStart: number
): number {
  if (matchesThis <= 0) return 1;
  const probs = suspensionMissProbs(el, matchesBefore, matchesThis, teamGamesPlayed, pStart);
  let missed = 0;
  for (const p of probs) missed += p;
  return clamp(1 - missed / matchesThis, 0, 1);
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
  // Only what FPL has ALREADY declared — injured, doubtful, banned. Risk of a
  // ban he has not yet earned is priced once per EVENT rather than here; see
  // `suspensionMissProbs` and its call site in `projectAll` — `suspensionAvail`
  // is only the equal-weight summary and is not what `projectAll` calls. Doing
  // it per fixture charged a one-match ban against both legs of a double.
  const avail = availabilityAt(el, gwOffset, kickoffTime(fixture));
  if (avail === 0) return 0;
  const p60 = avail * mm.pStart * p60GivenStart(mm.minsPerStart);
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
  // Read once for the whole projection rather than per player: it is a sort per
  // position, and `minutesModel` is called ~700 times.
  const ownPct = ownershipPercentiles(ctx.bootstrap.elements);

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
      //
      // ALL OF WHICH IS CURRENTLY INERT, and the comment above would read as
      // load-bearing without this line. `gkPreseason.minutesWeight` is 0, so
      // `mins` is multiplied by zero three lines down and nothing in this
      // paragraph reaches a projection; the 1.92x/1.015x figures were measured
      // at the old nonzero weight. It is kept computed and kept documented
      // because the weight is the thing under review, not the units bug — see
      // `minutesWeight` for the seven-way refutation of the record term, and
      // note that if the weight ever returns this bug returns with it.
      const ev = preseasonEvidence(el, ctx.pastSeason?.get(el.id), seasonStartYear);
      const mins = ev && ev.games > 0 ? (ev.minutes / ev.games) * cfg.preseasonSeasonGames : 0;
      // Absent for a whole position at once — `ownershipPercentiles` drops a
      // position, never a player — so within a club it is all keepers or none,
      // and a zero here cannot advantage one man over his rival by accident.
      const q = ownPct.get(el.id);
      const crowd = q == null ? 0 : Math.pow(q, cfg.priorPStartOwnGamma) * g.ownWeight;
      const score =
        el.now_cost / 10 +
        (Math.min(mins, g.minutesCap) / g.minutesCap) * g.minutesWeight +
        crowd;
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
        const av = list.map((k) => availabilityAt(k.el, off, kickoff));
        const sum = list.reduce((acc, _, i) => acc + av[i] * raw[i], 0);
        if (!Number.isFinite(sum) || sum <= 0) continue;
        // The club's start mass, divided up. This sums to `slotMass` exactly,
        // by construction, and it is the only quantity here that is a
        // probability in its own right.
        const p = list.map((_, i) => ((av[i] * raw[i]) / sum) * g.slotMass);
        // What gets STORED is conditional on the keeper being fit, because
        // `fixtureXp` multiplies availability back in for every player alike.
        // Dividing it out is what makes the cap below dangerous rather than
        // decorative: a doubtful number one's conditional share legitimately
        // exceeds 1 — at availability 0.5 against a clear deputy it is 1.632,
        // which multiplies back to a perfectly sensible 0.816 — and clamping it
        // to 0.97 deleted a third of a start probability that belonged to
        // somebody. The club's keepers then covered 0.60 of a shirt between
        // them instead of 0.95, and the man who lost most by it was the DEPUTY,
        // whose whole reason for being in the pool is that the incumbent is
        // doubtful. That directly undid what the availability-weighted
        // denominator above is for.
        //
        // So the cap still applies — nobody is more than `preseasonMaxPStart`
        // certain to start a game he is fit for — but the probability it takes
        // off is real and is pushed onto the keepers who have room for it,
        // in proportion to their own weight, rather than thrown away. Repeated
        // because a redistribution can push the next man over the cap in turn;
        // it converges in at most one pass per keeper.
        const cond = list.map((_, i) => (av[i] > 0 ? p[i] / av[i] : 0));
        for (let pass = 0; pass < list.length; pass++) {
          let spare = 0;
          const room: number[] = [];
          for (let i = 0; i < cond.length; i++) {
            if (cond[i] > cfg.preseasonMaxPStart) {
              spare += (cond[i] - cfg.preseasonMaxPStart) * av[i];
              cond[i] = cfg.preseasonMaxPStart;
            } else if (av[i] > 0) room.push(i);
          }
          const wsum = room.reduce((s, i) => s + av[i] * raw[i], 0);
          if (spare <= 0 || wsum <= 0) break;
          for (const i of room) cond[i] += (spare * raw[i]) / wsum;
        }
        list.forEach((_, i) => {
          shares[i][off] = clamp(cond[i], 0, cfg.preseasonMaxPStart);
        });
      }
      list.forEach((k, i) => gkPStart.set(k.id, shares[i]));
    }
  }

  // The outfield equivalent of the keeper depth chart above: a club hands out
  // ten outfield starts a match and `priorPStart` has no way to know it, so a
  // club whose squad the league has priced cheaply is left several starters
  // short. See `preseasonClubStartMass` and `clubStartMass`.
  //
  // Keepers are excluded because the block above has already allocated their
  // one shirt by club, and running both would count the same normalisation
  // twice.
  const liftedPStart = new Map<number, number>();
  if (cfg.preseasonClubStartMass > 0) {
    const byClub = new Map<number, { id: number; pStart: number; hasEvidence: boolean }[]>();
    for (const el of ctx.bootstrap.elements) {
      if (el.element_type < 2 || el.element_type > 4) continue;
      // Pre-season only, per club, on the same test the keeper block uses.
      // Once a club has kicked off, who it actually picked is an observation
      // and no club-level accounting improves on watching.
      if ((st.gamesByTeam.get(el.team) ?? st.playedGws) > 0) continue;
      const p = ctx.pastSeason?.get(el.id);
      const list = byClub.get(el.team) ?? [];
      list.push({
        id: el.id,
        pStart: preseasonMinutes(el, p, seasonStartYear, ownPct.get(el.id)).pStart,
        hasEvidence: preseasonEvidence(el, p, seasonStartYear) != null,
      });
      byClub.set(el.team, list);
    }
    for (const list of byClub.values()) {
      const adj = clubStartMass(
        list,
        cfg.preseasonClubStartMass,
        cfg.preseasonMaxPStart,
        cfg.preseasonClubStartMassScope,
        cfg.preseasonRecordlessMaxPStart,
        cfg.preseasonClubStartMassSpill,
        cfg.preseasonClubStartMassDown
      );
      for (const [id, p] of adj) liftedPStart.set(id, p);
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
    let mm = minutesModel(
      el,
      teamGames,
      ctx.recentForm?.get(el.id),
      past,
      seasonStartYear,
      ownPct.get(el.id)
    );
    // `share` is recomputed rather than left alone, so that the three fields of
    // the struct keep agreeing with each other after `pStart` moves.
    //
    // The old form here was a bare `lifted * minsPerStart / 90`, justified by
    // "only ever set for a record-less outfielder, whose share is exactly
    // that". The first half of that stopped being true when
    // `preseasonClubStartMassScope` gained the `"all"` setting, and the second
    // half was only ever true for record-less players: `preseasonMinutes`
    // floors `share` at the OBSERVED one, `minutes / (games * 90)`, precisely
    // so that a genuine substitute's real minutes are not thrown away by
    // `pStart * minsPerStart`. Recomputing from scratch would have dropped that
    // floor for exactly the players the floor exists for.
    //
    // `max` against the existing share restores it without needing to recompute
    // it, and is safe because `clubStartMass` is up-only: `lifted` is never
    // below the `pStart` that produced `mm.share`, so the max cannot resurrect
    // a stale larger value. That holds for every shipped setting;
    // `preseasonClubStartMassDown` is the one switch that breaks it, which is
    // why it is a measurement switch and not a candidate.
    const lifted = liftedPStart.get(el.id);
    if (lifted != null) {
      mm = {
        pStart: lifted,
        minsPerStart: mm.minsPerStart,
        share: clamp(Math.max((lifted * mm.minsPerStart) / 90, mm.share), 0, 1),
      };
    }
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
    // REPLACES, and that includes replacing the record-less clamp
    // `preseasonMinutes` applied a few frames up the stack. Deliberate, not an
    // oversight: see `preseasonRecordlessGlobalCap` for why a zero-sum
    // allocation of one shirt is the wrong place to express "we have never seen
    // this man play", and `preseason.test.ts` for the test that pins it.
    mm = gkMm(0) ?? mm;
    if (XP_DEBUG.minutes) {
      XP_DEBUG.minutes.set(el.id, {
        ...mm,
        preseason,
        hasEvidence: preseasonEvidence(el, past, seasonStartYear) != null,
      });
    }
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
    // Club matches between now and the event being projected. Not the same as
    // the gameweek offset once a blank or a double is in the horizon, and it is
    // the match count that the suspension term needs: two legs of a double are
    // two chances to be booked, a blank is none.
    let matchesBefore = 0;
    for (let gw = ctx.nextEvent; gw < ctx.nextEvent + horizon && gw <= lastEvent; gw++) {
      const fx = fxIndex.get(gw)?.get(el.team) ?? [];
      const off = gw - ctx.nextEvent;
      const mmGw = gkMm(off) ?? mm;
      // Kept per leg, not just summed, because the suspension term below has to
      // charge a ban against the specific match it is served in. `fx` is in
      // kickoff order (see `makeFixtureIndex`), so `legXp[0]` really is first.
      const legXp = fx.map((f) => fixtureXp(el, f, f.team_h === el.team, off, st, rates, mmGw));
      let gwXp = legXp.reduce((a, b) => a + b, 0);
      // Blend the real-world anchors — fixture-count aware (scale for DGWs,
      // skip on blanks). Build a combined target from ep_next and last season,
      // then pull the model toward it in proportion to how thin our data is.
      // Hoisted out of the blend so the suspension term can reconstruct what
      // each leg of a double is worth AFTER blending. The anchor target is a
      // per-game figure multiplied by the fixture count, so it splits evenly
      // across the legs; the model part does not.
      let blendW = 0;
      let blendLegTarget = 0;
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
        // Assigned inside the guard, not beside it. With `w === 0` the two are
        // multiplied by zero downstream and the value of `blendLegTarget` is
        // arithmetically irrelevant — but only while `target` is finite, and it
        // is finite only because `epUsable` and `pastUsable` each gate on
        // `Number.isFinite`. If either guard ever loosens, a stray `0 * NaN`
        // would poison the suspension term's `lost` and turn the whole
        // projection into NaN. Keeping them unset in the common case removes
        // that coupling rather than documenting it.
        if (w > 0) {
          gwXp = (1 - w) * gwXp + w * target;
          blendW = w;
          blendLegTarget = target / fx.length;
        }
      }
      // Yellow-card accumulation risk, applied AFTER the anchor blend and once
      // per event rather than per fixture.
      //
      // After the blend, because the anchors are as blind to a future ban as
      // they are to a current injury — `ep_next` and last season's per-game
      // output know nothing about a man on four bookings — so discounting
      // before the blend would let `target` put the points straight back.
      //
      // Per event, because a one-match ban costs one match. `pStart` is scaled
      // by declared availability first, so an already-injured or already-banned
      // player is not also charged for collecting cards in matches the model
      // has him missing.
      //
      // Subtracted per LEG rather than applied as one multiplier over the event.
      // For a single fixture the two are identical, and for a double with two
      // equal legs they are too — but a double's legs are rarely equal, and the
      // leg at risk is specifically the later one, since only a booking already
      // collected can ban him. Averaging over the two charges a cheap away trip
      // at the price of a home banker, or the reverse. Off a 6.0 and a 2.0 leg
      // with q = 0.17 the uniform version is out by a factor of two — that is
      // the WORST case for those two numbers, not the generic one: with the
      // cheap leg first and the banker second it is out by 1.5x instead.
      if (fx.length > 0) {
        const availGw = availabilityAt(el, off, kickoffTime(fx[0]));
        const probs = suspensionMissProbs(
          el,
          matchesBefore,
          fx.length,
          st.gamesByTeam.get(el.team) ?? st.playedGws,
          mmGw.pStart * availGw
        );
        let lost = 0;
        for (let p = 0; p < probs.length; p++) {
          // The blended value of leg p. These sum back to `gwXp` in real
          // arithmetic, so this cannot lose or invent points; in floating point
          // the two sides disagree by up to ~1e-14 absolute, which is why the
          // claim below is a bound and not an identity.
          lost += probs[p] * ((1 - blendW) * legXp[p] + blendW * blendLegTarget);
        }
        // `lost <= gwXp` holds without the clamp — every `probs[p]` is a
        // negative-binomial pmf term so they sum to at most 1, and both
        // `legXp[p]` and `target` are non-negative because `fixtureXp` ends in
        // its own `Math.max(0, ...)`. The clamp is belt and braces, and it is
        // also the reason the offset-0 single-fixture case stays bit-exact: with
        // `lost === 0` and `gwXp >= 0` it is the identity. If `fixtureXp` ever
        // stopped clamping, this line would quietly move every projection and
        // the `toBe` assertion in suspension.test.ts would be the only guard.
        gwXp = Math.max(0, gwXp - lost);
      }
      matchesBefore += fx.length;
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
