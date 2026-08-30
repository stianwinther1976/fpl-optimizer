/*
 * WHAT DOES THE APP ACTUALLY SCORE THE RANK BAND AT?
 *
 * Reported from the app: own live score 45, FPL's gameweek average 29, and a
 * "Safety score (your rank band)" of 83. Two earlier probe runs settled half of
 * it (33317888160, 33318074241, GW2 2026-08-30):
 *
 *  - the sample IS the reader's band. `page_standings` is honoured all the way
 *    down — rank 1 at page 1, 4,964,563 at page 100,000 — and the page the app
 *    asks for brackets rank 6,078,195;
 *  - the band's median live score is 36 against a published average of 29;
 *  - `Σ picks(position ≤ 11) × multiplier × live total_points` reproduces FPL's
 *    own `summary_event_points` EXACTLY on all twenty sampled entries, so the
 *    picks-to-live join is not where the inflation is;
 *  - counting all fifteen instead of the eleven raises the median from 42 to
 *    47, and the single highest entry from 42 to 70. Not enough for 83 on its
 *    own — so something else is being added, and guessing which term is how the
 *    wrong fix gets shipped.
 *
 * This runs `bandMedianScore` — the shipped function, imported, not copied —
 * over exactly the sample `LiveTab` builds, and prints every entry three ways:
 * FPL's own figure, the app's, and the difference. The per-entry rows are the
 * point: a constant offset, a multiplicative one and a handful of large
 * outliers are three different bugs.
 *
 * NOT PART OF `npm test`. It needs the network and it needs a gameweek in
 * progress to say anything. Run it on a runner:
 *
 *   npx vitest run -c vitest.band.config.ts
 */
import { describe, it } from "vitest";
import { bandMedianScore, liveEntryScore, provisionalBonus } from "@/lib/live";
import type {
  Bootstrap,
  Element,
  EntryEventPicks,
  EventLive,
  Fixture,
  LeagueStandings,
} from "@/lib/types";

const BASE = "https://fantasy.premierleague.com/api";

async function get<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BASE}/${path}`, {
    headers: {
      "User-Agent": "fpl-optimizer band score (personal, non-commercial)",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

const median = (xs: number[]): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor(s.length / 2)];
};

describe("the safety score, computed by the shipped code", () => {
  it("scores the reader's rank band the way LiveTab does", async () => {
    const ENTRY = process.env.FPL_ENTRY_ID ?? "946779";
    const LEAGUE = Number(process.env.FPL_LEAGUE_ID ?? "314");

    const boot = await get<Bootstrap>("bootstrap-static/");
    const ev = boot?.events.find((e) => e.is_current);
    if (!boot || !ev) return void console.log("no current gameweek — nothing to measure");
    const gw = ev.id;
    console.log(`GW${gw} · average_entry_score=${ev.average_entry_score} · finished=${ev.finished}`);

    const me = await get<{ summary_overall_rank: number; summary_event_points: number }>(
      `entry/${ENTRY}/`
    );
    if (!me?.summary_overall_rank) return void console.log("no overall rank yet");
    const rank = me.summary_overall_rank;
    console.log(`entry ${ENTRY}: rank=${rank} · FPL summary_event_points=${me.summary_event_points}`);

    // EXACTLY LiveTab's sampling, so a difference here is a difference there.
    const page = Math.max(1, Math.ceil(rank / 50));
    const standings = await get<LeagueStandings>(
      `leagues-classic/${LEAGUE}/standings/?page_standings=${page}`
    );
    const all = standings?.standings.results ?? [];
    const sample = all
      .filter((_, i) => i % Math.max(1, Math.floor(all.length / 20)) === 0)
      .slice(0, 20);
    console.log(`sample of ${sample.length} from page ${page}`);

    const [live, fixtures] = await Promise.all([
      get<EventLive>(`event/${gw}/live/`),
      get<Fixture[]>("fixtures/"),
    ]);
    if (!live || !fixtures) return void console.log("live feeds unavailable");

    const elementById = new Map<number, Element>(boot.elements.map((e) => [e.id, e]));
    const bonus = provisionalBonus(boot, fixtures, live, gw);
    const gwDone =
      ev.finished ||
      (fixtures.some((f) => f.event === gw) &&
        fixtures.filter((f) => f.event === gw).every((f) => f.finished));
    console.log(
      `gwDone=${gwDone} · provisional bonus map covers ${bonus.byElement.size} players`
    );

    const picks: EntryEventPicks[] = [];
    const fplSays: number[] = [];
    console.log("\n  entry     | FPL says | app says | diff | chip");
    for (const r of sample) {
      const p = await get<EntryEventPicks>(`entry/${r.entry}/event/${gw}/picks/`);
      const e = await get<{ summary_event_points: number }>(`entry/${r.entry}/`);
      if (!p || !e) continue;
      picks.push(p);
      fplSays.push(e.summary_event_points);
      const app = liveEntryScore(p, elementById, live, fixtures, gw, bonus.byElement, gwDone);
      console.log(
        `  ${String(r.entry).padEnd(9)} | ${String(e.summary_event_points).padStart(8)} | ${String(
          app
        ).padStart(8)} | ${String(app - e.summary_event_points).padStart(4)} | ${p.active_chip ?? "-"}`
      );
    }

    const appScores = picks.map((p) =>
      liveEntryScore(p, elementById, live, fixtures, gw, bonus.byElement, gwDone)
    );
    console.log(`\n  median FPL says            : ${median(fplSays)}`);
    console.log(`  median app says            : ${median(appScores)}`);
    console.log(
      `  bandMedianScore (as shipped): ${bandMedianScore(
        picks,
        elementById,
        live,
        fixtures,
        gw,
        bonus.byElement,
        gwDone
      )}`
    );
    console.log(`  FPL's published GW average : ${ev.average_entry_score}`);
    console.log(
      "\n  READ THE DIFF COLUMN: a constant offset, a multiplicative one and a few\n" +
        "  large outliers are three different bugs. FPL's figure excludes provisional\n" +
        "  bonus and nothing else, so a positive diff of a few points on a squad whose\n" +
        "  matches have ended is expected; anything larger is not."
    );
  });
});
