// Subset of the official FPL API types that the app uses.
// Prices are in tenths of £m (e.g. 55 = £5.5m) — same convention as the API.

export type ElementType = 1 | 2 | 3 | 4; // GK, DEF, MID, FWD

export interface Element {
  id: number;
  web_name: string;
  first_name: string;
  second_name: string;
  photo?: string; // e.g. "223340.jpg" -> player photo id
  team: number;
  element_type: ElementType;
  now_cost: number;
  cost_change_start: number;
  form: string;
  points_per_game: string;
  total_points: number;
  event_points: number;
  status: "a" | "d" | "i" | "s" | "u" | "n";
  news: string;
  /** When the current `news` string was published, ISO ("2026-08-06T17:30:12.1Z").
   *  Optional because most fixtures and the demo feed do not synthesise it; the
   *  live bootstrap always carries it, `null` when there is no news. Read only to
   *  date a flag — a knock added after a snapshot was taken is information the
   *  reader of that snapshot did not have. */
  news_added?: string | null;
  chance_of_playing_next_round: number | null;
  selected_by_percent: string;
  minutes: number;
  starts: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  bonus: number;
  /**
   * Season total of yellow cards. Read for one purpose: a player sitting on
   * four of them is one booking from an automatic ban, and until he actually
   * gets it his `status` is a perfectly innocent "a". The function that reads it
   * is `suspensionMissProbs` in xp.ts; `suspensionAvail` is its summary.
   */
  yellow_cards?: number;
  ict_index: string;
  expected_goals: string;
  expected_assists: string;
  expected_goal_involvements: string;
  expected_goals_conceded: string;
  /** Season COUNT of defensive actions (tackles + CBI + recoveries), 2025/26+.
   *  NOT points — a nailed DM racks up 300–500 over a season. The +2 DC points
   *  are modelled in xp.ts via a Poisson tail against the 10/12 threshold. */
  defensive_contribution?: number;
  ep_next: string | null;
  penalties_order?: number | null;
  corners_and_indirect_freekicks_order?: number | null;
  direct_freekicks_order?: number | null;
  saves?: number;
  bps?: number;
  transfers_in_event?: number;
  transfers_out_event?: number;
  /** 2026/27 Price Change Predictor: progress toward the next price change as a
   *  signed percentage string ("96" = 96% of the way to a rise, "-97" to a fall).
   *  Past ±100 the change is expected at the next 00:00 UK update. */
  price_change_percent?: string;
  /** Price movement so far this gameweek, in tenths of £m. */
  cost_change_event?: number;
}

export interface Team {
  id: number;
  code?: number; // kit/badge asset id
  name: string;
  short_name: string;
  strength: number;
  strength_overall_home: number;
  strength_overall_away: number;
  strength_attack_home: number;
  strength_attack_away: number;
  strength_defence_home: number;
  strength_defence_away: number;
}

export interface Event {
  id: number;
  name: string;
  deadline_time: string;
  finished: boolean;
  is_current: boolean;
  is_next: boolean;
  average_entry_score: number;
  highest_score: number | null;
  /*
   * WHAT THE FIELD DID. Published on every event and, until `field.ts`, never
   * read by this app — which had no model of its competition at all.
   *
   * All four are null or empty for a gameweek that has not finished, so
   * pre-season they are null for all 38. Nothing may treat an absent value as a
   * zero: "no manager captained him" and "the week has not happened" are
   * different claims and only one of them is ever true here.
   */
  /** Element id of the most-captained player. An id, never a share. */
  most_captained?: number | null;
  most_vice_captained?: number | null;
  most_selected?: number | null;
  /** Managers who played each chip in this gameweek. */
  chip_plays?: { chip_name: string; num_played: number }[];
  transfers_made?: number;
}

export interface BootstrapChip {
  id?: number;
  name: string; // "wildcard" | "freehit" | "bboost" | "3xc" | ...
  start_event: number;
  stop_event: number;
  number?: number;
}

export interface Bootstrap {
  events: Event[];
  teams: Team[];
  elements: Element[];
  chips?: BootstrapChip[];
  total_players: number;
}

export interface Fixture {
  id: number;
  event: number | null;
  team_h: number;
  team_a: number;
  team_h_difficulty: number;
  team_a_difficulty: number;
  kickoff_time: string | null;
  finished: boolean;
  started?: boolean;
  team_h_score: number | null;
  team_a_score: number | null;
}

/**
 * A player's completed-season line from element-summary's `history_past`.
 *
 * This is the only per-player record that SURVIVES FPL's summer reset: some
 * weeks before GW1 the bootstrap zeroes `defensive_contribution`, and later
 * `minutes`/`starts`/`total_points` too. Without this the model would go into
 * the new season knowing nothing about who actually plays.
 */
export interface PastSeasonStats {
  seasonName?: string;
  points: number;
  minutes: number;
  /** Games STARTED — the single best predictor of next season's minutes. */
  starts?: number;
  /** Season count of defensive actions (the +2 DC threshold stat). */
  defensiveContribution?: number;
  goals?: number;
  assists?: number;
  xg?: number;
  xa?: number;
  bonus?: number;
  ict?: number;
  saves?: number;
  /**
   * How many completed Premier League seasons the player has on record.
   * 0 means he has never been in the game — a signing from abroad, an academy
   * graduate — and price is then the only evidence of his expected role.
   * Distinguishing that from "registered last season and played nothing" is
   * the difference between rating a marquee arrival and rating a third-choice
   * keeper, and the two look identical in the bootstrap.
   */
  plSeasons?: number;
  /**
   * The most recent completed season's workload, INCLUDING zeroes. This is what
   * the minutes model should judge on: a player who started 30 games two years
   * ago but none last season is a bench player now.
   *
   * `starts` is declared optional for callers that build a workload by hand;
   * the live API always sends the field, and always as a number.
   *
   * A ZERO IS NOT SELF-EXPLANATORY. FPL only began populating the field in
   * 2022/23 — before that every row reads `0` regardless of what the player
   * actually did, so a 3000-minute 2020/21 season arrives here as "0 starts".
   * Consumers must disambiguate on the season name via `startsUnrecorded` in
   * `xp.ts`, which tests against `XP_CONFIG.startsRecordedFrom`. Treating the
   * zero at face value rated career regulars returning via promoted clubs
   * below players who had never appeared at all.
   */
  lastSeason?: SeasonWorkload;
  /**
   * Every completed Premier League season on record, oldest first.
   *
   * The minutes model weights these by age rather than reading only the newest,
   * which is what lets it tell apart the three cases that all look like "no
   * recent starts": a player who has faded, a nailed regular who lost a season
   * to injury, and a regular who spent last season outside the Premier League.
   * A season the player spent abroad or in the Championship is simply ABSENT —
   * no evidence, which is very different from evidence of zero.
   */
  seasons?: SeasonWorkload[];
}

export interface SeasonWorkload {
  seasonName?: string;
  minutes: number;
  starts?: number;
}

/**
 * What a player has actually been doing in the last ~5 team games, read from
 * the element-summary rows.
 *
 * These three numbers are ONE observation of one player and are kept in one
 * record on purpose. They were previously two parallel `Map<number, number>`
 * threaded side by side through the context, the optimizer and the panel — two
 * structurally identical maps, so swapping them at any call site typechecked,
 * linted and silently modelled every player's start share as his minutes.
 *
 * They answer three different questions and the model consumes them on
 * different axes: `startShare` says how often he is in the eleven (drives
 * `pStart`), `minsPerStart` says how long he stays on once he is (drives
 * `minsPerStart`), and `minsPerGame` is the unconditional figure that carries a
 * pure substitute's real playing time (drives the `share` floor).
 */
export interface RecentForm {
  /** Fraction of the last ~5 recorded rounds the player STARTED. */
  startShare: number;
  /** Mean minutes per recorded round — starts, cameos and unused benchings. */
  minsPerGame: number;
  /**
   * Mean minutes in the rounds he STARTED, measured directly; `null` when he
   * started none of them.
   *
   * This is the quantity the minutes model wants, and it was previously
   * RECONSTRUCTED as `minsPerGame / startShare`, which charges every bench
   * minute to the starts: a defender hooked at 50' who also plays two cameos
   * comes out at 87.5 implied minutes per start instead of his real 50, which
   * is the difference between a 0.458 and a 1.000 chance of the sixty-minute
   * point. The joint distribution was in the rows all along and the two
   * marginals threw it away.
   */
  minsPerStart: number | null;
}

export interface EntryLeague {
  id: number;
  name: string;
  league_type: string; // "x" = private classic, "s" = system/public
  entry_rank: number | null;
  entry_last_rank: number | null;
}

export interface Entry {
  id: number;
  player_first_name: string;
  player_last_name: string;
  name: string; // team name
  summary_overall_points: number;
  summary_overall_rank: number | null;
  summary_event_points: number;
  summary_event_rank: number | null;
  current_event: number | null;
  last_deadline_bank: number;
  last_deadline_value: number;
  leagues?: {
    classic?: EntryLeague[];
    h2h?: EntryLeague[];
  };
}

export interface Pick {
  element: number;
  position: number; // 1..15
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
}

export interface EntryEventPicks {
  active_chip: string | null;
  entry_history: {
    event: number;
    points: number;
    total_points: number;
    rank: number | null;
    overall_rank: number | null;
    bank: number;
    value: number;
    event_transfers: number;
    event_transfers_cost: number;
    points_on_bench: number;
  };
  picks: Pick[];
}

export interface EntryHistory {
  current: {
    event: number;
    points: number;
    total_points: number;
    rank: number | null;
    overall_rank: number | null;
    bank: number;
    value: number;
    event_transfers: number;
    event_transfers_cost: number;
    points_on_bench: number;
  }[];
  chips: { name: string; time: string; event: number }[];
  past: { season_name: string; total_points: number; rank: number }[];
}

export interface Transfer {
  element_in: number;
  element_in_cost: number;
  element_out: number;
  element_out_cost: number;
  entry: number;
  event: number;
  time: string;
}

export interface LiveExplainStat {
  identifier: string; // e.g. "minutes", "goals_scored", "bonus"
  points: number;
  value: number;
}

export interface LiveElement {
  id: number;
  /**
   * FPL's live stat block. These are the counting stats for the gameweek in
   * progress; the season equivalents live on `Element`.
   *
   * The optional ones are optional because a stub feed may not send them, not
   * because FPL omits them — the real endpoint sends every field for every
   * player. Declaring them at all is the point: this interface listed six
   * fields, so the demo feed satisfied the type while sending nothing a keeper
   * could be rendered from, and there was no way to say in a test that a clean
   * sheet or a booking had been recorded.
   */
  stats: {
    minutes: number;
    total_points: number;
    bonus: number;
    bps: number;
    goals_scored: number;
    assists: number;
    clean_sheets?: number;
    goals_conceded?: number;
    saves?: number;
    yellow_cards?: number;
    red_cards?: number;
    own_goals?: number;
    penalties_saved?: number;
    penalties_missed?: number;
  };
  explain?: { fixture: number; stats: LiveExplainStat[] }[];
}

export interface EventLive {
  elements: LiveElement[];
}

export interface LeagueStandings {
  league: { id: number; name: string };
  standings: {
    has_next: boolean;
    results: {
      entry: number;
      entry_name: string;
      player_name: string;
      rank: number;
      last_rank: number;
      total: number;
      event_total: number;
    }[];
  };
}

// ---- App-level derived types ----

export interface OwnedPlayer {
  element: Element;
  purchasePrice: number; // tenths
  sellPrice: number; // tenths
  pickPosition: number; // 1..15 from last GW
  isCaptain: boolean;
  isViceCaptain: boolean;
}

export interface SquadState {
  players: OwnedPlayer[];
  bank: number; // tenths
  freeTransfers: number;
  usedChips: string[]; // chip names from history
  activeChip: string | null;
  currentEvent: number; // last played/current GW
  nextEvent: number | null;
}
