// Squad optimizer: best XI, transfer plans, captaincy and chip advice.
// Search strategy: exact formation enumeration for the XI + beam search over
// transfer combinations (documented in README). Fast enough to run in the browser.

import type {
  Bootstrap,
  Element,
  ElementType,
  Fixture,
  OwnedPlayer,
  PastSeasonStats,
  RecentForm,
} from "./types";
import { MAX_FREE_TRANSFERS, MAX_PER_CLUB, TRANSFER_HIT, VALID_FORMATIONS } from "./rules";
import { makeFixtureIndex, projectAll, XP_CONFIG, type PlayerXp, type XpContext } from "./xp";

export interface XiSlot {
  element: Element;
  xp: number;
  isCaptain?: boolean;
  isVice?: boolean;
}

export interface BestXi {
  formation: [number, number, number];
  starters: XiSlot[]; // GK first, then DEF, MID, FWD
  // FPL bench order: substitute GK FIRST, then the outfield subs by xp desc.
  // (This line used to say "GK last", contradicting both the code that builds
  // it and the comment right above that code. It is not cosmetic: the four
  // `BENCH_SLOT_WEIGHTS` are index-aligned to this array, so a reader who
  // trusted the old comment would price the sub keeper at 0.046 and the first
  // outfield sub at 0.072 — the weights reversed on the two slots that carry
  // almost all the value.)
  bench: XiSlot[];
  captain: XiSlot | null;
  vice: XiSlot | null;
  totalXp: number; // XI xp + captain doubling
}

export interface TransferMove {
  out: Element;
  outSell: number;
  in: Element;
  inCost: number;
}

export interface TransferPlan {
  transfers: TransferMove[];
  hitCost: number;
  grossXp: number; // horizon xP of resulting best XIs
  netXp: number; // grossXp - hitCost
  gainVsKeep: number; // netXp - keep-team xP
  bankAfter: number;
  nextXi: BestXi;
}

export interface ChipAdvice {
  chip: string;
  label: string;
  projectedGain: number;
  detail: string;
}

interface SquadEval {
  players: { element: Element; sell: number }[];
  bank: number;
  moves: TransferMove[];
}

/** Pick the optimal starting XI + bench for a squad, given per-player xP. */
export function pickBestXi(
  squad: Element[],
  xpOf: (id: number) => number
): BestXi {
  const slot = (e: Element): XiSlot => ({ element: e, xp: xpOf(e.id) });
  const gks = squad.filter((e) => e.element_type === 1).map(slot).sort((a, b) => b.xp - a.xp);
  const defs = squad.filter((e) => e.element_type === 2).map(slot).sort((a, b) => b.xp - a.xp);
  const mids = squad.filter((e) => e.element_type === 3).map(slot).sort((a, b) => b.xp - a.xp);
  const fwds = squad.filter((e) => e.element_type === 4).map(slot).sort((a, b) => b.xp - a.xp);

  // The formation is chosen on the ELEVEN's xp, and the captain's doubled xp is
  // added afterwards. That looks like it could pick the wrong formation — the
  // reported quantity is XI + captain, so the argmax ought to be taken over
  // XI + captain — but it cannot, and the reason is worth writing down because
  // an audit flagged it as a bug and the "fix" would have been a no-op.
  //
  // Every legal formation contains at least 1 GK, 3 DEF, 2 MID and 1 FWD
  // (see VALID_FORMATIONS). The pools below are sorted by xp descending, so the
  // single highest-xp player of EVERY position starts in EVERY formation. The
  // captain is therefore the same player, with the same xp, whichever formation
  // wins — a constant added to all eight candidates, which cannot reorder them.
  // `optimizer.test.ts` pins this against a brute-force argmax over XI+captain,
  // so if FPL ever legalises a formation with zero forwards the guard fails
  // rather than silently degrading.
  let best: BestXi | null = null;
  for (const [d, m, f] of VALID_FORMATIONS) {
    if (defs.length < d || mids.length < m || fwds.length < f || gks.length < 1) continue;
    const starters = [gks[0], ...defs.slice(0, d), ...mids.slice(0, m), ...fwds.slice(0, f)];
    const sum = starters.reduce((s, p) => s + p.xp, 0);
    if (!best || sum > best.totalXp) {
      const benchOutfield = [...defs.slice(d), ...mids.slice(m), ...fwds.slice(f)].sort(
        (a, b) => b.xp - a.xp
      );
      // FPL convention: the substitute GK occupies bench slot 1.
      const bench = [...gks.slice(1), ...benchOutfield];
      best = {
        formation: [d, m, f],
        starters,
        bench,
        captain: null,
        vice: null,
        totalXp: sum,
      };
    }
  }
  if (!best) throw new Error("No valid formation for this squad");
  const ranked = [...best.starters].sort((a, b) => b.xp - a.xp);
  best.captain = ranked[0] ?? null;
  best.vice = ranked[1] ?? null;
  if (best.captain) {
    best.captain.isCaptain = true;
    best.totalXp += best.captain.xp; // captain doubles
  }
  if (best.vice) best.vice.isVice = true;
  return best;
}

/**
 * Horizon score for a squad: sum over horizon GWs of best-XI xP incl. captain,
 * with future GWs discounted (they are less certain). Optionally memoized by
 * squad composition — the beam search revisits many identical squads.
 */
function horizonScore(
  squad: Element[],
  xp: Map<number, PlayerXp>,
  events: number[],
  cache?: Map<string, number>
): number {
  let key = "";
  if (cache) {
    key = squad
      .map((e) => e.id)
      .sort((a, b) => a - b)
      .join(",");
    const hit = cache.get(key);
    if (hit != null) return hit;
  }
  let sum = 0;
  for (let i = 0; i < events.length; i++) {
    const gw = events[i];
    const xi = pickBestXi(squad, (id) => xp.get(id)?.perGw.get(gw) ?? 0);
    sum += xi.totalXp * Math.pow(XP_CONFIG.gwDecay, i);
  }
  if (cache) cache.set(key, sum);
  return sum;
}

function clubCountOk(squad: Element[]): boolean {
  const counts = new Map<number, number>();
  for (const e of squad) {
    const c = (counts.get(e.team) ?? 0) + 1;
    if (c > MAX_PER_CLUB) return false;
    counts.set(e.team, c);
  }
  return true;
}

export interface OptimizerInput {
  bootstrap: Bootstrap;
  fixtures: Fixture[];
  owned: OwnedPlayer[];
  bank: number;
  freeTransfers: number;
  nextEvent: number;
  horizon?: number;
  maxTransfers?: number; // default 3
  candidatesPerPosition?: number; // default 22
  beamWidth?: number; // default 8
  /** Reuse an already-computed projection (must match nextEvent/horizon). */
  precomputedXp?: Map<number, PlayerXp>;
  /** Recent line-up form per element (see XpContext.recentForm). */
  recentForm?: Map<number, RecentForm>;
  /*
   * LAST SEASON'S RECORD, which this engine could not see at all.
   *
   * `projectAll` has taken `pastSeason` for a long time, and the dashboard and
   * the launch drafter both pass it. The optimizer, the six-week planner and
   * the chip scenarios did not — the field did not exist on their inputs — so
   * the app ended up quoting two different xP figures for the same man and
   * disagreeing hardest about exactly the players a manager needs help with: a
   * summer signing or a returning long-term absentee is on no minutes this
   * season, so with no record he projects near zero, never enters the candidate
   * pool, and cannot be recommended however good he is. The pitch would show
   * him at 4.1 while the Optimize tab refused to consider him.
   */
  pastSeason?: Map<number, PastSeasonStats>;
}

export interface OptimizerResult {
  xp: Map<number, PlayerXp>;
  keepXi: BestXi; // best XI with 0 transfers, next GW
  keepHorizonXp: number;
  plans: TransferPlan[]; // for 1..maxTransfers transfers (best per count)
  captainRanking: XiSlot[]; // top of current squad by next-GW xp
  chipAdvice: ChipAdvice[];
  dreamTeam: BestXi;
  dreamSquad: Element[];
}

export function optimize(input: OptimizerInput): OptimizerResult {
  const {
    bootstrap,
    fixtures,
    owned,
    bank,
    freeTransfers,
    nextEvent,
  } = input;
  const horizon = input.horizon ?? 5;
  const maxTransfers = input.maxTransfers ?? 3;
  const candN = input.candidatesPerPosition ?? 22;
  const beamWidth = input.beamWidth ?? 8;

  const ctx: XpContext = {
    bootstrap,
    fixtures,
    nextEvent,
    horizon,
    recentForm: input.recentForm,
    pastSeason: input.pastSeason,
  };
  const xp = input.precomputedXp ?? projectAll(ctx);
  const lastEvent = bootstrap.events.length > 0 ? bootstrap.events[bootstrap.events.length - 1].id : 38;
  const gws: number[] = [];
  for (let g = nextEvent; g < nextEvent + horizon && g <= lastEvent; g++) gws.push(g);

  const ownedIds = new Set(owned.map((o) => o.element.id));
  const squadEls = owned.map((o) => o.element);

  // --- Keep-team baseline ---
  const keepXi = pickBestXi(squadEls, (id) => xp.get(id)?.next ?? 0);
  const keepHorizonXp = horizonScore(squadEls, xp, gws);

  // --- Candidate pool: top N per position by horizon xP (available players only) ---
  const candidates = new Map<ElementType, Element[]>();
  for (const t of [1, 2, 3, 4] as ElementType[]) {
    const pool = bootstrap.elements
      .filter(
        (e) =>
          e.element_type === t &&
          !ownedIds.has(e.id) &&
          e.status !== "u" &&
          (xp.get(e.id)?.total ?? 0) > 0
      )
      .sort(
        (a, b) => (xp.get(b.id)?.totalDiscounted ?? 0) - (xp.get(a.id)?.totalDiscounted ?? 0)
      )
      .slice(0, candN);
    candidates.set(t, pool);
  }

  // --- Beam search over transfer combos ---
  const start: SquadEval = {
    players: owned.map((o) => ({ element: o.element, sell: o.sellPrice })),
    bank,
    moves: [],
  };
  const bestPerCount = new Map<number, { s: SquadEval; score: number }>();
  const scoreCache = new Map<string, number>();
  let beam: SquadEval[] = [start];

  for (let depth = 1; depth <= maxTransfers; depth++) {
    const next: { s: SquadEval; score: number }[] = [];
    const seen = new Set<string>();
    for (const state of beam) {
      const outAlready = new Set(state.moves.map((m) => m.out.id));
      const inAlready = new Set(state.moves.map((m) => m.in.id));
      for (const outP of state.players) {
        if (inAlready.has(outP.element.id)) continue; // don't sell what we just bought
        const pool = candidates.get(outP.element.element_type) ?? [];
        for (const inEl of pool) {
          if (outAlready.has(inEl.id)) continue;
          if (state.players.some((p) => p.element.id === inEl.id)) continue;
          const newBank = state.bank + outP.sell - inEl.now_cost;
          if (newBank < 0) continue;
          const newPlayers = state.players
            .filter((p) => p.element.id !== outP.element.id)
            .concat([{ element: inEl, sell: inEl.now_cost }]);
          const els = newPlayers.map((p) => p.element);
          if (!clubCountOk(els)) continue;
          const key = els
            .map((e) => e.id)
            .sort((a, b) => a - b)
            .join(",");
          if (seen.has(key)) continue;
          seen.add(key);
          const score = horizonScore(els, xp, gws, scoreCache);
          next.push({
            s: {
              players: newPlayers,
              bank: newBank,
              moves: [
                ...state.moves,
                { out: outP.element, outSell: outP.sell, in: inEl, inCost: inEl.now_cost },
              ],
            },
            score,
          });
        }
      }
    }
    next.sort((a, b) => b.score - a.score);
    const top = next.slice(0, beamWidth);
    if (top.length === 0) break;
    const bestAtDepth = top[0];
    bestPerCount.set(depth, bestAtDepth);
    beam = top.map((t) => t.s);
  }

  const plans: TransferPlan[] = [];
  for (const [count, { s, score }] of bestPerCount) {
    const hitCost = Math.max(0, count - freeTransfers) * TRANSFER_HIT;
    const netXp = score - hitCost;
    const els = s.players.map((p) => p.element);
    plans.push({
      transfers: s.moves,
      hitCost,
      grossXp: score,
      netXp,
      gainVsKeep: netXp - keepHorizonXp,
      bankAfter: s.bank,
      nextXi: pickBestXi(els, (id) => xp.get(id)?.next ?? 0),
    });
  }
  plans.sort((a, b) => a.transfers.length - b.transfers.length);

  // --- Captain ranking (next GW, current squad) ---
  const captainRanking = squadEls
    .map((e) => ({ element: e, xp: xp.get(e.id)?.next ?? 0 }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 5);

  // --- Dream team (ignore current squad, £100m) ---
  const { squad: dreamSquad } = buildDreamSquad(bootstrap.elements, xp);
  const dreamTeam = pickBestXi(dreamSquad, (id) => xp.get(id)?.next ?? 0);

  // --- Chip advisor: evaluate each chip across EVERY GW in the horizon, so
  // double/blank gameweeks (the highest-leverage chip moments) are found. ---
  const chipAdvice: ChipAdvice[] = [];
  const fxIndex = makeFixtureIndex(fixtures);
  const squadTeams = new Set(squadEls.map((e) => e.team));
  const gwNote = (gw: number): string => {
    const byTeam = fxIndex.get(gw);
    if (!byTeam) return "";
    let dbl = 0;
    let blank = 0;
    for (const t of squadTeams) {
      const n = byTeam.get(t)?.length ?? 0;
      if (n >= 2) dbl++;
      else if (n === 0) blank++;
    }
    if (dbl > 0) return ` — double gameweek for ${dbl} of your clubs`;
    if (blank > 0) return ` — ${blank} of your clubs blank`;
    return "";
  };
  const xiAt = (squad: Element[], gw: number) =>
    pickBestXi(squad, (id) => xp.get(id)?.perGw.get(gw) ?? 0);

  // Bench Boost: GW where the bench of the best XI scores the most.
  let bbBest = { gw: nextEvent, gain: 0 };
  // Triple Captain: GW + player with the highest single-GW xP (the chip adds 1x).
  let tcBest = { gw: nextEvent, gain: 0, name: keepXi.captain?.element.web_name ?? "Your captain" };
  // Free Hit: GW where a one-week optimal squad beats your own XI the most.
  const fhBudget = totalValue(owned, bank);
  let fhBest = { gw: nextEvent, gain: 0 };
  for (const gw of gws) {
    const ownXi = xiAt(squadEls, gw);
    const benchXp = ownXi.bench.reduce((s, p) => s + p.xp, 0);
    if (benchXp > bbBest.gain) bbBest = { gw, gain: benchXp };
    for (const e of squadEls) {
      const v = xp.get(e.id)?.perGw.get(gw) ?? 0;
      if (v > tcBest.gain) tcBest = { gw, gain: v, name: e.web_name };
    }
    // Free Hit is a one-week chip — build the squad optimal for THIS gw (so a
    // double gameweek picks the players with two fixtures), not a horizon squad.
    const fhSquad = buildSquadWithinBudget(
      bootstrap.elements,
      xp,
      fhBudget,
      (id) => xp.get(id)?.perGw.get(gw) ?? 0
    ).squad;
    const fhGwGain = xiAt(fhSquad, gw).totalXp - ownXi.totalXp;
    if (fhGwGain > fhBest.gain) fhBest = { gw, gain: fhGwGain };
  }
  chipAdvice.push({
    chip: "bboost",
    label: "Bench Boost",
    projectedGain: bbBest.gain,
    detail: `Best in GW${bbBest.gw}${gwNote(bbBest.gw)}: your bench projects ${bbBest.gain.toFixed(1)} pts that week.`,
  });
  chipAdvice.push({
    chip: "3xc",
    label: "Triple Captain",
    projectedGain: tcBest.gain,
    detail: `Best in GW${tcBest.gw}${gwNote(tcBest.gw)}: ${tcBest.name} would add ~${tcBest.gain.toFixed(1)} extra points (3x instead of 2x).`,
  });
  const wcGain = Math.max(
    0,
    horizonScore(dreamSquadWithinValue(bootstrap.elements, xp, totalValue(owned, bank)), xp, gws, scoreCache) -
      keepHorizonXp
  );
  chipAdvice.push({
    chip: "wildcard",
    label: "Wildcard",
    projectedGain: wcGain,
    detail: `An optimal squad within your team value is projected to gain ~${wcGain.toFixed(1)} points over the next ${gws.length} gameweeks.`,
  });
  chipAdvice.push({
    chip: "freehit",
    label: "Free Hit",
    projectedGain: Math.max(0, fhBest.gain),
    detail: `Best in GW${fhBest.gw}${gwNote(fhBest.gw)}: an optimal one-week squad projects ~${Math.max(0, fhBest.gain).toFixed(1)} pts more than your team that week.`,
  });
  chipAdvice.sort((a, b) => b.projectedGain - a.projectedGain);

  return {
    xp,
    keepXi,
    keepHorizonXp,
    plans,
    captainRanking,
    chipAdvice,
    dreamTeam,
    dreamSquad,
  };
}

function totalValue(owned: OwnedPlayer[], bank: number): number {
  return owned.reduce((s, o) => s + o.sellPrice, 0) + bank;
}

/*
 * REJECTED, and recorded here because it is the first idea anyone has about
 * this function and it is measurably wrong.
 *
 * An FPL squad is scored by its starting eleven. The other four play only
 * through autosubs. So the downgrade loop below, which judges every swap by
 * `scoreOf(out) - scoreOf(in)`, is valuing the fifteenth man exactly as highly
 * as the first, and ought to be judging swaps by the change in BEST-XI score
 * instead — with the bench discounted by roughly its autosub value.
 *
 * That was implemented and measured. Under PERFECT FORESIGHT it is strictly
 * better, which is what settles the question of whether it is a better
 * optimiser: feeding actual end-of-season points in as the score and comparing
 * the resulting squads' real season totals,
 *
 *              2022-23  2023-24  2024-25  2025-26   total
 *   sum-of-15     3098     3122     3106     3089   12415
 *   best-XI       3166     3136     3123     3089   12514
 *
 * better or equal in all four, +99 overall, and spending the whole £100.0m
 * every season where the old one left up to £4.0m idle.
 *
 * And it loses points on the live model. Managed 38-gameweek totals over the
 * same four seasons fall 8729 -> 8516, set-and-forget 6483 -> 6373, and no
 * value of the bench discount rescues it:
 *
 *   bench weight   0.15   0.30   0.50   0.70   0.85    (sum-of-15 = 8729)
 *   managed        8516   8601   8441   8634   8514
 *   set-and-forget 6373   6088   6100   6205   6268
 *
 * Every `managed` number here predates `inSeasonPast` in
 * `scripts/simulate.test.ts` and has not been re-measured; reproduce with
 * `NO_PAST_INSEASON=1`. The set-and-forget row is unaffected. The conclusion
 * below survives either way: it rests on the managed and set-and-forget rows
 * agreeing in SIGN across five weights, and the in-season record is a change to
 * the projection every one of those columns shares.
 *
 * The two facts together say something worth knowing about this whole app. The
 * optimiser is not the binding constraint; the projections are. A sharper
 * optimiser concentrates the budget on the players the model rates highest,
 * and pre-season those are exactly the players whose ratings carry the most
 * estimation error — a high projection is high partly because it is wrong.
 * Sharpening the search without sharpening the estimate just exploits the
 * model's own mistakes more efficiently. The old loop's habit of protecting
 * bench quality and leaving money unspent was acting as accidental
 * regularisation.
 *
 * So this is worth revisiting only after the projections improve, and the
 * oracle table above is the check that will say whether it has become worth it.
 * What was kept from the attempt is the reinvestment pass at the end, which is
 * unambiguous — leaving £4.0m in the bank at a launch deadline buys nothing —
 * and which measured +76 managed and +13 set-and-forget, worse in no season.
 *
 * The oracle row is a constant, not a metric that needs a permanent harness:
 * it depends only on the archived prices and the archived actual points, so no
 * model change can move it. That is why the probe that produced it is not
 * checked in. To regenerate it, temporarily export this function, build an xP
 * map whose `next`/`total`/`totalDiscounted` are each player's real end-of-
 * season total, call it with `budget = 1000`, and score the resulting fifteen
 * through `actualGwPoints` for all 38 gameweeks. It also doubles as the
 * denominator for "fraction of achievable optimum": the live managed total of
 * 8805 against a 12415 ceiling is 71%, and the gap is projection error, not
 * search error. (The 8805 predates `inSeasonPast` — see above. The 12415 does
 * not move: the oracle depends only on archived prices and archived points.)
 */
/** Greedy + repair: best 15-man squad within a budget.
 * `scoreOf` ranks players — defaults to discounted horizon xP (permanent moves
 * like Wildcard); pass a single-GW scorer for Free Hit. */
export function buildSquadWithinBudget(
  elements: Element[],
  xp: Map<number, PlayerXp>,
  budget: number,
  scoreOf: (id: number) => number = (id) => xp.get(id)?.totalDiscounted ?? 0,
  opts?: {
    /** Exclude any single player above this price (tenths) — "value" builds. */
    maxPlayerCost?: number;
    /** Force these players in first — "stars & scrubs" builds. */
    mustInclude?: number[];
  }
): { squad: Element[]; cost: number } {
  const need: Record<ElementType, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
  const cap = opts?.maxPlayerCost ?? Infinity;
  const locked = new Set(opts?.mustInclude ?? []);
  const byId = new Map(elements.map((e) => [e.id, e]));
  const pools = new Map<ElementType, Element[]>();
  for (const t of [1, 2, 3, 4] as ElementType[]) {
    pools.set(
      t,
      elements
        .filter(
          (e) =>
            e.element_type === t &&
            e.status !== "u" &&
            (xp.get(e.id)?.total ?? 0) > 0 &&
            (e.now_cost <= cap || locked.has(e.id))
        )
        .sort((a, b) => scoreOf(b.id) - scoreOf(a.id))
        .slice(0, 40)
    );
  }
  const squad: Element[] = [];
  const clubCount = new Map<number, number>();
  const add = (e: Element) => {
    squad.push(e);
    clubCount.set(e.team, (clubCount.get(e.team) ?? 0) + 1);
  };
  // Forced premium picks first (respecting position/club limits).
  for (const id of locked) {
    const e = byId.get(id);
    if (!e) continue;
    if (squad.filter((s) => s.element_type === e.element_type).length >= need[e.element_type]) continue;
    if ((clubCount.get(e.team) ?? 0) >= MAX_PER_CLUB) continue;
    add(e);
  }
  // Greedy-best fill, then downgrade lowest value-per-price until affordable.
  for (const t of [1, 2, 3, 4] as ElementType[]) {
    for (const e of pools.get(t)!) {
      if (squad.some((s) => s.id === e.id)) continue;
      if (squad.filter((s) => s.element_type === t).length >= need[t]) break;
      if ((clubCount.get(e.team) ?? 0) >= MAX_PER_CLUB) continue;
      add(e);
    }
  }
  let cost = squad.reduce((s, e) => s + e.now_cost, 0);
  let guard = 200;
  while (cost > budget && guard-- > 0) {
    let bestSwap: { outIdx: number; inEl: Element; delta: number } | null = null;
    for (let i = 0; i < squad.length; i++) {
      const out = squad[i];
      if (locked.has(out.id)) continue; // never downgrade a forced pick
      const pool = pools.get(out.element_type)!;
      for (const inEl of pool) {
        if (inEl.now_cost >= out.now_cost) continue;
        if (squad.some((s) => s.id === inEl.id)) continue;
        const clubOk =
          (clubCount.get(inEl.team) ?? 0) + (inEl.team === out.team ? -1 : 0) < MAX_PER_CLUB;
        if (!clubOk) continue;
        const xpLoss = scoreOf(out.id) - scoreOf(inEl.id);
        const saved = out.now_cost - inEl.now_cost;
        const delta = xpLoss / Math.max(1, saved); // xp lost per tenth saved
        if (!bestSwap || delta < bestSwap.delta) bestSwap = { outIdx: i, inEl, delta };
      }
    }
    if (!bestSwap) break;
    const out = squad[bestSwap.outIdx];
    clubCount.set(out.team, (clubCount.get(out.team) ?? 1) - 1);
    clubCount.set(bestSwap.inEl.team, (clubCount.get(bestSwap.inEl.team) ?? 0) + 1);
    squad[bestSwap.outIdx] = bestSwap.inEl;
    cost = squad.reduce((s, e) => s + e.now_cost, 0);
  }

  // Spend what is left.
  //
  // The loop above stops the instant the squad is affordable. It has a reason
  // to stop overspending and no reason at all to spend, so it routinely handed
  // back a squad with several million sitting in the bank: £4.0m unspent in
  // 2023-24, £1.0m in 2024-25, £0.5m in 2022-23. In a launch squad that money
  // buys nothing later — there is no later, the season starts — so it is simply
  // thrown away. This walks back up, taking the single best affordable upgrade
  // each time until none is left.
  guard = 60;
  for (;;) {
    if (guard-- <= 0) break;
    let bestUp: { outIdx: number; inEl: Element; gain: number } | null = null;
    for (let i = 0; i < squad.length; i++) {
      const out = squad[i];
      if (locked.has(out.id)) continue;
      for (const inEl of pools.get(out.element_type)!) {
        if (squad.some((s) => s.id === inEl.id)) continue;
        if (cost - out.now_cost + inEl.now_cost > budget) continue;
        const clubOk =
          (clubCount.get(inEl.team) ?? 0) + (inEl.team === out.team ? -1 : 0) < MAX_PER_CLUB;
        if (!clubOk) continue;
        const gain = scoreOf(inEl.id) - scoreOf(out.id);
        if (gain > 1e-9 && (!bestUp || gain > bestUp.gain)) bestUp = { outIdx: i, inEl, gain };
      }
    }
    if (!bestUp) break;
    const out = squad[bestUp.outIdx];
    clubCount.set(out.team, (clubCount.get(out.team) ?? 1) - 1);
    clubCount.set(bestUp.inEl.team, (clubCount.get(bestUp.inEl.team) ?? 0) + 1);
    squad[bestUp.outIdx] = bestUp.inEl;
    cost = squad.reduce((s, e) => s + e.now_cost, 0);
  }
  return { squad, cost };
}

function buildDreamSquad(elements: Element[], xp: Map<number, PlayerXp>) {
  return buildSquadWithinBudget(elements, xp, 1000);
}

/**
 * How often each bench slot is actually NEEDED, in FPL bench order — sub
 * goalkeeper first, then the three outfield subs in priority order, which is
 * exactly the order `pickBestXi` returns.
 *
 * Measured, not chosen: `scripts/simulate.test.ts` (SLOTW=1) replays 152
 * managed gameweeks across four seasons and counts, per bench INDEX, how often
 * an auto-sub into that slot was required. Slots NEEDED, not slots FILLED —
 * filled is a joint fact about the fixtures and about how good this particular
 * bench happens to be, and using it here would let a bad bench justify itself.
 *
 * The spread is the point. Every objective in this file before now priced a
 * bench uniformly, and the first outfield sub turns out to be worth ELEVEN
 * TIMES the third. Re-run SLOTW=1 if the numbers are ever questioned; do not
 * hand-tune them.
 */
export const BENCH_SLOT_WEIGHTS = [0.072, 0.513, 0.283, 0.046] as const;

/** Squad score with the bench priced at what it is worth instead of at par. */
export function benchAwareScore(squad: Element[], scoreOf: (id: number) => number): number {
  const xi = pickBestXi(squad, scoreOf);
  let total = xi.starters.reduce((a, s) => a + scoreOf(s.element.id), 0);
  xi.bench.forEach((s, i) => {
    total += (BENCH_SLOT_WEIGHTS[i] ?? 0) * scoreOf(s.element.id);
  });
  return total;
}

/**
 * A £100m squad built on `benchAwareScore` rather than on the sum over all
 * fifteen — "strong eleven, honest bench".
 *
 * WHAT IT IS WORTH, MEASURED. Played out over four real seasons at 38
 * set-and-forget gameweeks (`BENCH=1` in scripts/simulate.test.ts), this
 * squad scored +64 / +19 / +40 / -51 against the greedy draft — total +72,
 * better in three seasons of four. The unbounded search on the same objective
 * comes out at +155 / -77 / -104 / +80, total +54, split two seasons each way.
 *
 * THAT IS NOT A MANDATE TO MAKE IT THE DEFAULT, and the size of the number is
 * why. +72 over four seasons is +18 a season; the spread between the best and
 * the worst optimum WITHIN a single objective's family, in the same
 * experiment, is 67-566 points. The signal is inside the noise. What the
 * measurement supports is that re-pricing the bench does not cost anything —
 * enough to offer the structure, not enough to impose it.
 *
 * AND THE NUMBER IS NOT A CONSTANT. An earlier run of the identical experiment
 * gave -140 / +19 / -2 / -51, total -174, i.e. the opposite sign. Neither this
 * function nor `BENCH_SLOT_WEIGHTS` changed between the two runs. Exactly one
 * thing did: commit 77099ab, the pre-season minutes model, which is the only
 * commit in that stretch to touch `src/lib/xp.ts` — the other three (bf2483c,
 * 2e4f41d, 916077f) added measurement harnesses and no model code at all. So
 * this is a measurement of the bench objective UNDER ONE PROJECTION MODEL, and
 * a change to how minutes are projected is enough to flip its sign. Re-run the
 * `BENCH=1` gate after any change to `xp.ts`. Do not quote these figures as a
 * settled fact about FPL.
 *
 * WHY THIS IS A SEPARATE FUNCTION AND NOT A FLAG ON `buildSquadWithinBudget`.
 * That builder is greedy over PER-PLAYER scores: it fills by rank and then
 * downgrades by xp-lost-per-tenth-saved. A bench weight is not a property of a
 * player, it is a property of the slot he lands in, and which slot that is only
 * exists once the other fourteen are known. So the objective has to be scored
 * on whole squads, which means a search over squads.
 *
 * THE POOL IS THE SUBTLE PART. `buildSquadWithinBudget` takes the top 40 per
 * position by projected points, and a £4.0m third-choice keeper is nowhere near
 * that list — so a search restricted to it CANNOT BUILD THE THING THIS FUNCTION
 * EXISTS TO BUILD, and would quietly return something close to the incumbent
 * while looking like it had tried. The cheapest 14 per position are unioned in
 * for exactly that reason.
 *
 * THE PAIRED NEIGHBOURHOOD IS THE OTHER SUBTLE PART. At £100.0m every single
 * upgrade is unaffordable and every single downgrade loses points, so a
 * single-swap climb declares victory immediately and a budget-tight local
 * optimum looks global. `scripts/ytcompare.test.ts` measured that failure at
 * 2.55 xP. Here the paired move is deliberately restricted to selling a BENCH
 * slot down to fund an XI upgrade, which is both the move that matters and
 * cheap enough to run in a browser — the general paired neighbourhood is
 * 15x15 slot pairs and this is 4x11.
 */
/**
 * The candidate pool the bench-aware climb searches over, exported so the
 * property that makes it correct can be asserted directly: the CHEAPEST
 * eligible player at each position must be reachable. A pool of "the best 40"
 * is the natural thing to write and is exactly wrong here — on real data the
 * cheapest keeper is somewhere past rank 60, so a search restricted to the
 * best 40 cannot build a cheap bench and would return the greedy draft while
 * looking like it had tried.
 */
export function benchAwarePool(
  elements: Element[],
  xp: Map<number, PlayerXp>
): Map<ElementType, Element[]> {
  const scoreOf = (id: number) => xp.get(id)?.totalDiscounted ?? 0;
  const pools = new Map<ElementType, Element[]>();
  for (const t of [1, 2, 3, 4] as ElementType[]) {
    const eligible = elements.filter(
      (e) => e.element_type === t && e.status !== "u" && (xp.get(e.id)?.total ?? 0) > 0
    );
    const byScore = [...eligible].sort((a, b) => scoreOf(b.id) - scoreOf(a.id)).slice(0, 40);
    const byPrice = [...eligible].sort((a, b) => a.now_cost - b.now_cost).slice(0, 14);
    const seen = new Set<number>();
    pools.set(
      t,
      [...byScore, ...byPrice].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    );
  }
  return pools;
}

export function buildBenchAwareSquad(
  elements: Element[],
  xp: Map<number, PlayerXp>,
  budget: number
): { squad: Element[]; cost: number } {
  const scoreOf = (id: number) => xp.get(id)?.totalDiscounted ?? 0;
  const seed = buildSquadWithinBudget(elements, xp, budget);
  const pools = benchAwarePool(elements, xp);

  let squad = [...seed.squad];
  let cost = seed.cost;
  if (squad.length !== 15) return seed;
  let cur = benchAwareScore(squad, scoreOf);

  const canSwap = (sq: Element[], i: number, inEl: Element, atCost: number): boolean => {
    const out = sq[i];
    if (inEl.id === out.id) return false;
    if (inEl.element_type !== out.element_type) return false;
    if (sq.some((s, j) => j !== i && s.id === inEl.id)) return false;
    if (atCost - out.now_cost + inEl.now_cost > budget) return false;
    let n = 0;
    for (let j = 0; j < sq.length; j++) if (j !== i && sq[j].team === inEl.team) n++;
    return n < MAX_PER_CLUB;
  };

  for (let iter = 0; iter < 120; iter++) {
    let improved = false;

    // Neighbourhood 1: single swaps.
    for (let i = 0; i < squad.length && !improved; i++) {
      for (const inEl of pools.get(squad[i].element_type)!) {
        if (!canSwap(squad, i, inEl, cost)) continue;
        const trial = [...squad];
        trial[i] = inEl;
        const s = benchAwareScore(trial, scoreOf);
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

    // Neighbourhood 2: sell a bench slot down, spend it on the eleven.
    const benchIds = new Set(
      pickBestXi(squad, scoreOf).bench.map((s) => s.element.id)
    );
    for (let i = 0; i < squad.length && !improved; i++) {
      if (!benchIds.has(squad[i].id)) continue;
      for (const cheap of pools.get(squad[i].element_type)!) {
        if (cheap.now_cost >= squad[i].now_cost) continue;
        if (!canSwap(squad, i, cheap, cost)) continue;
        const mid = [...squad];
        mid[i] = cheap;
        const midCost = cost - squad[i].now_cost + cheap.now_cost;
        for (let j = 0; j < mid.length && !improved; j++) {
          if (j === i || benchIds.has(mid[j].id)) continue;
          for (const up of pools.get(mid[j].element_type)!) {
            if (up.now_cost <= mid[j].now_cost) continue;
            if (!canSwap(mid, j, up, midCost)) continue;
            const trial = [...mid];
            trial[j] = up;
            const s = benchAwareScore(trial, scoreOf);
            if (s > cur + 1e-9) {
              cost = midCost - mid[j].now_cost + up.now_cost;
              squad = trial;
              cur = s;
              improved = true;
              break;
            }
          }
        }
      }
    }
    if (!improved) break;
  }

  // `cost` is maintained incrementally during the search because the budget
  // test runs inside the innermost loop; it is recomputed here so a bookkeeping
  // slip in one of the two neighbourhoods cannot reach the caller as a squad
  // whose reported price is not its price.
  return { squad, cost: squad.reduce((a, e) => a + e.now_cost, 0) };
}

export interface LaunchSquad {
  squad: Element[];
  cost: number; // tenths
  xi: BestXi;
  xp: Map<number, PlayerXp>;
}

/**
 * Season-launch mode: build the best £100m squad from scratch — no existing
 * team required. Pre-season the xP model leans on the price prior, FPL's
 * ep_next, team strengths and the opening fixtures.
 */
export function buildLaunchSquad(
  bootstrap: Bootstrap,
  fixtures: Fixture[],
  nextEvent: number,
  horizon = 5,
  pastSeason?: Map<number, PastSeasonStats>
): LaunchSquad {
  const xp = projectAll({ bootstrap, fixtures, nextEvent, horizon, pastSeason });
  const { squad, cost } = buildSquadWithinBudget(bootstrap.elements, xp, 1000);
  const xi = pickBestXi(squad, (id) => xp.get(id)?.next ?? 0);
  return { squad, cost, xi, xp };
}

export interface LaunchVariant {
  key: string;
  label: string;
  description: string;
  squad: Element[];
  cost: number;
  xi: BestXi;
}

/** The "value" draft's headline price ceiling: no player above £8.5m. */
export const VALUE_CAP = 85;

/**
 * The price ceiling actually applied to the "value" draft: £8.5m, TIGHTENED to
 * £0.5m below the balanced draft's dearest player if £8.5m would not have
 * excluded anybody — clamped at the £4.0m floor, so between £4.1m and £4.4m
 * the tightening is less than a full tier, and an empty squad (no draft to
 * derive from) falls back to the headline £8.5m.
 *
 * Both halves are load-bearing, and I got this wrong in both directions before
 * settling here. A bare constant stops binding the moment the balanced draft's
 * dearest pick falls to £8.5m or below — the two builds then come out
 * byte-identical, `buildLaunchVariants` dedupes one away, and the manager is
 * shown three cards where four were promised, with nothing failing anywhere.
 * That is not hypothetical, but it is narrower than it first looks: on the
 * 2026-27 pool the balanced draft's dearest pick is £12.0m when last season's
 * minutes are available and £8.0m when they are not, so the bug bites only on
 * the fallback path `OptimizePanel` takes when the per-player history could
 * not be fetched — which is the path a manager hits when the FPL API is flaky,
 * i.e. the one nobody tests by hand.
 *
 * But deriving the cap from the balanced draft ALONE is worse, for a reason
 * that is easy to get backwards — I did. On the normal path the balanced
 * draft's dearest player is £12.0m, so a pure "one tier below" rule gives an
 * £11.5m cap. Measured, that cap produces a squad BYTE-IDENTICAL to the one
 * the £8.5m cap produces (both share 12 of 15 with balanced, both top out at
 * £8.5m): the greedy build simply never wanted anyone between £8.5m and
 * £11.5m. So the derived cap costs nothing in squad terms — the damage is
 * entirely in the card, which would announce an £11.5m ceiling for a draft
 * whose dearest player is £8.5m, and would move that headline number around
 * from season to season for no reason a manager could act on.
 *
 * SO THE RULE IS A CONDITIONAL, NOT A MINIMUM — and this paragraph used to say
 * "take the minimum", which is a different function and a wrong one. `min(85,
 * dearest - 5)` tightens whenever `dearest < 90`, so it answers 82 for a
 * balanced draft topping out at £8.7m, where £8.5m binds perfectly well and
 * there is nothing to fix. What the product needs is: keep the headline £8.5m
 * whenever £8.5m excludes somebody, and only when it excludes nobody fall back
 * to one tier below the dearest pick.
 *
 * WHAT IT STILL CANNOT DO, at the £4.0m floor. If the balanced draft's dearest
 * player IS £4.0m, `dearest - 5` is below the cheapest price in the game and
 * the clamp returns 40, which excludes nobody — so the value build equals the
 * balanced build and the dedupe in `buildLaunchVariants` drops it, leaving
 * three cards. That is the documented failure mode, and here it is the right
 * answer rather than a bug: in a pool where the best fifteen are all at the
 * floor there IS no "spread the money differently" structure distinct from
 * balanced, so showing one card for one squad is honest. It is also
 * unreachable in the real game — a £100m budget does not produce an all-£4.0m
 * optimum — which is why it is documented here instead of guarded against.
 *
 * Exported so the property that makes the variant worth showing at all — that
 * it binds — can be asserted rather than assumed.
 */
export function valueCapOf(balancedSquad: Element[]): number {
  if (balancedSquad.length === 0) return VALUE_CAP;
  const dearest = Math.max(...balancedSquad.map((e) => e.now_cost));
  // NOT `Math.min(VALUE_CAP, dearest - 5)`, which is what stood here and is
  // wrong on a four-value strip nobody would think to try: £8.6m to £8.9m,
  // where £8.5m binds but `dearest - 5` is still under 85. Prices move in
  // £0.1m steps in-season, so that strip is an ordinary place for the dearest
  // pick to sit, not a corner. The test that was supposed to pin this used
  // `dearest = 120` and passed under either rule.
  //
  // The condition has to be "does £8.5m exclude anybody", which is
  // `dearest > VALUE_CAP` — nothing about `dearest - 5`.
  return dearest > VALUE_CAP ? VALUE_CAP : Math.max(40, dearest - 5);
}

/**
 * Several viable GW1 drafts, not one "answer" — pre-season uncertainty is real,
 * so we offer distinct legal £100m structures the manager can choose between:
 *  - Balanced: highest projected points overall.
 *  - Stars & scrubs: two forced premium picks, cheap enablers around them.
 *  - Value: no player above £8.5m (tightened if that would not bind) —
 *    spreads money and risk.
 *  - Strong XI: bench priced at its measured autosub value, not at par.
 *
 * These are STRUCTURES, not a ranking, and the four-season 240-restart
 * experiment in `scripts/simulate.test.ts` is why. WHICH FIFTEEN you end up
 * with swamps WHICH RULE picked them: the spread between the best and worst
 * optimum within a single objective's own family is 67-566 points across the
 * four seasons, against gaps of 77-155 between the two objectives the app
 * actually builds on (sum-of-15 for "Balanced", slot-weighted for "Strong XI";
 * across all three pairs the same experiment measures, including the XI-only
 * objective, the range is 0-249 — 0 because in 2023-24 the slot-weighted and
 * XI-only families land on the same median, 1770). In eleven of the twelve
 * family-seasons measured the within-family
 * spread is the larger of the two, and in the twelfth (2025-26's bench-aware
 * family, which converged to only five distinct optima and a 67-point spread)
 * it is not — so this is a strong tendency, not a law. It is
 * still the reason "Strong XI" is offered as a choice and is deliberately not
 * the default; see its own note above `buildBenchAwareSquad`.
 */
export function buildLaunchVariants(
  bootstrap: Bootstrap,
  fixtures: Fixture[],
  nextEvent: number,
  horizon = 5,
  pastSeason?: Map<number, PastSeasonStats>
): { xp: Map<number, PlayerXp>; variants: LaunchVariant[] } {
  const xp = projectAll({ bootstrap, fixtures, nextEvent, horizon, pastSeason });
  const score = (id: number) => xp.get(id)?.totalDiscounted ?? 0;
  const finalize = (
    key: string,
    label: string,
    description: string,
    built: { squad: Element[]; cost: number }
  ): LaunchVariant => ({
    key,
    label,
    description,
    squad: built.squad,
    cost: built.cost,
    xi: pickBestXi(built.squad, (id) => xp.get(id)?.next ?? 0),
  });

  // Two premium picks to force in "stars & scrubs": the highest-projected
  // players priced £9.0m+ (prefer distinct positions for a stronger spine).
  const premiums = bootstrap.elements
    .filter((e) => e.now_cost >= 90 && e.status !== "u" && (xp.get(e.id)?.total ?? 0) > 0)
    .sort((a, b) => score(b.id) - score(a.id));
  const stars: number[] = [];
  for (const e of premiums) {
    if (stars.length >= 2) break;
    if (stars.length === 1 && e.element_type === bootstrap.elements.find((x) => x.id === stars[0])!.element_type)
      continue; // encourage two different positions
    stars.push(e.id);
  }
  if (stars.length < 2 && premiums[1]) stars.push(premiums[1].id);

  const balanced = buildSquadWithinBudget(bootstrap.elements, xp, 1000);

  // £8.5m normally; tightened only if £8.5m would not have bound. See the note
  // on `valueCapOf` for why neither the constant nor the derived cap is right
  // on its own. The cap that was applied is what the card says, so the two
  // cannot drift apart.
  const valueCap = valueCapOf(balanced.squad);
  const valueBuilt = buildSquadWithinBudget(bootstrap.elements, xp, 1000, score, {
    maxPlayerCost: valueCap,
  });
  const drafts: [string, string, string, { squad: Element[]; cost: number }][] = [
    [
      "balanced",
      "Balanced",
      // Names the metric it wins on, deliberately. Each card also shows its
      // starting XI's projected points, and "Strong XI" beats this one on that
      // number — 47.9 against 49.9 on the current pool. Measured, not by
      // construction: `benchAwareScore` maximises discounted xP over five
      // gameweeks with no captain term, while the card prints next-GW xP with
      // the captain doubled, so the two are not the same objective and nothing
      // guarantees the ordering. It just happens to hold on both real-pool
      // paths (42.6 against 45.0 on the no-history fallback). A card
      // that called itself "the model's single best draft", which this one
      // did, was therefore contradicted by the figure printed beside it.
      "Highest projected points across all fifteen — best on the squad total, not on the eleven alone.",
      balanced,
    ],
    [
      "stars",
      "Stars & scrubs",
      "Two premium picks locked in, budget enablers around them.",
      buildSquadWithinBudget(bootstrap.elements, xp, 1000, score, { mustInclude: stars }),
    ],
    [
      "value",
      "Value / balanced budget",
      `No player above £${(valueCap / 10).toFixed(1)}m — spreads money and risk across more mid-price picks.`,
      valueBuilt,
    ],
    // Offered, not preferred. Over four real seasons at 240 restarts each the
    // unbounded search on this objective beat sum-of-15 in two and lost two
    // (+155 / -77 / -104 / +80), and an earlier run under a different
    // projection model had it losing three of four. The description below
    // therefore describes the trade in the manager's own terms instead of
    // selling it as an upgrade. It is here because "strong eleven, cheap
    // bench" is a structure managers deliberately play, and because the
    // £4.0m-backup-keeper half of it IS measured positive (+1.74 discounted xP
    // over five gameweeks, `scripts/ytcompare.test.ts`).
    [
      "strongxi",
      "Strong XI, cheap bench",
      "Prices the bench at what it actually returns through autosubs, then spends the savings on the eleven. A stronger starting team with less cover if someone is dropped.",
      buildBenchAwareSquad(bootstrap.elements, xp, 1000),
    ],
  ];

  // A build can come back short of fifteen — a `maxPlayerCost` tight enough to
  // empty a position does it — and a short "squad" is not a draft: its card
  // would price a partial team at full budget and `pickBestXi` has no legal
  // formation to find. Drop it here, BEFORE `finalize`, rather than aliasing it
  // to the balanced squad and letting the dedupe below quietly swallow it. The
  // difference matters: aliasing produced a card whose description named a cap
  // the squad it described did not obey, and left "why are there three cards?"
  // with no answer anywhere in the code.
  //
  // The budget half of the guard is here for the same reason and has never
  // fired: `buildSquadWithinBudget` is supposed to return a squad inside the
  // budget it was handed, so `cost > 1000` would be a bug in the builder, not
  // a legitimate outcome. But the comment above claims this filter stops a
  // card that misprices a team, and a fifteen costing £101m is exactly that,
  // so the check has to be here or the comment is a lie.
  //
  // And it is NOT unreachable, which an earlier draft of this comment claimed.
  // `buildSquadWithinBudget`'s downgrade loop is `while (cost > budget && ...)`
  // with a `break` when no legal swap is left, and it never downgrades a locked
  // pick — so a `mustInclude` build with two forced premiums and a thin pool
  // can legitimately return over budget. The "Stars & scrubs" draft is exactly
  // that shape. What this filter changes for that case is that the card
  // disappears instead of appearing with an illegal price on it, which is the
  // better of the two, and the four-key assertions in `optimizer.test.ts` and
  // `ytcompare.test.ts` are what stop it disappearing unnoticed.
  //
  // No fixture currently drives it: deleting `&& built.cost <= 1000` leaves the
  // whole suite green.
  const variants = drafts
    .filter(([, , , built]) => built.squad.length === 15 && built.cost <= 1000)
    .map(([key, label, description, built]) => finalize(key, label, description, built));

  // Drop a variant if it came out identical to another (dedupe by squad ids).
  const seen = new Set<string>();
  const unique = variants.filter((v) => {
    const k = v.squad.map((e) => e.id).sort((a, b) => a - b).join(",");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { xp, variants: unique };
}

function dreamSquadWithinValue(
  elements: Element[],
  xp: Map<number, PlayerXp>,
  budget: number
): Element[] {
  return buildSquadWithinBudget(elements, xp, budget).squad;
}

// ---------------------------------------------------------------------------
// Multi-gameweek sequenced planner
// ---------------------------------------------------------------------------
// Answers "WHEN should I make which transfer?", not just "what should I do
// now": bank a free transfer this week, make the double move when the
// fixtures swing, take a hit only when it pays. Beam search over per-GW
// decisions (0..2 transfers per GW) with official FT banking (max 5) and
// -4 hits, scored by discounted best-XI xP across the horizon.

export interface GwPlanStep {
  gw: number;
  transfers: TransferMove[];
  ftBefore: number; // free transfers available going into this GW
  hit: number; // points paid this GW
  bankAfter: number; // tenths
  xi: BestXi; // best XI for this GW after the moves
  note?: string; // e.g. "double gameweek"
}

export interface SeasonPlan {
  steps: GwPlanStep[];
  totalXp: number; // discounted XI xp over the horizon, hits subtracted
  totalHits: number;
  keepXp: number; // same score for doing nothing all horizon
  gainVsKeep: number;
}

interface PlanState {
  players: { element: Element; sell: number }[];
  bank: number;
  ft: number;
  score: number; // accumulated discounted xp minus hits (played GWs so far)
  steps: { gw: number; moves: TransferMove[]; ftBefore: number; hit: number; bankAfter: number }[];
}

export interface PlannerInput {
  bootstrap: Bootstrap;
  fixtures: Fixture[];
  owned: OwnedPlayer[];
  bank: number;
  freeTransfers: number;
  nextEvent: number;
  horizon?: number; // default 6
  candidatesPerPosition?: number; // default 10
  beamWidth?: number; // default 6
  singlesPerState?: number; // default 8
  precomputedXp?: Map<number, PlayerXp>;
  recentForm?: Map<number, RecentForm>;
  /** See the note on `OptimizerInput.pastSeason`. */
  pastSeason?: Map<number, PastSeasonStats>;
}

export function planHorizon(input: PlannerInput): SeasonPlan {
  const { bootstrap, fixtures, owned, bank, freeTransfers, nextEvent } = input;
  const horizon = input.horizon ?? 6;
  const candN = input.candidatesPerPosition ?? 10;
  const beamWidth = input.beamWidth ?? 6;
  const singlesN = input.singlesPerState ?? 8;

  const xp =
    input.precomputedXp ??
    projectAll({
      bootstrap,
      fixtures,
      nextEvent,
      horizon,
      recentForm: input.recentForm,
      pastSeason: input.pastSeason,
    });
  const lastEvent =
    bootstrap.events.length > 0 ? bootstrap.events[bootstrap.events.length - 1].id : 38;
  const gws: number[] = [];
  for (let g = nextEvent; g < nextEvent + horizon && g <= lastEvent; g++) gws.push(g);
  const decayAt = (gw: number) => Math.pow(XP_CONFIG.gwDecay, gw - nextEvent);
  const fxIndex = makeFixtureIndex(fixtures);

  // Global candidate pool per position (best remaining-horizon players).
  const candidates = new Map<ElementType, Element[]>();
  for (const t of [1, 2, 3, 4] as ElementType[]) {
    candidates.set(
      t,
      bootstrap.elements
        .filter(
          (e) => e.element_type === t && e.status !== "u" && (xp.get(e.id)?.total ?? 0) > 0
        )
        .sort(
          (a, b) => (xp.get(b.id)?.totalDiscounted ?? 0) - (xp.get(a.id)?.totalDiscounted ?? 0)
        )
        .slice(0, candN)
    );
  }

  // Remaining-horizon xp of a player from a given GW on (discounted).
  const restXp = (id: number, fromGw: number): number => {
    const p = xp.get(id);
    if (!p) return 0;
    let s = 0;
    for (const [g, v] of p.perGw) if (g >= fromGw) s += v * decayAt(g);
    return s;
  };

  const xiAt = (players: { element: Element }[], gw: number): BestXi =>
    pickBestXi(players.map((p) => p.element), (id) => xp.get(id)?.perGw.get(gw) ?? 0);

  // Future potential of a squad over remaining GWs (for beam ranking only).
  const futureScore = (players: { element: Element }[], fromIdx: number): number => {
    let s = 0;
    for (let i = fromIdx; i < gws.length; i++) s += xiAt(players, gws[i]).totalXp * decayAt(gws[i]);
    return s;
  };

  const applyMove = (
    state: PlanState,
    moves: TransferMove[]
  ): { players: PlanState["players"]; bank: number } | null => {
    let players = state.players;
    let bk = state.bank;
    for (const m of moves) {
      const out = players.find((p) => p.element.id === m.out.id);
      if (!out) return null;
      if (players.some((p) => p.element.id === m.in.id)) return null;
      bk = bk + out.sell - m.in.now_cost;
      if (bk < 0) return null;
      players = players
        .filter((p) => p.element.id !== m.out.id)
        .concat([{ element: m.in, sell: m.in.now_cost }]);
    }
    if (!clubCountOk(players.map((p) => p.element))) return null;
    return { players, bank: bk };
  };

  let beam: PlanState[] = [
    {
      players: owned.map((o) => ({ element: o.element, sell: o.sellPrice })),
      bank,
      ft: freeTransfers,
      score: 0,
      steps: [],
    },
  ];
  // Baseline: never transfer.
  const keepXp = futureScore(beam[0].players, 0);

  for (let gi = 0; gi < gws.length; gi++) {
    const gw = gws[gi];
    const next: { s: PlanState; rank: number }[] = [];
    const seen = new Set<string>();

    for (const state of beam) {
      // Candidate single moves for THIS state, ranked by remaining-horizon gain.
      const singles: TransferMove[] = [];
      for (const outP of state.players) {
        const pool = candidates.get(outP.element.element_type) ?? [];
        for (const inEl of pool) {
          if (inEl.id === outP.element.id) continue;
          if (state.players.some((p) => p.element.id === inEl.id)) continue;
          if (state.bank + outP.sell - inEl.now_cost < 0) continue;
          singles.push({ out: outP.element, outSell: outP.sell, in: inEl, inCost: inEl.now_cost });
        }
      }
      singles.sort(
        (a, b) =>
          restXp(b.in.id, gw) - restXp(b.out.id, gw) - (restXp(a.in.id, gw) - restXp(a.out.id, gw))
      );
      const topSingles = singles.slice(0, singlesN);

      // Move sets to evaluate: none, top singles, pairs of the top few singles.
      const moveSets: TransferMove[][] = [[]];
      for (const s of topSingles) moveSets.push([s]);
      const pairBase = topSingles.slice(0, 5);
      for (let i = 0; i < pairBase.length; i++) {
        for (let j = i + 1; j < pairBase.length; j++) {
          const a = pairBase[i];
          const b = pairBase[j];
          if (a.out.id === b.out.id || a.in.id === b.in.id) continue;
          if (a.in.id === b.out.id || b.in.id === a.out.id) continue;
          moveSets.push([a, b]);
        }
      }

      for (const moves of moveSets) {
        const applied = applyMove(state, moves);
        if (!applied) continue;
        const used = moves.length;
        const hit = Math.max(0, used - state.ft) * TRANSFER_HIT;
        // FT rule: hits mean all FTs are gone; otherwise subtract, then +1 (cap 5).
        const ftAfter = Math.min(
          MAX_FREE_TRANSFERS,
          (hit > 0 ? 0 : Math.max(0, state.ft - used)) + 1
        );
        const xi = xiAt(applied.players, gw);
        const gwScore = xi.totalXp * decayAt(gw) - hit;
        const key =
          applied.players
            .map((p) => p.element.id)
            .sort((a, b) => a - b)
            .join(",") + `|${state.ft}-${used}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const s: PlanState = {
          players: applied.players,
          bank: applied.bank,
          ft: ftAfter,
          score: state.score + gwScore,
          steps: [
            ...state.steps,
            { gw, moves, ftBefore: state.ft, hit, bankAfter: applied.bank },
          ],
        };
        next.push({ s, rank: s.score + futureScore(applied.players, gi + 1) });
      }
    }

    next.sort((a, b) => b.rank - a.rank);
    beam = next.slice(0, beamWidth).map((n) => n.s);
    if (beam.length === 0) break;
  }

  const best = beam[0];
  const steps: GwPlanStep[] = best.steps.map((st) => {
    const squadAt = reconstructSquad(owned, best.steps, st.gw);
    const byTeam = fxIndex.get(st.gw);
    let note: string | undefined;
    if (byTeam) {
      let dbl = 0;
      let blank = 0;
      for (const p of squadAt) {
        const n = byTeam.get(p.element.team)?.length ?? 0;
        if (n >= 2) dbl++;
        else if (n === 0) blank++;
      }
      if (dbl > 0) note = `double gameweek for ${dbl} of your players`;
      else if (blank >= 3) note = `${blank} of your players blank`;
    }
    return {
      gw: st.gw,
      transfers: st.moves,
      ftBefore: st.ftBefore,
      hit: st.hit,
      bankAfter: st.bankAfter,
      xi: xiAt(squadAt, st.gw),
      note,
    };
  });
  const totalHits = steps.reduce((s, st) => s + st.hit, 0);
  return {
    steps,
    totalXp: best.score,
    totalHits,
    keepXp,
    gainVsKeep: best.score - keepXp,
  };
}

/** Squad composition after all planned moves up to AND including `gw`. */
function reconstructSquad(
  owned: OwnedPlayer[],
  steps: { gw: number; moves: TransferMove[] }[],
  gw: number
): { element: Element }[] {
  let players: { element: Element }[] = owned.map((o) => ({ element: o.element }));
  for (const st of steps) {
    if (st.gw > gw) break;
    for (const m of st.moves) {
      players = players.filter((p) => p.element.id !== m.out.id).concat([{ element: m.in }]);
    }
  }
  return players;
}

// ---------------------------------------------------------------------------
// Chip "what-if" scenarios
// ---------------------------------------------------------------------------
// Turn a chip badge into an actual decision aid: what would this chip do if I
// played it? Computed on demand when the user taps a chip.

export interface ChipScenario {
  chip: string;
  label: string;
  bestGw: number; // GW where the chip pays most
  gain: number; // projected extra points from playing it
  note?: string; // e.g. "double gameweek for 3 of your players"
  squad?: Element[]; // Wildcard / Free Hit: the squad to field
  cost?: number; // squad cost (tenths)
  bank?: number; // left in the bank (tenths)
  xi?: BestXi; // resulting best XI
  benchSlots?: XiSlot[]; // Bench Boost: the bench that would score
  captainName?: string; // Triple Captain: who to triple
  horizon: number;
}

export function chipScenario(input: OptimizerInput, chip: string): ChipScenario {
  const { bootstrap, fixtures, owned, bank, nextEvent } = input;
  const horizon = input.horizon ?? 5;
  const xp =
    input.precomputedXp ??
    projectAll({
      bootstrap,
      fixtures,
      nextEvent,
      horizon,
      recentForm: input.recentForm,
      pastSeason: input.pastSeason,
    });
  const lastEvent =
    bootstrap.events.length > 0 ? bootstrap.events[bootstrap.events.length - 1].id : 38;
  const gws: number[] = [];
  for (let g = nextEvent; g < nextEvent + horizon && g <= lastEvent; g++) gws.push(g);
  const squadEls = owned.map((o) => o.element);
  const teamValue = owned.reduce((s, o) => s + o.sellPrice, 0) + bank;
  const label =
    chip === "wildcard"
      ? "Wildcard"
      : chip === "freehit"
        ? "Free Hit"
        : chip === "bboost"
          ? "Bench Boost"
          : "Triple Captain";

  const fxIndex = makeFixtureIndex(fixtures);
  const squadTeams = new Set(squadEls.map((e) => e.team));
  const gwNote = (gw: number): string | undefined => {
    const byTeam = fxIndex.get(gw);
    if (!byTeam) return undefined;
    let dbl = 0;
    let blank = 0;
    for (const t of squadTeams) {
      const n = byTeam.get(t)?.length ?? 0;
      if (n >= 2) dbl++;
      else if (n === 0) blank++;
    }
    if (dbl > 0) return `double gameweek for ${dbl} of your clubs`;
    if (blank >= 3) return `${blank} of your clubs blank`;
    return undefined;
  };
  const xiAt = (els: Element[], gw: number) =>
    pickBestXi(els, (id) => xp.get(id)?.perGw.get(gw) ?? 0);

  if (chip === "wildcard") {
    // Permanent rebuild within team value, judged over the whole horizon.
    const { squad, cost } = buildSquadWithinBudget(bootstrap.elements, xp, teamValue);
    const gain = Math.max(
      0,
      horizonScore(squad, xp, gws) - horizonScore(squadEls, xp, gws)
    );
    return {
      chip,
      label,
      bestGw: nextEvent,
      gain,
      squad,
      cost,
      bank: teamValue - cost,
      xi: xiAt(squad, nextEvent),
      horizon,
    };
  }

  if (chip === "freehit") {
    // One-week squad tailored to the single best gameweek in the horizon.
    let best = { gw: nextEvent, gain: -Infinity, squad: [] as Element[], cost: 0 };
    for (const gw of gws) {
      const { squad, cost } = buildSquadWithinBudget(
        bootstrap.elements,
        xp,
        teamValue,
        (id) => xp.get(id)?.perGw.get(gw) ?? 0
      );
      const gain = xiAt(squad, gw).totalXp - xiAt(squadEls, gw).totalXp;
      if (gain > best.gain) best = { gw, gain, squad, cost };
    }
    return {
      chip,
      label,
      bestGw: best.gw,
      gain: Math.max(0, best.gain),
      note: gwNote(best.gw),
      squad: best.squad,
      cost: best.cost,
      bank: teamValue - best.cost,
      xi: xiAt(best.squad, best.gw),
      horizon,
    };
  }

  if (chip === "bboost") {
    let best = { gw: nextEvent, gain: 0, xi: xiAt(squadEls, nextEvent) };
    for (const gw of gws) {
      const xi = xiAt(squadEls, gw);
      const benchXp = xi.bench.reduce((s, p) => s + p.xp, 0);
      if (benchXp > best.gain) best = { gw, gain: benchXp, xi };
    }
    return {
      chip,
      label,
      bestGw: best.gw,
      gain: best.gain,
      note: gwNote(best.gw),
      benchSlots: best.xi.bench,
      xi: best.xi,
      horizon,
    };
  }

  // Triple Captain
  let best = { gw: nextEvent, gain: 0, name: squadEls[0]?.web_name ?? "your captain" };
  for (const gw of gws) {
    for (const e of squadEls) {
      const v = xp.get(e.id)?.perGw.get(gw) ?? 0;
      if (v > best.gain) best = { gw, gain: v, name: e.web_name };
    }
  }
  return {
    chip,
    label,
    bestGw: best.gw,
    gain: best.gain, // the extra 1x on top of the normal captain double
    note: gwNote(best.gw),
    captainName: best.name,
    horizon,
  };
}
