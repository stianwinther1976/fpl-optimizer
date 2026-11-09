/*
 * HOW LOW CAN "AVERAGE MISS" GO AT ALL?
 *
 * Asked, looking at the Model-accuracy card: ten graded gameweeks, mean
 * absolute error between 1.75 and 2.27, no direction. Why doesn't it improve?
 *
 * The card cannot answer that, because it reports the model's error against
 * nothing. A number with no scale invites the reader to assume the scale is
 * zero — that a perfect model would score 0.00 — and for a quantity as lumpy
 * as a footballer's weekly FPL return that is wrong by about two points.
 *
 * So this measures the SCALE, from the official API only, over the same
 * gameweeks the card grades. It does not touch the app's model at all and
 * deliberately imports nothing from `src/lib/xp.ts`: the question is what the
 * OUTCOME distribution permits, which is a fact about football and is true
 * whatever the projection is.
 *
 * Four reference predictors, in order of how much they are allowed to cheat:
 *
 *  - zero        predict 0 for everybody. The floor under the floor.
 *  - pooled mean predict the population's own mean, the same number for all.
 *  - running     predict each player's mean over the gameweeks BEFORE this
 *                one. Causal: a real model could compute it.
 *  - ORACLE      predict each player's mean over ALL ten gameweeks, including
 *                this one. NOT causal and not attainable — it is handed the
 *                answer sheet. It is the interesting line: no predictor that
 *                assigns one number per player per week, without knowing what
 *                happens in that week's matches, can beat it by much.
 *
 * POPULATION MATTERS AND IS NOT ASSUMED. `applyGwOutcome` grades only players
 * it predicted at least `CAL_CONFIG.minPred` for, which came to 306–342 of
 * them on the reported card. Taking all ~700 elements would put hundreds of
 * non-playing squad fillers on a flat 0 into the average and drag every figure
 * down, so this sweeps an appearance threshold and prints the population size
 * beside every row. Compare the row whose N is closest to the card's, and the
 * sweep shows how much the choice is worth.
 *
 * On a runner because the sandbox cannot reach fantasy.premierleague.com.
 * Reads only the official public API, writes nothing, publishes nothing.
 */
import { describe, it, expect } from "vitest";
import type { Bootstrap, EventLive } from "@/lib/types";

const FPL = "https://fantasy.premierleague.com/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${FPL}/${path}`, {
    headers: { "User-Agent": "fpl-optimizer accuracy floor (personal, non-commercial)" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

describe("what the average miss could be at best", () => {
  it("prices the model's error against predictors that cannot be beaten", async () => {
    const boot = await get<Bootstrap>("bootstrap-static/");
    const finished = boot.events.filter((e) => e.finished).map((e) => e.id);
    expect(finished.length, "no finished gameweeks to measure").toBeGreaterThan(1);
    const gws = finished.slice(-12);
    console.log(`\n=== graded window: GW${gws[0]}–GW${gws[gws.length - 1]} (${gws.length} gameweeks) ===`);

    const lives = await Promise.all(gws.map((g) => get<EventLive>(`event/${g}/live/`)));

    /** elementId -> points per gameweek, index-aligned with `gws`. */
    const pts = new Map<number, number[]>();
    /** elementId -> gameweeks with any minutes. */
    const apps = new Map<number, number>();
    for (const e of boot.elements) {
      pts.set(e.id, new Array(gws.length).fill(0));
      apps.set(e.id, 0);
    }
    lives.forEach((live, i) => {
      for (const el of live.elements) {
        const row = pts.get(el.id);
        if (!row) continue;
        row[i] = el.stats.total_points ?? 0;
        if ((el.stats.minutes ?? 0) > 0) apps.set(el.id, (apps.get(el.id) ?? 0) + 1);
      }
    });

    const header =
      "  min apps   N     mean pts    zero   pooled  running   ORACLE";
    console.log(`\n${header}`);
    console.log("  " + "-".repeat(header.length - 2));

    for (const minApps of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const pop = boot.elements.filter((e) => (apps.get(e.id) ?? 0) >= minApps);
      if (pop.length === 0) continue;

      const all: number[] = [];
      for (const e of pop) all.push(...pts.get(e.id)!);
      const pooled = mean(all);

      const errZero: number[] = [];
      const errPooled: number[] = [];
      const errRunning: number[] = [];
      const errOracle: number[] = [];

      for (const e of pop) {
        const row = pts.get(e.id)!;
        const own = mean(row);
        for (let i = 0; i < row.length; i++) {
          errZero.push(Math.abs(row[i]));
          errPooled.push(Math.abs(row[i] - pooled));
          errOracle.push(Math.abs(row[i] - own));
          // Causal: only the weeks strictly before this one. The first
          // gameweek has no history, so it falls back to the pooled mean —
          // which is what any real model without last season's record does.
          const prior = row.slice(0, i);
          errRunning.push(Math.abs(row[i] - (prior.length > 0 ? mean(prior) : pooled)));
        }
      }

      console.log(
        `  ${String(minApps).padStart(8)} ${String(pop.length).padStart(5)} ` +
          `${pooled.toFixed(2).padStart(10)}  ` +
          `${mean(errZero).toFixed(2).padStart(6)}  ` +
          `${mean(errPooled).toFixed(2).padStart(6)}  ` +
          `${mean(errRunning).toFixed(2).padStart(7)}  ` +
          `${mean(errOracle).toFixed(2).padStart(7)}`
      );
    }

    /*
     * AND THE SAME ORACLE PER GAMEWEEK, because the card's rows are per
     * gameweek and a reader comparing one row against one aggregate would be
     * comparing two different things. If the oracle's own figure swings as
     * much week to week as the model's does, that swing is the fixture list
     * and the scoring, not the model changing quality.
     */
    const popRef = boot.elements.filter((e) => (apps.get(e.id) ?? 0) >= 5);
    const refPooled = mean(popRef.flatMap((e) => pts.get(e.id)!));
    console.log(`\n--- per gameweek, population = ${popRef.length} players with 5+ appearances ---`);
    console.log("  GW    mean pts   ORACLE miss");
    gws.forEach((g, i) => {
      const act = popRef.map((e) => pts.get(e.id)![i]);
      const err = popRef.map((e) => Math.abs(pts.get(e.id)![i] - mean(pts.get(e.id)!)));
      console.log(
        `  ${String(g).padStart(3)} ${mean(act).toFixed(2).padStart(10)} ${mean(err).toFixed(2).padStart(13)}`
      );
    });
    void refPooled;

    /*
     * WHAT A BIAS CORRECTION CAN BUY, which is the other half of the question.
     * `calibrationMultiplier` can only rescale a projection, so the most it
     * can remove is the SYSTEMATIC part of the error. At the card's reported
     * bias this prints what perfectly removing it would be worth, as a bound.
     */
    console.log("\n--- what removing a systematic bias is worth, as a bound ---");
    for (const bias of [0.05, 0.11, 0.14]) {
      console.log(
        `  a ${(bias * 100).toFixed(0)}% bias on a mean of ${refPooled.toFixed(2)} pts ` +
          `is ${(refPooled * bias).toFixed(2)} pts per player — the most a rescaling can remove`
      );
    }
  });
});
