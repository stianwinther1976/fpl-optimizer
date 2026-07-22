// Live-gameweek helpers: provisional bonus from BPS and live match state.

import type { Bootstrap, EventLive, Fixture } from "./types";

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

/** Approximate match minute from kickoff time (display only). */
export function matchMinute(f: Fixture, now: Date): string {
  if (f.finished) return "FT";
  if (!f.started || !f.kickoff_time) return "";
  const mins = Math.floor((now.getTime() - new Date(f.kickoff_time).getTime()) / 60000);
  if (mins <= 0) return "KO";
  if (mins >= 45 && mins <= 60) return "HT~";
  const capped = Math.min(mins > 60 ? mins - 15 : mins, 90); // rough half-time adjustment
  return `${capped}'`;
}
