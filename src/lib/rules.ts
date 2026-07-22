// The FPL rules engine — pure functions, fully unit-tested.
// All prices are in tenths of £m, same as the FPL API.

import type { ElementType, Element, Transfer } from "./types";

export const SQUAD_SIZE = 15;
export const MAX_PER_CLUB = 3;
export const INITIAL_BUDGET = 1000; // £100.0m
export const TRANSFER_HIT = 4; // points per extra transfer
export const MAX_FREE_TRANSFERS = 5; // current FPL cap on banked FTs

export const SQUAD_COMPOSITION: Record<ElementType, number> = {
  1: 2, // GK
  2: 5, // DEF
  3: 5, // MID
  4: 3, // FWD
};

export const POSITION_NAMES: Record<ElementType, string> = {
  1: "GK",
  2: "DEF",
  3: "MID",
  4: "FWD",
};

// All valid FPL formations as [DEF, MID, FWD] (GK always 1).
export const VALID_FORMATIONS: [number, number, number][] = [
  [3, 4, 3],
  [3, 5, 2],
  [4, 3, 3],
  [4, 4, 2],
  [4, 5, 1],
  [5, 2, 3],
  [5, 3, 2],
  [5, 4, 1],
];

export interface SquadPlayerLite {
  id: number;
  elementType: ElementType;
  teamId: number;
}

/** Validate a full 15-man squad against composition and club rules. Returns a list of error strings (empty = valid). */
export function validateSquad(players: SquadPlayerLite[]): string[] {
  const errors: string[] = [];
  if (players.length !== SQUAD_SIZE) {
    errors.push(`Squad must have ${SQUAD_SIZE} players (has ${players.length}).`);
  }
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== players.length) {
    errors.push("Squad contains duplicate players.");
  }
  const byType: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const byClub = new Map<number, number>();
  for (const p of players) {
    byType[p.elementType] = (byType[p.elementType] ?? 0) + 1;
    byClub.set(p.teamId, (byClub.get(p.teamId) ?? 0) + 1);
  }
  for (const t of [1, 2, 3, 4] as ElementType[]) {
    if (byType[t] !== SQUAD_COMPOSITION[t]) {
      errors.push(
        `Squad must have ${SQUAD_COMPOSITION[t]} ${POSITION_NAMES[t]} (has ${byType[t]}).`
      );
    }
  }
  for (const [teamId, count] of byClub) {
    if (count > MAX_PER_CLUB) {
      errors.push(`Max ${MAX_PER_CLUB} players from the same club (club ${teamId} has ${count}).`);
    }
  }
  return errors;
}

/** Is [def, mid, fwd] a legal formation? */
export function isValidFormation(def: number, mid: number, fwd: number): boolean {
  return VALID_FORMATIONS.some(([d, m, f]) => d === def && m === mid && f === fwd);
}

/**
 * Selling price per official rules:
 * - If the price has risen since purchase, you get purchase + 50% of the rise,
 *   rounded DOWN to the nearest £0.1m (i.e. floor in tenths).
 * - If the price has fallen, you sell at the current (lower) price.
 */
export function sellingPrice(purchasePrice: number, currentPrice: number): number {
  if (currentPrice <= purchasePrice) return currentPrice;
  return purchasePrice + Math.floor((currentPrice - purchasePrice) / 2);
}

/**
 * Determine the purchase price for a currently-owned player.
 * Uses the most recent transfer-in from the transfers endpoint; falls back to
 * the season-start price (now_cost - cost_change_start) for original-squad players.
 */
export function purchasePriceFor(element: Element, transfers: Transfer[]): number {
  let latest: Transfer | null = null;
  for (const t of transfers) {
    if (t.element_in === element.id) {
      if (!latest || t.event > latest.event || (t.event === latest.event && t.time > latest.time)) {
        latest = t;
      }
    }
  }
  if (latest) return latest.element_in_cost;
  return element.now_cost - element.cost_change_start;
}

/**
 * Free transfers available before the given gameweek.
 * FTs accumulate +1 per GW (capped), extra transfers cost points, and
 * Wildcard/Free Hit GWs neither consume nor reset banked FTs (post-2024/25 rules).
 *
 * historyRows: one row per played GW with event_transfers and event_transfers_cost.
 * chipEvents: map of event -> chip name for GWs where a chip was active.
 */
export function computeFreeTransfers(
  historyRows: { event: number; event_transfers: number; event_transfers_cost: number }[],
  chipEvents: Map<number, string>
): number {
  let ft = 1; // start of season: 1 FT for GW2 onwards (GW1 is unlimited team creation)
  const rows = [...historyRows].sort((a, b) => a.event - b.event);
  for (const row of rows.slice(1)) {
    // Each new GW grants +1 FT (added before that GW's transfers), capped.
    const chip = chipEvents.get(row.event);
    const freeTransferChip = chip === "wildcard" || chip === "freehit";
    if (freeTransferChip) {
      // Transfers don't consume FTs; banked FTs carry through unchanged.
      continue;
    }
    // Paid hits imply all FTs were used; otherwise subtract used transfers.
    if (row.event_transfers_cost > 0) {
      ft = 0;
    } else {
      ft = Math.max(0, ft - row.event_transfers);
    }
    ft = Math.min(MAX_FREE_TRANSFERS, ft + 1);
  }
  return Math.max(1, Math.min(MAX_FREE_TRANSFERS, ft));
}

/** Points cost for making `transferCount` transfers with `freeTransfers` available (0 while WC/FH active). */
export function transferCost(
  transferCount: number,
  freeTransfers: number,
  chipActive?: "wildcard" | "freehit" | null
): number {
  if (chipActive === "wildcard" || chipActive === "freehit") return 0;
  return Math.max(0, transferCount - freeTransfers) * TRANSFER_HIT;
}

export const ALL_CHIPS = ["wildcard", "freehit", "bboost", "3xc"] as const;
export type ChipName = (typeof ALL_CHIPS)[number];

export const CHIP_LABELS: Record<string, string> = {
  wildcard: "Wildcard",
  freehit: "Free Hit",
  bboost: "Bench Boost",
  "3xc": "Triple Captain",
  manager: "Assistant Manager",
};

/**
 * Remaining chips, computed dynamically. If bootstrap provides a `chips`
 * definition (with per-window counts), use it; otherwise fall back to the
 * classic set and subtract chips already played (from entry history).
 */
export function remainingChips(
  usedChips: { name: string; event: number }[],
  bootstrapChips?: { name: string; start_event: number; stop_event: number; number?: number }[] | null,
  nextEvent?: number | null
): { name: string; label: string }[] {
  if (bootstrapChips && bootstrapChips.length > 0) {
    const out: { name: string; label: string }[] = [];
    for (const c of bootstrapChips) {
      if (nextEvent != null && (nextEvent < c.start_event || nextEvent > c.stop_event)) continue;
      const usedInWindow = usedChips.filter(
        (u) => u.name === c.name && u.event >= c.start_event && u.event <= c.stop_event
      ).length;
      const total = c.number ?? 1;
      for (let i = usedInWindow; i < total; i++) {
        out.push({ name: c.name, label: CHIP_LABELS[c.name] ?? c.name });
      }
    }
    return out;
  }
  const usedNames = usedChips.map((u) => u.name);
  return ALL_CHIPS.filter((c) => {
    const used = usedNames.filter((n) => n === c).length;
    return used === 0;
  }).map((c) => ({ name: c, label: CHIP_LABELS[c] }));
}

/** Format tenths-of-£m as display string, e.g. 55 -> "5.5". */
export function fmtPrice(tenths: number): string {
  return (tenths / 10).toFixed(1);
}
