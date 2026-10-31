/*
 * WHAT DOES THE APP SAY ABOUT ONE SPECIFIC TEAM, RIGHT NOW?
 *
 * `gwview.test.ts` prints the model's view of the gameweek — the best players
 * in the game. That is the wrong question when the reader already owns fifteen
 * of them and has two hours to the deadline. This prints the app's answer for
 * an entry id: the squad with its projections, the best XI and captain, the
 * transfer plans with their gain over doing nothing, the chip advice, and the
 * six-gameweek plan.
 *
 * FAITHFUL, NOT INDICATIVE, and that is the whole difficulty:
 *
 *  - `loadTeamData`, `optimize` and `planHorizon` are IMPORTED. A harness that
 *    rebuilds the squad state or re-derives the objective proves its own
 *    arithmetic against itself — the trap `score-probe.mjs` records and
 *    `bandscore.test.ts` avoids.
 *  - The argument lists are copied from `OptimizePanel`'s `run()` and
 *    `runPlan()`, INCLUDING the shortlist `loadRecentForm` builds. Recent form
 *    and last season's record are each worth a documented amount, and a
 *    projection missing either is a different model from the one on screen, so
 *    quoting it as "the app's answer" would be false.
 *
 * It runs on a runner because the sandbox cannot reach
 * fantasy.premierleague.com. It reads only the official public API, writes
 * nothing and publishes nothing.
 *
 *   FPL_ENTRY_ID=<id> npx vitest run -c vitest.squadplan.config.ts \
 *     --reporter=verbose --silent=false
 */
import { describe, it, expect } from "vitest";
import { loadTeamData, fetchRecentForm, fetchPastSeason } from "@/lib/fpl";
import { optimize, planHorizon, type BestXi, type TransferMove } from "@/lib/optimizer";
import { projectAll } from "@/lib/xp";
import { launchPool } from "@/lib/pool";
import { POSITION_NAMES } from "@/lib/rules";
import type { Element, Fixture } from "@/lib/types";

const FPL = "https://fantasy.premierleague.com/api";

/*
 * The shim, identical in purpose to `gwview.test.ts`'s. `fpl.ts` builds
 * `/api/fpl/<path>` because in production that is the app's own proxy; on a
 * runner there is no origin to resolve it against.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("/api/fpl/")) {
    return realFetch(`${FPL}/${url.slice("/api/fpl/".length)}`, init);
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const money = (tenths: number) => `£${(tenths / 10).toFixed(1)}m`;

describe("the app's own answer for one team", () => {
  it("prints the squad, the XI, the transfers and the plan", async () => {
    const entryId = Number(process.env.FPL_ENTRY_ID);
    expect(Number.isFinite(entryId) && entryId > 0, "FPL_ENTRY_ID must be set").toBe(true);

    const data = await loadTeamData(entryId);
    const squad = data.squad;
    expect(squad, "no squad came back for that entry").not.toBeNull();
    const nextEvent = squad!.nextEvent;
    expect(nextEvent, "no upcoming gameweek").not.toBeNull();

    const teamOf = new Map(data.bootstrap.teams.map((t) => [t.id, t.short_name]));

    // Opponent per club this gameweek, so every line explains itself.
    const opp = new Map<number, string>();
    for (const f of data.fixtures.filter((f: Fixture) => f.event === nextEvent)) {
      opp.set(f.team_h, `${teamOf.get(f.team_a)} (H)`);
      opp.set(f.team_a, `${teamOf.get(f.team_h)} (A)`);
    }

    console.log(`\n=== ${data.entry.name} — entry ${entryId} ===`);
    console.log(
      `GW${nextEvent} · bank ${money(squad!.bank)} · ${squad!.freeTransfers} free transfer(s)` +
        ` · chips used: ${(data.history?.chips ?? []).map((c) => `${c.name} GW${c.event}`).join(", ") || "none"}`
    );

    /*
     * THE SHORTLIST `OptimizePanel.loadRecentForm` BUILDS, copied term for
     * term. The squad's own fifteen plus the top fifteen per position off a
     * preliminary projection that already has last season's record — without
     * which a summer signing projects near zero, misses the shortlist, and
     * then has no recent-form evidence either. That note is in the panel.
     */
    /*
     * WALL CLOCK PER PHASE, AND A CONTENT CHECK ON BOTH MODEL INPUTS.
     *
     * The first run reported 393 element summaries fetched in 487 ms and the
     * whole test in 1.25 s, which is too fast to believe over a network. A
     * map's SIZE does not establish that it holds anything: `fetchPastSeason`
     * writes a record for every player it looked at, including one with no
     * history at all, because "we looked and there is nothing" is itself the
     * signal that separates a new signing from a benched squad player. So a
     * run where every fetch returned an empty document would report 393 held,
     * 0 failed, and project a different model from the one the app ships —
     * which is exactly the falsehood this harness's own header warns against.
     *
     * Hence: elapsed milliseconds, and how many of the records are NON-EMPTY.
     */
    const t0 = Date.now();
    const pool = launchPool(data.bootstrap.elements);
    console.log(`fetching last season's record for ${pool.length} players (launchPool)…`);
    const past = await fetchPastSeason(pool);
    const tPast = Date.now();

    const prelim = projectAll({
      bootstrap: data.bootstrap,
      fixtures: data.fixtures,
      nextEvent: nextEvent!,
      pastSeason: past.data,
    });
    const ids = new Set<number>(squad!.players.map((p) => p.element.id));
    for (const t of [1, 2, 3, 4]) {
      data.bootstrap.elements
        .filter((e) => e.element_type === t && e.status !== "u")
        .sort(
          (a, b) =>
            (prelim.get(b.id)?.totalDiscounted ?? 0) - (prelim.get(a.id)?.totalDiscounted ?? 0)
        )
        .slice(0, 15)
        .forEach((e) => ids.add(e.id));
    }
    console.log(`fetching recent line-ups for ${ids.size}…`);
    const recentForm = await fetchRecentForm([...ids], 5, 8);
    const tForm = Date.now();

    const withSeasons = [...past.data.values()].filter((p) => (p.plSeasons ?? 0) > 0).length;
    const withMinutes = [...past.data.values()].filter(
      (p) => (p.lastSeason?.minutes ?? 0) > 0
    ).length;
    const withStarts = [...recentForm.values()].filter((r) => r.minsPerStart != null).length;
    console.log(
      `last season: ${past.data.size} held, ${past.failed} failed, ` +
        `${withSeasons} with a PL season on record, ${withMinutes} with minutes — ${tPast - t0} ms`
    );
    console.log(
      `recent form: ${recentForm.size} held, ${withStarts} with a start in the last 5 — ` +
        `${tForm - tPast} ms`
    );
    /*
     * THE ASSERTION IS THE POINT. A silent empty input is the failure mode
     * that makes the whole print misleading, so the harness fails rather than
     * reporting numbers nobody should act on. Both floors are deliberately
     * loose: they distinguish "the feed answered" from "nothing came back",
     * and are not tuned to anything.
     */
    expect(withMinutes, "last season's record came back empty").toBeGreaterThan(50);
    expect(withStarts, "recent form came back empty").toBeGreaterThan(10);

    // A SPOT CHECK A HUMAN CAN READ, because an aggregate can still be wrong
    // in a way a count cannot show.
    for (const p of squad!.players.slice(0, 3)) {
      const id = p.element.id;
      console.log(
        `  check ${p.element.web_name.padEnd(16)} ` +
          `recentForm=${JSON.stringify(recentForm.get(id) ?? null)} ` +
          `lastSeason=${JSON.stringify(past.data.get(id)?.lastSeason ?? null)}`
      );
    }
    console.log("");

    const res = optimize({
      bootstrap: data.bootstrap,
      fixtures: data.fixtures,
      owned: squad!.players,
      bank: squad!.bank,
      freeTransfers: squad!.freeTransfers,
      nextEvent: nextEvent!,
      horizon: 5,
      recentForm,
      pastSeason: past.data,
      usedChips: data.history?.chips ?? [],
    });

    const row = (e: Element, xp: number, tag = "") =>
      `  ${tag.padEnd(4)}${e.web_name.padEnd(16)} ${POSITION_NAMES[e.element_type as 1 | 2 | 3 | 4].padEnd(4)} ` +
      `${(teamOf.get(e.team) ?? "?").padEnd(4)} ${money(e.now_cost).padStart(7)}  ` +
      `xP ${xp.toFixed(2).padStart(5)}  ` +
      `${(e.status !== "a" ? `[${e.status}${e.chance_of_playing_next_round != null ? ` ${e.chance_of_playing_next_round}%` : ""}]` : "").padEnd(10)}` +
      `vs ${opp.get(e.team) ?? "— (blank)"}`;

    const showXi = (xi: BestXi, label: string) => {
      console.log(
        `\n--- ${label}: ${xi.formation.join("-")} · ${xi.totalXp.toFixed(2)} xP (captain doubled) ---`
      );
      for (const s of xi.starters) {
        console.log(row(s.element, s.xp, s.isCaptain ? "(C) " : s.isVice ? "(V) " : ""));
      }
      console.log("  bench (sub GK first):");
      for (const s of xi.bench) console.log(row(s.element, s.xp, "   "));
    };

    console.log("--- YOUR FIFTEEN, as the model sees them ---");
    [...squad!.players]
      .map((p) => ({ e: p.element, x: res.xp.get(p.element.id) }))
      .sort((a, b) => (b.x?.next ?? 0) - (a.x?.next ?? 0))
      .forEach(({ e, x }) =>
        console.log(
          row(e, x?.next ?? 0) + `   h${x?.perGw.size ?? 0} ${(x?.totalDiscounted ?? 0).toFixed(1)}`
        )
      );

    showXi(res.keepXi, "BEST XI IF YOU DO NOTHING");

    console.log("\n--- CAPTAIN ORDER (next GW xP) ---");
    res.captainRanking.slice(0, 6).forEach((s, i) => {
      const read = res.captainReads.get(s.element.id);
      // The whole `Element` rides inside a `CaptainRead`, so dumping the object
      // buried the five lines that matter under five hundred fields.
      console.log(
        `  ${i + 1}. ${s.element.web_name.padEnd(16)} ${s.xp.toFixed(2).padStart(5)} xP` +
          `${read ? `   owned ${read.ownership != null ? `${(read.ownership * 100).toFixed(1)}%` : "—"}  ${read.klass}${read.wasTemplateCaptain ? "  (was template captain)" : ""}` : ""}`
      );
    });

    const moves = (ms: TransferMove[]) =>
      ms
        .map(
          (m) =>
            `${m.out.web_name} (${teamOf.get(m.out.team)}, sell ${money(m.outSell)}) → ` +
            `${m.in.web_name} (${teamOf.get(m.in.team)}, ${money(m.inCost)})`
        )
        .join("; ") || "no move";

    console.log(`\n(optimize took ${Date.now() - tForm} ms)`);
    console.log(
      `\n--- TRANSFERS over ${5} GWs · keep-the-team scores ${res.keepHorizonPlainXp.toFixed(1)} plain xP ---`
    );
    for (const p of res.plans) {
      console.log(
        `  ${p.transfers.length} transfer(s), hit ${p.hitCost}:  gain vs keeping ` +
          `${p.gainVsKeep >= 0 ? "+" : ""}${p.gainVsKeep.toFixed(2)} plain xP`
      );
      console.log(`      ${moves(p.transfers)}`);
      console.log(`      next-GW XI after the move: ${p.nextXi.totalXp.toFixed(2)} xP`);
    }

    console.log("\n--- CHIPS ---");
    for (const c of res.chipAdvice) {
      console.log(`  ${c.label.padEnd(16)} gain ${c.projectedGain.toFixed(2)}  ${c.detail}`);
      console.log(`      timing: ${JSON.stringify(c.timing)}`);
    }

    const plan = planHorizon({
      bootstrap: data.bootstrap,
      fixtures: data.fixtures,
      owned: squad!.players,
      bank: squad!.bank,
      freeTransfers: squad!.freeTransfers,
      nextEvent: nextEvent!,
      horizon: 6,
      recentForm,
      pastSeason: past.data,
    });
    console.log(
      `\n--- SIX-GAMEWEEK PLAN · ${plan.plainTotalXp.toFixed(1)} plain xP vs ` +
        `${plan.plainKeepXp.toFixed(1)} for doing nothing (gain ${plan.gainVsKeep >= 0 ? "+" : ""}${plan.gainVsKeep.toFixed(2)}), ` +
        `${plan.totalHits} points of hits ---`
    );
    for (const s of plan.steps) {
      console.log(
        `  GW${s.gw}  ft ${s.ftBefore}  hit ${s.hit}  bank ${money(s.bankAfter)}  ` +
          `XI ${s.xi.totalXp.toFixed(1)} xP${s.note ? `  (${s.note})` : ""}`
      );
      console.log(`      ${moves(s.transfers)}`);
      if (s.alternative) {
        console.log(
          `      runner-up: ${moves(s.alternative.transfers)}  (costs ${s.alternative.costPlain.toFixed(2)} over the horizon)`
        );
      }
    }
  });
});
