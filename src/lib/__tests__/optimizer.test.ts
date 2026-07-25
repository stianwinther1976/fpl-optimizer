import { describe, it, expect } from "vitest";
import { makeMockBootstrap, makeMockFixtures, makeMockOwned } from "./mockdata";
import {
  optimize,
  pickBestXi,
  buildLaunchSquad,
  buildLaunchVariants,
  planHorizon,
} from "../optimizer";
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
  it("a zero-minute premium moves a long way toward a high ep_next without reaching it", () => {
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
    const run = () =>
      projectAll({ bootstrap: b, fixtures: makeMockFixtures(), nextEvent: 11, horizon: 1 });
    const high = run();
    const withHigh = high.get(premium.id)!.next;
    const rest = b.elements.filter((e) => e.element_type === 4 && e.id !== premium.id);
    const field = rest.reduce((s, e) => s + high.get(e.id)!.next, 0) / rest.length;
    premium.ep_next = "2.0";
    const withField = run().get(premium.id)!.next;

    // This test used to assert `> 5` — that the projection should essentially
    // TRACK FPL's 7.5. That threshold was not derived from anything; it was
    // fitted to a since-removed weighting whose only justification was passing
    // this test, which is circular, and the four-season backtest says the
    // weighting was wrong. So the assertion now says the two things that are
    // actually defensible about a player with zero minutes on record.
    //
    // First, ep_next has to MOVE him a long way. Holding everything else fixed
    // and changing only FPL's estimate from 2.0 to 7.5 must at least double him.
    expect(withHigh).toBeGreaterThan(withField * 2);
    expect(withHigh).toBeGreaterThan(field * 2.5);
    // Second, it must not carry him to the estimate itself. `ep_next` is
    // minutes-blind — FPL gives an unplayed backup keeper the same ~2.6 it gives
    // a nailed midfielder — so a number that has never been tested against a
    // minute of football is not worth taking at face value. The bound is 5
    // because the removed weighting produced 5.79 here: this assertion is what
    // would have caught it, and a looser one would not have.
    expect(withHigh).toBeLessThan(5);
  });

  it("a proven last-season performer outprojects an unknown at the same price", () => {
    const b = makeMockBootstrap();
    b.elements.forEach((e) => {
      e.minutes = 0;
      e.starts = 0;
      e.total_points = 0;
      e.form = "0.0";
      e.points_per_game = "0.0";
      e.ep_next = null; // isolate the last-season signal
    });
    // The mock marks events 1-10 finished while its fixture list contains no
    // finished games, and `teamGames` falls back to the event count when the
    // fixtures cannot answer. Zeroing every player's minutes on top of that
    // produced a state no real gameweek can be in — ten weeks played, nobody in
    // the league having taken the field — and in it the in-season minutes model
    // correctly reports that nobody starts, so both projections collapsed and
    // the comparison was settled by leftovers rather than by the 3200-minute
    // record in the title. Zeroed minutes ARE last season's record, which is
    // pre-season; saying so in the events makes the mock self-consistent and
    // puts the test in the regime it was always describing.
    b.events.forEach((e) => {
      e.finished = false;
    });
    const mids = b.elements.filter((e) => e.element_type === 3);
    const proven = mids[0];
    const unknown = mids[1];
    proven.now_cost = unknown.now_cost = 80; // same price
    // The rows were `{ points, minutes }` and nothing else, which is legal —
    // `starts`, `seasons` and `plSeasons` are all optional on `PastSeasonStats`
    // — so the minutes model, which reads exactly those, had nothing to read and
    // gave the 3200-minute regular and the 500-minute fringe player the same
    // start probability. Optional fields on a fixture are how a test quietly
    // stops being one.
    //
    const pastSeason = new Map([
      [
        proven.id,
        {
          points: 220, minutes: 3200, starts: 35, plSeasons: 1,
          seasons: [{ seasonName: "2024/25", minutes: 3200, starts: 35 }],
        },
      ], // nailed, high-scoring
      [
        unknown.id,
        {
          points: 30, minutes: 500, starts: 4, plSeasons: 1,
          seasons: [{ seasonName: "2024/25", minutes: 500, starts: 4 }],
        },
      ], // fringe
    ]);
    const xp = projectAll({
      bootstrap: b,
      fixtures: makeMockFixtures(),
      nextEvent: 11,
      horizon: 1,
      pastSeason,
    });
    // `toBeGreaterThan` alone would pass on a hair. 35 starts against 4 is the
    // clearest signal this model ever gets, and it should be worth a lot more
    // than a rounding difference. Measured ratio is 3.21; the bar is set at 2.5
    // to leave room for retuning while still biting on a real regression — the
    // bug this test was blind to scored the pair at 0.34.
    //
    // Deleting `starts` and `seasons` from the fixture above does NOT break
    // this (the ratio goes to 3.62, since `impliedStarts` reads 3200/80 = 38,
    // more than the 35 actually recorded). They are there so the fixture
    // describes a real player rather than to carry the assertion.
    expect(xp.get(proven.id)!.next).toBeGreaterThan(xp.get(unknown.id)!.next * 2.5);
  });
});

describe("buildLaunchVariants (multiple GW1 drafts)", () => {
  it("returns distinct, legal £100m squads with different structures", () => {
    const b = makeMockBootstrap();
    b.events.forEach((e) => {
      e.finished = false;
      e.is_current = false;
      e.is_next = e.id === 1;
    });
    b.elements.forEach((e) => {
      e.minutes = 0;
      e.starts = 0;
      e.total_points = 0;
      e.form = "0.0";
      e.points_per_game = "0.0";
    });
    const fx = makeMockFixtures().map((f) => ({ ...f, event: (f.event ?? 11) - 10, finished: false }));
    const { variants } = buildLaunchVariants(b, fx, 1, 5);
    expect(variants.length).toBeGreaterThanOrEqual(2);
    for (const v of variants) {
      expect(
        validateSquad(v.squad.map((e) => ({ id: e.id, elementType: e.element_type, teamId: e.team })))
      ).toEqual([]);
      expect(v.cost).toBeLessThanOrEqual(1000);
      expect(v.xi.starters.length).toBe(11);
    }
    // The "value" variant caps player price; it must differ from balanced.
    const value = variants.find((v) => v.key === "value");
    if (value) expect(Math.max(...value.squad.map((e) => e.now_cost))).toBeLessThanOrEqual(85);
    // Variants aren't all identical.
    const sigs = new Set(
      variants.map((v) => v.squad.map((e) => e.id).sort((a, b) => a - b).join(","))
    );
    expect(sigs.size).toBe(variants.length);
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

  it("spends the budget instead of banking it", () => {
    // The downgrade loop in `buildSquadWithinBudget` stops the moment the squad
    // is affordable, so before the reinvestment pass was added it handed back
    // launch squads with money idle — £4.0m in the 2023-24 archive, £1.0m in
    // 2024-25. At a launch deadline that money buys nothing: there is no later
    // gameweek to save it for, so it is points thrown away.
    //
    // The bar is £1.0m rather than £0.0m because a squad genuinely can be
    // unable to spend the last few hundred thousand — every upgrade inside the
    // remaining bank may be blocked by the three-per-club cap or simply not
    // exist in the price grid. Measured by deleting the reinvestment pass and
    // re-running: £97.3m without it, comfortably under the bar, so this is a
    // mutation-tested assertion rather than one that happens to pass.
    const b = makeMockBootstrap();
    b.events.forEach((e) => { e.finished = false; e.is_current = false; e.is_next = e.id === 1; });
    b.elements.forEach((e) => {
      e.minutes = 0; e.starts = 0; e.total_points = 0;
      e.form = "0.0"; e.points_per_game = "0.0";
      e.expected_goals = "0.0"; e.expected_assists = "0.0";
    });
    const fx = makeMockFixtures().map((f) => ({ ...f, event: (f.event ?? 11) - 10, finished: false }));
    const launch = buildLaunchSquad(b, fx, 1, 5);
    expect(launch.cost).toBeLessThanOrEqual(1000);
    expect(launch.cost).toBeGreaterThanOrEqual(990);
    // And it is still legal after the reinvestment pass — that loop mutates the
    // squad and the club counter together, which is exactly where an off-by-one
    // would let a fourth player from one club in.
    //
    // Honesty about what this line does and does not do: relaxing the club test
    // in that loop from `<` to `<=` does NOT fail here, because this mock's
    // prices never make a fourth player from one club the best upgrade. It does
    // fail "dream team is legal and at least as good as current squad" further
    // up, so the mutant is caught by the suite — just not by this assertion.
    expect(
      validateSquad(launch.squad.map((e) => ({ id: e.id, elementType: e.element_type, teamId: e.team })))
    ).toEqual([]);

    // The cost bar alone is weak, and it is worth saying why rather than
    // leaving it looking sufficient. It passes if the pass runs exactly ONCE
    // and then stops, because the first upgrade already clears £99.0m. It also
    // passes if the pass is made to accept DOWNGRADES — swapping in strictly
    // worse players still spends money. Both were tried; both survived the
    // assertion above.
    //
    // So assert the post-condition the loop is actually supposed to establish:
    // when it returns, no single affordable, legal, like-for-like swap can
    // raise the squad's score. That is the definition of "done", and it kills
    // the downgrade mutant — swapping in a worse player leaves the reverse swap
    // sitting there as an improvement, and the assertion names it.
    //
    // It does NOT kill the truncated loop, and the reason is the mock rather
    // than the assertion: one upgrade exhausts every improving swap here, so
    // `guard = 1` reaches the same fixed point as `guard = 60`. On the archived
    // seasons the loop runs one to four times. Catching that would need a
    // universe with a deeper price ladder than this one has.
    const bank = 1000 - launch.cost;
    const score = (id: number) => launch.xp.get(id)?.totalDiscounted ?? 0;
    const clubs = new Map<number, number>();
    for (const e of launch.squad) clubs.set(e.team, (clubs.get(e.team) ?? 0) + 1);
    const missed: string[] = [];
    for (const out of launch.squad) {
      for (const inEl of b.elements) {
        if (inEl.element_type !== out.element_type) continue;
        if (launch.squad.some((s) => s.id === inEl.id)) continue;
        if (inEl.now_cost - out.now_cost > bank) continue;
        const after = (clubs.get(inEl.team) ?? 0) + (inEl.team === out.team ? -1 : 0);
        if (after >= 3) continue;
        if (score(inEl.id) > score(out.id) + 1e-9) {
          missed.push(`${out.web_name} -> ${inEl.web_name}`);
        }
      }
    }
    expect(missed).toEqual([]);
  });
});
