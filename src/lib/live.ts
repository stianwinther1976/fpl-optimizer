// Live-gameweek helpers: provisional bonus from BPS, auto-substitution
// projection and live match state.

import type { Bootstrap, Element, EventLive, Fixture, Pick } from "./types";
import { isValidFormation } from "./rules";

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
  const statOf = new Map(live.elements.map((e) => [e.id, e.stats]));

  for (const f of fixtures) {
    if (f.event !== event) continue;
    if (!f.started || f.finished) continue; // only project while in play / awaiting confirmation
    const players = live.elements
      .filter((e) => {
        const t = teamOf.get(e.id);
        return (t === f.team_h || t === f.team_a) && (statOf.get(e.id)?.minutes ?? 0) > 0;
      })
      .map((e) => ({ id: e.id, bps: e.stats.bps }))
      .sort((a, b) => b.bps - a.bps);
    if (players.length === 0) continue;

    // Group by bps value, award 3/2/1 with tie-sharing.
    let bonus = 3;
    let i = 0;
    while (i < players.length && bonus > 0) {
      const tied = players.filter((p) => p.bps === players[i].bps);
      for (const p of tied) {
        byElement.set(p.id, Math.max(byElement.get(p.id) ?? 0, bonus));
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
  picks: Pick[],
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

/** Approximate match minute from kickoff time (display only). */
export function matchMinute(f: Fixture, now: Date = new Date()): string {
  if (f.finished) return "FT";
  if (!f.started || !f.kickoff_time) return "";
  const mins = Math.floor((now.getTime() - new Date(f.kickoff_time).getTime()) / 60000);
  if (mins <= 0) return "KO";
  if (mins >= 45 && mins <= 60) return "HT~";
  const capped = Math.min(mins > 60 ? mins - 15 : mins, 90); // rough half-time adjustment
  return `${capped}'`;
}
