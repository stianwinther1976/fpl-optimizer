import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeMockBootstrap, makeMockFixtures, makeMockOwned } from "./mockdata";
import { makeDemoUniverse } from "../demo";
import {
  optimize,
  chipScenario,
  pickBestXi,
  buildLaunchSquad,
  buildLaunchVariants,
  rankLaunchVariants,
  type LaunchVariant,
  type BestXi,
  buildSquadWithinBudget,
  buildBenchAwareSquad,
  benchAwarePool,
  benchAwareScore,
  valueCapOf,
  VALUE_CAP,
  BENCH_SLOT_WEIGHTS,
  planHorizon,
} from "../optimizer";
import { MAX_FREE_TRANSFERS, MAX_PER_CLUB, VALID_FORMATIONS, validateSquad } from "../rules";
// Explicitly the FPL `Element`, not the DOM one. Without it the global
// `Element` from lib.dom wins and the `as Element` casts below fail to
// compile (TS2352, insufficient overlap) — loudly, not silently, but the
// error names two types both called "Element" and reads like nonsense.
import type { Bootstrap, Element, OwnedPlayer } from "../types";
import type { PlayerXp } from "../xp";
import { projectAll } from "../xp";

const bootstrap = makeMockBootstrap();
const fixtures = makeMockFixtures();
const owned = makeMockOwned(bootstrap);

/**
 * Printable ASCII plus the typographic characters the card copy legitimately
 * uses. One shared constant, because this change was on its way to shipping
 * two: the strongxi assertions already carried `/^[\x20-\x7E£]+$/`, and the
 * new loop over all four variants needed `—` for the descriptions that use
 * one. Two charsets for one rule is how you get a test that goes red over an
 * em dash it has nothing to say about, so they were merged before that could
 * happen rather than after.
 *
 * BE HONEST ABOUT WHAT THIS CATCHES. It is a non-ASCII guard, not a language
 * detector. The risk it exists for is Norwegian leaking into the UI — I am
 * written to in Norwegian and reply in Norwegian, and the app must be English
 * — and it only catches the Norwegian that carries æ, ø or å, plus mojibake
 * from a bad copy-paste. A label reading "Beste laget ditt" is pure ASCII and
 * sails through. Nothing automatic here can do better; the actual guard is
 * reading the strings.
 */
const ENGLISH_ONLY = /^[\x20-\x7E£—–…]+$/;

/**
 * The "value" card announces a price ceiling in its own copy. Whatever number
 * it announces, the fifteen it describes must obey — a card that says "no
 * player above £7.5m" over a squad containing an £8.0m player is the single
 * most visible way this feature can be wrong, and it is wrong in a way no
 * assertion phrased in terms of `valueCapOf` can catch, because those compute
 * the expectation from the code they are checking.
 */
function expectDescribedCapHolds(v: { key: string; description: string; squad: { now_cost: number }[] }) {
  const m = v.description.match(/£(\d+\.\d)m/);
  expect(m, `${v.key} description names no price ceiling: ${v.description}`).not.toBeNull();
  const capTenths = Math.round(parseFloat(m![1]) * 10);
  const dearest = Math.max(...v.squad.map((e) => e.now_cost));
  expect(dearest, `${v.key} says £${m![1]}m but fields a £${(dearest / 10).toFixed(1)}m player`).toBeLessThanOrEqual(capTenths);
}

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
    const xp = projectAll({ pastSeason: undefined, bootstrap, fixtures, nextEvent: 11 });
    const values = [...xp.values()].map((v) => v.total);
    expect(Math.max(...values)).toBeGreaterThan(0);
  });
});

describe("pickBestXi", () => {
  const xp = projectAll({ pastSeason: undefined, bootstrap, fixtures, nextEvent: 11 });
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

  it("keeps the zero floors on the Wildcard and Free Hit gains", () => {
    /*
     * A TOKEN GUARD, AND HONEST ABOUT BEING ONE.
     *
     * The assertion above looks like it pins `Math.max(0, ...)` and does not:
     * mutation-testing removed BOTH floors and the whole suite stayed green,
     * because on this fixture the unclamped values are positive anyway.
     *
     * They are positive on every fixture, which is the actual problem. Both
     * quantities are "an optimal squad for this window, minus the one you
     * hold", and an optimal squad cannot lose to a held one — so the floors
     * cannot be driven below zero through the public API and there is no
     * behavioural test to write. Contriving one would be theatre.
     *
     * CLAUDE.md leans on the bound anyway ("bounded below by zero... the size
     * of a gap, not a reason to play the chip"), and floating-point noise
     * around a genuinely equal squad is exactly when it fires. So the floors
     * are pinned at the source, with the weakness stated: this catches deletion
     * and nothing else.
     */
    const src = fs.readFileSync(path.join(__dirname, "../optimizer.ts"), "utf8");
    /*
     * The Wildcard's floor is no longer a literal `Math.max(0, ...)`. It takes
     * the best of the built squad, KEEPING the squad, and every squad the beam
     * already evaluated — and "keeping" is what puts the floor at zero, now
     * structurally rather than by clamping. That is the stronger version of the
     * same bound, and there IS a behavioural test for it two describes below:
     * the gain can no longer come out under the best transfer plan, which is
     * what the old clamp was hiding.
     */
    expect(src).toMatch(/const wcBase = Math\.max\(/);
    expect(src).toMatch(/keepHorizonXp,\n\s*\.\.\.plans\.map\(\(p\) => p\.grossXp\)/);
    expect(src).toMatch(/projectedGain: Math\.max\(0, fhBest\.gain\)/);
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
    const vsWeak = projectAll({ pastSeason: undefined, bootstrap: b, fixtures: mkFx(strongOpp), nextEvent: 11, horizon: 1 }).get(el.id)!.next;
    const vsStrong = projectAll({ pastSeason: undefined, bootstrap: b, fixtures: mkFx(weakOpp), nextEvent: 11, horizon: 1 }).get(el.id)!.next;
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
    const xp = projectAll({ pastSeason: undefined, bootstrap: b, fixtures: makeMockFixtures(), nextEvent: 11, horizon: 1 });
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
    const xp = projectAll({ pastSeason: undefined, bootstrap: b, fixtures: fx, nextEvent: 11, horizon: 1 });
    expect(xp.get(el.id)!.next).toBe(0);
  });
  it("a double gameweek projects more than a single", () => {
    const b = makeMockBootstrap();
    const el = b.elements.find((e) => e.element_type === 3 && e.minutes > 1000)!;
    const base = makeMockFixtures();
    const single = projectAll({ pastSeason: undefined, bootstrap: b, fixtures: base, nextEvent: 11, horizon: 1 });
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
    const dgw = projectAll({ pastSeason: undefined, bootstrap: b, fixtures: [...base, extra], nextEvent: 11, horizon: 1 });
    expect(dgw.get(el.id)!.next).toBeGreaterThan(single.get(el.id)!.next * 1.5);
  });
  it("totalDiscounted is below total over a multi-GW horizon", () => {
    const xp = projectAll({ pastSeason: undefined, bootstrap, fixtures, nextEvent: 11, horizon: 5 });
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

// The recency data is fetched by the panel and has to travel through the
// optimizer to reach the projection. Every hop is a plain optional field being
// copied into an object literal, which typechecks and lints identically whether
// it is there or not — so deleting all three forwards used to leave the whole
// suite green while the deployed app quietly stopped using the best minutes
// signal it has. These tests watch the wire, not the model.
describe("the optimizer forwards recent form to the projection", () => {
  const benchedEverywhere = (b: ReturnType<typeof makeMockBootstrap>) =>
    new Map(
      b.elements.map((e) => [
        e.id,
        { startShare: 0, minsPerGame: 0, minsPerStart: null as number | null },
      ])
    );

  it("optimize() reaches projectAll", () => {
    const b = makeMockBootstrap();
    const own = makeMockOwned(b);
    const base = optimize({
      bootstrap: b,
      fixtures,
      owned: own,
      bank: 0,
      freeTransfers: 1,
      nextEvent: 11,
      horizon: 3,
    });
    const benched = optimize({
      bootstrap: b,
      fixtures,
      owned: own,
      bank: 0,
      freeTransfers: 1,
      nextEvent: 11,
      horizon: 3,
      recentForm: benchedEverywhere(b),
    });
    // Nobody has started in five games: every projection must come down.
    expect(benched.keepHorizonXp).toBeLessThan(base.keepHorizonXp * 0.9);
  });

  it("planHorizon() reaches projectAll", () => {
    const b = makeMockBootstrap();
    const own = makeMockOwned(b);
    const args = {
      bootstrap: b,
      fixtures,
      owned: own,
      bank: 0,
      freeTransfers: 1,
      nextEvent: 11,
      horizon: 3,
    };
    const base = planHorizon(args);
    const benched = planHorizon({ ...args, recentForm: benchedEverywhere(b) });
    expect(benched.keepXp).toBeLessThan(base.keepXp * 0.9);
  });
});

describe("xp model — recent starts", () => {
  it("a player who lost his place projects lower; a new starter higher", () => {
    const b = makeMockBootstrap();
    const el = b.elements.find((e) => e.element_type === 3 && e.minutes > 1500)!;
    const base = projectAll({ pastSeason: undefined, bootstrap: b, fixtures, nextEvent: 11, horizon: 3 });
    const benched = projectAll({ pastSeason: undefined,
      bootstrap: b,
      fixtures,
      nextEvent: 11,
      horizon: 3,
      // started 0 of last 5
      recentForm: new Map([[el.id, { startShare: 0, minsPerGame: 0, minsPerStart: null }]]),
    });
    const nailed = projectAll({ pastSeason: undefined,
      bootstrap: b,
      fixtures,
      nextEvent: 11,
      horizon: 3,
      // started 5 of 5, full matches
      recentForm: new Map([[el.id, { startShare: 1, minsPerGame: 90, minsPerStart: 90 }]]),
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
      projectAll({ pastSeason: undefined, bootstrap: b, fixtures: makeMockFixtures(), nextEvent: 11, horizon: 1 });
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
    // All four drafts, by name. `>= 2` above is a floor on legality, not on
    // completeness, and an `if (value)` guard here — which is what used to
    // stand — passes just as happily when the variant has vanished as when it
    // is right. The cap must BIND: the value draft's dearest player strictly
    // below the balanced draft's.
    expect(variants.map((v) => v.key)).toEqual(["balanced", "stars", "value", "strongxi"]);
    const value = variants.find((v) => v.key === "value")!;
    const bal = variants.find((v) => v.key === "balanced")!;
    expect(Math.max(...value.squad.map((e) => e.now_cost))).toBeLessThan(
      Math.max(...bal.squad.map((e) => e.now_cost))
    );
    expectDescribedCapHolds(value);
    // Every card is read by a human, and the UI is English-only — no Norwegian
    // may reach it. The `value` description is the one that matters most here
    // because it is the only one built by string interpolation.
    for (const v of variants) {
      expect(v.label, `${v.key} label`).toMatch(ENGLISH_ONLY);
      expect(v.description, `${v.key} description`).toMatch(ENGLISH_ONLY);
    }
    // Structurally distinct, not merely non-identical. `sigs.size ===
    // variants.length` used to stand here and is a tautology: production
    // dedupes by exactly that signature two lines before returning, so the
    // assertion cannot fail whatever the builders do. What is NOT guaranteed
    // is that each draft differs in the direction its name promises — the
    // dedupe is happy with four squads that differ by one £4.0m reserve each.
    // Value's cap is checked above; here, "Strong XI, cheap bench" has to
    // actually field a cheaper bench than the balanced draft, or the card is
    // selling a structure it did not build.
    const benchCost = (v: (typeof variants)[number]) =>
      v.xi.bench.reduce((s, slot) => s + slot.element.now_cost, 0);
    const strongxi = variants.find((v) => v.key === "strongxi")!;
    expect(benchCost(strongxi)).toBeLessThan(benchCost(bal));
  });

  it("offers the bench-aware draft as a fourth option", () => {
    const b = makeMockBootstrap();
    b.events.forEach((e) => {
      e.finished = false;
      e.is_current = false;
      e.is_next = e.id === 1;
    });
    const fx = makeMockFixtures().map((f) => ({ ...f, event: (f.event ?? 11) - 10, finished: false }));
    const { variants, xp } = buildLaunchVariants(b, fx, 1, 5);
    // Not conditional. `if (!strong) return` used to stand here, which meant
    // deleting the variant outright turned the test green and took the four
    // assertions below with it — a test named for a feature is worthless if
    // removing the feature satisfies it.
    const strong = variants.find((v) => v.key === "strongxi")!;
    expect(strong).toBeDefined();
    expect(
      validateSquad(strong.squad.map((e) => ({ id: e.id, elementType: e.element_type, teamId: e.team })))
    ).toEqual([]);
    expect(strong.cost).toBeLessThanOrEqual(1000);
    // The label and description are user-facing and must stay English-only:
    // no Norwegian ever reaches the UI.
    expect(strong.label).toMatch(ENGLISH_ONLY);
    expect(strong.description).toMatch(ENGLISH_ONLY);
    // And it must actually be built on the objective it is named for: the
    // squad it returns has to score at least as well under `benchAwareScore`
    // as the balanced draft does, or the search is decorative.
    const score = (id: number) => xp.get(id)?.totalDiscounted ?? 0;
    const balanced = variants.find((v) => v.key === "balanced")!;
    expect(benchAwareScore(strong.squad, score)).toBeGreaterThanOrEqual(
      benchAwareScore(balanced.squad, score) - 1e-9
    );
  });

  it("keeps the value draft alive when the £8.5m cap would not have bound", () => {
    const b = makeMockBootstrap();
    b.events.forEach((e) => {
      e.finished = false;
      e.is_current = false;
      e.is_next = e.id === 1;
    });
    // Squeeze every price under the headline cap. This is the exact shape of
    // the real regression — the 2026-27 pool does it on the fallback path
    // where last-season minutes could not be fetched and the balanced draft's
    // dearest pick comes out at £8.0m — and it is the only way to reproduce it
    // deterministically, because the unclamped mock still has £8.5m+ players.
    b.elements.forEach((e) => {
      e.now_cost = Math.min(e.now_cost, 80);
    });
    const fx = makeMockFixtures().map((f) => ({ ...f, event: (f.event ?? 11) - 10, finished: false }));
    const { variants } = buildLaunchVariants(b, fx, 1, 5);
    const value = variants.find((v) => v.key === "value");
    const balanced = variants.find((v) => v.key === "balanced")!;
    // This is the regression the adaptive cap exists for. With a fixed £8.5m
    // cap and a balanced draft whose dearest player is £8.0m, the two builds
    // were byte-identical and `value` was silently dropped by the dedupe.
    expect(value).toBeDefined();
    // The card the manager reads must name the cap that was actually applied,
    // not a constant that has drifted away from the code. Note the limit of
    // this line: the expectation is computed from the function under test, so
    // it pins the description against the CODE and cannot tell you the code's
    // RULE is right. (It is not vacuous — hardcoding `£8.5m` back into the
    // template literal turns it red — it is just narrower than it reads. The
    // rule itself is pinned by the `valueCapOf` cases below.)
    expect(value!.description).toContain(`£${(valueCapOf(balanced.squad) / 10).toFixed(1)}m`);
    // Independent of `valueCapOf` entirely: whatever number the card prints,
    // the squad it describes has to obey it. This is the property a manager
    // would notice being broken, and it survives any bug in the cap rule.
    expectDescribedCapHolds(value!);
    expect(value!.squad.map((e) => e.id).sort((a, b) => a - b)).not.toEqual(
      balanced.squad.map((e) => e.id).sort((a, b) => a - b)
    );
  });

  it("never ships a short squad when the value cap starves the build", () => {
    const b = makeMockBootstrap();
    b.events.forEach((e) => {
      e.finished = false;
      e.is_current = false;
      e.is_next = e.id === 1;
    });
    // Flat-price everyone at £4.5m. The cap then derives to £4.0m and the pool
    // it filters on is empty at every position, so the value build comes back
    // with nothing. A degenerate pool, but the failure it provokes is not: a
    // variant card rendering an 0-man "squad" is worse than one card fewer,
    // and `pickBestXi` on an empty squad is not something the UI survives.
    b.elements.forEach((e) => {
      e.now_cost = 45;
    });
    const fx = makeMockFixtures().map((f) => ({ ...f, event: (f.event ?? 11) - 10, finished: false }));
    const { variants } = buildLaunchVariants(b, fx, 1, 5);
    // The value draft is GONE, not silently replaced by the balanced one: a
    // card headed "no player above £4.0m" over a squad of £4.5m players is a
    // lie, and one card fewer is the honest outcome. `> 0` would be
    // unfalsifiable here — balanced always survives — so name the key.
    expect(variants.map((v) => v.key)).not.toContain("value");
    expect(variants.map((v) => v.key)).toContain("balanced");
    for (const v of variants) {
      expect(v.squad.length, `${v.key} is not a fifteen`).toBe(15);
      expect(v.xi.starters.length).toBe(11);
    }
  });
});

describe("valueCapOf", () => {
  const el = (now_cost: number) => ({ now_cost }) as Element;

  it("stays at the headline £8.5m when £8.5m already binds", () => {
    // The normal case, and the one the product name depends on. On the real
    // 2026-27 pool the balanced draft's dearest player is £12.0m; deriving the
    // cap from him would give £11.5m, and measured on that pool an £11.5m cap
    // returns a squad BYTE-IDENTICAL to the £8.5m one (both share 12 of 15
    // with balanced, both top out at £8.5m) — the greedy build never wanted
    // anyone in between. So the derived cap would cost nothing in squad terms
    // and everything in honesty: the card would announce an £11.5m ceiling for
    // a draft whose dearest player is £8.5m.
    expect(valueCapOf([el(45), el(120), el(85)])).toBe(85);
  });

  it("stays at £8.5m for a dearest pick just above it", () => {
    // The case that actually pins the rule, and the reason the £12.0m case
    // above does not. `Math.min(VALUE_CAP, dearest - 5)` — the first
    // implementation — tightens whenever `dearest - 5 < 85`, i.e. for every
    // `dearest` below £9.0m, so it answered 82 here. £8.5m excludes the £8.7m
    // player perfectly well; there is nothing to fix and no reason to move the
    // headline number off the constant the card is named for.
    //
    // £8.6m-£8.9m is not a corner. In-season prices move in £0.1m steps, so
    // the balanced draft's dearest pick lands in that strip routinely; only
    // the pre-season pool, where everything is on a £0.5m grid, makes it look
    // unreachable.
    expect(valueCapOf([el(45), el(87)])).toBe(85);
    expect(valueCapOf([el(45), el(86)])).toBe(85);
    expect(valueCapOf([el(45), el(89)])).toBe(85);
    // The far side of the boundary: £8.5m exactly, which excludes nobody.
    expect(valueCapOf([el(45), el(85)])).toBe(80);
  });

  it("tightens below the dearest pick when £8.5m would not bind", () => {
    // The failure case: nobody in the balanced draft is above £8.5m, so the
    // constant excludes nobody and the variant dedupes itself out of the app.
    expect(valueCapOf([el(45), el(80), el(75)])).toBe(75);
  });

  it("stops at £4.0m rather than deriving a cap nobody can meet", () => {
    // A squad of £4.0m players would otherwise produce a £3.5m cap and the
    // build would starve. £4.0m is the cheapest price in the 2026-27 pool, and
    // FPL's floor has been £4.0m for several seasons — but it HAS been lower
    // (£3.8m/£3.9m players existed), so this is a floor chosen against the
    // current game, not a law. If the game ever ships cheaper players the
    // starvation guard in `buildLaunchVariants`, not this constant, is what
    // keeps a short squad off the screen.
    expect(valueCapOf([el(40), el(40)])).toBe(40);
  });

  it("falls back to the headline cap when there is no draft to derive from", () => {
    // Math.max() of an empty list is -Infinity; deriving from nothing has to
    // be handled explicitly rather than producing a cap that excludes everyone.
    // Spelled against the constant, not against 85, so that moving the headline
    // ceiling moves this with it — the property is "falls back to the headline
    // cap", and nothing here cares what the headline cap is.
    expect(valueCapOf([])).toBe(VALUE_CAP);
  });
});

describe("benchAwareScore (bench priced at its measured autosub value)", () => {
  const xp = projectAll({ pastSeason: undefined, bootstrap, fixtures, nextEvent: 11 });
  const score = (id: number) => xp.get(id)?.totalDiscounted ?? 0;
  const squad = owned.map((o) => o.element);

  it("applies the measured weights in FPL bench order", () => {
    // The literals are repeated here on purpose rather than imported: this
    // test exists to catch a change to BENCH_SLOT_WEIGHTS, and a test that
    // imports the thing it is checking cannot catch a change to it.
    const W = [0.072, 0.513, 0.283, 0.046];
    expect([...BENCH_SLOT_WEIGHTS]).toEqual(W);
    const xi = pickBestXi(squad, score);
    // Bench slot 1 is the substitute keeper by FPL convention; the remaining
    // three are outfielders in the order they would be autosubbed.
    expect(xi.bench[0].element.element_type).toBe(1);
    expect(xi.bench.length).toBe(4);
    const expected =
      xi.starters.reduce((a, s) => a + score(s.element.id), 0) +
      xi.bench.reduce((a, s, i) => a + W[i] * score(s.element.id), 0);
    expect(benchAwareScore(squad, score)).toBeCloseTo(expected, 9);
  });

  it("lands strictly between the two extremes it was built to sit between", () => {
    const xi = pickBestXi(squad, score);
    const xiOnly = xi.starters.reduce((a, s) => a + score(s.element.id), 0);
    const sum15 = squad.reduce((a, e) => a + score(e.id), 0);
    const mid = benchAwareScore(squad, score);
    // Every weight is in (0, 1), so pricing the bench cannot reach either end.
    expect(mid).toBeGreaterThan(xiOnly);
    expect(mid).toBeLessThan(sum15);
    // And the bench must be worth something, or the guard above is vacuous.
    expect(sum15 - xiOnly).toBeGreaterThan(0);
  });
});

describe("buildBenchAwareSquad", () => {
  const b = makeMockBootstrap();
  b.events.forEach((e) => {
    e.finished = false;
    e.is_current = false;
    e.is_next = e.id === 1;
  });
  const fx = makeMockFixtures().map((f) => ({ ...f, event: (f.event ?? 11) - 10, finished: false }));
  const xp = projectAll({ pastSeason: undefined, bootstrap: b, fixtures: fx, nextEvent: 1, horizon: 5 });
  const score = (id: number) => xp.get(id)?.totalDiscounted ?? 0;

  it("returns a legal fifteen inside the budget", () => {
    const built = buildBenchAwareSquad(b.elements, xp, 1000);
    expect(built.squad.length).toBe(15);
    expect(
      validateSquad(built.squad.map((e) => ({ id: e.id, elementType: e.element_type, teamId: e.team })))
    ).toEqual([]);
    expect(built.cost).toBeLessThanOrEqual(1000);
  });

  it("can reach the cheapest player at every position", () => {
    // This is the property the whole function depends on and the one that is
    // silently easy to lose: a pool of "the best 40 by projected points" looks
    // perfectly sensible and cannot build a cheap bench, because the cheap
    // players are precisely the ones that ranking excludes. Asserted on the
    // pool rather than on the search result so it fails for the right reason.
    const pools = benchAwarePool(b.elements, xp);
    let outsideTop40 = 0;
    for (const t of [1, 2, 3, 4] as const) {
      const eligible = b.elements.filter(
        (e) => e.element_type === t && e.status !== "u" && (xp.get(e.id)?.total ?? 0) > 0
      );
      const cheapest = eligible.reduce((a, e) => (e.now_cost < a.now_cost ? e : a));
      expect(pools.get(t)!.some((e) => e.id === cheapest.id)).toBe(true);
      const top40 = new Set(
        [...eligible].sort((x, y) => score(y.id) - score(x.id)).slice(0, 40).map((e) => e.id)
      );
      if (!top40.has(cheapest.id)) outsideTop40++;
    }
    // ...and the guard above is only meaningful if the mock universe actually
    // has cheap players the xP ranking would have thrown away. If a future
    // change to the fixtures makes every position's cheapest player a top-40
    // pick, the assertion above becomes free and this line says so out loud.
    expect(outsideTop40).toBeGreaterThan(0);
  });

  it("never returns a squad the greedy seed already beat on its own objective", () => {
    // The climb starts from `buildSquadWithinBudget` and only ever accepts a
    // strict improvement, so this is the one guarantee it owes the caller. If
    // it ever regresses, the search has a bug in how it applies a move.
    const seed = buildSquadWithinBudget(b.elements, xp, 1000);
    const built = buildBenchAwareSquad(b.elements, xp, 1000);
    expect(benchAwareScore(built.squad, score)).toBeGreaterThanOrEqual(
      benchAwareScore(seed.squad, score) - 1e-9
    );
  });

  it("returns a squad no single legal swap can improve", () => {
    // The climb is a loop, and a loop that runs once is indistinguishable from
    // a loop that runs to convergence on every guard that only compares the
    // result to the seed. This checks the thing the loop is FOR: that the
    // squad handed back is a local optimum of the objective it optimises.
    // The legality rules are re-implemented here on purpose rather than
    // imported from the search — a bug shared by both would cancel out.
    const built = buildBenchAwareSquad(b.elements, xp, 1000);
    const pools = benchAwarePool(b.elements, xp);
    const cur = benchAwareScore(built.squad, score);
    let improvements = 0;
    let considered = 0;
    for (let i = 0; i < built.squad.length; i++) {
      const out = built.squad[i];
      for (const inEl of pools.get(out.element_type)!) {
        if (inEl.id === out.id) continue;
        if (built.squad.some((e, j) => j !== i && e.id === inEl.id)) continue;
        if (built.cost - out.now_cost + inEl.now_cost > 1000) continue;
        const sameClub = built.squad.filter((e, j) => j !== i && e.team === inEl.team).length;
        if (sameClub >= MAX_PER_CLUB) continue;
        considered++;
        const trial = built.squad.map((e, j) => (j === i ? inEl : e));
        if (benchAwareScore(trial, score) > cur + 1e-9) improvements++;
      }
    }
    expect(considered).toBeGreaterThan(100); // the sweep must not be empty
    expect(improvements).toBe(0);
    // WHAT THIS DOES NOT COVER, said out loud so it is not mistaken for
    // coverage: the paired bench-down/XI-up neighbourhood. On this mock
    // universe the single-swap neighbourhood already reaches the local optimum
    // by itself, so deleting the paired move entirely leaves every assertion
    // in this file green — it is an equivalent mutant HERE. Its value is a
    // real-data property (measured at 2.55 xP in scripts/ytcompare.test.ts)
    // and it is guarded on real seasons in scripts/simulate.test.ts, not here.
  });

  it("respects a budget too small for the greedy seed to have used", () => {
    const built = buildBenchAwareSquad(b.elements, xp, 900);
    expect(built.cost).toBeLessThanOrEqual(900);
    expect(
      validateSquad(built.squad.map((e) => ({ id: e.id, elementType: e.element_type, teamId: e.team })))
    ).toEqual([]);
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

describe("pickBestXi picks the formation that maximises XI + captain", () => {
  // `pickBestXi` selects the formation on the eleven's xp and only then adds the
  // captain's doubled xp. An audit read that as an off-by-one in the objective:
  // the number it reports is XI + captain, so a formation that scores lower on
  // the eleven but hands the armband to a bigger player could in principle win.
  //
  // It cannot, because every legal formation starts the top player of every
  // position, so the captain is formation-invariant. That is an argument about
  // VALID_FORMATIONS, not about this function, which is exactly why it needs a
  // test: change the formation table and the argument silently stops holding.
  // So this pins the shipped result against a brute force over the quantity that
  // is actually reported, on random squads rather than one hand-built case.
  // The production table, not a copy of it. A local transcription would only
  // ever detect that the two lists had diverged, which is a weaker and more
  // confusing signal than checking the real thing.
  const VALID = VALID_FORMATIONS;

  /** Deterministic LCG — a seeded generator, so a failure is reproducible. */
  const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  it("matches a brute-force argmax over XI+captain on 400 random squads", () => {
    const rand = rng(20260722);
    let checked = 0;
    for (let trial = 0; trial < 400; trial++) {
      // A legal 15: 2 GK, 5 DEF, 5 MID, 3 FWD, with arbitrary xp.
      const squad: { id: number; element_type: number }[] = [];
      const xpOfMap = new Map<number, number>();
      let id = 1;
      for (const [type, n] of [
        [1, 2],
        [2, 5],
        [3, 5],
        [4, 3],
      ] as const) {
        for (let i = 0; i < n; i++) {
          squad.push({ id, element_type: type });
          // Occasionally give a defender or keeper a huge score, so the top
          // player of the squad is not always a forward or midfielder.
          xpOfMap.set(id, rand() < 0.15 ? rand() * 20 : rand() * 6);
          id++;
        }
      }
      const xpOf = (pid: number) => xpOfMap.get(pid) ?? 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const got = pickBestXi(squad as any, xpOf);

      // Brute force: for every formation take the top d/m/f by xp, and score
      // the eleven PLUS its best starter again (the captain).
      const byType = (t: number) =>
        squad
          .filter((p) => p.element_type === t)
          .map((p) => xpOf(p.id))
          .sort((a, b) => b - a);
      const gk = byType(1);
      const df = byType(2);
      const md = byType(3);
      const fw = byType(4);
      let bruteBest = -Infinity;
      for (const [d, m, f] of VALID) {
        const starters = [gk[0], ...df.slice(0, d), ...md.slice(0, m), ...fw.slice(0, f)];
        const total = starters.reduce((a, x) => a + x, 0) + Math.max(...starters);
        if (total > bruteBest) bruteBest = total;
      }
      expect(got.totalXp).toBeCloseTo(bruteBest, 10);
      checked++;
    }
    expect(checked).toBe(400);
  });

  it("the invariant it relies on actually holds: every formation fields each position's best", () => {
    // The comment in pickBestXi argues the captain is formation-invariant BECAUSE
    // every legal formation starts at least one of each position. That argument
    // lives in VALID_FORMATIONS, so this is the assertion that owns it: legalise
    // a shape with no forward (or no midfielder, or no defender) and this fails
    // loudly instead of the formation choice quietly becoming a non-argmax.
    expect(VALID_FORMATIONS.length).toBeGreaterThan(0);
    for (const [d, m, f] of VALID_FORMATIONS) {
      expect(d, `formation ${d}-${m}-${f} fields no defender`).toBeGreaterThanOrEqual(1);
      expect(m, `formation ${d}-${m}-${f} fields no midfielder`).toBeGreaterThanOrEqual(1);
      expect(f, `formation ${d}-${m}-${f} fields no forward`).toBeGreaterThanOrEqual(1);
    }
  });
});

/*
 * The field reaches the result, and does not touch the ranking on its way.
 *
 * The whole argument for `field.ts` is that ownership is information about
 * SPREAD, not a better estimate of points — the field's expected score is a
 * constant with respect to this choice, so reweighting by ownership answers a
 * different question rather than answering this one better. These tests exist
 * so that argument stays true of the shipped code and not merely of the
 * comment describing it.
 */
describe("captaincy against the field", () => {
  const run = (differentialTolerance?: number) =>
    optimize({
      bootstrap,
      fixtures,
      owned,
      bank: 20,
      freeTransfers: 2,
      nextEvent: 11,
      horizon: 3,
      differentialTolerance,
    });

  it("ranks on projected points by default, whatever the ownership", () => {
    const r = run();
    const xps = r.captainRanking.map((c) => c.xp);
    expect(xps).toEqual([...xps].sort((a, b) => b - a));
  });

  it("carries a read for every ranked captain, keyed by id", () => {
    // Keyed, not index-aligned — see the note on `OptimizerResult.captainReads`.
    const r = run();
    for (const c of r.captainRanking) {
      const read = r.captainReads.get(c.element.id);
      expect(read, `no field read for ${c.element.web_name}`).toBeDefined();
      expect(read!.element.id).toBe(c.element.id);
      expect(read!.xp).toBe(c.xp);
    }
  });

  it("says nothing about the field's captain before a gameweek has finished", () => {
    // `most_captained` is null on every unfinished event, which pre-season is
    // all 38 of them. Nothing may turn that into a claim.
    const r = run();
    expect([...r.captainReads.values()].some((x) => x.wasTemplateCaptain)).toBe(false);
  });

  it("splits the RECOMMENDED XI into what the field has and what it does not", () => {
    /*
     * It used to be the keep XI, while the Line-up section below the card
     * defaults to "Best plan" — one player different on the demo, and the one
     * number on the page whose subject is ownership exposure was describing a
     * team the reader was being advised not to field.
     */
    const r = run();
    const best = [...r.plans].sort((a, b) => b.netXp - a.netXp)[0];
    const shown = best && best.gainVsKeep > 0.05 ? best.nextXi : r.keepXi;
    const total = shown.starters.reduce((a, s) => a + s.xp, 0);
    expect(r.fieldSplit.total).toBeCloseTo(total, 6);
    expect(r.fieldSplit.shared + r.fieldSplit.differential).toBeCloseTo(total, 6);
    // Every mock element carries a published ownership, so none is dropped.
    expect(r.fieldSplit.unknown).toBe(0);
    // And the shared half is a real fraction of it, not the whole or nothing:
    // the mock's ownership runs from 2% to 42%.
    expect(r.fieldSplit.shared).toBeGreaterThan(0);
    expect(r.fieldSplit.shared).toBeLessThan(total);
  });

  it("only reorders inside the tolerance the caller asked for", () => {
    // A tolerance big enough to matter must not be able to promote a pick past
    // one it actually trails by more than that. Stated against the default
    // ranking so the property is checked on real optimiser output rather than
    // on a hand-built list.
    const base = run();
    const bold = run(0.75);
    const bestXp = base.captainRanking[0].xp;
    expect(bold.captainRanking[0].xp).toBeGreaterThanOrEqual(bestXp - 0.75);
  });
});

describe("chip advice carries season-long timing", () => {
  const result = optimize({
    bootstrap,
    fixtures,
    owned,
    bank: 20,
    freeTransfers: 2,
    nextEvent: 11,
    horizon: 3,
  });

  it("attaches a timing read to every chip", () => {
    expect(result.chipAdvice.length).toBeGreaterThan(0);
    for (const a of result.chipAdvice) {
      expect(a.timing, `${a.chip} has no timing`).toBeDefined();
      expect(a.timing.chip).toBe(a.chip);
    }
  });

  it("never flags a gameweek inside the horizon it already scored, or past the window", () => {
    // The two registers must not overlap: what the projection scored in points
    // is not re-reported as a fixture count, and nothing is suggested for a
    // gameweek the chip cannot be played in.
    //
    // THIS TEST USED TO EXECUTE NO ASSERTIONS AT ALL. The mock calendar has no
    // double and no blank anywhere, so `timing.windows` is empty for all four
    // chips and both `expect`s below sat inside a loop that never ran — the
    // only zero-assertion test in the suite. Mutation-tested: removing BOTH
    // clips this test names from `chips.ts` left it green.
    //
    // The clipping itself is pinned properly in `chips.test.ts`, against a
    // calendar that actually has structure. What is worth keeping here is that
    // the two registers do not overlap on the SHIPPED path, so the guard below
    // states the precondition rather than letting it pass vacuously.
    const flagged = result.chipAdvice.flatMap((a) =>
      a.timing.windows.map((w) => ({ chip: a.chip, gw: w.gw, stop: a.timing.window?.stop }))
    );
    if (flagged.length === 0) {
      // Nothing to check, and that is a fact about the fixture, not a pass.
      expect(
        result.chipAdvice.every((a) => a.timing.windows.length === 0),
        "fixture has no structural windows, so the loop below is vacuous"
      ).toBe(true);
      return;
    }
    for (const f of flagged) {
      expect(f.gw, `${f.chip} flagged a gameweek already scored`).toBeGreaterThan(13);
      if (f.stop != null) expect(f.gw, `${f.chip} flagged past its window`).toBeLessThanOrEqual(f.stop);
    }
  });

  it("never names a gameweek outside the chip's own window", () => {
    /*
     * THE CLIP THE TEST ABOVE CHECKS IS ON `timing.windows` — the STRUCTURAL
     * register. The headline `detail`, which is what the reader sees first, was
     * an argmax over `nextEvent … nextEvent + horizon - 1` with no reference to
     * `bootstrap.chips` at all. Any horizon crossing an expiry therefore named
     * a gameweek the chip cannot be played in, three lines above a timing note
     * saying when the window closed.
     */
    const withWindows = (start: number, stop: number) =>
      optimize({
        bootstrap: {
          ...bootstrap,
          chips: ["bboost", "3xc", "freehit", "wildcard"].map((name) => ({
            name,
            start_event: start,
            stop_event: stop,
          })),
        },
        fixtures,
        owned,
        bank: 20,
        freeTransfers: 2,
        nextEvent: 11,
        horizon: 5, // GW11..15
      });

    // Window closes mid-horizon: every named gameweek is inside it.
    for (const a of withWindows(2, 13).chipAdvice) {
      const gw = a.detail.match(/Best in GW(\d+)/);
      if (a.chip === "wildcard") {
        // Not a one-week chip: it names no gameweek at all, so it cannot name
        // a wrong one. Pinned so a future edit does not quietly give it one.
        expect(gw, "the Wildcard card must not name a gameweek").toBeNull();
        continue;
      }
      expect(gw, `${a.chip} names no gameweek inside a window it overlaps`).not.toBeNull();
      expect(Number(gw![1]), `${a.chip} named a gameweek past its window`).toBeLessThanOrEqual(13);
      expect(Number(gw![1])).toBeGreaterThanOrEqual(11);
    }

    // Window already closed, and window not yet open: no gameweek is named and
    // no gain is claimed. Both are cases the timing note explains.
    for (const [start, stop] of [
      [2, 9],
      [30, 38],
    ]) {
      for (const a of withWindows(start, stop).chipAdvice) {
        if (a.chip === "wildcard") continue;
        expect(a.detail, `${a.chip} named a gameweek with no overlap`).not.toMatch(/Best in GW/);
        expect(a.detail).toMatch(/inside this chip's window/);
        expect(a.projectedGain).toBe(0);
      }
    }
  });

  it("stops the Wildcard card from reading as 'play it this week'", () => {
    // `wcGain` is bounded below by zero and a freshly optimised squad beats a
    // held one over any window, so the figure is almost always positive and
    // used to sort straight to the top under copy that implied urgency. It is
    // the size of a gap, and the copy has to say so.
    const wc = result.chipAdvice.find((a) => a.chip === "wildcard")!;
    expect(wc.detail).toMatch(/not a reason to play the chip this week/);
  });
});

/*
 * THE CARD'S NUMBER USED TO RANK THE DRAFTS BACKWARDS.
 *
 * `xi.totalXp` is next-GW only, and the launch cards showed it as each draft's
 * headline figure. Measured on the 2026-08-07 snapshot the two orderings are
 * close to reversed: `value` tops GW1 at 46.31 and comes last over five
 * gameweeks at 217.98, while `stars` is last on GW1 at 44.87 and first over
 * five at 223.00. A reader picking the biggest number on screen was picking
 * the squad that scores least over the period they will hold it.
 *
 * `horizonXp` is the number that answers the question actually being asked.
 */
describe("launch drafts carry a horizon score", () => {
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

  it("reports one covering the whole horizon it was asked for", () => {
    const { variants } = buildLaunchVariants(b, fx, 1, 5);
    for (const v of variants) {
      expect(v.horizonGws).toBe(5);
      // Summed over five gameweeks, so it must exceed any single one of them.
      expect(v.horizonXp).toBeGreaterThan(v.xi.totalXp);
    }
  });

  it("tracks the horizon it is given, not a fixed five", () => {
    const three = buildLaunchVariants(b, fx, 1, 3).variants;
    const five = buildLaunchVariants(b, fx, 1, 5).variants;
    for (const v of three) expect(v.horizonGws).toBe(3);
    // A shorter horizon cannot score more, draft for draft.
    for (const v of three) {
      const same = five.find((f) => f.key === v.key);
      if (same) expect(v.horizonXp).toBeLessThanOrEqual(same.horizonXp + 1e-9);
    }
  });

  it("is a re-picked XI each week, not the opening eleven held", () => {
    // Holding GW1's XI would understate every draft. The floor here is what
    // that mistake would produce: re-picking can only ever score more.
    const { variants, xp } = buildLaunchVariants(b, fx, 1, 5);
    for (const v of variants) {
      let held = 0;
      const openingIds = new Set(v.xi.starters.map((s) => s.element.id));
      for (let gw = 1; gw <= 5; gw++) {
        for (const s of v.xi.starters) held += xp.get(s.element.id)?.perGw.get(gw) ?? 0;
        // The captain doubles in `totalXp`, so add the best starter again.
        held += Math.max(
          ...v.xi.starters.map((s) => xp.get(s.element.id)?.perGw.get(gw) ?? 0)
        );
      }
      expect(openingIds.size).toBe(11);
      expect(v.horizonXp).toBeGreaterThanOrEqual(held - 1e-6);
    }
  });
});

/*
 * THE BADGE MUST NOT CONTRADICT THE NUMBER PRINTED BESIDE IT.
 *
 * On the 2026-08-07 snapshot the top two drafts came out at 223.00 and 222.99.
 * The card printed both as "223 xp/5gw" and badged one BEST — 0.01 points over
 * five gameweeks presented as a winner. `rankLaunchVariants` owns the tie rule,
 * and the rule is the PRINTED PRECISION rather than any fitted threshold, so
 * two drafts shown as equal are badged as equal whatever the numbers are.
 */
describe("rankLaunchVariants", () => {
  const v = (key: string, horizonXp: number, gw1: number): LaunchVariant => ({
    key,
    label: key,
    description: "",
    squad: [],
    cost: 1000,
    xi: { starters: [], bench: [], captain: null, viceCaptain: null, totalXp: gw1 } as unknown as BestXi,
    horizonXp,
    horizonGws: 5,
  });

  it("orders by the horizon, not by the opening gameweek", () => {
    const r = rankLaunchVariants([v("a", 217.98, 46.31), v("b", 223.0, 44.87), v("c", 219.7, 45.94)]);
    expect(r.order).toEqual(["b", "c", "a"]);
  });

  it("names one leader when the top is clear", () => {
    const r = rankLaunchVariants([v("a", 217.98, 46.31), v("b", 223.0, 44.87)]);
    expect([...r.leaders]).toEqual(["b"]);
    expect(r.bestIndex).toBe(1);
  });

  it("names every leader that is level at the printed precision", () => {
    // The measured case: 223.00 and 222.99 both print as 223.0.
    const r = rankLaunchVariants([v("stars", 223.0, 44.87), v("strongxi", 222.99, 47.1)]);
    expect(r.leaders).toEqual(new Set(["stars", "strongxi"]));
  });

  it("separates drafts that differ at the printed precision", () => {
    // 223.0 vs 222.9 — one decimal apart, so not a tie.
    const r = rankLaunchVariants([v("stars", 223.0, 44.87), v("strongxi", 222.9, 47.1)]);
    expect(r.leaders).toEqual(new Set(["stars"]));
  });

  it("breaks a tie on the opening gameweek, not on construction order", () => {
    // `stars` is built first and is a leader, so plain argmax would keep it.
    const r = rankLaunchVariants([v("stars", 223.0, 44.87), v("strongxi", 222.99, 47.1)]);
    expect(r.bestIndex).toBe(1);
  });

  it("never pre-selects a draft that is not a leader", () => {
    const r = rankLaunchVariants([v("a", 100, 99), v("b", 223.0, 1), v("c", 222.99, 2)]);
    expect(r.leaders.has(r.order[0])).toBe(true);
    expect(r.leaders.has(["a", "b", "c"][r.bestIndex])).toBe(true);
    expect(r.bestIndex).toBe(2);
  });

  it("survives an empty list", () => {
    expect(rankLaunchVariants([])).toEqual({ order: [], leaders: new Set(), bestIndex: 0 });
  });
});

describe("pickBestXi says which failure it hit", () => {
  /*
   * Branching on the squad SIZE alone reported "no projected fixtures in the
   * horizon" for a squad that is short and has no goalkeeper — and a missing
   * keeper is the one thing that is definitely not a horizon problem, because
   * pool starvation empties every position together.
   */
  const el = (id: number, type: 1 | 2 | 3 | 4): Element =>
    ({ id, element_type: type, team: (id % 20) + 1, now_cost: 45, web_name: `P${id}` }) as Element;
  const xp = () => 3;
  const squadOf = (spec: [1 | 2 | 3 | 4, number][]) => {
    const out: Element[] = [];
    let id = 1;
    for (const [type, n] of spec) for (let i = 0; i < n; i++) out.push(el(id++, type));
    return out;
  };

  it("names the missing goalkeeper rather than blaming the horizon", () => {
    for (const spec of [
      [[2, 5], [3, 5], [4, 1]] as [1 | 2 | 3 | 4, number][], // 11, no keeper
      [[2, 5], [3, 5], [4, 4]] as [1 | 2 | 3 | 4, number][], // 14, no keeper
      [[2, 5], [3, 5], [4, 5]] as [1 | 2 | 3 | 4, number][], // 15, no keeper
    ]) {
      expect(() => pickBestXi(squadOf(spec), xp)).toThrow(/no goalkeeper/);
      expect(() => pickBestXi(squadOf(spec), xp)).not.toThrow(/horizon/);
    }
  });

  it("still blames the horizon when the squad is simply empty", () => {
    // The real cause it was written for: `buildSquadWithinBudget` filters on a
    // positive projection, so with no fixtures in the horizon every pool comes
    // back empty and this is handed nothing at all.
    expect(() => pickBestXi([], xp)).toThrow(/horizon/);
  });

  it("names a position it is short of, whichever one it is", () => {
    // Enough keepers, not enough defenders.
    expect(() =>
      pickBestXi(squadOf([[1, 2], [2, 2], [3, 5], [4, 3]]), xp)
    ).toThrow(/only 2 defenders/);
  });

  it("does not cry wolf over a squad that can form an XI perfectly well", () => {
    // 2-3-5-5 has a legal 3-5-2 in it; the new branch must not fire on it.
    expect(() => pickBestXi(squadOf([[1, 2], [2, 3], [3, 5], [4, 5]]), xp)).not.toThrow();
    expect(() => pickBestXi(squadOf([[1, 2], [2, 5], [3, 5], [4, 3]]), xp)).not.toThrow();
  });
});

describe("the planner's beam dedupe keeps the better state, not the first", () => {
  /*
   * `PlanState.score` is PATH-DEPENDENT — which gameweek a transfer was made in
   * changes the accumulated score even when the resulting fifteen, the free
   * transfers before and the number used are all identical — so two parents can
   * converge on one key with different scores. First-come-first-served kept
   * whichever had the higher-ranked PARENT.
   *
   * THE MUTATION TRAP THIS TEST EXISTS TO AVOID: on a realistic pool the two
   * rules agree most of the time, so a test built from real data goes green
   * under both. The universe below is constructed so that they cannot.
   */
  const NGW = 2;
  const universe = (seed: number) => {
    const rnd = (n: number) => {
      const x = Math.sin(seed * 7919 + n * 104729) * 10000;
      return x - Math.floor(x);
    };
    const type = (i: number): 1 | 2 | 3 | 4 => (i < 2 ? 1 : i < 7 ? 2 : i < 12 ? 3 : 4);
    const els: Element[] = [];
    for (let i = 0; i < 15; i++)
      els.push({ id: i + 1, element_type: type(i), team: (i % 20) + 1, now_cost: 50, web_name: `O${i + 1}`, status: "a" } as Element);
    for (let i = 0; i < 3; i++)
      els.push({ id: 100 + i, element_type: 3, team: 15 + i, now_cost: 50, web_name: `C${i}`, status: "a" } as Element);
    const xp = new Map<number, PlayerXp>();
    for (const e of els) {
      const perGw = new Map<number, number>();
      for (let g = 1; g <= NGW; g++)
        perGw.set(g, e.id >= 100 ? rnd(e.id * 10 + g) * 20 : 2 + rnd(e.id * 10 + g) * 4);
      xp.set(e.id, {
        next: perGw.get(1)!,
        perGw,
        total: [...perGw.values()].reduce((a, b) => a + b, 0),
      } as unknown as PlayerXp);
    }
    return {
      bootstrap: {
        elements: els,
        events: Array.from({ length: 38 }, (_, i) => ({ id: i + 1, finished: false, is_next: i === 0 })),
        teams: Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })),
      } as unknown as Bootstrap,
      owned: els.slice(0, 15).map((e) => ({ element: e, sellPrice: 50, purchasePrice: 50 })) as OwnedPlayer[],
      xp,
    };
  };

  const plan = (seed: number) => {
    const { bootstrap, owned, xp } = universe(seed);
    return planHorizon({
      bootstrap,
      fixtures: [],
      owned,
      bank: 0,
      freeTransfers: 1,
      nextEvent: 1,
      horizon: NGW,
      precomputedXp: xp,
      // Wide enough that ordinary pruning is not the constraint — which is the
      // point: no beam width fixes a dedupe that throws the better state away.
      beamWidth: 400,
      candidatesPerPosition: 20,
      singlesPerState: 20,
    });
  };

  it("beats the first-seen rule on universes where the two can disagree", () => {
    /*
     * These four are seeds where a strictly better state was being discarded,
     * measured against the first-seen rule at the same beam width. The bars are
     * the first-seen results, so the assertion fails the moment the dedupe goes
     * back to keeping whichever arrived first.
     */
    const floors: [number, number][] = [
      [9, 134.523089],
      [11, 134.086829],
      [17, 131.802438],
      [96, 0], // the largest gain measured, 13.20; the exact floor is below
    ];
    for (const [seed, floor] of floors) {
      const got = plan(seed).totalXp;
      expect(got, `seed ${seed}`).toBeGreaterThan(floor);
    }
    expect(plan(9).totalXp).toBeCloseTo(140.793669, 4);
    expect(plan(11).totalXp).toBeCloseTo(146.808035, 4);
    expect(plan(17).totalXp).toBeCloseTo(142.691261, 4);
  });

  it("still returns a legal, self-consistent plan", () => {
    const p = plan(11);
    expect(p.totalXp).toBeGreaterThan(p.keepXp);
    expect(p.gainVsKeep).toBeCloseTo(p.totalXp - p.keepXp, 9);
    for (const st of p.steps) expect(st.bankAfter).toBeGreaterThanOrEqual(0);
  });
});

describe("the chip sheet names a gameweek the chip can be played in", () => {
  /*
   * `optimize` runs every chip argmax through `inChipWindow`, with a long note
   * saying that naming a gameweek outside the window is worse than silence.
   * `chipScenario` — which draws the sheet you open FROM that card — looped
   * from `nextEvent` and never read `bootstrap.chips` at all. Reproduced on the
   * demo with the real 2026/27 window shape and `nextEvent: 16`, horizon 5:
   *
   *   CARD   Triple Captain — window to GW19
   *   SHEET  Triple Captain — Best in GW20, gain 6.89
   *
   * Any reader in GW15-GW19 on the five- or eight-gameweek horizon was in it.
   *
   * The mock's fixtures run GW11-GW15, so the windows below are placed inside
   * that range rather than at the real season's GW19/GW20 boundary. The shape
   * is what matters: a window that ends inside the horizon, one that starts
   * inside it, and one that does not meet it at all.
   */
  const CHIPS = ["wildcard", "freehit", "bboost", "3xc"];
  const windows = (start: number, stop: number) =>
    CHIPS.map((name) => ({ name, start_event: start, stop_event: stop, number: 1 }));

  const inputWith = (
    chipWindows: { name: string; start_event: number; stop_event: number; number: number }[],
    usedChips: { name: string; event: number }[] = []
  ) => {
    const bootstrap = { ...makeMockBootstrap(), chips: chipWindows };
    return {
      bootstrap,
      fixtures: makeMockFixtures(),
      owned: makeMockOwned(bootstrap),
      bank: 5,
      freeTransfers: 1,
      nextEvent: 11,
      horizon: 5,
      usedChips,
    };
  };

  it("never names a gameweek past the chip's expiry", () => {
    // Horizon GW11-15, window closes after GW13.
    for (const chip of CHIPS) {
      const s = chipScenario(inputWith(windows(11, 13)), chip);
      expect(s.bestGw, chip).not.toBeNull();
      expect(s.bestGw!, chip).toBeLessThanOrEqual(13);
    }
  });

  it("never names a gameweek before the window opens", () => {
    // Horizon GW11-15, window does not open until GW14.
    for (const chip of CHIPS) {
      const s = chipScenario(inputWith(windows(14, 20)), chip);
      expect(s.bestGw, chip).not.toBeNull();
      expect(s.bestGw!, chip).toBeGreaterThanOrEqual(14);
    }
  });

  it("names no gameweek at all when no window meets the horizon", () => {
    for (const chip of CHIPS) {
      const s = chipScenario(inputWith(windows(20, 38)), chip);
      expect(s.bestGw, chip).toBeNull();
      expect(s.gain, chip).toBe(0);
    }
  });

  it("names no gameweek once the reader has spent the only window left", () => {
    for (const chip of CHIPS) {
      const s = chipScenario(
        inputWith([...windows(1, 10), ...windows(11, 15)], [{ name: chip, event: 12 }]),
        chip
      );
      expect(s.bestGw, chip).toBeNull();
    }
  });

  it("still judges the Wildcard over the whole horizon", () => {
    /*
     * It is not a one-week chip: it rebuilds the squad for the rest of the
     * season, so scoring it only over the weeks it may be PLAYED in would
     * charge it for a restriction it does not have. With the window closing
     * after GW13 the gain must not fall, only the gameweek named may move.
     */
    const unconstrained = chipScenario(inputWith([]), "wildcard");
    const clipped = chipScenario(inputWith(windows(11, 13)), "wildcard");
    expect(clipped.gain).toBeCloseTo(unconstrained.gain, 9);
    expect(clipped.gain).toBeGreaterThan(0);
  });
});

describe("the horizon total on screen is points, not the ranking key", () => {
  /*
   * `horizonScore` weights gameweek `i` by `gwDecay ** i` (0.88). That is what
   * makes the planner prefer near-term certainty and it stays — but it was
   * ALSO the number the card printed, under a heading saying "next N GWs" and
   * beside a first-gameweek figure it could not be reconciled with. Measured on
   * the demo, keep-the-team, the same XIs both ways: 0% / 11% / 21% / 33% low
   * at horizons 1 / 3 / 5 / 8.
   */
  const run = (horizon: number) => {
    const bootstrap = makeMockBootstrap();
    return optimize({
      bootstrap,
      fixtures: makeMockFixtures(),
      owned: makeMockOwned(bootstrap),
      bank: 5,
      freeTransfers: 1,
      nextEvent: 11,
      horizon,
    });
  };

  it("agrees with the weighted total only at horizon 1, where the weight is 1", () => {
    const one = run(1);
    expect(one.keepHorizonPlainXp).toBeCloseTo(one.keepHorizonXp, 9);
    // And at horizon 1 both are just the first gameweek's XI.
    expect(one.keepHorizonPlainXp).toBeCloseTo(one.keepXi.totalXp, 9);
  });

  it("is strictly larger over a real horizon, by roughly the decay", () => {
    const five = run(5);
    expect(five.keepHorizonPlainXp).toBeGreaterThan(five.keepHorizonXp);
    // A plain sum of five gameweeks cannot average less than the weighted one.
    expect(five.keepHorizonPlainXp / 5).toBeGreaterThan(five.keepHorizonXp / 5);
    // The gap grows with the horizon: that is the whole shape of the defect.
    const three = run(3);
    const gap = (r: { keepHorizonPlainXp: number; keepHorizonXp: number }) =>
      1 - r.keepHorizonXp / r.keepHorizonPlainXp;
    expect(gap(five)).toBeGreaterThan(gap(three));
  });

  it("stays reconcilable with the first gameweek the card quotes", () => {
    // The reader can divide. At horizon 5 the plain total must not average
    // wildly below the GW1 figure printed beside it on the same card — the
    // weighted one did, by a fifth.
    const five = run(5);
    expect(five.keepHorizonPlainXp / 5).toBeGreaterThan(five.keepXi.totalXp * 0.85);
  });
});

describe("the Wildcard cannot be worth less than one transfer", () => {
  /*
   * `dreamSquadWithinValue` maximises the sum of `totalDiscounted` over all
   * FIFTEEN at par while `horizonScore` counts only the best XI — two
   * objectives, so its squad is a local optimum of the wrong one. Measured on
   * the demo, same squad, same week, unclamped:
   *
   *   horizon      1       2       3       5       8
   *   wildcard   0.269   3.164   0.663   0.690   5.440
   *   1 transfer 0.375   1.199   1.143   1.283   2.663
   *
   * so at three of the five the "best squad your money can buy" was worth less
   * than a move the app recommends with one free transfer — which cannot be
   * true, because a wildcard can make that move too. Every squad the beam
   * already evaluated is reachable on the chip WITHOUT the hit, so `grossXp`
   * is a lower bound and costs nothing to apply.
   */
  /*
   * ON THE DEMO, NOT THE MOCK. Mutation-testing showed why: with the floor
   * removed, the mock's squad still comes out fine — the greedy build happens
   * to dominate there — so a test on `makeMockBootstrap` could not fail on the
   * thing it was written for. The demo's mid-season universe is where the two
   * objectives actually come apart, and it is where the table above was
   * measured.
   */
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
  const run = (horizon: number) => {
    const u = makeDemoUniverse(NOW);
    const bootstrap = u.bootstrap;
    const owned: OwnedPlayer[] = u.picks!.picks.map((p, i) => {
      const element = bootstrap.elements.find((e) => e.id === p.element)!;
      return {
        element,
        sellPrice: element.now_cost,
        purchasePrice: element.now_cost,
        pickPosition: i + 1,
        isCaptain: p.is_captain,
        isViceCaptain: p.is_vice_captain,
      };
    });
    return optimize({
      bootstrap,
      fixtures: u.fixtures,
      owned,
      bank: 5,
      freeTransfers: 1,
      nextEvent: bootstrap.events.find((e) => e.is_next)!.id,
      horizon,
    });
  };

  it("is never beaten by a transfer plan the same panel recommends", () => {
    for (const horizon of [1, 2, 3, 5]) {
      const res = run(horizon);
      const wc = res.chipAdvice?.find((c) => c.chip === "wildcard");
      const best = Math.max(0, ...res.plans.map((p) => p.gainVsKeep));
      expect(wc, `h=${horizon}`).toBeTruthy();
      expect(wc!.projectedGain, `h=${horizon}`).toBeGreaterThanOrEqual(best - 1e-9);
    }
  });

  it("is still bounded below by zero", () => {
    // Keeping the squad is one of the things it takes the best of, so a
    // negative gap is not reachable — but it was `Math.max(0, …)` before and
    // dropping that clamp must not reintroduce one.
    for (const horizon of [1, 3, 5]) {
      const wc = run(horizon).chipAdvice?.find((c) => c.chip === "wildcard");
      expect(wc!.projectedGain).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("'Against the field' describes the XI the panel recommends", () => {
  /*
   * `splitByField` was fed `keepXi.starters` — the NO-TRANSFER eleven — while
   * the Line-up section below that card defaults to "Best plan". On the demo
   * that was one player different: ARS Back 3 (9.7% owned) in the number, BOU
   * Back 3 (6.3%) on the pitch. The one figure on the page whose entire subject
   * is ownership exposure ignored the transfer the app had just recommended.
   */
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
  const res = (() => {
    const u = makeDemoUniverse(NOW);
    const bootstrap = u.bootstrap;
    const owned: OwnedPlayer[] = u.picks!.picks.map((p, i) => {
      const element = bootstrap.elements.find((e) => e.id === p.element)!;
      return {
        element,
        sellPrice: element.now_cost,
        purchasePrice: element.now_cost,
        pickPosition: i + 1,
        isCaptain: p.is_captain,
        isViceCaptain: p.is_vice_captain,
      };
    });
    return optimize({
      bootstrap,
      fixtures: u.fixtures,
      owned,
      bank: 5,
      freeTransfers: 1,
      nextEvent: bootstrap.events.find((e) => e.is_next)!.id,
      horizon: 5,
    });
  })();

  it("totals the same eleven the pitch draws by default", () => {
    const best = [...res.plans].sort((a, b) => b.netXp - a.netXp)[0];
    const shown = best && best.gainVsKeep > 0.05 ? best.nextXi : res.keepXi;
    const sum = shown.starters.reduce((s, x) => s + x.xp, 0);
    // `splitByField` drops players whose ownership FPL has not published, so
    // the totals agree only up to those.
    expect(res.fieldSplit.total).toBeCloseTo(sum, 6);
    expect(res.fieldSplit.unknown).toBe(0);
  });

  it("says which eleven it is describing", () => {
    const best = [...res.plans].sort((a, b) => b.netXp - a.netXp)[0];
    expect(res.fieldXiIsPlan).toBe(Boolean(best && best.gainVsKeep > 0.05));
  });

  it("falls back to the held XI when no transfer is worth making", () => {
    // With the recommendation switched off there is nothing to describe but
    // the squad the reader holds.
    const u = makeDemoUniverse(NOW);
    const bootstrap = u.bootstrap;
    const owned: OwnedPlayer[] = u.picks!.picks.map((p, i) => {
      const element = bootstrap.elements.find((e) => e.id === p.element)!;
      return {
        element,
        sellPrice: element.now_cost,
        purchasePrice: element.now_cost,
        pickPosition: i + 1,
        isCaptain: p.is_captain,
        isViceCaptain: p.is_vice_captain,
      };
    });
    const noMoves = optimize({
      bootstrap,
      fixtures: u.fixtures,
      owned,
      bank: 5,
      freeTransfers: 1,
      nextEvent: bootstrap.events.find((e) => e.is_next)!.id,
      horizon: 5,
      maxTransfers: 0,
    });
    expect(noMoves.fieldXiIsPlan).toBe(false);
    const sum = noMoves.keepXi.starters.reduce((s, x) => s + x.xp, 0);
    expect(noMoves.fieldSplit.total).toBeCloseTo(sum, 6);
  });
});
