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
  chance_of_playing_next_round: number | null;
  selected_by_percent: string;
  minutes: number;
  starts: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  bonus: number;
  ict_index: string;
  expected_goals: string;
  expected_assists: string;
  expected_goal_involvements: string;
  expected_goals_conceded: string;
  ep_next: string | null;
  penalties_order?: number | null;
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

export interface LiveElement {
  id: number;
  stats: {
    minutes: number;
    total_points: number;
    bonus: number;
    bps: number;
    goals_scored: number;
    assists: number;
  };
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
