// Built-in demo universe: a full mid-season snapshot (GW20 just played,
// one evening match still in play) so the app can be explored off-season.
// Deterministic apart from timestamps, which anchor to "now".

export const DEMO_ENTRY_ID = 999999;

const TEAM_NAMES = [
  "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton",
  "Chelsea", "Crystal Palace", "Everton", "Fulham", "Leeds",
  "Liverpool", "Man City", "Man Utd", "Newcastle", "Forest",
  "Spurs", "Sunderland", "West Ham", "Wolves", "Burnley",
];

const CURRENT_GW = 20;
const DAY = 86_400_000;

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeElements() {
  const elements: any[] = [];
  let id = 1;
  for (let team = 1; team <= 20; team++) {
    const q = (21 - team) / 20; // quality factor, team 1 strongest
    const mk = (t: number, i: number, price: number, xg: number, xa: number) => {
      const ppg = Math.max(1, 1.5 + 4.5 * q - (i - 1) * 0.8);
      elements.push({
        id,
        web_name: `${TEAM_NAMES[team - 1].slice(0, 3)}. ${["Keeper", "Back", "Mid", "Striker"][t - 1]} ${i}`,
        first_name: "Demo",
        second_name: `${TEAM_NAMES[team - 1]} ${["GK", "DEF", "MID", "FWD"][t - 1]}${i}`,
        team,
        element_type: t,
        now_cost: price + ((id * 3) % 7) - 3,
        cost_change_start: ((id * 3) % 7) - 3,
        form: ppg.toFixed(1),
        points_per_game: ppg.toFixed(1),
        total_points: Math.round(ppg * 19),
        event_points: Math.max(0, Math.round(ppg + ((id * 7) % 5) - 2)),
        status: id % 37 === 0 ? "d" : id % 53 === 0 ? "i" : "a",
        news: id % 37 === 0 ? "Knock - 75% chance of playing" : "",
        chance_of_playing_next_round: id % 37 === 0 ? 75 : null,
        selected_by_percent: (2 + 45 * q).toFixed(1),
        minutes: i === 1 ? 1700 : 800,
        starts: i === 1 ? 19 : 9,
        goals_scored: Math.round(xg * q * 0.9),
        assists: Math.round(xa * q * 0.9),
        clean_sheets: Math.round(8 * q),
        goals_conceded: Math.round(28 - 14 * q),
        bonus: Math.round(12 * q),
        ict_index: (60 + 140 * q).toFixed(1),
        expected_goals: (xg * q).toFixed(1),
        expected_assists: (xa * q).toFixed(1),
        expected_goal_involvements: ((xg + xa) * q).toFixed(1),
        expected_goals_conceded: (28 - 14 * q).toFixed(1),
        ep_next: ppg.toFixed(1),
      });
      id++;
    };
    mk(1, 1, 45 + Math.round(12 * q), 0, 0);
    mk(1, 2, 40, 0, 0);
    for (let i = 1; i <= 4; i++) mk(2, i, 40 + Math.round(25 * q) - i * 2, 1.5, 1.5);
    for (let i = 1; i <= 4; i++) mk(3, i, 45 + Math.round(80 * q) - i * 8, 6, 6);
    for (let i = 1; i <= 2; i++) mk(4, i, 45 + Math.round(100 * q) - i * 10, 10, 3);
  }
  return elements;
}

export function makeDemoUniverse(now: number) {
  const elements = makeElements();

  // GW21 deadline in ~2 days; one GW per week around it.
  const deadlineFor = (gw: number) => new Date(now + (gw - 21) * 7 * DAY + 2 * DAY).toISOString();
  const events = Array.from({ length: 38 }, (_, i) => {
    const gw = i + 1;
    return {
      id: gw,
      name: `Gameweek ${gw}`,
      deadline_time: deadlineFor(gw),
      finished: gw < CURRENT_GW,
      is_current: gw === CURRENT_GW,
      is_next: gw === CURRENT_GW + 1,
      average_entry_score: 42 + ((gw * 13) % 25),
      highest_score: 100 + ((gw * 7) % 40),
    };
  });

  const teams = TEAM_NAMES.map((name, i) => ({
    id: i + 1,
    name,
    short_name: name.slice(0, 3).toUpperCase(),
    strength: Math.max(2, Math.min(5, Math.round((21 - (i + 1)) / 4))),
    strength_overall_home: 1100, strength_overall_away: 1050,
    strength_attack_home: 1100, strength_attack_away: 1050,
    strength_defence_home: 1100, strength_defence_away: 1050,
  }));

  const bootstrap = {
    events,
    teams,
    elements,
    chips: [
      { name: "wildcard", start_event: 2, stop_event: 19, number: 1 },
      { name: "wildcard", start_event: 20, stop_event: 38, number: 1 },
      { name: "freehit", start_event: 2, stop_event: 38, number: 1 },
      { name: "bboost", start_event: 2, stop_event: 38, number: 1 },
      { name: "3xc", start_event: 2, stop_event: 38, number: 1 },
    ],
    total_players: 11_234_567,
  };

  // Fixtures: GW20 has 8 finished + 2 in play; GW21-25 upcoming.
  const fixtures: any[] = [];
  let fid = 1;
  for (let gw = CURRENT_GW; gw <= CURRENT_GW + 5; gw++) {
    for (let i = 0; i < 10; i++) {
      const home = ((i * 2 + gw) % 20) + 1;
      let away = ((i * 2 + 1 + gw * 3) % 20) + 1;
      if (away === home) away = (away % 20) + 1;
      const diffFor = (t: number) => Math.max(2, Math.min(5, Math.ceil(t / 4)));
      const isCurrent = gw === CURRENT_GW;
      const liveMatch = isCurrent && i >= 8; // last two of GW20 in play
      fixtures.push({
        id: fid++,
        event: gw,
        team_h: home,
        team_a: away,
        team_h_difficulty: diffFor(away),
        team_a_difficulty: diffFor(home),
        kickoff_time: isCurrent
          ? liveMatch
            ? new Date(now - 55 * 60_000).toISOString()
            : new Date(now - 8 * 3600_000).toISOString()
          : new Date(now + (gw - 21) * 7 * DAY + 2 * DAY + 26 * 3600_000).toISOString(),
        finished: isCurrent && !liveMatch,
        started: isCurrent,
        team_h_score: isCurrent ? home % 3 : null,
        team_a_score: isCurrent ? away % 2 : null,
      });
    }
  }

  // Demo squad: legal 2-5-5-3, max 3 per club, decent quality.
  const byTeamType = (team: number, t: number) =>
    elements.filter((e) => e.team === team && e.element_type === t);
  const squad = [
    byTeamType(3, 1)[0], // GK starter
    ...byTeamType(1, 2).slice(0, 2), // 2 Arsenal DEF
    byTeamType(5, 2)[0],
    byTeamType(8, 2)[0],
    byTeamType(2, 3)[0], // MIDs
    byTeamType(2, 3)[1],
    byTeamType(6, 3)[0],
    byTeamType(11, 3)[0],
    byTeamType(12, 4)[0], // FWDs
    byTeamType(4, 4)[0],
    // bench (12-15): GK first
    byTeamType(15, 1)[0],
    byTeamType(12, 2)[0],
    byTeamType(16, 3)[0],
    byTeamType(7, 4)[0],
  ];
  // starters need 11: currently 11 above bench? count: 1GK+4DEF+4MID+2FWD = 11 ✓, bench 4 ✓

  const picks = {
    active_chip: null,
    entry_history: {
      event: CURRENT_GW,
      points: 61,
      total_points: 1152,
      rank: 180_000,
      overall_rank: 245_812,
      bank: 15,
      value: squad.reduce((s, e) => s + e.now_cost, 0) + 15,
      event_transfers: 2,
      event_transfers_cost: 4,
      points_on_bench: 9,
    },
    picks: squad.map((e, i) => ({
      element: e.id,
      position: i + 1,
      multiplier: i === 5 ? 2 : i < 11 ? 1 : 0, // captain = second Chelsea-ish mid
      is_captain: i === 5,
      is_vice_captain: i === 9,
    })),
  };

  const entry = {
    id: DEMO_ENTRY_ID,
    player_first_name: "Demo",
    player_last_name: "Manager",
    name: "Demo Wanderers",
    summary_overall_points: 1152,
    summary_overall_rank: 245_812,
    summary_event_points: 61,
    summary_event_rank: 180_000,
    current_event: CURRENT_GW,
    last_deadline_bank: 15,
    last_deadline_value: picks.entry_history.value,
    leagues: {
      classic: [
        { id: 900001, name: "Demo League of Legends", league_type: "x", entry_rank: 2, entry_last_rank: 3 },
        { id: 900002, name: "Office Rivals", league_type: "x", entry_rank: 1, entry_last_rank: 1 },
        { id: 314, name: "Overall", league_type: "s", entry_rank: 245_812, entry_last_rank: 251_400 },
        { id: 411, name: "Norway", league_type: "s", entry_rank: 3_812, entry_last_rank: 4_190 },
      ],
    },
  };

  const history = {
    current: Array.from({ length: CURRENT_GW }, (_, i) => {
      const gw = i + 1;
      return {
        event: gw,
        points: 40 + ((gw * 17) % 42) + (gw === 15 ? 18 : 0),
        total_points: 1152 - (CURRENT_GW - gw) * 57,
        rank: 400_000 - gw * 8_000,
        overall_rank: 400_000 - gw * 8_000,
        bank: 15,
        value: 1000 + gw * 2,
        event_transfers: gw % 3 === 0 ? 1 : 0,
        event_transfers_cost: gw === 12 || gw === CURRENT_GW ? 4 : 0,
        points_on_bench: 4 + (gw % 7),
      };
    }),
    chips: [
      { name: "wildcard", time: new Date(now - 90 * DAY).toISOString(), event: 8 },
      { name: "bboost", time: new Date(now - 40 * DAY).toISOString(), event: 15 },
    ],
    past: [
      { season_name: "2023/24", total_points: 2210, rank: 342_100 },
      { season_name: "2024/25", total_points: 2350, rank: 187_553 },
      { season_name: "2025/26", total_points: 2311, rank: 154_321 },
    ],
  };

  const transfers = [
    {
      element_in: squad[6].id,
      element_in_cost: squad[6].now_cost - 3,
      element_out: 999,
      element_out_cost: 60,
      entry: DEMO_ENTRY_ID,
      event: 14,
      time: new Date(now - 45 * DAY).toISOString(),
    },
  ];

  // Live GW20: finished matches have full minutes; the two in-play teams are mid-match.
  const liveTeams = new Set<number>();
  for (const f of fixtures) {
    if (f.event === CURRENT_GW && f.started && !f.finished) {
      liveTeams.add(f.team_h);
      liveTeams.add(f.team_a);
    }
  }
  const live = {
    elements: elements.map((e) => {
      const inPlay = liveTeams.has(e.team);
      const minutes = inPlay ? 58 : e.minutes > 1000 ? 90 : 25;
      const goals = e.id % 9 === 0 ? 1 : 0;
      const assists = e.id % 13 === 0 ? 1 : 0;
      const goalPts = goals * ({ 1: 10, 2: 6, 3: 5, 4: 4 } as Record<number, number>)[e.element_type];
      const appearance = minutes >= 60 ? 2 : 1;
      const total = appearance + goalPts + assists * 3;
      const stats = [{ identifier: "minutes", points: appearance, value: minutes }];
      if (goals) stats.push({ identifier: "goals_scored", points: goalPts, value: goals });
      if (assists) stats.push({ identifier: "assists", points: assists * 3, value: assists });
      return {
        id: e.id,
        stats: {
          minutes,
          total_points: total,
          bonus: 0,
          bps: ((e.id * 13) % 45) + (e.minutes > 1000 ? 10 : 0),
          goals_scored: goals,
          assists,
        },
        explain: [{ fixture: 1, stats }],
      };
    }),
  };

  const leagueResults = Array.from({ length: 10 }, (_, i) => ({
    entry: i === 1 ? DEMO_ENTRY_ID : 999_900 + i,
    entry_name: i === 1 ? entry.name : `Rival FC ${i + 1}`,
    player_name: i === 1 ? "Demo Manager" : `Manager ${i + 1}`,
    rank: i + 1,
    last_rank: i + (i % 2 === 0 ? 2 : 0),
    total: 1190 - i * 11,
    event_total: 66 - i * 2,
  }));
  const league = {
    league: { id: 900001, name: "Demo League of Legends" },
    standings: { has_next: false, results: leagueResults },
  };

  return { bootstrap, fixtures, entry, picks, history, transfers, live, league };
}
