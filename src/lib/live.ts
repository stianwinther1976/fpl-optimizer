// Live-gameweek helpers: provisional bonus from BPS, auto-substitution
// projection and live match state.

import type {
  Bootstrap,
  Element,
  EntryEventPicks,
  EventLive,
  Fixture,
  Pick as FplPick,
} from "./types";
import { isValidFormation } from "./rules";

/**
 * How often a screen showing live scores re-reads them, in milliseconds.
 *
 * Shared by the Live tab and the squad view so the two cannot drift apart —
 * they poll the same endpoints, and a reader switching between them should not
 * find one of them staler than the other for no visible reason.
 *
 * Not tuned, and there is nothing here to tune: the proxy caches `event/{id}/
 * live/` for 25 seconds, so anything faster than that returns the same bytes
 * and anything much slower wastes the freshness already paid for.
 */
export const LIVE_REFRESH_MS = 30_000;

/**
 * Is the ball actually rolling?
 *
 * `started && !finished` is NOT this question — `finished` means bonus
 * confirmed, so between the whistle and FPL settling the bonus (hours, after a
 * Saturday) it stays true. `matchMinute` learned that and started rendering
 * "FT"; the styling beside it did not, so a finished match sat there in the
 * in-play accent with an in-play border. Both read this now.
 */
export function isInPlay(f: Pick<Fixture, "started" | "finished" | "finished_provisional">): boolean {
  return !!f.started && !f.finished && !f.finished_provisional;
}

export interface ProvisionalBonus {
  /** elementId -> projected bonus (1..3) for fixtures where bonus isn't final yet */
  byElement: Map<number, number>;
}

/**
 * FPL awards 3/2/1 bonus to the top-BPS players per fixture. Once a fixture has
 * finished but its bonus is not yet confirmed, we read it off the BPS ladder.
 * Ties follow the official pattern: tied players share the higher bonus and the
 * lower slots are skipped accordingly.
 *
 * AT FULL TIME ONLY, WHICH IT WAS NOT. The gate was `started && !finished`, so
 * bonus was projected from the first minute of a match — and at minute two the
 * BPS table holds a couple of completed passes, so whoever tops it is awarded
 * 3, 2 or 1 points of pure noise. Reported from a live match: B.Fernandes
 * captained, one appearance point, a projected 2 on top, doubled for the
 * armband — the app showed 6 where FPL showed 2. Four phantom points on the
 * headline total, at minute two.
 *
 * `finished_provisional` is the final whistle, and there the ladder is FINAL:
 * nothing more can change it and only FPL's confirmation is outstanding. That
 * is the window this function's own header describes as hours long, and it is
 * the one state in which a reading off BPS is not a forecast. It is also the
 * only one that has been measured — on the 2026-08-21 snapshot the fixture at
 * `finished_provisional: true, finished: false` already carried the 3/2/1 rows
 * beside its ladder, and the top three matched exactly.
 *
 * A mid-match projection is a forecast, and this app does not put forecasts in
 * a total it presents as the reader's score. That the number was then
 * multiplied by the captain is what turned a small wrong into a visible one.
 */
export function provisionalBonus(
  bootstrap: Bootstrap,
  fixtures: Fixture[],
  live: EventLive,
  event: number
): ProvisionalBonus {
  const byElement = new Map<number, number>();
  const teamOf = new Map(bootstrap.elements.map((e) => [e.id, e.team]));

  /*
   * EVERYTHING HERE IS PER FIXTURE. `stats` IS PER GAMEWEEK.
   *
   * `live.elements[].stats.bps` and `.minutes` are totals across ALL of a
   * player's fixtures in the gameweek, and they used to be read as if they
   * described the match being projected. In a double gameweek that produced
   * three separate wrong answers, each confirmed by probe:
   *
   *  - a player who banked 45 BPS in leg 1 and has not come on in leg 2 was
   *    ranked top of leg 2 and awarded 3 provisional bonus for a match he was
   *    not playing in, demoting the man actually leading it;
   *  - bonus across two projectable legs was `Math.max`, so a player top of
   *    both was credited 3 where FPL pays 3 + 3;
   *  - the already-awarded subtraction summed `explain` over the whole
   *    gameweek, so a finished leg's CONFIRMED 3 cancelled the live leg's
   *    projection entirely and the points vanished from the live total.
   *
   * `explain` carries a `fixture` id, so participation and awarded bonus are
   * both answerable per leg. BPS is not in `explain` — but it IS on the fixture
   * itself, which is the correction below.
   */
  const perFixture = new Map<number, Map<number, { minutes: number; bonus: number }>>();
  const legsPlayed = new Map<number, number>();
  /*
   * Whether this feed itemises fixtures AT ALL, which is not the same question
   * as whether it itemises THIS fixture — and conflating the two reintroduced
   * the bug the rewrite exists to kill. `explain` for a second leg is absent in
   * the window between kickoff and FPL's first stats update for it, so falling
   * back on "no rows for this fixture" put the WHOLE gameweek's minutes back in
   * play: probe-confirmed, two leg-1 players were handed 3 and 2 provisional
   * bonus for a match they were not in, and the leg-1 bonus already confirmed
   * for one of them was counted twice on top.
   *
   * A feed with no `explain` anywhere is a stub, and there the gameweek total
   * is the fixture total because there is only one fixture to speak of.
   */
  const itemised = live.elements.some((e) => (e.explain ?? []).length > 0);
  for (const e of live.elements) {
    for (const ex of e.explain ?? []) {
      let mins = 0;
      let bonus = 0;
      for (const st of ex.stats) {
        if (st.identifier === "minutes") mins = st.value;
        else if (st.identifier === "bonus") bonus += st.points;
      }
      let f = perFixture.get(ex.fixture);
      if (!f) perFixture.set(ex.fixture, (f = new Map()));
      f.set(e.id, { minutes: mins, bonus });
      if (mins > 0) legsPlayed.set(e.id, (legsPlayed.get(e.id) ?? 0) + 1);
    }
  }

  for (const f of fixtures) {
    if (f.event !== event) continue;
    // Full time, bonus not yet confirmed — and nothing else. See the header.
    if (!f.finished_provisional || f.finished) continue;
    const inThis = perFixture.get(f.id);

    /*
     * THE FIXTURE'S OWN BPS LADDER, WHEN IT HAS ONE.
     *
     * `fixture.stats` carries a `bps` row per player who appeared IN THIS
     * MATCH, split home and away. That is the exact quantity the ranking below
     * wants, and its absence from the type is the only reason the gameweek
     * total was ever used for it. Read off the real snapshot (2026-08-21, GW1
     * fixture 1): 30 rows running −8 to 41, and the top three are precisely the
     * three the fixture's `bonus` rows pay 3, 2 and 1.
     *
     * IT DOES NOT ANSWER PARTICIPATION, and an earlier version of this block
     * said it did ("30 rows for the 30 players who appeared"). Thirty-ONE
     * appeared: FPL omits zero-valued entries from a `stats` row, so Rushworth
     * (element 110, 90 minutes, 1 point, 0 BPS) has no row at all. Counted
     * against `element-summaries`, which carries a per-fixture history row per
     * player. So participation stays with minutes and the ladder is used only
     * for the ORDER — a man with no row is on 0, not absent, and 0 can win the
     * third bonus point in a match where only two players score any BPS.
     *
     * `ladder` IS NULL WHEN THE ROW IS EMPTY, not merely when it is missing.
     * FPL emits identifiers with both arrays empty — `own_goals`, `red_cards`,
     * `penalties_saved` and `penalties_missed` all are, on that same fixture —
     * so `bps` may arrive that way too, and a size-0 Map that reads as "we have
     * a ladder" while every lookup falls through to the gameweek total is the
     * exact bug this block exists to remove, silently re-enabled.
     *
     * Not assumed to be there at all. FPL may only populate it from the final
     * whistle — the sandbox this was written in has no live fixture to check
     * against — so with no usable row this falls through to exactly the
     * behaviour it replaces, gameweek totals and the abstention.
     */
    const bpsRow = f.stats?.find((st) => st.identifier === "bps");
    const rows = bpsRow ? [...bpsRow.h, ...bpsRow.a] : [];
    const ladder = rows.length > 0 ? new Map(rows.map((r) => [r.element, r.value])) : null;

    const players = live.elements
      .filter((e) => {
        const t = teamOf.get(e.id);
        if (t !== f.team_h && t !== f.team_a) return false;
        // Per-fixture minutes when the feed itemises them; the gameweek total
        // is the fallback for a single-fixture week, where the two agree. A
        // player with a ladder entry played by definition, which covers the
        // window before `explain` carries a fresh second leg.
        if (ladder?.has(e.id)) return true;
        const mins = itemised ? (inThis?.get(e.id)?.minutes ?? 0) : e.stats.minutes;
        return (mins ?? 0) > 0;
      })
      .map((e) => ({ id: e.id, bps: ladder ? (ladder.get(e.id) ?? 0) : e.stats.bps }))
      .sort((a, b) => b.bps - a.bps);
    if (players.length === 0) continue;

    /*
     * ABSTAIN WHEN THE RANKING CANNOT BE TRUSTED — WHICH IS NOW ONLY WHEN THE
     * FIXTURE PUBLISHED NO USABLE BPS LADDER.
     *
     * Without it the only BPS available is the gameweek total, so if anyone on
     * this pitch has also played another fixture this gameweek his figure
     * includes points banked elsewhere and the 3/2/1 order here is not a
     * reading of this match. Projecting a confident wrong ladder is worse than
     * projecting nothing: the reader sees provisional bonus on the wrong three
     * players and the numbers do not settle until FPL confirms.
     *
     * `!ladder` is the same predicate the ranking above switches on, and that
     * matters: gating the two on different tests is how an empty row came to
     * select the gameweek-total ranking AND skip the abstention at once.
     *
     * Single gameweeks — every gameweek most seasons — never reached this
     * either way, because there the gameweek total IS this fixture's total.
     */
    if (!ladder && players.some((p) => (legsPlayed.get(p.id) ?? 0) > 1)) continue;

    // Group by bps value, award 3/2/1 with tie-sharing.
    let bonus = 3;
    let i = 0;
    while (i < players.length && bonus > 0) {
      const tied = players.filter((p) => p.bps === players[i].bps);
      for (const p of tied) {
        /*
         * Accumulate rather than `Math.max`, because FPL pays each leg. This
         * used to be unreachable — being credited from two legs meant playing
         * two, which made both fixtures abstain — and the note here said the
         * `+` was insurance against the day per-fixture BPS turned up. It has:
         * with `f.stats` a player top of both legs is now ranked in both, and
         * `Math.max` would credit 3 where FPL pays 6.
         */
        const net = bonus - (inThis?.get(p.id)?.bonus ?? 0);
        if (net > 0) byElement.set(p.id, (byElement.get(p.id) ?? 0) + net);
      }
      i += tied.length;
      bonus -= tied.length;
    }
  }

  return { byElement };
}

/** One player's line in ONE fixture, rather than across the gameweek. */
export interface FixtureLine {
  minutes: number;
  points: number;
  /** Null when the fixture publishes no BPS ladder — see `provisionalBonus`. */
  bps: number | null;
}

/**
 * Everyone who appeared in ONE fixture, with that fixture's own numbers.
 *
 * `live.elements[].stats` IS A GAMEWEEK TOTAL. Read as a per-match figure it
 * says a player who only appeared in leg 1 played in leg 2, gives him 180
 * minutes, and ranks him by two legs of BPS — which is exactly the family of
 * defect `provisionalBonus` was rewritten to remove, and it was still live one
 * file over in the match sheet.
 *
 * `explain` carries a `fixture` id, so minutes and points are answerable per
 * leg; `fixture.stats` carries the BPS ladder when FPL has published one. Where
 * the feed itemises nothing at all — a stub, or a gameweek with a single
 * fixture — the gameweek total IS this fixture's total and is used as-is.
 */
export function fixtureLines(
  fixture: Fixture,
  live: EventLive | null,
  /**
   * Which club each element plays for. Optional, and only used to keep players
   * from other clubs out of the un-itemised fallback — `provisionalBonus` has
   * always filtered on it there and this did not, so a stub feed could put a
   * third club's player in a two-club match. Not reachable from the shipped
   * feeds, which itemise; the asymmetry between two functions answering the
   * same question is the reason to close it.
   */
  teamOf?: Map<number, number>
): Map<number, FixtureLine> {
  const out = new Map<number, FixtureLine>();
  if (!live) return out;
  const bpsRow = fixture.stats?.find((st) => st.identifier === "bps");
  const rows = bpsRow ? [...bpsRow.h, ...bpsRow.a] : [];
  // Empty is not "published" — see the same distinction in `provisionalBonus`.
  const ladder = rows.length > 0 ? new Map(rows.map((r) => [r.element, r.value])) : null;
  const itemised = live.elements.some((e) => (e.explain ?? []).length > 0);
  for (const e of live.elements) {
    const legs = (e.explain ?? []).filter((ex) => ex.fixture === fixture.id);
    if (itemised && legs.length === 0) continue;
    let minutes = 0;
    let points = 0;
    if (itemised) {
      for (const leg of legs) {
        for (const st of leg.stats) {
          points += st.points;
          if (st.identifier === "minutes") minutes += st.value;
        }
      }
    } else {
      const t = teamOf?.get(e.id);
      if (teamOf && t !== fixture.team_h && t !== fixture.team_a) continue;
      minutes = e.stats.minutes;
      points = e.stats.total_points;
    }
    if (minutes <= 0 && points === 0) continue;
    /*
     * BPS, IN ORDER OF WHAT CAN BE PROVEN.
     *
     * The ladder is per-fixture and is the answer whenever it exists — and a
     * player missing from it is on ZERO, not unknown, because FPL omits
     * zero-valued entries from a `stats` row (measured: 31 players appeared in
     * the snapshot's fixture 1 and 30 have rows; the missing one is a keeper on
     * 0 BPS).
     *
     * With no ladder, the gameweek total is still exactly right for anyone with
     * ONE leg this gameweek — which is every player in every ordinary gameweek.
     * Returning null there threw away a correct number and emptied the BPS
     * column of the match sheet in weeks where it had always been right.
     */
    const oneLeg = (e.explain ?? []).length <= 1;
    out.set(e.id, {
      minutes,
      points,
      bps: ladder ? (ladder.get(e.id) ?? 0) : !itemised || oneLeg ? e.stats.bps : null,
    });
  }
  return out;
}

export interface AutoSubResult {
  /** element ids of starters projected to be replaced */
  out: number[];
  /** element ids of bench players projected to come on, in order */
  in: number[];
  /** effective XI element ids after projected auto-subs */
  effectiveXi: number[];
}

/**
 * Project FPL auto-substitutions: once ALL of a starter's fixtures in the GW
 * have finished with 0 minutes, the bench comes on in bench order (GK for GK,
 * outfield subject to formation legality), skipping bench players who also
 * finished on 0 minutes. Mirrors the official end-of-GW processing so the
 * "final" score matches FPL before it is officially processed.
 */
export function projectAutoSubs(
  picks: FplPick[],
  elements: Map<number, Element>,
  live: EventLive,
  fixtures: Fixture[],
  event: number
): AutoSubResult {
  const liveById = new Map(live.elements.map((e) => [e.id, e]));
  const fxByTeam = new Map<number, Fixture[]>();
  for (const f of fixtures) {
    if (f.event !== event) continue;
    for (const t of [f.team_h, f.team_a]) {
      const arr = fxByTeam.get(t);
      if (arr) arr.push(f);
      else fxByTeam.set(t, [f]);
    }
  }
  /*
   * A player is "done on 0" when they have fixtures this GW, every one has
   * REACHED FULL TIME, and they played 0 minutes. (No fixture at all = blank
   * GW = done.)
   *
   * FULL TIME IS `finished_provisional`, NOT `finished`. A substitution turns
   * entirely on MINUTES, which is a fact about the match and is settled at the
   * whistle; `finished` waits for BONUS, which no auto-substitution depends on.
   * CLAUDE.md states that split, and `isInPlay` and `matchMinute` were both
   * corrected to it — this was not, so for the whole provisional window (the
   * snapshot shows a fixture still provisional after full time, and a Saturday
   * slate routinely takes hours) the app rendered "FT", stopped the pulsing
   * live styling, and went on counting a starter who never came on while
   * ignoring the bench player who replaces him.
   *
   * The risk in the other direction is a stat correction after the whistle,
   * which would move a player off zero minutes. That does not favour waiting:
   * FPL processes the substitution on the same data, so following it is being
   * wrong exactly when FPL is, instead of being wrong for hours on purpose.
   */
  const doneOnZero = (elId: number): boolean => {
    const el = elements.get(elId);
    if (!el) return false;
    const fx = fxByTeam.get(el.team) ?? [];
    if (fx.length === 0) return true; // blank GW: cannot score
    if (!fx.every((f) => f.finished || f.finished_provisional)) return false;
    return (liveById.get(elId)?.stats.minutes ?? 0) === 0;
  };

  const sorted = [...picks].sort((a, b) => a.position - b.position);
  const starters = sorted.filter((p) => p.position <= 11);
  const bench = sorted.filter((p) => p.position > 11);
  const xi = starters.map((p) => p.element);
  const typeOf = (id: number) => elements.get(id)?.element_type ?? 3;

  const counts = () => {
    const c: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const id of xi) c[typeOf(id)]++;
    return c;
  };

  const out: number[] = [];
  const subbedIn: number[] = [];
  const usedBench = new Set<number>();

  for (const starter of starters) {
    if (!doneOnZero(starter.element)) continue;
    const sType = typeOf(starter.element);
    for (const b of bench) {
      if (usedBench.has(b.element)) continue;
      if (doneOnZero(b.element)) continue;
      const bType = typeOf(b.element);
      // GK slot can only be replaced by the bench GK, and vice versa.
      if ((sType === 1) !== (bType === 1)) continue;
      // Formation legality after the swap.
      const c = counts();
      c[sType]--;
      c[bType]++;
      if (c[1] !== 1 || !isValidFormation(c[2], c[3], c[4])) continue;
      const idx = xi.indexOf(starter.element);
      xi[idx] = b.element;
      usedBench.add(b.element);
      out.push(starter.element);
      subbedIn.push(b.element);
      break;
    }
  }
  return { out, in: subbedIn, effectiveXi: xi };
}

/**
 * The match clock for a fixture.
 *
 * READ IT, DO NOT ESTIMATE IT. FPL publishes `minutes` on every fixture and
 * this function used to ignore it, deriving the number from `now - kickoff`
 * with a flat fifteen minutes knocked off past the hour. That estimate has no
 * way to know about stoppage time — in either half, or a long VAR check, or a
 * delayed restart — and it only ever errs one way, because every one of those
 * adds wall-clock time that is not match time. Measured live on ARS v COV in
 * GW1 2026-27: FPL published 54, the estimate said 61.
 *
 * That error is worse than it sounds, because it does not look like an error.
 * A reader who knows a goal went in on 50 minutes sees a clock reading 52 and a
 * score without it, and concludes the SCORE is stale — when the score was right
 * and the clock was seven minutes ahead of the match. This was reported exactly
 * that way.
 *
 * The estimate survives as a fallback for the gap where a match has started but
 * the feed still says 0 minutes, which is a real state for a minute or so after
 * kickoff. It is not reached otherwise, and it stays deliberately rough: it is
 * a stand-in for a number that is usually there, not a second opinion.
 *
 * Note the published clock STOPS over half time rather than reading "HT" — 45'
 * frozen is what a scoreboard shows too, and inferring the break from a stalled
 * counter would be guessing again.
 */
/**
 * The match clock, read from the LIVE endpoint rather than from `fixtures/`.
 *
 * MEASURED, and it is the reason this function exists. Probe run 32577720199,
 * 36 samples 20s apart across the 2026-08-22 15:00 BST kick-offs, recording
 * FPL's own `age` header on both feeds:
 *
 *   `fixtures/`         age climbed 20 -> 301 and reset. Two resets 301s
 *                       apart, so FPL's edge holds it for 300 SECONDS.
 *   `event/{gw}/live/`  age never exceeded 92, resetting throughout — roughly
 *                       a 90-second hold.
 *
 * So the clock the app was reading is behind by however far into FPL's own
 * five-minute cache window the request lands. Sampled on IPS-SUN, kicked off
 * 14:00:00Z, at 14:18:11Z — 18 minutes of football played:
 *
 *   `fixtures[].minutes` ............ 10   (8 minutes behind)
 *   max player minutes, this fixture  16   (2 minutes behind)
 *
 * Across the run `fixtures[].minutes` sawtoothed between roughly 2 and 8
 * minutes behind, stepping only at the instants `age` reset. The player clock
 * moved smoothly and stayed about 2 behind. Nothing in this repo caused any of
 * it and no caching change here can shorten it: it is upstream of the proxy,
 * the CDN and the poll alike. Reading the other feed is the only lever.
 *
 * The comment this replaces claimed `fixtures[].minutes` had been measured
 * tracking the real clock ("89 at the 89th minute"). No snapshot in this repo
 * contains an in-play fixture, so that could not be reproduced, and the probe
 * above contradicts it for the live feed.
 *
 * ONE FIXTURE ONLY, WHICH IS THE TRAP. `live.elements[].stats.minutes` is a
 * GAMEWEEK total, so a player who banked 90 in leg 1 of a double would report
 * 90 for a leg 2 that kicked off ten minutes ago. Only players with exactly
 * one `explain` entry are counted — the same guard `provisionalBonus` needed,
 * for the same reason. In a double that still leaves every single-leg player
 * to read the clock from; when it leaves nobody, this returns null and the
 * caller falls back to the fixtures clock.
 */
export function liveMatchMinutes(live: EventLive | null, fixtureId: number): number | null {
  if (!live) return null;
  let best: number | null = null;
  for (const el of live.elements ?? []) {
    const legs = el.explain ?? [];
    if (legs.length !== 1 || legs[0].fixture !== fixtureId) continue;
    const m = el.stats?.minutes;
    if (typeof m !== "number" || !Number.isFinite(m)) continue;
    if (best === null || m > best) best = m;
  }
  return best;
}

export function matchMinute(f: Fixture, now: Date = new Date(), liveMinutes?: number | null): string {
  // `finished` means BONUS CONFIRMED, not "the match has ended" — after a
  // Saturday afternoon those are hours apart, and for that whole window the
  // clock had nothing to tell it the match was over and sat on 90'.
  if (f.finished || f.finished_provisional) return "FT";
  if (!f.started || !f.kickoff_time) return "";
  // Guard the type as well as the value: this arrives from the network, and a
  // string "54" would render as "54'" by luck and NaN-poison any arithmetic a
  // later caller does on it.
  /*
   * The LARGER of the two, because both are lower bounds on how much football
   * has been played and neither can run ahead of the match. `fixtures/` is
   * five minutes stale at worst; the live feed is ninety seconds stale at
   * worst; whichever has been refreshed more recently is the better answer,
   * and that is exactly what taking the max picks.
   */
  const published =
    typeof f.minutes === "number" && Number.isFinite(f.minutes) ? f.minutes : 0;
  const fromLive =
    typeof liveMinutes === "number" && Number.isFinite(liveMinutes) ? liveMinutes : 0;
  const best = Math.max(published, fromLive);
  if (best > 0) {
    const m = Math.floor(best);
    /*
     * FPL STOPS COUNTING AT 90, so a match in stoppage reads exactly 90 and
     * stays there. Measured on ARS v COV: the feed said 89 at the 89th minute
     * and then 90 for the rest of a match that ran to 94.
     *
     * "90'" for four more minutes of football is a claim the data cannot
     * support, and it is the reading that got queried. `90+` says what is
     * actually known — at least ninety, still playing — and is what FPL's own
     * scoreboard shows. The same applies at 120 for a match that goes to extra
     * time, which FPL does not run but the cap should not lie about either.
     */
    if (m >= 120) return "120+'";
    if (m >= 90) return "90+'";
    return `${m}'`;
  }
  const mins = Math.floor((now.getTime() - new Date(f.kickoff_time).getTime()) / 60000);
  if (mins <= 0) return "KO";
  if (mins >= 45 && mins <= 60) return "HT~";
  const capped = Math.min(mins > 60 ? mins - 15 : mins, 90); // rough half-time adjustment
  return `${capped}'`;
}


/**
 * The median live score of a sample of rival managers, scored exactly the way
 * the reader's own total is.
 *
 * SYMMETRY IS THE WHOLE POINT, and two things broke it while this lived inline
 * in `LiveTab`:
 *
 *  - The sample was fetched AND scored in one effect behind a ref that never
 *    reset, so the benchmark was a snapshot of the first live payload while the
 *    reader's total moved every thirty seconds. Left long enough that is not a
 *    comparison: the number you are told to beat is the score your rivals had
 *    when you opened the tab, and "you're N above; on course to climb" is what
 *    almost everyone sees by the end of a Saturday. Picks do not change during
 *    a gameweek, so they are still fetched once; the SCORING is what has to
 *    follow the feed, which is why it is a pure function here.
 *
 *  - `provisionalBonus` was applied to the reader and to nobody else. Through
 *    the window CLAUDE.md describes as "hours apart" — final whistle to bonus
 *    confirmation — that credited the reader two to eight points the benchmark
 *    credited no one. The bonus map is per PLAYER, so it applies to a rival's
 *    picks unchanged.
 *
 *  - THE ARMBAND DID NOT MOVE FOR RIVALS, and the commit that fixed the bonus
 *    half asserted that "everything else in this comparison is already
 *    symmetric". It was not. The reader's side promotes the vice-captain once
 *    the captain can no longer play; this took `pk.multiplier` off the picks
 *    payload, which is what FPL recorded at the deadline. Measured on one demo
 *    squad whose captain played 0 minutes and whose vice scored 13: the reader
 *    was credited 59 and the same squad scored here came to 46. It pushes the
 *    same direction as the bonus gap — the reader gets the takeover and the
 *    benchmark never does — and it also drags the median DOWN, because every
 *    band rival whose captain blanks is scored too low.
 *
 * Everything else really is symmetric: both sides net of hits, both with
 * projected auto-subs. Returns null below `minSample`, because a median of
 * three managers is not a rank band.
 */
export function bandMedianScore(
  picks: EntryEventPicks[],
  elements: Map<number, Element>,
  live: EventLive,
  fixtures: Fixture[],
  gw: number,
  bonusByElement: Map<number, number> | null,
  gwDone = false,
  minSample = 5
): number | null {
  const scores = picks.map((p) =>
    liveEntryScore(p, elements, live, fixtures, gw, bonusByElement, gwDone)
  );
  if (scores.length < minSample) return null;
  scores.sort((a, b) => a - b);
  return scores[Math.floor(scores.length / 2)];
}

/**
 * One manager's live gameweek score, net of hits — THE definition, used
 * everywhere a manager's live score is shown.
 *
 * THREE TABS COMPUTED THIS THREE DIFFERENT WAYS. The Live tab had provisional
 * bonus and the vice-captain takeover; the Team pitch corner had the takeover
 * and no bonus; the Mini-league row had neither, for the reader and for every
 * rival. Measured on the demo squad at GW20, identical inputs:
 *
 *                                          Live   Team pitch   Mini-league
 *   demo as shipped                          48       48           48
 *   bonus awarded but not yet confirmed      48       46           46
 *   captain blanked, vice played             53       53           52
 *
 * The first row agrees only because `demo.ts` itemises bonus into `explain`
 * for in-play fixtures — which FPL does not — so `provisionalBonus` returns an
 * empty map and the divergence is invisible on the only feed that runs
 * locally. The second row is the real state between the final whistle and
 * bonus confirmation, which CLAUDE.md and `isInPlay` above both describe as
 * hours long. The third row's gap is the vice's entire raw score, 4 to 15
 * points on real data.
 *
 * `pk.multiplier` is what FPL recorded at the DEADLINE and already carries
 * Triple Captain, so it stands unless the takeover fires — recomputing it from
 * `active_chip` in the ordinary case would replace a fact with an inference.
 */
export function liveEntryScore(
  p: EntryEventPicks,
  elements: Map<number, Element>,
  live: EventLive,
  fixtures: Fixture[],
  gw: number,
  bonusByElement: Map<number, number> | null,
  gwDone = false
): number {
  const pointsOf = new Map(live.elements.map((e) => [e.id, e.stats.total_points]));
  const minsOf = new Map(live.elements.map((e) => [e.id, e.stats.minutes]));
  const bb = p.active_chip === "bboost";
  const subs = projectAutoSubs(p.picks, elements, live, fixtures, gw);
  const effXi = new Set(subs.effectiveXi);
  /*
   * The takeover rule, term for term: the captain is gone once the gameweek is
   * done or the auto-sub projection has dropped him, he must be on zero
   * minutes, and the vice must have played.
   */
  const capMult = p.active_chip === "3xc" ? 3 : 2;
  const blanked = new Set(subs.out);
  const capPick = p.picks.find((k) => k.is_captain);
  const vicePick = p.picks.find((k) => k.is_vice_captain);
  const takeover =
    capPick != null &&
    vicePick != null &&
    (gwDone || blanked.has(capPick.element)) &&
    (minsOf.get(capPick.element) ?? 0) === 0 &&
    (minsOf.get(vicePick.element) ?? 0) > 0;
  let pts = 0;
  for (const pk of p.picks) {
    if (!bb && !effXi.has(pk.element)) continue;
    let mult = pk.multiplier > 1 ? pk.multiplier : 1;
    if (takeover) {
      if (pk.element === capPick!.element) mult = 1;
      else if (pk.element === vicePick!.element) mult = capMult;
    }
    pts += ((pointsOf.get(pk.element) ?? 0) + (bonusByElement?.get(pk.element) ?? 0)) * mult;
  }
  return pts - (p.entry_history?.event_transfers_cost ?? 0);
}

/**
 * How long the in-play feed may show the SAME numbers before it is not live.
 *
 * A BOUND, NOT A FITTED VALUE, and it is worth being precise about which:
 * the longest freeze this feed can legitimately show is half time, which the
 * Laws of the Game cap at 15 minutes. That is a rule of the sport, not a
 * measurement of FPL, so it does not need a sweep — but the margin on top of
 * it does not have one either. Five minutes is a guess at FPL's own update
 * lag; nothing here has measured it, and no snapshot taken so far contains an
 * in-play fixture to measure it from.
 *
 * Erring long is the right direction. A false "not updating" during half time
 * of a 3pm slot — when every match freezes at 45 together — would be the
 * advisory crying wolf on the one screen that has to be trusted.
 */
export const FEED_STALL_MS = 20 * 60_000;

/**
 * Everything about this gameweek's in-play matches that MUST change while
 * football is being played.
 *
 * WHY THIS EXISTS AT ALL, because two other defences already looked like they
 * covered it and do not:
 *
 *  - The origin no longer serves a cached body behind a failed upstream
 *    (`cache: "no-store"`), and
 *  - `liveStaleMinutes` catches a feed that has stopped ANSWERING.
 *
 * Both are about OUR request failing. Neither fires when the request succeeds
 * and the payload is simply old — an upstream edge serving its own stale copy,
 * which is indistinguishable from a fresh one at every layer we control. It
 * was observed: a match that had finished 2-0 rendered `55'` under a current
 * "Updated" stamp, having earlier rendered `2'` for over an hour. The payload
 * advanced once and stopped again, and every HTTP status along the way was 200.
 *
 * So the only honest test left is whether OUR OWN DATA MOVES. This makes no
 * claim about FPL's internals and does not estimate a minute from the clock —
 * the repo has three shipped defects from doing exactly that. It compares the
 * feed with itself.
 *
 * Scores and the finish flags are folded in as well as the clock, so a feed
 * that is alive in any respect counts as alive.
 */
export function liveSignature(fixtures: Fixture[], event: number): string {
  return fixtures
    .filter((f) => f.event === event && isInPlay(f))
    .map(
      (f) =>
        `${f.id}:${f.minutes ?? ""}:${f.team_h_score ?? ""}-${f.team_a_score ?? ""}:${
          f.finished ? 1 : 0
        }${f.finished_provisional ? 1 : 0}`
    )
    .sort()
    .join("|");
}

/**
 * The watch a caller holds between polls: the last in-play signature seen, and
 * when it was first seen.
 */
export type FeedWatch = { sig: string; at: number };

/**
 * Fold a fresh payload into the watch, returning the SAME OBJECT when nothing
 * moved.
 *
 * Referential stability is the point of that: this is held in React state and
 * set from the poll, so returning a new object every thirty seconds would
 * repaint the tab forever for no change. Pure — no ref written during render,
 * which `react-hooks/refs` rejects and which was the first shape of this.
 */
export function advanceFeedWatch(
  watch: FeedWatch,
  fixtures: Fixture[],
  event: number,
  now: number
): FeedWatch {
  const sig = liveSignature(fixtures, event);
  return sig === watch.sig ? watch : { sig, at: now };
}

/**
 * How long the feed has shown the same in-play numbers, or null while it moves.
 *
 * An empty signature — no match in play — is never a stall: the gap between two
 * kick-offs is not the feed failing, and `advanceFeedWatch` resets the clock on
 * the way in and out of it.
 */
export function feedStallMs(watch: FeedWatch, now: number): number | null {
  if (watch.sig === "") return null;
  const held = now - watch.at;
  return held >= FEED_STALL_MS ? held : null;
}

/**
 * How much football a manager's counting players still have in front of them.
 *
 * The number a live table is actually read for. A rival two points ahead with
 * five players still to kick off is in a different position from one two
 * points ahead with none, and the score alone cannot tell them apart — which
 * is why every live standings view worth using prints this beside it.
 *
 * COUNTED OVER THE SAME PLAYERS THE SCORE IS. Auto-subs and Bench Boost decide
 * who counts, so this runs `projectAutoSubs` exactly as `liveEntryScore` does;
 * counting the raw first eleven would credit a rival for a benched player's
 * fixture and miss the substitute who actually replaced him.
 *
 * A player is resolved against HIS CLUB'S fixtures in this gameweek, not one
 * fixture, so a double gameweek answers sensibly: in play if any leg is
 * running, otherwise to start if any leg has not kicked off, otherwise done.
 * `blank` is players with no fixture at all — neither waiting nor playing, and
 * reported separately rather than quietly counted as finished.
 */
export function squadMatchState(
  p: EntryEventPicks,
  elements: Map<number, Element>,
  live: EventLive,
  fixtures: Fixture[],
  gw: number
): { inPlay: number; toStart: number; played: number; blank: number } {
  const bb = p.active_chip === "bboost";
  const effXi = new Set(projectAutoSubs(p.picks, elements, live, fixtures, gw).effectiveXi);
  const byTeam = new Map<number, Fixture[]>();
  for (const f of fixtures) {
    if (f.event !== gw) continue;
    for (const t of [f.team_h, f.team_a]) {
      const list = byTeam.get(t);
      if (list) list.push(f);
      else byTeam.set(t, [f]);
    }
  }
  let inPlay = 0;
  let toStart = 0;
  let played = 0;
  let blank = 0;
  for (const pk of p.picks) {
    if (!bb && !effXi.has(pk.element)) continue;
    const team = elements.get(pk.element)?.team;
    const legs = team == null ? [] : (byTeam.get(team) ?? []);
    if (legs.length === 0) blank++;
    else if (legs.some((f) => isInPlay(f))) inPlay++;
    else if (legs.some((f) => !f.started)) toStart++;
    else played++;
  }
  return { inPlay, toStart, played, blank };
}

/**
 * Where one player is in his gameweek: still to come, on the pitch, finished,
 * or finished without appearing.
 *
 * ASKED FOR AFTER USING A TABLE THAT SHOWS IT. Opening a rival's team tells you
 * the score; it does not tell you whether that score is settled. Nine points
 * with everyone done is a different position from nine with three still to
 * kick off, and the squad view had no way to say which.
 *
 * The order of the checks is the same one `squadMatchState` uses and matters
 * for the same reason: a man on the pitch who also has a second match later is
 * PLAYING, not waiting. `todo` reports the earliest fixture that has not
 * started, so the caller can name a kick-off time for it.
 *
 * `minutes` is `live.elements[].stats.minutes`, a GAMEWEEK TOTAL. In a double
 * that is the sum across both legs, so a finished double reads its combined
 * minutes — true, if surprising. It is deliberately not split: `explain`
 * carries no per-fixture minutes, and inventing a split is the kind of
 * estimate this file has three shipped defects from.
 */
export type PlayerMatchStatus =
  | { state: "live"; minutes: number }
  | { state: "done"; minutes: number }
  | { state: "dnp" }
  | { state: "todo"; fixture: Fixture }
  | { state: "blank" };

export function playerMatchStatus(
  fixtures: Fixture[],
  minutes: number | null | undefined
): PlayerMatchStatus {
  if (fixtures.length === 0) return { state: "blank" };
  const mins = typeof minutes === "number" && Number.isFinite(minutes) ? minutes : 0;
  if (fixtures.some((f) => isInPlay(f))) return { state: "live", minutes: mins };
  const todo = fixtures
    .filter((f) => !f.started)
    .sort((a, b) => (a.kickoff_time ?? "").localeCompare(b.kickoff_time ?? ""))[0];
  if (todo) return { state: "todo", fixture: todo };
  return mins > 0 ? { state: "done", minutes: mins } : { state: "dnp" };
}

/**
 * A fixture's score derived from the LIVE feed rather than from `fixtures/`.
 *
 * MEASURED, probe run 32766378058, on Fulham's equaliser against Chelsea:
 *
 *   19:26:19  fixtures 0-1   live-derived 1-1   fx age 224s, live age 56s
 *   19:26:39  fixtures 0-1   live-derived 1-1   fx age 244s
 *   19:26:59  fixtures 0-1   live-derived 1-1   fx age 264s
 *   19:27:19  fixtures 0-1   live-derived 1-1   fx age 284s
 *   19:27:39  fixtures 1-1   live-derived 1-1   fx age 4s   <- window turned over
 *
 * The live feed carried the goal for at least 80 seconds — four consecutive
 * samples — before `fixtures/` did, and `fixtures/` only caught up at the
 * instant its 300-second cache window rolled. That is the whole gap: FPL holds
 * `fixtures/` for 300s and `event/{gw}/live/` for about 90.
 *
 * The arithmetic was validated separately, on the nine played GW1 fixtures —
 * 25 goals including a 0-1, a 2-2 and a 4-0 — reproducing `team_h_score` and
 * `team_a_score` exactly on every sample (run 32661146740). `own_goals` counts
 * for the OPPONENT, which is the term a naive sum gets wrong.
 *
 * NOT `Math.max` WITH THE PUBLISHED SCORE, which is what `matchMinute` does
 * with the clock and would be wrong here. Minutes only ever increase; goals do
 * not — VAR takes them away. A max would make a disallowed goal permanent.
 *
 * NULL UNTIL THE FEED HAS SAID ANYTHING ABOUT THIS FIXTURE. `explain` is empty
 * for a match FPL has not pushed stats for yet, and an empty sum is 0-0 — which
 * would erase a real scoreline rather than defer to it. The same trap
 * `provisionalBonus` documents: "no rows for this fixture" is not "nothing has
 * happened". The caller falls back to the published score.
 */
export function liveFixtureScore(
  live: EventLive | null,
  fixture: Fixture,
  elements: Map<number, Element>
): { h: number; a: number } | null {
  if (!live) return null;
  let sawFixture = false;
  let h = 0;
  let a = 0;
  for (const el of live.elements ?? []) {
    const club = elements.get(el.id)?.team;
    if (club == null) continue;
    for (const leg of el.explain ?? []) {
      if (leg.fixture !== fixture.id) continue;
      sawFixture = true;
      const own = club === fixture.team_h;
      for (const st of leg.stats ?? []) {
        const v = typeof st.value === "number" && Number.isFinite(st.value) ? st.value : 0;
        // A goal counts for the scorer's club; an own goal for the opponent.
        if (st.identifier === "goals_scored") {
          if (own) h += v;
          else a += v;
        } else if (st.identifier === "own_goals") {
          if (own) a += v;
          else h += v;
        }
      }
    }
  }
  return sawFixture ? { h, a } : null;
}
