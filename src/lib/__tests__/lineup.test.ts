import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  applyStartCall,
  pStartFor,
  loadStartCalls,
  saveStartCalls,
  activeStartCalls,
  setActiveStartCalls,
  resetStartCalls,
} from "../lineup";
import { projectAll, XP_CONFIG } from "../xp";
import { makeMockBootstrap, makeMockFixtures } from "./mockdata";

afterEach(() => resetStartCalls());

describe("what an override is allowed to claim", () => {
  it("never claims more certainty than the model's own ceiling", () => {
    // A manager naming the XI still cannot rule out a warm-up injury, and the
    // model's ceiling is exactly that residual doubt. An override that went to
    // 1.0 would assert something nobody knows.
    expect(pStartFor("starts")).toBe(XP_CONFIG.preseasonMaxPStart);
    expect(pStartFor("starts")).toBeLessThan(1);
  });

  it("uses the model's own floor for a benched player", () => {
    expect(pStartFor("benched")).toBe(XP_CONFIG.priorPStartRange[0]);
    expect(pStartFor("benched")).toBeGreaterThan(0);
  });
});

describe("applyStartCall", () => {
  const mm = { pStart: 0.5, minsPerStart: 80, share: 0.44 };

  it("raises a named starter to the ceiling", () => {
    const out = applyStartCall(mm, "starts");
    expect(out.pStart).toBe(XP_CONFIG.preseasonMaxPStart);
    expect(out.minsPerStart).toBe(80);
    expect(out.share).toBeCloseTo((XP_CONFIG.preseasonMaxPStart * 80) / 90, 9);
  });

  it("does not shrink a share the observed minutes already justify", () => {
    // Mirrors the `liftedPStart` block in projectAll: a substitute whose real
    // minutes imply a bigger share is not made smaller by being told he starts.
    const busy = { pStart: 0.5, minsPerStart: 20, share: 0.9 };
    expect(applyStartCall(busy, "starts").share).toBe(0.9);
  });

  it("lets a benched player's share fall, which is the claim being made", () => {
    // The documented asymmetry. "Not in the eleven" is a smaller statement than
    // "will not play", and a regular substitute is under-rated by it — which is
    // why the note on `applyStartCall` says to leave the override off for one.
    const out = applyStartCall(mm, "benched");
    expect(out.pStart).toBe(XP_CONFIG.priorPStartRange[0]);
    expect(out.share).toBeLessThan(mm.share);
  });

  it("keeps the three fields agreeing with each other", () => {
    for (const call of ["starts", "benched"] as const) {
      const out = applyStartCall(mm, call);
      expect(out.share).toBeLessThanOrEqual(1);
      expect(out.share).toBeGreaterThanOrEqual(0);
      expect(out.pStart).toBeLessThanOrEqual(1);
    }
  });
});

/*
 * The property that matters most: with nobody overridden, this build must
 * project exactly what it projected before the feature existed. A feature that
 * cannot be switched off has not been added, it has been imposed.
 */
describe("a projection with no overrides is unchanged", () => {
  const bootstrap = makeMockBootstrap();
  const fixtures = makeMockFixtures();
  const project = (startCalls?: Map<number, "starts" | "benched">) =>
    projectAll({ bootstrap, fixtures, nextEvent: 11, horizon: 3, pastSeason: undefined, startCalls });

  it("is identical with an empty set and with none passed at all", () => {
    const a = project();
    const b = project(new Map());
    expect(a.size).toBe(b.size);
    for (const [id, x] of a) {
      expect(b.get(id)!.total).toBeCloseTo(x.total, 12);
      expect(b.get(id)!.next).toBeCloseTo(x.next, 12);
      expect(x.startCall).toBeUndefined();
    }
  });

  it("reads the module-level set when the caller passes none", () => {
    const target = bootstrap.elements.find((e) => e.element_type === 3)!;
    const before = project().get(target.id)!.next;
    setActiveStartCalls(new Map([[target.id, "benched"]]));
    const after = projectAll({
      bootstrap, fixtures, nextEvent: 11, horizon: 3, pastSeason: undefined,
    }).get(target.id)!;
    expect(after.next).toBeLessThan(before);
    expect(after.startCall).toBe("benched");
  });
});

describe("an override moves the projection and is labelled", () => {
  const bootstrap = makeMockBootstrap();
  const fixtures = makeMockFixtures();
  const run = (calls: Map<number, "starts" | "benched">) =>
    projectAll({ bootstrap, fixtures, nextEvent: 11, horizon: 3, pastSeason: undefined, startCalls: calls });

  const target = bootstrap.elements.find((e) => e.element_type === 3)!;

  it("benching a player lowers his projection and starting him raises it", () => {
    const base = run(new Map()).get(target.id)!.next;
    const benched = run(new Map([[target.id, "benched"]])).get(target.id)!.next;
    const started = run(new Map([[target.id, "starts"]])).get(target.id)!.next;
    expect(benched).toBeLessThan(base);
    expect(started).toBeGreaterThan(benched);
  });

  it("never RAISES a player's projection for being told he is benched", () => {
    /*
     * `pStartFor("benched")` is the range FLOOR, 0.08. Taken neat it is not a
     * ceiling on a benched man, it is a floor under him — so anyone the model
     * already rated below 0.08 was PROMOTED by the reader saying he is out of
     * the eleven. Measured on the 2026-08-19 snapshot, one "benched" call per
     * player: 78 of 595 came out higher on the next gameweek, and the
     * population is exactly the one a reader is most likely to mark — backup
     * keepers. Arrizabalaga went 0.418 to 0.641, off a model `pStart` of
     * 0.0021.
     *
     * The test above ("benched < base, started > benched") holds under both
     * rules, which is why it could not catch this. This one asserts the
     * asymmetry the file's header actually states.
     */
    const deep = bootstrap.elements.filter((e) => e.element_type === 1);
    expect(deep.length).toBeGreaterThan(1);
    for (const e of bootstrap.elements) {
      const base = run(new Map()).get(e.id)!;
      const benched = run(new Map([[e.id, "benched"]])).get(e.id)!;
      expect(benched.next, `${e.web_name} next`).toBeLessThanOrEqual(base.next + 1e-9);
      expect(benched.total, `${e.web_name} total`).toBeLessThanOrEqual(base.total + 1e-9);
    }
  });

  it("applies each direction one-sidedly, at the level of the minutes model", () => {
    // The unit-level statement of the same rule, over the whole grid: "starts"
    // may only raise, "benched" may only lower, and neither touches how long a
    // start lasts.
    for (const pStart of [0, 0.001, 0.02, 0.08, 0.3, 0.75, 0.97, 1]) {
      for (const mps of [0, 30, 60, 75, 90]) {
        for (const share of [0, 0.01, 0.2, 0.6, 1]) {
          const mm = { pStart, minsPerStart: mps, share };
          const up = applyStartCall(mm, "starts");
          const down = applyStartCall(mm, "benched");
          expect(up.pStart).toBeGreaterThanOrEqual(pStart);
          expect(up.share).toBeGreaterThanOrEqual(share);
          expect(down.pStart).toBeLessThanOrEqual(pStart);
          expect(down.share).toBeLessThanOrEqual(share);
          expect(up.minsPerStart).toBe(mps);
          expect(down.minsPerStart).toBe(mps);
        }
      }
    }
  });

  it("never lowers a nailed player's pStart for being told he starts", () => {
    /*
     * `pStartFor("starts")` is the PRE-SEASON ceiling, 0.97. In season the model
     * clamps to 1.0, so an ever-present carries 1.0 and taking the assertion
     * neat DEMOTED him. Measured on the demo's mid-season universe before the
     * fix: 141 of 300 players sat above 0.97 and every one sampled went down.
     * `share` was already guarded one-sidedly; `pStart` was not, and it feeds
     * `p60` and `pPlay`.
     */
    const nailed = { pStart: 1, minsPerStart: 90, share: 1 };
    const after = applyStartCall(nailed, "starts");
    expect(after.pStart).toBe(1);
    expect(after.share).toBe(1);

    // A player BELOW the ceiling is still lifted to it, which is the point.
    const rotating = { pStart: 0.4, minsPerStart: 90, share: 0.4 };
    expect(applyStartCall(rotating, "starts").pStart).toBe(XP_CONFIG.preseasonMaxPStart);

    // And "benched" still takes a nailed player down: that direction asserts
    // something the model does not already know, so it is not one-sided.
    expect(applyStartCall(nailed, "benched").pStart).toBe(XP_CONFIG.priorPStartRange[0]);
  });

  it("moves a PRE-SEASON GOALKEEPER, who used to be silently exempt", () => {
    /*
     * THE FEATURE DID NOTHING FOR KEEPERS, AND SAID IT HAD.
     *
     * The call is folded into `mm` above the projection loop, but the loop then
     * took `gkMm(off) ?? mm` — and `gkMm` returns non-null for EVERY pre-season
     * keeper, so the override was overwritten at every offset including 0. The
     * post-call `mm` reached nothing but `XP_DEBUG`. Measured before the fix: a
     * deputy keeper's `next` was bit-identical with no call, with "starts" and
     * with "benched", while `PlayerXp.startCall` still reported "starts" — so
     * the app labelled a purely model-derived number as the reader's decision.
     *
     * Pre-season is exactly the window `lineup.ts` exists for, and the keeper
     * is exactly the position a reader most often has real news about.
     */
    const pre = makeMockBootstrap();
    for (const e of pre.elements) {
      e.minutes = 0;
      e.starts = 0;
      e.total_points = 0;
      e.form = "0.0";
      e.points_per_game = "0.0";
    }
    pre.events.forEach((ev) => {
      ev.finished = false;
      ev.is_current = false;
      ev.is_next = ev.id === 1;
    });
    const preFx = makeMockFixtures().map((f) => ({ ...f, event: (f.event ?? 11) - 10, finished: false }));
    const runPre = (calls: Map<number, "starts" | "benched">) =>
      projectAll({ bootstrap: pre, fixtures: preFx, nextEvent: 1, horizon: 3, pastSeason: undefined, startCalls: calls });

    // A club with more than one keeper, so the depth chart actually engages.
    const byClub = new Map<number, number[]>();
    for (const e of pre.elements) {
      if (e.element_type !== 1) continue;
      byClub.set(e.team, [...(byClub.get(e.team) ?? []), e.id]);
    }
    const club = [...byClub.values()].find((ks) => ks.length >= 2);
    expect(club).toBeDefined();
    // The deputy: the cheaper of the two, i.e. the one the chart demotes.
    const keepers = club!.map((id) => pre.elements.find((e) => e.id === id)!);
    keepers.sort((a, b) => a.now_cost - b.now_cost);
    const deputy = keepers[0];

    const base = runPre(new Map()).get(deputy.id)!.next;
    const started = runPre(new Map([[deputy.id, "starts"]])).get(deputy.id)!.next;
    const benched = runPre(new Map([[deputy.id, "benched"]])).get(deputy.id)!.next;

    // The bug made all three identical to the last bit.
    expect(started).toBeGreaterThan(base);
    expect(started).toBeGreaterThan(benched);
  });

  it("carries the call out to the caller so the UI can say who decided", () => {
    // Every other number in PlayerXp is the model's opinion. This one is the
    // reader's, and an unlabelled projection would be the app taking credit
    // for their team news.
    const r = run(new Map([[target.id, "starts"]]));
    expect(r.get(target.id)!.startCall).toBe("starts");
    for (const [id, x] of r) if (id !== target.id) expect(x.startCall).toBeUndefined();
  });

  it("touches nobody else", () => {
    const base = run(new Map());
    const one = run(new Map([[target.id, "benched"]]));
    for (const [id, x] of base) {
      if (id === target.id) continue;
      expect(one.get(id)!.next).toBeCloseTo(x.next, 12);
    }
  });
});

describe("persistence", () => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });

  it("keeps the demo's calls away from the real feed's", () => {
    // The demo numbers its players 1..300 and so do three hundred real
    // footballers. A call saved against demo id 42 must never reach real id 42.
    saveStartCalls(true, new Map([[42, "starts"]]));
    expect(loadStartCalls(false).size).toBe(0);
    expect(loadStartCalls(true).get(42)).toBe("starts");
  });

  it("drops a key that is not a player id, rather than coercing it to NaN", () => {
    /*
     * `Number("x")` is `NaN`, and a `NaN` key can never match
     * `startCalls.get(el.id)` — so it was invisible to the projection and
     * permanent everywhere else: it inflated `active.size`, which is half of
     * `startCallsVersion()`, and `setStartCall` re-persisted it as `"NaN"` on
     * the next write. The comment beside it already said keys were dropped
     * rather than coerced; only the value was.
     */
    store.set(
      "fpl-start-calls",
      JSON.stringify({ "8": "starts", x: "benched", "0": "starts", "-3": "benched", "1.5": "starts" })
    );
    expect([...loadStartCalls(false)]).toEqual([[8, "starts"]]);
  });

  it("drops a stored value it does not recognise rather than coercing it", () => {
    store.set("fpl-start-calls", JSON.stringify({ 7: "starts", 8: "maybe", 9: null }));
    const m = loadStartCalls(false);
    expect(m.get(7)).toBe("starts");
    expect(m.has(8)).toBe(false);
    expect(m.has(9)).toBe(false);
  });

  it("clears the key entirely when the last call is removed", () => {
    saveStartCalls(false, new Map([[1, "benched"]]));
    saveStartCalls(false, new Map());
    expect(store.has("fpl-start-calls")).toBe(false);
  });

  it("survives unreadable storage without throwing", () => {
    store.set("fpl-start-calls", "{not json");
    expect(loadStartCalls(false).size).toBe(0);
  });
});

describe("the active set", () => {
  it("resets to empty, so one test cannot seed the next", () => {
    setActiveStartCalls(new Map([[1, "starts"]]));
    expect(activeStartCalls().size).toBe(1);
    resetStartCalls();
    expect(activeStartCalls().size).toBe(0);
  });
});

/*
 * THE CALIBRATION MUST NOT LEARN FROM THE READER.
 *
 * `snapshotPredictions` stores a projection to be graded once the gameweek
 * finishes, and the grade moves a per-POSITION multiplier applied to every
 * player in the game. If that snapshot carried overrides, a reader who set a
 * £4.0m defender to "starts" and was wrong would teach the model that IT
 * over-rates defenders — a real correction, applied globally, sourced from
 * somebody else's mistake.
 *
 * The separation lives at the Dashboard call site, so this is a source-level
 * guard. It is pinned here rather than in componentInvariants because the
 * behaviour it protects is this module's, not the component's.
 */
describe("the calibration snapshot is taken without overrides", () => {
  it("passes an explicit empty set where it grades the model", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../components/Dashboard.tsx"),
      "utf8"
    );
    const at = src.indexOf("snapshotPredictions(");
    expect(at).toBeGreaterThan(0);
    // The projectAll that feeds it is the one immediately above.
    const before = src.slice(Math.max(0, at - 1400), at);
    const call = before.lastIndexOf("projectAll({");
    expect(call).toBeGreaterThanOrEqual(0);
    expect(before.slice(call)).toMatch(/startCalls:\s*new Map\(\)/);
  });
});
