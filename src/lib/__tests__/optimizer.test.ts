import { describe, it, expect } from "vitest";
import { makeMockBootstrap, makeMockFixtures, makeMockOwned } from "./mockdata";
import { optimize, pickBestXi, buildLaunchSquad, planHorizon } from "../optimizer";
import { MAX_FREE_TRANSFERS, validateSquad } from "../rules";
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
  it("bench has exactly one GK, in slot 1 (FPL convention)", () => {
    const benchGks = xi.bench.filter((p) => p.element.element_type === 1);
    expect(benchGks.length).toBe(1);
    expect(xi.bench[0].element.element_type).toBe(1);
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

describe("xp model — opponent strength & priors", () => {
  it("continuous strength model: easier opponent yields higher xp", () => {
    const b = makeMockBootstrap();
    // Give teams a real strength spread so the continuous model activates.
    b.teams.forEach((t, i) => {
      t.strength_attack_home = 1000 + i * 15;
      t.strength_attack_away = 980 + i * 15;
      t.strength_defence_home = 1000 + i * 15;
      t.strength_defence_away = 980 + i * 15;
    });
    const el = b.elements.find((e) => e.element_type === 3 && e.minutes > 1000)!;
    const weakOpp = b.teams[19].id; // highest index = strongest per our loop? id 20 has +15*19
    const strongOpp = b.teams[0].id;
    const mkFx = (opp: number) => [{
      id: 1, event: 11, team_h: el.team, team_a: opp,
      team_h_difficulty: 3, team_a_difficulty: 3,
      kickoff_time: null, finished: false, team_h_score: null, team_a_score: null,
    }];
    const vsWeak = projectAll({ bootstrap: b, fixtures: mkFx(strongOpp), nextEvent: 11, horizon: 1 }).get(el.id)!.next;
    const vsStrong = projectAll({ bootstrap: b, fixtures: mkFx(weakOpp), nextEvent: 11, horizon: 1 }).get(el.id)!.next;
    // team index 0 has LOWEST ratings (weakest), index 19 highest (strongest)
    expect(vsWeak).toBeGreaterThan(vsStrong);
  });

  it("price prior kicks in for players with few minutes", () => {
    const b = makeMockBootstrap();
    const el = b.elements.find((e) => e.element_type === 3)!;
    el.minutes = 90; // thin data
    el.now_cost = 120; // premium price
    const cheap = b.elements.find((e) => e.element_type === 3 && e.id !== el.id)!;
    cheap.minutes = 90;
    cheap.now_cost = 45;
    // Force identical thin underlying data
    cheap.form = el.form; cheap.points_per_game = el.points_per_game;
    cheap.expected_goals = el.expected_goals; cheap.expected_assists = el.expected_assists;
    cheap.ict_index = el.ict_index; cheap.ep_next = null; el.ep_next = null;
    cheap.team = el.team;
    const xp = projectAll({ bootstrap: b, fixtures: makeMockFixtures(), nextEvent: 11, horizon: 1 });
    expect(xp.get(el.id)!.next).toBeGreaterThan(xp.get(cheap.id)!.next);
  });
});

describe("xp model — DGW/blank GWs and discounting", () => {
  it("blank GW yields zero xP (no phantom ep_next points)", () => {
    const b = makeMockBootstrap();
    const el = b.elements.find((e) => e.element_type === 3 && e.minutes > 1000)!;
    el.ep_next = "6.0";
    const fx = makeMockFixtures().filter(
      (f) => !(f.event === 11 && (f.team_h === el.team || f.team_a === el.team))
    );
    const xp = projectAll({ bootstrap: b, fixtures: fx, nextEvent: 11, horizon: 1 });
    expect(xp.get(el.id)!.next).toBe(0);
  });
  it("a double gameweek projects more than a single", () => {
    const b = makeMockBootstrap();
    const el = b.elements.find((e) => e.element_type === 3 && e.minutes > 1000)!;
    const base = makeMockFixtures();
    const single = projectAll({ bootstrap: b, fixtures: base, nextEvent: 11, horizon: 1 });
    const extra = {
      id: 9999,
      event: 11,
      team_h: el.team,
      team_a: b.teams.find((t) => t.id !== el.team)!.id,
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      kickoff_time: null,
      finished: false,
      team_h_score: null,
      team_a_score: null,
    };
    const dgw = projectAll({ bootstrap: b, fixtures: [...base, extra], nextEvent: 11, horizon: 1 });
    expect(dgw.get(el.id)!.next).toBeGreaterThan(single.get(el.id)!.next * 1.5);
  });
  it("totalDiscounted is below total over a multi-GW horizon", () => {
    const xp = projectAll({ bootstrap, fixtures, nextEvent: 11, horizon: 5 });
    const p = [...xp.values()].find((v) => v.total > 5)!;
    expect(p.totalDiscounted).toBeLessThan(p.total);
    expect(p.totalDiscounted).toBeGreaterThan(p.total * 0.6);
  });
});

describe("planHorizon (multi-GW sequenced planner)", () => {
  const plan = planHorizon({
    bootstrap,
    fixtures,
    owned,
    bank: 20,
    freeTransfers: 2,
    nextEvent: 11,
    horizon: 5,
  });

  it("produces one step per gameweek in the horizon", () => {
    expect(plan.steps.map((s) => s.gw)).toEqual([11, 12, 13, 14, 15]);
  });

  it("every step's squad is legal and within budget", () => {
    let bank = 20;
    const ids = new Set(owned.map((o) => o.element.id));
    const sellOf = new Map(owned.map((o) => [o.element.id, o.sellPrice]));
    for (const st of plan.steps) {
      for (const m of st.transfers) {
        expect(ids.has(m.out.id)).toBe(true);
        expect(ids.has(m.in.id)).toBe(false);
        bank += (sellOf.get(m.out.id) ?? m.outSell) - m.in.now_cost;
        ids.delete(m.out.id);
        ids.add(m.in.id);
        sellOf.set(m.in.id, m.in.now_cost);
      }
      expect(bank).toBeGreaterThanOrEqual(0);
      expect(st.bankAfter).toBeGreaterThanOrEqual(0);
      const els = bootstrap.elements.filter((e) => ids.has(e.id));
      expect(
        validateSquad(els.map((e) => ({ id: e.id, elementType: e.element_type, teamId: e.team })))
      ).toEqual([]);
      expect(st.transfers.length).toBeLessThanOrEqual(2);
    }
  });

  it("free transfers bank correctly (+1 per GW, capped, hits reset to 0)", () => {
    let ft = 2;
    for (const st of plan.steps) {
      expect(st.ftBefore).toBe(ft);
      const used = st.transfers.length;
      const expectedHit = Math.max(0, used - ft) * 4;
      expect(st.hit).toBe(expectedHit);
      ft = Math.min(MAX_FREE_TRANSFERS, (expectedHit > 0 ? 0 : Math.max(0, ft - used)) + 1);
    }
  });

  it("the plan never scores worse than doing nothing", () => {
    expect(plan.totalXp).toBeGreaterThanOrEqual(plan.keepXp - 1e-9);
    expect(plan.gainVsKeep).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe("xp model — recent starts", () => {
  it("a player who lost his place projects lower; a new starter higher", () => {
    const b = makeMockBootstrap();
    const el = b.elements.find((e) => e.element_type === 3 && e.minutes > 1500)!;
    const base = projectAll({ bootstrap: b, fixtures, nextEvent: 11, horizon: 3 });
    const benched = projectAll({
      bootstrap: b,
      fixtures,
      nextEvent: 11,
      horizon: 3,
      recentStarts: new Map([[el.id, 0]]), // started 0 of last 5
    });
    const nailed = projectAll({
      bootstrap: b,
      fixtures,
      nextEvent: 11,
      horizon: 3,
      recentStarts: new Map([[el.id, 1]]), // started 5 of 5
    });
    expect(benched.get(el.id)!.total).toBeLessThan(base.get(el.id)!.total);
    expect(nailed.get(el.id)!.total).toBeGreaterThanOrEqual(base.get(el.id)!.total);
  });
});

describe("pre-season: leans on FPL's ep_next (premium-aware)", () => {
  it("a zero-minute premium with a high ep_next projects near that estimate", () => {
    const b = makeMockBootstrap();
    // Everyone pre-season: no minutes, no data.
    b.elements.forEach((e) => {
      e.minutes = 0;
      e.starts = 0;
      e.total_points = 0;
      e.form = "0.0";
      e.points_per_game = "0.0";
      e.expected_goals = "0.0";
      e.expected_assists = "0.0";
      e.ep_next = "2.0";
    });
    const premium = b.elements.find((e) => e.element_type === 4)!;
    premium.now_cost = 145;
    premium.ep_next = "7.5"; // FPL rates this player highly
    const xp = projectAll({ bootstrap: b, fixtures: makeMockFixtures(), nextEvent: 11, horizon: 1 });
    // With no data of our own, the projection should track FPL's estimate,
    // clearly above the field's 2.0.
    expect(xp.get(premium.id)!.next).toBeGreaterThan(5);
  });
});

describe("buildLaunchSquad (pre-season)", () => {
  it("drafts a legal 15-man squad within £100m even with zero minutes played", () => {
    const b = makeMockBootstrap();
    // Simulate season launch: nobody has played, prices are the only signal.
    b.events.forEach((e) => { e.finished = false; e.is_current = false; e.is_next = e.id === 1; });
    b.elements.forEach((e) => {
      e.minutes = 0; e.starts = 0; e.total_points = 0;
      e.form = "0.0"; e.points_per_game = "0.0";
      e.expected_goals = "0.0"; e.expected_assists = "0.0";
    });
    const fx = makeMockFixtures().map((f) => ({ ...f, event: (f.event ?? 11) - 10, finished: false })); // GW1-5
    const launch = buildLaunchSquad(b, fx, 1, 5);
    expect(
      validateSquad(launch.squad.map((e) => ({ id: e.id, elementType: e.element_type, teamId: e.team })))
    ).toEqual([]);
    expect(launch.cost).toBeLessThanOrEqual(1000);
    expect(launch.xi.starters.length).toBe(11);
    expect(launch.xi.totalXp).toBeGreaterThan(0); // price prior keeps projections meaningful
    // The draft should prefer expensive (better) players, not random cheap ones.
    const avgPrice = launch.squad.reduce((s, e) => s + e.now_cost, 0) / 15;
    const leagueAvg = b.elements.reduce((s, e) => s + e.now_cost, 0) / b.elements.length;
    expect(avgPrice).toBeGreaterThan(leagueAvg);
  });
});
