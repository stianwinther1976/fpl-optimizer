// Season points breakdown: how every point was earned, per player, per category
// and per gameweek. Built from the official `event/{gw}/live` "explain" data,
// which itemises each player's score by scoring rule (minutes, goals, assists,
// clean sheets, defensive contribution, bonus, cards, …). Auto-substitutions
// and captaincy (incl. Triple Captain / Bench Boost) are applied so the totals
// match what FPL actually awarded you.

import { api, FplApiError } from "./fpl";
import { projectAutoSubs } from "./live";
import type { Element, EntryEventPicks, EventLive, Fixture } from "./types";

/** Scoring categories we surface, in display order. `bps` is excluded (it is
 *  the raw tally behind bonus, not points itself). */
export const BREAKDOWN_CATS = [
  "minutes",
  "goals_scored",
  "assists",
  "clean_sheets",
  "saves",
  "penalties_saved",
  "defensive_contribution",
  "bonus",
  "goals_conceded",
  "own_goals",
  "penalties_missed",
  "yellow_cards",
  "red_cards",
] as const;

export type BreakdownCat = (typeof BREAKDOWN_CATS)[number];

export const CAT_LABEL: Record<BreakdownCat, string> = {
  minutes: "Minutes",
  goals_scored: "Goals",
  assists: "Assists",
  clean_sheets: "Clean sheets",
  saves: "Saves",
  penalties_saved: "Penalties saved",
  defensive_contribution: "Defensive contribution",
  bonus: "Bonus",
  goals_conceded: "Goals conceded",
  own_goals: "Own goals",
  penalties_missed: "Penalties missed",
  yellow_cards: "Yellow cards",
  red_cards: "Red cards",
};

/** Short header labels for the wide table. */
export const CAT_SHORT: Record<BreakdownCat, string> = {
  minutes: "Min",
  goals_scored: "Gls",
  assists: "Ast",
  clean_sheets: "CS",
  saves: "Sav",
  penalties_saved: "PenS",
  defensive_contribution: "DefC",
  bonus: "Bon",
  goals_conceded: "GC",
  own_goals: "OG",
  penalties_missed: "PenM",
  yellow_cards: "YC",
  red_cards: "RC",
};

export interface BreakdownRow {
  elementId: number;
  total: number;
  minutesPlayed: number;
  /** Gameweeks the player featured (counted in your score with >0 minutes). */
  apps: number;
  /** Points per scoring category, after captain multiplier. */
  byCat: Record<string, number>;
  /** Total points contributed per gameweek, after captain multiplier. */
  byGw: Map<number, number>;
  /** Per-gameweek category breakdown, so a single round can be itemised too. */
  byGwCat: Map<number, Record<string, number>>;
}

export interface SeasonBreakdown {
  gws: number[];
  rows: BreakdownRow[];
  /** Points per category summed across the whole squad. */
  catTotals: Record<string, number>;
  /** Gross points from players (before transfer hits). */
  playersTotal: number;
  /** Total points docked for transfer hits over the season. */
  hits: number;
  /** Per-gameweek squad gross points and hit cost. */
  perGw: Map<number, { points: number; hits: number }>;
  /**
   * Gameweeks that were asked for and could not be fetched.
   *
   * A HOLE IN THE MIDDLE IS INVISIBLE WITHOUT THIS. The loader's `catch` treats
   * "503 from the proxy" identically to "manager joined late", so a transient
   * failure silently deleted a whole gameweek from the season total: probed by
   * failing GW3 of GW1-5, `gws` came back `[1,2,4,5]`, progress reported 5 of
   * 5, and `playersTotal` read 178 against a true 248 — 70 points gone, under a
   * heading built from `gws[0]`-`gws[last]` that still said GW1 to GW5.
   *
   * Worse, this feeds `toArchive`, whose only guard is
   * `existing.gwsPlayed > a.gwsPlayed` — so a later, longer, holed run
   * overwrites an earlier complete one permanently.
   */
  missing: number[];
}

/** Effective per-element multipliers for one gameweek: applies auto-subs and
 *  moves the armband to the vice if the captain didn't play. */
function effectiveMultipliers(
  picks: EntryEventPicks,
  elements: Map<number, Element>,
  live: EventLive,
  fixtures: Fixture[],
  gw: number
): Map<number, number> {
  const chip = picks.active_chip;
  const capMult = chip === "3xc" ? 3 : 2;
  // Bench Boost: all 15 score, no auto-subs. Otherwise use the post-sub XI.
  const effIds =
    chip === "bboost"
      ? picks.picks.map((p) => p.element)
      : projectAutoSubs(picks.picks, elements, live, fixtures, gw).effectiveXi;

  /*
   * THE ARMBAND MOVES WHEN THE CAPTAIN DOES NOT PLAY, NOT WHEN HE IS SUBBED.
   *
   * This used to ask whether the captain was in the effective XI, which is a
   * different question and gives the wrong answer twice:
   *
   *  - Under Bench Boost `effIds` is all fifteen picks, so a captain on 0
   *    minutes was always "in" and kept a worthless armband. FPL's rule does
   *    not care which chip is active. Measured on a BB week with the captain
   *    blank and the vice scoring a goal: this reported 7 where FPL awards 14.
   *  - With no chip, a blanking captain for whom NO legal auto-sub exists —
   *    every bench player also on 0 — likewise stays in `effectiveXi`, and the
   *    vice was again given 1x. Same 7-against-14.
   *
   * Minutes are the test, so ask the live feed.
   */
  const liveById = new Map(live.elements.map((e) => [e.id, e]));
  const played = (id: number) => (liveById.get(id)?.stats.minutes ?? 0) > 0;

  const cap = picks.picks.find((p) => p.is_captain);
  const vice = picks.picks.find((p) => p.is_vice_captain);
  const capId =
    cap && played(cap.element)
      ? cap.element
      : vice && played(vice.element)
        ? vice.element
        : null;

  const mult = new Map<number, number>();
  for (const id of effIds) mult.set(id, id === capId ? capMult : 1);
  return mult;
}

/** Aggregate already-fetched per-GW data into a season breakdown. Pure — no
 *  network — so it is trivially testable. */
export function aggregateBreakdown(
  gwData: { gw: number; picks: EntryEventPicks; live: EventLive }[],
  elements: Map<number, Element>,
  fixtures: Fixture[]
): SeasonBreakdown {
  const rowById = new Map<number, BreakdownRow>();
  const perGw = new Map<number, { points: number; hits: number }>();
  const gws: number[] = [];
  let hits = 0;

  const rowFor = (id: number): BreakdownRow => {
    let r = rowById.get(id);
    if (!r) {
      r = {
        elementId: id,
        total: 0,
        minutesPlayed: 0,
        apps: 0,
        byCat: {},
        byGw: new Map(),
        byGwCat: new Map(),
      };
      rowById.set(id, r);
    }
    return r;
  };

  for (const { gw, picks, live } of [...gwData].sort((a, b) => a.gw - b.gw)) {
    gws.push(gw);
    const liveById = new Map(live.elements.map((e) => [e.id, e]));
    const mult = effectiveMultipliers(picks, elements, live, fixtures, gw);
    const hitCost = picks.entry_history?.event_transfers_cost ?? 0;
    hits += hitCost;
    let gwGross = 0;

    for (const [id, m] of mult) {
      if (m <= 0) continue;
      const le = liveById.get(id);
      if (!le) continue;
      const row = rowFor(id);
      const gwCat: Record<string, number> = row.byGwCat.get(gw) ?? {};
      let gwPts = 0;
      let mins = 0;
      for (const ex of le.explain ?? []) {
        for (const s of ex.stats) {
          if (s.identifier === "bps") continue;
          const pts = s.points * m;
          row.byCat[s.identifier] = (row.byCat[s.identifier] ?? 0) + pts;
          gwCat[s.identifier] = (gwCat[s.identifier] ?? 0) + pts;
          gwPts += pts;
          if (s.identifier === "minutes") mins += s.value;
        }
      }
      row.byGwCat.set(gw, gwCat);
      row.total += gwPts;
      row.minutesPlayed += mins;
      if (mins > 0) row.apps += 1;
      row.byGw.set(gw, (row.byGw.get(gw) ?? 0) + gwPts);
      gwGross += gwPts;
    }
    perGw.set(gw, { points: gwGross, hits: hitCost });
  }

  const rows = [...rowById.values()].sort((a, b) => b.total - a.total);
  const catTotals: Record<string, number> = {};
  let playersTotal = 0;
  for (const r of rows) {
    playersTotal += r.total;
    for (const [k, v] of Object.entries(r.byCat)) catTotals[k] = (catTotals[k] ?? 0) + v;
  }

  // `missing` belongs to the LOADER, which is the only thing that can know a
  // fetch failed; an aggregation of what it was handed has nothing to report.
  return { gws, rows, catTotals, playersTotal, hits, perGw, missing: [] };
}

/** Fetch picks + live for every finished gameweek and aggregate. Bounded
 *  concurrency; a GW the manager didn't participate in is simply skipped. */
export async function loadSeasonBreakdown(
  entryId: number,
  finishedGws: number[],
  elements: Map<number, Element>,
  fixtures: Fixture[],
  concurrency = 6,
  onProgress?: (done: number, total: number) => void
): Promise<SeasonBreakdown> {
  const queue = [...finishedGws];
  const total = queue.length;
  const collected: { gw: number; picks: EntryEventPicks; live: EventLive }[] = [];
  const missing: number[] = [];
  let done = 0;

  const worker = async () => {
    for (;;) {
      const gw = queue.shift();
      if (gw == null) return;
      try {
        /*
         * SEQUENTIAL, so a 404 can be attributed. Run together, the catch
         * cannot tell which leg failed — and "the manager had no picks that
         * gameweek" is a fact about PICKS only. A 404 from `event/{gw}/live/`
         * is a gameweek we could not read, and folding it into the benign case
         * deleted it silently: probed by 404-ing the live feed alone, `gws`
         * came back [1,2,4,5] with `missing: []`.
         *
         * The cost is one round trip's latency per gameweek instead of two in
         * parallel, and `api.live(gw)` is shared across every entry in the
         * session anyway — the second worker to want it gets the memo.
         */
        const picks = await api.picks(entryId, gw).catch((e) => {
          // The one benign 404 there is.
          if (e instanceof FplApiError && e.status === 404) return null;
          throw e;
        });
        if (picks == null) {
          done++;
          onProgress?.(done, total);
          continue;
        }
        const live = await api.live(gw);
        collected.push({ gw, picks, live });
      } catch (e) {
        /*
         * Everything that reaches here is a failure. The one benign case — a
         * 404 on PICKS, meaning the manager had no team that gameweek — is
         * handled above and never throws. A 503 while FPL updates the game, a
         * dropped connection, or a 404 from the LIVE feed is a gameweek we
         * could not read, and swallowing it silently removed real points from
         * the season total with nothing on screen to say so.
         */
        void e;
        missing.push(gw);
      }
      done++;
      onProgress?.(done, total);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker)
  );
  return { ...aggregateBreakdown(collected, elements, fixtures), missing: missing.sort((a, b) => a - b) };
}
