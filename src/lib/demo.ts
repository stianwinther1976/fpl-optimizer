// Built-in demo universe: a full mid-season snapshot (GW20 just played,
// one evening match still in play) so the app can be explored off-season.
// Deterministic apart from timestamps, which anchor to "now".

import type { Element, EventLive, Fixture, Pick, Transfer } from "./types";
import {
  INITIAL_BUDGET,
  MAX_FREE_TRANSFERS,
  MAX_PER_CLUB,
  VALID_FORMATIONS,
  sellingPrice,
  transferCost,
} from "./rules";
import { projectAutoSubs } from "./live";

export const DEMO_ENTRY_ID = 999999;

const TEAM_NAMES = [
  "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton",
  "Chelsea", "Crystal Palace", "Everton", "Fulham", "Leeds",
  "Liverpool", "Man City", "Man Utd", "Newcastle", "Forest",
  "Spurs", "Sunderland", "West Ham", "Wolves", "Burnley",
];

/*
 * The three-letter codes, WRITTEN DOWN rather than sliced off the names.
 *
 * `name.slice(0, 3)` collides: Manchester City and Manchester United both come
 * out "Man", so `short_name` was "MAN" for two different clubs and two
 * different players were both called "Man. Back 1". A duplicate web_name is not
 * a cosmetic problem in this app — the player search, the squad list and every
 * comparison table identify men to the reader by that string, so a transfer out
 * of one and into the other read as buying and selling the same player in the
 * same gameweek. These are FPL's own abbreviations.
 */
const TEAM_CODES = [
  "ARS", "AVL", "BOU", "BRE", "BHA",
  "CHE", "CRY", "EVE", "FUL", "LEE",
  "LIV", "MCI", "MUN", "NEW", "NFO",
  "TOT", "SUN", "WHU", "WOL", "BUR",
];

const CURRENT_GW = 20;
const DAY = 86_400_000;
// Roughly the size of the real FPL playerbase — the ceiling any rank must obey.
const PLAYER_COUNT = 11_000_000;

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The players, and specifically the INPUTS that generate them: price, quality,
 * and whether a man is nailed or a rotation option. Every counting stat a real
 * bootstrap carries — total points, goals, assists, clean sheets, minutes,
 * starts, bonus, form, points per game — is deliberately NOT set here. Those
 * are results, and they are written back at the end from the twenty gameweeks
 * the demo actually plays out.
 *
 * They used to be authored here instead, independently of the match feed, which
 * is why five goalkeepers could score a goal in GW20 and still show a season
 * total of zero goals in the same modal that reported the goal.
 */
function makeElements() {
  const elements: any[] = [];
  let id = 1;
  for (let team = 1; team <= 20; team++) {
    const q = (21 - team) / 20; // quality factor, team 1 strongest
    const mk = (t: number, i: number, xg: number, xa: number) => {
      const quality = Math.max(1, 1.5 + 4.5 * q - (i - 1) * 0.8);
      /*
       * PRICE IS A FUNCTION OF QUALITY, and of nothing else.
       *
       * It used to be handed in per position as a literal with `((id * 3) % 7)`
       * bolted on, which produced prices FPL cannot issue: a midfielder at
       * £0.8m, a defender at £2.9m, against a real floor of £3.9m. That is not
       * a cosmetic range problem. Anything that divides by price — the
       * optimizer's points-per-million, the value table, the squad builder's
       * budget arithmetic — treated those men as free points, so the demo's
       * "best value in the game" list was a list of the worst players in it.
       *
       * The bases and slopes below are FPL's actual shape: everybody starts at
       * or above £4.0m, keepers and defenders top out near £6.0m and £7.0m, and
       * only midfielders and forwards reach the double-digit prices.
       */
      const startPrice =
        [0, 40, 40, 45, 45][t] + Math.round([0, 4, 6, 15, 18][t] * (quality - 1));
      /*
       * And the season's price movement is a function of quality too. It was
       * `((id * 3) % 7) - 3` — ±0.3m assigned by id, so the players who had
       * risen were an arbitrary third of the league and the demo's team value
       * could not go anywhere. Real price movement follows performance: the men
       * everyone bought went up, the men everyone sold went down. The floor is
       * £3.8m, which is FPL's, and `cost_change_start` is then read back OFF
       * the clamped price so `now_cost - cost_change_start` is still exactly
       * the season-start price the rest of the app assumes it is.
       *
       * THE CENTRE AND THE AMPLITUDE BOTH MATTER, and the first version got
       * both wrong in the same direction. Centred at quality 3.4 — above the
       * median of the generated distribution — a majority of the league fell,
       * and since the demo manager's fifteen is repaired DOWN to a budget it
       * ends up holding a good share of the cheap end. His team value therefore
       * walked from £100.0m to £97.9m over twenty gameweeks, and then the GW1
       * squad priced out at £100.1m against a £100.0m budget and the walk threw
       * outright. A season in which the average team loses value is not a
       * season anyone recognises: the whole point of holding a rising player is
       * that he rises. Centring at 2.6 and tripling the slope gives the shape
       * FPL actually has — a long tail of small fallers, a short head of real
       * risers worth about £1.0m over half a season.
       */
      const nowCost = Math.max(38, startPrice + Math.round((quality - 2.6) * 3) + ((id * 7) % 5) - 2);
      elements.push({
        id,
        web_name: `${TEAM_CODES[team - 1]} ${["Keeper", "Back", "Mid", "Striker"][t - 1]} ${i}`,
        first_name: "Demo",
        second_name: `${TEAM_NAMES[team - 1]} ${["GK", "DEF", "MID", "FWD"][t - 1]}${i}`,
        team,
        element_type: t,
        now_cost: nowCost,
        cost_change_start: nowCost - startPrice,
        // Price Change Predictor: most players sit still, a handful of each
        // direction are near or past the threshold so the UI has something real
        // to draw. Deterministic, like the rest of the demo feed.
        price_change_percent: String(
          id % 23 === 0 ? 104 : id % 17 === 0 ? 91 : id % 19 === 0 ? -103 : id % 13 === 0 ? -88 : (id * 11) % 60
        ),
        cost_change_event: id % 23 === 0 ? 1 : id % 19 === 0 ? -1 : 0,
        /*
         * Availability, and ALL THREE FIELDS HAVE TO AGREE. The three ternaries
         * used to key off different divisors — `status` branched on `% 53` for
         * the injured case while `news` and `chance_of_playing_next_round`
         * branched on `% 37` alone — so every status-"i" player carried an empty
         * news line and a null chance. `XP_CONFIG.statusProb.i` is 0, so the
         * optimizer rated those four men at exactly 0.00 xP and ranked them
         * last of 240 while the demo's own live feed had three of them playing
         * ninety minutes, and `PlayerModal` had no text to explain why. An
         * injury is a fact about a player, not about a field.
         */
        ...(() => {
          const doubt = id % 37 === 0;
          const inj = !doubt && id % 53 === 0;
          return {
            status: doubt ? "d" : inj ? "i" : "a",
            news: doubt
              ? "Knock - 75% chance of playing"
              : inj
                ? "Hamstring injury - expected back late February"
                : "",
            chance_of_playing_next_round: doubt ? 75 : inj ? 0 : null,
          };
        })(),
        // Placeholders. Every one of these is overwritten in the season
        // write-back from what the player actually did across the twenty
        // gameweeks — they were previously left as written here, which made
        // ownership, ICT and xG pure functions of the CLUB. A club's reserve
        // keeper was published at the same 11.5% ownership as its 163-point
        // striker, so the differential/template split became a club ranking.
        selected_by_percent: (2 + 45 * q).toFixed(1),
        expected_goals: (xg * q).toFixed(1),
        expected_assists: (xa * q).toFixed(1),
        expected_goal_involvements: ((xg + xa) * q).toFixed(1),
        expected_goals_conceded: (28 - 14 * q).toFixed(1),
        ict_index: (60 + 140 * q).toFixed(1),
        /*
         * Set-piece duty, which the app surfaces on the player card and feeds
         * into its expected-points model. Absent from the demo entirely, so in
         * demo mode nobody in the league took a penalty, a free kick or a
         * corner, and the "on penalties" badge was unreachable. Each club's
         * first forward takes the penalties, its first midfielder the direct
         * free kicks, its second midfielder the corners — the ordinary shape.
         */
        penalties_order: t === 4 && i === 1 ? 1 : t === 3 && i === 1 ? 2 : null,
        direct_freekicks_order: t === 3 && i === 1 ? 1 : t === 3 && i === 2 ? 2 : null,
        corners_and_indirect_freekicks_order: t === 3 && i === 2 ? 1 : t === 2 && i === 1 ? 2 : null,
        /*
         * This week's transfer market. The price-change predictor reads these
         * two and nothing else; with both missing it had a threshold and no
         * flow to compare it against, so every player in the demo sat at
         * exactly net zero and the panel drew twenty blank rows. They agree in
         * sign with `cost_change_event` above, because a price rise is caused
         * by net transfers in.
         */
        transfers_in_event:
          3_000 + Math.round(60_000 * q) + ((id * 7_919) % 40_000) + (id % 23 === 0 ? 260_000 : 0),
        transfers_out_event:
          3_000 + Math.round(60_000 * q) + ((id * 104_729) % 40_000) + (id % 19 === 0 ? 260_000 : 0),
        // Generation inputs, not display fields. `_quality` drives how often the
        // man returns; `_nailed` decides whether he starts or is a rotation
        // risk. Both are stripped before the bootstrap is served.
        _quality: quality,
        _nailed: i === 1,
      });
      id++;
    };
    /*
     * FIFTEEN PER CLUB, not twelve — 2 GK, 5 DEF, 5 MID, 3 FWD.
     *
     * The old roster had exactly ten outfield players, which is exactly how
     * many an eleven needs. So there was no such thing as a team sheet: no club
     * could leave anyone out, no club had a bench, and the generator had to
     * decide each player's minutes independently. It did, at 45% blank apiece,
     * and clubs took the field with 348 to 580 minutes between them against the
     * 990 a real match distributes — as few as five men with any minutes at
     * all, and in half of GW19's matches BOTH goalkeepers played and both were
     * credited with the same clean sheet.
     *
     * Three spare outfielders is what makes rotation a real thing that can be
     * modelled rather than a coin flip applied to everybody at once.
     */
    mk(1, 1, 0, 0);
    mk(1, 2, 0, 0);
    for (let i = 1; i <= 5; i++) mk(2, i, 1.5, 1.5);
    for (let i = 1; i <= 5; i++) mk(3, i, 6, 6);
    for (let i = 1; i <= 3; i++) mk(4, i, 10, 3);
  }
  return elements;
}

export function makeDemoUniverse(now: number) {
  const elements = makeElements();
  const qualityOf = new Map<number, number>(elements.map((e) => [e.id, e._quality]));
  const nailedOf = new Set<number>(elements.filter((e) => e._nailed).map((e) => e.id));

  /*
   * How good a club is, on FPL's 1..5 scale, and THE ONLY STATEMENT OF IT.
   *
   * Club ids run strongest-first, so club 1 is a 5 and club 20 a 2. This used to
   * be written down twice: `strength` on the team said "club 1 is a 5", while
   * the fixture difficulty said `ceil(t / 4)`, which makes club 1 a 2 — the
   * exact inverse. Facing the best side in the league was therefore published as
   * the easiest fixture in the league, in every gameweek.
   *
   * That is not cosmetic here. Every club carried identical strength ratings, so
   * `buildStrengths` in xp.ts measured a spread of zero, declared them unusable
   * and fell through to the FDR branch — which meant the inverted number was the
   * ONLY opponent signal the projection had. The demo's optimizer recommended
   * transferring into the hardest run of fixtures on the board, and the pitch
   * painted an away trip to the champions emerald green.
   */
  const strengthOf = (t: number) => Math.max(2, Math.min(5, Math.round((21 - t) / 4)));

  /*
   * Kickoffs first, deadlines derived from them. FPL's deadline is always ninety
   * minutes before its gameweek's first match, and writing the two down
   * separately put GW20's deadline five days before GW20's own kickoffs.
   */
  const WEEK = 7 * DAY;
  const HOUR = 3_600_000;
  const firstKickoff = (gw: number) => now + (gw - CURRENT_GW) * WEEK - 26 * HOUR;
  const deadlineFor = (gw: number) => new Date(firstKickoff(gw) - 90 * 60_000).toISOString();
  const events = Array.from({ length: 38 }, (_, i) => {
    const gw = i + 1;
    const played = gw <= CURRENT_GW;
    return {
      id: gw,
      name: `Gameweek ${gw}`,
      deadline_time: deadlineFor(gw),
      finished: gw < CURRENT_GW,
      is_current: gw === CURRENT_GW,
      is_next: gw === CURRENT_GW + 1,
      /*
       * A gameweek nobody has played has no average and no highest score. FPL
       * reports 0 and `null` until it kicks off; the demo reported a full set of
       * figures for all eighteen remaining weeks, so the season planner could
       * compare next month's "field average" against this month's.
       */
      average_entry_score: played ? 42 + ((gw * 13) % 25) : 0,
      // A floor only, and deliberately a low one: it is patched upward at the
      // end to clear the best score this universe states anyone achieved. A
      // floor set above every achievable score makes that patch dead code and
      // the test that guards it vacuous.
      highest_score: played ? 70 + ((gw * 7) % 12) : null,
    };
  });

  const teams = TEAM_NAMES.map((name, i) => ({
    id: i + 1,
    name,
    short_name: TEAM_CODES[i],
    strength: strengthOf(i + 1),
    /*
     * Real ratings, spread the way the real ones are. They were all 1100/1050,
     * and `buildStrengths` requires a spread above 40 before it will trust them
     * — so an identical set silently disabled the strength-based half of the xP
     * model for the entire demo.
     */
    strength_overall_home: 1340 - i * 17,
    strength_overall_away: 1290 - i * 17,
    strength_attack_home: 1350 - i * 18,
    strength_attack_away: 1295 - i * 18,
    strength_defence_home: 1330 - i * 16,
    strength_defence_away: 1280 - i * 16,
  }));

  const bootstrap = {
    events,
    teams,
    elements,
    /*
     * One of each chip per half of the season, which is how FPL has shipped
     * them since 2025/26. It used to be a single all-season window for three of
     * the four, so the demo quietly taught the pre-2025 rule: a bench boost
     * played in GW15 looked spent for good, when in reality the second-half
     * copy unlocks at GW20 and is available right now.
     */
    chips: ["wildcard", "freehit", "bboost", "3xc"].flatMap((name) => [
      { name, start_event: 2, stop_event: 19, number: 1 },
      { name, start_event: 20, stop_event: 38, number: 1 },
    ]),
    total_players: PLAYER_COUNT,
  };

  /*
   * Fixtures for the WHOLE SEASON SO FAR, GW1 onwards, not just the current
   * week. The app's gameweek time machine and its points breakdown both ask for
   * `entry/{id}/event/{gw}/picks/` and `event/{gw}/live/` for every finished
   * gameweek; with only GW20 in the universe those endpoints had nothing
   * gameweek-specific to answer with and handed back GW20 for all of them. The
   * Team tab then drew a GW15 pitch worth 51 points beside a history row that
   * said 61, and the points breakdown reconciled the season to 893 against a
   * dashboard reading 1,199.
   *
   * A REAL ROUND-ROBIN, by the circle method: nineteen rounds in which every
   * club meets each of the other nineteen once, then the same nineteen rounds
   * played back with the venues swapped. Every club therefore ends the season
   * having faced all nineteen opponents home and away — 38 matches, 19 at home.
   *
   * It used to be `home = (2i + gw) % 20` against `away = (2i + 1 + 3gw) % 20`.
   * Both endpoints stepped with `gw`, so their difference only ever took a
   * handful of values and every club met exactly FIVE distinct opponents all
   * season, never once playing the other fourteen. Nothing crashes on that, and
   * that is what made it survive: fixture difficulty runs became periodic, so
   * the ticker's "next five" was very nearly the same five every week and the
   * planner's horizon was ranking clubs on a quarter of the league.
   */
  const roundRobin = (round: number): [number, number][] => {
    const M = 19; // the rotating clubs, 1..19; club 20 is the fixed pivot
    const pairs: [number, number][] = [];
    const pivotOpp = (round % M) + 1;
    pairs.push(round % 2 === 0 ? [20, pivotOpp] : [pivotOpp, 20]);
    for (let i = 1; i < 10; i++) {
      const a = ((round + i) % M) + 1;
      const b = ((((round - i) % M) + M) % M) + 1;
      pairs.push(i % 2 === 0 ? [a, b] : [b, a]);
    }
    return pairs;
  };

  const fixtures: any[] = [];
  let fid = 1;
  // …and all the way to GW38, not five weeks ahead. The bootstrap declares a
  // 38-event season, so a fixture list that stopped at GW25 made clubs look as
  // though they had 13 blank gameweeks: anything reading fixtures per event —
  // the planner's horizon, the fixture-difficulty ticker — saw an empty run and
  // projected zero for it.
  for (let gw = 1; gw <= 38; gw++) {
    // Second half of the season replays the first with the venues reversed.
    const reversed = gw > 19;
    const round = (gw - 1) % 19;
    const pairs = roundRobin(round).map(([h, a]): [number, number] =>
      reversed ? [a, h] : [h, a]
    );
    for (let i = 0; i < 10; i++) {
      const [home, away] = pairs[i];
      const isCurrent = gw === CURRENT_GW;
      const isPast = gw < CURRENT_GW;
      /*
       * Which two of GW20's ten matches are still in play is decided AFTER the
       * demo manager's squad exists, further down, and patched onto these rows
       * — it has to be two matches he actually has players in, or the app
       * renders a "live" gameweek in which nothing the user holds is live and
       * the provisional-bonus path never appears. It used to be hard-coded to
       * fixture indices 2 and 3 under a comment reasoning about which clubs
       * those paired; the round-robin above makes that reasoning false, and
       * picking the fixtures by ownership makes it unnecessary.
       */
      fixtures.push({
        id: fid++,
        event: gw,
        team_h: home,
        team_a: away,
        // Difficulty of the fixture FOR the home side is how strong the AWAY
        // side is, and vice versa — and it has to be the same statement of club
        // quality that `teams[].strength` makes. It used to be `ceil(t / 4)`,
        // the exact inverse: club 1 was rated strength 5 in the bootstrap and
        // difficulty 2 in the fixture list, so in demo mode the xP model spent
        // every projection believing the best clubs were the easiest opponents.
        team_h_difficulty: strengthOf(away),
        team_a_difficulty: strengthOf(home),
        // Eight hours ago for the current gameweek's finished matches — an
        // afternoon programme already in the books. The two evening kickoffs
        // are moved forward to 73 minutes ago by the live patch below.
        kickoff_time: isCurrent
          ? new Date(now - 8 * 3600_000).toISOString()
          : new Date(firstKickoff(gw) + i * 90 * 60_000).toISOString(),
        finished: isPast || isCurrent,
        started: gw <= CURRENT_GW,
        // Filled in by the goals the match feed actually records, below.
        team_h_score: gw <= CURRENT_GW ? 0 : null,
        team_a_score: gw <= CURRENT_GW ? 0 : null,
      });
    }
  }

  const rnd = (n: number) => {
    let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return ((x ^ (x >>> 16)) >>> 0) / 4_294_967_296;
  };

  /*
   * ======================= ONE GAMEWEEK, PLAYED OUT =======================
   *
   * THE SINGLE SOURCE OF TRUTH FOR EVERY GAMEWEEK. Each week's history row, the
   * bench total, the scorelines on the fixture list, the season aggregates on
   * every player card, the mini-league, the points breakdown and the entry
   * summary are all DERIVED from what this function returns.
   *
   * GW20 used to be five hand-written constants that disagreed with each other:
   * the pitch read the live data and showed 21, the Latest GW card read a
   * literal 61, the delta read a history row worth 40 net against 69 the week
   * before and said −29, the cumulative total implied 57, and the league table
   * said 64. Every one of those numbers claimed to be the same gameweek. Real
   * FPL data cannot disagree with itself like that, so a demo that does is not
   * a demo of this app — it is a bug report.
   *
   * It is built in passes, and the order is the point. A player's clean sheet
   * depends on the scoreline, the scoreline depends on who scored, and bonus
   * depends on everything else — so each of those has to be settled before the
   * next is computed. Deciding them independently is precisely how a 1-0 ended
   * up awarding a clean sheet to BOTH sides.
   */
  const GOAL_PTS: Record<number, number> = { 1: 10, 2: 6, 3: 5, 4: 4 };
  const BPS_GOAL: Record<number, number> = { 1: 12, 2: 12, 3: 18, 4: 24 };
  // Per-position return rates. Keepers do not score: the ten-point keeper goal
  // is in the table because FPL has the rule, not because it should happen
  // twice a season in a demo — it used to, and the player card then reported a
  // goal above a season line reading zero goals.
  const GOAL_RATE: Record<number, number> = { 1: 0, 2: 0.02, 3: 0.075, 4: 0.09 };
  const ASSIST_RATE: Record<number, number> = { 1: 0, 2: 0.022, 3: 0.05, 4: 0.04 };

  type GwRow = {
    id: number;
    fixture: number;
    opponent: number;
    wasHome: boolean;
    minutes: number;
    goals: number;
    assists: number;
    saves: number;
    conceded: number;
    cs: boolean;
    yellow: number;
    bonus: number;
    bps: number;
    points: number;
  };

  /*
   * ============================= THE TEAM SHEET =============================
   *
   * A CLUB PUTS ELEVEN MEN ON THE PITCH AND HAS NINETY MINUTES TO GIVE THEM.
   * That is one decision per club per match, and it used to be twelve
   * INDEPENDENT decisions — each player blanking on his own 45% coin flip —
   * which is why clubs took the field with 348 to 580 minutes between them
   * instead of 990, why as few as five men at a club recorded any minutes at
   * all, and why in half of GW19's matches both goalkeepers played and both
   * were handed the same clean sheet.
   *
   * Minutes are CONSERVED here, which is the property that makes the rest true:
   * eleven start, three are substituted on the hour or later, and the man
   * coming off and the man coming on split the ninety between them. A finished
   * match therefore distributes exactly 990 minutes per club, and one at 58'
   * exactly 11 × 58.
   */
  const rosterOf = new Map<number, any[]>();
  for (const e of elements) {
    const list = rosterOf.get(e.team);
    if (list) list.push(e);
    else rosterOf.set(e.team, [e]);
  }

  /** Substitution clock: who comes off when, once a match is over. */
  const SUB_MINUTES = [60, 70, 80];

  const teamSheet = (
    teamId: number,
    gw: number,
    mustStart: ReadonlySet<number>,
    mustSit: ReadonlySet<number>
  ) => {
    // Selection is quality plus a weekly wobble, so the same eleven does not
    // start every week and the wobble is deterministic in the gameweek.
    const rank = (e: any) =>
      qualityOf.get(e.id)! + (nailedOf.has(e.id) ? 2.5 : 0) + rnd(e.id * 31 + gw * 1009) * 1.5;
    const avail = rosterOf
      .get(teamId)!
      .filter((e) => !mustSit.has(e.id))
      .sort((a, b) => rank(b) - rank(a));

    const keepers = avail.filter((e) => e.element_type === 1);
    // EXACTLY ONE keeper starts. Two keepers on the same team sheet was not a
    // rounding error — it handed the same clean sheet out twice.
    const gk = keepers.find((e) => mustStart.has(e.id)) ?? keepers[0];

    const outfield = avail.filter((e) => e.element_type !== 1);
    const xi: any[] = [];
    const add = (e: any) => {
      if (e && xi.length < 10 && !xi.includes(e)) xi.push(e);
    };
    // Players the demo manager owns are known to have played, so they are
    // picked first; then a legal shape (at least three defenders and a forward);
    // then the best of the rest.
    for (const e of outfield) if (mustStart.has(e.id)) add(e);
    for (const e of outfield.filter((x) => x.element_type === 2).slice(0, 3)) add(e);
    for (const e of outfield.filter((x) => x.element_type === 4).slice(0, 1)) add(e);
    for (const e of outfield) add(e);

    const bench = outfield.filter((e) => !xi.includes(e));
    return { gk, xi, bench };
  };

  const buildGw = (
    gw: number,
    squadCtx: { mustStart: ReadonlySet<number>; mustSit: ReadonlySet<number> } | null
  ) => {
    const gwFixtures = fixtures.filter((f) => f.event === gw);
    const fixtureOf = new Map<number, (typeof gwFixtures)[number]>();
    for (const f of gwFixtures) {
      fixtureOf.set(f.team_h, f);
      fixtureOf.set(f.team_a, f);
    }

    /*
     * PASS 0 — TEAM SHEETS. Every club names an eleven and shares out the
     * ninety minutes; nothing below invents a minute of its own.
     *
     * The demo manager's own squad is pinned rather than drawn: exactly one of
     * his starters blanks and his reserve keeper sits, every week, so the app
     * always tells the same story about auto-substitutions and the vice-captain.
     */
    const NONE: ReadonlySet<number> = new Set<number>();
    const mustStart = squadCtx?.mustStart ?? NONE;
    const mustSit = squadCtx?.mustSit ?? NONE;
    const minutesOf = new Map<number, number>();
    for (const f of gwFixtures) {
      const finished = f.finished;
      const inPlay = f.started && !f.finished;
      if (!f.started) continue;
      for (const teamId of [f.team_h, f.team_a]) {
        const { gk, xi, bench } = teamSheet(teamId, gw, mustStart, mustSit);
        if (inPlay) {
          // 58 minutes gone, nobody withdrawn yet: 11 × 58, and the bench is
          // still the bench.
          for (const e of [gk, ...xi]) minutesOf.set(e.id, 58);
          continue;
        }
        if (!finished) continue;
        minutesOf.set(gk.id, 90);
        for (const e of xi) minutesOf.set(e.id, 90);
        // Three changes. The men withdrawn are the lowest-ranked starters who
        // are NOT pinned — a manager does not hook the player the demo has
        // promised is playing — and each substitute plays out the remainder.
        const hookable = xi.filter((e) => !mustStart.has(e.id)).reverse();
        for (let s = 0; s < SUB_MINUTES.length; s++) {
          const off = hookable[s];
          const on = bench[s];
          if (!off || !on) break;
          minutesOf.set(off.id, SUB_MINUTES[s]);
          minutesOf.set(on.id, 90 - SUB_MINUTES[s]);
        }
      }
    }

    // PASS 1 — what each player did with the minutes he was given. Nothing here
    // depends on anyone else's result.
    const perf = elements.map((e) => {
      const f = fixtureOf.get(e.team)!;
      const inPlay = f.started && !f.finished;
      const minutes = minutesOf.get(e.id) ?? 0;
      const dnp = minutes === 0;
      // Returns are weighted by the player's own quality AND by how long he was
      // actually on the pitch, so a man who comes on for the last ten minutes
      // no longer scores at a ninety-minute starter's rate.
      const q = qualityOf.get(e.id)!;
      const share = minutes / 90;
      const goals =
        !dnp && rnd(e.id + gw * 313) < q * GOAL_RATE[e.element_type] * share ? 1 : 0;
      const assists =
        !dnp && rnd(e.id + 101 + gw * 571) < q * ASSIST_RATE[e.element_type] * share ? 1 : 0;
      const saves =
        e.element_type === 1 && !dnp ? Math.floor(rnd(e.id + 9 + gw * 137) * 7 * share) : 0;
      /*
       * Bookings, because the app models yellow-card suspension risk and in
       * demo mode had nothing to model: every player finished the season on
       * zero cards, so the suspension warning was unreachable and the −1 that
       * every FPL manager sees several times a week never appeared in a points
       * breakdown. Defenders and midfielders are booked more often than
       * forwards and far more often than keepers, which is what the real
       * distribution looks like.
       */
      const cardRate = [0, 0.02, 0.13, 0.11, 0.07][e.element_type];
      const yellow = !dnp && rnd(e.id + 613 + gw * 241) < cardRate ? 1 : 0;
      return { e, f, inPlay, minutes, goals, assists, saves, yellow };
    });

    // PASS 2 — the scoreline IS the sum of the goals the live feed records. It
    // used to be `home % 3` versus `away % 2`, invented independently of the
    // players, so the fixture list and the points breakdown contradicted each
    // other in almost every match.
    const goalsFor = new Map<number, number>();
    for (const p of perf) goalsFor.set(p.e.team, (goalsFor.get(p.e.team) ?? 0) + p.goals);
    for (const f of gwFixtures) {
      f.team_h_score = goalsFor.get(f.team_h) ?? 0;
      f.team_a_score = goalsFor.get(f.team_a) ?? 0;
    }

    // PASS 3 — points and BPS, now that the scorelines exist. A clean sheet is
    // a property of the MATCH: it belongs to the side that conceded nothing,
    // which is not something two teams in the same fixture can both do.
    const scored = perf.map((p) => {
      const { e, f, minutes, goals, assists, saves, yellow } = p;
      // Goals conceded are only credited to a man who was ON THE PITCH — the
      // same condition his clean sheet already obeyed one line down. Without
      // it, an unused substitute was charged with his club's concessions, so
      // the demo could show a defender on 0 minutes, 0 points and 3 conceded,
      // and the "goals conceded per 90" column divided by zero.
      const conceded = minutes === 0 ? 0 : f.team_h === e.team ? f.team_a_score : f.team_h_score;
      // Only once the match is over: a 0-0 at 58 minutes is not a clean sheet yet.
      const cs = f.finished && minutes >= 60 && conceded === 0;
      const appearance = minutes === 0 ? 0 : minutes >= 60 ? 2 : 1;
      const goalPts = goals * GOAL_PTS[e.element_type];
      const csPts = cs ? (e.element_type <= 2 ? 4 : e.element_type === 3 ? 1 : 0) : 0;
      const savePts = Math.floor(saves / 3);
      const base = appearance + goalPts + assists * 3 + csPts + savePts - yellow;
      /*
       * BPS approximates the official ledger, and it has to be derived from
       * what the player actually did — it used to be `(id * 13) % 45`,
       * unrelated to his points, so the match modal showed a man on 11 BPS
       * taking two bonus off a man on 42. The random term stands in for
       * everything BPS counts that this demo does not model (passes, tackles,
       * recoveries) and also breaks ties.
       */
      const bps =
        minutes === 0
          ? 0
          : (minutes >= 60 ? 6 : 3) +
            goals * BPS_GOAL[e.element_type] +
            assists * 9 +
            (cs && e.element_type <= 2 ? 12 : 0) +
            savePts * 2 -
            yellow * 3 +
            Math.round(rnd(e.id + 31 + gw * 89) * 12);
      return { ...p, conceded, cs, appearance, goalPts, csPts, savePts, base, bps };
    });

    /*
     * PASS 4 — bonus, awarded 3/2/1 on BPS within each fixture with FPL's
     * tie-sharing. Awarded for in-play fixtures too, because since 2026/27 FPL
     * publishes its own projected bonus once a match passes twenty minutes, and
     * this one is at 58. That matters for more than realism: `provisionalBonus`
     * treats anything itemised in `explain` as already counted, so awarding it
     * here is what makes the Live tab's total agree with the dashboard's. When
     * bonus was withheld mid-match, the Live tab added its own projection on
     * top and showed 53 for a gameweek every other screen called 51 — the same
     * defect this whole rewrite exists to remove, one tab over.
     */
    const bonusOf = new Map<number, number>();
    for (const f of gwFixtures) {
      const inMatch = scored
        .filter((p) => p.f === f && p.minutes > 0)
        .map((p) => ({ id: p.e.id, bps: p.bps }))
        .sort((a, b) => b.bps - a.bps);
      let award = 3;
      let i = 0;
      while (i < inMatch.length && award > 0) {
        const tied = inMatch.filter((p) => p.bps === inMatch[i].bps);
        for (const p of tied) bonusOf.set(p.id, Math.max(bonusOf.get(p.id) ?? 0, award));
        i += tied.length;
        award -= tied.length;
      }
    }

    // PASS 5 — assemble. `total_points` is the sum of `explain`, always.
    const rows: GwRow[] = [];
    const live = {
      elements: scored.map((p) => {
        const bonus = bonusOf.get(p.e.id) ?? 0;
        const stats = [{ identifier: "minutes", points: p.appearance, value: p.minutes }];
        if (p.goals) stats.push({ identifier: "goals_scored", points: p.goalPts, value: p.goals });
        if (p.assists)
          stats.push({ identifier: "assists", points: p.assists * 3, value: p.assists });
        if (p.csPts) stats.push({ identifier: "clean_sheets", points: p.csPts, value: 1 });
        if (p.savePts) stats.push({ identifier: "saves", points: p.savePts, value: p.saves });
        if (p.yellow) stats.push({ identifier: "yellow_cards", points: -p.yellow, value: p.yellow });
        if (bonus) stats.push({ identifier: "bonus", points: bonus, value: bonus });
        rows.push({
          id: p.e.id,
          fixture: p.f.id,
          opponent: p.f.team_h === p.e.team ? p.f.team_a : p.f.team_h,
          wasHome: p.f.team_h === p.e.team,
          minutes: p.minutes,
          goals: p.goals,
          assists: p.assists,
          saves: p.saves,
          conceded: p.conceded,
          cs: p.cs,
          yellow: p.yellow,
          bonus,
          bps: p.bps,
          points: p.base + bonus,
        });
        return {
          id: p.e.id,
          // The live feed carries the whole `EventLive` stat block that
          // `types.ts` declares, not a five-field subset of it. The missing
          // ones were not cosmetic: `clean_sheets`, `goals_conceded` and
          // `saves` are what the player modal and the stats table read for the
          // current gameweek, so in demo mode a keeper who had just kept a
          // clean sheet and made six saves rendered as a blank row while the
          // points breakdown beside it itemised both.
          stats: {
            minutes: p.minutes,
            total_points: p.base + bonus,
            bonus,
            bps: p.bps,
            goals_scored: p.goals,
            assists: p.assists,
            clean_sheets: p.cs ? 1 : 0,
            goals_conceded: p.conceded,
            saves: p.saves,
            yellow_cards: p.yellow,
            red_cards: 0,
            own_goals: 0,
            penalties_saved: 0,
            penalties_missed: 0,
          },
          explain: [{ fixture: p.f.id, stats }],
        };
      }),
    };
    const points = new Map<number, number>(rows.map((r) => [r.id, r.points]));
    return { live, rows, points, byId: new Map(rows.map((r) => [r.id, r])) };
  };

  /*
   * The nineteen finished weeks first. They need nothing from the demo squad —
   * which is the only reason the ordering below works at all, because the
   * squad's armband is chosen from the season form these weeks produce.
   */
  const gwData = new Map<number, ReturnType<typeof buildGw>>();
  for (let gw = 1; gw < CURRENT_GW; gw++) gwData.set(gw, buildGw(gw, null));

  // Season points through GW19: the form a manager would actually have picked
  // his captain on, and the ordering the demo squad's armband uses.
  const formPointsOf = new Map<number, number>(elements.map((e) => [e.id, 0]));
  for (let gw = 1; gw < CURRENT_GW; gw++) {
    for (const r of gwData.get(gw)!.rows) {
      formPointsOf.set(r.id, formPointsOf.get(r.id)! + r.points);
    }
  }

  const byTeamType = (team: number, t: number) =>
    elements.filter((e) => e.team === team && e.element_type === t);

  /*
   * ============================== THE SQUAD ==============================
   *
   * DERIVED, NOT AUTHORED — and the reason is the budget.
   *
   * It used to be fifteen hard-coded club/position lookups: the first-choice
   * keeper, four first-choice defenders, four first-choice midfielders and two
   * first-choice forwards, all from the top half of the table. That is a squad
   * no FPL manager can own. Priced on the same curve as everyone else it comes
   * to £118.6m against the £100.0m the game issues, and the demo simply never
   * checked: `entry_history.value` was interpolated toward whatever that squad
   * happened to cost, so the arithmetic closed on itself while stating a squad
   * £18.6m over budget. Every screen that reasons about affordability — the
   * transfer planner's "can I afford him", the squad builder, the value table —
   * was being handed a starting position the rules forbid.
   *
   * So the fifteen are CHOSEN, the way a manager chooses them: the most
   * productive squad, by the season the demo has actually played out, that
   * fits. Greedy on points first, then repaired down to the budget by whichever
   * swap gives up the fewest points per £0.1m it frees. Deterministic, and it
   * cannot produce an illegal or unaffordable squad because it never leaves the
   * legal set.
   */
  const SQUAD_BUDGET = INITIAL_BUDGET - 15; // £1.5m held back, as most managers do
  const QUOTA: Record<number, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
  const pointsOf = (e: any) => formPointsOf.get(e.id) ?? 0;

  /*
   * Repair a fifteen down to a budget, in place, and hand it back.
   *
   * SHARED WITH THE MINI-LEAGUE ON PURPOSE. It began life inline in the demo
   * manager's squad, which meant HE was the only manager in the universe who
   * had to pay for his players: the nine rivals and the sampled field were
   * built by taking the best man at each club with no budget at all, so they
   * fielded squads costing £115m-odd. The demo manager, playing by the rules,
   * finished twenty gameweeks in the bottom third of a field of cheats. Every
   * rank on the opening screen was a measurement of that asymmetry and nothing
   * else. One budget, applied to everybody, or the ranks mean nothing.
   */
  const repairToBudget = (held: any[], budget: number): any[] => {
    const ptsOf = pointsOf;
    let cost = held.reduce((s, e) => s + e.now_cost, 0);
    /*
     * Each pass considers every legal one-for-one downgrade and takes the
     * cheapest one IN POINTS PER TENTH FREED, which is the same trade a
     * manager makes when he cannot afford his shortlist. The loop terminates
     * because every accepted swap strictly reduces the cost and the cheapest
     * legal fifteen is far below the budget; the guard is a backstop, not a
     * plan, and it throws rather than returning an over-budget squad silently.
     */
    for (let pass = 0; cost > budget; pass++) {
      if (pass > 400) throw new Error("demo: squad repair did not converge");
      const excess = cost - budget;
      /*
       * TWO CANDIDATES, NOT ONE, AND THE LAST PASS IS THE ONE THAT MATTERS.
       *
       * Points-per-tenth alone is the right rule while the squad is still a
       * long way over, because it buys the most room for the least damage. It
       * is the WRONG rule on the pass that finishes the job: the best rate is
       * usually also the biggest saving, so the loop would take a £2.0m
       * downgrade to close a £0.3m gap and hand back the change as unspendable
       * bank. That is how a £98.5m squad came out costing £95.2m — £3.3m of
       * premium quality given away for nothing, in a fixture whose whole
       * purpose is to look like a real manager's team.
       *
       * So: among the swaps that are ON THEIR OWN sufficient, take the one that
       * costs the fewest points outright. Only when none of them suffices does
       * the rate rule apply, and then the next pass reconsiders.
       */
      let bestRate: { i: number; e: any; save: number; loss: number } | null = null;
      let bestFinal: { i: number; e: any; save: number; loss: number } | null = null;
      for (let i = 0; i < held.length; i++) {
        const out = held[i];
        const rest = held.filter((_, j) => j !== i);
        const restIds = new Set(rest.map((e) => e.id));
        const restClubs = new Map<number, number>();
        for (const e of rest) restClubs.set(e.team, (restClubs.get(e.team) ?? 0) + 1);
        for (const cand of elements) {
          if (cand.element_type !== out.element_type) continue;
          if (restIds.has(cand.id)) continue;
          if (cand.now_cost >= out.now_cost) continue;
          if ((restClubs.get(cand.team) ?? 0) >= MAX_PER_CLUB) continue;
          const save = out.now_cost - cand.now_cost;
          const loss = Math.max(0, ptsOf(out) - ptsOf(cand));
          const swap = { i, e: cand, save, loss };
          if (!bestRate || loss / save < bestRate.loss / bestRate.save) bestRate = swap;
          if (save >= excess) {
            // Ties broken on the smaller saving, then on id, so the choice is
            // deterministic and keeps as much of the budget in play as it can.
            if (
              !bestFinal ||
              loss < bestFinal.loss ||
              (loss === bestFinal.loss && save < bestFinal.save) ||
              (loss === bestFinal.loss && save === bestFinal.save && cand.id < bestFinal.e.id)
            ) {
              bestFinal = swap;
            }
          }
        }
      }
      const best = bestFinal ?? bestRate;
      if (!best) throw new Error("demo: squad repair ran out of downgrades");
      cost -= best.save;
      held[best.i] = best.e;
    }
    return held;
  };

  /**
   * Spend the bank, the way a manager of a given standard would spend it.
   *
   * `repairToBudget` only ever cuts, so a squad assembled from the cheap end of
   * each club's list came out UNDER budget and stayed there: one demo rival sat
   * on £14.5m of unspent money for twenty gameweeks. That is not a manager
   * anybody has ever met, and team value is a headline figure on both the
   * dashboard and the mini-league table, so the fiction was on screen.
   *
   * The upgrade is chosen at the SAME depth the squad was built at, which is
   * the point. Investing on points alone would walk every squad back toward
   * the greedy optimum and collapse the skill spread the depth argument exists
   * to create — the good manager would be indistinguishable from the bad one
   * the moment either had money. Instead each buys the `depth`-th best man he
   * can afford, so the sharp manager converts his bank into points and the one
   * who drafted on shirt numbers converts it into an expensive disappointment.
   * Among the fifteen candidate swaps, the one that spends the most wins, so
   * the bank actually drains rather than trickling.
   */
  const investBank = (held: any[], budget: number, depth: number): any[] => {
    const ptsOf = pointsOf;
    let cost = held.reduce((s, e) => s + e.now_cost, 0);
    for (let pass = 0; budget - cost > 5; pass++) {
      if (pass > 400) break;
      const headroom = budget - cost;
      let best: { i: number; e: any; spend: number } | null = null;
      for (let i = 0; i < held.length; i++) {
        const out = held[i];
        const rest = held.filter((_, j) => j !== i);
        const restIds = new Set(rest.map((e) => e.id));
        const restClubs = new Map<number, number>();
        for (const e of rest) restClubs.set(e.team, (restClubs.get(e.team) ?? 0) + 1);
        const affordable = elements
          .filter(
            (c) =>
              c.element_type === out.element_type &&
              !restIds.has(c.id) &&
              c.now_cost > out.now_cost &&
              c.now_cost - out.now_cost <= headroom &&
              (restClubs.get(c.team) ?? 0) < MAX_PER_CLUB
          )
          .sort((a, b) => ptsOf(b) - ptsOf(a) || b.now_cost - a.now_cost || a.id - b.id);
        if (!affordable.length) continue;
        const cand = affordable[Math.min(depth, affordable.length - 1)];
        const spend = cand.now_cost - out.now_cost;
        if (!best || spend > best.spend || (spend === best.spend && cand.id < best.e.id)) {
          best = { i, e: cand, spend };
        }
      }
      if (!best) break;
      cost += best.spend;
      held[best.i] = best.e;
    }
    return held;
  };

  const fifteen: any[] = (() => {
    const ptsOf = pointsOf;
    const need: Record<number, number> = { ...QUOTA };
    const clubs = new Map<number, number>();
    const held: any[] = [];
    const ranked = [...elements].sort(
      (a, b) => ptsOf(b) - ptsOf(a) || a.now_cost - b.now_cost || a.id - b.id
    );
    for (const e of ranked) {
      if (!need[e.element_type] || (clubs.get(e.team) ?? 0) >= MAX_PER_CLUB) continue;
      held.push(e);
      need[e.element_type]--;
      clubs.set(e.team, (clubs.get(e.team) ?? 0) + 1);
    }
    return repairToBudget(held, SQUAD_BUDGET);
  })();

  /*
   * Pick order: the starting eleven first, in FPL's own 1..15. The eleven is the
   * best legal FORMATION rather than the best eleven players — take the top ten
   * outfielders by points and you routinely get six midfielders, which FPL will
   * not accept — so each of the eight legal shapes is scored and the best wins.
   * The reserve keeper is slot 12, which is where FPL puts him and where the
   * app's auto-substitution reads him from.
   */
  const squad: any[] = (() => {
    const ptsOf = (e: any) => formPointsOf.get(e.id) ?? 0;
    const byPos = (t: number) =>
      fifteen.filter((e) => e.element_type === t).sort((a, b) => ptsOf(b) - ptsOf(a) || a.id - b.id);
    const gks = byPos(1);
    const pools = { 2: byPos(2), 3: byPos(3), 4: byPos(4) } as Record<number, any[]>;
    let bestXi: any[] | null = null;
    let bestPts = -1;
    for (const [d, m, f] of VALID_FORMATIONS) {
      const xi = [...pools[2].slice(0, d), ...pools[3].slice(0, m), ...pools[4].slice(0, f)];
      if (xi.length !== 10) continue;
      const pts = xi.reduce((s, e) => s + ptsOf(e), 0);
      if (pts > bestPts) {
        bestPts = pts;
        bestXi = xi;
      }
    }
    const xi = bestXi!;
    const inXi = new Set(xi.map((e) => e.id));
    const bench = fifteen
      .filter((e) => e.element_type !== 1 && !inXi.has(e.id))
      .sort((a, b) => ptsOf(b) - ptsOf(a) || a.id - b.id);
    return [gks[0], ...xi, gks[1], ...bench];
  })();

  const ENTRY_NAME = "Demo Wanderers";

  const chipHistory = [
    { name: "wildcard", time: new Date(now - 90 * DAY).toISOString(), event: 8 },
    { name: "bboost", time: new Date(now - 40 * DAY).toISOString(), event: 15 },
  ];
  const chipEvents = new Map(chipHistory.map((c) => [c.event, c.name]));

  /*
   * ============================ TRANSFER LEDGER ============================
   *
   * The season's transfer activity, and the ONLY statement of it. The history
   * rows' `event_transfers` / `event_transfers_cost`, the free-transfer count
   * the header shows, every player's purchase price, AND the squad the time
   * machine draws for any past gameweek all read from here.
   *
   * It used to be a single made-up record with `element_out: 999` — an id no
   * element in the demo has — and history rows that claimed transfers in every
   * third gameweek regardless. Two consequences. `purchasePriceFor` fell back
   * to the season-start price for fourteen of the fifteen players and to the
   * ledger for the fifteenth, so team value depended on whether a record
   * happened to exist rather than on what was bought. And `computeFreeTransfers`
   * counted a ledger that did not match the rows it was counting.
   *
   * ONLY THE COUNTS ARE AUTHORED. The points cost of each week is DERIVED by
   * walking the free-transfer bank forward under the game's own rules, using
   * the app's own `transferCost` and the same accumulate-and-cap arithmetic
   * `computeFreeTransfers` uses to read the bank back out.
   *
   * The costs used to be written down beside the counts, and they were wrong:
   * `{ event: 12, count: 2, cost: 4 }` assumed one banked free transfer, but by
   * GW12 this manager had gone four quiet weeks and had the full five banked,
   * so FPL would have charged him nothing. The header then showed a
   * free-transfer count derived from one rule while the history table showed
   * hits derived from another, and a −4 appeared in a week where the app itself
   * said no hit was possible. Deriving it means the two cannot disagree —
   * change a count and the cost follows, or it doesn't compile.
   *
   * The counts still shape the season deliberately: a quiet opening, the
   * wildcard rebuild in GW8, a five-transfer swing in GW17 off a full bank, and
   * then two impatient paid weeks that leave exactly one free transfer for
   * GW21. Fifteen transfers in all — one per squad slot, so every player in the
   * team has a purchase price the ledger can actually justify.
   */
  const TRANSFER_PLAN: { event: number; count: number; cost: number }[] = [];
  {
    const COUNTS = [
      { event: 3, count: 1 },
      { event: 8, count: 4 }, // wildcard week — unlimited, free
      { event: 17, count: 4 },
      { event: 18, count: 2 },
      { event: 19, count: 2 },
      { event: 20, count: 2 },
    ];
    const countAt = new Map(COUNTS.map((c) => [c.event, c.count]));
    // GW1 is the unlimited free team creation; the bank starts at one for GW2.
    let ft = 1;
    for (let gw = 2; gw <= CURRENT_GW; gw++) {
      const count = countAt.get(gw) ?? 0;
      const chip = chipEvents.get(gw);
      const free = chip === "wildcard" || chip === "freehit" ? (chip as "wildcard") : null;
      const cost = transferCost(count, ft, free);
      if (count > 0) TRANSFER_PLAN.push({ event: gw, count, cost });
      if (free) {
        ft = Math.min(MAX_FREE_TRANSFERS, ft + 1);
        continue;
      }
      // A paid week means the bank was emptied first; otherwise it just drains.
      ft = cost > 0 ? 0 : Math.max(0, ft - count);
      ft = Math.min(MAX_FREE_TRANSFERS, ft + 1);
    }
  }
  const planFor = new Map(TRANSFER_PLAN.map((p) => [p.event, p]));

  /*
   * The ledger is built by walking BACKWARDS from the squad the manager owns
   * today, undoing one transfer at a time. That direction is what makes the
   * intermediate squads real: an earlier squad is only ever the current one
   * with a player swapped out, so it is automatically the right size and shape,
   * and the man coming back in can be chosen with the earlier squad's club
   * counts in hand.
   *
   * Choosing him forwards, from a list in id order, was how the demo ended up
   * fielding eleven Arsenal players in GW3 — legal at the end of the season and
   * illegal at every point before it, under a comment claiming the opposite.
   */
  /**
   * What a player cost in a given gameweek: his current price, less the share
   * of this season's movement that had not happened yet. `priceAt(e, 0)` is the
   * season-start price `now_cost - cost_change_start`, which is what
   * `purchasePriceFor` falls back to, and `priceAt(e, CURRENT_GW)` is exactly
   * `now_cost`. Both ends have to hold or the ledger and the bootstrap disagree
   * about the same player in the same week.
   */
  const priceAt = (e: { now_cost: number; cost_change_start: number }, gw: number) =>
    e.now_cost - Math.round(e.cost_change_start * (1 - gw / CURRENT_GW));

  const squadForGw = new Map<number, any[]>();
  const transfers: Transfer[] = [];
  {
    /*
     * Which squad slot was filled when. NOT in slot order: filling them 0..14
     * means the last transfers of the season buy slots 13 and 14, which are
     * bench slots — so the demo's two paid −4 hits were both spent on
     * substitutes, and the header explained a hit nobody would take. The
     * bench and the keeper are bought early, on the free weeks and the
     * wildcard; the midfielders and forwards, which is what a manager takes a
     * hit for, are bought last.
     */
    const SLOT_ORDER = [11, 12, 13, 14, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const buys: { event: number; inEl: any }[] = [];
    let bought = 0;
    for (const plan of TRANSFER_PLAN) {
      for (let n = 0; n < plan.count; n++) {
        buys.push({ event: plan.event, inEl: squad[SLOT_ORDER[bought++]] });
      }
    }

    const held0 = new Set(squad.map((e) => e.id));
    const usedOut = new Set<number>();
    const reversed: { event: number; inEl: any; outEl: any }[] = [];
    let cur = [...squad];
    for (let gw = CURRENT_GW; gw >= 1; gw--) {
      squadForGw.set(gw, [...cur]);
      for (const b of buys.filter((x) => x.event === gw).reverse()) {
        const ix = cur.findIndex((e) => e.id === b.inEl.id);
        if (ix < 0) continue;
        const clubs = new Map<number, number>();
        for (const e of cur) {
          if (e.id !== b.inEl.id) clubs.set(e.team, (clubs.get(e.team) ?? 0) + 1);
        }
        const inHand = new Set(cur.map((e) => e.id));
        const inPts = formPointsOf.get(b.inEl.id) ?? 0;
        const inPrice = priceAt(b.inEl, gw);
        /*
         * THE MAN HE REPLACED, and this is the choice that decides whether the
         * ledger tells a story a manager would recognise.
         *
         * It used to be `spare.find(...)` over a list in element-id order.
         * Element ids run club 1 first and club 1 is the strongest and priciest
         * club, so the predecessor was ALWAYS a club-1 player: every one of the
         * fifteen transfers sold a better, costlier man for a worse, cheaper
         * one, and GW20's −4 hit was spent selling the two highest-scoring
         * players in the demo to buy two substitutes. A ledger in which every
         * move is a downgrade is not a neutral placeholder — the transfer
         * planner reads it as evidence, and the "your recent moves" panel
         * reported a manager systematically destroying his own team.
         *
         * So the predecessor is the candidate who makes the transfer an
         * UPGRADE ON POINTS while staying inside a hand's width of the same
         * price: same position, fewer points than the man replacing him, price
         * within £1.5m either way. Ranked on points given up per £0.1m freed so
         * the choice is stable, then on id so it is deterministic.
         */
        const candidates = elements.filter(
          (e) =>
            e.element_type === b.inEl.element_type &&
            !held0.has(e.id) &&
            !usedOut.has(e.id) &&
            !inHand.has(e.id) &&
            (clubs.get(e.team) ?? 0) < MAX_PER_CLUB
        );
        const near = candidates.filter(
          (e) => (formPointsOf.get(e.id) ?? 0) < inPts && Math.abs(priceAt(e, gw) - inPrice) <= 15
        );
        const pool = near.length ? near : candidates;
        const outEl = pool.sort((a, c) => {
          const ap = Math.abs(priceAt(a, gw) - inPrice);
          const cp = Math.abs(priceAt(c, gw) - inPrice);
          return ap - cp || (formPointsOf.get(c.id) ?? 0) - (formPointsOf.get(a.id) ?? 0) || a.id - c.id;
        })[0];
        if (!outEl) continue;
        usedOut.add(outEl.id);
        reversed.push({ event: gw, inEl: b.inEl, outEl });
        cur = cur.map((e, i) => (i === ix ? outEl : e));
      }
    }

    for (const r of reversed.reverse()) {
      transfers.push({
        element_in: r.inEl.id,
        // Bought at the price he was that week, not at the season-start price.
        // Booking every purchase at the start price made the ledger a no-op:
        // `purchasePriceFor` returned exactly what its no-ledger fallback would
        // have returned, so a GW20 signing was credited with twenty gameweeks
        // of price rise he was never around for.
        element_in_cost: priceAt(r.inEl, r.event),
        element_out: r.outEl.id,
        element_out_cost: priceAt(r.outEl, r.event),
        entry: DEMO_ENTRY_ID,
        event: r.event,
        // An hour before that gameweek's deadline. Real transfer times are
        // always before the deadline of the gameweek they are booked to; a
        // timestamp after it would make `purchasePriceFor`'s tiebreak lie.
        time: new Date(new Date(deadlineFor(r.event)).getTime() - 3600_000).toISOString(),
      });
    }
  }

  /*
   * ======================= TEAM VALUE, WALKED FORWARD =======================
   *
   * Every gameweek's `value` and `bank`, derived from the ledger above and from
   * nothing else.
   *
   * They used to be `INITIAL_BUDGET + (squadValue - INITIAL_BUDGET) × (gw-1)/19`
   * and a constant `bank`. A straight line from £100.0m to whatever the squad
   * happened to be worth, rising by exactly £0.5m every single week including
   * the weeks nothing moved, with the same £1.5m in the bank in all twenty rows
   * — including the rows either side of a transfer that changed it. Only GW20
   * reconciled with the squad, which is why the one test that checked the
   * identity checked it in GW20 and passed.
   *
   * The walk is the game's own arithmetic:
   *   bank starts at £100.0m less what the opening fifteen cost;
   *   a transfer credits the SELLING price of the man sold and debits the full
   *     price of the man bought (FPL charges buyers the market price and pays
   *     sellers half the rise — the spread is where team value leaks);
   *   value is the sum of the squad's selling prices plus the bank.
   *
   * A TRANSFER THEREFORE DOES NOT MOVE TEAM VALUE except by that spread: bank
   * and squad move by equal and opposite amounts. Value moves when prices do.
   * That is the property the old straight line got exactly backwards, and it is
   * why the demo's value chart climbed in a week the manager made no moves and
   * every player he owned had fallen.
   */
  const bankAt = new Map<number, number>();
  const valueAt = new Map<number, number>();
  {
    const paid = new Map<number, number>(); // element id -> what he cost this owner
    const opening = squadForGw.get(1)!;
    for (const e of opening) paid.set(e.id, priceAt(e, 1));
    let bank = INITIAL_BUDGET - opening.reduce((s, e) => s + priceAt(e, 1), 0);
    if (bank < 0) {
      throw new Error(
        `demo: opening squad costs ${INITIAL_BUDGET - bank} against a budget of ${INITIAL_BUDGET}`
      );
    }
    const byEvent = new Map<number, Transfer[]>();
    for (const t of transfers) {
      const list = byEvent.get(t.event);
      if (list) list.push(t);
      else byEvent.set(t.event, [t]);
    }
    for (let gw = 1; gw <= CURRENT_GW; gw++) {
      for (const t of byEvent.get(gw) ?? []) {
        bank += sellingPrice(paid.get(t.element_out) ?? t.element_out_cost, t.element_out_cost);
        bank -= t.element_in_cost;
        paid.set(t.element_in, t.element_in_cost);
      }
      if (bank < 0) throw new Error(`demo: bank went negative (${bank}) in GW${gw}`);
      bankAt.set(gw, bank);
      valueAt.set(
        gw,
        squadForGw.get(gw)!.reduce((s, e) => s + sellingPrice(paid.get(e.id)!, priceAt(e, gw)), 0) +
          bank
      );
    }
  }
  const BANK = bankAt.get(CURRENT_GW)!;
  const squadValue = valueAt.get(CURRENT_GW)!;

  /*
   * The armband goes to the two best ATTACKING players in that week's XI rather
   * than to two hard-coded slots, so it keeps pointing at the right men both if
   * the squad above is reshuffled and as the time machine walks back through
   * squads the manager no longer owns. Ranked on the season form to date —
   * which is what a manager actually has in front of him — and restricted to
   * midfielders and forwards on purpose: this demo's quality curve rates a
   * top-club defender above a mid-table striker, so an unrestricted "best"
   * pick handed the captaincy to a full-back, which is not a thing FPL
   * managers do.
   */
  const armbandFor = (fifteen: any[]) => {
    const ranked = fifteen
      .slice(0, 11)
      .map((e, i) => ({ i, pts: formPointsOf.get(e.id) ?? 0, att: e.element_type >= 3 }))
      .filter((p) => p.att)
      .sort((a, b) => b.pts - a.pts || a.i - b.i);
    return { captain: ranked[0].i, vice: ranked[1].i };
  };

  const picksAt = (gw: number): Pick[] => {
    const fifteen = squadForGw.get(gw)!;
    const { captain, vice } = armbandFor(fifteen);
    const chip = chipEvents.get(gw);
    const capMult = chip === "3xc" ? 3 : 2;
    /*
     * On a Bench Boost week the bench scores, and FPL says so in the picks
     * themselves: positions 12-15 come back with `multiplier: 1`, not 0. The
     * demo used to hard-code 0 for every bench slot regardless of chip while
     * separately crediting the bench in the history row — which is the exact
     * shape of the defect that started all this. Anything summing
     * `livePoints × multiplier` (the dashboard's pitch corner, LiveTab, the
     * mini-league's rival re-derivation) came out below the history row it sat
     * beside, and the gameweek delta went negative for no visible reason.
     */
    const benchMult = chip === "bboost" ? 1 : 0;
    return fifteen.map((e, i) => ({
      element: e.id,
      position: i + 1,
      multiplier: i === captain ? capMult : i < 11 ? 1 : benchMult,
      is_captain: i === captain,
      is_vice_captain: i === vice,
    }));
  };

  const squadPicks = picksAt(CURRENT_GW);
  const CAPTAIN_IX = squadPicks.findIndex((p) => p.is_captain);
  const VICE_IX = squadPicks.findIndex((p) => p.is_vice_captain);

  /*
   * TWO OF GW20'S TEN MATCHES ARE STILL IN PLAY, and which two is decided HERE
   * rather than in the fixture loop, because the choice depends on the squad.
   *
   * It has to be two matches the demo manager actually holds players in. A
   * "live" gameweek in which nothing the user owns is live looks identical to a
   * finished one from every screen he can reach: the Live tab has no ticking
   * row, `provisionalBonus` has no unfinished fixture to project from, and the
   * dashboard's in-play badge is unreachable. The fixtures are therefore ranked
   * by how many of his STARTERS they contain, most first — which also puts his
   * armband in play often enough for the captain-multiplier path to be visible.
   *
   * 73 minutes ago, not 58: `matchMinute` subtracts a 15-minute interval once a
   * match is past the hour, so 73 renders as 58' — the number of minutes the
   * team sheets below actually credit the men on the pitch. At 58 real minutes
   * the clock read "HT~" while every player card claimed 58 played.
   */
  const currentFixtures = fixtures.filter((f) => f.event === CURRENT_GW);
  {
    const holders = new Map<number, number>();
    for (const e of squad.slice(0, 11)) holders.set(e.team, (holders.get(e.team) ?? 0) + 1);
    const ranked = currentFixtures
      .map((f) => ({ f, n: (holders.get(f.team_h) ?? 0) + (holders.get(f.team_a) ?? 0) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || a.f.id - b.f.id);
    // Never every match he owns: something has to have finished, or there is no
    // settled score to compare the live one against and no blank starter with a
    // completed fixture for the auto-substitution machinery to act on.
    for (const { f } of ranked.slice(0, Math.min(2, ranked.length - 1))) {
      f.finished = false;
      f.kickoff_time = new Date(now - 73 * 60_000).toISOString();
    }
  }

  const currentFixtureOf = new Map<number, any>();
  for (const f of currentFixtures) {
    currentFixtureOf.set(f.team_h, f);
    currentFixtureOf.set(f.team_a, f);
  }
  /*
   * One starter blanks. Without this the demo's auto-substitution and
   * vice-captain machinery — which this app implements and no other FPL tool
   * bothers with — has nothing to act on, because every starter is a nailed
   * ninety-minute player. The victim is the weakest starter who is neither
   * captain nor vice AND WHOSE MATCH HAS FINISHED, since FPL only substitutes
   * once a blanking player's fixtures are over. That last condition is the
   * whole point of the blank: pick a man whose match is still in play and
   * `projectAutoSubs` becomes the identity function, so the dashboard's pitch
   * corner and the history row agree by accident rather than by construction —
   * and the test that guards the reported defect compares a number with itself.
   */
  const blankStarter = squad
    .slice(0, 11)
    .map((e, i) => ({ i, e, pts: formPointsOf.get(e.id) ?? 0 }))
    .filter(
      (p) =>
        // NOT THE GOALKEEPER, however little he has scored. FPL will only ever
        // replace a keeper with the reserve keeper, and the reserve keeper is
        // the other man this demo deliberately sits — so a blanking keeper
        // produces no substitution at all, which is the one thing the blank
        // exists to produce. Ranking the eleven on form picks the keeper every
        // time, because keepers score least; the constraint has to be stated,
        // not hoped for.
        p.e.element_type !== 1 &&
        p.i !== CAPTAIN_IX &&
        p.i !== VICE_IX &&
        currentFixtureOf.get(p.e.team)?.finished
    )
    .sort((a, b) => a.pts - b.pts)[0];
  const BLANK_ID: number = blankStarter.e.id;
  const RESERVE_GK_ID: number = squad[11].id;

  /*
   * The current gameweek, now that the squad is known. `mustStart` pins the ten
   * starters who are not the blank; `mustSit` benches the blank and the reserve
   * keeper. Everyone else's team sheet is drawn by the generator.
   *
   * Pinning is what makes the demo tell the SAME story every time it is opened:
   * exactly one starter blanks, so exactly one auto-substitution is projected,
   * and the reserve keeper never takes the field to un-blank a keeper who is
   * supposed to be the reason a manager carries one.
   */
  const mustStart = new Set(
    squad.slice(0, 11).map((e) => e.id).filter((id) => id !== BLANK_ID)
  );
  gwData.set(
    CURRENT_GW,
    buildGw(CURRENT_GW, { mustStart, mustSit: new Set([BLANK_ID, RESERVE_GK_ID]) })
  );

  /*
   * Season aggregates, written back from the twenty gameweeks that were just
   * played. Every one of these was previously authored by hand next to the
   * generator that produced the matches, so the two told different stories
   * about the same player in the same modal.
   */
  {
    const blank = () => ({
      points: 0, minutes: 0, starts: 0, goals: 0, assists: 0,
      cs: 0, conceded: 0, bonus: 0, yellow: 0, saves: 0, bps: 0, apps: 0, recent: [] as number[],
    });
    const agg = new Map<number, ReturnType<typeof blank>>(elements.map((e) => [e.id, blank()]));
    for (let gw = 1; gw <= CURRENT_GW; gw++) {
      for (const r of gwData.get(gw)!.rows) {
        const a = agg.get(r.id)!;
        a.points += r.points;
        a.minutes += r.minutes;
        a.goals += r.goals;
        a.assists += r.assists;
        a.conceded += r.conceded;
        a.bonus += r.bonus;
        a.yellow += r.yellow;
        a.saves += r.saves;
        a.bps += r.bps;
        if (r.cs) a.cs++;
        if (r.minutes > 0) a.apps++;
        if (r.minutes >= 60) a.starts++;
        if (gw > CURRENT_GW - 4) a.recent.push(r.points);
      }
    }
    const lastGw = gwData.get(CURRENT_GW)!;
    for (const e of elements) {
      const a = agg.get(e.id)!;
      e.total_points = a.points;
      e.event_points = lastGw.byId.get(e.id)?.points ?? 0;
      e.minutes = a.minutes;
      e.starts = a.starts;
      e.goals_scored = a.goals;
      e.assists = a.assists;
      e.clean_sheets = a.cs;
      e.goals_conceded = a.conceded;
      e.bonus = a.bonus;
      // Season counting stats the app reads directly: `saves` drives the
      // keeper columns, `yellow_cards` drives the suspension-risk warning, and
      // `defensive_contribution` is the 2025/26 scoring category. All three
      // were absent from the demo bootstrap entirely, so those features had
      // nothing to render and silently showed nothing at all.
      e.saves = a.saves;
      e.bps = a.bps;
      e.yellow_cards = a.yellow;
      e.red_cards = 0;
      e.own_goals = 0;
      e.penalties_saved = 0;
      e.penalties_missed = 0;
      // Defensive actions: roughly ten per ninety for a defender, six for a
      // midfielder, two for a forward, none credited to a keeper.
      e.defensive_contribution = Math.round(
        (a.minutes / 90) * [0, 0, 10, 6, 2][e.element_type]
      );
      // FPL's points-per-game is per APPEARANCE, not per gameweek, so a
      // rotation player is not punished twice for the weeks he did not feature.
      e.points_per_game = (a.apps ? a.points / a.apps : 0).toFixed(1);
      e.form = (a.recent.length ? a.recent.reduce((s, v) => s + v, 0) / a.recent.length : 0).toFixed(1);
      e.ep_next = e.points_per_game;

      /*
       * ================ THE UNDERLYING NUMBERS, ALSO DERIVED ================
       *
       * `expected_goals`, `expected_assists`, `expected_goal_involvements`,
       * `expected_goals_conceded`, `ict_index` and `selected_by_percent` were
       * all written at generation time as functions of `q` — the CLUB's quality
       * — and nothing else. So every one of a club's fifteen players published
       * the same xG, the same ICT and the same ownership: a club's reserve
       * keeper was advertised at the same 11.5% as its 163-point striker.
       *
       * These are not decoration. `statLine` in xp.ts feeds `xg`, `xa` and
       * `ict` straight into the expected-points model, `StatsTable` sorts on
       * xGI, `PlayerModal` prints it, and the differential/template split is a
       * comparison of ownership against the field. A per-club constant told the
       * model that fifteen very different footballers were the same footballer,
       * which is precisely the signal the model exists to distinguish.
       *
       * So they are read off the season instead. xG is what he scored, pulled
       * a little toward what a man with his minutes would be expected to score
       * — that is what an expected-goals figure IS, a smoothed version of the
       * finishing, and it keeps a striker on a hot run from publishing an xG
       * identical to his goals. The over/under-performance factor is a stable
       * function of the player's id, so the same man is the same finisher every
       * time the demo is opened.
       */
      const per90 = (v: number) => (a.minutes > 0 ? (v * 90) / a.minutes : 0);
      const nineties = a.minutes / 90;
      // A stable ±20% finishing bias, so xG and goals are correlated without
      // being the same column twice.
      const bias = 0.8 + ((e.id * 37) % 41) / 100;
      const baseG = [0, 0.01, 0.06, 0.16, 0.34][e.element_type];
      const baseA = [0, 0.01, 0.08, 0.17, 0.13][e.element_type];
      // Blended toward the positional baseline, more heavily the fewer minutes
      // he has played: eight goals in thirty appearances is evidence about a
      // striker, eight in three is mostly luck.
      const w = Math.min(1, nineties / 12);
      const xg = nineties * (w * per90(a.goals) * bias + (1 - w) * baseG);
      const xa = nineties * (w * per90(a.assists) * bias + (1 - w) * baseA);
      e.expected_goals = xg.toFixed(2);
      e.expected_assists = xa.toFixed(2);
      // xGI is the SUM, by definition. Computing it from the same inputs a
      // third time invites the three to disagree in the last decimal, and
      // `StatsTable` sorts on it while `PlayerModal` prints all three.
      e.expected_goal_involvements = (xg + xa).toFixed(2);
      // Goals conceded while he was on the pitch, smoothed the same way.
      e.expected_goals_conceded = (a.conceded * (0.85 + ((e.id * 17) % 31) / 100)).toFixed(2);
      /*
       * ICT is FPL's own composite of influence, creativity and threat, and it
       * runs on a scale of a few hundred over a season for the men who do
       * things. Built from what he actually did rather than from his club's
       * rating: goals and assists dominate it, bonus points and defensive work
       * carry the rest, and a man who has not played has an index near zero
       * rather than his club's.
       */
      /*
       * THE COEFFICIENTS ARE CALIBRATED, NOT DECORATIVE. `statLine` divides
       * this by nineties and `expectedPoints` multiplies the result by
       * `bonusPerIct90` (0.045) to get a bonus-per-start expectation, so the
       * SCALE of the index decides how much bonus the model hands out. Real
       * ICT runs to roughly 450 over a full season for the best attacker —
       * about 13 per 90. An earlier draft ran to 758 over twenty gameweeks
       * (38 per 90), which asked the model for 1.7 bonus points a start and
       * pinned every good player against `bonusCap`, flattening exactly the
       * distinction the term exists to draw.
       */
      e.ict_index = (
        a.goals * 12 + a.assists * 7.5 + a.bonus * 2 + a.saves * 0.8 + nineties
      ).toFixed(1);
      /*
       * Ownership follows POINTS, because that is what managers chase. It was
       * a function of the club, so the differential badge was a club badge.
       * The curve is deliberately convex — FPL ownership is extremely
       * top-heavy, a handful of players above 40% and a long tail under 1% —
       * and the absolute level is fixed by the rescale below, so only the
       * shape matters here.
       */
      e.selected_by_percent = Math.pow(Math.max(0, a.points), 3.4).toFixed(4);

      delete e._quality;
      delete e._nailed;
    }

    /*
     * Ownership has to add up. Every manager picks fifteen players, so the
     * selected-by percentages of the whole playerbase sum to 1500% and no more.
     * The demo's raw curve summed to roughly 6,100% — four squads' worth — and
     * the differential/template classification the app draws is a comparison
     * against that total, so in demo mode almost nothing ever read as a
     * differential. Rescaling preserves the ordering (the popular players are
     * still the popular ones) and fixes the sum.
     */
    const raw = elements.map((e) => parseFloat(e.selected_by_percent));
    const scale = 1500 / raw.reduce((s, v) => s + v, 0);
    elements.forEach((e, i) => {
      e.selected_by_percent = Math.max(0.1, raw[i] * scale).toFixed(1);
    });
  }

  const elementById = new Map<number, Element>(elements.map((e) => [e.id, e as Element]));

  /*
   * A manager's gameweek score, computed the way THE APP computes it — through
   * the same `projectAutoSubs` the dashboard's pitch corner and the mini-league
   * table both run. That is the whole point of routing it through the shared
   * function rather than re-adding the eleven starters here: a blanking starter
   * whose fixture has finished is replaced by a bench player, so a demo that
   * states a total without the substitution states a different number from
   * every screen that draws one. The demo's own blanking starter is worth
   * several points of exactly that discrepancy.
   */
  const scoreOf = (
    entryPicks: Pick[],
    chip: string | null,
    gw: number
  ): { gross: number; bench: number } => {
    const data = gwData.get(gw)!;
    const { effectiveXi } = projectAutoSubs(
      entryPicks,
      elementById,
      data.live as unknown as EventLive,
      fixtures as Fixture[],
      gw
    );
    const playing = new Set(effectiveXi);
    let gross = 0;
    let bench = 0;
    for (const p of entryPicks) {
      const pts = data.points.get(p.element) ?? 0;
      if (chip === "bboost" || playing.has(p.element)) {
        gross += pts * (p.multiplier > 1 ? p.multiplier : 1);
      } else {
        bench += pts;
      }
    }
    return { gross, bench: chip === "bboost" ? 0 : bench };
  };

  /*
   * Rank from score. A rank is a POSITION IN A DISTRIBUTION, so it is derived
   * from one: how many standard deviations above the field a score sits, run
   * through a logistic approximation of the normal CDF.
   *
   * The previous shape was `5_000_000 × 0.9^(net − avg)`, an exponential with
   * no ceiling, which returned 12.9 million for a below-average week — a rank
   * larger than the game has players. Clamping it to `PLAYER_COUNT` fixed the
   * impossible number and introduced a worse one: everything past about −25
   * pinned at exactly 11,000,000, so a −7 week and a −16 week ranked
   * identically and the app's own "did I gain or lose ground" arithmetic had
   * nothing to work with. A CDF cannot exceed the playerbase and is strictly
   * monotonic in the score, which is what the property actually requires.
   */
  /*
   * A generated fifteen, used both by the nine mini-league rivals and by the
   * field sample two blocks below. It lives up here rather than down with the
   * mini-league because the FIELD AVERAGE has to exist before the history rows
   * are built, and the history rows are built before the rivals are.
   */
  const rivalSquad = (seed: number, depth = 0) => {
    // Clubs in a seed-dependent order, so two rivals rarely own the same team.
    const order = Array.from({ length: 20 }, (_, i) => i + 1).sort(
      (a, b) => rnd(seed * 977 + a) - rnd(seed * 977 + b)
    );
    const perClub = new Map<number, number>();
    const take = (t: number, count: number) => {
      const out: any[] = [];
      for (const club of order) {
        if (out.length === count) break;
        const used = perClub.get(club) ?? 0;
        if (used >= 3) continue; // the three-per-club rule binds rivals too
        const list = byTeamType(club, t);
        if (!list.length) continue;
        /*
         * HOW FAR DOWN A CLUB'S DEPTH CHART THIS MANAGER REACHES — which is
         * the difference between a rival and the field. At depth 0 he takes
         * the first-choice man, and that is a strong squad by construction:
         * nine rivals built that way are nine good managers, which is what a
         * mini-league is. The sampled field is NOT nine good managers. Left at
         * depth 0 the "average" was a league of experts, the demo manager
         * finished twenty gameweeks behind it, and the front page opened on a
         * rank of 7.8 million out of 11 million for a squad any reader can see
         * is a good one. An average is only an average if the average manager
         * is in it.
         */
        const want =
          depth === 0
            ? out.length < count - 1
              ? 0
              : 1
            : Math.floor(rnd(seed * 613 + club * 17 + t) * (depth + 1));
        const cand = list[Math.min(want, list.length - 1)] ?? list[0];
        if (!cand || out.includes(cand)) continue;
        out.push(cand);
        perClub.set(club, used + 1);
      }
      return out;
    };
    const gk = take(1, 2);
    const def = take(2, 5);
    const mid = take(3, 5);
    const fwd = take(4, 3);
    // 4-4-2 with the last of each position on the bench, same shape the demo
    // manager plays, so the auto-sub projection has somewhere to go.
    const shaped = [
      gk[0], ...def.slice(0, 4), ...mid.slice(0, 4), ...fwd.slice(0, 2),
      gk[1], def[4], mid[4], fwd[2],
    ];
    /*
     * And then he pays for them, exactly as the demo manager does. `take` picks
     * the best man at each club it visits, which comes to something near £115m
     * — a squad the game would refuse. The repair swaps positions in place, so
     * the 1..15 ordering above survives it and slot 12 is still the reserve
     * keeper.
     */
    return investBank(repairToBudget(shaped, SQUAD_BUDGET), SQUAD_BUDGET, depth);
  };

  /*
   * ===================== WHAT THE FIELD SCORED, DERIVED =====================
   *
   * `average_entry_score` used to be `42 + ((gw * 13) % 25)` — a sawtooth
   * between 42 and 66 with a mean of about 53.5, written down with no
   * relationship to the players this universe says were on the pitch. Nothing
   * in the demo checked it, and it is load-bearing for FOUR different things:
   * every gameweek rank, every overall rank, the "vs average" line on the
   * dashboard, and the season planner's field comparison.
   *
   * The consequence was not a rounding error. The demo manager's squad is
   * chosen from the same generated players everyone else's is, so it scores
   * around 48 a week — below an invented average of 53.5, every single week,
   * cumulatively. By GW20 he was ranked 10,624,861st of 11,000,000: a demo
   * whose headline screen is a rank, opening on the bottom three percent, while
   * the pitch above it showed a perfectly respectable team. The number was not
   * wrong about the manager; it was wrong about the field.
   *
   * So the field is SAMPLED. Twenty-four budget-legal squads are generated,
   * played through the same `scoreOf` against the same live feed, and
   * averaged. Seeds are offset well clear of the rival entry ids so the
   * mini-league is not scoring itself against nine copies of its own members.
   * No chips and no hits: a chip is a once-a-season event and the average is
   * over eleven million managers, so the mean week is a plain one.
   *
   * The depth argument is what makes it a FIELD rather than nine more experts
   * — see `rivalSquad`. At depth 2 the sampled managers reach two or three men
   * down each club's list, which is what the eleven million actually look like.
   * They average around 41 a week; the demo manager's greedy-optimal fifteen
   * averages around 47 and finishes the twenty weeks around 615,000th of
   * eleven million — the top six per cent, earned against a real distribution
   * rather than asserted. (It was ~215,000th before these sampled managers
   * learned to spend their bank; a field that sits on £14m does flatter the
   * reader, but not honestly.)
   *
   * The result is an average that MOVES WITH THE FIXTURES — a blank week drags
   * the field down exactly as it drags the manager down — which is the property
   * the ranks actually need and the one a written-down sawtooth cannot have.
   */
  {
    const FIELD_SAMPLE = 24;
    const samples = Array.from({ length: FIELD_SAMPLE }, (_, i) => {
      const fifteen = rivalSquad(500_000 + i * 37, 2);
      const { captain, vice } = armbandFor(fifteen);
      return fifteen.map((e, ix) => ({
        element: e.id,
        position: ix + 1,
        multiplier: ix === captain ? 2 : ix < 11 ? 1 : 0,
        is_captain: ix === captain,
        is_vice_captain: ix === vice,
      }));
    });
    for (let gw = 1; gw <= CURRENT_GW; gw++) {
      const total = samples.reduce((s, picks) => s + scoreOf(picks, null, gw).gross, 0);
      /*
       * A sampled mean is a mean of GOOD-FAITH SQUADS, and the eleven million
       * are not all good faith: dead teams, abandoned teams and teams that
       * never made a transfer all sit in FPL's published average and pull it
       * down. The real gap runs a few points; five per cent is the shape of it
       * without pretending to a precision the demo has no source for.
       */
      events[gw - 1].average_entry_score = Math.round((total / FIELD_SAMPLE) * 0.95);
    }
  }

  const phi = (z: number) => 1 / (1 + Math.exp(-1.702 * z));
  const rankFromZ = (z: number) =>
    Math.max(1, Math.min(PLAYER_COUNT, Math.round(PLAYER_COUNT * (1 - phi(z)))));
  const GW_SD = 18; // spread of a single gameweek's scores
  const SEASON_SD = 14; // per-gameweek spread of the season-long running total

  /*
   * The season's history rows. NOT ONE FIGURE HERE IS WRITTEN DOWN. Every
   * gameweek's score is what that week's squad actually scored against that
   * week's live feed; the bench total comes off the same reckoning; the running
   * total accumulates; the ranks come out of the distribution; the value walks
   * from the £100.0m everyone starts with to the squad the demo really owns.
   *
   * Nineteen of these used to be `40 + ((gw * 17) % 42)` — a number with no
   * relationship to the players on the pitch that week, which is exactly why
   * the time machine and the history chart could not both be right.
   */
  let running = 0;
  let runningAvg = 0;
  const historyRows = Array.from({ length: CURRENT_GW }, (_, i) => {
    const gw = i + 1;
    const chip = chipEvents.get(gw) ?? null;
    const { gross: points, bench } = scoreOf(picksAt(gw), chip, gw);
    const plan = planFor.get(gw);
    const cost = plan?.cost ?? 0;
    running += points - cost;
    // The field's score comes from the events table rather than being
    // re-derived from the same formula in a second place, which is how the two
    // drifted apart the first time.
    runningAvg += events[gw - 1].average_entry_score;
    return {
      event: gw,
      points,
      total_points: running,
      rank: rankFromZ((points - cost - events[gw - 1].average_entry_score) / GW_SD),
      // The overall rank is a function of the season SO FAR, so a bad week has
      // to push it the wrong way. It used to be `400_000 − gw × 8_000`: a
      // straight line that improved every single gameweek no matter what the
      // manager scored, including the ones he lost points on.
      overall_rank: rankFromZ((running - runningAvg) / (SEASON_SD * Math.sqrt(gw))),
      bank: bankAt.get(gw)!,
      value: valueAt.get(gw)!,
      event_transfers: plan?.count ?? 0,
      event_transfers_cost: cost,
      // Bench Boost weeks have no bench points by definition — the bench
      // played, so its score is in `points`, and FPL reports zero left on it.
      points_on_bench: bench,
    };
  });
  const currentRow = historyRows[CURRENT_GW - 1];
  const prevRow = historyRows[CURRENT_GW - 2];
  const seasonTotal = running;

  /*
   * ============================ THE MINI-LEAGUE ============================
   *
   * Nine rivals, each with a REAL SQUAD played through all twenty gameweeks.
   * This costs more than inventing ten numbers, and it is the only way the
   * league table can be true.
   *
   * `MiniLeague` does not display `event_total` when it can do better: it
   * fetches each rival's picks, runs them through `projectAutoSubs` and the
   * live feed, and renders THAT (MiniLeague.tsx:373). The demo API served the
   * demo manager's own picks for every entry id, so all ten rows resolved to
   * the same live score — a table whose stored gameweek column disagreed with
   * the one actually drawn over it, in ten places at once. Giving each rival a
   * squad fixes both halves: the picks endpoint returns something different per
   * manager, and `event_total` here is computed from that same squad by the
   * same function, so the stored figure and the rendered figure agree.
   */
  const rivalEntries = Array.from({ length: 9 }, (_, i) => 999_900 + i);
  type Rival = {
    entry: number;
    name: string;
    manager: string;
    fifteen: any[];
    chipAt: (gw: number) => string | null;
    hitAt: (gw: number) => number;
    picksAt: (gw: number) => Pick[];
  };
  const rivals = new Map<number, Rival>();
  rivalEntries.forEach((id, i) => {
    /*
     * A MINI-LEAGUE IS A SPREAD, NOT NINE COPIES OF THE SAME GOOD MANAGER.
     * All nine were built at depth 0 — the best available man at every club —
     * which is close to the greedy optimum the demo manager himself holds, so
     * six of the nine outscored him and the front page showed a manager sitting
     * seventh of ten in his own league while the card above it called him top
     * 2%. Two true things that read as one contradiction.
     *
     * Depth is how far down each club's list a manager is willing to go, so it
     * is exactly the dial for "how well does he pick": 0 is the sharp one, 3
     * the friend who drafted on shirt numbers. Cycling it gives a league with a
     * top, a middle and a tail, and puts the reader near but not at the top.
     */
    const fifteen = rivalSquad(id, i % 4);
    // A chip apiece for two of them in the current week, so the badge and the
    // bench-boost scoring path are both exercised by something other than the
    // demo manager.
    const chipAt = (gw: number) =>
      gw !== CURRENT_GW ? null : id % 7 === 0 ? "bboost" : id % 5 === 0 ? "3xc" : null;
    const hitAt = (gw: number) => (rnd(id * 31 + gw) < 0.25 ? 4 : 0);
    rivals.set(id, {
      entry: id,
      name: `Rival FC ${i + 1}`,
      manager: `Manager ${i + 1}`,
      fifteen,
      chipAt,
      hitAt,
      picksAt: (gw: number) => {
        const { captain, vice } = armbandFor(fifteen);
        const chip = chipAt(gw);
        const capMult = chip === "3xc" ? 3 : 2;
        // Same Bench Boost rule the demo manager's picks obey: on a boosted
        // week FPL returns `multiplier: 1` for positions 12-15, and
        // `MiniLeague` re-derives each rival's live score from exactly these
        // numbers. Leaving the bench at 0 made the boosted rival's rendered
        // score contradict the stored `event_total` sitting beside it.
        const benchMult = chip === "bboost" ? 1 : 0;
        return fifteen.map((e, ix) => ({
          element: e.id,
          position: ix + 1,
          multiplier: ix === captain ? capMult : ix < 11 ? 1 : benchMult,
          is_captain: ix === captain,
          is_vice_captain: ix === vice,
        }));
      },
    });
  });

  /*
   * Every rival's whole season, played out rather than asserted. A rival's
   * total is what he actually scored week by week, so `total − event_total` is
   * a real previous standing and `last_rank` can be derived from it. Ranks then
   * fall out of sorting; nobody is assigned a position, which is how the old
   * table managed to say a manager had climbed in a week he lost ground.
   */
  const rivalRows = new Map<number, ReturnType<typeof historyRowsFor>>();
  function historyRowsFor(r: Rival) {
    let total = 0;
    let avgTotal = 0;
    /*
     * A RIVAL'S MONEY IS HIS OWN. Every rival's every gameweek reported
     * `bank: 5, value: 1000` — the same two constants for nine managers across
     * twenty weeks — so the mini-league's team-value column was a column of
     * £100.0m, nobody's squad ever appreciated, and the one figure a reader
     * uses to judge whether a rival has been managing well said nothing at all.
     *
     * He holds this fifteen all season (that is what `picksAt` returns), so his
     * ledger is exactly the game's arithmetic: he paid GW1 prices, his bank is
     * what was left of the budget, and his team value is the sum of what he
     * could sell for today — `purchase + floor((now - purchase) / 2)` on a
     * rise, and the current price on a fall.
     */
    const paid = r.fifteen.map((e) => priceAt(e, 1));
    const rivalBank = INITIAL_BUDGET - paid.reduce((s, v) => s + v, 0);
    return Array.from({ length: CURRENT_GW }, (_, i) => {
      const gw = i + 1;
      const squadValue = r.fifteen.reduce(
        (s, e, ix) => s + sellingPrice(paid[ix], priceAt(e, gw)),
        0
      );
      const chip = r.chipAt(gw);
      const { gross, bench } = scoreOf(r.picksAt(gw), chip, gw);
      const hit = r.hitAt(gw);
      total += gross - hit;
      avgTotal += events[gw - 1].average_entry_score;
      return {
        event: gw,
        points: gross,
        total_points: total,
        rank: rankFromZ((gross - hit - events[gw - 1].average_entry_score) / GW_SD),
        // A GAMEWEEK rank and an OVERALL rank are different questions: one week
        // against the field, versus the whole season against the field. These
        // two were byte-identical expressions, so a rival who had a good week
        // after a bad season jumped to the same overall rank as his gameweek
        // rank, and the mini-league's "overall" column was really nineteen
        // gameweeks of noise.
        overall_rank: rankFromZ((total - avgTotal) / (SEASON_SD * Math.sqrt(gw))),
        // `value` is squad PLUS bank, which is why every manager reads exactly
        // 1000 after GW1 however much he left unspent. See `display.teamValue`.
        bank: rivalBank,
        value: squadValue + rivalBank,
        event_transfers: hit / 4 + 1,
        event_transfers_cost: hit,
        points_on_bench: bench,
        active_chip: chip,
      };
    });
  }
  for (const r of rivals.values()) rivalRows.set(r.entry, historyRowsFor(r));

  const gwNet = currentRow.points - currentRow.event_transfers_cost;
  const unranked = [
    {
      entry: DEMO_ENTRY_ID,
      entry_name: ENTRY_NAME,
      player_name: "Demo Manager",
      before: seasonTotal - gwNet,
      event_total: gwNet,
    },
    ...rivalEntries.map((id) => {
      const r = rivals.get(id)!;
      const rows = rivalRows.get(id)!;
      const last = rows[CURRENT_GW - 1];
      return {
        entry: id,
        entry_name: r.name,
        player_name: r.manager,
        before: rows[CURRENT_GW - 2].total_points,
        event_total: last.total_points - rows[CURRENT_GW - 2].total_points,
      };
    }),
  ];
  /*
   * Ranking with FPL's tie rule: level on points is level in the table, so tied
   * managers SHARE a rank and the next man down takes the position their count
   * would have given him — 1, 2, 2, 4, not 1, 2, 3, 4. Positional ranking by
   * array index gave two managers on the same total different places, so the
   * table said one of them was ahead of the other while printing identical
   * point counts beside both. With ten real squads played out over twenty
   * gameweeks, ties are not a rare case; the demo produced one on the first run.
   */
  const rankMap = (ordered: { entry: number; score: number }[]) => {
    const m = new Map<number, number>();
    ordered.forEach((r, i) => {
      const tiedWith = ordered.findIndex((o) => o.score === r.score);
      m.set(r.entry, tiedWith + 1 === i + 1 ? i + 1 : tiedWith + 1);
    });
    return m;
  };
  const totalOf = (r: (typeof unranked)[number]) => r.before + r.event_total;
  const byTotal = [...unranked].sort((a, b) => totalOf(b) - totalOf(a));
  const rankByTotal = rankMap(byTotal.map((r) => ({ entry: r.entry, score: totalOf(r) })));
  const beforeOrder = [...unranked].sort((a, b) => b.before - a.before);
  const rankByBefore = rankMap(beforeOrder.map((r) => ({ entry: r.entry, score: r.before })));
  const leagueResults = byTotal.map((r) => ({
    entry: r.entry,
    entry_name: r.entry_name,
    player_name: r.player_name,
    rank: rankByTotal.get(r.entry)!,
    last_rank: rankByBefore.get(r.entry)!,
    total: totalOf(r),
    event_total: r.event_total,
  }));
  const myRow = leagueResults.find((r) => r.entry === DEMO_ENTRY_ID)!;

  /*
   * A gameweek's highest score cannot sit below a score this same universe says
   * somebody achieved. The floor above is an invention; the ceiling has to
   * respect the facts, so it is raised to clear the best stated score of the
   * week. (The real record holder is one of eleven million managers, none of
   * whom are in this demo, so a margin over the best of the ten is right.)
   */
  for (let gw = 1; gw <= CURRENT_GW; gw++) {
    const stated = [
      historyRows[gw - 1].points - historyRows[gw - 1].event_transfers_cost,
      ...[...rivalRows.values()].map((rows) => rows[gw - 1].points - rows[gw - 1].event_transfers_cost),
    ];
    const ev = events[gw - 1];
    // A played gameweek has a highest score by definition. If this ever fires,
    // the events table and the history rows disagree about which weeks have
    // been played, and every rank in the demo is built on the wrong footing —
    // so it fails loudly rather than quietly picking a floor of zero.
    if (ev.highest_score === null) {
      throw new Error(`demo: gameweek ${gw} has been played but states no highest score`);
    }
    ev.highest_score = Math.max(ev.highest_score, Math.max(...stated) + 12 + ((gw * 5) % 9));
  }

  const entry = {
    id: DEMO_ENTRY_ID,
    player_first_name: "Demo",
    player_last_name: "Manager",
    name: ENTRY_NAME,
    summary_overall_points: seasonTotal,
    summary_overall_rank: currentRow.overall_rank,
    // GROSS, mirroring `entry_history.points`. The app is responsible for
    // taking the hit off before it shows the figure to anyone.
    summary_event_points: currentRow.points,
    summary_event_rank: currentRow.rank,
    current_event: CURRENT_GW,
    last_deadline_bank: BANK,
    last_deadline_value: squadValue,
    leagues: {
      classic: [
        // Every standing here is read off the table the app will actually draw
        // when the league is opened, not asserted alongside it. Two of these
        // used to be hard-coded — "Office Rivals #1" opened onto a table in
        // which the manager sat fifth — and the public leagues restated the
        // overall rank a third time.
        {
          id: 900001,
          name: "Demo League of Legends",
          league_type: "x",
          entry_rank: myRow.rank,
          entry_last_rank: myRow.last_rank,
        },
        {
          id: 314,
          name: "Overall",
          league_type: "s",
          entry_rank: currentRow.overall_rank,
          entry_last_rank: prevRow.overall_rank,
        },
      ],
    },
  };

  /*
   * Previous seasons, anchored to THIS UNIVERSE'S OWN CLOCK rather than to the
   * wall calendar. The list used to be labelled from the current month, while
   * the running season is labelled from GW1's deadline (`currentSeasonName`);
   * the two disagree for seventy-seven days a year — every day from 1 August
   * until mid-October — and on those days the demo listed the season it is
   * twenty gameweeks INTO as a finished past season, complete with a final
   * rank. Opening Past seasons then showed "2025/26 · 2,311 pts" expanding into
   * a nineteen-gameweek archive of the season still being played.
   */
  const gw1 = new Date(deadlineFor(1));
  const thisSeasonStart =
    gw1.getUTCMonth() >= 5 ? gw1.getUTCFullYear() : gw1.getUTCFullYear() - 1;
  const seasonLabel = (startYear: number) =>
    `${startYear}/${String((startYear + 1) % 100).padStart(2, "0")}`;
  const history = {
    current: historyRows,
    chips: chipHistory,
    past: [
      { total_points: 2210, rank: 342_100 },
      { total_points: 2350, rank: 187_553 },
      { total_points: 2311, rank: 154_321 },
    ].map((s, i) => ({ season_name: seasonLabel(thisSeasonStart - 3 + i), ...s })),
  };

  const league = {
    league: { id: 900001, name: "Demo League of Legends" },
    standings: { has_next: false, results: leagueResults },
  };

  /**
   * The live feed for ANY gameweek, not just the current one. `event/{gw}/live/`
   * used to serve GW20 whatever was asked for, so the points breakdown added
   * GW20's scoring up nineteen times and reconciled the season to a total the
   * dashboard had never heard of.
   */
  const liveFor = (gw: number) => {
    const built = gwData.get(gw);
    if (built) return built.live;
    /*
     * A GAMEWEEK THAT HAS NOT BEEN PLAYED IS NOT THIS GAMEWEEK. The fallback
     * here was `gwData.get(CURRENT_GW)`, so asking for GW25 — which the Team
     * tab's forward navigation and any stale client cache will do — got GW20's
     * scores back under a GW25 heading, complete with itemised goals for
     * matches that have not kicked off. FPL answers an unplayed week with the
     * full element list and every stat at zero, and so does this: the shape
     * the client parses is identical, and the numbers are honest.
     */
    return {
      elements: elements.map((e) => ({
        id: e.id,
        stats: {
          minutes: 0,
          total_points: 0,
          bonus: 0,
          bps: 0,
          goals_scored: 0,
          assists: 0,
          clean_sheets: 0,
          goals_conceded: 0,
          saves: 0,
          yellow_cards: 0,
          red_cards: 0,
          own_goals: 0,
          penalties_saved: 0,
          penalties_missed: 0,
        },
        explain: [] as { fixture: number; stats: { identifier: string; points: number; value: number }[] }[],
      })),
    };
  };

  /**
   * Picks for ANY entry in the demo league in ANY gameweek. Both halves were
   * broken: the route ignored the entry id and handed back the demo manager's
   * team, which is why every rival in the mini-league scored exactly what he
   * did, and it ignored the gameweek, which is why the time machine drew the
   * GW20 pitch under a GW15 caption.
   */
  const picksFor = (id: number, gw: number = CURRENT_GW) => {
    const week = Math.max(1, Math.min(CURRENT_GW, gw));
    if (id === DEMO_ENTRY_ID) {
      const row = historyRows[week - 1];
      return {
        active_chip: chipEvents.get(week) ?? null,
        picks: picksAt(week),
        entry_history: { ...row },
      };
    }
    const r = rivals.get(id);
    /*
     * AN ENTRY THE DEMO DOES NOT HAVE IS A 404, not the demo manager's team.
     * The fallback used to be "anyone I don't recognise gets my own squad",
     * which is the single most damaging shape a stub can take: it never errors,
     * so nothing surfaces, and every consumer quietly reads the same fifteen
     * players. `LiveTab`'s safety score takes the median of the league's live
     * scores to tell the manager whether he is ahead of the field — and with
     * every unknown entry resolving to him, that median WAS his own score, so
     * the panel always said he was exactly average and could never say
     * otherwise. Returning null lets the route answer honestly.
     */
    if (!r) return null;
    const rows = rivalRows.get(id)!;
    const { active_chip, ...row } = rows[week - 1];
    return { active_chip, picks: r.picksAt(week), entry_history: row };
  };

  /**
   * Standings for whichever league was asked for. One object used to answer for
   * every league id, so the public "Overall" league opened onto the ten-manager
   * demo table with the manager sitting fifth against the 320,325th place the
   * card had just advertised.
   */
  const leagueFor = (id: number) => {
    if (id === 900001) return league;
    const l = entry.leagues.classic.find((x) => x.id === id);
    if (!l) return league;
    /*
     * A public league is a slice of the whole playerbase — but the rows in that
     * slice have to be MANAGERS THIS UNIVERSE HAS. They used to be invented on
     * the spot as `2_000_000 + rank`, entry ids `picksFor` has never heard of,
     * so clicking any neighbour in the Overall league fetched a team that did
     * not exist. The neighbours are the demo's own ten managers, shifted so the
     * demo manager lands on the rank his entry summary advertises.
     *
     * Rank follows total, for everybody: the rows are already ordered by season
     * total, so a constant offset preserves "higher total, better rank". And
     * `last_rank` is derived the same way for every row — from the ordering of
     * the previous week's totals — rather than being read off the entry for one
     * row and invented with `(i % 3) - 1` for the other eight, which is how the
     * table came to show managers climbing and falling at random.
     */
    const myRank = rankByTotal.get(DEMO_ENTRY_ID)!;
    const myLastRank = rankByBefore.get(DEMO_ENTRY_ID)!;
    const rank = l.entry_rank;
    const lastRank = l.entry_last_rank ?? rank;
    const rows = leagueResults.map((r) => ({
      entry: r.entry,
      entry_name: r.entry_name,
      player_name: r.player_name,
      // Shifted by the SHARED rank, not the array position, so two managers
      // level on points stay level here too.
      rank: Math.max(1, rank + (rankByTotal.get(r.entry)! - myRank)),
      last_rank: Math.max(1, lastRank + (rankByBefore.get(r.entry)! - myLastRank)),
      total: r.total,
      event_total: r.event_total,
    }));
    return {
      league: { id: l.id, name: l.name },
      // False, and it has to be: the demo route cannot see `?page_standings=`,
      // so there is no second page to fetch. Claiming one made the app's
      // paginated league view offer a "next" that returned page one again.
      standings: { has_next: false, results: rows },
    };
  };

  /**
   * A player's gameweek-by-gameweek season, read off the same match feeds that
   * produced his season totals. The demo API used to invent these rows from the
   * element id, so the recent-starts model was fed a rotation pattern that
   * contradicted both the player's own minutes and every live score he had.
   */
  const elementHistory = (id: number) => ({
    /*
     * THROUGH THE CURRENT GAMEWEEK, not up to it. This was `CURRENT_GW - 1`,
     * which stopped at GW19 — so `fetchRecentForm`, whose whole job is to
     * answer "has he started recently", never saw the most recent week the
     * demo has. Every GW20 fixture in this universe has kicked off (most have
     * finished, two are in play), and FPL publishes the round as soon as it
     * starts, so the row belongs here.
     */
    history: Array.from({ length: CURRENT_GW }, (_, i) => {
      const r = gwData.get(i + 1)!.byId.get(id);
      if (!r) return null;
      return {
        element: id,
        round: i + 1,
        minutes: r.minutes,
        starts: r.minutes >= 60 ? 1 : 0,
        total_points: r.points,
        goals_scored: r.goals,
        assists: r.assists,
        clean_sheets: r.cs ? 1 : 0,
        goals_conceded: r.conceded,
        saves: r.saves,
        bonus: r.bonus,
        bps: r.bps,
        opponent_team: r.opponent,
        was_home: r.wasHome,
      };
    }).filter(Boolean),
    /*
     * ======================= AND LAST SEASON =======================
     *
     * `history_past` was absent entirely, so `fetchPastSeason` returned an
     * empty map for every player in the demo. That is not a missing nicety:
     * it is the STRONGEST pre-season signal the model has, and the one field
     * that survives FPL's summer reset of the bootstrap. With it empty, the
     * whole `fromPast` branch of `statLine` — the branch that decides who is
     * nailed on and who is a rotation risk before a ball is kicked — was
     * unreachable in demo mode, and the pre-season pipeline the app ships
     * could not be demonstrated at all.
     *
     * A previous season is not a second copy of this one. It is scaled to a
     * full 38 games and given a stable per-player wobble, because a
     * footballer's last season resembles his current one without repeating it
     * — and a demo in which every man reproduces himself exactly would make
     * the shrinkage in xp.ts look far more confident than it is.
     */
    history_past: (() => {
      const e = elementById.get(id);
      if (!e) return [];
      // Two seasons, the older one a little further from the player he is now.
      return [2, 1].map((back) => {
        /*
         * A PAST SEASON IS STILL ONE SEASON, and the wobble is what decides
         * whether it stays one. Scaling twenty gameweeks up to thirty-eight and
         * then multiplying by a factor that reaches 1.26 hands an ever-present
         * 4,300 minutes and 47 starts — figures no season can contain, and
         * precisely the two `statLine` divides by to get per-90 rates and the
         * start rate it reads as "nailed on". So the factor tops out just below
         * 1: at the ceiling a man who played every minute of every gameweek
         * this season played every minute of all 38 last season, and nobody
         * plays more than that.
         *
         * Clamping the OUTPUTS instead would have been the obvious fix and is
         * the wrong one — an ever-present would hit the same cap in both past
         * seasons and so report them identically, which is exactly the "two
         * independent observations that are really one" that the shrinkage in
         * xp.ts must not be fed.
         *
         * The older season is then a strict further step down from the newer:
         * a footballer's last season resembles his current one more closely
         * than the one before it does.
         */
        const near = 0.72 + ((id * 29) % 28) / 100; // 0.72 .. 0.99
        const wobble = back === 1 ? near : near * (0.7 + ((id * 47) % 20) / 100);
        const scale = (38 / CURRENT_GW) * wobble;
        const mins = Math.round(e.minutes * scale);
        const r2 = (v: number | undefined) => Math.round((v ?? 0) * scale);
        return {
          season_name: seasonLabel(thisSeasonStart - back),
          total_points: r2(e.total_points),
          minutes: mins,
          starts: r2(e.starts),
          goals_scored: r2(e.goals_scored),
          assists: r2(e.assists),
          clean_sheets: r2(e.clean_sheets),
          goals_conceded: r2(e.goals_conceded),
          saves: r2(e.saves),
          bonus: r2(e.bonus),
          bps: r2(e.bps),
          yellow_cards: r2(e.yellow_cards),
          red_cards: 0,
          own_goals: 0,
          penalties_saved: 0,
          penalties_missed: 0,
          defensive_contribution: r2(e.defensive_contribution),
          ict_index: (parseFloat(e.ict_index) * scale).toFixed(1),
          expected_goals: (parseFloat(e.expected_goals) * scale).toFixed(2),
          expected_assists: (parseFloat(e.expected_assists) * scale).toFixed(2),
          expected_goal_involvements: (
            parseFloat(e.expected_goal_involvements) * scale
          ).toFixed(2),
          expected_goals_conceded: (
            parseFloat(e.expected_goals_conceded) * scale
          ).toFixed(2),
          // A past season's price, in the units FPL publishes it in.
          start_cost: e.now_cost - e.cost_change_start,
          end_cost: e.now_cost,
          element_code: id,
        };
      });
    })(),
  });

  /**
   * A manager's season, for ANY manager in the demo league.
   *
   * `entry/{id}/history/` threw the id away and served the demo manager's own
   * season to every caller, which is the same defect `picksFor` was built to
   * fix one endpoint over: a rival's card opened on the demo manager's points,
   * his ranks and his chips, so nine managers had one identical season and the
   * mini-league's history was a mirror. The rows already exist per rival —
   * `rivalRows` — so this is a lookup, not a computation.
   */
  const historyFor = (id: number) => {
    if (id === DEMO_ENTRY_ID) return history;
    const rows = rivalRows.get(id);
    if (!rows) return null;
    return {
      current: rows,
      // A rival's chips are the ones his own season used, read off his own
      // rows rather than copied from the demo manager's list.
      chips: rows
        .filter((r) => r.active_chip)
        .map((r) => ({ name: r.active_chip as string, time: deadlineFor(r.event), event: r.event })),
      past: [] as { season_name: string; total_points: number; rank: number }[],
    };
  };

  return {
    bootstrap,
    fixtures,
    entry,
    picks: picksFor(DEMO_ENTRY_ID, CURRENT_GW),
    picksFor,
    history,
    historyFor,
    transfers,
    live: liveFor(CURRENT_GW),
    liveFor,
    league,
    leagueFor,
    elementHistory,
  };
}
