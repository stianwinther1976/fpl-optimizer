// Squad optimizer: best XI, transfer plans, captaincy and chip advice.
// Search strategy: exact formation enumeration for the XI + beam search over
// transfer combinations (documented in README). Fast enough to run in the browser.

import type { Bootstrap, Element, ElementType, Fixture, OwnedPlayer } from "./types";
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
  bench: XiSlot[]; // ordered: first outfield subs by xp, GK last
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
  /** Recent start share per element (see XpContext.recentStarts). */
  recentStarts?: Map<number, number>;
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

  const ctx: XpContext = { bootstrap, fixtures, nextEvent, horizon, recentStarts: input.recentStarts };
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
  const fhSquad = dreamSquadWithinValue(bootstrap.elements, xp, totalValue(owned, bank));
  let fhBest = { gw: nextEvent, gain: 0 };
  for (const gw of gws) {
    const ownXi = xiAt(squadEls, gw);
    const benchXp = ownXi.bench.reduce((s, p) => s + p.xp, 0);
    if (benchXp > bbBest.gain) bbBest = { gw, gain: benchXp };
    for (const e of squadEls) {
      const v = xp.get(e.id)?.perGw.get(gw) ?? 0;
      if (v > tcBest.gain) tcBest = { gw, gain: v, name: e.web_name };
    }
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

/** Greedy + repair: best 15-man squad within a budget.
 * `scoreOf` ranks players — defaults to discounted horizon xP (permanent moves
 * like Wildcard); pass a single-GW scorer for Free Hit. */
function buildSquadWithinBudget(
  elements: Element[],
  xp: Map<number, PlayerXp>,
  budget: number,
  scoreOf: (id: number) => number = (id) => xp.get(id)?.totalDiscounted ?? 0
): { squad: Element[]; cost: number } {
  const need: Record<ElementType, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
  const pools = new Map<ElementType, Element[]>();
  for (const t of [1, 2, 3, 4] as ElementType[]) {
    pools.set(
      t,
      elements
        .filter((e) => e.element_type === t && e.status !== "u" && (xp.get(e.id)?.total ?? 0) > 0)
        .sort((a, b) => scoreOf(b.id) - scoreOf(a.id))
        .slice(0, 40)
    );
  }
  // Start with the greedy-best squad, then downgrade lowest value-per-price until affordable.
  const squad: Element[] = [];
  const clubCount = new Map<number, number>();
  for (const t of [1, 2, 3, 4] as ElementType[]) {
    for (const e of pools.get(t)!) {
      if (squad.filter((s) => s.element_type === t).length >= need[t]) break;
      if ((clubCount.get(e.team) ?? 0) >= MAX_PER_CLUB) continue;
      squad.push(e);
      clubCount.set(e.team, (clubCount.get(e.team) ?? 0) + 1);
    }
  }
  let cost = squad.reduce((s, e) => s + e.now_cost, 0);
  let guard = 200;
  while (cost > budget && guard-- > 0) {
    // Replace the worst xp-per-cost player with the cheapest viable alternative.
    let bestSwap: { outIdx: number; inEl: Element; delta: number } | null = null;
    for (let i = 0; i < squad.length; i++) {
      const out = squad[i];
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
  return { squad, cost };
}

function buildDreamSquad(elements: Element[], xp: Map<number, PlayerXp>) {
  return buildSquadWithinBudget(elements, xp, 1000);
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
  horizon = 5
): LaunchSquad {
  const xp = projectAll({ bootstrap, fixtures, nextEvent, horizon });
  const { squad, cost } = buildSquadWithinBudget(bootstrap.elements, xp, 1000);
  const xi = pickBestXi(squad, (id) => xp.get(id)?.next ?? 0);
  return { squad, cost, xi, xp };
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
  recentStarts?: Map<number, number>;
}

export function planHorizon(input: PlannerInput): SeasonPlan {
  const { bootstrap, fixtures, owned, bank, freeTransfers, nextEvent } = input;
  const horizon = input.horizon ?? 6;
  const candN = input.candidatesPerPosition ?? 10;
  const beamWidth = input.beamWidth ?? 6;
  const singlesN = input.singlesPerState ?? 8;

  const xp =
    input.precomputedXp ??
    projectAll({ bootstrap, fixtures, nextEvent, horizon, recentStarts: input.recentStarts });
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
    projectAll({ bootstrap, fixtures, nextEvent, horizon, recentStarts: input.recentStarts });
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
