// Synthetic FPL universe for tests and local dev (the real API is only
// reachable from the deployed app). Deterministic — no randomness.

import type { Bootstrap, Element, ElementType, Fixture, OwnedPlayer } from "../types";

const TEAM_NAMES = [
  "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton",
  "Chelsea", "Crystal Palace", "Everton", "Fulham", "Leeds",
  "Liverpool", "Man City", "Man Utd", "Newcastle", "Forest",
  "Spurs", "Sunderland", "West Ham", "Wolves", "Burnley",
];

export function makeElement(partial: Partial<Element> & { id: number }): Element {
  return {
    web_name: `P${partial.id}`,
    first_name: "Test",
    second_name: `Player${partial.id}`,
    team: 1,
    element_type: 3,
    now_cost: 60,
    cost_change_start: 0,
    form: "4.0",
    points_per_game: "4.0",
    total_points: 80,
    event_points: 5,
    status: "a",
    news: "",
    chance_of_playing_next_round: null,
    selected_by_percent: "10.0",
    minutes: 1800,
    starts: 20,
    goals_scored: 5,
    assists: 5,
    clean_sheets: 5,
    goals_conceded: 20,
    bonus: 10,
    ict_index: "120.0",
    expected_goals: "5.0",
    expected_assists: "4.0",
    expected_goal_involvements: "9.0",
    expected_goals_conceded: "20.0",
    ep_next: "4.5",
    ...partial,
  } as Element;
}

export function makeMockBootstrap(): Bootstrap {
  const elements: Element[] = [];
  let id = 1;
  // 20 teams; per team: 2 GK, 4 DEF, 4 MID, 2 FWD = 240 players.
  for (let team = 1; team <= 20; team++) {
    const strength = 21 - team; // team 1 strongest
    const q = strength / 20; // 0.05 .. 1.0 quality factor
    const mk = (t: ElementType, i: number, price: number, xg: number, xa: number) =>
      elements.push(
        makeElement({
          id: id,
          web_name: `${TEAM_NAMES[team - 1].slice(0, 3).toUpperCase()}_${["GK", "DEF", "MID", "FWD"][t - 1]}${i}`,
          team,
          element_type: t,
          now_cost: price,
          minutes: i === 1 ? 2000 : 900,
          starts: i === 1 ? 22 : 10,
          expected_goals: (xg * q).toFixed(1),
          expected_assists: (xa * q).toFixed(1),
          ict_index: (60 + 140 * q).toFixed(1),
          points_per_game: (1.5 + 4.5 * q - (i - 1) * 0.8).toFixed(1),
          ep_next: (1.5 + 4.5 * q - (i - 1) * 0.8).toFixed(1),
          total_points: Math.round(30 + 150 * q - (i - 1) * 25),
          selected_by_percent: (2 + 40 * q).toFixed(1),
        })
      ) && id++;
    mk(1, 1, 40 + Math.round(15 * q), 0, 0);
    mk(1, 2, 40, 0, 0);
    for (let i = 1; i <= 4; i++) mk(2, i, 40 + Math.round(25 * q) - i * 2, 1.5, 1.5);
    for (let i = 1; i <= 4; i++) mk(3, i, 45 + Math.round(80 * q) - i * 8, 6, 6);
    for (let i = 1; i <= 2; i++) mk(4, i, 45 + Math.round(100 * q) - i * 10, 10, 3);
  }
  const events = Array.from({ length: 38 }, (_, i) => ({
    id: i + 1,
    name: `Gameweek ${i + 1}`,
    deadline_time: new Date(Date.UTC(2026, 7, 15 + i * 7)).toISOString(),
    finished: i + 1 <= 10,
    is_current: i + 1 === 10,
    is_next: i + 1 === 11,
    average_entry_score: 50,
    highest_score: 100,
  }));
  const teams = TEAM_NAMES.map((name, i) => ({
    id: i + 1,
    name,
    short_name: name.slice(0, 3).toUpperCase(),
    strength: Math.max(2, Math.min(5, Math.round((21 - (i + 1)) / 4))),
    strength_overall_home: 1100, strength_overall_away: 1050,
    strength_attack_home: 1100, strength_attack_away: 1050,
    strength_defence_home: 1100, strength_defence_away: 1050,
  }));
  return {
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
    total_players: 11000000,
  };
}

/** Round-robin-ish deterministic fixtures for GW 11..15. */
export function makeMockFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  let fid = 1;
  for (let gw = 11; gw <= 15; gw++) {
    for (let i = 0; i < 10; i++) {
      const home = ((i * 2 + gw) % 20) + 1;
      let away = ((i * 2 + 1 + gw * 3) % 20) + 1;
      if (away === home) away = (away % 20) + 1;
      const diffFor = (t: number) => Math.max(2, Math.min(5, Math.ceil(t / 4)));
      fixtures.push({
        id: fid++,
        event: gw,
        team_h: home,
        team_a: away,
        team_h_difficulty: diffFor(away),
        team_a_difficulty: diffFor(home),
        kickoff_time: new Date(Date.UTC(2026, 7, 15 + (gw - 1) * 7)).toISOString(),
        finished: false,
        team_h_score: null,
        team_a_score: null,
      });
    }
  }
  return fixtures;
}

/** A mid-table mock squad: legal 2-5-5-3, max 3 per club. */
export function makeMockOwned(bootstrap: Bootstrap): OwnedPlayer[] {
  const pick = (t: ElementType, n: number, fromTeam: number[]) => {
    const els = bootstrap.elements.filter(
      (e) => e.element_type === t && fromTeam.includes(e.team)
    );
    return els.slice(0, n);
  };
  const squad = [
    ...pick(1, 1, [3]), ...pick(1, 1, [15]),
    ...pick(2, 2, [1]), ...pick(2, 1, [5]), ...pick(2, 1, [8]), ...pick(2, 1, [12]),
    ...pick(3, 2, [2]), ...pick(3, 1, [6]), ...pick(3, 1, [11]), ...pick(3, 1, [16]),
    ...pick(4, 1, [4]), ...pick(4, 1, [7]), ...pick(4, 1, [13]),
  ];
  return squad.map((element, i) => ({
    element,
    purchasePrice: element.now_cost,
    sellPrice: element.now_cost,
    pickPosition: i + 1,
    isCaptain: i === 6,
    isViceCaptain: i === 7,
  }));
}
