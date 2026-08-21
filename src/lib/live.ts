// Live-gameweek helpers: provisional bonus from BPS, auto-substitution
// projection and live match state.

import type { Bootstrap, Element, EventLive, Fixture, Pick as FplPick } from "./types";
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
 * FPL awards 3/2/1 bonus to the top-BPS players per fixture. While a fixture is
 * live (or finished but not confirmed), we project bonus from current BPS.
 * Ties follow the official pattern: tied players share the higher bonus and the
 * lower slots are skipped accordingly.
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
   * both answerable per leg. BPS is not in `explain` and FPL publishes it only
   * as a gameweek total — see the abstention below.
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
    if (!f.started || f.finished) continue; // only project while in play / awaiting confirmation
    const inThis = perFixture.get(f.id);
    const players = live.elements
      .filter((e) => {
        const t = teamOf.get(e.id);
        if (t !== f.team_h && t !== f.team_a) return false;
        // Per-fixture minutes when the feed itemises them; the gameweek total
        // is the fallback for a single-fixture week, where the two agree.
        const mins = itemised ? (inThis?.get(e.id)?.minutes ?? 0) : e.stats.minutes;
        return (mins ?? 0) > 0;
      })
      .map((e) => ({ id: e.id, bps: e.stats.bps }))
      .sort((a, b) => b.bps - a.bps);
    if (players.length === 0) continue;

    /*
     * ABSTAIN WHEN THE RANKING CANNOT BE TRUSTED.
     *
     * FPL publishes BPS only as a gameweek total. If anyone on this pitch has
     * also played another fixture this gameweek, his figure includes points
     * banked elsewhere and the 3/2/1 order here is not a reading of this match.
     * Projecting a confident wrong ladder is worse than projecting nothing: the
     * reader sees provisional bonus on the wrong three players and the numbers
     * do not settle until FPL confirms.
     *
     * Single gameweeks — every gameweek most seasons — are unaffected, because
     * there the gameweek total IS this fixture's total.
     */
    if (players.some((p) => (legsPlayed.get(p.id) ?? 0) > 1)) continue;

    // Group by bps value, award 3/2/1 with tie-sharing.
    let bonus = 3;
    let i = 0;
    while (i < players.length && bonus > 0) {
      const tied = players.filter((p) => p.bps === players[i].bps);
      for (const p of tied) {
        /*
         * Accumulate rather than `Math.max`, because FPL pays each leg — and
         * note this cannot currently fire. Being credited from two legs means
         * playing two, which makes BOTH of those fixtures abstain above. The
         * `+` is here so that relaxing the abstention (if FPL ever publishes
         * per-fixture BPS) does not silently reintroduce the old bug, and this
         * comment is here so nobody writes a test for a branch that has no
         * reachable input.
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
  // A player is "done on 0" when they have fixtures this GW, every one has
  // finished, and they played 0 minutes. (No fixture at all = blank GW = done.)
  const doneOnZero = (elId: number): boolean => {
    const el = elements.get(elId);
    if (!el) return false;
    const fx = fxByTeam.get(el.team) ?? [];
    if (fx.length === 0) return true; // blank GW: cannot score
    if (!fx.every((f) => f.finished)) return false;
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
export function matchMinute(f: Fixture, now: Date = new Date()): string {
  // `finished` means BONUS CONFIRMED, not "the match has ended" — after a
  // Saturday afternoon those are hours apart, and for that whole window the
  // clock had nothing to tell it the match was over and sat on 90'.
  if (f.finished || f.finished_provisional) return "FT";
  if (!f.started || !f.kickoff_time) return "";
  // Guard the type as well as the value: this arrives from the network, and a
  // string "54" would render as "54'" by luck and NaN-poison any arithmetic a
  // later caller does on it.
  if (typeof f.minutes === "number" && Number.isFinite(f.minutes) && f.minutes > 0) {
    const m = Math.floor(f.minutes);
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
