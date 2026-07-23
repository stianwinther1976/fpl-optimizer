// Squad optimizer: best XI, transfer plans, captaincy and chip advice.
// Search strategy: exact formation enumeration for the XI + beam search over
// transfer combinations (documented in README). Fast enough to run in the browser.

import type { Bootstrap, Element, ElementType, Fixture, OwnedPlayer } from "./types";
import { MAX_PER_CLUB, TRANSFER_HIT, VALID_FORMATIONS } from "./rules";
import { projectAll, type PlayerXp, type XpContext } from "./xp";

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

/** Horizon score for a squad: sum over horizon GWs of best-XI xP incl. captain. */
function horizonScore(
  squad: Element[],
  xp: Map<number, PlayerXp>,
  events: number[]
): number {
  let sum = 0;
  for (const gw of events) {
    const xi = pickBestXi(squad, (id) => xp.get(id)?.perGw.get(gw) ?? 0);
    sum += xi.totalXp;
  }
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

  const ctx: XpContext = { bootstrap, fixtures, nextEvent, horizon };
  const xp = projectAll(ctx);
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
      .sort((a, b) => (xp.get(b.id)?.total ?? 0) - (xp.get(a.id)?.total ?? 0))
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
          const score = horizonScore(els, xp, gws);
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

  // --- Chip advisor ---
  const chipAdvice: ChipAdvice[] = [];
  const benchNextXp = keepXi.bench.reduce((s, p) => s + p.xp, 0);
  chipAdvice.push({
    chip: "bboost",
    label: "Bench Boost",
    projectedGain: benchNextXp,
    detail: `Your bench is projected to score ${benchNextXp.toFixed(1)} points next gameweek.`,
  });
  const capXp = keepXi.captain?.xp ?? 0;
  chipAdvice.push({
    chip: "3xc",
    label: "Triple Captain",
    projectedGain: capXp,
    detail: `${keepXi.captain?.element.web_name ?? "Your captain"} would add ~${capXp.toFixed(1)} extra points (3x instead of 2x).`,
  });
  const wcGain = Math.max(0, horizonScore(dreamSquadWithinValue(bootstrap.elements, xp, totalValue(owned, bank)), xp, gws) - keepHorizonXp);
  chipAdvice.push({
    chip: "wildcard",
    label: "Wildcard",
    projectedGain: wcGain,
    detail: `An optimal squad within your team value is projected to gain ~${wcGain.toFixed(1)} points over the next ${gws.length} gameweeks.`,
  });
  const fhSquad = dreamSquadWithinValue(bootstrap.elements, xp, totalValue(owned, bank));
  const fhXi = pickBestXi(fhSquad, (id) => xp.get(id)?.next ?? 0);
  const fhGain = Math.max(0, fhXi.totalXp - keepXi.totalXp);
  chipAdvice.push({
    chip: "freehit",
    label: "Free Hit",
    projectedGain: fhGain,
    detail: `An optimal one-week squad is projected to score ~${fhGain.toFixed(1)} more points than your current team next gameweek.`,
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

/** Greedy + repair: best 15-man squad within a budget. */
function buildSquadWithinBudget(
  elements: Element[],
  xp: Map<number, PlayerXp>,
  budget: number
): { squad: Element[]; cost: number } {
  const need: Record<ElementType, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
  const pools = new Map<ElementType, Element[]>();
  for (const t of [1, 2, 3, 4] as ElementType[]) {
    pools.set(
      t,
      elements
        .filter((e) => e.element_type === t && e.status !== "u" && (xp.get(e.id)?.total ?? 0) > 0)
        .sort((a, b) => (xp.get(b.id)?.total ?? 0) - (xp.get(a.id)?.total ?? 0))
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
        const xpLoss = (xp.get(out.id)?.total ?? 0) - (xp.get(inEl.id)?.total ?? 0);
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
