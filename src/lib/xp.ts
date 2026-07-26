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
   * Outfield starts a club hands out per match: eleven shirts minus the
   * keeper's. Pre-season, a club's outfielders' `pStart` is made to sum to at
   * least this — see `clubStartMass` for the mechanism and for why only the
   * players with NO Premier League record absorb the difference.
   *
   * AN EARLIER VERSION OF THIS COMMENT CALLED IT "not a fitted parameter"
   * because the sweep that could have fitted it was flat from 9.0 to 11.0
   * (.1955 / .1953 / .1953 / .1955 / .1966 at targets 9.0 / 9.5 / 10.0 / 10.5
   * / 11.0). That sweep does not reproduce on the current model, and the
   * flatness it asserted was the whole argument for taking the football number
   * on faith. Re-measured through `projectAll` at the GW1 state, scoring the
   * stored `pStart` against realised "started" per player-gameweek over GW1-5,
   * launch pool, outfield, pooled over 2023/24-2025/26 (n = 5619), and
   * independently reproduced to four decimals by a second harness:
   *
   *     target    0    7.0   7.5   8.0   9.0   9.5   9.6  10.0  10.5  11.0
   *     Brier  .2019 .1980 .1972 .1970 .1967 .1972 .1975 .1989 .2024 .2055
   *
   * The flat region is 7.5-9.5, where the sweep moves by .0005; above that it
   * climbs monotonically, and by 11.0 the mechanism is worse than being
   * switched off. Ten is not in the plateau. It sits on the rising edge and
   * gives back .0022 of the .0030 the mechanism is worth in total.
   *
   * WHY THE SHIPPED VALUE IS 9.6 AND WHY THAT IS STILL NOT A FITTED NUMBER.
   * Ten outfielders start every match; that is an identity and it is not in
   * doubt. But the identity this mechanism can act on is not the whole of it,
   * because the mechanism can only allocate over the element list it can see
   * at the deadline, and some of those ten shirts go to players who are not on
   * it yet. Counting outfield starts per match that went to players present on
   * their club's GW1 element list: 9.775 pooled over 60 club-seasons, and
   * 9.597 at the clubs this rule actually touches (9.66 / 9.50 / 9.63 by
   * season), falling to 9.43 at clubs short by a full start. The residual is
   * window signings. The same count run on goalkeepers, where one shirt is
   * likewise an identity, returns 0.993 — which is the control that says the
   * method is measuring what it claims to. So 9.6 is the visible part of the
   * ten-shirt identity, measured and stable across all three seasons, rather
   * than the low point of a sweep: the sweep's own optimum is 9.0, and 9.0 is
   * NOT what ships, because it loses in 2025/26 taken alone. At 9.6 the
   * mechanism wins in each of the three seasons separately (.2017 / .1867 /
   * .2039 against 10's .2029 / .1895 / .2043), and a paired bootstrap over
   * 4000 resamples clustered on club-season puts 9.6 against 10 at -0.00146
   * [-0.00277, -0.00041]. Set to 0 to switch the mechanism off entirely.
   *
   * A SHARPER ALLOCATION WAS TRIED HERE AND REFUTED. The obvious reading of a
   * sub-ten optimum is that the total is fine and the SHAPE is wrong: real
   * clubs concentrate ten shirts on thirteen or fourteen men, while this rule
   * spreads the deficit proportionally across every record-less outfielder,
   * including squad filler and youth who will not play at all. The descriptive
   * half of that is true — the top five record-less players hold 0.533 of the
   * predicted mass against 0.638 realised — but the conclusion drawn from it is
   * backwards. Cutting the 9-to-10 damage by within-club rank (ranked ex ante,
   * because ranking by realised starts would be circular) puts 113% of it in
   * ranks 1 and 2 and about 8% in ranks 7 and below:
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
   * outfielders came to 4.42-6.35 against an observed 8.4-10.5 for every club
   * alike. The model was giving a promoted club about five outfield starters
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
   * because established clubs do not sit above the target as a class. With the
   * mechanism off, 2023/24 reads
   *
   *     SHU   4.42     WHU   8.75     CHE   9.65     AVL  10.68
   *     BUR   5.09     EVE   9.11     BHA   9.81     MUN  10.69
   *     LUT   5.46     FUL   9.47     BRE  10.02     TOT  11.02
   *     WOL   7.64     NFO   9.49     MCI  10.44     NEW  11.56
   *     BOU   8.45     CRY   9.53     LIV  10.64     ARS  13.14
   *
   * and the other two seasons have the same shape. Over the three, established
   * clubs span 7.08 to 13.14 and 27 of the 51 established club-seasons fall
   * below the target and are lifted by this rule. Wolves are short every
   * season (7.64, 8.71, 7.08) and Everton came to 7.37 in 2025/26, none of
   * them anywhere near promotion. The conclusion outlived its example, and on
   * better evidence than the example gave it: what the correction keys on is
   * the thing that actually causes the shortfall, which is how much start
   * probability a club's own squad has failed to account for, and that is a
   * property of squads and not of promotion.
   */
  preseasonClubStartMass: 9.6,
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
  seasonStartYear: number,
  ownPct?: number
): MinutesModel {
  const cfg = XP_CONFIG;
  const prior = priorPStart(el, ownPct);
  const floor = setPieceStartFloor(el);
  const ev = preseasonEvidence(el, past, seasonStartYear);
  if (!ev) {
    const mps = cfg.preseasonUnknownMinsPerStart;
    const pStart = Math.max(prior, floor);
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
 *  - UP ONLY. A club over the target is left alone. An earlier version of this
 *    comment justified that by saying downward normalisation costs the players
 *    with a record, moving them from .1945 to .1965 because a proven starter at
 *    a deep squad would be told he is less nailed on the strength of who else
 *    the club signed. That cannot happen and never did: `movable` excludes
 *    anyone with a record, so no proven starter is reachable in either
 *    direction, and with down-normalisation switched on the has-record group is
 *    unchanged to six decimals at .194480. What down-normalisation actually
 *    costs is the record-less group, .2174 to .2312, and the pool overall,
 *    .1989 to .2016. So the choice is still right and the stated reason for it
 *    was not. The over-allocated tail is real (Arsenal 2023/24 summed to 13.14)
 *    but the model is not wrong about those individuals, only about the sum,
 *    and there is no evidence here for which of them to demote.
 *
 *  - RECORD-LESS PLAYERS ONLY absorb the deficit, and this is the one choice of
 *    the three that the measurement does not support. The claim used to be that
 *    absorbing it into the record-less players lands at .1953 against .1967 for
 *    spreading it over everyone. The sign is the other way round: record-less
 *    only lands at .1989 and spreading over everyone at .1971. Half the
 *    reasoning does hold — spreading the deficit over everyone degrades the
 *    players who already have a record, .1945 to .1969 — but it improves the
 *    record-less group by far more, .2174 to .1978, and the net favours the
 *    rejected alternative by .0018. Record-less-only is what ships because a
 *    club is short precisely where its squad has no record, and because
 *    confining the correction to the players the model already admits it cannot
 *    score keeps it from reaching players it scores well. That is an argument
 *    about where the error comes from, not a Brier result, and the Brier result
 *    does not agree with it. Anyone revisiting this should start here.
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
  maxPStart: number
): Map<number, number> {
  const out = new Map<number, number>();
  // "This club will field ten outfielders" says nothing about a set that does
  // not contain ten candidates. A real bootstrap never trips this — the archive
  // seasons list 27-50 outfielders per club — but a partial squad does, and
  // there the rule stops being an accounting identity and becomes an
  // extrapolation: told to find ten starts among two men it multiplies both by
  // twelve and pins them at the ceiling, which erases the very ordering the
  // rest of the model spent its evidence establishing.
  if (players.length < target) return out;
  const total = players.reduce((s, p) => s + p.pStart, 0);
  let want = target - total;
  if (!(want > 0)) return out;
  let movable = players.filter((p) => !p.hasEvidence && p.pStart > 0);
  if (movable.length === 0) return out;
  want += movable.reduce((s, p) => s + p.pStart, 0);
  // At most one pass per player: each pass either finishes or caps somebody,
  // and a capped player never becomes movable again.
  for (let pass = 0; pass <= players.length; pass++) {
    const base = movable.reduce((s, p) => s + p.pStart, 0);
    if (base <= 0 || want <= 0) break;
    const k = want / base;
    const capped = movable.filter((p) => p.pStart * k > maxPStart);
    if (capped.length === 0) {
      for (const p of movable) out.set(p.id, p.pStart * k);
      break;
    }
    for (const p of capped) {
      out.set(p.id, maxPStart);
      want -= maxPStart;
    }
    movable = movable.filter((p) => p.pStart * k <= maxPStart);
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
      const adj = clubStartMass(list, cfg.preseasonClubStartMass, cfg.preseasonMaxPStart);
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
    // Only ever set for a record-less outfielder pre-season, whose `share` is
    // exactly `pStart * minsPerStart / 90` — so recomputing it here reproduces
    // the branch that produced it rather than patching one field of a struct
    // and leaving the other two disagreeing with it.
    const lifted = liftedPStart.get(el.id);
    if (lifted != null) {
      mm = {
        pStart: lifted,
        minsPerStart: mm.minsPerStart,
        share: clamp((lifted * mm.minsPerStart) / 90, 0, 1),
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
