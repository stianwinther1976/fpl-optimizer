/*
 * WHAT DOES THIS APP ACTUALLY SAY ABOUT THE COMING GAMEWEEK?
 *
 * Asked how the app's view compares with a newspaper's gameweek preview. The
 * app's view only exists in a browser, so there was no way to put the two side
 * by side without reading it off a phone. This runs the shipped projection on
 * a runner and prints it.
 *
 * TWO THINGS MAKE IT FAITHFUL RATHER THAN INDICATIVE, and both were the whole
 * difficulty:
 *
 *  - `projectAll` is imported, never reimplemented. A harness that re-derives
 *    the model proves its own arithmetic against itself — the trap
 *    `score-probe.mjs` records and `bandscore.test.ts` already avoids.
 *  - RECENT FORM IS INCLUDED. `fetchRecentForm` is the best minutes predictor
 *    the app has, and a projection without it is a different model from the one
 *    the reader sees — so quoting it as "the app's answer" would be false. It
 *    fetches through relative `/api/fpl/...` URLs that only resolve in a
 *    browser, so `fetch` is shimmed to send those at FPL directly. The shipped
 *    function then runs unmodified, including its `played` row filter, which is
 *    itself worth a measured 7.1% on a nailed starter.
 *
 * NOT part of `npm test`: it needs the network. Run it with
 *
 *   npx vitest run -c vitest.gwview.config.ts --reporter=verbose --silent=false
 */
import { describe, it } from "vitest";
import { projectAll, type PlayerXp } from "@/lib/xp";
import { fetchRecentForm, fetchPastSeason } from "@/lib/fpl";
import { POSITION_NAMES } from "@/lib/rules";
import type { Bootstrap, Element, Fixture } from "@/lib/types";

const FPL = "https://fantasy.premierleague.com/api";

/*
 * The shim. `fpl.ts` builds `/api/fpl/<path>` because in production that is the
 * app's own proxy; on a runner there is no origin to resolve it against. This
 * sends exactly those requests upstream and leaves every other fetch alone.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("/api/fpl/")) {
    return realFetch(`${FPL}/${url.slice("/api/fpl/".length)}`, init);
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

async function get<T>(path: string): Promise<T> {
  const res = await realFetch(`${FPL}/${path}`, {
    headers: { "User-Agent": "fpl-optimizer gw view (personal, non-commercial)" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const money = (e: Element) => `£${(e.now_cost / 10).toFixed(1)}m`;

describe("the app's own view of the coming gameweek", () => {
  it("prints what the shipped model projects", async () => {
    const [boot, fixtures] = await Promise.all([
      get<Bootstrap>("bootstrap-static/"),
      get<Fixture[]>("fixtures/"),
    ]);

    const next =
      boot.events.find((e) => e.is_next)?.id ??
      (boot.events.find((e) => e.is_current)?.id ?? 0) + 1;
    const byId = new Map<number, Element>(boot.elements.map((e) => [e.id, e]));
    const teamOf = new Map(boot.teams.map((t) => [t.id, t.short_name]));
    console.log(`\n=== GW${next} — projected by the shipped model ===`);

    // Opponent per club this gameweek, so a line explains itself.
    const opp = new Map<number, string>();
    for (const f of fixtures.filter((f) => f.event === next)) {
      opp.set(f.team_h, `${teamOf.get(f.team_a)} (H)`);
      opp.set(f.team_a, `${teamOf.get(f.team_h)} (A)`);
    }

    // PASS 1 picks who is worth the element-summary round trip; PASS 2 is the
    // projection that gets quoted. 600 summaries would be 600 requests.
    const first = projectAll({
      bootstrap: boot,
      fixtures,
      nextEvent: next,
      pastSeason: undefined,
    });
    const shortlist = [...first.values()]
      .sort((a, b) => b.next - a.next)
      .slice(0, 150)
      .map((p) => p.elementId);
    /*
     * BOTH MODEL INPUTS, off the SAME documents. `fetchSummaries` sits under
     * these two and fetches each player's element-summary once, so asking for
     * recent form and last season's record costs one round trip per player
     * rather than two. Leaving `pastSeason` out would be the same falsehood as
     * leaving recent form out — CLAUDE.md records it as a defect that has
     * already happened once per input.
     */
    console.log(`fetching element summaries for the top ${shortlist.length}…`);
    const recentForm = await fetchRecentForm(shortlist);
    const past = await fetchPastSeason(shortlist);
    console.log(
      `recent form held for ${recentForm.size}; last season for ${past.data.size}` +
        `${past.failed > 0 ? ` (${past.failed} failed)` : ""}\n`
    );

    const xp = projectAll({
      bootstrap: boot,
      fixtures,
      nextEvent: next,
      recentForm,
      pastSeason: past.data,
    });
    const rows = [...xp.values()]
      .filter((p) => shortlist.includes(p.elementId))
      .sort((a, b) => b.next - a.next);

    const line = (p: PlayerXp, rank?: number) => {
      const e = byId.get(p.elementId)!;
      return (
        `${rank != null ? String(rank).padStart(3) + ". " : "     "}` +
        `${e.web_name.padEnd(16)} ${POSITION_NAMES[e.element_type as 1 | 2 | 3 | 4].padEnd(4)} ` +
        `${(teamOf.get(e.team) ?? "?").padEnd(4)} ${money(e).padStart(7)}  ` +
        `xP ${p.next.toFixed(2).padStart(5)}  own ${String(e.selected_by_percent).padStart(5)}%  ` +
        `vs ${opp.get(e.team) ?? "—"}`
      );
    };

    console.log("--- CAPTAINCY / top 20 by next-gameweek xP ---");
    rows.slice(0, 20).forEach((p, i) => console.log(line(p, i + 1)));

    for (const pos of [1, 2, 3, 4] as const) {
      console.log(`\n--- best ${POSITION_NAMES[pos]} ---`);
      rows
        .filter((p) => byId.get(p.elementId)!.element_type === pos)
        .slice(0, 8)
        .forEach((p, i) => console.log(line(p, i + 1)));
    }

    /*
     * THE COMPARISON ITSELF. Set NAMES to a comma-separated list — whoever a
     * preview is talking about — and the app's own number for each is printed
     * beside its rank, including the ones it does not rate. Silence about a
     * player the press is pushing is the interesting case, so a name that
     * matches nothing is reported rather than skipped.
     */
    const names = (process.env.NAMES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length > 0) {
      console.log("\n=== what the app says about the names asked about ===");
      for (const name of names) {
        const hit = [...xp.values()]
          .map((p) => ({ p, e: byId.get(p.elementId)! }))
          .filter(
            ({ e }) =>
              e.web_name.toLowerCase().includes(name.toLowerCase()) ||
              `${e.first_name} ${e.second_name}`.toLowerCase().includes(name.toLowerCase())
          )
          .sort((a, b) => b.p.next - a.p.next)[0];
        if (!hit) {
          console.log(`  ${name.padEnd(18)} — no such player in bootstrap`);
          continue;
        }
        const rank = rows.findIndex((r) => r.elementId === hit.p.elementId);
        console.log(
          `  ${line(hit.p)}  ${rank >= 0 ? `[app rank ${rank + 1}]` : "[outside the top 150]"}`
        );
      }
    }
  });
});
