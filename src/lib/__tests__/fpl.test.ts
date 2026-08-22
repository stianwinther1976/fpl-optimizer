import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  api,
  buildSquadState,
  fetchCacheSize,
  fetchPastSeason,
  fetchRecentForm,
  rankPercentile,
  resetFetchCache,
  resetSummaryCache,
  setDemoMode,
} from "../fpl";
import type {
  Bootstrap,
  Element,
  Entry,
  EntryEventPicks,
  EntryHistory,
  Transfer,
} from "../types";

describe("rankPercentile", () => {
  it("uses more decimals the closer to the top you are", () => {
    expect(rankPercentile(1_000, 10_000_000)).toBe("Top 0.010%");
    expect(rankPercentile(50_000, 10_000_000)).toBe("Top 0.50%");
    expect(rankPercentile(500_000, 10_000_000)).toBe("Top 5.0%");
    expect(rankPercentile(4_000_000, 10_000_000)).toBe("Top 40%");
  });

  it("never claims a rank better than the field allows", () => {
    expect(rankPercentile(11_000_000, 10_000_000)).toBe("Top 100%");
  });

  it("returns null rather than a bogus percentage when inputs are missing", () => {
    expect(rankPercentile(null, 10_000_000)).toBeNull();
    expect(rankPercentile(1_000, null)).toBeNull();
    expect(rankPercentile(1_000, 0)).toBeNull();
    expect(rankPercentile(0, 10_000_000)).toBeNull();
  });
});

// The optimizer's minutes model consumes three recent-form signals and all
// three are read from the same element-summary rows. If this function stops
// returning any of them the corresponding term in xp.ts goes silently dead in
// the deployed app while every unit test still passes, so the shape is pinned
// here — in particular `minsPerStart`, which is the reason the rows are read at
// all rather than reduced to two independent marginals.
describe("fetchRecentForm", () => {
  const rows = (mins: number[], withStarts = true) =>
    mins.map((m, i) => ({
      element: 1,
      round: i + 1,
      minutes: m,
      total_points: 2,
      opponent_team: 2,
      was_home: true,
      ...(withStarts ? { starts: m >= 60 ? 1 : 0 } : {}),
    }));

  function mockApi(byId: Record<number, { history: unknown[] } | "fail">) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const id = Number(String(url).match(/element-summary\/(\d+)/)![1]);
      const body = byId[id];
      if (body === "fail" || body == null) return { ok: false, status: 404 } as Response;
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it("does not count a fixture that has not been played", async () => {
    /*
     * FPL EMITS A HISTORY ROW FROM THE DEADLINE, with `minutes: 0`,
     * `starts: 0` and `team_h_score: null`, for a match that has not kicked
     * off. Counted on the 2026-08-21 snapshot with one of ten GW1 fixtures
     * started: 538 of 600 players carry one. Unfiltered, every one of them was
     * charged a round he did not play in a match that had not happened — a
     * one-in-five dilution of `startShare` and `minsPerGame` for the whole
     * window between the deadline and each kickoff, and BIASED ACROSS CLUBS
     * within one gameweek, since the Saturday lunchtime club is clean and the
     * Monday night club is not. The optimizer compares them directly.
     */
    const played = rows([90, 90, 90, 90, 90]).map((r) => ({ ...r, team_h_score: 1 }));
    const pending = { ...rows([0])[0], round: 6, team_h_score: null };
    const restore = mockApi({ 8100: { history: [...played, pending] } });
    try {
      const m = await fetchRecentForm([8100], 5);
      expect(m.get(8100)).toEqual({ startShare: 1, minsPerGame: 90, minsPerStart: 90 });
    } finally {
      restore();
      resetSummaryCache();
    }
  });

  it("keeps counting rows whose payload omits the score at all", async () => {
    // `!== null`, not `!= null`: an explicit null is FPL's pre-kickoff signal,
    // while an absent key is a stub or an older reduced record and falls back
    // to the behaviour this replaces.
    const restore = mockApi({ 8101: { history: rows([90, 0]) } });
    try {
      const m = await fetchRecentForm([8101], 5);
      expect(m.get(8101)!.startShare).toBe(0.5);
    } finally {
      restore();
      resetSummaryCache();
    }
  });

  it("still fills the window from real rounds when a pending one is dropped", async () => {
    // The filter runs BEFORE the window, so a player gets five real rounds
    // rather than four and a hole.
    const played = rows([10, 20, 30, 40, 50, 60]).map((r) => ({ ...r, team_h_score: 0 }));
    const pending = { ...rows([0])[0], round: 7, team_h_score: null };
    const restore = mockApi({ 8102: { history: [...played, pending] } });
    try {
      const m = await fetchRecentForm([8102], 5);
      // Rounds 2..6: 20+30+40+50+60 = 200 over five.
      expect(m.get(8102)!.minsPerGame).toBeCloseTo(40, 9);
    } finally {
      restore();
      resetSummaryCache();
    }
  });

  it("measures minutes per start over the starts, not over every appearance", async () => {
    // 90, 80, 30, 0, 45 => started two of five (the 90 and the 80), mean 49
    // minutes a game, and 85 minutes in the games he started. Three
    // deliberately different numbers, so a mix-up between any pair shows up.
    // Note what the OLD reconstruction would have produced from the two
    // marginals: 49 / 0.4 = 122.5, capped to 90 — a substitute's cameos
    // charged to his starts.
    const restore = mockApi({ 8001: { history: rows([90, 80, 30, 0, 45]) } });
    try {
      const r = await fetchRecentForm([8001], 5, 2);
      expect(r.get(8001)!.startShare).toBeCloseTo(2 / 5, 9);
      expect(r.get(8001)!.minsPerGame).toBeCloseTo(49, 9);
      expect(r.get(8001)!.minsPerStart).toBeCloseTo(85, 9);
    } finally {
      restore();
    }
  });

  it("reports no minutes per start for a player who started none of them", async () => {
    // Null, not zero and not the per-game figure: "he has not started" is not
    // the same claim as "his starts last no time", and the model must be able
    // to tell them apart or it will demote a returning starter to nothing.
    const restore = mockApi({ 8006: { history: rows([20, 0, 35, 12, 0]) } });
    try {
      const r = await fetchRecentForm([8006], 5, 2);
      expect(r.get(8006)!.startShare).toBe(0);
      expect(r.get(8006)!.minsPerGame).toBeCloseTo(13.4, 9);
      expect(r.get(8006)!.minsPerStart).toBeNull();
    } finally {
      restore();
    }
  });

  it("only reads the last N rounds", async () => {
    const restore = mockApi({ 8002: { history: rows([0, 0, 0, 90, 90]) } });
    try {
      const r = await fetchRecentForm([8002], 2, 2);
      expect(r.get(8002)!.startShare).toBe(1);
      expect(r.get(8002)!.minsPerGame).toBe(90);
      expect(r.get(8002)!.minsPerStart).toBe(90);
    } finally {
      restore();
    }
  });

  it("withholds the player entirely when the starts column is missing", async () => {
    // FPL only began emitting `starts` in 2022/23. Reading an absent column as
    // zero would bench the whole squad, and emitting the minutes alone would
    // look like data the model was using: the whole recency branch in
    // `minutesModel` is gated on the record being present.
    const restore = mockApi({ 8003: { history: rows([90, 60], false) } });
    try {
      const r = await fetchRecentForm([8003], 5, 2);
      expect(r.has(8003)).toBe(false);
    } finally {
      restore();
    }
  });

  it("leaves failed and empty players out rather than guessing", async () => {
    const restore = mockApi({ 8004: "fail", 8005: { history: [] } });
    try {
      const r = await fetchRecentForm([8004, 8005], 5, 2);
      expect(r.has(8004)).toBe(false);
      expect(r.has(8005)).toBe(false);
    } finally {
      restore();
    }
  });
});

/*
 * `element-summary/{id}/` is the most expensive thing the app does — one
 * request per player over the whole field — and it is the only endpoint whose
 * payload two different consumers read for two different halves.
 */
describe("the element-summary layer", () => {
  let calls: number[];
  /** Full URLs, so which FEED served each player is observable. */
  let urls: string[];

  /** Counts every round trip, and serves both halves of the document. */
  function mockApi(fail = new Set<number>(), onCall?: (id: number) => void) {
    const original = globalThis.fetch;
    calls = [];
    urls = [];
    globalThis.fetch = (async (url: string) => {
      const id = Number(String(url).match(/element-summary\/(\d+)/)![1]);
      calls.push(id);
      urls.push(String(url));
      onCall?.(id);
      if (fail.has(id)) return { ok: false, status: 503 } as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          history: [{ element: id, round: 1, minutes: 90, starts: 1, total_points: 6 }],
          history_past: [{ season_name: "2025/26", total_points: 180, minutes: 3000, starts: 34 }],
        }),
      } as Response;
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  beforeEach(() => resetSummaryCache());

  it("pins the feed for the whole load, so a mid-load switch cannot poison it", async () => {
    /*
     * THE COLLISION THIS EXISTS TO STOP. The URL and the cache key both derive
     * from a module-global `demoMode`, and this load runs for tens of seconds
     * over hundreds of players. Read per player, a load that starts on the real
     * feed and is overtaken by a navigation to the demo finishes writing REAL
     * footballers' records under `demo:{id}` keys — and the demo numbers its
     * players 1..300 exactly as three hundred real players are numbered, so
     * nothing looks wrong afterwards. Nothing in production clears this cache
     * on a feed switch, so the poisoned records would outlive the page.
     */
    setDemoMode(false);
    // Flip to the demo after the first player is served, mid-load.
    const restore = mockApi(new Set(), (id) => {
      if (id === 1) setDemoMode(true);
    });
    try {
      await fetchPastSeason([1, 2, 3, 4], 1);
      // Every request went to the feed the load STARTED on.
      expect(urls.every((u) => u.includes("/api/fpl/"))).toBe(true);
      expect(urls.some((u) => u.includes("/api/demo/"))).toBe(false);
    } finally {
      restore();
      setDemoMode(false);
    }
  });

  it("does not serve a real player's record to the demo under his number", async () => {
    setDemoMode(false);
    const restore = mockApi(new Set(), (id) => {
      if (id === 1) setDemoMode(true);
    });
    try {
      await fetchPastSeason([1, 2, 3, 4], 1);
      restore();
      // Now genuinely in the demo. Nothing from the real load may be reused,
      // so every id must be fetched again — from the demo feed this time.
      const restore2 = mockApi();
      try {
        await fetchPastSeason([1, 2, 3, 4], 1);
        expect(calls.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
        expect(urls.every((u) => u.includes("/api/demo/"))).toBe(true);
      } finally {
        restore2();
      }
    } finally {
      setDemoMode(false);
    }
  });

  it("reads both halves of one document from a single request", async () => {
    // The dashboard pulls last season on mount; the recent-form pull happens
    // when someone taps Optimize, which is minutes later and so past the URL
    // cache's TTL. That second call used to be a fresh round trip for a payload
    // the session had already parsed.
    const restore = mockApi();
    try {
      const past = await fetchPastSeason([9101], 2);
      expect(past.data.get(9101)!.minutes).toBe(3000);
      expect(calls).toEqual([9101]);

      const form = await fetchRecentForm([9101], 5, 2);
      expect(form.get(9101)!.minsPerStart).toBe(90);
      // Still one. The second consumer read the held record.
      expect(calls).toEqual([9101]);
    } finally {
      restore();
    }
  });

  it("does not cache a failure, so a retry really does retry", async () => {
    // `pastSeasonStore` refuses to treat a result with failures as final so the
    // drafter's "Re-draft to try them again" button can mean what it says.
    // Recording the miss here would quietly take that back: the retry would
    // find it cached and issue no request at all.
    const restore = mockApi(new Set([9102]));
    try {
      const first = await fetchPastSeason([9102], 1);
      expect(first.failed).toBe(1);
      // One attempt plus the one retry inside the fetcher.
      expect(calls.length).toBe(2);

      const second = await fetchPastSeason([9102], 1);
      expect(second.failed).toBe(1);
      expect(calls.length).toBe(4);
    } finally {
      restore();
    }
  });

  it("issues nothing at all once the signal is aborted", async () => {
    // The cost being cancelled is the QUEUE, hundreds of requests deep, not the
    // one already on the wire.
    const restore = mockApi();
    try {
      const ac = new AbortController();
      ac.abort();
      const r = await fetchPastSeason([9103, 9104, 9105], 2, undefined, ac.signal);
      expect(calls).toEqual([]);
      expect(r.data.size).toBe(0);
    } finally {
      restore();
    }
  });
});

describe("the squad on the pitch versus the squad to optimize from", () => {
  /*
   * `buildSquadState` deliberately moves `players` away from what is fielded
   * this gameweek: it applies transfers already made for `nextEvent`, and
   * `loadTeamData` hands it the PREVIOUS gameweek's picks during a Free Hit.
   * Both are right for the optimizer and wrong for anything rendering this
   * gameweek's live scores, which the live pitch and the Live tab were doing.
   */
  const el = (id: number): Element =>
    ({
      id,
      element_type: ((id % 4) + 1) as 1 | 2 | 3 | 4,
      team: (id % 20) + 1,
      now_cost: 50,
      web_name: `P${id}`,
    }) as Element;

  const bootstrap = {
    elements: Array.from({ length: 40 }, (_, i) => el(i + 1)),
    events: Array.from({ length: 38 }, (_, i) => ({
      id: i + 1,
      is_current: i + 1 === 20,
      is_next: i + 1 === 21,
      finished: i + 1 < 20,
    })),
    teams: [],
  } as unknown as Bootstrap;

  const picksFor = (ids: number[], capAt = 3, viceAt = 4): EntryEventPicks =>
    ({
      active_chip: null,
      entry_history: { event: 20, bank: 5, value: 1000, event_transfers: 0, event_transfers_cost: 0 },
      picks: ids.map((element, i) => ({
        element,
        position: i + 1,
        multiplier: i + 1 === capAt ? 2 : i < 11 ? 1 : 0,
        is_captain: i + 1 === capAt,
        is_vice_captain: i + 1 === viceAt,
      })),
    }) as unknown as EntryEventPicks;

  const history = { current: [], chips: [] } as unknown as EntryHistory;
  const base = Array.from({ length: 15 }, (_, i) => i + 1);
  const build = (transfers: Transfer[], opts?: Parameters<typeof buildSquadState>[5]) =>
    buildSquadState(bootstrap, {} as Entry, picksFor(base), history, transfers, opts);

  const transferAt = (event: number, out: number, inn: number): Transfer =>
    ({
      event,
      element_in: inn,
      element_out: out,
      element_in_cost: 50,
      element_out_cost: 50,
      time: "2026-01-01T00:00:00Z",
    }) as unknown as Transfer;

  it("keeps this gameweek's fifteen when a transfer is already made for next", () => {
    /*
     * FPL publishes GW n `is_current` alongside GW n+1 `is_next` while GW n's
     * matches are still being played, so this is routine. The outgoing player
     * played this week and vanished from the pitch; the incoming player was
     * drawn with points he scored for somebody else.
     */
    const s = build([transferAt(21, 5, 20)]);
    expect(s.players.map((p) => p.element.id)).toContain(20);
    expect(s.players.map((p) => p.element.id)).not.toContain(5);
    expect(s.currentPlayers.map((p) => p.element.id)).toEqual(base);
    // Fifteen either way — the pitch's ten-and-five split came from mixing them.
    expect(s.currentPlayers).toHaveLength(15);
  });

  it("fields the Free Hit team, not the squad it replaced", () => {
    const fh = Array.from({ length: 15 }, (_, i) => i + 21);
    const s = buildSquadState(bootstrap, {} as Entry, picksFor(base), history, [], {
      currentPicks: picksFor(fh),
      activeChip: "freehit",
    });
    expect(s.players.map((p) => p.element.id)).toEqual(base);
    expect(s.currentPlayers.map((p) => p.element.id)).toEqual(fh);
  });

  it("leaves exactly one captain and one vice when a transfer takes an armband", () => {
    /*
     * Probed before the fix: transferring the vice out left NO vice at all,
     * and transferring the captain out left one man wearing both. With no vice
     * the takeover path is dead for the week and no V badge is drawn; with one
     * man wearing both it cannot fire either, because captain and vice resolve
     * to the same element.
     */
    for (const [out, label] of [
      [4, "the vice"],
      [3, "the captain"],
    ] as const) {
      const s = build([transferAt(21, out, 20)]);
      const caps = s.players.filter((p) => p.isCaptain);
      const vices = s.players.filter((p) => p.isViceCaptain);
      expect(caps, `${label}: captains`).toHaveLength(1);
      expect(vices, `${label}: vices`).toHaveLength(1);
      expect(caps[0].element.id, `${label}: same man wears both`).not.toBe(vices[0].element.id);
    }
  });

  it("leaves an untouched squad's armbands exactly where they were", () => {
    const s = build([]);
    expect(s.players.find((p) => p.isCaptain)!.element.id).toBe(3);
    expect(s.players.find((p) => p.isViceCaptain)!.element.id).toBe(4);
    expect(s.players.filter((p) => p.isCaptain)).toHaveLength(1);
    expect(s.players.filter((p) => p.isViceCaptain)).toHaveLength(1);
  });
});

describe("the in-memory memo does not grow for the life of the page", () => {
  /*
   * `fetchCache` never evicted. That was fine when the keys were a fixed
   * handful per reader and is not any more: the gameweek time machine fetches
   * `event/{gw}/live/` and a picks payload for every week it is pointed at — up
   * to thirty-eight of each — and the mini-league fetches four payloads per
   * rival card opened. A gameweek's live feed is around 100 KB for a
   * three-hundred-player universe, so the ceiling was tens of megabytes of JSON
   * nobody would look at twice.
   */
  beforeEach(() => {
    resetFetchCache();
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
  });

  it("drops entries whose TTL has passed, on the next write", async () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000_000);
      for (let gw = 1; gw <= 10; gw++) await api.live(gw);
      expect(fetchCacheSize()).toBe(10);
      // Still inside the 25s live TTL: nothing is dropped.
      now.mockReturnValue(1_000_000 + 20_000);
      await api.live(11);
      expect(fetchCacheSize()).toBe(11);
      // Past it: the write that triggers the sweep is the only one left.
      now.mockReturnValue(1_000_000 + 60_000);
      await api.live(12);
      expect(fetchCacheSize()).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps entries that are still live, whatever their TTL", async () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(2_000_000);
      await api.live(1); // 25s
      await api.bootstrap(); // 300s
      await api.history(7); // 300s
      expect(fetchCacheSize()).toBe(3);
      // Past the live TTL and well inside the other two.
      now.mockReturnValue(2_000_000 + 30_000);
      await api.live(2);
      expect(fetchCacheSize()).toBe(3); // bootstrap, history, and the new live
    } finally {
      now.mockRestore();
    }
  });
});
