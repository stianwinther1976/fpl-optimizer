import { afterEach, describe, expect, it } from "vitest";
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
