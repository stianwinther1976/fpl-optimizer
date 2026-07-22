// Local mock of the FPL API for development in sandboxes without internet
// access to fantasy.premierleague.com.
//
//   node --experimental-strip-types scripts/mock-server.ts   (port 4100)
//   FPL_API_BASE=http://localhost:4100 npm run dev
//
// Deterministic data from src/lib/__tests__/mockdata.ts.

import { createServer } from "node:http";
import {
  makeMockBootstrap,
  makeMockFixtures,
  makeMockOwned,
} from "../src/lib/__tests__/mockdata.ts";

const bootstrap = makeMockBootstrap();
const fixtures = makeMockFixtures();
const owned = makeMockOwned(bootstrap);

// GW10 fixtures for the live view: finished, in-play and upcoming.
{
  let fid = 1000;
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    const home = i * 2 + 1;
    const away = i * 2 + 2;
    const state =
      i < 4 ? "finished" : i < 7 ? "live" : "upcoming"; // 4 FT, 3 live, 3 later
    fixtures.push({
      id: fid++,
      event: 10,
      team_h: home,
      team_a: away,
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      kickoff_time:
        state === "finished"
          ? new Date(now - 5 * 3600_000).toISOString()
          : state === "live"
            ? new Date(now - 55 * 60_000).toISOString()
            : new Date(now + 3 * 3600_000).toISOString(),
      finished: state === "finished",
      started: state !== "upcoming",
      team_h_score: state === "upcoming" ? null : (home % 3),
      team_a_score: state === "upcoming" ? null : (away % 2),
    });
  }
}

const entry = {
  id: 1234567,
  player_first_name: "Stian",
  player_last_name: "Winther",
  name: "Winther Wanderers",
  summary_overall_points: 612,
  summary_overall_rank: 154321,
  summary_event_points: 58,
  summary_event_rank: 90210,
  current_event: 10,
  last_deadline_bank: 20,
  last_deadline_value: owned.reduce((s, o) => s + o.element.now_cost, 0) + 20,
  leagues: {
    classic: [
      { id: 98765, name: "The Winthers", league_type: "x", entry_rank: 3, entry_last_rank: 4 },
      { id: 98766, name: "Office League", league_type: "x", entry_rank: 1, entry_last_rank: 1 },
      { id: 314, name: "Overall", league_type: "s", entry_rank: 154321, entry_last_rank: 159321 },
      { id: 411, name: "Norway", league_type: "s", entry_rank: 2211, entry_last_rank: 2400 },
    ],
  },
};

const picks = {
  active_chip: null,
  entry_history: {
    event: 10,
    points: 58,
    total_points: 612,
    rank: 90210,
    overall_rank: 154321,
    bank: 20,
    value: entry.last_deadline_value,
    event_transfers: 1,
    event_transfers_cost: 0,
    points_on_bench: 7,
  },
  picks: owned.map((o, i) => ({
    element: o.element.id,
    position: i + 1,
    multiplier: i === 6 ? 2 : i < 11 ? 1 : 0,
    is_captain: i === 6,
    is_vice_captain: i === 7,
  })),
};

const history = {
  current: Array.from({ length: 10 }, (_, i) => ({
    event: i + 1,
    points: 45 + ((i * 13) % 40),
    total_points: 500 + i * 11,
    rank: 200000 - i * 5000,
    overall_rank: 200000 - i * 5000,
    bank: 20,
    value: entry.last_deadline_value,
    event_transfers: i % 3 === 0 ? 0 : 1,
    event_transfers_cost: i === 7 ? 4 : 0,
    points_on_bench: 5,
  })),
  chips: [{ name: "wildcard", time: "2026-10-01T10:00:00Z", event: 6 }],
  past: [
    { season_name: "2024/25", total_points: 2210, rank: 342100 },
    { season_name: "2025/26", total_points: 2350, rank: 187553 },
  ],
};

const transfers = [
  {
    element_in: owned[6].element.id,
    element_in_cost: owned[6].element.now_cost - 3,
    element_out: 999,
    element_out_cost: 60,
    entry: entry.id,
    event: 5,
    time: "2026-09-20T10:00:00Z",
  },
];

const live = {
  elements: bootstrap.elements.map((e) => {
    const minutes = e.minutes > 1000 ? 90 : 30;
    const goals = e.id % 7 === 0 ? 1 : 0;
    const assists = e.id % 11 === 0 ? 1 : 0;
    const goalPts = goals * ({ 1: 10, 2: 6, 3: 5, 4: 4 } as Record<number, number>)[e.element_type];
    const total = (minutes >= 60 ? 2 : 1) + goalPts + assists * 3;
    const stats = [
      { identifier: "minutes", points: minutes >= 60 ? 2 : 1, value: minutes },
    ];
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
      explain: [{ fixture: 1000 + (e.team % 10), stats }],
    };
  }),
};

const league = {
  league: { id: 98765, name: "The Office League" },
  standings: {
    has_next: false,
    results: Array.from({ length: 12 }, (_, i) => ({
      entry: i === 2 ? entry.id : 1000 + i,
      entry_name: i === 2 ? entry.name : `Team ${i + 1}`,
      player_name: i === 2 ? "Stian Winther" : `Manager ${i + 1}`,
      rank: i + 1,
      last_rank: i + (i % 2 === 0 ? 2 : 0),
      total: 700 - i * 9,
      event_total: 60 - i,
    })),
  },
};

const routes: [RegExp, unknown][] = [
  [/^\/bootstrap-static\/$/, bootstrap],
  [/^\/fixtures\/$/, fixtures],
  [/^\/entry\/\d+\/event\/\d+\/picks\/$/, picks],
  [/^\/entry\/\d+\/history\/$/, history],
  [/^\/entry\/\d+\/transfers\/$/, transfers],
  [/^\/entry\/\d+\/$/, entry],
  [/^\/event\/\d+\/live\/$/, live],
  [/^\/leagues-classic\/\d+\/standings\/$/, league],
];

const server = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  const hit = routes.find(([re]) => re.test(path));
  if (!hit) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", path }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(hit[1]));
});

server.listen(4100, () => console.log("Mock FPL API on http://localhost:4100"));
