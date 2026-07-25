// End-to-end pre-season tests: real API JSON -> fetchPastSeason -> projectAll.
//
// The existing pre-season suite hand-builds PastSeasonStats objects, which is
// how a bug survived it for months: a test asserted that a season with no xG
// falls back to the prior, but it constructed `{ points, minutes, starts }`
// with `xg` simply omitted — a shape the real fetcher could not produce,
// because its number parser coerced the absent field to 0. The test passed and
// proved nothing.
//
// So these tests start from `history_past` JSON in exactly the form the live
// API returns it (integers as numbers, decimals as STRINGS, columns genuinely
// missing for seasons that predate them) and run the actual data layer over it.
// Every row shape below was read from the live 2026/27 API on 2026-07-25.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPastSeason } from "../fpl";
import { projectAll } from "../xp";
import type { Bootstrap, Element, Fixture, PastSeasonStats, Team } from "../types";

// --- Fixtures --------------------------------------------------------------

const teams: Team[] = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  name: `Team ${i + 1}`,
  short_name: `T${i + 1}`,
  strength: 3,
  // Pre-season the detailed ratings are all zero; only overall varies.
  strength_overall_home: 3,
  strength_overall_away: 3,
  strength_attack_home: 0,
  strength_attack_away: 0,
  strength_defence_home: 0,
  strength_defence_away: 0,
}));

const fixtures: Fixture[] = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  event: 1,
  team_h: i * 2 + 1,
  team_a: i * 2 + 2,
  team_h_difficulty: 3,
  team_a_difficulty: 3,
  finished: false,
  started: false,
  kickoff_time: "2026-08-22T14:00:00Z",
  team_h_score: null,
  team_a_score: null,
}));

/** A bootstrap element AFTER FPL's summer wipe: every counter is zero. */
function el(
  p: Partial<Element> &
    Pick<Element, "id" | "web_name" | "team" | "element_type" | "now_cost">
): Element {
  return {
    first_name: "",
    second_name: "",
    cost_change_start: 0,
    form: "0.0",
    event_points: 0,
    status: "a",
    news: "",
    chance_of_playing_next_round: null,
    selected_by_percent: "5.0",
    minutes: 0,
    starts: 0,
    total_points: 0,
    points_per_game: "0.0",
    goals_scored: 0,
    assists: 0,
    clean_sheets: 0,
    goals_conceded: 0,
    bonus: 0,
    ict_index: "0.0",
    expected_goals: "0.00",
    expected_assists: "0.00",
    expected_goal_involvements: "0.00",
    expected_goals_conceded: "0.00",
    defensive_contribution: 0,
    ep_next: "2.5",
    ...p,
  } as Element;
}

/**
 * A `history_past` row in the live API's own encoding. Integers come back as
 * numbers, every decimal as a string. Columns that did not exist in a given
 * season are absent from the row entirely, which is the whole point.
 */
type Row = Record<string, number | string>;

function season(
  name: string,
  o: {
    minutes: number;
    starts?: number;
    points?: number;
    goals?: number;
    assists?: number;
    xg?: number;
    xa?: number;
    bonus?: number;
    ict?: number;
    dc?: number;
    saves?: number;
  }
): Row {
  const r: Row = {
    season_name: name,
    element_code: 1,
    start_cost: 55,
    end_cost: 55,
    total_points: o.points ?? 0,
    minutes: o.minutes,
    goals_scored: o.goals ?? 0,
    assists: o.assists ?? 0,
    clean_sheets: 0,
    goals_conceded: 0,
    bonus: o.bonus ?? 0,
    ict_index: String(o.ict ?? 0),
  };
  // `starts` only exists from 2021/22 on. Absent is NOT zero.
  if (o.starts != null) r.starts = o.starts;
  // Expected goals only exist from 2022/23 on.
  if (o.xg != null) r.expected_goals = o.xg.toFixed(2);
  if (o.xa != null) r.expected_assists = o.xa.toFixed(2);
  // Defensive contribution only exists for 2024/25 and 2025/26.
  if (o.dc != null) r.defensive_contribution = o.dc;
  if (o.saves != null) r.saves = o.saves;
  return r;
}

/** Route the real data layer at canned element-summary payloads. */
function mockApi(history: Record<number, Row[]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const id = Number(/element-summary\/(\d+)/.exec(String(url))?.[1]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ history: [], history_past: history[id] ?? [] }),
      } as unknown as Response;
    })
  );
}

function project(elements: Element[], past?: Map<number, PastSeasonStats>) {
  const bootstrap = {
    events: [
      {
        id: 1,
        name: "Gameweek 1",
        deadline_time: "2026-08-21T17:30:00Z",
        finished: false,
        is_current: false,
        is_next: true,
        average_entry_score: 0,
        highest_score: null,
      },
    ],
    teams,
    elements,
    total_players: 1_167_938,
  } as unknown as Bootstrap;
  return projectAll({ bootstrap, fixtures, nextEvent: 1, horizon: 1, pastSeason: past });
}

// Unique id ranges per test keep the data layer's request cache from bleeding
// one test's canned payload into the next.
let nextId = 1000;
const ids = (n: number) => Array.from({ length: n }, () => nextId++);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-10T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("absent stats survive the real fetch path", () => {
  it("does not read a pre-2022/23 season as zero xG", async () => {
    // Both strikers played the same volume. One has recorded xG, the other's
    // season predates the column. If absence were coerced to 0 the second man
    // would look like a striker who cannot shoot.
    const [proven, older, coerced] = ids(3);
    mockApi({
      [proven]: [
        season("2025/26", { minutes: 3000, starts: 34, points: 180, goals: 18, assists: 6, xg: 16, xa: 5 }),
      ],
      [older]: [season("2020/21", { minutes: 3000, starts: 34, points: 180, goals: 18, assists: 6 })],
      // The control is `older`'s row with the two columns present and zero —
      // which is not a hypothetical shape, it is precisely what the old
      // number-coercing parser handed the model for every pre-2022/23 season.
      // Comparing against the defect's own output is what makes the assertion
      // below bite; comparing against `proven` does not, because a fraction of
      // a healthy striker is a bar that near-zero xG clears anyway.
      [coerced]: [
        season("2020/21", { minutes: 3000, starts: 34, points: 180, goals: 18, assists: 6, xg: 0, xa: 0 }),
      ],
    });
    const past = (await fetchPastSeason([proven, older, coerced], 2)).data;

    expect(past.get(older)!.xg).toBeUndefined();
    expect(past.get(older)!.xa).toBeUndefined();
    expect(past.get(proven)!.xg).toBeCloseTo(16, 5);
    expect(past.get(coerced)!.xg).toBe(0);

    const xp = project(
      [
        el({ id: proven, web_name: "Proven", team: 1, element_type: 4, now_cost: 80, ep_next: "3.0" }),
        el({ id: older, web_name: "Older", team: 2, element_type: 4, now_cost: 80, ep_next: "3.0" }),
        el({ id: coerced, web_name: "Coerced", team: 4, element_type: 4, now_cost: 80, ep_next: "3.0" }),
      ],
      past
    );
    // He falls back to the price prior — below a man with measured xG, and
    // above the man whose xG was read as a genuine zero.
    //
    // The first line is kept for shape but proves very little on its own: half
    // of a healthy striker is a bar that a striker with no shooting at all
    // clears comfortably, so it passes under the defect too. The second line is
    // the test. The two rows differ in nothing except whether the column is
    // absent or present-and-zero, so under coercion they are bit-identical and
    // the ratio is exactly 1.000; fixed, it is 1.091. The margin is only nine
    // percent because pre-season the anchors carry 70% of the weight and both
    // men have the same ep_next and the same points, which is worth knowing:
    // getting xG right matters far less in August than the minutes do.
    expect(xp.get(older)!.next).toBeGreaterThan(xp.get(proven)!.next * 0.5);
    expect(xp.get(older)!.next).toBeGreaterThan(xp.get(coerced)!.next * 1.05);
  });

  it("does not read a season without a starts column as a season of no starts", async () => {
    // 2020/21 predates `starts`. Read as zero it would rate an ever-present
    // below a player who has never appeared at all.
    const [old3000, unknown] = ids(2);
    mockApi({
      [old3000]: [season("2020/21", { minutes: 3000, points: 150 })],
      [unknown]: [],
    });
    const past = (await fetchPastSeason([old3000, unknown], 2)).data;
    expect(past.get(old3000)!.starts).toBeUndefined();
    expect(past.get(old3000)!.seasons![0].starts).toBeUndefined();

    const xp = project(
      [
        el({ id: old3000, web_name: "Ever present", team: 1, element_type: 3, now_cost: 65 }),
        el({ id: unknown, web_name: "Never played", team: 2, element_type: 3, now_cost: 65 }),
      ],
      past
    );
    expect(xp.get(old3000)!.next).toBeGreaterThan(xp.get(unknown)!.next);
  });
});

describe("multi-season history", () => {
  it("rates a player on his newest season, not his best", async () => {
    // Same three seasons, opposite order. A fading regular and a rising one
    // have identical totals — only recency tells them apart.
    const [fading, rising] = ids(2);
    mockApi({
      [fading]: [
        season("2023/24", { minutes: 3200, starts: 36, points: 160 }),
        season("2024/25", { minutes: 1600, starts: 17, points: 80, dc: 90 }),
        season("2025/26", { minutes: 400, starts: 3, points: 20, dc: 25 }),
      ],
      [rising]: [
        season("2023/24", { minutes: 400, starts: 3, points: 20 }),
        season("2024/25", { minutes: 1600, starts: 17, points: 80, dc: 90 }),
        season("2025/26", { minutes: 3200, starts: 36, points: 160, dc: 200 }),
      ],
    });
    const past = (await fetchPastSeason([fading, rising], 2)).data;
    expect(past.get(fading)!.seasons).toHaveLength(3);

    const xp = project(
      [
        el({ id: fading, web_name: "Fading", team: 1, element_type: 2, now_cost: 55 }),
        el({ id: rising, web_name: "Rising", team: 2, element_type: 2, now_cost: 55 }),
      ],
      past
    );
    expect(xp.get(rising)!.next).toBeGreaterThan(xp.get(fading)!.next * 1.4);
  });

  it("keeps faith with a regular who lost one season to injury", async () => {
    // A missing year is not evidence of decline. Weighted across seasons he
    // still reads as a starter, while a career-long bench player does not.
    const [injured, benchWarmer] = ids(2);
    mockApi({
      [injured]: [
        season("2023/24", { minutes: 3200, starts: 36, points: 150 }),
        season("2024/25", { minutes: 3100, starts: 35, points: 145, dc: 180 }),
        season("2025/26", { minutes: 300, starts: 3, points: 12, dc: 20 }),
      ],
      [benchWarmer]: [
        season("2023/24", { minutes: 350, starts: 2, points: 14 }),
        season("2024/25", { minutes: 300, starts: 2, points: 12, dc: 18 }),
        season("2025/26", { minutes: 300, starts: 3, points: 12, dc: 20 }),
      ],
    });
    const past = (await fetchPastSeason([injured, benchWarmer], 2)).data;
    const xp = project(
      [
        el({ id: injured, web_name: "Returning", team: 1, element_type: 3, now_cost: 65 }),
        el({ id: benchWarmer, web_name: "Bench", team: 2, element_type: 3, now_cost: 65 }),
      ],
      past
    );
    expect(xp.get(injured)!.next).toBeGreaterThan(xp.get(benchWarmer)!.next * 1.25);
  });

  it("treats a season spent outside the league as absent, not as zero", async () => {
    // A player promoted with his club has no row for the year he spent in the
    // Championship. That silence must not be read as a year of not playing.
    const [promoted, dropped] = ids(2);
    mockApi({
      [promoted]: [season("2023/24", { minutes: 3000, starts: 34, points: 140 })],
      [dropped]: [
        season("2023/24", { minutes: 3000, starts: 34, points: 140 }),
        season("2024/25", { minutes: 0, starts: 0, points: 0 }),
        season("2025/26", { minutes: 0, starts: 0, points: 0 }),
      ],
    });
    const past = (await fetchPastSeason([promoted, dropped], 2)).data;
    const xp = project(
      [
        el({ id: promoted, web_name: "Promoted", team: 1, element_type: 3, now_cost: 60 }),
        el({ id: dropped, web_name: "Frozen out", team: 2, element_type: 3, now_cost: 60 }),
      ],
      past
    );
    expect(xp.get(promoted)!.next).toBeGreaterThan(xp.get(dropped)!.next * 1.5);
  });
});

describe("goalkeeper competition", () => {
  it("demotes a second-choice keeper who shares a club with a proven number one", async () => {
    // The case FPL's own ep_next gets wrong: an untested keeper is priced like
    // a starter and given 2.6 expected points. One club has one shirt.
    const [first, second, lone] = ids(3);
    mockApi({
      [first]: [season("2025/26", { minutes: 3330, starts: 37, points: 162, saves: 95 })],
      [second]: [],
      [lone]: [],
    });
    const past = (await fetchPastSeason([first, second, lone], 3)).data;
    const xp = project(
      [
        el({ id: first, web_name: "Number one", team: 1, element_type: 1, now_cost: 60, ep_next: "4.0" }),
        el({ id: second, web_name: "Understudy", team: 1, element_type: 1, now_cost: 50, ep_next: "2.6" }),
        // Same player, same price, no rival on record: the control.
        el({ id: lone, web_name: "Unrivalled", team: 3, element_type: 1, now_cost: 50, ep_next: "2.6" }),
      ],
      past
    );
    expect(xp.get(first)!.next).toBeGreaterThan(xp.get(second)!.next * 2);
    // Competition, not price, is what demoted him.
    expect(xp.get(second)!.next).toBeLessThan(xp.get(lone)!.next);
  });

  it("gives the shirt to the only keeper a club lists", async () => {
    // This assertion used to read "less than 1.2", which was the old
    // divide-by-total design showing through: it had to refuse to promote a
    // lone keeper, because dividing him by himself would have made him the
    // surest starter in the game. Allocating a fixed slot has no such problem,
    // and the football is not ambiguous — if a club lists one keeper, he plays.
    //
    // Every real club lists three to five, so this is a robustness case rather
    // than one the live bootstrap can produce.
    const [solo] = ids(1);
    mockApi({ [solo]: [season("2025/26", { minutes: 0, starts: 0, points: 0 })] });
    const past = (await fetchPastSeason([solo], 1)).data;
    const xp = project(
      [el({ id: solo, web_name: "Solo", team: 1, element_type: 1, now_cost: 45, ep_next: "2.6" })],
      past
    );
    const n = xp.get(solo)!.next;
    expect(n).toBeGreaterThan(2);
    // Still a keeper, not a premium forward: the ceiling is what a clean sheet
    // and a handful of saves are worth.
    expect(n).toBeLessThan(6);
  });
});

describe("availability", () => {
  it("gives a long-term injury no points at all", async () => {
    // status "i" with a zero chance of playing. Before the fix the anchor blend
    // ignored availability and paid him most of a fit player's score.
    const [out, fit] = ids(2);
    mockApi({
      [out]: [season("2025/26", { minutes: 3000, starts: 34, points: 150, xg: 8, xa: 6 })],
      [fit]: [season("2025/26", { minutes: 3000, starts: 34, points: 150, xg: 8, xa: 6 })],
    });
    const past = (await fetchPastSeason([out, fit], 2)).data;
    const xp = project(
      [
        el({
          id: out, web_name: "ACL", team: 1, element_type: 3, now_cost: 75, ep_next: "0.0",
          status: "i", chance_of_playing_next_round: 0, news: "Knee injury - expected back 01 Jan",
        }),
        el({ id: fit, web_name: "Fit", team: 2, element_type: 3, now_cost: 75, ep_next: "4.0" }),
      ],
      past
    );
    expect(xp.get(out)!.next).toBe(0);
    expect(xp.get(fit)!.next).toBeGreaterThan(2);
  });

  it("eases a player back in over the weeks after his stated return date", async () => {
    // "expected back 01 Aug" before a 22 Aug kickoff: three weeks clear, so he
    // should be close to fully available. A date after kickoff means zero.
    const [backEarly, backLate] = ids(2);
    mockApi({
      [backEarly]: [season("2025/26", { minutes: 3000, starts: 34, points: 150, xg: 8, xa: 6 })],
      [backLate]: [season("2025/26", { minutes: 3000, starts: 34, points: 150, xg: 8, xa: 6 })],
    });
    const past = (await fetchPastSeason([backEarly, backLate], 2)).data;
    const xp = project(
      [
        el({
          id: backEarly, web_name: "Back early", team: 1, element_type: 3, now_cost: 75,
          status: "i", chance_of_playing_next_round: 0, news: "Hamstring - expected back 01 Aug",
        }),
        el({
          id: backLate, web_name: "Back late", team: 2, element_type: 3, now_cost: 75,
          status: "i", chance_of_playing_next_round: 0, news: "Hamstring - expected back 20 Sep",
        }),
      ],
      past
    );
    expect(xp.get(backLate)!.next).toBe(0);
    expect(xp.get(backEarly)!.next).toBeGreaterThan(xp.get(backLate)!.next);
    expect(xp.get(backEarly)!.next).toBeGreaterThan(1);
  });
});

describe("set-piece duty", () => {
  it("treats the designated penalty taker as a starter even on thin evidence", async () => {
    // A club does not give penalties to a man it plans to leave on the bench.
    // Both players look identical in the record; only the duty differs.
    const [taker, other] = ids(2);
    mockApi({
      [taker]: [season("2025/26", { minutes: 700, starts: 6, points: 40, xg: 2, xa: 1 })],
      [other]: [season("2025/26", { minutes: 700, starts: 6, points: 40, xg: 2, xa: 1 })],
    });
    const past = (await fetchPastSeason([taker, other], 2)).data;
    const xp = project(
      [
        el({
          id: taker, web_name: "Penalties", team: 1, element_type: 3, now_cost: 60,
          penalties_order: 1,
        }),
        el({ id: other, web_name: "No duty", team: 2, element_type: 3, now_cost: 60 }),
      ],
      past
    );
    expect(xp.get(taker)!.next).toBeGreaterThan(xp.get(other)!.next * 1.5);
  });
});

describe("thin samples are not extrapolated", () => {
  it("does not let a one-minute cameo outrank a proven starter", async () => {
    // The most expensive bug this model has had, and it never showed up in a
    // unit test — only in a full-season backtest, where it cost 150 points.
    //
    // Pre-season the whole projection leans on last season's line, and last
    // season's line was being turned into a rate by plain division. A player
    // who came on for one minute and banked the appearance point therefore
    // read as "one point in 1/90th of a match" — ninety points per ninety —
    // and the launch drafter, asked for the highest-scoring squad it could
    // afford, bought fifteen of them. Salah projected 7.1; a £4.0m reserve
    // with a single substitute appearance projected 28.6.
    //
    // Two full matches of evidence is not a rate. It is a rounding error with
    // a denominator.
    // The line below is Vitor Reis's real 2024/25 record, to the minute.
    const [cameo, regular] = ids(2);
    mockApi({
      [cameo]: [season("2025/26", { minutes: 1, starts: 0, points: 1 })],
      [regular]: [
        season("2025/26", {
          minutes: 3200, starts: 36, points: 190, goals: 18, assists: 12,
          xg: 17.5, xa: 10.2, bonus: 22, ict: 300,
        }),
      ],
    });
    const past = (await fetchPastSeason([cameo, regular], 2)).data;
    const xp = project(
      [
        el({ id: cameo, web_name: "Cameo", team: 1, element_type: 2, now_cost: 50 }),
        el({ id: regular, web_name: "Regular", team: 2, element_type: 3, now_cost: 130 }),
      ],
      past
    );
    const c = xp.get(cameo)!.next;
    const r = xp.get(regular)!.next;
    expect(c).toBeLessThan(r);
    // The absolute figure is what matters, and it is what the ratio hides.
    // Restoring the raw division puts this player at 1.8 rather than 0.5 —
    // still below the premium, so a ratio assertion passes happily, and still
    // enough to buy him at £5.0m ahead of a defender who plays every week.
    // A single substitute appearance has to read as roughly nothing.
    expect(c).toBeLessThan(0.75);
  });

  it("rates a half-season regular between the cameo and the ever-present", async () => {
    // Shrinkage has to be graded, not a cliff: evidence should buy confidence
    // in proportion to how much of it there is.
    const [thin, half, full] = ids(3);
    const line = (m: number, s: number, p: number) =>
      season("2025/26", { minutes: m, starts: s, points: p, goals: Math.round(p / 12),
        xg: p / 14, xa: p / 22, bonus: Math.round(p / 12), ict: p });
    mockApi({
      [thin]: [line(180, 1, 12)],
      [half]: [line(1600, 18, 90)],
      [full]: [line(3200, 36, 180)],
    });
    const past = (await fetchPastSeason([thin, half, full], 3)).data;
    const xp = project(
      [
        el({ id: thin, web_name: "Thin", team: 1, element_type: 3, now_cost: 60 }),
        el({ id: half, web_name: "Half", team: 2, element_type: 3, now_cost: 60 }),
        el({ id: full, web_name: "Full", team: 3, element_type: 3, now_cost: 60 }),
      ],
      past
    );
    expect(xp.get(thin)!.next).toBeLessThan(xp.get(half)!.next);
    expect(xp.get(half)!.next).toBeLessThan(xp.get(full)!.next);
  });

  it("does not quote a per-appearance rate off a single substitute outing", async () => {
    // `pointsPerAppearanceFloor` had no test at all, which was worth finding
    // out, because the answer to "what breaks if I delete it" turned out to be
    // "nothing, visibly". Two separate defences were built against the cameo
    // disaster — this floor under the per-appearance denominator, and the
    // minutes shrinkage in the anchor — and the shrinkage does nearly all of
    // the work. Deleting the floor moves the player below from 0.554 to 0.612
    // and every one of the other 131 tests still passes.
    //
    // Ten percent is small, and the bound is set where it is because of that
    // rather than in spite of it: a test that only fires on a large move would
    // not fire on this one, and a term nothing tests is a term that quietly
    // stops working. What makes the case reproduce at all is the shape — two
    // goals from ninety-five minutes off the bench, so `starts` is 1 and
    // `minutes / 70` is 1.4, and the floor is the only thing standing between
    // fourteen points and a denominator of one.
    const [flash] = ids(1);
    mockApi({
      [flash]: [
        season("2025/26", { minutes: 95, starts: 1, points: 14, goals: 2, xg: 1.6, xa: 0.2, bonus: 3, ict: 12 }),
      ],
    });
    const past = (await fetchPastSeason([flash], 1)).data;
    const xp = project(
      [el({ id: flash, web_name: "Flash", team: 1, element_type: 4, now_cost: 50, ep_next: null })],
      past
    );
    expect(xp.get(flash)!.next).toBeLessThan(0.59);
  });
});

describe("one shirt per club in goal", () => {
  it("keeps a proven number one at a realistic level, not just above his deputies", async () => {
    // The first fix here divided each club's keepers by their total so they
    // summed to one. Ordering within the club came out right and the level came
    // out absurd: clubs list four or five keepers, so every keeper in the game
    // landed near 0.25 of a start and none of them cleared 1.9 xP. The drafter
    // responded rationally — it bought the two cheapest keepers in the league,
    // because if no keeper can score, none is worth paying for.
    //
    // The number that matters is therefore absolute, not relative.
    const [one, two, three, four] = ids(4);
    mockApi({
      [one]: [season("2025/26", { minutes: 3330, starts: 37, points: 160, saves: 110, ict: 120 })],
      [two]: [season("2025/26", { minutes: 90, starts: 1, points: 4, saves: 3 })],
      [three]: [],
      [four]: [],
    });
    const past = (await fetchPastSeason([one, two, three, four], 4)).data;
    const xp = project(
      [
        el({ id: one, web_name: "Nailed", team: 1, element_type: 1, now_cost: 55 }),
        el({ id: two, web_name: "Deputy", team: 1, element_type: 1, now_cost: 45 }),
        el({ id: three, web_name: "Third", team: 1, element_type: 1, now_cost: 40 }),
        el({ id: four, web_name: "Kid", team: 1, element_type: 1, now_cost: 40 }),
      ],
      past
    );
    const n = xp.get(one)!.next;
    expect(n).toBeGreaterThan(xp.get(two)!.next);
    expect(xp.get(three)!.next).toBeLessThan(xp.get(two)!.next * 1.05);
    // A first-choice Premier League keeper is worth roughly three points a
    // week. Anything under two means the squad optimiser will not buy one.
    expect(n).toBeGreaterThan(2.5);
  });

  it("hands the shirt to the deputy when the number one is ruled out", async () => {
    // Availability multiplies the weight, not the answer, so the mass moves
    // across rather than evaporating.
    const [one, two] = ids(2);
    mockApi({
      [one]: [season("2025/26", { minutes: 3330, starts: 37, points: 160, saves: 110 })],
      [two]: [season("2025/26", { minutes: 0, starts: 0, points: 0 })],
    });
    const past = (await fetchPastSeason([one, two], 2)).data;
    const xp = project(
      [
        el({
          id: one, web_name: "Nailed", team: 1, element_type: 1, now_cost: 55,
          status: "i", chance_of_playing_next_round: 0,
          news: "Knee injury - expected back 20 Dec",
        }),
        el({ id: two, web_name: "Deputy", team: 1, element_type: 1, now_cost: 45 }),
      ],
      past
    );
    expect(xp.get(one)!.next).toBe(0);
    expect(xp.get(two)!.next).toBeGreaterThan(2.2);
  });

  it("gives the shirt back once the stated return date has passed", async () => {
    // The allocation above used to be computed ONCE, from
    // `availabilityAt(el, 0)` with no kickoff time, and that single number was
    // then used for every gameweek in the horizon. So a number one with a knock
    // and "expected back 05 Sep" written on his card was not merely out for the
    // opening weekend — he was out for the entire projection, and his deputy was
    // credited with the shirt in perpetuity. At launch, when the horizon is the
    // whole opening month, that is the difference between drafting the club's
    // actual keeper and drafting a man who will not play after the first fortnight.
    //
    // Four separate gameweeks, so the return date falls INSIDE the horizon.
    const [one, two] = ids(2);
    mockApi({
      [one]: [season("2025/26", { minutes: 3330, starts: 37, points: 160, saves: 110 })],
      [two]: [season("2025/26", { minutes: 180, starts: 2, points: 8, saves: 6 })],
    });
    const past = (await fetchPastSeason([one, two], 2)).data;
    const kicks = [
      "2026-08-22T14:00:00Z", // GW1 — out
      "2026-08-29T14:00:00Z", // GW2 — out
      "2026-09-12T14:00:00Z", // GW3 — a week past the return date
      "2026-09-19T14:00:00Z", // GW4 — a fortnight past it
    ];
    const multiFixtures: Fixture[] = kicks.map((kickoff_time, i) => ({
      id: 100 + i,
      event: i + 1,
      team_h: 1,
      team_a: 2,
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      finished: false,
      started: false,
      kickoff_time,
      team_h_score: null,
      team_a_score: null,
    }));
    const elements = [
      el({
        id: one, web_name: "Nailed", team: 1, element_type: 1, now_cost: 55,
        status: "i", chance_of_playing_next_round: 0,
        news: "Knee injury - expected back 05 Sep",
      }),
      el({ id: two, web_name: "Deputy", team: 1, element_type: 1, now_cost: 45 }),
    ];
    const bootstrap = {
      events: kicks.map((_, i) => ({
        id: i + 1,
        name: `Gameweek ${i + 1}`,
        deadline_time: "2026-08-21T17:30:00Z",
        finished: false,
        is_current: false,
        is_next: i === 0,
        average_entry_score: 0,
        highest_score: null,
      })),
      teams,
      elements,
      total_players: 1_167_938,
    } as unknown as Bootstrap;
    const xp = projectAll({
      bootstrap, fixtures: multiFixtures, nextEvent: 1, horizon: 4, pastSeason: past,
    });
    const nailed = xp.get(one)!.perGw;
    const deputy = xp.get(two)!.perGw;

    // Out for the first two, exactly as the news says.
    expect(nailed.get(1) ?? 0).toBe(0);
    expect(nailed.get(2) ?? 0).toBe(0);
    // Back for the last two — and back in front of the deputy, because the
    // pecking order never changed, only his fitness did. Under the frozen
    // version this was 0 for all four.
    expect(nailed.get(4)!).toBeGreaterThan(2);
    expect(nailed.get(4)!).toBeGreaterThan(deputy.get(4)!);
    // And the deputy gives it back rather than keeping it all season.
    // And the deputy gives the shirt BACK rather than keeping it all season:
    // 2.75 a week in the two gameweeks he is actually the keeper, 0.41 once the
    // first choice is fit again. Two separate defects had to be fixed for this
    // line to hold. The allocation itself was frozen at offset 0, which kept the
    // deputy on the full 2.75 for all four; and the ep_next and last-season
    // anchors were still being scaled by the offset-0 minutes model even after
    // the allocation was fixed, which held him at 2.30. Each on its own leaves
    // this assertion failing, which is the point of asserting it.
    expect(deputy.get(4)!).toBeLessThan(deputy.get(1)! * 0.3);
    expect(nailed.get(4)!).toBeGreaterThan(deputy.get(4)! * 3);
  });
});

describe("a keeper's save points depend on who he is facing", () => {
  it("widens the gap between a busy keeper and an idle one against a harder fixture", async () => {
    // Pre-season FPL zeroes every `strength_attack_*` and `strength_defence_*`,
    // so `buildStrengths` reports the detailed model unusable and every
    // projection the live app makes between May and August goes down the FDR
    // fallback. In that fallback the shots-faced term used to be `1 / ownQuality`
    // and nothing else — the opponent, the one thing FDR actually tells you, was
    // not in it. A keeper facing the champions and a keeper facing the promoted
    // side were credited with the same saves.
    //
    // Two keepers, at two clubs of identical quality, alike in every respect
    // except that one made 140 saves last season and the other made 8. Their
    // last-season POINTS are set equal on purpose, so the last-season anchor
    // cannot be what separates them and the only live difference is saves.
    const [busy, idle] = ids(2);
    mockApi({
      [busy]: [season("2025/26", { minutes: 3330, starts: 37, points: 130, saves: 140 })],
      [idle]: [season("2025/26", { minutes: 3330, starts: 37, points: 130, saves: 8 })],
    });
    const past = (await fetchPastSeason([busy, idle], 2)).data;
    // GW1 is a soft fixture for both clubs, GW2 the hardest there is.
    const paired: Fixture[] = [
      { event: 1, difficulty: 2 },
      { event: 2, difficulty: 5 },
    ].flatMap((g, i) =>
      [
        [1, 2],
        [3, 4],
      ].map(([h, a], j) => ({
        id: 200 + i * 2 + j,
        event: g.event,
        team_h: h,
        team_a: a,
        team_h_difficulty: g.difficulty,
        team_a_difficulty: g.difficulty,
        finished: false,
        started: false,
        kickoff_time: "2026-08-22T14:00:00Z",
        team_h_score: null,
        team_a_score: null,
      }))
    );
    const elements = [
      el({ id: busy, web_name: "Busy", team: 1, element_type: 1, now_cost: 50, ep_next: null }),
      el({ id: idle, web_name: "Idle", team: 3, element_type: 1, now_cost: 50, ep_next: null }),
    ];
    const bootstrap = {
      events: [1, 2].map((id) => ({
        id,
        name: `Gameweek ${id}`,
        deadline_time: "2026-08-21T17:30:00Z",
        finished: false,
        is_current: false,
        is_next: id === 1,
        average_entry_score: 0,
        highest_score: null,
      })),
      teams,
      elements,
      total_players: 1_167_938,
    } as unknown as Bootstrap;
    const xp = projectAll({
      bootstrap, fixtures: paired, nextEvent: 1, horizon: 2, pastSeason: past,
    });
    const soft = xp.get(busy)!.perGw.get(1)! - xp.get(idle)!.perGw.get(1)!;
    const hard = xp.get(busy)!.perGw.get(2)! - xp.get(idle)!.perGw.get(2)!;
    // A busy keeper is worth more than an idle one in both weeks...
    expect(soft).toBeGreaterThan(0);
    // ...and worth MORE more in the week his goal is under siege. The two clubs
    // have identical `strength_overall_*`, so under the old own-quality-only
    // term these two numbers came out equal to the last decimal.
    expect(hard).toBeGreaterThan(soft * 1.15);
  });
});

describe("players with and without a record are scored by the same machine", () => {
  // The defect these cover was not a wrong number anywhere. Every individual
  // projection looked defensible; the fault was that two groups of players were
  // scored by DIFFERENT mechanisms and the results compared as though they were
  // the same quantity. The anchor toward last season's output was applied only
  // to players who had a last season, so a proven regular was scored 70% anchor
  // and 30% fixture model while a new arrival, having no anchor to be pulled
  // toward, was scored 100% fixture model.
  //
  // It is invisible in any test that looks at one player, and invisible in a
  // ratio between two proven players. It showed up only when the whole
  // candidate pool was ranked against what those players went on to score:
  // within the men who had a previous season the ranking correlated at
  // 0.36-0.44, within the men who did not at 0.32-0.39, and pooled it fell to
  // 0.23-0.31 — worse than either half, which can only happen if the halves are
  // individually sound and mutually miscalibrated. They were: averaged over
  // three seasons the players with no record were projected HIGHER than the
  // proven ones, 1.38 against 1.28, and went on to score half as much, 30
  // against 59. Giving everyone the anchor, falling back to the price-implied
  // prior where there is no evidence to move it, took the pooled figure to
  // 0.42-0.45.
  //
  // Both tests below pass `ep_next: null`, and that is load-bearing rather than
  // lazy fixture-building. When ep_next IS present the damage is largely masked
  // — a player with no record still gets an anchor, FPL's own, and
  // `epMinutesBlindPStart` already scales it down for someone unlikely to play.
  // Written with ep_next populated these same two tests pass with the defect
  // restored, which was checked rather than assumed. The exposure is the case
  // where FPL publishes no estimate: a new arrival added to the list after the
  // summer rebuild, and every gameweek of the historical record the backtest
  // runs on, which has no ep_next column at all.

  it("does not rate an unknown above a proven regular of the same price", async () => {
    // Same club, same position, same price, one gameweek, identical fixture.
    // The only difference is that one has played and the other has an empty
    // `history_past`, which is what the live API returns for a player new to
    // the league.
    const [regular, newcomer] = ids(2);
    mockApi({
      [regular]: [
        season("2025/26", { minutes: 3100, starts: 35, points: 145, goals: 8, assists: 11, xg: 7.4, xa: 9.8, bonus: 14, ict: 220 }),
      ],
      [newcomer]: [],
    });
    const past = (await fetchPastSeason([regular, newcomer], 2)).data;
    const xp = project(
      [
        el({ id: regular, web_name: "Regular", team: 1, element_type: 3, now_cost: 55, ep_next: null }),
        el({ id: newcomer, web_name: "Newcomer", team: 1, element_type: 3, now_cost: 55, ep_next: null }),
      ],
      past
    );
    const r = xp.get(regular)!.next;
    const n = xp.get(newcomer)!.next;
    // Wide, not merely present, and the threshold is set from measurement
    // rather than taste: the unknown lands at 0.27 of the regular once everyone
    // shares one anchor, and at 0.47 with the defect restored. A looser bound
    // like "less than 0.7" is satisfied by both and proves nothing — which was
    // the first draft of this test, and it was checked before being believed.
    expect(n).toBeLessThan(r * 0.35);
    // Absolutely too, since the level rather than the ratio is what gets
    // compared across positions when the optimiser spends its budget.
    expect(n).toBeLessThan(1.2);
  });

  it("separates two unknowns by price when FPL offers no estimate", async () => {
    // With no record and no ep_next there is exactly one opinion available
    // about these two men, and it is the market's. Under the defect neither
    // reached the anchor at all, so both fell through to a fixture model whose
    // rates are priors — and the priors are far less price-sensitive than the
    // anchor, so a £9.5m signing and a £4.5m squad filler came out close
    // together.
    const [cheap, dear] = ids(2);
    mockApi({ [cheap]: [], [dear]: [] });
    const past = (await fetchPastSeason([cheap, dear], 2)).data;
    const xp = project(
      [
        el({ id: cheap, web_name: "Cheap", team: 1, element_type: 3, now_cost: 45, ep_next: null }),
        el({ id: dear, web_name: "Dear", team: 1, element_type: 3, now_cost: 95, ep_next: null }),
      ],
      past
    );
    // 8.6x sharing one anchor, 3.4x with the defect restored. Both clear a
    // 2x bound, so 2x would have been a test that could not fail.
    expect(xp.get(dear)!.next).toBeGreaterThan(xp.get(cheap)!.next * 6);
  });
});

describe("the season a player's history is aged against", () => {
  it("still separates a nailed starter from a fringe player when the deadline is blank", async () => {
    // A NaN regression, and NaN bugs do not announce themselves — this one ran
    // green through 128 tests, a type check and a lint while quietly disabling
    // the largest signal the pre-season model has.
    //
    // Every season in `history_past` is aged against the year the new season
    // starts in, which is read from the event list. That read used to chain
    // `??`, which rejects null and undefined and accepts an empty string. An
    // empty string is not a date; `getUTCFullYear()` on it is NaN; and NaN
    // passes every guard downstream, because `NaN < 0` and `NaN < 0.05` are
    // both false and `?? 0` does not fire on it. The evidence builder ended up
    // returning null for every player who had ever played, so the minutes model
    // fell back to price alone and these two men — one an ever-present, one a
    // bit-part player, same price — came out at exactly 1.000x each other.
    //
    // The blank deadline is the real trigger rather than a contrived one: it is
    // what a reconstructed event list contains, which is how a whole backtest
    // came to be run against a model with its minutes engine switched off.
    const [nailed, fringe] = ids(2);
    mockApi({
      [nailed]: [season("2025/26", { minutes: 3330, starts: 37, points: 160, goals: 6, assists: 9, xg: 5.5, xa: 8.1, bonus: 16, ict: 210 })],
      [fringe]: [season("2025/26", { minutes: 300, starts: 2, points: 14, goals: 0, assists: 1, xg: 0.4, xa: 0.9, ict: 18 })],
    });
    const past = (await fetchPastSeason([nailed, fringe], 2)).data;
    const elements = [
      el({ id: nailed, web_name: "Nailed", team: 1, element_type: 3, now_cost: 60, ep_next: null }),
      el({ id: fringe, web_name: "Fringe", team: 1, element_type: 3, now_cost: 60, ep_next: null }),
    ];
    const bootstrap = {
      // Blank, exactly as a synthetic event list has it. The fixture list below
      // carries a real kickoff, and that is what has to be fallen back to.
      events: [{ id: 1, name: "Gameweek 1", deadline_time: "", finished: false,
        is_current: false, is_next: true, average_entry_score: 0, highest_score: null }],
      teams, elements, total_players: 1_167_938,
    } as unknown as Bootstrap;
    const xp = projectAll({ bootstrap, fixtures, nextEvent: 1, horizon: 1, pastSeason: past });
    // Measured at 8.6x once the date is parsed rather than assumed, and at
    // exactly 1.000x under the defect. Anything above a small multiple pins it.
    expect(xp.get(nailed)!.next).toBeGreaterThan(xp.get(fringe)!.next * 3);
  });

  it("lets an old season argue more quietly than a recent one", () => {
    // The rate line the projection anchors on does not come from LAST season.
    // `fetchPastSeason` takes the most recent season in which the player got on
    // the pitch, so for a man who missed a year injured it is the season before
    // that, and for one returning from three years abroad it is older still.
    // Taking the RATE from there is right — a lost year does not erase what a
    // player can do per 90 — but it was also being taken at full CONFIDENCE,
    // which is a different claim and an indefensible one.
    //
    // The minutes model has never made that mistake: it weights every past
    // season by `preseasonSeasonDecay ^ age`. So the model held two
    // contradictory views of the same row, discounting it when asking whether
    // the player will play and trusting it completely when asking how well.
    //
    // The pair below is CONSTRUCTED rather than fetched, and deliberately so.
    // Their season lists are identical, which is what the minutes model reads,
    // so it cannot tell them apart; the only field that differs is the one
    // naming which season the rate line came from, which only the anchor reads.
    // A realistically fetched pair would differ in both places at once and
    // could not show that the anchor reacts on its own.
    const seasons = [
      { seasonName: "2022/23", minutes: 3000, starts: 34 },
      { seasonName: "2025/26", minutes: 3000, starts: 34 },
    ];
    const base = {
      points: 190, minutes: 3000, starts: 34, plSeasons: 2, seasons,
      goals: 14, assists: 9, xg: 12.5, xa: 8.2, bonus: 18, ict: 240,
    };
    const past = new Map<number, PastSeasonStats>([
      [1, { ...base, seasonName: "2025/26" } as PastSeasonStats],
      [2, { ...base, seasonName: "2022/23" } as PastSeasonStats],
    ]);
    const elements = [
      el({ id: 1, web_name: "Fresh", team: 1, element_type: 3, now_cost: 55, ep_next: null }),
      el({ id: 2, web_name: "Stale", team: 1, element_type: 3, now_cost: 55, ep_next: null }),
    ];
    const xp = project(elements, past);
    const fresh = xp.get(1)!.next;
    const stale = xp.get(2)!.next;
    // 4.60 against 4.00. Under the defect the two are bit-identical, so the
    // 0.95 bound is what makes this test a test at all; the fix has to move it
    // 5% before the assertion notices.
    expect(stale).toBeLessThan(fresh * 0.95);
    // And not collapsed either. Scaling the EVIDENCE leaves the implied per-90
    // exactly where it was and only shortens how far it can pull away from the
    // price-implied prior, so a good season three years old still says the same
    // thing in a quieter voice. Scaling the RATE instead — the obvious wrong
    // way to write this — would take a fifth off the projection outright.
    expect(stale).toBeGreaterThan(fresh * 0.8);
  });
});
