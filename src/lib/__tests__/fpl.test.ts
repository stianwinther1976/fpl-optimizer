import { describe, it, expect, beforeEach } from "vitest";
import { fetchPastSeason, fetchRecentForm, rankPercentile, resetSummaryCache } from "../fpl";

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

  /** Counts every round trip, and serves both halves of the document. */
  function mockApi(fail = new Set<number>()) {
    const original = globalThis.fetch;
    calls = [];
    globalThis.fetch = (async (url: string) => {
      const id = Number(String(url).match(/element-summary\/(\d+)/)![1]);
      calls.push(id);
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
