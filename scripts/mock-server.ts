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
  elements: bootstrap.elements.map((e) => ({
    id: e.id,
    stats: {
      minutes: e.minutes > 1000 ? 90 : 30,
      total_points: Math.max(1, Math.round((parseFloat(e.points_per_game) || 2) * 0.9)),
      bonus: 0,
      bps: 20,
      goals_scored: 0,
      assists: 0,
    },
  })),
};

const league = {
  league: { id: 98765, name: "Kontorligaen" },
  standings: {
    has_next: false,
    results: Array.from({ length: 12 }, (_, i) => ({
      entry: i === 2 ? entry.id : 1000 + i,
      entry_name: i === 2 ? entry.name : `Lag ${i + 1}`,
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
