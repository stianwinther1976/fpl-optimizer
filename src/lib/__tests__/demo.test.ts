import { describe, expect, it } from "vitest";
import { DEMO_ENTRY_ID, makeDemoUniverse } from "../demo";
import { netGwDelta, netGwPoints } from "../display";
import { matchMinute, projectAutoSubs, provisionalBonus } from "../live";
import {
  INITIAL_BUDGET,
  computeFreeTransfers,
  purchasePriceFor,
  remainingChips,
  sellingPrice,
} from "../rules";
import type { Bootstrap, Element, EventLive, Fixture, Pick, Transfer } from "../types";

/*
 * The demo universe is the shop window: it is what every visitor without an FPL
 * id sees, and it is the only data the app ever renders that nobody can check
 * against the real feed. That makes it the one dataset where an inconsistency
 * is invisible until a user notices and asks.
 *
 * One did. The dashboard showed "Latest GW 61 pts" beside a "-29 vs GW19"
 * delta, while the pitch in the same view showed 21 — because GW20 was written
 * out five separate times by hand (the live elements, `summary_event_points`,
 * the history row, the running `total_points`, and the mini-league row) and the
 * five copies had drifted apart. The app's arithmetic was right in every case;
 * it was faithfully reporting five different fixtures that all claimed to be
 * the same gameweek.
 *
 * Real FPL data cannot contradict itself, so a demo that does is not testing
 * the app, it is generating bug reports. These tests assert the property that
 * makes the demo worth having: that it is internally consistent the way the
 * real feed is.
 *
 * Where a screen computes a figure rather than printing one — the pitch corner
 * runs `projectAutoSubs`, the Live tab adds `provisionalBonus`, the mini-league
 * re-derives every rival's score from that rival's picks — these tests call the
 * SAME function the screen calls. Re-implementing the sum here would only prove
 * that two copies of the test author's arithmetic agree, which is exactly the
 * blind spot that let the original defect ship.
 */

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/*
 * WHICH GAMEWEEK IS "NOW" IS THE DEMO'S TO SAY, NOT THIS FILE'S.
 *
 * This was `const CURRENT_GW = 20`, a second copy of a fact the demo already
 * states — and a copy is exactly the defect the rest of this file exists to
 * catch. A mutation run proved it: moving the demo's own `CURRENT_GW` to 19
 * left the suite green, because every assertion was being made against gameweek
 * 20 of a universe whose current gameweek was 19, and the live feed answered
 * for GW20 whatever was asked. The one thing the constant was there to pin down
 * was the one thing it could not see.
 *
 * So read it off `is_current`, the field the app itself reads, and assert
 * separately (below) that the flag agrees with the fixtures, the events and the
 * history rows.
 */
const CURRENT_GW = (() => {
  const events = makeDemoUniverse(NOW).bootstrap.events;
  const cur = events.filter((e) => e.is_current);
  if (cur.length !== 1) throw new Error(`demo names ${cur.length} current gameweeks`);
  return cur[0].id;
})();

interface Row {
  event: number;
  points: number;
  total_points: number;
  rank: number;
  overall_rank: number;
  bank: number;
  value: number;
  event_transfers: number;
  event_transfers_cost: number;
  points_on_bench: number;
}
interface Standing {
  entry: number;
  entry_name: string;
  rank: number;
  last_rank: number;
  total: number;
  event_total: number;
}
interface EntryPicks {
  active_chip: string | null;
  picks: Pick[];
  entry_history: Row;
}
interface DemoUniverse {
  bootstrap: Bootstrap & { total_players: number };
  fixtures: Fixture[];
  entry: {
    summary_event_points: number;
    summary_overall_points: number;
    summary_event_rank: number;
    summary_overall_rank: number;
    current_event: number;
    last_deadline_bank: number;
    last_deadline_value: number;
    leagues: {
      classic: { id: number; name: string; entry_rank: number; entry_last_rank: number }[];
    };
  };
  picks: EntryPicks;
  picksFor: (id: number, gw?: number) => EntryPicks;
  liveFor: (gw: number) => EventLive;
  leagueFor: (id: number) => { league: { id: number; name: string }; standings: { results: Standing[] } };
  elementHistory: (id: number) => {
    history: { round: number; minutes: number; total_points: number; goals_scored: number }[];
    history_past: {
      season_name: string;
      total_points: number;
      minutes: number;
      starts: number;
      expected_goals: string;
      expected_assists: string;
      expected_goal_involvements: string;
    }[];
  };
  history: {
    current: Row[];
    chips: { name: string; event: number }[];
    past: { season_name: string; total_points: number; rank: number }[];
  };
  transfers: Transfer[];
  live: EventLive;
  league: { standings: { results: Standing[] } };
}

function universe() {
  const u = makeDemoUniverse(NOW) as unknown as DemoUniverse;
  const rows = u.history.current;
  const byId = new Map<number, Element>(u.bootstrap.elements.map((e) => [e.id, e]));
  const livePoints = new Map(u.live.elements.map((e) => [e.id, e.stats.total_points]));
  const bonus = provisionalBonus(u.bootstrap, u.fixtures, u.live, CURRENT_GW);

  /**
   * What the app puts on screen for one manager's gameweek, computed through
   * the app's own helpers: the pitch corner and the Live tab header both take
   * the effective XI after projected auto-subs, apply the captain multiplier,
   * and subtract the hit; the Live tab additionally adds any bonus it thinks
   * FPL has not published yet.
   */
  const render = (p: EntryPicks) => {
    const bboost = p.active_chip === "bboost";
    const { effectiveXi } = projectAutoSubs(p.picks, byId, u.live, u.fixtures, CURRENT_GW);
    const playing = new Set(effectiveXi);
    let dashboard = 0;
    let liveTab = 0;
    let bench = 0;
    for (const pick of p.picks) {
      const raw = livePoints.get(pick.element) ?? 0;
      const proj = bonus.byElement.get(pick.element) ?? 0;
      const mult = pick.multiplier > 1 ? pick.multiplier : 1;
      if (bboost || playing.has(pick.element)) {
        dashboard += raw * mult;
        liveTab += (raw + proj) * mult;
      } else {
        bench += raw + proj;
      }
    }
    const hit = p.entry_history.event_transfers_cost;
    return {
      gross: dashboard,
      dashboardNet: dashboard - hit,
      liveTabNet: liveTab - hit,
      bench: bboost ? 0 : bench,
    };
  };

  /**
   * The same computation, for ANY gameweek, off that gameweek's own live feed.
   *
   * The Team tab's time machine re-renders a past week exactly like this. It
   * could not be tested before because the demo had only one live feed to
   * render against, which is precisely why it drew the GW20 pitch under a GW15
   * caption for nineteen weeks running. No provisional bonus here: a finished
   * week's bonus is published, and `provisionalBonus` correctly adds nothing.
   */
  const renderAt = (p: EntryPicks, gw: number) => {
    const live = u.liveFor(gw);
    const pts = new Map(live.elements.map((e) => [e.id, e.stats.total_points]));
    const bboost = p.active_chip === "bboost";
    const { effectiveXi } = projectAutoSubs(p.picks, byId, live, u.fixtures, gw);
    const playing = new Set(effectiveXi);
    let xi = 0;
    let bench = 0;
    for (const pick of p.picks) {
      const raw = pts.get(pick.element) ?? 0;
      const mult = pick.multiplier > 1 ? pick.multiplier : 1;
      if (bboost || playing.has(pick.element)) xi += raw * mult;
      else bench += raw;
    }
    return {
      gross: xi,
      net: xi - p.entry_history.event_transfers_cost,
      bench: bboost ? 0 : bench,
    };
  };

  return {
    ...u,
    rows,
    renderAt,
    current: rows[rows.length - 1],
    prev: rows[rows.length - 2],
    beforePrev: rows[rows.length - 3],
    livePoints,
    bonus,
    byId,
    render,
    avgOf: (gw: number) => u.bootstrap.events[gw - 1].average_entry_score,
    chipEvents: new Map(u.history.chips.map((c) => [c.event, c.name])),
  };
}

describe("the demo universe states each gameweek exactly once", () => {
  it("puts the same gameweek score in the entry summary, the history row and the picks", () => {
    const u = universe();
    // All three are GROSS in the real feed; the app is what takes the hit off.
    expect(u.entry.summary_event_points).toBe(u.current.points);
    expect(u.picks.entry_history).toEqual(u.current);
    expect(u.entry.current_event).toBe(u.current.event);
  });

  it("states the gameweek the dashboard and the Live tab actually draw", () => {
    const u = universe();
    const shown = u.render(u.picks);
    /*
     * The two screens disagreed by four points at one stage and by two at
     * another, for two different reasons, and both are guarded here.
     *
     * The dashboard's pitch corner counts the EFFECTIVE XI — a starter who
     * blanked in a finished fixture is replaced by a bench player — so a
     * history row that adds up the nominal eleven states a different number
     * from the one drawn over the pitch.
     *
     * The Live tab adds `provisionalBonus` on top of whatever the feed already
     * publishes. When the demo withheld bonus from the two in-play matches, the
     * Live tab projected its own and showed 53 for a gameweek the dashboard
     * called 51 — the reported defect, one tab over.
     */
    expect(shown.gross).toBe(u.current.points);
    expect(shown.dashboardNet).toBe(netGwPoints(u.current));
    expect(shown.liveTabNet).toBe(shown.dashboardNet);
    expect(shown.bench).toBe(u.current.points_on_bench);
    // Not vacuous: a squad that scored nothing would satisfy every line above.
    expect(shown.gross).toBeGreaterThan(20);
  });

  it("publishes bonus for the in-play matches, so nothing is projected twice", () => {
    const u = universe();
    /*
     * Since 2026/27 FPL publishes projected bonus itself once a fixture passes
     * twenty minutes, and `provisionalBonus` deliberately subtracts anything
     * already itemised in `explain` so it never double-counts. The demo's live
     * matches are at 58 minutes, so a correct feed leaves it with nothing to
     * add. An empty map here is the assertion; a non-empty one is the Live tab
     * and the dashboard drifting apart again.
     */
    expect(u.bonus.byElement.size).toBe(0);
    const withBonus = u.live.elements.filter((e) => e.stats.bonus > 0);
    expect(withBonus.length).toBeGreaterThan(0);
  });

  it("accumulates total_points as the running NET total, hits included", () => {
    const u = universe();
    let running = 0;
    for (const r of u.rows) {
      running += netGwPoints(r);
      expect({ event: r.event, total: r.total_points }).toEqual({
        event: r.event,
        total: running,
      });
    }
    expect(u.entry.summary_overall_points).toBe(running);
    // At least one row must actually carry a hit, or "hits included" is untested.
    expect(u.rows.some((r) => r.event_transfers_cost > 0)).toBe(true);
  });

  it("puts the headline score, the delta and the running total on the same gameweek", () => {
    const u = universe();
    /*
     * This is the exact trio the user was looking at when he asked whether
     * "-29" could be right beside "61 pts". Each is computed by a different
     * part of the dashboard from a different field, so they only agree if the
     * fixture states the gameweek once:
     *
     *   headline  — `summary_event_points`, net of this week's hit
     *   movement  — how far the cumulative NET total advanced
     *   delta     — this week's net minus last week's net (netGwDelta)
     *
     * The headline and the movement are the same quantity by definition. When
     * they disagreed, the demo was claiming a manager scored 61 in a week his
     * season total rose by 57.
     */
    const headline = u.entry.summary_event_points - u.current.event_transfers_cost;
    const movement = u.current.total_points - u.prev.total_points;
    expect(headline).toBe(netGwPoints(u.current));
    expect(movement).toBe(headline);
    /*
     * The delta, reached WITHOUT touching `points` at all — purely from how far
     * the running total moved this week against how far it moved last week.
     * Comparing `netGwDelta` to `netGwPoints(current) - netGwPoints(prev)` would
     * just be restating the helper's own definition back at it.
     */
    const movedLastWeek = u.prev.total_points - u.beforePrev.total_points;
    expect(netGwDelta(u.current, u.prev)).toBe(movement - movedLastWeek);
  });
});

describe("the demo universe reports each rank exactly once", () => {
  it("matches the entry summary ranks to the current history row", () => {
    const u = universe();
    expect(u.entry.summary_event_rank).toBe(u.current.rank);
    expect(u.entry.summary_overall_rank).toBe(u.current.overall_rank);
  });

  it("matches the Overall league to this week's and last week's overall rank", () => {
    const u = universe();
    const overall = u.entry.leagues.classic.find((l) => l.id === 314);
    expect(overall).toBeDefined();
    expect(overall!.entry_rank).toBe(u.current.overall_rank);
    expect(overall!.entry_last_rank).toBe(u.prev.overall_rank);
  });

  it("never states a rank at or beyond the edge of the playerbase", () => {
    const u = universe();
    const cap = u.bootstrap.total_players;
    /*
     * Two defects, one after the other. The unclamped curve returned 12.9
     * million for a below-average week — more managers than the game has. The
     * clamp that fixed it introduced a quieter one: everything past about −25
     * pinned at exactly the cap, so a −7 week and a −16 week ranked identically
     * and the movement arrows had nothing to point at. Hence the strict
     * inequality rather than `<=`.
     */
    for (const r of u.rows) {
      expect({ gw: r.event, ok: r.rank >= 1 && r.rank < cap }).toEqual({ gw: r.event, ok: true });
      expect({ gw: r.event, ok: r.overall_rank >= 1 && r.overall_rank < cap }).toEqual({
        gw: r.event,
        ok: true,
      });
    }
    expect(new Set(u.rows.map((r) => r.rank)).size).toBeGreaterThan(u.rows.length / 2);
  });

  it("orders every gameweek rank by how far the score beat the average", () => {
    const u = universe();
    /*
     * Pairwise over all twenty rows, not just the best and the worst: a curve
     * can get the extremes right and still be flat, backwards or step-shaped in
     * the middle, and the earlier best-vs-worst check passed happily while
     * three separate weeks shared one rank.
     */
    const byMargin = u.rows
      .map((r) => ({ gw: r.event, margin: netGwPoints(r) - u.avgOf(r.event), rank: r.rank }))
      .sort((a, b) => a.margin - b.margin);
    for (let i = 1; i < byMargin.length; i++) {
      const worse = byMargin[i - 1];
      const better = byMargin[i];
      expect({
        pair: `gw${worse.gw}(${worse.margin}) vs gw${better.gw}(${better.margin})`,
        ordered: better.margin > worse.margin ? better.rank < worse.rank : true,
      }).toEqual({
        pair: `gw${worse.gw}(${worse.margin}) vs gw${better.gw}(${better.margin})`,
        ordered: true,
      });
    }
    // The spread has to be worth something, or a constant rank would pass.
    expect(byMargin[0].rank / byMargin[byMargin.length - 1].rank).toBeGreaterThan(4);
  });

  it("moves the overall rank the wrong way after a below-average gameweek", () => {
    const u = universe();
    /*
     * The overall rank used to be `400_000 - gw * 8_000`: a straight line that
     * improved every single week regardless of what the manager scored,
     * including the weeks he took a hit and lost ground. GW20 is exactly such a
     * week, which is why the demo could show a red gameweek beside a green
     * season-rank arrow.
     */
    expect(netGwPoints(u.current)).toBeLessThan(u.avgOf(u.current.event));
    expect(u.current.overall_rank).toBeGreaterThan(u.prev.overall_rank);
    // And at least one week must go the other way, or "responds to the score"
    // would be satisfied by a line that only ever got worse.
    const improved = u.rows.slice(1).some((r, i) => r.overall_rank < u.rows[i].overall_rank);
    expect(improved).toBe(true);
  });
});

describe("the demo mini-league agrees with every dashboard it links to", () => {
  it("gives the demo entry its real season total and its real net gameweek", () => {
    const u = universe();
    const mine = u.league.standings.results.find((r) => r.entry === DEMO_ENTRY_ID);
    expect(mine).toBeDefined();
    expect(mine!.total).toBe(u.entry.summary_overall_points);
    // The league table is one of the few places FPL shows a NET score.
    expect(mine!.event_total).toBe(netGwPoints(u.current));
  });

  it("gives every rival a squad whose live score is the one the table stores", () => {
    const u = universe();
    /*
     * `MiniLeague` does not print `event_total` when it can do better: it
     * fetches each rival's picks and re-derives the score from the live feed.
     * The demo API served the demo manager's picks for every entry id, so all
     * ten rows resolved to HIS score — a table whose stored column disagreed
     * with the column drawn over it, in ten places at once.
     */
    const squads = new Set<string>();
    for (const r of u.league.standings.results) {
      const p = u.picksFor(r.entry);
      expect({ entry: r.entry, rendered: u.render(p).liveTabNet }).toEqual({
        entry: r.entry,
        rendered: r.event_total,
      });
      squads.add(
        p.picks
          .map((x) => x.element)
          .sort((a, b) => a - b)
          .join(","),
      );
    }
    // Ten different managers, ten different teams.
    expect(squads.size).toBe(u.league.standings.results.length);
  });

  it("orders the table so rank and total do not contradict each other", () => {
    const u = universe();
    const rows = [...u.league.standings.results].sort((a, b) => a.rank - b.rank);
    /*
     * Two claims, and the second is the one with teeth. Points never go up as
     * you read down the table; and a rank is EQUAL to the rank above it exactly
     * when the totals are equal, which is FPL's tie rule. Asserting only "each
     * total is strictly below the last" would forbid ties outright — and ties
     * happen, ten squads over twenty gameweeks produced one immediately — while
     * asserting only "non-increasing" would let every manager share rank 1.
     */
    for (let i = 1; i < rows.length; i++) {
      expect({
        i,
        dropped: rows[i].total <= rows[i - 1].total,
        sharesRank: rows[i].rank === rows[i - 1].rank,
      }).toEqual({ i, dropped: true, sharesRank: rows[i].total === rows[i - 1].total });
    }
    // …and the tie rule is the standard-competition one — 1, 2, 2, 4 — so a
    // manager who is not tied with the row above him takes his own position.
    expect(rows.map((r) => r.rank)).toEqual(
      rows.map((r, i) => (i > 0 && r.total === rows[i - 1].total ? null : i + 1)).reduce(
        (acc: number[], v, i) => [...acc, v ?? acc[i - 1]],
        []
      )
    );
  });

  it("derives last week's places from last week's totals", () => {
    const u = universe();
    /*
     * `last_rank` drives the ▲/▼ arrows. It used to be decorative arithmetic on
     * the row index, which could show a manager climbing in a week he was
     * overtaken. Ranking on `total - event_total` is the only definition that
     * makes the arrow mean anything.
     */
    const expected = [...u.league.standings.results]
      .sort((a, b) => b.total - b.event_total - (a.total - a.event_total))
      .map((r) => r.entry);
    for (const r of u.league.standings.results) {
      expect({ entry: r.entry, last: r.last_rank }).toEqual({
        entry: r.entry,
        last: expected.indexOf(r.entry) + 1,
      });
    }
    // Somebody has to have moved, or the arrows are never exercised.
    expect(u.league.standings.results.some((r) => r.rank !== r.last_rank)).toBe(true);
  });

  it("reports the manager's standing in his own league the same way twice", () => {
    const u = universe();
    const mine = u.league.standings.results.find((r) => r.entry === DEMO_ENTRY_ID)!;
    const summary = u.entry.leagues.classic.find((l) => l.id === 900001);
    expect(summary).toBeDefined();
    expect(summary!.entry_rank).toBe(mine.rank);
    expect(summary!.entry_last_rank).toBe(mine.last_rank);
  });
});

describe("the demo squad, ledger and team value are legal", () => {
  it("is a legal 2-5-5-3 with at most three players per club", () => {
    const u = universe();
    expect(u.picks.picks).toHaveLength(15);
    const counts = [0, 0, 0, 0];
    const perClub = new Map<number, number>();
    for (const p of u.picks.picks) {
      const el = u.byId.get(p.element);
      expect(el).toBeDefined();
      counts[el!.element_type - 1]++;
      perClub.set(el!.team, (perClub.get(el!.team) ?? 0) + 1);
    }
    expect(counts).toEqual([2, 5, 5, 3]);
    expect(Math.max(...perClub.values())).toBeLessThanOrEqual(3);
    expect(new Set(u.picks.picks.map((p) => p.element)).size).toBe(15);
  });

  it("starts eleven, benches four, and hands the armband to two different starters", () => {
    const u = universe();
    const xi = u.picks.picks.filter((p) => p.multiplier > 0);
    expect(xi).toHaveLength(11);
    expect(u.picks.picks.filter((p) => p.multiplier === 0).map((p) => p.position)).toEqual([
      12, 13, 14, 15,
    ]);
    const caps = u.picks.picks.filter((p) => p.is_captain);
    const vices = u.picks.picks.filter((p) => p.is_vice_captain);
    expect(caps).toHaveLength(1);
    expect(vices).toHaveLength(1);
    expect(caps[0].element).not.toBe(vices[0].element);
    expect(caps[0].multiplier).toBe(2);
    expect(caps[0].position).toBeLessThanOrEqual(11);
    expect(vices[0].position).toBeLessThanOrEqual(11);
    // The captain is an attacker. An unrestricted "highest points-per-game"
    // pick handed the armband to a full-back.
    expect(u.byId.get(caps[0].element)!.element_type).toBeGreaterThanOrEqual(3);
  });

  it("values the squad at SELLING prices, the way the dashboard does", () => {
    const u = universe();
    /*
     * FPL does not value a squad at `now_cost`. A player who has risen 0.4 is
     * worth 0.2 of that rise to his owner, and `buildSquadState` derives the
     * dashboard's "Team value" line accordingly. An earlier version of this
     * test asserted the `now_cost` sum and passed — enshrining a figure £0.8m
     * away from the one on screen.
     */
    const sell = u.picks.picks.reduce((s, p) => {
      const el = u.byId.get(p.element)!;
      return s + sellingPrice(purchasePriceFor(el, u.transfers, u.chipEvents), el.now_cost);
    }, 0);
    expect(u.current.value).toBe(sell + u.current.bank);
    expect(u.entry.last_deadline_value).toBe(u.current.value);
    expect(u.entry.last_deadline_bank).toBe(u.current.bank);
    // A rise somewhere, or the selling-price rule is untested by this fixture.
    expect(sell).not.toBe(u.picks.picks.reduce((s, p) => s + u.byId.get(p.element)!.now_cost, 0));
  });

  it("starts the season on the budget every manager starts on", () => {
    const u = universe();
    /*
     * £100.0m exactly in GW1, because that is what the game issues and
     * `entry_history.value` counts the bank inside it. This is the one figure
     * in the whole season that is not a matter of degree.
     */
    expect(u.rows[0].value).toBe(INITIAL_BUDGET);
    expect(u.rows[u.rows.length - 1].value).toBe(u.entry.last_deadline_value);

    /*
     * THIS USED TO ASSERT THAT TEAM VALUE NEVER FALLS, and it passed for the
     * worst possible reason: the value was interpolated toward a fixed
     * endpoint, so it could not fall, and the test was measuring the
     * interpolation rather than the squad. Team value in FPL falls all the
     * time — every owner of a player who drops 0.1 loses 0.1 — and a fixture
     * that cannot express that cannot exercise the red arrow the dashboard
     * draws for it.
     *
     * What is actually true, and what is asserted instead: a manager cannot
     * spend money he does not have, and a week's price movement across fifteen
     * players is small. A jump of more than £3.0m in one gameweek is not a
     * price movement, it is the walk having lost the thread.
     */
    for (let i = 0; i < u.rows.length; i++) {
      expect({ gw: u.rows[i].event, negative: u.rows[i].bank < 0 }).toEqual({
        gw: u.rows[i].event,
        negative: false,
      });
      if (i === 0) continue;
      const step = Math.abs(u.rows[i].value - u.rows[i - 1].value);
      expect({ gw: u.rows[i].event, wild: step > 30 }).toEqual({
        gw: u.rows[i].event,
        wild: false,
      });
    }

    // And it has to MOVE, in both directions, or the fixture is still the old
    // straight line under a new name.
    const steps = u.rows.slice(1).map((r, i) => r.value - u.rows[i].value);
    expect(steps.some((d) => d > 0)).toBe(true);
    expect(steps.some((d) => d < 0)).toBe(true);
  });

  it("keeps a transfer ledger that matches the history rows it is counted from", () => {
    const u = universe();
    const perEvent = new Map<number, number>();
    for (const t of u.transfers) perEvent.set(t.event, (perEvent.get(t.event) ?? 0) + 1);
    for (const r of u.rows) {
      expect({ gw: r.event, n: r.event_transfers }).toEqual({
        gw: r.event,
        n: perEvent.get(r.event) ?? 0,
      });
      expect({ gw: r.event, mod: r.event_transfers_cost % 4 }).toEqual({ gw: r.event, mod: 0 });
      // A hit cannot cost more than the transfers made could have earned.
      expect(r.event_transfers * 4).toBeGreaterThanOrEqual(r.event_transfers_cost);
    }
    expect(u.transfers.length).toBeGreaterThan(0);
    // The free-transfer count on the header is computed from these rows, and a
    // paid pair in the current gameweek leaves exactly one for the next.
    expect(computeFreeTransfers(u.rows, u.chipEvents)).toBe(1);
  });

  it("never buys or sells the same player twice, or sells one it still owns", () => {
    const u = universe();
    const owned = new Set(u.picks.picks.map((p) => p.element));
    const ins = u.transfers.map((t) => t.element_in);
    const outs = u.transfers.map((t) => t.element_out);
    expect(new Set(ins).size).toBe(ins.length);
    expect(new Set(outs).size).toBe(outs.length);
    for (const t of u.transfers) {
      // Everyone bought is still in the squad; nobody sold is.
      expect({ in: t.element_in, held: owned.has(t.element_in) }).toEqual({
        in: t.element_in,
        held: true,
      });
      expect({ out: t.element_out, held: owned.has(t.element_out) }).toEqual({
        out: t.element_out,
        held: false,
      });
      // Same position in as out, or the squad was illegal the moment it landed.
      expect(u.byId.get(t.element_in)!.element_type).toBe(u.byId.get(t.element_out)!.element_type);
      // Booked before the deadline of the gameweek it belongs to.
      const deadline = u.bootstrap.events[t.event - 1].deadline_time;
      expect({ event: t.event, before: t.time < deadline }).toEqual({
        event: t.event,
        before: true,
      });
    }
  });

  it("accounts for the chips it has played and the ones it still holds", () => {
    const u = universe();
    const used = u.history.chips.map((c) => c.name);
    expect(used.length).toBeGreaterThan(0);
    // Every chip played must sit inside a window the bootstrap actually offers.
    for (const c of u.history.chips) {
      const window = u.bootstrap.chips!.find(
        (w) => w.name === c.name && c.event >= w.start_event && c.event <= w.stop_event
      );
      expect({ chip: c.name, event: c.event, offered: window != null }).toEqual({
        chip: c.name,
        event: c.event,
        offered: true,
      });
    }
    const left = remainingChips(u.history.chips, u.bootstrap.chips, CURRENT_GW + 1, "season");
    expect(left.length).toBeGreaterThan(0);
    // A Bench Boost week has nothing left on the bench, by definition — the
    // bench played, so its score is inside `points`.
    for (const r of u.rows) {
      if (u.chipEvents.get(r.event) === "bboost") {
        expect({ gw: r.event, bench: r.points_on_bench }).toEqual({ gw: r.event, bench: 0 });
      }
    }
  });

  it("lists past seasons that are actually past", () => {
    const u = universe();
    /*
     * The list used to end at a hard-coded "2025/26" — a season this demo
     * claims to be twenty gameweeks into. A written-down season label is a fact
     * with an expiry date, and that one had passed it.
     */
    const thisSeason =
      new Date(NOW).getUTCMonth() >= 7
        ? new Date(NOW).getUTCFullYear()
        : new Date(NOW).getUTCFullYear() - 1;
    const years = u.history.past.map((p) => parseInt(p.season_name.slice(0, 4), 10));
    expect(years.length).toBeGreaterThan(0);
    for (const y of years) expect(y).toBeLessThan(thisSeason);
    expect([...years].sort((a, b) => a - b)).toEqual(years);
  });
});

describe("the demo live feed is self-consistent", () => {
  it("totals each player's points from that player's own breakdown", () => {
    const u = universe();
    for (const e of u.live.elements) {
      // `explain` is optional in the app's own type because the real feed omits
      // it for a player with no fixture. The demo never emits such a row, and a
      // silent `?? []` would turn that promise into an unnoticed 0 === 0.
      const explain = e.explain ?? [];
      expect({ id: e.id, breakdowns: explain.length }).toEqual({ id: e.id, breakdowns: 1 });
      const sum = explain.flatMap((x) => x.stats).reduce((s, st) => s + st.points, 0);
      expect({ id: e.id, total: e.stats.total_points }).toEqual({ id: e.id, total: sum });
    }
  });

  it("gives nothing at all to a player who did not appear", () => {
    const u = universe();
    const dnp = u.live.elements.filter((e) => e.stats.minutes === 0);
    // Without any DNPs the bench never matters and auto-substitution, which
    // this app implements, would have nothing in the demo to act on.
    expect(dnp.length).toBeGreaterThan(0);
    for (const e of dnp) {
      expect({ id: e.id, pts: e.stats.total_points }).toEqual({ id: e.id, pts: 0 });
    }
  });

  it("makes every scoreline the sum of the goals the feed records", () => {
    const u = universe();
    /*
     * The scorelines were `home % 3` against `away % 2`, invented with no
     * reference to the players, so the fixture list and the points breakdown
     * contradicted each other in nearly every match — and a 1-0 could award a
     * clean sheet to both sides at once.
     */
    const goalsFor = new Map<number, number>();
    for (const e of u.live.elements) {
      const team = u.byId.get(e.id)!.team;
      goalsFor.set(team, (goalsFor.get(team) ?? 0) + e.stats.goals_scored);
    }
    const gw = u.fixtures.filter((f) => f.event === CURRENT_GW);
    expect(gw.length).toBeGreaterThan(0);
    for (const f of gw) {
      expect({ id: f.id, h: f.team_h_score, a: f.team_a_score }).toEqual({
        id: f.id,
        h: goalsFor.get(f.team_h) ?? 0,
        a: goalsFor.get(f.team_a) ?? 0,
      });
    }
    // Clean sheets belong to the side that conceded nothing, and to one side of
    // a decided match only.
    for (const e of u.live.elements) {
      const cs = (e.explain ?? [])
        .flatMap((x) => x.stats)
        .some((s) => s.identifier === "clean_sheets");
      if (!cs) continue;
      const team = u.byId.get(e.id)!.team;
      const f = gw.find((x) => x.team_h === team || x.team_a === team)!;
      expect({ id: e.id, conceded: f.team_h === team ? f.team_a_score : f.team_h_score }).toEqual({
        id: e.id,
        conceded: 0,
      });
      expect(f.finished).toBe(true);
    }
  });

  it("puts the clock and the minutes played on the same match", () => {
    const u = universe();
    const inPlay = u.fixtures.filter((f) => f.event === CURRENT_GW && f.started && !f.finished);
    expect(inPlay.length).toBeGreaterThan(0);
    const teams = new Set(inPlay.flatMap((f) => [f.team_h, f.team_a]));
    const minutes = u.live.elements
      .filter((e) => teams.has(u.byId.get(e.id)!.team) && e.stats.minutes > 0)
      .map((e) => e.stats.minutes);
    expect(minutes.length).toBeGreaterThan(0);
    // `matchMinute` knocks 15 minutes off past the hour to allow for half time,
    // so the demo's kickoff has to be set from the minutes it credits, not the
    // other way round. It once read "HT~" while every card claimed 58 played.
    for (const f of inPlay) {
      expect({ id: f.id, clock: matchMinute(f, new Date(NOW)) }).toEqual({
        id: f.id,
        clock: `${Math.max(...minutes)}'`,
      });
    }
    // And the live matches must involve the demo manager, or the whole in-play
    // half of the app has nothing to render for the person looking at it.
    const mine = u.picks.picks.filter((p) => teams.has(u.byId.get(p.element)!.team));
    expect(mine.length).toBeGreaterThan(0);
  });

  it("keeps every stated score inside the week's stated highest score", () => {
    const u = universe();
    for (const r of u.rows) {
      const highest = u.bootstrap.events[r.event - 1].highest_score;
      expect({ gw: r.event, ok: highest != null && r.points <= highest }).toEqual({
        gw: r.event,
        ok: true,
      });
    }
    for (const s of u.league.standings.results) {
      expect(s.event_total).toBeLessThanOrEqual(
        u.bootstrap.events[CURRENT_GW - 1].highest_score ?? 0
      );
    }
  });
});

describe("the demo says the same thing about every gameweek, not just this one", () => {
  /*
   * ================== THE PROPERTY THE REPORTED BUG BROKE ==================
   *
   * A manager on the demo saw "Latest GW 61 pts" over a pitch reading 21. Both
   * numbers came out of correct app arithmetic; they disagreed because GW20 was
   * written down five times by hand and the copies had drifted.
   *
   * The fix was structural: every gameweek is now generated by one machine, and
   * every endpoint answers for the gameweek it was asked about. The tests below
   * are the ones that fix could not have passed before — nineteen weeks of the
   * same coherence the block above asserts for one.
   */
  it("draws every past gameweek's pitch as that gameweek's history row", () => {
    const u = universe();
    for (let gw = 1; gw <= CURRENT_GW; gw++) {
      const p = u.picksFor(DEMO_ENTRY_ID, gw);
      const row = u.rows[gw - 1];
      const shown = u.renderAt(p, gw);
      expect({ gw, gross: shown.gross, bench: shown.bench, chip: p.active_chip }).toEqual({
        gw,
        gross: row.points,
        bench: row.points_on_bench,
        chip: u.chipEvents.get(gw) ?? null,
      });
      expect({ gw, net: shown.net }).toEqual({ gw, net: netGwPoints(row) });
    }
  });

  it("hands back a different team and a different feed for a different week", () => {
    const u = universe();
    /*
     * Not vacuous. `picksFor` used to ignore its gameweek entirely and the live
     * route dropped the {gw} segment, so a loop like the one above would have
     * compared the SAME pitch against twenty different history rows — and would
     * have failed, which is how the defect was found. The danger now is the
     * mirror image: an accessor that quietly clamps everything to GW20 again
     * would sail through the loop the moment the history rows were derived from
     * it too. So state the difference outright.
     */
    const early = u.picksFor(DEMO_ENTRY_ID, 3);
    const now = u.picksFor(DEMO_ENTRY_ID, CURRENT_GW);
    const ids = (p: EntryPicks) => p.picks.map((x) => x.element).sort((a, b) => a - b).join(",");
    expect(ids(early)).not.toBe(ids(now));
    expect(early.entry_history.event).toBe(3);

    const feeds = new Set(
      Array.from({ length: CURRENT_GW }, (_, i) =>
        u
          .liveFor(i + 1)
          .elements.map((e) => `${e.id}:${e.stats.total_points}`)
          .join("|")
      )
    );
    expect(feeds.size).toBe(CURRENT_GW);
  });

  it("gives every player a season made of the weeks he actually played", () => {
    const u = universe();
    /*
     * `element-summary/{id}/` used to invent its rows from the element id, so
     * the recent-starts model — which decides who the optimizer will pick —
     * was reading a rotation pattern that contradicted the player's own minutes
     * and every live score he had. The rows now come off the same match feeds
     * that produced his bootstrap totals, so the two must reconcile.
     */
    const sampled = u.bootstrap.elements.filter((e) => e.id % 37 === 1);
    expect(sampled.length).toBeGreaterThan(5);
    for (const el of sampled) {
      const rows = u.elementHistory(el.id).history;
      /*
       * THROUGH the current gameweek, not up to it. The summary used to stop
       * at GW19, so `fetchRecentForm` — whose entire question is "has he
       * started RECENTLY" — could never see the most recent week the demo has.
       * Every GW20 fixture here has kicked off, and FPL publishes a round as
       * soon as it starts.
       */
      expect(rows.map((r) => r.round)).toEqual(
        Array.from({ length: CURRENT_GW }, (_, i) => i + 1)
      );
      const pts = rows.reduce((s, r) => s + r.total_points, 0);
      const mins = rows.reduce((s, r) => s + r.minutes, 0);
      expect({ id: el.id, pts, mins }).toEqual({
        id: el.id,
        pts: el.total_points,
        mins: el.minutes,
      });
      // The current week's row and the live feed are the same week, so they
      // have to agree — that is the join the season total is built on.
      const live = u.live.elements.find((e) => e.id === el.id);
      const last = rows[rows.length - 1];
      expect({ id: el.id, round: last.round, pts: last.total_points }).toEqual({
        id: el.id,
        round: CURRENT_GW,
        pts: live?.stats.total_points ?? 0,
      });
    }
  });

  it("gives every player the previous seasons the pre-season model runs on", () => {
    const u = universe();
    /*
     * `history_past` was absent from the demo entirely, so `fetchPastSeason`
     * returned an empty map for all 300 players and the `fromPast` branch of
     * `statLine` — the branch that decides who is nailed on before a ball is
     * kicked — was unreachable in demo mode. The pre-season pipeline the app
     * ships could not be demonstrated at all.
     */
    const sampled = u.bootstrap.elements.filter((e) => e.id % 41 === 3);
    expect(sampled.length).toBeGreaterThan(4);
    /*
     * This season's label, derived rather than written down. `history.past`
     * ends on the season BEFORE this one — that is what makes it past — so the
     * current label is the year after it. Reading the last entry as "now" is
     * the off-by-one this comment exists to stop being made again.
     */
    const lastPast = u.history.past[u.history.past.length - 1].season_name;
    const thisStart = parseInt(lastPast.slice(0, 4), 10) + 1;
    const thisSeason = `${thisStart}/${String((thisStart + 1) % 100).padStart(2, "0")}`;
    for (const el of sampled) {
      const past = u.elementHistory(el.id).history_past;
      expect({ id: el.id, n: past.length }).toEqual({ id: el.id, n: 2 });
      for (const s of past) {
        const label = `${el.id} ${s.season_name}`;
        // A past season is a PAST season: never this one, and in order.
        expect({ label, isThis: s.season_name === thisSeason }).toEqual({ label, isThis: false });
        // 38 games, not 20 — the scale is a full season, which is what makes
        // per-90 rates off it comparable with a real feed's.
        expect({ label, over: s.minutes > 38 * 90 }).toEqual({ label, over: false });
        // And the start count that `statLine` reads as "nailed on" cannot
        // exceed the games there were to start.
        expect({ label, over: s.starts > 38 }).toEqual({ label, over: false });
        expect({ label, neg: s.total_points < 0 || s.minutes < 0 }).toEqual({ label, neg: false });
        // xGI is the sum of its parts here too, to two decimals.
        const gi = parseFloat(s.expected_goals) + parseFloat(s.expected_assists);
        expect({ label, gi: Math.abs(gi - parseFloat(s.expected_goal_involvements)) < 0.02 }).toEqual(
          { label, gi: true }
        );
      }
      expect(past[0].season_name < past[1].season_name).toBe(true);
      // And it must not be a carbon copy of this season, or the shrinkage in
      // xp.ts is being handed the same evidence twice and told it is two
      // independent observations.
      expect({
        id: el.id,
        older: past[0].total_points < past[1].total_points || el.total_points === 0,
      }).toEqual({ id: el.id, older: true });
    }
  });

  it("names one current gameweek and means it", () => {
    const u = universe();
    /*
     * The flag is what the app reads to decide which week it is in, and this
     * file now reads it too. Everything else the demo says about "now" has to
     * line up behind it, or deriving `CURRENT_GW` from it just relocates the
     * problem.
     */
    const events = u.bootstrap.events;
    expect(events.filter((e) => e.is_current).map((e) => e.id)).toEqual([CURRENT_GW]);
    expect(events.filter((e) => e.is_next).map((e) => e.id)).toEqual([CURRENT_GW + 1]);
    expect(events.filter((e) => e.finished).map((e) => e.id)).toEqual(
      Array.from({ length: CURRENT_GW - 1 }, (_, i) => i + 1)
    );
    expect(u.rows.map((r) => r.event)).toEqual(
      Array.from({ length: CURRENT_GW }, (_, i) => i + 1)
    );
    // The week is genuinely in play: some of its matches are done, some are not.
    const gw = u.fixtures.filter((f) => f.event === CURRENT_GW);
    expect(gw.some((f) => f.finished)).toBe(true);
    expect(gw.some((f) => !f.finished && f.started)).toBe(true);
  });
});

describe("the demo gives the auto-sub projection something to do", () => {
  it("actually substitutes a blanking starter, in a match that has finished", () => {
    const u = universe();
    /*
     * THIS TEST EXISTS BECAUSE THE FLAGSHIP GUARD WAS VACUOUS WITHOUT IT.
     *
     * Every assertion that the pitch corner equals the history row is trivially
     * satisfied when no substitution happens: both sides then sum the same
     * eleven. A mutation run confirmed it — blanking a starter whose match was
     * still IN PLAY left the whole suite green, because `projectAutoSubs`
     * correctly refuses to substitute anyone who might still come on, so the
     * projection was empty and the guard was comparing a sum to itself.
     *
     * The demo therefore has to blank a starter whose fixture is OVER, and this
     * is the test that says so.
     */
    const sub = projectAutoSubs(u.picks.picks, u.byId, u.live, u.fixtures, CURRENT_GW);
    expect(sub.out.length).toBeGreaterThan(0);
    expect(sub.in.length).toBe(sub.out.length);
    expect(sub.effectiveXi.length).toBe(11);

    for (const id of sub.out) {
      const el = u.byId.get(id)!;
      const live = u.live.elements.find((e) => e.id === id);
      expect({ id, minutes: live?.stats.minutes ?? 0 }).toEqual({ id, minutes: 0 });
      // ...and every fixture his club had this week is finished, which is the
      // only condition under which FPL would process the substitution.
      const his = u.fixtures.filter(
        (f) => f.event === CURRENT_GW && (f.team_h === el.team || f.team_a === el.team)
      );
      expect(his.length).toBeGreaterThan(0);
      expect(his.every((f) => f.finished)).toBe(true);
    }
    // The man coming on was on the bench and did play.
    for (const id of sub.in) {
      const pick = u.picks.picks.find((p) => p.element === id)!;
      expect(pick.position).toBeGreaterThan(11);
      expect(u.live.elements.find((e) => e.id === id)!.stats.minutes).toBeGreaterThan(0);
    }
  });
});

describe("every squad in the demo league would be accepted by FPL", () => {
  it("gives each rival fifteen legal players in a legal shape", () => {
    const u = universe();
    /*
     * The rivals are not decoration: `MiniLeague` fetches each one's picks and
     * re-derives the score from them, and the optimizer's rank projections read
     * the same rows. A rival squad with four keepers or five Arsenal players is
     * a squad the real game would have refused, and any conclusion drawn from
     * it is drawn from a position that cannot exist.
     */
    let tightest = 0;
    for (const r of u.league.standings.results) {
      for (const gw of [1, Math.ceil(CURRENT_GW / 2), CURRENT_GW]) {
        const p = u.picksFor(r.entry, gw);
        const els = p.picks.map((x) => u.byId.get(x.element)!);
        const label = `entry ${r.entry} gw ${gw}`;
        expect({ label, n: new Set(p.picks.map((x) => x.element)).size }).toEqual({ label, n: 15 });
        const byType = (t: number) => els.filter((e) => e.element_type === t).length;
        expect({ label, shape: [byType(1), byType(2), byType(3), byType(4)] }).toEqual({
          label,
          shape: [2, 5, 5, 3],
        });
        const clubs = new Map<number, number>();
        for (const e of els) clubs.set(e.team, (clubs.get(e.team) ?? 0) + 1);
        const worst = Math.max(...clubs.values());
        expect({ label, legal: worst <= 3 }).toEqual({ label, legal: true });
        tightest = Math.max(tightest, worst);

        // Positions 1..15, a legal starting eleven, exactly one captain and one
        // vice, and both of them in the eleven that plays.
        expect(p.picks.map((x) => x.position)).toEqual(
          Array.from({ length: 15 }, (_, i) => i + 1)
        );
        const xi = p.picks.filter((x) => x.position <= 11).map((x) => u.byId.get(x.element)!);
        const xiType = (t: number) => xi.filter((e) => e.element_type === t).length;
        expect({ label, gk: xiType(1) }).toEqual({ label, gk: 1 });
        expect(xiType(2)).toBeGreaterThanOrEqual(3);
        expect(xiType(4)).toBeGreaterThanOrEqual(1);
        expect(xiType(2) + xiType(3) + xiType(4)).toBe(10);
        const caps = p.picks.filter((x) => x.is_captain);
        const vices = p.picks.filter((x) => x.is_vice_captain);
        expect({ label, caps: caps.length, vices: vices.length }).toEqual({
          label,
          caps: 1,
          vices: 1,
        });
        expect(caps[0].element).not.toBe(vices[0].element);
        expect({ label, capStarts: caps[0].position <= 11 }).toEqual({ label, capStarts: true });
      }
    }
    /*
     * A "≤ 3 per club" check passes trivially on squads that never go near the
     * limit, and the historical squads are built by a backward walk that has to
     * consult club counts to pick each replacement. If nothing anywhere reaches
     * three, that walk is not being exercised and the guard is decorative.
     */
    expect(tightest).toBe(3);
  });

  it("opens each of the manager's leagues onto a table he is actually in", () => {
    const u = universe();
    /*
     * One standings object answered for every league id, so clicking the public
     * "Overall" league opened the ten-manager demo table with the manager fifth
     * — against the 245,812nd place the card above it had just advertised.
     */
    expect(u.entry.leagues.classic.length).toBeGreaterThan(1);
    for (const l of u.entry.leagues.classic) {
      const table = u.leagueFor(l.id);
      expect({ id: l.id, served: table.league.id }).toEqual({ id: l.id, served: l.id });
      const mine = table.standings.results.find((r) => r.entry === DEMO_ENTRY_ID);
      expect(mine).toBeDefined();
      expect({ id: l.id, rank: mine!.rank }).toEqual({ id: l.id, rank: l.entry_rank });
      expect({ id: l.id, total: mine!.total }).toEqual({
        id: l.id,
        total: u.entry.summary_overall_points,
      });
      const ranks = table.standings.results.map((r) => r.rank);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }
  });
});

/*
 * ===========================================================================
 * THE SECOND PASS.
 *
 * Everything above was written to close the defect the user reported. Then two
 * adversarial agents went through the generator looking for the ones nobody had
 * reported yet, and a mutation run went through this file looking for tests
 * that could not fail. Both found plenty. What follows guards the repairs.
 * ===========================================================================
 */

/**
 * A live stat, or a loud failure. The fields below are optional on
 * `LiveElement` because a stub feed may omit them — but the demo is not
 * allowed to, so reading one through this helper turns "the demo stopped
 * sending clean sheets" into a failure instead of a silent zero that would
 * make every assertion downstream trivially true.
 */
const stat = (
  e: EventLive["elements"][number],
  k: "clean_sheets" | "goals_conceded" | "saves" | "yellow_cards"
) => {
  const v = e.stats[k];
  if (typeof v !== "number") throw new Error(`demo live feed omits ${k} for element ${e.id}`);
  return v;
};

describe("the demo says the same thing about a club twice", () => {
  it("does not rate the best clubs as the easiest opponents", () => {
    /*
     * THE INVERSION. `teams[].strength` said club 1 was a 5; fixture difficulty
     * said `ceil(id / 4)`, which makes club 1 a 2. Both are on the FPL 1-5
     * scale and both describe the same club, so one of them was the exact
     * reverse of the truth — and the one driving the expected-points model was
     * the wrong one. In demo mode the optimiser spent every projection
     * believing a trip to the league leaders was the kindest fixture available,
     * which is not a subtle error in a tool whose entire output is fixture-led.
     */
    const u = universe();
    const strength = new Map(u.bootstrap.teams.map((t) => [t.id, t.strength]));
    for (const f of u.fixtures) {
      expect({
        f: f.id,
        h: f.team_h_difficulty,
        a: f.team_a_difficulty,
      }).toEqual({ f: f.id, h: strength.get(f.team_a), a: strength.get(f.team_h) });
    }
    // …and the scale is actually used, rather than every club landing on one value.
    expect(new Set(u.fixtures.map((f) => f.team_h_difficulty)).size).toBeGreaterThan(2);
  });

  it("gives clubs a strength spread the expected-points model can use", () => {
    /*
     * `buildStrengths` in xp.ts only trusts the club ratings when their spread
     * clears 40; below that it falls back to fixture difficulty. The demo's
     * ratings were flat, so the fallback ran — and the fallback read the
     * inverted difficulty above. Two defects that only bit in combination.
     */
    const u = universe();
    const att = u.bootstrap.teams.map((t) => t.strength_attack_home);
    expect(Math.max(...att) - Math.min(...att)).toBeGreaterThan(40);
  });

  it("gives every club a fixture in every gameweek of the season", () => {
    const u = universe();
    const last = Math.max(...u.bootstrap.events.map((e) => e.id));
    expect(last).toBe(38);
    for (let gw = 1; gw <= last; gw++) {
      const clubs = u.fixtures
        .filter((f) => f.event === gw)
        .flatMap((f) => [f.team_h, f.team_a]);
      // A blank gameweek in the demo is a generator bug, not a scheduling
      // quirk: the fixture list used to stop five weeks out, so every club had
      // thirteen blanks and the planner's horizon projected zero across them.
      expect({ gw, clubs: new Set(clubs).size }).toEqual({ gw, clubs: 20 });
    }
  });

  it("puts the deadline before the first kick-off of its own gameweek", () => {
    const u = universe();
    for (const ev of u.bootstrap.events) {
      const kicks = u.fixtures
        .filter((f) => f.event === ev.id && f.kickoff_time)
        .map((f) => +new Date(f.kickoff_time!));
      if (!kicks.length) continue;
      const deadline = +new Date(ev.deadline_time);
      expect({ gw: ev.id, before: deadline < Math.min(...kicks) }).toEqual({
        gw: ev.id,
        before: true,
      });
    }
  });
});

describe("the demo scores a gameweek the way FPL scores one", () => {
  const scoringUniverse = () => {
    const u = universe();
    const byId = new Map(u.bootstrap.elements.map((e) => [e.id, e]));
    return { u, byId };
  };

  it("pays appearance points on the hour and not before", () => {
    const { u } = scoringUniverse();
    for (const e of u.liveFor(CURRENT_GW - 1).elements) {
      const mins = e.stats.minutes;
      const app = (e.explain ?? [])
        .flatMap((x) => x.stats)
        .find((s) => s.identifier === "minutes");
      expect({ id: e.id, mins, pts: app?.points ?? 0 }).toEqual({
        id: e.id,
        mins,
        pts: mins === 0 ? 0 : mins >= 60 ? 2 : 1,
      });
    }
  });

  it("pays a clean sheet only to the positions that earn one, and only over the hour", () => {
    const { u, byId } = scoringUniverse();
    const gw = CURRENT_GW - 1;
    for (const e of u.liveFor(gw).elements) {
      const el = byId.get(e.id)!;
      const cs = (e.explain ?? [])
        .flatMap((x) => x.stats)
        .find((s) => s.identifier === "clean_sheets");
      if (!cs) continue;
      // Forwards earn nothing for a clean sheet, so a row should never exist.
      expect({ id: e.id, type: el.element_type, pts: cs.points }).toEqual({
        id: e.id,
        type: el.element_type,
        pts: el.element_type <= 2 ? 4 : 1,
      });
      expect(e.stats.minutes).toBeGreaterThanOrEqual(60);
      expect(stat(e, "goals_conceded")).toBe(0);
    }
  });

  it("never credits a man with goals conceded in a match he did not play", () => {
    const u = universe();
    for (let gw = 1; gw <= CURRENT_GW; gw++) {
      for (const e of u.liveFor(gw).elements) {
        if (e.stats.minutes > 0) continue;
        expect({ gw, id: e.id, conceded: stat(e, "goals_conceded") }).toEqual({
          gw,
          id: e.id,
          conceded: 0,
        });
      }
    }
  });

  it("awards bonus in the order the BPS puts the players in", () => {
    /*
     * Not "at most six per match". FPL's tie rule really can hand out more than
     * 3+2+1 — two men level at the top both take three and the next takes one,
     * seven in all — and an earlier draft of this test asserted the six and
     * failed against a generator that was right. What IS invariant is the
     * ordering: nobody takes more than three; equal BPS in the same match means
     * equal bonus; and more BPS never earns less bonus. Those three together
     * are the rule, and they are what `(id * 13) % 45` violated when bonus and
     * BPS were generated independently of each other.
     */
    const u = universe();
    for (let gw = 1; gw <= CURRENT_GW; gw++) {
      const live = u.liveFor(gw);
      const byFixture = new Map<number, { bps: number; bonus: number }[]>();
      for (const e of live.elements) {
        for (const x of e.explain ?? []) {
          const b = x.stats.find((s) => s.identifier === "bonus");
          if (b) {
            expect(b.points).toBeLessThanOrEqual(3);
            expect(b.points).toBeGreaterThan(0);
          }
          const list = byFixture.get(x.fixture) ?? [];
          list.push({ bps: e.stats.bps, bonus: b?.points ?? 0 });
          byFixture.set(x.fixture, list);
        }
      }
      for (const [fixture, list] of byFixture) {
        for (const a of list) {
          for (const b of list) {
            const consistent = a.bps === b.bps ? a.bonus === b.bonus : a.bps > b.bps ? a.bonus >= b.bonus : true;
            expect({ gw, fixture, consistent }).toEqual({ gw, fixture, consistent: true });
          }
        }
      }
    }
  });

  it("hands the bonus to the players who topped the BPS", () => {
    const u = universe();
    const gw = CURRENT_GW - 1;
    const live = u.liveFor(gw);
    const bpsOf = new Map(live.elements.map((e) => [e.id, e.stats.bps]));
    const byFixture = new Map<number, { id: number; bonus: number }[]>();
    for (const e of live.elements) {
      for (const x of e.explain ?? []) {
        const b = x.stats.find((s) => s.identifier === "bonus");
        const list = byFixture.get(x.fixture) ?? [];
        list.push({ id: e.id, bonus: b?.points ?? 0 });
        byFixture.set(x.fixture, list);
      }
    }
    for (const [fixture, list] of byFixture) {
      const best = Math.max(...list.map((p) => bpsOf.get(p.id) ?? 0));
      const topScorer = list.filter((p) => (bpsOf.get(p.id) ?? 0) === best);
      // Whoever leads the BPS in a match takes three bonus. If bonus and BPS
      // were generated independently — and they were, `(id * 13) % 45` — a man
      // on 11 BPS could take two off a man on 42, and the match modal said so.
      expect({ fixture, top: topScorer.every((p) => p.bonus === 3) }).toEqual({
        fixture,
        top: true,
      });
    }
  });

  it("books players, and charges them for it", () => {
    const u = universe();
    let booked = 0;
    for (let gw = 1; gw <= CURRENT_GW; gw++) {
      for (const e of u.liveFor(gw).elements) {
        const card = (e.explain ?? [])
          .flatMap((x) => x.stats)
          .find((s) => s.identifier === "yellow_cards");
        if (!card) {
          expect(stat(e, "yellow_cards")).toBe(0);
          continue;
        }
        booked++;
        expect({ id: e.id, value: card.value, points: card.points }).toEqual({
          id: e.id,
          value: 1,
          points: -1,
        });
        expect(e.stats.minutes).toBeGreaterThan(0);
      }
    }
    // The app models suspension risk off yellow cards. With none in the whole
    // demo season the feature had nothing to work on and could not be seen.
    expect(booked).toBeGreaterThan(50);
  });

  it("adds a player's live stats up to the points it says he scored", () => {
    const u = universe();
    for (let gw = 1; gw <= CURRENT_GW; gw++) {
      for (const e of u.liveFor(gw).elements) {
        const summed = (e.explain ?? [])
          .flatMap((x) => x.stats)
          .reduce((s, x) => s + x.points, 0);
        expect({ gw, id: e.id, total: e.stats.total_points }).toEqual({
          gw,
          id: e.id,
          total: summed,
        });
      }
    }
  });

  it("carries the whole live stat block, not the handful the header happens to read", () => {
    const u = universe();
    for (const e of u.liveFor(CURRENT_GW).elements) {
      // `PlayerModal` and `StatsTable` read these for the current gameweek. A
      // keeper who had just kept a clean sheet and made six saves rendered as a
      // blank row while the breakdown beside it itemised both.
      for (const k of ["clean_sheets", "goals_conceded", "saves", "yellow_cards"] as const) {
        expect({ id: e.id, k, has: typeof e.stats[k] }).toEqual({ id: e.id, k, has: "number" });
      }
    }
  });
});

describe("the demo bootstrap is a bootstrap the app can read", () => {
  it("shares out fifteen squad places and no more", () => {
    const u = universe();
    const total = u.bootstrap.elements.reduce(
      (s, e) => s + parseFloat(e.selected_by_percent),
      0
    );
    /*
     * Every manager owns fifteen players, so ownership across the whole
     * playerbase sums to 1500% — that is arithmetic, not a convention. The
     * demo's raw curve summed to about 6,100%: four squads each. The app
     * classifies a pick as template or differential by comparing against that
     * total, so in demo mode almost nothing could read as a differential.
     */
    expect(Math.abs(total - 1500)).toBeLessThan(25);
    expect(Math.min(...u.bootstrap.elements.map((e) => parseFloat(e.selected_by_percent)))).toBeGreaterThan(0);
  });

  it("gives someone at each club the set pieces", () => {
    const u = universe();
    for (const t of u.bootstrap.teams) {
      const squad = u.bootstrap.elements.filter((e) => e.team === t.id);
      for (const k of [
        "penalties_order",
        "direct_freekicks_order",
        "corners_and_indirect_freekicks_order",
      ] as const) {
        const first = squad.filter((e) => e[k] === 1);
        // Exactly one man on each duty per club. Nobody had any, so the "on
        // penalties" badge was unreachable and the xP model's set-piece term
        // was multiplied by nothing all the way through demo mode.
        expect({ team: t.id, k, count: first.length }).toEqual({ team: t.id, k, count: 1 });
      }
    }
  });

  it("has a transfer market with a direction", () => {
    const u = universe();
    const net = u.bootstrap.elements.map((e) => {
      if (e.transfers_in_event == null || e.transfers_out_event == null) {
        throw new Error(`demo element ${e.id} has no transfer flow`);
      }
      return e.transfers_in_event - e.transfers_out_event;
    });
    expect(net.some((n) => n > 0)).toBe(true);
    expect(net.some((n) => n < 0)).toBe(true);
    // The price-change predictor reads these two fields and nothing else. With
    // both absent every player sat at exactly net zero and the panel drew rows
    // of blanks.
    expect(new Set(net).size).toBeGreaterThan(u.bootstrap.elements.length / 2);
  });

  it("counts a season's saves and cards back onto the player who made them", () => {
    const u = universe();
    const totals = new Map<number, { saves: number; cards: number }>();
    for (let gw = 1; gw <= CURRENT_GW; gw++) {
      for (const e of u.liveFor(gw).elements) {
        const t = totals.get(e.id) ?? { saves: 0, cards: 0 };
        t.saves += stat(e, "saves");
        t.cards += stat(e, "yellow_cards");
        totals.set(e.id, t);
      }
    }
    for (const e of u.bootstrap.elements) {
      const t = totals.get(e.id)!;
      expect({ id: e.id, saves: e.saves, cards: e.yellow_cards }).toEqual({
        id: e.id,
        saves: t.saves,
        cards: t.cards,
      });
    }
  });
});

describe("the demo charges for transfers the way the rules charge for them", () => {
  it("derives every hit from the free transfers the manager actually had", () => {
    /*
     * The costs used to be written down beside the counts, and one of them was
     * impossible: a −4 in a week the manager had five free transfers banked.
     * Rebuilding the bank here with the app's own `computeFreeTransfers` — fed
     * the rows up to but not including the week being checked, which is exactly
     * what it sees in production — proves the two rules agree.
     */
    const u = universe();
    const chipEvents = new Map(u.history.chips.map((c) => [c.event, c.name]));
    for (const row of u.rows) {
      if (row.event === 1) continue;
      const ft = computeFreeTransfers(u.rows.slice(0, row.event - 1), chipEvents);
      const chip = chipEvents.get(row.event);
      const expected =
        chip === "wildcard" || chip === "freehit"
          ? 0
          : Math.max(0, row.event_transfers - ft) * 4;
      expect({ gw: row.event, cost: row.event_transfers_cost }).toEqual({
        gw: row.event,
        cost: expected,
      });
    }
  });

  it("actually charges for one, somewhere in the season", () => {
    // Otherwise the whole gross-versus-net distinction — the thing the reported
    // defect turned on — is never exercised by the demo at all.
    const u = universe();
    expect(u.rows.filter((r) => r.event_transfers_cost > 0).length).toBeGreaterThan(0);
  });

  it("books one ledger record for every transfer it claims to have made", () => {
    const u = universe();
    for (const row of u.rows) {
      const booked = u.transfers.filter((t) => t.event === row.event).length;
      expect({ gw: row.event, booked }).toEqual({ gw: row.event, booked: row.event_transfers });
    }
  });
});

describe("the demo's Bench Boost boosts the bench", () => {
  const boostWeek = () => {
    const u = universe();
    const chip = u.history.chips.find((c) => c.name === "bboost");
    if (!chip) throw new Error("the demo no longer plays a Bench Boost");
    return { u, gw: chip.event };
  };

  it("returns a live multiplier on the bench, the way FPL does", () => {
    /*
     * THE REPORTED SYMPTOM, IN MINIATURE. FPL sends `multiplier: 1` for
     * positions 12-15 on a boosted week. The demo sent 0 while separately
     * crediting the bench in the history row — so every screen that sums
     * `points × multiplier` (the pitch corner, the Live tab, the mini-league's
     * rival re-derivation) came out below the row printed beside it, and the
     * gameweek delta went negative for no reason anyone could see.
     */
    const { u, gw } = boostWeek();
    const p = u.picksFor(DEMO_ENTRY_ID, gw);
    expect(p.active_chip).toBe("bboost");
    expect(p.picks.slice(11).map((x) => x.multiplier)).toEqual([1, 1, 1, 1]);
  });

  it("leaves nothing on the bench in the week it is played", () => {
    const { u, gw } = boostWeek();
    const p = u.picksFor(DEMO_ENTRY_ID, gw);
    expect(p.entry_history.points_on_bench).toBe(0);
    // And the pitch adds up to the row, which is the property the whole file exists for.
    expect(u.renderAt(p, gw).gross).toBe(p.entry_history.points);
  });

  it("keeps the bench off the scoresheet in every other week", () => {
    const { u, gw } = boostWeek();
    const other = gw === CURRENT_GW ? gw - 1 : CURRENT_GW;
    expect(u.picksFor(DEMO_ENTRY_ID, other).picks.slice(11).map((x) => x.multiplier)).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

describe("the demo does not answer for managers it does not have", () => {
  it("refuses an entry id that is not in this universe", () => {
    /*
     * The fallback used to be "anyone I don't recognise gets the demo
     * manager's own squad". That never errors, so nothing ever surfaced — and
     * `LiveTab` takes the MEDIAN of the league's live scores to tell the
     * manager whether he is ahead of the field. With every unknown entry
     * resolving to him, that median WAS his own score, so the panel could only
     * ever say he was exactly average.
     */
    const u = universe() as unknown as { picksFor: (id: number, gw?: number) => unknown };
    expect(u.picksFor(4_242_424, CURRENT_GW)).toBeNull();
  });

  it("fills a public league with managers whose teams can be opened", () => {
    const u = universe();
    const overall = u.entry.leagues.classic.find((l) => l.id === 314)!;
    const table = u.leagueFor(overall.id);
    for (const row of table.standings.results) {
      // Rows used to be invented as `2_000_000 + rank` — entry ids `picksFor`
      // had never heard of — so clicking a neighbour fetched a team that did
      // not exist.
      expect({ entry: row.entry, opens: u.picksFor(row.entry, CURRENT_GW) !== null }).toEqual({
        entry: row.entry,
        opens: true,
      });
    }
  });

  it("orders a public league by its own totals", () => {
    const u = universe();
    for (const l of u.entry.leagues.classic) {
      const rows = [...u.leagueFor(l.id).standings.results].sort((a, b) => a.rank - b.rank);
      for (let i = 1; i < rows.length; i++) {
        expect({ id: l.id, i, ok: rows[i].total <= rows[i - 1].total }).toEqual({
          id: l.id,
          i,
          ok: true,
        });
      }
    }
  });
});

describe("the mini-league's two ranks answer two different questions", () => {
  it("does not restate a rival's gameweek rank as his overall rank", () => {
    /*
     * These were byte-identical expressions, so a rival who had a good week
     * after a bad season jumped to the same overall rank as his gameweek rank,
     * and the "overall" column was really nineteen gameweeks of noise.
     */
    const u = universe() as unknown as {
      picksFor: (id: number, gw?: number) => EntryPicks | null;
      league: { standings: { results: Standing[] } };
    };
    const rivals = u.league.standings.results.filter((r) => r.entry !== DEMO_ENTRY_ID);
    let differ = 0;
    for (const r of rivals) {
      const row = u.picksFor(r.entry, CURRENT_GW)!.entry_history as Row;
      if (row.rank !== row.overall_rank) differ++;
    }
    expect({ rivals: rivals.length, differ }).toEqual({
      rivals: rivals.length,
      differ: rivals.length,
    });
  });
});

describe("every price and every name in the demo is one FPL could have issued", () => {
  it("gives no two players the same name", () => {
    const u = universe();
    /*
     * `web_name` was built as `TEAM_NAMES[team - 1].slice(0, 3)`, and Manchester
     * City and Manchester United both slice to "Man" — so two different players
     * were both called "Man. Back 1", and both clubs answered to "MAN".
     *
     * That is not a cosmetic collision. The player search, the squad list, the
     * transfer planner and every comparison table identify a man to the reader
     * by this string and nothing else, so a ledger entry selling one and buying
     * the other read as selling and buying the SAME PLAYER in the same
     * gameweek — an apparently nonsensical transfer that the app was reporting
     * perfectly faithfully.
     */
    const names = u.bootstrap.elements.map((e) => e.web_name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
    const shorts = u.bootstrap.teams.map((t) => t.short_name);
    expect(new Set(shorts).size).toBe(shorts.length);
    for (const t of u.bootstrap.teams) {
      expect({ id: t.id, len: t.short_name.length }).toEqual({ id: t.id, len: 3 });
    }
  });

  it("prices every player inside the range the game issues prices in", () => {
    const u = universe();
    /*
     * FPL's cheapest player is £3.9m and its dearest is around £15.0m, and the
     * demo used to issue midfielders at £0.8m. Anything that DIVIDES BY PRICE —
     * the optimizer's points-per-million, the value table, the "best value in
     * the game" list — treats a sub-floor price as free points, so the app's
     * value ranking was a ranking of the generator's worst players.
     *
     * The start price matters as much as the current one: `purchasePriceFor`
     * falls back to `now_cost - cost_change_start` for a player the manager has
     * always owned, so an impossible start price becomes an impossible purchase
     * price and then an impossible selling price.
     */
    for (const e of u.bootstrap.elements) {
      const start = e.now_cost - e.cost_change_start;
      const label = `${e.web_name} (${e.id})`;
      expect({ label, ok: e.now_cost >= 38 && e.now_cost <= 150 }).toEqual({ label, ok: true });
      expect({ label, ok: start >= 38 && start <= 150 }).toEqual({ label, ok: true });
    }
    // And the range has to be USED, or the shape is a constant wearing a bound.
    const costs = u.bootstrap.elements.map((e) => e.now_cost);
    expect(Math.max(...costs) - Math.min(...costs)).toBeGreaterThan(50);
    const moves = u.bootstrap.elements.map((e) => e.cost_change_start);
    expect(moves.some((m) => m > 0)).toBe(true);
    expect(moves.some((m) => m < 0)).toBe(true);
  });

  it("gives every manager in the demo a squad he could have paid for", () => {
    const u = universe();
    /*
     * The budget used to bind the demo manager ALONE. The rivals and the field
     * were built by taking the best man at each club with no budget at all, so
     * they fielded roughly £115m of talent while he played by the rules — and
     * every rank on the front page was a measurement of that asymmetry rather
     * than of anything he did. One budget, applied to everyone.
     */
    for (const r of u.league.standings.results) {
      const p = u.picksFor(r.entry, CURRENT_GW);
      const spend = p.picks.reduce((s, x) => s + u.byId.get(x.element)!.now_cost, 0);
      expect({ entry: r.entry, over: spend > INITIAL_BUDGET }).toEqual({
        entry: r.entry,
        over: false,
      });
    }
    /*
     * And the manager's own fifteen must not be WELL under it either. The
     * repair loop's first version took the best points-per-tenth downgrade on
     * every pass including the last, so it would give up £2.0m of striker to
     * close a £0.3m gap and leave the change sitting in an unspendable bank: a
     * £98.5m squad that came out at £95.2m. Money left on the table is quality
     * left on the bench.
     */
    const mine = u.picks.picks.reduce((s, x) => s + u.byId.get(x.element)!.now_cost, 0);
    expect(mine).toBeGreaterThan(INITIAL_BUDGET - 30);
  });
});

describe("the demo measures the manager against a field that plays the same game", () => {
  it("derives the field's average from squads rather than from the gameweek number", () => {
    const u = universe();
    /*
     * `average_entry_score` was `42 + ((gw * 13) % 25)`: a sawtooth with no
     * relationship to the players this universe says were on the pitch. It is
     * load-bearing for four separate things — every gameweek rank, every
     * overall rank, the dashboard's "vs average" line and the season planner's
     * field comparison — and none of them checked it.
     *
     * The tell that it was authored rather than derived is that it depends on
     * the gameweek NUMBER. A derived average moves with the fixtures; an
     * authored one repeats on a cycle. So: assert it is not that formula, and
     * assert it behaves like a measurement.
     */
    const played = u.bootstrap.events.filter((e) => e.id <= CURRENT_GW);
    for (const ev of played) {
      const label = `gw ${ev.id}`;
      expect({ label, formula: ev.average_entry_score === 42 + ((ev.id * 13) % 25) }).toEqual({
        label,
        formula: false,
      });
      expect({ label, sane: ev.average_entry_score > 10 && ev.average_entry_score < 90 }).toEqual({
        label,
        sane: true,
      });
    }
    // A week nobody has played has no average. FPL reports 0 until it kicks off.
    for (const ev of u.bootstrap.events.filter((e) => e.id > CURRENT_GW)) {
      expect({ gw: ev.id, avg: ev.average_entry_score }).toEqual({ gw: ev.id, avg: 0 });
    }
    // It has to vary, and not on a period the gameweek number could supply.
    const vals = played.map((e) => e.average_entry_score);
    expect(new Set(vals).size).toBeGreaterThan(4);
  });

  it("puts the demo manager where the demo says it puts him", () => {
    const u = universe();
    /*
     * The front page opens on a rank. With an invented average of ~53.5 a week
     * against a squad that scores ~47, the demo manager finished twenty
     * gameweeks 10,624,861st of 11,000,000 — the bottom three per cent — while
     * the pitch above the number showed a squad any reader can see is a good
     * one. The rank was not wrong about the manager. It was wrong about the
     * field.
     *
     * A greedy-optimal budget-legal fifteen, playing against sampled managers
     * who reach two or three men down each club's list, should finish well
     * ahead of them. That is the claim the whole demo rests on, so it is
     * asserted rather than assumed.
     */
    const field = u.bootstrap.events
      .filter((e) => e.id <= CURRENT_GW)
      .reduce((s, e) => s + e.average_entry_score, 0);
    const mine = u.history.current[CURRENT_GW - 1].total_points;
    expect(mine).toBeGreaterThan(field);
    // Top decile, but not first in the world: a demo that opens on rank 1 is
    // advertising a bug, not a good season.
    const rank = u.history.current[CURRENT_GW - 1].overall_rank;
    expect(rank).toBeGreaterThan(1_000);
    expect(rank).toBeLessThan(u.bootstrap.total_players / 10);
  });
});

describe("the demo's underlying numbers describe the player, not his club", () => {
  /*
   * xG, xA, xGI, xGC, ICT and ownership were all written at generation time as
   * functions of `q` — the CLUB's quality rating — and of nothing else. So a
   * club's reserve keeper published the same 11.5% ownership, the same ICT and
   * the same xG as its 163-point striker, and every consumer that reads them
   * turned into a club ranking: `statLine` feeds xG/xA/ICT straight into the
   * expected-points model, `StatsTable` sorts on xGI, and the
   * differential/template split is a comparison against the ownership total.
   *
   * These tests pin the two things that were wrong: that the numbers VARY
   * WITHIN a club, and that they land on the SCALE the model was tuned for.
   */
  const u = makeDemoUniverse(NOW) as unknown as DemoUniverse;
  const els = u.bootstrap.elements;
  const num = (v: string | undefined) => parseFloat(v ?? "0");

  it("varies every derived stat inside a single club", () => {
    // Take a club with a full complement and check its men are not clones.
    const byClub = new Map<number, typeof els>();
    for (const e of els) byClub.set(e.team, [...(byClub.get(e.team) ?? []), e]);
    let checked = 0;
    for (const [team, squad] of byClub) {
      if (squad.length < 10) continue;
      checked++;
      for (const field of [
        "expected_goals",
        "expected_assists",
        "expected_goal_involvements",
        "ict_index",
      ] as const) {
        const distinct = new Set(squad.map((e) => e[field]));
        /*
         * Not "more than one" — a club whose fifteen publish three values is
         * still a club ranking with rounding on top. Half the squad is the
         * bar: the bug being guarded published ONE value per club, and the
         * measured floor across all twenty clubs is nine of fifteen, so this
         * has real headroom without licensing a regression toward the club.
         * It is not "every man distinct", because ties at 0.00 among the men
         * who have not played are correct and a real feed has them too.
         */
        expect({ team, field, distinct: distinct.size * 2 >= squad.length }).toEqual({
          team,
          field,
          distinct: true,
        });
      }
      /*
       * Ownership is asserted differently and deliberately. FPL publishes it
       * to one decimal and a real bootstrap has dozens of players sitting on
       * the same 0.1%, so counting distinct values would fail on a demo that
       * is behaving correctly. What must hold is the ORDERING: inside one
       * club, the man who has scored the points is the man who is owned.
       */
      const ranked = [...squad].sort((a, b) => b.total_points - a.total_points);
      const best = num(ranked[0].selected_by_percent);
      const worst = num(ranked[ranked.length - 1].selected_by_percent);
      expect({ team, ordered: best > worst }).toEqual({ team, ordered: true });
    }
    expect(checked).toBeGreaterThan(15);
  });

  it("puts ICT on the scale the bonus model divides by", () => {
    /*
     * `statLine` computes ict90 and `expectedPoints` multiplies it by
     * `bonusPerIct90` to get an expected bonus per start, so the SCALE of this
     * index is a scale on bonus points. Real ICT runs to about 13 per 90 for
     * the best attacker in the league. A draft that ran to 38 per 90 asked the
     * model for 1.7 bonus a start and pinned everyone good against `bonusCap`.
     */
    const played = els.filter((e) => e.minutes > 400);
    expect(played.length).toBeGreaterThan(50);
    const per90 = played.map((e) => (num(e.ict_index) * 90) / e.minutes);
    expect(Math.max(...per90)).toBeLessThan(20);
    expect(Math.max(...per90)).toBeGreaterThan(8);
    expect(Math.min(...per90)).toBeGreaterThan(0);
    // A man who has not played has an index near zero rather than his club's.
    for (const e of els.filter((x) => x.minutes === 0)) {
      expect({ id: e.id, ict: num(e.ict_index) }).toEqual({ id: e.id, ict: 0 });
    }
  });

  it("keeps ownership adding up to fifteen picks a manager", () => {
    const own = els.map((e) => num(e.selected_by_percent));
    const sum = own.reduce((s, v) => s + v, 0);
    // Every manager picks fifteen, so the playerbase sums to 1500% and no
    // more. The raw curve summed to ~6,100% — four squads each — and the
    // differential badge is a comparison against that total, so in demo mode
    // almost nothing ever read as a differential.
    expect(Math.abs(sum - 1500)).toBeLessThan(25);
    const sorted = [...own].sort((a, b) => b - a);
    // Top-heavy the way FPL is: a premium above 35%, and a long tail.
    expect(sorted[0]).toBeGreaterThan(35);
    expect(sorted[0]).toBeLessThan(75);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThan(6);
    // And ownership follows points, not the club badge.
    const top = [...els].sort((a, b) => b.total_points - a.total_points)[0];
    expect(num(top.selected_by_percent)).toBeGreaterThan(sorted[20]);
  });

  it("makes the expected numbers agree with the actual ones", () => {
    for (const e of els) {
      const gi = num(e.expected_goals) + num(e.expected_assists);
      expect({ id: e.id, gi: Math.abs(gi - num(e.expected_goal_involvements)) < 0.02 }).toEqual({
        id: e.id,
        gi: true,
      });
      // Nobody is expected to have done anything in minutes he did not play.
      if (e.minutes === 0) {
        expect({ id: e.id, xgi: num(e.expected_goal_involvements) }).toEqual({ id: e.id, xgi: 0 });
      }
    }
    // Across the league, expected goals track scored goals: a demo whose xG
    // says half as many goals as the scoreboard makes every value judgement
    // the model draws off xG a systematic one.
    const xg = els.reduce((s, e) => s + num(e.expected_goals), 0);
    const goals = els.reduce((s, e) => s + e.goals_scored, 0);
    expect(goals).toBeGreaterThan(200);
    expect(Math.abs(xg - goals) / goals).toBeLessThan(0.25);
  });
});

describe("the demo answers about the manager who was asked about", () => {
  const u = makeDemoUniverse(NOW) as unknown as DemoUniverse & {
    historyFor: (id: number) => {
      current: {
        event: number;
        total_points: number;
        value: number;
        bank: number;
        active_chip: string | null;
      }[];
      chips: { name: string; event: number }[];
    } | null;
  };

  it("gives every rival his own season rather than the reader's", () => {
    /*
     * `entry/{id}/history/` threw the id away. Nine rivals therefore shared one
     * history — the demo manager's points, his ranks, his chips — which is the
     * same defect `picksFor` was written to fix one endpoint over, and it makes
     * the mini-league a mirror rather than a league.
     */
    const rivals = u.leagueFor(900001).standings.results.filter((r) => r.entry !== DEMO_ENTRY_ID);
    expect(rivals.length).toBeGreaterThan(5);
    const mine = u.historyFor(DEMO_ENTRY_ID)!;
    const totals = new Set<number>();
    for (const r of rivals) {
      const h = u.historyFor(r.entry);
      expect({ entry: r.entry, got: h != null }).toEqual({ entry: r.entry, got: true });
      const last = h!.current[h!.current.length - 1];
      expect({ entry: r.entry, n: h!.current.length }).toEqual({ entry: r.entry, n: CURRENT_GW });
      // His own total, and the one the standings table publishes for him.
      expect({ entry: r.entry, total: last.total_points }).toEqual({
        entry: r.entry,
        total: r.total,
      });
      expect(last.total_points).not.toBe(mine.current[mine.current.length - 1].total_points);
      totals.add(last.total_points);
      // His own chips, read off his own season.
      const used = h!.current.filter((c) => c.active_chip).map((c) => c.active_chip);
      expect(h!.chips.map((c) => c.name)).toEqual(used);
    }
    expect(totals.size).toBe(rivals.length);
  });

  it("does not invent a season for a manager it has never heard of", () => {
    expect(u.historyFor(1)).toBeNull();
    expect(u.historyFor(424242)).toBeNull();
  });

  it("gives every rival a bank and a team value that move", () => {
    /*
     * Every rival's every gameweek reported `bank: 5, value: 1000` — two
     * constants, nine managers, twenty weeks — so the mini-league's team-value
     * column was a column of £100.0m and nobody's squad ever appreciated.
     */
    const rivals = u.leagueFor(900001).standings.results.filter((r) => r.entry !== DEMO_ENTRY_ID);
    const finals = new Set<number>();
    for (const r of rivals) {
      const rows = u.historyFor(r.entry)!.current;
      // The invariant the whole game rests on: everybody starts on £100.0m,
      // squad plus bank, however much they left unspent.
      expect({ entry: r.entry, gw1: rows[0].value }).toEqual({ entry: r.entry, gw1: 1000 });
      // A bank is money, so it is not negative — and it is not a fortune
      // either. One rival sat on £14.5m for the whole season because the
      // squad builder only ever cut and never spent.
      for (const row of rows) {
        expect({ entry: r.entry, gw: row.event, ok: row.bank >= 0 && row.bank <= 60 }).toEqual({
          entry: r.entry,
          gw: row.event,
          ok: true,
        });
      }
      const values = rows.map((row) => row.value);
      expect(new Set(values).size).toBeGreaterThan(2);
      finals.add(values[values.length - 1]);
    }
    // And the nine of them do not all land on the same number.
    expect(finals.size).toBeGreaterThan(3);
  });

  it("spreads the mini-league across managers of different standards", () => {
    /*
     * All nine rivals were built at depth 0 — the best available man at every
     * club — which is close to the greedy optimum the demo manager holds, so
     * six of the nine outscored him and the front page showed a reader seventh
     * of ten in his own league beside a card calling him top few per cent.
     */
    const results = u.leagueFor(900001).standings.results;
    const totals = results.map((r) => r.total).sort((a, b) => b - a);
    expect(totals[0] - totals[totals.length - 1]).toBeGreaterThan(150);
    const mine = results.find((r) => r.entry === DEMO_ENTRY_ID)!;
    const place = totals.indexOf(mine.total) + 1;
    // Near the top, but beaten: a demo that opens on first place is a demo
    // nobody believes, and one that opens on last contradicts the rank card.
    expect(place).toBeGreaterThan(1);
    expect(place).toBeLessThan(6);
  });

  it("answers an unplayed gameweek with an unplayed gameweek", () => {
    /*
     * `liveFor` fell back to the current gameweek for anything it did not
     * have, so GW25 came back as GW20's scores under a GW25 heading — itemised
     * goals for matches that have not kicked off.
     */
    const now = u.liveFor(CURRENT_GW);
    const future = u.liveFor(CURRENT_GW + 5);
    expect(future.elements.length).toBe(now.elements.length);
    expect(future.elements.every((e) => e.stats.total_points === 0)).toBe(true);
    expect(future.elements.every((e) => e.stats.minutes === 0)).toBe(true);
    expect(future.elements.every((e) => (e.explain ?? []).length === 0)).toBe(true);
    // And it is genuinely a different document from the one it used to copy.
    expect(now.elements.some((e) => e.stats.total_points > 0)).toBe(true);
  });
});
