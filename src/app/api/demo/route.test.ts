import { describe, expect, it } from "vitest";
import { GET } from "./[...path]/route";
import { DEMO_ENTRY_ID } from "@/lib/demo";

/*
 * THE ROUTE IS THE ONLY THING THE BROWSER ACTUALLY TALKS TO.
 *
 * `demo.ts` can be as coherent as it likes; if the handler in front of it drops
 * a path segment, none of that reaches the screen. That is not hypothetical —
 * it is what happened. The handler matched `entry/{id}/event/{gw}/picks/` and
 * then called `picksFor(id)` with no gameweek, and matched `event/{gw}/live/`
 * and returned the single GW20 feed. So the Team tab's time machine drew the
 * current pitch under every past caption, and a mutation run confirmed the gap:
 * deleting the id argument entirely left the whole suite green, because nothing
 * imported this file.
 *
 * These tests call the exported handler the way Next calls it.
 */

const call = async (path: string) => {
  const res = await GET({} as never, { params: Promise.resolve({ path: path.split("/") }) });
  return { status: res.status, body: await res.json() };
};

/** Which gameweek the demo says it is in. Asking beats writing it down twice. */
const NOW_GW = await (async () => {
  const { body } = await call("bootstrap-static");
  const events = (body as { events: { id: number; is_current: boolean }[] }).events;
  return events.find((e) => e.is_current)!.id;
})();

describe("the demo API route", () => {
  it("serves the four top-level documents", async () => {
    for (const p of ["bootstrap-static", "fixtures", `entry/${DEMO_ENTRY_ID}`]) {
      const { status, body } = await call(p);
      expect({ p, status }).toEqual({ p, status: 200 });
      expect(body).toBeTruthy();
    }
    const { body: fixtures } = await call("fixtures");
    expect(Array.isArray(fixtures)).toBe(true);
    expect((fixtures as unknown[]).length).toBeGreaterThan(0);
  });

  it("honours the gameweek in the picks path", async () => {
    // THE REGRESSION. Both of these used to be the same document.
    const a = await call(`entry/${DEMO_ENTRY_ID}/event/3/picks`);
    const b = await call(`entry/${DEMO_ENTRY_ID}/event/${NOW_GW}/picks`);
    expect(a.status).toBe(200);
    expect((a.body as { entry_history: { event: number } }).entry_history.event).toBe(3);
    expect((b.body as { entry_history: { event: number } }).entry_history.event).toBe(NOW_GW);
    expect(a.body).not.toEqual(b.body);
  });

  it("honours the entry id in the picks path", async () => {
    const { body: league } = (await call("leagues-classic/900001/standings")) as {
      body: { standings: { results: { entry: number }[] } };
    };
    const rival = league.standings.results.find((r) => r.entry !== DEMO_ENTRY_ID)!;
    const mine = await call(`entry/${DEMO_ENTRY_ID}/event/${NOW_GW}/picks`);
    const theirs = await call(`entry/${rival.entry}/event/${NOW_GW}/picks`);
    const ids = (b: unknown) => (b as { picks: { element: number }[] }).picks.map((p) => p.element);
    expect(ids(theirs.body)).not.toEqual(ids(mine.body));
  });

  it("honours the gameweek in the live path", async () => {
    const a = await call("event/3/live");
    const b = await call(`event/${NOW_GW}/live`);
    expect(a.status).toBe(200);
    expect(a.body).not.toEqual(b.body);
    const els = (b2: unknown) => (b2 as { elements: unknown[] }).elements;
    expect(els(a.body).length).toBe(els(b.body).length);
  });

  it("honours the league id in the standings path", async () => {
    const demo = await call("leagues-classic/900001/standings");
    const overall = await call("leagues-classic/314/standings");
    expect(overall.status).toBe(200);
    const id = (b: unknown) => (b as { league: { id: number } }).league.id;
    expect(id(demo.body)).toBe(900001);
    expect(id(overall.body)).toBe(314);
  });

  it("gives a player's season the length his season actually has", async () => {
    const { status, body } = await call("element-summary/1");
    expect(status).toBe(200);
    const rows = (body as { history: { round: number }[] }).history;
    // Every finished gameweek, in order, and no invented twentieth.
    expect(rows.map((r) => r.round)).toEqual(
      Array.from({ length: NOW_GW - 1 }, (_, i) => i + 1)
    );
  });

  it("404s an endpoint it does not serve rather than answering with something else", async () => {
    const { status } = await call("dream-team/1");
    expect(status).toBe(404);
  });

  it("tells the browser not to cache a live document", async () => {
    const res = await GET({} as never, {
      params: Promise.resolve({ path: ["event", String(NOW_GW), "live"] }),
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
