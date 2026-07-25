// Which players are worth a per-player history lookup before drafting.

import type { Element } from "./types";

/**
 * Which players to pull last-season records for before drafting a launch squad.
 *
 * Price alone is the wrong filter here: a £100m squad is decided as much by
 * which £4.0m defender actually starts as by which premium forward to captain,
 * and the cheap end is exactly where "does he play at all?" is unknown. So the
 * pool interleaves several rankings per position, filling a fixed quota.
 *
 * Crucially, none of the rankings may depend on a field FPL wipes before GW1.
 * Ranking by the bootstrap's `starts` looked right in July and would have
 * degenerated into "the first N players by id" in August — silently, and
 * precisely when the feature matters most. Ownership and price movement survive
 * the reset, and they carry something no stored statistic does: five weeks of
 * managers reacting to pre-season friendlies and team news.
 */
export function launchPool(all: Element[]): number[] {
  const alive = all.filter(
    (e) => e.element_type >= 1 && e.element_type <= 4 && e.status !== "u" && e.status !== "n"
  );
  // Rough shape of a realistic candidate list, by position.
  const quota: Record<number, number> = { 1: 16, 2: 70, 3: 80, 4: 44 };
  const rankings: ((e: (typeof alive)[number]) => number)[] = [
    (e) => e.now_cost,
    (e) => parseFloat(e.selected_by_percent) || 0,
    (e) => e.starts ?? 0,
    (e) => e.cost_change_start ?? 0,
  ];
  const ids = new Set<number>();
  for (const pos of [1, 2, 3, 4]) {
    const inPos = alive.filter((e) => e.element_type === pos);
    const sorted = rankings.map((r) => [...inPos].sort((a, b) => r(b) - r(a)));
    // Round-robin so the quota is met exactly, whatever the overlap between
    // rankings — and so a ranking that has gone flat costs coverage, not slots.
    const cursor = new Array(sorted.length).fill(0);
    const target = Math.min(quota[pos], inPos.length);
    let picked = 0;
    while (picked < target) {
      let advanced = false;
      for (let r = 0; r < sorted.length && picked < target; r++) {
        while (cursor[r] < sorted[r].length && ids.has(sorted[r][cursor[r]].id)) cursor[r]++;
        if (cursor[r] >= sorted[r].length) continue;
        ids.add(sorted[r][cursor[r]++].id);
        picked++;
        advanced = true;
      }
      if (!advanced) break;
    }
  }
  return [...ids];
}

