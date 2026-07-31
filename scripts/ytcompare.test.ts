// Score three published 2026/27 opening squads against the app's own model, and
// against the drafts the app produces from the same data.
//
// This is a measurement harness, not a test of a feature. It exists because the
// question "is the app's draft actually as good as what an experienced player
// picks?" had been asked and never answered, and because answering it needs the
// LIVE season — pre-season is exactly when the archived CSVs in fpl-data are the
// wrong year and the model is leaning hardest on priors.
//
// Data comes from `../fpl-live/snapshot`, produced by the Actions job in
// .github/workflows/fpl-snapshot.yml (the dev sandbox cannot reach
// fantasy.premierleague.com directly; see that file). `global.fetch` is stubbed
// to serve the snapshot from disk so the REAL `fetchPastSeason` and the real
// `launchPool` run, rather than a reimplementation of them that could drift.
//
// It DOES assert, and the assertions are the point. An earlier version of this
// file had none, and `fetchPastSeason` swallows every throw: a stub regex that
// stopped matching would have produced a green run and a full page of
// plausible-looking numbers computed with no last-season record for anybody.
// Two independent assertions now close that (the failed-count check, and a
// sanity check that the points ranking has real values in it) — both verified by
// breaking the stub on a copy and watching the run go red.
//
// Run: npx vitest run -c vitest.yt.config.ts --disable-console-intercept

import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import { projectAll, XP_DEBUG, type PlayerXp } from "../src/lib/xp";
import {
  pickBestXi,
  buildLaunchVariants,
  buildSquadWithinBudget,
  type BestXi,
} from "../src/lib/optimizer";
import { launchPool } from "../src/lib/pool";
import { fetchPastSeason } from "../src/lib/fpl";
import { MAX_PER_CLUB, SQUAD_COMPOSITION, VALID_FORMATIONS, isValidFormation } from "../src/lib/rules";
import type { Bootstrap, Element, Fixture } from "../src/lib/types";

const SNAP = "/home/claude/work/fpl-live/snapshot";
const read = <T>(f: string): T => JSON.parse(readFileSync(`${SNAP}/${f}`, "utf8")) as T;

const bootstrap = read<Bootstrap>("bootstrap-static.json");
const fixtures = read<Fixture[]>("fixtures.json");
const summaries = read<Record<string, unknown>>("element-summaries.json");
const meta = read<{ fetchedAt: string }>("meta.json");

// Serve the snapshot to anything in src/lib/fpl.ts that asks for it. Only the
// element-summary route is needed: bootstrap and fixtures are handed in directly.
const origFetch = globalThis.fetch;
let stubHits = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const m = /element-summary\/(\d+)\//.exec(url);
  if (m) {
    const body = summaries[m[1]];
    if (body === undefined) return new Response("null", { status: 404 });
    stubHits++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unstubbed fetch: ${url}`);
}) as typeof fetch;
// Kept so a SECOND test in this file can put the stub back. The main test
// restores `origFetch` when it finishes, which is right — it should not leave a
// global monkey-patched for whatever runs next — but it also means any later
// test in the same file starts with the real transport and would try to reach
// fantasy.premierleague.com, which this sandbox cannot do. Discovered the
// obvious way.
const stubFetch = globalThis.fetch;

const byId = new Map(bootstrap.elements.map((e) => [e.id, e]));
const teamName = new Map(bootstrap.teams.map((t) => [t.id, t.short_name]));
const POS = ["", "GK", "DEF", "MID", "FWD"];
const el = (id: number): Element => {
  const e = byId.get(id);
  if (!e) throw new Error(`unknown element ${id}`);
  return e;
};
const fmt = (n: number) => n.toFixed(2);
const money = (tenths: number) => `£${(tenths / 10).toFixed(1)}m`;

/** FPL's own expected points for the coming GW. Blank/absent reads as 0. */
const epOf = (id: number) => parseFloat(String(el(id).ep_next ?? "0")) || 0;

/**
 * The three squads, transcribed from the screenshots. Cross-checked two ways
 * before being written down: every price shown matches `now_cost`, and every
 * player's club matches the GW1 opponent printed on his card against the live
 * fixture list. That second check covered 30 of the 34 cards — the four on FPL
 * Harry's bench show no fixture bar at all, so those rest on the name+club+price
 * match alone. It matters because several of these names are ambiguous in the
 * bootstrap ("Cunha" is a Man Utd midfielder AND a Forest defender, "Sarr" is
 * three players, "Palmer" is a Chelsea midfielder and an Ipswich keeper) and
 * picking the wrong one would silently change the answer.
 */
interface Squad {
  name: string;
  /** Full 15 where the screenshot showed one; XI only where it did not. */
  xi: number[];
  bench: number[];
  captain: number;
  vice: number;
  /** True where the armband was NOT visible and has been assumed. */
  armbandAssumed?: boolean;
  note?: string;
}

const SQUADS: Squad[] = [
  {
    name: "FPL Harry (First Draft)",
    xi: [1, 418, 9, 474, 368, 426, 40, 239, 346, 165, 411],
    bench: [111, 445, 50, 173],
    captain: 411,
    vice: 426,
  },
  {
    name: "FPLMate (first team)",
    xi: [412, 356, 11, 469, 88, 426, 427, 368, 335, 411, 165],
    bench: [],
    captain: 411,
    vice: 426,
    armbandAssumed: true,
    note: "screenshot showed the XI only, and no armband — captain assumed Haaland",
  },
  {
    // NOT "unlimited budget", which is what an earlier version of this file
    // called it. The word UNLIMITED in the screenshot sits under a Free Hit
    // badge, so it means unlimited TRANSFERS. The two £4.0m/£4.5m bench cards
    // are the bootstrap's minimum prices for their positions, and
    // 91.5 + 4.0 + 4.5 = exactly 100.0 — i.e. the draft is inside the normal
    // cap with two slots not yet filled, not a budget-free dream team.
    name: "Third draft (13 of 15 picked)",
    xi: [496, 329, 469, 11, 426, 154, 368, 208, 237, 411, 346],
    bench: [254, 449],
    captain: 411,
    vice: 426,
    note: "13 players shown; two bench slots left unfilled",
  },
];

// ---------------------------------------------------------------------------
// Squad construction used for the baselines and for completing partial squads.
// ---------------------------------------------------------------------------

// Deliberately the same predicate `buildSquadWithinBudget` applies, so "the set
// of players a squad may be built from" has one definition in this file rather
// than two that could drift. (The production filter is `status !== "u"`; `"n"`
// players are also unpickable but there are none in this snapshot, so the two
// agree here and this comment is the record of why.)
const PICKABLE = bootstrap.elements.filter(
  (e) => e.status !== "u" && e.status !== "n" && e.element_type >= 1 && e.element_type <= 4
);
const MIN_PRICE: Record<number, number> = {};
for (const pos of [1, 2, 3, 4]) {
  MIN_PRICE[pos] = Math.min(...PICKABLE.filter((e) => e.element_type === pos).map((e) => e.now_cost));
}

/**
 * Legal 15 by an arbitrary ranking, respecting 2/5/5/3, three per club and a
 * budget — with a feasibility guard so a greedy run cannot paint itself into a
 * corner it can no longer afford to fill.
 *
 * Used ONLY to complete a partial squad at the cheapest legal price, where
 * "greedy by minus price" is exactly the right algorithm. The baselines further
 * down deliberately do NOT use this: they go through the app's own
 * `buildSquadWithinBudget`, because a baseline built by a weaker search would
 * flatter the model by handing it the search's advantage as well as the
 * ranking's.
 */
function greedySquad(
  rank: (e: Element) => number,
  budget = 1000,
  seed: Element[] = []
): { squad: Element[]; cost: number } | null {
  const squad = [...seed];
  const used = new Set(seed.map((e) => e.id));
  const need = { 1: 2, 2: 5, 3: 5, 4: 3 } as Record<number, number>;
  const club = new Map<number, number>();
  let cost = 0;
  for (const e of seed) {
    need[e.element_type]--;
    club.set(e.team, (club.get(e.team) ?? 0) + 1);
    cost += e.now_cost;
  }
  if (Object.values(need).some((n) => n < 0)) return null;

  const reserveAfter = (pos: number) => {
    let r = 0;
    for (const p of [1, 2, 3, 4]) r += (need[p] - (p === pos ? 1 : 0)) * MIN_PRICE[p];
    return r;
  };

  const order = [...PICKABLE].sort((a, b) => rank(b) - rank(a));
  for (const e of order) {
    if (Object.values(need).every((n) => n === 0)) break;
    if (used.has(e.id)) continue;
    const pos = e.element_type;
    if (need[pos] <= 0) continue;
    if ((club.get(e.team) ?? 0) >= MAX_PER_CLUB) continue;
    if (cost + e.now_cost + reserveAfter(pos) > budget) continue;
    squad.push(e);
    used.add(e.id);
    need[pos]--;
    club.set(e.team, (club.get(e.team) ?? 0) + 1);
    cost += e.now_cost;
  }
  if (!Object.values(need).every((n) => n === 0)) return null;
  return { squad, cost };
}

/** Fill a partial squad to a legal 15 as cheaply as possible. */
const cheapestCompletion = (seed: Element[]) => greedySquad((e) => -e.now_cost, 1000, seed);

/*
 * The cheapest completion is the WRONG way to score a partial human squad, and
 * an earlier version of this file used it for exactly that while calling it
 * "exactly the right algorithm". It is the right algorithm for pricing how much
 * of the budget a partial squad has left — which is what it was written for —
 * but as a way of filling the slots a screenshot did not show it is a handicap:
 * it spends the remaining money on the cheapest bodies in the game, and the
 * all-15 and 5-GW columns then measure the harness's fill rather than the
 * human's judgement. On FPLMate — the strongest of the three humans, and so the
 * one it matters most for — the cheapest fill handed over four players worth
 * 0.42, 0.50, 0.38 and 0.39 GW1 xP while Mitchell at £4.5m and 2.52 was
 * affordable the whole time.
 *
 * `bestCompletion` fills the same slots with the app's OWN search instead. That
 * is deliberately generous to the human: it gives them the app's optimiser for
 * the players they never revealed, so any remaining margin cannot be the fill.
 * Both are reported, because the honest range for a partial squad is the pair,
 * not either one on its own.
 */
// NOT `buildSquadWithinBudget(..., {mustInclude})`, which is the obvious choice
// and which produced an ILLEGAL £101.0m squad here. That is worth recording,
// because it is a real (if currently unreachable) limitation of the production
// function rather than a mistake in this file: its downgrade loop skips locked
// players by design (`optimizer.ts`, "never downgrade a forced pick"), so with
// eleven of the fifteen locked at £82.5m it has only four slots to absorb the
// overspend, and when the top-40-per-position pools do not contain anything
// cheap enough it exits via `if (!bestSwap) break` and RETURNS OVER BUDGET
// rather than failing. Production only ever locks one or two premiums, where
// the remaining slack is ample — every app variant here comes out at exactly
// £100.0m and legal — so this is not a live bug, but the function is silent
// about it, and a caller that locked more would get an illegal squad back with
// no indication. Worth hardening separately; out of scope for a measurement.
//
// `greedySquad` is used instead: its `reserveAfter` guard keeps enough money in
// hand to fill every remaining slot at minimum price, so it is legal by
// construction or returns null.
const bestCompletion = (seed: Element[], score: (id: number) => number) =>
  greedySquad((e) => score(e.id), 1000, seed);

function legality(squad: Element[], cost: number): string {
  const club = new Map<number, number>();
  for (const e of squad) club.set(e.team, (club.get(e.team) ?? 0) + 1);
  const posCount = [0, 0, 0, 0, 0];
  for (const e of squad) posCount[e.element_type]++;
  const bad: string[] = [];
  if (squad.length !== 15) bad.push(`${squad.length} players`);
  for (const t of [1, 2, 3, 4] as const)
    if (posCount[t] !== SQUAD_COMPOSITION[t]) bad.push(`${POS[t]}=${posCount[t]}`);
  const over = [...club.entries()].filter(([, n]) => n > MAX_PER_CLUB);
  if (over.length) bad.push(`club ${over.map(([t, n]) => `${teamName.get(t)}=${n}`).join(",")}`);
  if (cost > 1000) bad.push(`cost ${money(cost)}`);
  return bad.length ? `ILLEGAL: ${bad.join(" ")}` : "legal";
}

// ---------------------------------------------------------------------------
// Two reference ceilings.
// ---------------------------------------------------------------------------

/**
 * The cheapest bench any legal squad can get away with, minimised over
 * formations. Deliberately an UNDER-estimate: it charges the minimum price of a
 * position once per benched slot even where two players at that price do not
 * exist, and it takes the cheapest formation. Both errors push the XI's spendable
 * budget UP, which can only make the resulting bound looser.
 *
 * That direction is the whole point. An earlier version used a closed-form
 * "1 GK + 2x cheapest outfield + 1x next cheapest" which happened to be right on
 * this snapshot only because DEF is the cheapest position and no formation
 * benches three defenders. Had MID been cheapest, `[5,2,3]` benches three of
 * them, the formula would have OVERCHARGED the bench, and the "upper bound"
 * could have come out BELOW the true optimum — a false ceiling, which is far
 * worse than a loose one.
 */
const CHEAPEST_BENCH = Math.min(
  ...VALID_FORMATIONS.map(
    ([d, m, f]) => MIN_PRICE[1] + (5 - d) * MIN_PRICE[2] + (5 - m) * MIN_PRICE[3] + (3 - f) * MIN_PRICE[4]
  )
);

/**
 * The highest GW1 score any XI could reach under budget and formation rules,
 * ignoring the three-per-club cap. A RELAXATION, so a genuine ceiling, but not
 * necessarily a squad anyone could field.
 *
 * Solved exactly by knapsack DP per position, convolved over cost. The captain
 * doubles, so the objective is not separable; each strong player is forced in as
 * captain in turn and the enumeration stops on a PROOF rather than on a guessed
 * cut: with M the best XI sum under no forcing, a candidate of value v(c) cannot
 * exceed M + v(c), so once that falls at or below the best found the rest are
 * eliminated. (The previous version just took the top 12 by value and asserted
 * the winner was not the last one examined, which is not the same thing.)
 */
function xiUpperBound(value: (id: number) => number): {
  bound: number;
  captain: string;
  captainsTried: number;
  proved: boolean;
} {
  const B = 1000 - CHEAPEST_BENCH;
  const NEG = -1e9;

  /** dp[k][c] = best value picking exactly k of `pool` for cost at most c. */
  const posTable = (pool: Element[], maxK: number): Float64Array[] => {
    const t: Float64Array[] = [];
    for (let k = 0; k <= maxK; k++) t.push(new Float64Array(B + 1).fill(NEG));
    t[0].fill(0);
    for (const e of pool) {
      const c = e.now_cost;
      const v = value(e.id);
      for (let k = maxK; k >= 1; k--) {
        const cur = t[k];
        const prev = t[k - 1];
        for (let budget = B; budget >= c; budget--) {
          const cand = prev[budget - c] + v;
          if (cand > cur[budget]) cur[budget] = cand;
        }
      }
    }
    for (const a of t) for (let i = 1; i <= B; i++) if (a[i - 1] > a[i]) a[i] = a[i - 1];
    return t;
  };

  const conv = (a: Float64Array, b: Float64Array): Float64Array => {
    const out = new Float64Array(B + 1).fill(NEG);
    for (let i = 0; i <= B; i++) {
      if (a[i] <= NEG / 2) continue;
      const av = a[i];
      for (let j = 0; j + i <= B; j++) {
        if (b[j] <= NEG / 2) continue;
        const s = av + b[j];
        if (s > out[i + j]) out[i + j] = s;
      }
    }
    for (let i = 1; i <= B; i++) if (out[i - 1] > out[i]) out[i] = out[i - 1];
    return out;
  };

  const poolsFor = (exclude: number | null) => {
    const p: Record<number, Element[]> = { 1: [], 2: [], 3: [], 4: [] };
    for (const e of PICKABLE) if (e.id !== exclude) p[e.element_type].push(e);
    return p;
  };

  /** Best XI sum (no captain bonus) over all formations within `budget`. */
  const bestXiSum = (
    tables: Record<number, Float64Array[]>,
    discount: Record<number, number>,
    budget: number
  ) => {
    let bestSum = NEG;
    for (const [d, m, f] of VALID_FORMATIONS) {
      const want = { 1: 1 - (discount[1] ?? 0), 2: d - (discount[2] ?? 0), 3: m - (discount[3] ?? 0), 4: f - (discount[4] ?? 0) };
      if (Object.values(want).some((n) => n < 0)) continue;
      let acc = tables[1][want[1]];
      for (const pos of [2, 3, 4]) acc = conv(acc, tables[pos][want[pos]]);
      if (acc[budget] > bestSum) bestSum = acc[budget];
    }
    return bestSum;
  };

  const openPools = poolsFor(null);
  const openTables: Record<number, Float64Array[]> = {
    1: posTable(openPools[1], 1),
    2: posTable(openPools[2], 5),
    3: posTable(openPools[3], 5),
    4: posTable(openPools[4], 3),
  };
  const M = bestXiSum(openTables, {}, B); // no captain forced, no captain bonus

  const candidates = [...PICKABLE].sort((a, b) => value(b.id) - value(a.id));
  let best = NEG;
  let bestCap = "";
  let tried = 0;
  let proved = false;
  for (const cap of candidates) {
    // Nothing below this candidate can beat what we already have.
    if (M + value(cap.id) <= best + 1e-9) {
      proved = true;
      break;
    }
    tried++;
    const remaining = B - cap.now_cost;
    if (remaining < 0) continue;
    const pools = poolsFor(cap.id);
    const tables: Record<number, Float64Array[]> = {
      1: posTable(pools[1], 1),
      2: posTable(pools[2], 5),
      3: posTable(pools[3], 5),
      4: posTable(pools[4], 3),
    };
    const discount = { [cap.element_type]: 1 } as Record<number, number>;
    const sum = bestXiSum(tables, discount, remaining);
    if (sum <= NEG / 2) continue;
    const total = sum + value(cap.id) * 2;
    if (total > best) {
      best = total;
      bestCap = cap.web_name;
    }
  }
  return { bound: best, captain: bestCap, captainsTried: tried, proved };
}

/**
 * The best FULLY LEGAL squad this harness can find, by hill-climbing single
 * swaps from several starting points. A lower bound on the legal optimum, and
 * the number that actually settles what the relaxed ceiling above cannot: how
 * much of the gap between the app's draft and that ceiling is the club cap, and
 * how much is the app's search leaving points behind.
 *
 * The distinction matters because an earlier version of this file asserted the
 * headroom was unreachable "because the bound ignores the club cap", and that
 * was simply an assumption. It is not true here, and a hill-climb was all it
 * took to show it.
 */
function bestLegalSquad(
  value: (id: number) => number,
  seeds: Element[][],
  /**
   * What the climb maximises. Defaults to the best-XI-plus-captain score, which
   * is the natural reading of "best squad". Pass a whole-squad function to climb
   * on a different objective — used to test whether the app's greedy search is
   * weak or merely aiming somewhere else.
   */
  objective?: (squad: Element[]) => number
): { squad: Element[]; cost: number; xi: BestXi } | null {
  // Deterministic LCG: a rerun must produce the same number or it is not a
  // measurement.
  let seed = 20260726;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const byPos: Record<number, Element[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const e of PICKABLE) byPos[e.element_type].push(e);
  // Only players with some projected value are worth swapping in; the rest just
  // slow the climb down.
  for (const pos of [1, 2, 3, 4])
    byPos[pos] = byPos[pos].filter((e) => value(e.id) > 0).sort((a, b) => value(b.id) - value(a.id)).slice(0, 60);

  const score = objective ?? ((squad: Element[]) => pickBestXi(squad, value).totalXp);

  let bestSquad: Element[] | null = null;
  let bestScore = -Infinity;

  /** Is putting `inEl` in slot `i` of `squad` legal, given the running cost? */
  const canSwap = (squad: Element[], i: number, inEl: Element, cost: number): boolean => {
    const out = squad[i];
    if (inEl.id === out.id) return false;
    if (inEl.element_type !== out.element_type) return false;
    if (squad.some((s, j) => j !== i && s.id === inEl.id)) return false;
    if (cost - out.now_cost + inEl.now_cost > 1000) return false;
    let n = 0;
    for (let j = 0; j < squad.length; j++) if (j !== i && squad[j].team === inEl.team) n++;
    return n < MAX_PER_CLUB;
  };

  const climb = (start: Element[]) => {
    let squad = [...start];
    let cost = squad.reduce((a, e) => a + e.now_cost, 0);
    if (cost > 1000 || legality(squad, cost) !== "legal") return;
    let cur = score(squad);
    for (let iter = 0; iter < 400; iter++) {
      let improved = false;
      // Neighbourhood 1: single swaps. Cheap, and does most of the work.
      for (let i = 0; i < squad.length && !improved; i++) {
        for (const inEl of byPos[squad[i].element_type]) {
          if (!canSwap(squad, i, inEl, cost)) continue;
          const trial = [...squad];
          trial[i] = inEl;
          const s = score(trial);
          if (s > cur + 1e-9) {
            cost = cost - squad[i].now_cost + inEl.now_cost;
            squad = trial;
            cur = s;
            improved = true;
            break;
          }
        }
      }
      if (improved) continue;
      // Neighbourhood 2: PAIRED swaps — downgrade one slot to fund an upgrade in
      // another. Without this the climb is essentially stuck the moment the squad
      // is at £100.0m, because every single upgrade is unaffordable and every
      // single downgrade loses points, so a budget-tight local optimum looks
      // global when it is not. An earlier version of this harness had only
      // neighbourhood 1 and reported a "best legal squad" 2.55 xP below what the
      // paired neighbourhood reaches from the same seeds, which would have made
      // the app's search look better than it is.
      for (let i = 0; i < squad.length && !improved; i++) {
        // Fund the upgrade by selling slot i down. Only downgrades are useful
        // here; an affordable upgrade would already have been taken above.
        for (const cheap of byPos[squad[i].element_type]) {
          if (cheap.now_cost >= squad[i].now_cost) continue;
          if (!canSwap(squad, i, cheap, cost)) continue;
          const mid = [...squad];
          mid[i] = cheap;
          const midCost = cost - squad[i].now_cost + cheap.now_cost;
          for (let j = 0; j < mid.length && !improved; j++) {
            if (j === i) continue;
            for (const up of byPos[mid[j].element_type]) {
              if (up.now_cost <= mid[j].now_cost) continue;
              if (!canSwap(mid, j, up, midCost)) continue;
              const trial = [...mid];
              trial[j] = up;
              const s = score(trial);
              if (s > cur + 1e-9) {
                squad = trial;
                cost = midCost - mid[j].now_cost + up.now_cost;
                cur = s;
                improved = true;
                break;
              }
            }
          }
          if (improved) break;
        }
      }
      if (!improved) break;
    }
    if (cur > bestScore) {
      bestScore = cur;
      bestSquad = squad;
    }
  };

  for (const s of seeds) climb(s);
  // A few random legal restarts, so the answer is not just "wherever the app's
  // draft happens to sit in the basin".
  for (let r = 0; r < 6; r++) {
    const start = greedySquad((e) => value(e.id) * (0.6 + 0.8 * rand()));
    if (start) climb(start.squad);
  }
  if (!bestSquad) return null;
  const squad = bestSquad as Element[];
  const cost = squad.reduce((a, e) => a + e.now_cost, 0);
  return { squad, cost, xi: pickBestXi(squad, value) };
}

// ---------------------------------------------------------------------------

interface Row {
  name: string;
  /** GW1 xP of the XI + captain — the headline, and the app's XI objective. */
  ours: number;
  /** FPL's own ep_next over the same XI + captain. */
  ep: number;
  /** GW1 xP of all 15 + captain, i.e. what a Bench Boost would return. */
  all15: number;
  /** Sum of best-XI xP over GW1..GW5, XI re-picked each week. */
  gw5: number;
  cost: number | null;
  note?: string;
}
const NA = Number.NaN;

test("score the published squads and the app's drafts on live 2026/27 data", async () => {
  const nextEvent = bootstrap.events.find((e) => e.is_next)?.id;
  if (nextEvent == null) throw new Error("no is_next event in the snapshot");
  const events = Array.from({ length: 5 }, (_, i) => nextEvent + i);

  const pool = launchPool(bootstrap.elements);
  const past = await fetchPastSeason(pool, 16);
  console.log(
    `\nSnapshot fetched ${meta.fetchedAt}: ${bootstrap.elements.length} elements, ` +
      `next event GW${nextEvent}. Pool ${pool.length}, past-season records ${past.data.size}, ` +
      `failed ${past.failed}.`
  );

  // The run is worthless without the last-season record, and the record is
  // fetched through a stubbed transport that fails silently. Checked, not hoped.
  expect(past.failed).toBe(0);
  expect(past.data.size).toBe(pool.length);
  expect(stubHits).toBeGreaterThanOrEqual(pool.length);

  // Exactly the production call: same pool, same past-season map, same horizon.
  XP_DEBUG.minutes = new Map();
  const { xp, variants } = buildLaunchVariants(bootstrap, fixtures, nextEvent, 5, past.data);
  // All FOUR drafts, on the real pool. `>= 3` used to stand here, which is a
  // floor with no ceiling: the app showed three cards while claiming four and
  // this line stayed green.
  //
  // Be clear about what this run does and does not cover. It asserts
  // `past.failed === 0` above, so it is the path WITH last-season minutes, and
  // on that path the balanced draft's dearest player is £12.0m — the old fixed
  // £8.5m cap bound perfectly well and the bug was never reachable here. The
  // regression lives on the fallback path (`pastSeason` undefined, which
  // `OptimizePanel` passes when the history lookup comes back empty), where
  // the dearest pick drops to £8.0m. That path is covered by the mock test in
  // `src/lib/__tests__/optimizer.test.ts`. What THIS line is worth is the
  // other half: that the four drafts stay four, and stay distinct, on the real
  // pool the app actually ships against.
  expect(variants.map((v) => v.key)).toEqual(["balanced", "stars", "value", "strongxi"]);
  const maxPriceOf = (k: string) =>
    Math.max(...variants.find((v) => v.key === k)!.squad.map((e) => e.now_cost));
  expect(maxPriceOf("value")).toBeLessThan(maxPriceOf("balanced"));
  const mmOf = (id: number) => XP_DEBUG.minutes?.get(id) ?? null;
  const one = (id: number): PlayerXp | undefined => xp.get(id);
  const nextOf = (id: number) => one(id)?.next ?? 0;

  /** 5-GW score with the XI re-picked each week, applied identically to everyone. */
  const horizon5 = (squad: Element[]) =>
    events.reduce(
      (sum, gw) => sum + pickBestXi(squad, (id) => one(id)?.perGw.get(gw) ?? 0).totalXp,
      0
    );
  const all15Of = (squad: Element[], captainId: number) =>
    squad.reduce((a, e) => a + nextOf(e.id), 0) + nextOf(captainId);

  const rows: Row[] = [];

  // Every id named in a squad must have been projected. A typo'd id would
  // otherwise contribute a silent zero. A projected ZERO, on the other hand, is
  // legitimate — a genuinely unavailable player scores nothing — so that is a
  // warning, not a failure: aborting the whole comparison because one human
  // picked an injured player would be the harness breaking, not the data.
  for (const s of SQUADS)
    for (const id of [...s.xi, ...s.bench]) {
      expect(xp.has(id), `no projection for element ${id}`).toBe(true);
      if (nextOf(id) <= 0)
        console.log(`  ! ${el(id).web_name} (${id}) projects 0.00 for GW1 — status "${el(id).status}"`);
    }

  // And the transcribed squads themselves must be legal where they are complete,
  // with a legal formation. A mistyped id that put four players from one club in
  // a squad would otherwise just print a slightly wrong number.
  for (const s of SQUADS) {
    const listed = [...s.xi, ...s.bench].map(el);
    expect(new Set(listed.map((e) => e.id)).size, `${s.name} has a duplicated player`).toBe(listed.length);
    expect(s.xi.length, `${s.name} XI is not 11`).toBe(11);
    const shape = [0, 0, 0, 0, 0];
    for (const id of s.xi) shape[el(id).element_type]++;
    expect(shape[1], `${s.name} XI has ${shape[1]} keepers`).toBe(1);
    expect(
      isValidFormation(shape[2], shape[3], shape[4]),
      `${s.name} XI formation ${shape[2]}-${shape[3]}-${shape[4]} is not legal`
    ).toBe(true);
    if (listed.length === 15) {
      const cost = listed.reduce((a, e) => a + e.now_cost, 0);
      expect(legality(listed, cost), `${s.name} is not a legal squad`).toBe("legal");
    }
    expect([...s.xi, ...s.bench], `${s.name} captain is not in the squad`).toContain(s.captain);
  }

  const asPickedOurs = (s: Squad) => s.xi.reduce((a, id) => a + nextOf(id), 0) + nextOf(s.captain);
  const asPickedEp = (s: Squad) => s.xi.reduce((a, id) => a + epOf(id), 0) + epOf(s.captain);
  const xiEp = (xi: BestXi) =>
    xi.starters.reduce((a, x) => a + epOf(x.element.id), 0) + epOf(xi.captain?.element.id ?? 0);

  // --- the published squads --------------------------------------------------
  for (const s of SQUADS) {
    const listed = [...s.xi, ...s.bench].map(el);
    const listedCost = listed.reduce((a, e) => a + e.now_cost, 0);
    const completed =
      listed.length === 15 ? { squad: listed, cost: listedCost } : cheapestCompletion(listed);

    console.log(`\n=== ${s.name}`);
    if (s.note) console.log(`    (${s.note})`);
    console.log(
      `    ${listed.length} players listed, ${money(listedCost)}` +
        (listed.length === 15
          ? ""
          : `; cheapest legal completion to 15 costs ${completed ? money(completed.cost) : "n/a"}` +
            ` (leaves ${completed ? money(1000 - completed.cost) : "-"} of slack)`)
    );
    console.log(
      `    XI as picked: our GW1 xP ${fmt(asPickedOurs(s))}   FPL ep_next ${fmt(asPickedEp(s))}` +
        `   (captain ${el(s.captain).web_name}${s.armbandAssumed ? ", ASSUMED" : ""})`
    );

    rows.push({
      name: `${s.name} — as picked`,
      ours: asPickedOurs(s),
      ep: asPickedEp(s),
      all15: listed.length === 15 ? all15Of(listed, s.captain) : NA,
      gw5: NA,
      cost: listed.length === 15 ? listedCost : null,
      note: listed.length === 15 ? undefined : `XI only, ${money(listedCost)} of ${listed.length} players`,
    });

    // The generous fill: same revealed players, the app's own search for the
    // rest. Only meaningful where the screenshot was short of 15.
    const generous =
      listed.length === 15
        ? null
        : bestCompletion(listed, (id) => xp.get(id)?.totalDiscounted ?? 0);
    if (generous) {
      // A completion that overspends is not a completion. This assertion is the
      // one that caught the mustInclude overspend described above.
      expect(
        legality(generous.squad, generous.cost),
        `${s.name}: generous completion is not legal`
      ).toBe("legal");
      const gXi = pickBestXi(generous.squad, nextOf);
      console.log(
        `    completed by the APP'S OWN SEARCH instead of cheapest: ${money(generous.cost)}` +
          `  GW1 XI ${fmt(gXi.totalXp)}  all 15 ${fmt(all15Of(generous.squad, gXi.captain?.element.id ?? s.captain))}` +
          `  5-GW ${fmt(horizon5(generous.squad))}  ${legality(generous.squad, generous.cost)}`
      );
      rows.push({
        name: `${s.name} — best legal completion`,
        ours: gXi.totalXp,
        ep: xiEp(gXi),
        all15: all15Of(generous.squad, gXi.captain?.element.id ?? s.captain),
        gw5: horizon5(generous.squad),
        cost: generous.cost,
        note: "unrevealed slots filled by the app's own search — generous to the human",
      });
    }

    if (completed) {
      const reXi = pickBestXi(completed.squad, nextOf);
      console.log(
        `    XI re-picked from the same 15: our GW1 xP ${fmt(reXi.totalXp)}  ` +
          `(captain ${reXi.captain?.element.web_name}, formation ${reXi.formation.join("-")})`
      );
      console.log(
        `    all 15 + captain ${fmt(all15Of(completed.squad, reXi.captain?.element.id ?? s.captain))}` +
          `   5-GW (XI re-picked weekly) ${fmt(horizon5(completed.squad))}` +
          `   ${legality(completed.squad, completed.cost)}`
      );
      const out = s.xi.filter((id) => !reXi.starters.some((x) => x.element.id === id));
      const inn = reXi.starters.filter((x) => !s.xi.includes(x.element.id));
      if (out.length)
        console.log(
          `    model benches ${out.map((id) => el(id).web_name).join(", ")}` +
            ` -> starts ${inn.map((x) => x.element.web_name).join(", ")}`
        );
      rows.push({
        name: `${s.name} — model re-picks XI`,
        ours: reXi.totalXp,
        ep: xiEp(reXi),
        all15: all15Of(completed.squad, reXi.captain?.element.id ?? s.captain),
        gw5: horizon5(completed.squad),
        cost: completed.cost,
        note: listed.length === 15 ? undefined : "completed at cheapest legal",
      });
    }

    console.log("    per player (GW1 / 5GW / status / FPL ep_next):");
    for (const id of [...s.xi, ...s.bench]) {
      const e = el(id);
      const bench = s.bench.includes(id) ? "(b) " : "    ";
      console.log(
        `      ${bench}${(POS[e.element_type] + " " + e.web_name).padEnd(22)} ${teamName.get(e.team)}  ` +
          `${money(e.now_cost).padStart(7)}  gw1 ${fmt(nextOf(id))}  5gw ${fmt(one(id)?.total ?? 0)}` +
          `  status ${e.status}  ep_next ${e.ep_next ?? "-"}` +
          (e.news_added ? `  news_added ${e.news_added}` : "") +
          (past.data.has(id) ? "" : "  [NO RECORD]")
      );
    }
  }

  // --- information the humans did not have ----------------------------------
  // Garner picked up an injury flag roughly a day before this snapshot was
  // taken, i.e. AFTER at least some of these drafts were published. Scoring him
  // at his flagged availability marks a human down for news he could not have
  // read.
  //
  // Healing him means undoing BOTH consequences of the flag, not one. Setting
  // `status` back to "a" restores the availability multiplier; it does NOT
  // restore `ep_next`, which FPL itself zeroes for flagged players and which
  // carries ~0.385 of the projection at GW1. An earlier version healed only the
  // status and so reported about 60% of the real asymmetry. There is no way to
  // recover the ep_next FPL would have published, so it is imputed from his
  // unflagged peers at the same price and position, and reported as an
  // imputation.
  const GARNER = 239;
  const garner = el(GARNER);
  if (garner.status !== "a") {
    const peers = bootstrap.elements.filter(
      (e) =>
        e.id !== GARNER &&
        e.element_type === garner.element_type &&
        e.now_cost === garner.now_cost &&
        e.status === "a" &&
        epOf(e.id) > 0
    );
    const peerEp = peers.length
      ? peers.map((e) => epOf(e.id)).sort((a, b) => a - b)[Math.floor(peers.length / 2)]
      : 0;
    const heal = (e: Element) =>
      e.id === GARNER
        ? { ...e, status: "a", chance_of_playing_next_round: null, news: "", news_added: null, ep_next: String(peerEp) }
        : e;
    const healedXp = projectAll({
      bootstrap: { ...bootstrap, elements: bootstrap.elements.map(heal) } as Bootstrap,
      fixtures,
      nextEvent,
      horizon: 5,
      pastSeason: past.data,
    });
    const healedNext = (id: number) => healedXp.get(id)?.next ?? 0;
    console.log(
      `\n=== Information asymmetry: ${garner.web_name} is "${garner.status}"` +
        ` (news_added ${garner.news_added}, snapshot ${meta.fetchedAt})`
    );
    console.log(
      `    FPL publishes ep_next ${garner.ep_next ?? "-"} for him because it zeroes it for flagged players;` +
        ` ${peers.length} unflagged ${POS[garner.element_type]}s at ${money(garner.now_cost)} have a median of ${peerEp}.`
    );
    console.log(
      `    ${garner.web_name} GW1 xP: ${fmt(nextOf(GARNER))} flagged -> ${fmt(healedNext(GARNER))} healed+imputed.`
    );
    for (const s of SQUADS) {
      if (![...s.xi, ...s.bench].includes(GARNER)) continue;
      const healedTotal = s.xi.reduce((a, id) => a + healedNext(id), 0) + healedNext(s.captain);
      console.log(
        `    ${s.name}: our GW1 xP ${fmt(asPickedOurs(s))} as scored -> ${fmt(healedTotal)} without the flag` +
          ` (+${fmt(healedTotal - asPickedOurs(s))}).`
      );
      rows.push({
        name: `${s.name} — as picked, no injury flag`,
        ours: healedTotal,
        ep: NA,
        all15: NA,
        gw5: NA,
        cost: [...s.xi, ...s.bench].length === 15 ? [...s.xi, ...s.bench].reduce((a, id) => a + el(id).now_cost, 0) : null,
        note: `counterfactual; ep_next imputed at ${peerEp} from peers`,
      });
    }
  }

  // --- what the app itself drafts --------------------------------------------
  for (const v of variants) {
    const capId = v.xi.captain?.element.id ?? 0;
    console.log(
      `\n=== APP: ${v.label}  (15 for ${money(v.cost)}, XI ${money(v.xi.starters.reduce((a, x) => a + x.element.now_cost, 0))})`
    );
    console.log(
      `    GW1 xP ${fmt(v.xi.totalXp)}   FPL ep_next ${fmt(xiEp(v.xi))}   ` +
        `all 15 + captain ${fmt(all15Of(v.squad, capId))}   5-GW ${fmt(horizon5(v.squad))}   ` +
        `captain ${v.xi.captain?.element.web_name}   formation ${v.xi.formation.join("-")}   ` +
        legality(v.squad, v.cost)
    );
    for (const x of [...v.xi.starters, ...v.xi.bench]) {
      const e = x.element;
      const bench = v.xi.bench.includes(x) ? "(b) " : "    ";
      console.log(
        `      ${bench}${(POS[e.element_type] + " " + e.web_name).padEnd(22)} ${teamName.get(e.team)}  ` +
          `${money(e.now_cost).padStart(7)}  gw1 ${fmt(nextOf(e.id))}  5gw ${fmt(one(e.id)?.total ?? 0)}` +
          `  sel ${e.selected_by_percent}%  ep_next ${e.ep_next ?? "-"}`
      );
    }
    rows.push({
      name: `APP: ${v.label}`,
      ours: v.xi.totalXp,
      ep: xiEp(v.xi),
      all15: all15Of(v.squad, capId),
      gw5: horizon5(v.squad),
      cost: v.cost,
    });
  }

  // --- baselines: what NO modelling at all achieves --------------------------
  // This is the comparison the first version of this harness was missing, and
  // without it every number above is unreadable. "The app beats three YouTubers
  // by 5-9 xP" means nothing until you know what sorting the player list by last
  // season's points scores, because if that lands in the same place then the
  // model is not what produced the gap.
  //
  // Each baseline goes through the app's OWN `buildSquadWithinBudget` with the
  // model's ranking swapped out for a naive one. The candidate universe, the
  // three-per-club handling, the downgrade loop and the spend-the-remainder pass
  // are all identical, so the difference between a baseline row and an app row is
  // the ranking and nothing else. (`buildSquadWithinBudget` also filters on the
  // model's `total > 0`, which sounds like a leak; replacing the map with a
  // constant changes none of the four baselines by a single player, because
  // exactly one pickable player fails that filter.)
  //
  // Two scores are printed per baseline. "model XI" lets our model choose the XI
  // and armband out of the naive 15 — which is not zero-modelling at all, and on
  // the points-per-start row it was worth +9.1 on its own. "naive XI" keeps the
  // baseline's own ranking all the way through, and is the honest floor.
  //
  // NB `past.data.get(id).points` is the most recent season WITH MINUTES, not
  // literally last season (see fpl.ts) — 19 of 364 records are a year older than
  // they look. Restricting it to last season only leaves the headline row at
  // exactly 45.02, so it is documented rather than worked around.
  const mostRecentPlayedSeasonPoints = (id: number) => past.data.get(id)?.points ?? 0;
  // A minimum-starts floor is not a nicety here. Without one, points-per-start is
  // won by players with a single appearance — Chiesa's 37 points in 1 start reads
  // as 37.00 per start — so the "baseline" measured who had one good cameo and
  // scored 24.86 with £17.5m left unspent. It is a ranking of noise, not a floor.
  const MIN_STARTS = 20;
  const recentPpg = (id: number) => {
    const p = past.data.get(id);
    if (!p || !p.minutes) return 0;
    const starts = p.starts && p.starts > 0 ? p.starts : p.minutes / 90;
    if (starts < MIN_STARTS) return 0;
    return p.points / starts;
  };
  const BASELINES: { name: string; rank: (id: number) => number }[] = [
    { name: "BASELINE: last season total_points", rank: mostRecentPlayedSeasonPoints },
    {
      name: "BASELINE: ownership (selected_by_%)",
      rank: (id) => parseFloat(el(id).selected_by_percent) || 0,
    },
    { name: `BASELINE: points-per-start (min ${MIN_STARTS} starts)`, rank: recentPpg },
    { name: "BASELINE: price only (now_cost)", rank: (id) => el(id).now_cost },
  ];
  expect(mostRecentPlayedSeasonPoints(411), "Haaland should have last-season points").toBeGreaterThan(100);
  expect(new Set(pool.map(mostRecentPlayedSeasonPoints)).size, "points ranking is degenerate").toBeGreaterThan(50);
  expect(new Set(pool.map(recentPpg)).size, "ppg ranking is degenerate").toBeGreaterThan(50);

  console.log("\n=== Zero-modelling baselines (app's own £100m search, naive ranking)");
  for (const b of BASELINES) {
    const built = buildSquadWithinBudget(bootstrap.elements, xp, 1000, b.rank);
    const modelXi = pickBestXi(built.squad, nextOf);
    const naiveXi = pickBestXi(built.squad, b.rank);
    // The naive XI's players are the baseline's, but scoring them still has to be
    // done with a common yardstick or the columns are not comparable.
    const naiveOurs =
      naiveXi.starters.reduce((a, x) => a + nextOf(x.element.id), 0) +
      nextOf(naiveXi.captain?.element.id ?? 0);
    const naiveEp =
      naiveXi.starters.reduce((a, x) => a + epOf(x.element.id), 0) +
      epOf(naiveXi.captain?.element.id ?? 0);
    console.log(
      `  ${b.name.padEnd(42)} model XI ${fmt(modelXi.totalXp).padStart(6)} / naive XI ${fmt(naiveOurs).padStart(6)}` +
        `   ep_next ${fmt(xiEp(modelXi)).padStart(6)} / ${fmt(naiveEp).padStart(6)}` +
        `   ${money(built.cost)}  ${legality(built.squad, built.cost)}`
    );
    console.log(`      model XI: ${modelXi.starters.map((x) => x.element.web_name).join(", ")}`);
    rows.push({
      name: `${b.name} [model XI]`,
      ours: modelXi.totalXp,
      ep: xiEp(modelXi),
      all15: all15Of(built.squad, modelXi.captain?.element.id ?? 0),
      gw5: horizon5(built.squad),
      cost: built.cost,
    });
    rows.push({
      name: `${b.name} [naive XI]`,
      ours: naiveOurs,
      ep: naiveEp,
      all15: NA,
      gw5: NA,
      cost: built.cost,
      note: "XI and armband also chosen by the naive ranking",
    });
  }

  // --- is the gap a WEAK SEARCH or a DIFFERENT OBJECTIVE? -------------------
  // This is the question the whole "headroom" discussion turns on, and it is
  // decidable rather than arguable.
  //
  // The hill-climb below finds a legal squad worth ~2.9 more GW1 XI xP than the
  // app's best draft. The tempting reading is "the app's greedy search is
  // leaving points on the table". The alternative reading is "the app is
  // maximising something else, and doing it well". They are distinguished by
  // running the SAME hill-climb on the app's ACTUAL objective — the sum over all
  // fifteen of discounted horizon xP, which is what `buildSquadWithinBudget`
  // ranks by (optimizer.ts, default `scoreOf`) — and seeing whether a much
  // stronger search beats the app's greedy one THERE.
  //
  // If the stronger search wins on the app's own objective, the search is weak
  // and should be fixed. If it merely ties, the search is already at (or at
  // least level with) the optimum it is aiming for, and the 2.9 is the price of
  // the objective, not a defect.
  const sum15 = (squad: Element[]) =>
    squad.reduce((a, e) => a + (xp.get(e.id)?.totalDiscounted ?? 0), 0);
  const appBestOnOwnObjective = variants.reduce(
    (best, v) => (sum15(v.squad) > sum15(best.squad) ? v : best),
    variants[0]
  );
  const climbedOnOwnObjective = bestLegalSquad(
    (id) => xp.get(id)?.totalDiscounted ?? 0,
    variants.map((v) => v.squad),
    sum15
  );
  console.log("\n=== Is the headroom a weak search, or a different objective?");
  console.log(
    `  app's own objective = sum over all 15 of discounted horizon xP (optimizer.ts default scoreOf)`
  );
  console.log(`  app's best draft on that objective          ${fmt(sum15(appBestOnOwnObjective.squad))}`);
  if (climbedOnOwnObjective) {
    console.log(
      `  strong hill-climb on that same objective    ${fmt(sum15(climbedOnOwnObjective.squad))}` +
        `  ${money(climbedOnOwnObjective.cost)}  ${legality(climbedOnOwnObjective.squad, climbedOnOwnObjective.cost)}`
    );
    const sameSquad =
      new Set(climbedOnOwnObjective.squad.map((e) => e.id)).size === 15 &&
      climbedOnOwnObjective.squad.every((e) => appBestOnOwnObjective.squad.some((a) => a.id === e.id));
    console.log(
      `  => the stronger search beats the app by ${fmt(sum15(climbedOnOwnObjective.squad) - sum15(appBestOnOwnObjective.squad))}` +
        ` on the app's own objective${sameSquad ? " (it found the IDENTICAL squad)" : ""}.`
    );
  }
  // And the converse: what the 2.9-better GW1 squad is worth by the app's own
  // yardstick. If it is far WORSE, then "headroom" is the wrong word entirely —
  // the two squads are answers to two different questions.
  const legalBestForObjective = bestLegalSquad(nextOf, variants.map((v) => v.squad));
  if (legalBestForObjective) {
    console.log(
      `  the GW1-maximising ceiling squad scores     ${fmt(sum15(legalBestForObjective.squad))}` +
        ` on the app's objective (${fmt(sum15(legalBestForObjective.squad) - sum15(appBestOnOwnObjective.squad))} vs the app's draft)`
    );
  }

  // --- an external claim, checked ------------------------------------------
  // A review agent asserted a specific fully-legal £100.0m squad reaching 49.95
  // GW1 XI xP, and that number was very nearly written into a report to the user
  // on the agent's word. It is checked here instead, by name, because "an agent
  // said so" is not a measurement and the claim is easy to falsify: sum the xP of
  // the eleven named players, add the best captain among them, price the cheapest
  // legal completion. Whatever the answer, the number that gets reported is the
  // one this file computes.
  const CLAIMED = [
    "Raya", "Gabriel", "Virgil", "Guéhi", "Tarkowski",
    "Lacroix", "B.Fernandes", "Rice", "Semenyo", "Gibbs-White", "Watkins",
  ];
  console.log("\n=== Checking an externally-claimed 49.95 XI, player by player");
  const claimedEls: Element[] = [];
  for (const name of CLAIMED) {
    const hits = bootstrap.elements.filter((e) => e.web_name === name);
    if (hits.length !== 1) {
      console.log(`  ! "${name}" matches ${hits.length} elements — cannot check this claim`);
      continue;
    }
    claimedEls.push(hits[0]);
  }
  if (claimedEls.length === CLAIMED.length) {
    const claimedSum = claimedEls.reduce((a, e) => a + nextOf(e.id), 0);
    const claimedCap = Math.max(...claimedEls.map((e) => nextOf(e.id)));
    const claimedCost = claimedEls.reduce((a, e) => a + e.now_cost, 0);
    for (const e of claimedEls) {
      console.log(
        `      ${(POS[e.element_type] + " " + e.web_name).padEnd(22)} ${teamName.get(e.team)}  ` +
          `${money(e.now_cost).padStart(7)}  gw1 ${fmt(nextOf(e.id))}`
      );
    }
    const shape = [0, 0, 0, 0, 0];
    for (const e of claimedEls) shape[e.element_type]++;
    const completion = cheapestCompletion(claimedEls);
    console.log(
      `  claimed XI sums to ${fmt(claimedSum)} + best captain ${fmt(claimedCap)} = ` +
        `${fmt(claimedSum + claimedCap)}   XI cost ${money(claimedCost)}   ` +
        `shape ${shape.slice(2).join("-")} ${isValidFormation(shape[2], shape[3], shape[4]) ? "legal" : "ILLEGAL"}` +
        (completion ? `   full 15 ${money(completion.cost)} ${legality(completion.squad, completion.cost)}` : "   no legal completion")
    );
    console.log(
      `  => the claim was ${fmt(49.95)}; measured ${fmt(claimedSum + claimedCap)}` +
        ` (difference ${fmt(49.95 - (claimedSum + claimedCap))}).`
    );
  }

  // --- ceilings -------------------------------------------------------------
  const boundOurs = xiUpperBound(nextOf);
  const boundEp = xiUpperBound(epOf);
  const legalBest = bestLegalSquad(nextOf, variants.map((v) => v.squad));
  console.log("\n=== Ceilings");
  console.log(
    `  RELAXED upper bound on GW1 xP (no club cap)  ${fmt(boundOurs.bound)}  ` +
      `captain ${boundOurs.captain}  [${boundOurs.captainsTried} captains evaluated, ` +
      `${boundOurs.proved ? "optimality of the relaxation PROVED" : "NOT proved"}]`
  );
  console.log(
    `  RELAXED upper bound on ep_next              ${fmt(boundEp.bound)}  captain ${boundEp.captain}` +
      `  [${boundEp.captainsTried} evaluated, ${boundEp.proved ? "proved" : "NOT proved"}]`
  );
  // If the enumeration ever stops because it ran out of candidates rather than
  // because it proved the rest cannot win, the "bound" is an unknown amount too
  // low, which is the one failure mode worse than a loose bound.
  expect(boundOurs.proved, "upper bound on our xP was not proved optimal").toBe(true);
  expect(boundEp.proved, "upper bound on ep_next was not proved optimal").toBe(true);
  if (legalBest) {
    console.log(
      `  BEST FULLY LEGAL squad found (hill-climb)   ${fmt(legalBest.xi.totalXp)}  ` +
        `${money(legalBest.cost)}  ep_next ${fmt(xiEp(legalBest.xi))}  ` +
        `all 15 + captain ${fmt(all15Of(legalBest.squad, legalBest.xi.captain?.element.id ?? 0))}  ` +
        `5-GW ${fmt(horizon5(legalBest.squad))}  ${legality(legalBest.squad, legalBest.cost)}`
    );
    console.log(`      XI: ${legalBest.xi.starters.map((x) => `${x.element.web_name}(${teamName.get(x.element.team)})`).join(", ")}`);
    console.log(`      bench: ${legalBest.xi.bench.map((x) => `${x.element.web_name} ${fmt(nextOf(x.element.id))}`).join(", ")}`);
    // A hill-climb result that is not legal, or that is above the relaxed bound,
    // means one of the two is wrong.
    expect(legality(legalBest.squad, legalBest.cost)).toBe("legal");
    expect(legalBest.xi.totalXp).toBeLessThanOrEqual(boundOurs.bound + 1e-6);
    rows.push({
      name: "CEILING: best legal squad found (hill-climb)",
      ours: legalBest.xi.totalXp,
      ep: xiEp(legalBest.xi),
      all15: all15Of(legalBest.squad, legalBest.xi.captain?.element.id ?? 0),
      gw5: horizon5(legalBest.squad),
      cost: legalBest.cost,
      note: "maximises GW1 XI only — note its bench",
    });
  }
  rows.push({
    name: "CEILING: relaxed upper bound (no club cap)",
    ours: boundOurs.bound,
    ep: boundEp.bound,
    all15: NA,
    gw5: NA,
    cost: 1000,
    note: "not a squad; a proven ceiling",
  });

  // --- the ep_next ablation -------------------------------------------------
  // `ep_next` is NOT an independent yardstick for these squads, and an earlier
  // version of this file claimed it was. It is an INPUT to our projection: at
  // GW1, with no games played, the blend puts about 0.385 of a NAILED starter's
  // xP on `ep_next` directly (less for anyone the minutes model discounts, since
  // the term is scaled by pStart and availability — the population-wide mean
  // derivative is nearer 0.17). Across the 558 projected players our xP
  // correlates with ep_next at Pearson 0.74. Marking the app's draft with
  // ep_next is therefore closer to marking it with a noisy copy of its own
  // objective than to a second opinion.
  //
  // What CAN be asked honestly: does the app still draft an ep_next-strong squad
  // when the model cannot see ep_next at all? Strip the field, re-draft, and
  // score those drafts on the real ep_next.
  const blindBootstrap = {
    ...bootstrap,
    elements: bootstrap.elements.map((e) => ({ ...e, ep_next: null })),
  } as unknown as Bootstrap;
  const blind = buildLaunchVariants(blindBootstrap, fixtures, nextEvent, 5, past.data);
  console.log("\n=== Ablation: app re-drafts with ep_next stripped, then scored on the real ep_next");
  for (const v of blind.variants) {
    const ep = xiEp(v.xi);
    console.log(
      `  ${("ABLATED " + v.label).padEnd(42)} ep_next ${fmt(ep).padStart(6)}  ${money(v.cost)}  ` +
        `captain ${v.xi.captain?.element.web_name}`
    );
    rows.push({
      name: `ABLATED (no ep_next): ${v.label}`,
      ours: NA,
      ep,
      all15: NA,
      gw5: NA,
      cost: v.cost,
      note: "drafted blind to ep_next",
    });
  }

  // --- the whole board ------------------------------------------------------
  console.log("\n=== EVERYTHING, one table");
  const col = (n: number, w: number) => (Number.isNaN(n) ? "-" : fmt(n)).padStart(w);
  console.log(
    `  ${"".padEnd(52)} ${"GW1 XI".padStart(8)} ${"ep_next".padStart(8)} ${"all 15".padStart(8)} ${"5-GW".padStart(8)} ${"cost".padStart(8)}`
  );
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(52)} ${col(r.ours, 8)} ${col(r.ep, 8)} ${col(r.all15, 8)} ${col(r.gw5, 8)} ` +
        `${(r.cost == null ? "-" : money(r.cost)).padStart(8)}` +
        (r.note ? `   ${r.note}` : "")
    );
  }

  for (const v of variants) expect(legality(v.squad, v.cost)).toBe("legal");

  // --- the minutes model, for every player named anywhere in this run --------
  // The single biggest reason two projections disagree pre-season is pStart, and
  // pStart is invisible in the xP number. Printed with the evidence it was built
  // from so a suspicious value can be traced to a suspicious input.
  const named = new Set<number>();
  for (const s of SQUADS) for (const id of [...s.xi, ...s.bench]) named.add(id);
  for (const v of variants) for (const e of v.squad) named.add(e.id);
  console.log("\n=== Minutes model (pStart / minsPerStart / share) and the record behind it");
  const mrows = [...named].map((id) => ({ id, e: el(id), mm: mmOf(id), p: past.data.get(id) }));
  mrows.sort((a, b) => (b.mm?.pStart ?? 0) - (a.mm?.pStart ?? 0));
  for (const r of mrows) {
    const last = r.p?.lastSeason;
    console.log(
      `  ${(POS[r.e.element_type] + " " + r.e.web_name).padEnd(24)} ${teamName.get(r.e.team)} ` +
        `${money(r.e.now_cost).padStart(7)}  pStart ${(r.mm?.pStart ?? NaN).toFixed(3)}` +
        `  mps ${(r.mm?.minsPerStart ?? NaN).toFixed(0)}  share ${(r.mm?.share ?? NaN).toFixed(3)}` +
        `  pre ${r.mm?.preseason ? "y" : "n"} ev ${r.mm?.hasEvidence ? "y" : "n"}` +
        `  last ${last ? `${last.seasonName} ${last.minutes}min ${last.starts ?? "?"}st` : "none"}` +
        `  seasons ${r.p?.plSeasons ?? "?"}`
    );
  }

  globalThis.fetch = origFetch;
});

// ---------------------------------------------------------------------------
// THE HAALAND THRESHOLD
//
// The app's £100.0m draft does not contain Erling Haaland, and the user asked
// whether that can possibly be right. The answer given at the time included a
// sensitivity table — "his projection would have to rise by X% before he gets
// picked" — and that table was produced in conversation, from a reading of the
// model rather than from a run of it. Nothing in this repository computed X, so
// nothing in this repository could contradict it when it was wrong.
//
// This block computes it. It is gated because it runs a full hill-climb per
// probe point and takes minutes:
//
//   HAALAND=1 npx vitest run -c vitest.yt.config.ts --disable-console-intercept
//
// WHAT IS AND IS NOT PROVED HERE. `bestLegalSquad` is a seeded hill-climb, not
// an exact solver, so the number below is the point at which THE SEARCH switches
// over, and a stronger search could switch earlier. That is a real limitation
// and it is why the assertion is a band rather than a point. What the band does
// close is the failure mode that produced the bad table in the first place: a
// figure quoted with nothing behind it. Two independent guards make a
// mis-measured threshold loud rather than plausible — the climb must find a
// Haaland-free squad at the bottom of the bracket and a Haaland-containing one
// at the top, and the forced-in comparison must reproduce the gap the threshold
// implies. A threshold with no squad change under it is not a threshold.
//
// The interesting quantity is not really the percentage anyway; it is the
// straight cost of overriding the model, printed first. "How many points does
// insisting on Haaland cost" is a question the user can act on. "By what factor
// is the model wrong about him" is a question about the model.
//
// AS MEASURED on the 2026-07-26 snapshot, GW1, horizon 5:
//
//   Haaland £15.5m, discounted horizon xP 21.62, GW1 xP 5.50
//   best legal squad                   205.71   £100.0m   Haaland out
//   best legal squad containing him    200.26   £100.0m
//   cost of insisting                    5.45   (2.65% of the squad total)
//   threshold                          +25.2%   (21.62 -> 27.08)
//
// The two are the same measurement seen twice: 21.62 x 0.252 = 5.45, which is
// what the consistency assertion at the end checks and is the reason it is
// there rather than being left as a coincidence for a reader to notice.
//
// The conversational table this replaces said +22.8%. That was not far out, and
// being not far out is exactly what made it dangerous — it read as though it had
// been computed. The squad it displaces is the part that table could not have
// got right at all: Haaland comes in alongside three DOWNGRADES (B.Fernandes
// £12.0m -> Fernandes £6.0m, Gabriel £8.0m -> Mukiele £5.5m, Bruno G. £7.0m ->
// Buendía £6.0m, Calvert-Lewin dropped), because at £15.5m he is not funded by
// one sale but by the whole spine. That, and not the percentage, is the honest
// answer to "is leaving Haaland out really smart?".
test.runIf(process.env.HAALAND)(
  "measures how far Haaland's projection must move before the app drafts him",
  { timeout: 1_800_000 },
  async () => {
    globalThis.fetch = stubFetch;
    try {
      const nextEvent = bootstrap.events.find((e) => e.is_next)?.id;
      if (nextEvent == null) throw new Error("no is_next event in the snapshot");
      const pool = launchPool(bootstrap.elements);
      const past = await fetchPastSeason(pool, 16);
      expect(past.failed).toBe(0);
      const { xp, variants } = buildLaunchVariants(bootstrap, fixtures, nextEvent, 5, past.data);

      // By name, then pinned to the id the rest of this file already uses. Either
      // check alone can pass on the wrong player: "Haaland" could in principle be
      // two people, and a hard-coded id silently becomes someone else when the
      // bootstrap is re-issued. Both together cannot.
      const haalands = bootstrap.elements.filter((e) => e.web_name === "Haaland");
      expect(haalands.length, "expected exactly one Haaland in the bootstrap").toBe(1);
      const HAA = haalands[0].id;
      expect(HAA).toBe(411);
      expect(el(HAA).element_type).toBe(4);

      // The app's real objective, exactly as `buildSquadWithinBudget` ranks by.
      const tdOf = (id: number) => xp.get(id)?.totalDiscounted ?? 0;
      expect(tdOf(HAA), "Haaland must have a positive projection or this measures nothing")
        .toBeGreaterThan(0);
      const valueAt = (lam: number) => (id: number) => (id === HAA ? tdOf(id) * lam : tdOf(id));
      const sumOf = (v: (id: number) => number) => (squad: Element[]) =>
        squad.reduce((a, e) => a + v(e.id), 0);
      const sum15 = sumOf(tdOf);
      const hasHaa = (squad: Element[]) => squad.some((e) => e.id === HAA);

      const seeds = variants.map((v) => v.squad);

      console.log(
        `\n=== THE HAALAND THRESHOLD  (snapshot ${meta.fetchedAt}, GW${nextEvent}, horizon 5)`
      );
      console.log(
        `  Haaland ${money(el(HAA).now_cost)}  discounted horizon xP ${fmt(tdOf(HAA))}` +
          `  GW1 xP ${fmt(xp.get(HAA)?.next ?? 0)}`
      );

      // --- 1. the unconstrained optimum ------------------------------------
      const base = bestLegalSquad(tdOf, seeds, sum15);
      if (!base) throw new Error("no legal squad found at all");
      console.log(
        `  best legal squad on the app's objective     ${fmt(sum15(base.squad))}` +
          `  ${money(base.cost)}  ${legality(base.squad, base.cost)}  Haaland ${hasHaa(base.squad) ? "IN" : "out"}`
      );

      // --- 2. what insisting on him costs -----------------------------------
      // Forced in by making him worth an unreachable amount TO THE CLIMB, then
      // scoring the squad it lands on with the REAL objective. A bonus rather
      // than a squad-membership constraint because `bestLegalSquad` has no
      // must-include parameter, and adding one to a function three other blocks
      // depend on to do something else is a worse trade than this.
      const BONUS = 1e6;
      const forcedValue = (id: number) => (id === HAA ? tdOf(id) + BONUS : tdOf(id));
      const forced = bestLegalSquad(forcedValue, seeds, sumOf(forcedValue));
      if (!forced) throw new Error("no legal squad found containing Haaland");
      expect(hasHaa(forced.squad), "the bonus failed to force Haaland in").toBe(true);
      const cost = sum15(base.squad) - sum15(forced.squad);
      console.log(
        `  best legal squad that CONTAINS Haaland      ${fmt(sum15(forced.squad))}` +
          `  ${money(forced.cost)}  ${legality(forced.squad, forced.cost)}`
      );
      console.log(
        `  => insisting on Haaland costs ${fmt(cost)} discounted xP over 5 GWs` +
          ` (${((100 * cost) / sum15(base.squad)).toFixed(2)}% of the squad total)`
      );
      const out = base.squad.filter((e) => !forced.squad.some((f) => f.id === e.id));
      const inn = forced.squad.filter((e) => !base.squad.some((b) => b.id === e.id));
      console.log(
        `     he displaces: ${out.map((e) => `${e.web_name} ${money(e.now_cost)}`).join(", ")}` +
          `\n     replaced by:  ${inn.map((e) => `${e.web_name} ${money(e.now_cost)}`).join(", ")}`
      );

      // --- 3. the threshold --------------------------------------------------
      // Bracket by doubling the uplift, then bisect. The Haaland-containing
      // squad from step 2 joins the seed set so the climb is never asked to
      // discover that basin from scratch at the moment it matters most; without
      // it the measured threshold is an artefact of where the seeds happen to
      // sit rather than of the objective.
      const probeSeeds = [...seeds, forced.squad, base.squad];
      const picksHaaland = (lam: number) => {
        const v = valueAt(lam);
        const r = bestLegalSquad(v, probeSeeds, sumOf(v));
        return r != null && hasHaa(r.squad);
      };

      expect(picksHaaland(1), "Haaland is already in the optimum; this block measures nothing")
        .toBe(false);
      let lo = 1;
      let hi = 1;
      for (let step = 0; step < 6; step++) {
        hi = 1 + 0.1 * Math.pow(2, step);
        console.log(`  bracketing at +${((hi - 1) * 100).toFixed(1)}% ...`);
        if (picksHaaland(hi)) break;
        lo = hi;
      }
      if (!picksHaaland(hi)) throw new Error(`Haaland not drafted even at +${((hi - 1) * 100).toFixed(0)}%`);
      for (let step = 0; step < 10; step++) {
        const mid = (lo + hi) / 2;
        if (picksHaaland(mid)) hi = mid;
        else lo = mid;
      }
      const pct = (hi - 1) * 100;
      console.log(
        `  => the app drafts Haaland once his projection rises by +${pct.toFixed(1)}%` +
          `  (bracket +${((lo - 1) * 100).toFixed(1)}% .. +${pct.toFixed(1)}%)`
      );
      console.log(
        `     i.e. ${fmt(tdOf(HAA))} -> ${fmt(tdOf(HAA) * hi)} discounted xP over the horizon`
      );

      // --- 4. the guards -----------------------------------------------------
      // A threshold is only meaningful if the squad really does change across
      // it. Both ends are re-run and compared, so a bisection that converged on
      // noise — the same squad on both sides, the flag flipping for some reason
      // other than Haaland — fails here instead of being printed as a finding.
      const below = bestLegalSquad(valueAt(lo), probeSeeds, sumOf(valueAt(lo)));
      const above = bestLegalSquad(valueAt(hi), probeSeeds, sumOf(valueAt(hi)));
      expect(below && hasHaa(below.squad)).toBe(false);
      expect(above && hasHaa(above.squad)).toBe(true);

      // And the threshold must be consistent with the cost measured in step 2:
      // at the switching point the uplift Haaland is given has to be worth about
      // what step 2 said displacing him is worth. On the measured run these
      // agree to two decimals (21.62 x 0.252 = 5.45 against 5.45), which is a
      // stronger statement than it looks — the two are computed by different
      // routes, one by differencing two climbs and one by bisecting a third.
      //
      // Written against `pct` and not against `hi`, deliberately. `pct` is the
      // number that gets printed, quoted, and told to the user, so it is the one
      // that has to be load-bearing; an off-by-a-factor between `hi` and `pct`
      // is precisely the kind of slip that produced the table this block
      // replaces, and a mutation halving `pct` survived the whole file while
      // this assertion still named `hi`.
      //
      // The lower bound is the tight one. The upper is loose because a hill-climb
      // can leave points on the table at either end, which inflates the apparent
      // uplift needed; 1.6 catches a doubling without failing on search slack.
      const upliftAtSwitch = (tdOf(HAA) * pct) / 100;
      expect(upliftAtSwitch).toBeGreaterThan(cost * 0.9);
      expect(upliftAtSwitch).toBeLessThan(cost * 1.6);

      // The band. Wide, on purpose: it is here to catch a model change that
      // moves Haaland's standing by a lot, not to freeze a hill-climb's third
      // decimal. Re-measure and widen with a comment if a legitimate change
      // trips it; do not narrow it to whatever today's run prints.
      expect(pct).toBeGreaterThan(5);
      expect(pct).toBeLessThan(60);
    } finally {
      globalThis.fetch = origFetch;
    }
  }
);

// ---------------------------------------------------------------------------
// THE SECOND KEEPER
//
// The autosub slot weights measured in `scripts/simulate.test.ts` (SLOTW=1,
// 152 managed gameweeks) put the substitute goalkeeper at 0.072 — he is on the
// pitch about one week in fourteen. The app's own draft has been buying him at
// £5.5m, out of a £100.0m budget, using an objective that values all fifteen
// players equally. That is £1.5m over the floor spent on a slot worth seven
// percent of a starting one, and the question the user asked is what taking it
// back is worth.
//
//   GK2=1 npx vitest run -c vitest.yt.config.ts --disable-console-intercept
//
// WHY THIS IS NOT CIRCULAR, WHICH IS THE ONLY REASON IT IS WORTH RUNNING. The
// obvious way to score a squad here is the app's own sum-over-fifteen, and
// that is exactly the yardstick that bought the expensive keeper in the first
// place — it would report any downgrade as a loss by construction. So the
// comparison is made on two quantities that are NOT the objective under test:
//
//   XI value  — discounted horizon xP of the eleven that actually play. The
//               eleven score every week; this is what the budget is for.
//   exposure  — the backup's own xP times 0.072, which is what is being given
//               up in expected autosub value.
//
// Net = gain in XI value - loss in exposure. Both terms come out of the same
// xP model, so this does not escape projection error — but it does escape the
// specific error of counting a bench keeper as though he were a starter, which
// is the error being investigated.
//
// The user's added condition is the right one and is reported alongside:
// cheap is not enough, the backup should also be someone who would actually
// PLAY if the first keeper is unavailable. A £4.0m third-choice keeper saves
// the money and quietly makes the 0.072 into something closer to zero, since
// he blanks in the same weeks everyone else does. `pStart` is printed for
// every candidate so that trade is visible rather than assumed.
//
// MEASURED, snapshot 2026-07-26, GW1, horizon 5 gameweeks:
//
//   best squad, app's objective   XI value 161.03  backup Donnarumma £5.5m pStart 0.92
//   same objective, keeper kept   XI value 163.51  backup Donnarumma £5.5m pStart 0.92
//   best squad, slot-weighted     XI value 165.93  backup Palmer     £4.0m pStart 0.53
//   => the whole move is +4.90 XI xP, split +2.48 cheaper OUTFIELD subs
//      and +2.42 the KEEPER. Only the second half is this block's question.
//   => net of the autosub exposure given up, the keeper downgrade is
//      +1.74 discounted xP over five gameweeks, for £1.5m released.
//
// The £4.0m tier all reach the same XI (165.93) — the eleven do not care WHICH
// £4.0m keeper is behind them — so within that tier the ranking is purely the
// backup's own xP, which is the user's criterion doing the work: Palmer (IPS,
// pStart 0.53) and Dovin (COV, 0.48) at +1.74 against Heaton/Pecsi/Jaros/Davies
// (pStart 0.00) at +1.52. Buying a keeper who might actually play is worth
// about 0.2 xP and costs nothing, so there is no reason not to.
//
// The £4.5m tier is the interesting trade and the answer is no. Perri (LEE)
// starts with pStart 0.95 — as close to a guaranteed starter as the pool has —
// and nets +0.84 against Palmer's +1.74. The extra £0.5m out of the XI costs
// about 0.90 xP over five gameweeks and buys 0.42 of pStart on a slot that is
// on the pitch one week in fourteen. At 0.072, near-certainty is not worth
// paying for; that is the whole point of the slot weight.
test.runIf(process.env.GK2)(
  "measures what a cheaper second goalkeeper is worth",
  { timeout: 1_800_000 },
  async () => {
    globalThis.fetch = stubFetch;
    try {
      const nextEvent = bootstrap.events.find((e) => e.is_next)?.id;
      if (nextEvent == null) throw new Error("no is_next event in the snapshot");
      const pool = launchPool(bootstrap.elements);
      const past = await fetchPastSeason(pool, 16);
      expect(past.failed).toBe(0);
      XP_DEBUG.minutes = new Map();
      const { xp, variants } = buildLaunchVariants(bootstrap, fixtures, nextEvent, 5, past.data);
      const pStartOf = (id: number) => XP_DEBUG.minutes?.get(id)?.pStart ?? NaN;

      const tdOf = (id: number) => xp.get(id)?.totalDiscounted ?? 0;
      const sum15 = (squad: Element[]) => squad.reduce((a, e) => a + tdOf(e.id), 0);

      // The measured profile, in bench order: sub GK first, then the three
      // outfield subs. Sourced from the SLOTW block, not guessed here — if that
      // measurement is re-run these must be updated with it.
      const W = [0.072, 0.513, 0.283, 0.046];
      const slotW = (squad: Element[]) => {
        const xi = pickBestXi(squad, tdOf);
        let t = xi.starters.reduce((a, s) => a + tdOf(s.element.id), 0);
        xi.bench.forEach((s, i) => {
          t += (W[i] ?? 0) * tdOf(s.element.id);
        });
        return t;
      };
      const xiValue = (squad: Element[]) =>
        pickBestXi(squad, tdOf).starters.reduce((a, s) => a + tdOf(s.element.id), 0);
      /** The keeper who ends up on the bench, i.e. the one this block is about. */
      const benchGk = (squad: Element[]) => {
        const gks = squad.filter((e) => e.element_type === 1);
        if (gks.length !== 2) throw new Error(`squad has ${gks.length} keepers`);
        return tdOf(gks[0].id) <= tdOf(gks[1].id) ? gks[0] : gks[1];
      };
      const describe1 = (e: Element) =>
        `${e.web_name} (${teamName.get(e.team)}) ${money(e.now_cost)} ` +
        `pStart ${pStartOf(e.id).toFixed(2)} xP ${fmt(tdOf(e.id))}`;

      const seeds = variants.map((v) => v.squad);
      console.log(`\n=== THE SECOND KEEPER  (snapshot ${meta.fetchedAt}, GW${nextEvent}, horizon 5)`);

      // --- what the app ships today -----------------------------------------
      const shipped = variants.reduce((b, v) => (sum15(v.squad) > sum15(b.squad) ? v : b), variants[0]);
      console.log(`  app's shipped draft      ${money(shipped.cost)}  backup ${describe1(benchGk(shipped.squad))}`);

      // --- the search's own optimum on the app's objective --------------------
      const base = bestLegalSquad(tdOf, seeds, sum15);
      if (!base) throw new Error("no legal squad found");
      const baseGk = benchGk(base.squad);
      console.log(
        `  best squad, app's objective  ${money(base.cost)}  XI value ${fmt(xiValue(base.squad))}` +
          `  backup ${describe1(baseGk)}`
      );

      // --- the locked climb, used for every row below --------------------------
      // Maximise `slotW` subject to `g` being IN the squad and being the SECOND
      // keeper. Both halves are needed. The `+1e6` in `forced` makes any squad
      // without `g` score 1e6 below any squad with him, so ownership is
      // absolute; the `- 1e6` afterwards only keeps the printed magnitudes sane
      // and cannot change the argmax (it shifts every containing squad by the
      // same constant).
      //
      // The `- 1e5` is the half that the first two runs of this block were
      // missing, and it mattered: locking Donnarumma without it produced a
      // reference squad that kept him and PROMOTED HIM INTO THE XI, selling the
      // first-choice keeper to pay for it and putting a £4.0m man on the bench.
      // That is a perfectly good squad and a useless reference — it has already
      // taken the cheap-backup decision that is supposed to be under test, so
      // the incumbent's real cost never appears. The question is what a £5.5m
      // player sitting on the BENCH costs, so the bench is where he has to sit.
      const lockedBest = (g: Element) => {
        const forced = (id: number) => (id === g.id ? tdOf(id) + 1e6 : tdOf(id));
        const r = bestLegalSquad(forced, [...seeds, base.squad], (sq) =>
          sq.reduce((a, e) => a + forced(e.id), 0) - 1e6 + slotW(sq) - sum15(sq) -
          (benchGk(sq).id === g.id ? 0 : 1e5)
        );
        // Ownership is enforced here; whether he ended up as the backup is left
        // to the caller, so the table can say so out loud instead of silently
        // dropping a row.
        return r && r.squad.some((e) => e.id === g.id) ? r : null;
      };

      // --- the reference: same objective, incumbent keeper kept ---------------
      // THIS IS THE COMPARISON THAT MATTERS AND THE FIRST RUN OF THIS BLOCK GOT
      // IT WRONG. Scoring each candidate against `base` (the sum-over-fifteen
      // optimum) charges the keeper with the whole gain from re-weighting the
      // bench — the three outfield subs get cheaper too, and every £4.0m keeper
      // came out with an identical "+4.91" precisely because that number was
      // not about the keeper at all. The honest reference is the same locked
      // climb, on the same objective, with the incumbent held in place: then
      // the only difference between reference and row is the keeper.
      const ref = lockedBest(baseGk);
      if (!ref) throw new Error("could not lock the incumbent keeper");
      if (benchGk(ref.squad).id !== baseGk.id)
        throw new Error("the incumbent would not stay on the bench; the reference is meaningless");
      const refXi = xiValue(ref.squad);
      console.log(
        `  same objective, keeper kept  ${money(ref.cost)}  XI value ${fmt(refXi)}` +
          `  backup ${describe1(benchGk(ref.squad))}`
      );

      // --- the same search told what the bench is actually worth --------------
      // No constraint at all; only the objective changes. If the slot weights
      // matter, this is where a cheaper keeper shows up on its own.
      const weighted = bestLegalSquad(tdOf, [...seeds, base.squad, ref.squad], slotW);
      if (!weighted) throw new Error("no legal squad found on the weighted objective");
      const wGk = benchGk(weighted.squad);
      console.log(
        `  best squad, slot-weighted    ${money(weighted.cost)}  XI value ${fmt(xiValue(weighted.squad))}` +
          `  backup ${describe1(wGk)}`
      );
      console.log(
        `  => weighting the bench moves the backup keeper ` +
          `${money(baseGk.now_cost)} -> ${money(wGk.now_cost)}` +
          ` and the XI ${fmt(xiValue(base.squad))} -> ${fmt(xiValue(weighted.squad))}`
      );
      // Split that gain in two, because the two halves are separate decisions and
      // only one of them is the question the user asked.
      console.log(
        `     of which cheaper OUTFIELD subs ${fmt(refXi - xiValue(base.squad))}` +
          ` and the KEEPER ${fmt(xiValue(weighted.squad) - refXi)} (XI xP over 5 GWs)`
      );

      // --- every cheap keeper, forced in and paid for --------------------------
      // Locked one at a time so the freed money is actually reinvested by the
      // climb rather than left in the bank, and so the answer is a table the
      // user can read down rather than a single winner with no alternatives.
      const gks = bootstrap.elements
        .filter((e) => e.element_type === 1 && PICKABLE.some((p) => p.id === e.id))
        .filter((e) => e.now_cost <= 45)
        .sort((a, b) => a.now_cost - b.now_cost || pStartOf(b.id) - pStartOf(a.id));
      console.log(`\n  ${gks.length} pickable keepers at £4.5m or less; each locked in as the backup:`);
      console.log(
        `  ${"keeper".padEnd(28)} ${"price".padStart(6)} ${"pStart".padStart(7)}` +
          ` ${"XI value".padStart(9)} ${"vs ref".padStart(8)} ${"exposure".padStart(9)} ${"net".padStart(7)}`
      );
      const baseExposure = W[0] * tdOf(baseGk.id);
      type Cand = { e: Element; xi: number; net: number; cost: number };
      const rows: Cand[] = [];
      for (const g of gks) {
        const r = lockedBest(g);
        if (!r) continue;
        // Only meaningful if he really is the BACKUP; a cheap keeper the model
        // rates ahead of the incumbent is a different question.
        const bg = benchGk(r.squad);
        if (bg.id !== g.id) {
          console.log(`  ${describe1(g).padEnd(52)}  (climbs into the XI, not the bench — skipped)`);
          continue;
        }
        const xiV = xiValue(r.squad);
        const exposure = W[0] * tdOf(g.id);
        const net = xiV - refXi - (baseExposure - exposure);
        rows.push({ e: g, xi: xiV, net, cost: r.cost });
        console.log(
          `  ${(g.web_name + " (" + teamName.get(g.team) + ")").padEnd(28)} ${money(g.now_cost).padStart(6)}` +
            ` ${pStartOf(g.id).toFixed(2).padStart(7)} ${fmt(xiV).padStart(9)}` +
            ` ${(xiV - refXi >= 0 ? "+" : "") + fmt(xiV - refXi)}`.padStart(9) +
            ` ${fmt(exposure).padStart(9)} ${((net >= 0 ? "+" : "") + fmt(net)).padStart(7)}`
        );
      }

      rows.sort((a, b) => b.net - a.net);
      const best = rows[0];
      if (best) {
        console.log(
          `\n  BEST: ${describe1(best.e)}  net ${(best.net >= 0 ? "+" : "") + fmt(best.net)} discounted xP over 5 GWs` +
            `  (squad ${money(best.cost)})`
        );
        console.log(
          `  Against the incumbent ${describe1(baseGk)} — the money released is ` +
            `${money(baseGk.now_cost - best.e.now_cost)}.`
        );
      }

      // --- guards --------------------------------------------------------------
      // The weights must be the measured ones, in bench order. A reordering here
      // silently reweights the whole table, and every number above would still
      // look plausible.
      expect(W).toEqual([0.072, 0.513, 0.283, 0.046]);
      expect(W[1]).toBeGreaterThan(W[0]);
      // The block measures nothing if there is no cheap keeper to compare with,
      // or if the incumbent is already at the floor.
      expect(rows.length).toBeGreaterThan(0);
      expect(baseGk.now_cost).toBeGreaterThan(40);
      // The headline: the winner sits at the £4.0m floor. If a model change ever
      // makes a £4.5m keeper win outright, that is a real finding and this line
      // should be re-measured, not relaxed.
      expect(best.e.now_cost).toBe(40);
      // `net` must charge the downgrade for the autosub exposure it gives up.
      // STRICT: dropping the exposure term makes `net` exactly equal to the
      // `vs ref` column, so `<=` would let that mutation through. The measured
      // gap is 2.42 -> 1.74.
      expect(best.net).toBeLessThan(best.xi - refXi);
      // That one line does more work than it looks like it does. Mutation
      // tested three ways: dropping the exposure term, scoring `net` against
      // `base` instead of `refXi`, and dropping the bench-pin penalty from
      // `lockedBest`. It catches the first two; the third throws earlier, where
      // `ref` is built. A fourth guard written here — "net must be at least a
      // point below the naive base-relative figure" — was removed after mutation
      // testing showed it killed nothing this one does not already kill. It
      // read like a second line of defence and was a second copy of the first.
      // And `slotW` must actually differ from `sum15`, or the "same search, one
      // objective changed" line above is comparing a thing with itself.
      expect(slotW(base.squad)).toBeLessThan(sum15(base.squad));
      // (The "reference really does bench the incumbent" check is NOT repeated
      // here. It throws where `ref` is built, which is before anything is
      // printed — a duplicate assertion down here would be unreachable, and an
      // unreachable assertion is worse than none: it reads like coverage.)
      // Dominance. `weighted` is the SAME objective with the lock removed, and
      // it climbs from a seed set that includes `ref.squad`, so an unconstrained
      // optimum below a constrained one means the lock arithmetic leaked into
      // the score. This is the guard that would catch the `- 1e6` being applied
      // to a squad that does not contain the locked keeper.
      expect(slotW(weighted.squad)).toBeGreaterThanOrEqual(slotW(ref.squad) - 1e-9);
      expect(slotW(ref.squad)).toBeGreaterThanOrEqual(slotW(base.squad) - 1e-9);
      // The correction must actually bite. If the reference were no better than
      // `base`, then "vs ref" and the old, wrong "vs base" would be the same
      // column and the defect this block was rewritten to fix would be back
      // without changing a printed number. (Writing the decomposition identity
      // here instead is tempting and worthless: (r-b) + (w-r) === (w-b) holds
      // for any three numbers.)
      // Measured margin 163.51 - 161.03 = 2.48; the bound is set at a full point
      // so a change that all but collapses the correction still trips it.
      expect(refXi).toBeGreaterThan(xiValue(base.squad) + 1.0);
    } finally {
      globalThis.fetch = origFetch;
    }
  }
);
