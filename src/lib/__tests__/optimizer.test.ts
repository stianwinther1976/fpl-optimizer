import { describe, it, expect } from "vitest";
import { makeMockBootstrap, makeMockFixtures, makeMockOwned } from "./mockdata";
import { optimize, pickBestXi } from "../optimizer";
import { validateSquad } from "../rules";
import { projectAll } from "../xp";

const bootstrap = makeMockBootstrap();
const fixtures = makeMockFixtures();
const owned = makeMockOwned(bootstrap);

describe("mock universe sanity", () => {
  it("mock squad is legal", () => {
    expect(
      validateSquad(
        owned.map((o) => ({
          id: o.element.id,
          elementType: o.element.element_type,
          teamId: o.element.team,
        }))
      )
    ).toEqual([]);
  });
  it("projects positive xP for available players", () => {
    const xp = projectAll({ bootstrap, fixtures, nextEvent: 11 });
    const values = [...xp.values()].map((v) => v.total);
    expect(Math.max(...values)).toBeGreaterThan(0);
  });
});

describe("pickBestXi", () => {
  const xp = projectAll({ bootstrap, fixtures, nextEvent: 11 });
  const xi = pickBestXi(owned.map((o) => o.element), (id) => xp.get(id)?.next ?? 0);

  it("returns a legal formation with 11 starters and 4 on the bench", () => {
    const [d, m, f] = xi.formation;
    expect(1 + d + m + f).toBe(11);
    expect(xi.starters.length).toBe(11);
    expect(xi.bench.length).toBe(4);
  });
  it("bench has exactly one GK, placed last", () => {
    const benchGks = xi.bench.filter((p) => p.element.element_type === 1);
    expect(benchGks.length).toBe(1);
    expect(xi.bench[xi.bench.length - 1].element.element_type).toBe(1);
  });
  it("captain is the highest-xP starter and doubles the total", () => {
    const maxXp = Math.max(...xi.starters.map((s) => s.xp));
    expect(xi.captain?.xp).toBe(maxXp);
    const rawSum = xi.starters.reduce((s, p) => s + p.xp, 0);
    expect(xi.totalXp).toBeCloseTo(rawSum + maxXp, 5);
  });
});

describe("optimize", () => {
  const result = optimize({
    bootstrap,
    fixtures,
    owned,
    bank: 20,
    freeTransfers: 2,
    nextEvent: 11,
    horizon: 3,
    maxTransfers: 3,
    candidatesPerPosition: 12,
    beamWidth: 5,
  });

  it("produces plans for 1..3 transfers", () => {
    expect(result.plans.length).toBeGreaterThanOrEqual(1);
    for (const plan of result.plans) {
      expect(plan.transfers.length).toBeGreaterThanOrEqual(1);
      expect(plan.transfers.length).toBeLessThanOrEqual(3);
    }
  });

  it("every plan yields a legal squad within budget", () => {
    for (const plan of result.plans) {
      expect(plan.bankAfter).toBeGreaterThanOrEqual(0);
      const ids = new Set(owned.map((o) => o.element.id));
      for (const m of plan.transfers) {
        ids.delete(m.out.id);
        ids.add(m.in.id);
      }
      expect(ids.size).toBe(15);
      const els = bootstrap.elements.filter((e) => ids.has(e.id));
      expect(
        validateSquad(els.map((e) => ({ id: e.id, elementType: e.element_type, teamId: e.team })))
      ).toEqual([]);
    }
  });

  it("transfers only swap like-for-like positions", () => {
    for (const plan of result.plans) {
      for (const m of plan.transfers) {
        expect(m.in.element_type).toBe(m.out.element_type);
      }
    }
  });

  it("applies -4 hits beyond free transfers in net xP", () => {
    const three = result.plans.find((p) => p.transfers.length === 3);
    if (three) {
      expect(three.hitCost).toBe(4); // 3 transfers, 2 FTs
      expect(three.netXp).toBeCloseTo(three.grossXp - 4, 5);
    }
  });

  it("plans improve on keeping the team (gross)", () => {
    for (const plan of result.plans) {
      expect(plan.grossXp).toBeGreaterThanOrEqual(result.keepHorizonXp - 1e-9);
    }
  });

  it("dream team is legal and at least as good as current squad", () => {
    expect(
      validateSquad(
        result.dreamSquad.map((e) => ({ id: e.id, elementType: e.element_type, teamId: e.team }))
      )
    ).toEqual([]);
    const cost = result.dreamSquad.reduce((s, e) => s + e.now_cost, 0);
    expect(cost).toBeLessThanOrEqual(1000);
    expect(result.dreamTeam.totalXp).toBeGreaterThanOrEqual(result.keepXi.totalXp - 1e-9);
  });

  it("gives advice for all four chips", () => {
    expect(result.chipAdvice.map((c) => c.chip).sort()).toEqual(
      ["3xc", "bboost", "freehit", "wildcard"].sort()
    );
    for (const advice of result.chipAdvice) {
      expect(advice.projectedGain).toBeGreaterThanOrEqual(0);
    }
  });

  it("captain ranking has 5 entries sorted by xp", () => {
    expect(result.captainRanking.length).toBe(5);
    for (let i = 1; i < 5; i++) {
      expect(result.captainRanking[i - 1].xp).toBeGreaterThanOrEqual(result.captainRanking[i].xp);
    }
  });
});
