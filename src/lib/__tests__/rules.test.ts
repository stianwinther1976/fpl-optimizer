import { describe, it, expect } from "vitest";
import {
  computeFreeTransfers,
  isValidFormation,
  remainingChips,
  sellingPrice,
  transferCost,
  validateSquad,
  purchasePriceFor,
  MAX_FREE_TRANSFERS,
} from "../rules";
import type { Element, ElementType, Transfer } from "../types";

function squad(counts: [number, number, number, number], clubSpread = true) {
  const players: { id: number; elementType: ElementType; teamId: number }[] = [];
  let id = 1;
  const types: ElementType[] = [1, 2, 3, 4];
  types.forEach((t, i) => {
    for (let k = 0; k < counts[i]; k++) {
      players.push({ id: id, elementType: t, teamId: clubSpread ? id : 1 });
      id++;
    }
  });
  return players;
}

describe("validateSquad", () => {
  it("accepts a legal 2-5-5-3 squad", () => {
    expect(validateSquad(squad([2, 5, 5, 3]))).toEqual([]);
  });
  it("rejects wrong composition", () => {
    expect(validateSquad(squad([1, 6, 5, 3])).length).toBeGreaterThan(0);
  });
  it("rejects more than 3 from one club", () => {
    const s = squad([2, 5, 5, 3]);
    s[0].teamId = s[1].teamId = s[2].teamId = s[3].teamId = 7;
    expect(validateSquad(s).some((e) => e.includes("same club"))).toBe(true);
  });
  it("rejects duplicates", () => {
    const s = squad([2, 5, 5, 3]);
    s[1].id = s[0].id;
    expect(validateSquad(s).some((e) => e.includes("duplicate"))).toBe(true);
  });
});

describe("formations", () => {
  it("accepts all 8 legal formations", () => {
    for (const [d, m, f] of [
      [3, 4, 3], [3, 5, 2], [4, 3, 3], [4, 4, 2],
      [4, 5, 1], [5, 2, 3], [5, 3, 2], [5, 4, 1],
    ]) {
      expect(isValidFormation(d, m, f)).toBe(true);
    }
  });
  it("rejects 2 defenders and 4 forwards", () => {
    expect(isValidFormation(2, 5, 3)).toBe(false);
    expect(isValidFormation(3, 3, 4)).toBe(false);
  });
});

describe("sellingPrice (tenths of £m)", () => {
  it("sells at current price after a fall", () => {
    expect(sellingPrice(80, 76)).toBe(76);
  });
  it("gives 50% of rise rounded down: +0.1 rise -> no profit", () => {
    expect(sellingPrice(80, 81)).toBe(80);
  });
  it("+0.2 rise -> +0.1 profit", () => {
    expect(sellingPrice(80, 82)).toBe(81);
  });
  it("+0.3 rise -> +0.1 profit (floor)", () => {
    expect(sellingPrice(80, 83)).toBe(81);
  });
  it("+1.0 rise -> +0.5 profit", () => {
    expect(sellingPrice(80, 90)).toBe(85);
  });
  it("unchanged price sells at purchase", () => {
    expect(sellingPrice(80, 80)).toBe(80);
  });
});

describe("purchasePriceFor", () => {
  const el = { id: 5, now_cost: 90, cost_change_start: 5 } as Element;
  it("uses latest transfer-in cost", () => {
    const transfers = [
      { element_in: 5, element_in_cost: 87, event: 3, time: "t1" },
      { element_in: 5, element_in_cost: 89, event: 8, time: "t2" },
    ] as Transfer[];
    expect(purchasePriceFor(el, transfers)).toBe(89);
  });
  it("falls back to season-start price for original squad", () => {
    expect(purchasePriceFor(el, [])).toBe(85);
  });
  it("ignores transfers made in a Free Hit week (they revert)", () => {
    const transfers = [
      { element_in: 5, element_in_cost: 87, event: 3, time: "t1" },
      { element_in: 5, element_in_cost: 95, event: 12, time: "t2" }, // FH week
    ] as Transfer[];
    const chipEvents = new Map([[12, "freehit"]]);
    expect(purchasePriceFor(el, transfers, chipEvents)).toBe(87);
  });
});

describe("transferCost", () => {
  it("free within FT allowance", () => {
    expect(transferCost(2, 2)).toBe(0);
  });
  it("-4 per extra transfer", () => {
    expect(transferCost(3, 1)).toBe(8);
  });
  it("free while wildcard active", () => {
    expect(transferCost(7, 1, "wildcard")).toBe(0);
  });
  it("free while free hit active", () => {
    expect(transferCost(7, 0, "freehit")).toBe(0);
  });
});

describe("computeFreeTransfers", () => {
  const row = (event: number, t: number, cost = 0) => ({
    event,
    event_transfers: t,
    event_transfers_cost: cost,
  });
  it("banks +1 per GW without transfers, capped at max", () => {
    const rows = [row(1, 0), row(2, 0), row(3, 0), row(4, 0), row(5, 0), row(6, 0), row(7, 0)];
    expect(computeFreeTransfers(rows, new Map())).toBe(MAX_FREE_TRANSFERS);
  });
  it("uses transfers before banking", () => {
    // GW2: 1 FT, uses 1 -> 0, then +1 for GW3 => 1
    const rows = [row(1, 0), row(2, 1)];
    expect(computeFreeTransfers(rows, new Map())).toBe(1);
  });
  it("hit resets FTs to zero then banks one", () => {
    const rows = [row(1, 0), row(2, 3, 8)];
    expect(computeFreeTransfers(rows, new Map())).toBe(1);
  });
  it("wildcard week preserves banked FTs and still grants +1", () => {
    // GW2: no transfers -> bank to 2 for GW3. GW3: wildcard with 10 transfers
    // -> the 2 carry over untouched and +1 accrues for GW4 => 3.
    const rows = [row(1, 0), row(2, 0), row(3, 10)];
    expect(computeFreeTransfers(rows, new Map([[3, "wildcard"]]))).toBe(3);
  });
  it("never returns less than 1", () => {
    const rows = [row(1, 0), row(2, 5, 16)];
    expect(computeFreeTransfers(rows, new Map())).toBeGreaterThanOrEqual(1);
  });
});

describe("remainingChips", () => {
  it("fallback mirrors 2025/26 structure: two of each chip, one per half", () => {
    const left = remainingChips([
      { name: "wildcard", event: 8 },
      { name: "bboost", event: 26 },
    ]);
    const count = (n: string) => left.filter((c) => c.name === n).length;
    expect(count("wildcard")).toBe(1); // first-half WC used, second-half remains
    expect(count("bboost")).toBe(1);
    expect(count("freehit")).toBe(2);
    expect(count("3xc")).toBe(2);
  });
  it("fallback: first-half wildcard used, GW25 still has the second-half one", () => {
    const left = remainingChips([{ name: "wildcard", event: 8 }], null, 25);
    expect(left.filter((c) => c.name === "wildcard").length).toBe(1);
  });
  it("season mode counts future windows; now mode hides them", () => {
    const chips = [
      { name: "freehit", start_event: 2, stop_event: 19, number: 1 },
      { name: "freehit", start_event: 20, stop_event: 38, number: 1 },
    ];
    expect(remainingChips([], chips, 10, "now").length).toBe(1);
    expect(remainingChips([], chips, 10, "season").length).toBe(2);
  });
  it("bootstrap windows: second-half wildcard still available", () => {
    const chips = [
      { name: "wildcard", start_event: 2, stop_event: 19, number: 1 },
      { name: "wildcard", start_event: 20, stop_event: 38, number: 1 },
    ];
    const left = remainingChips([{ name: "wildcard", event: 8 }], chips, 25);
    expect(left.map((c) => c.name)).toEqual(["wildcard"]);
  });
  it("bootstrap windows: chip outside window is unavailable", () => {
    const chips = [{ name: "freehit", start_event: 2, stop_event: 19, number: 1 }];
    expect(remainingChips([], chips, 25)).toEqual([]);
  });
});
