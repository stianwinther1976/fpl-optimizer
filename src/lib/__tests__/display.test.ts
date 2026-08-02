import { describe, it, expect } from "vitest";
import {
  autoSubView,
  benchPoints,
  netEventPoints,
  netGwPoints,
  netGwDelta,
  averageFdr,
  fdrSortKey,
  signedPrice,
  type BenchRow,
} from "../display";

/**
 * Every case below is a bug that shipped. The functions under test used to be
 * expressions inside JSX, where nothing could reach them; the point of the
 * module is that these assertions are now possible at all.
 */
describe("benchPoints", () => {
  // Fifteen picks. 1..11 start, 12..15 are the bench. The bench scores
  // 2 + 9 + 1 + 4 = 16, and the starters score plenty so that a filter which
  // accidentally swallows the whole squad still cannot produce 16 by luck.
  const squad: BenchRow[] = [
    ...Array.from({ length: 11 }, (_, i) => ({
      elementId: i + 1,
      pickPosition: i + 1,
      display: 5,
    })),
    { elementId: 12, pickPosition: 12, display: 2 },
    { elementId: 13, pickPosition: 13, display: 9 },
    { elementId: 14, pickPosition: 14, display: 1 },
    { elementId: 15, pickPosition: 15, display: 4 },
  ];
  const startingXi = new Set(Array.from({ length: 11 }, (_, i) => i + 1));

  it("adds up the bench in an ordinary gameweek", () => {
    expect(benchPoints(squad, startingXi)).toBe(16);
  });

  it("does not count a bench player the auto-subs promoted", () => {
    // #7 blanked and #13 (9 pts) came on for him: #13 is in the effective XI,
    // so what the bench contributed while on the bench is 16 - 9 = 7.
    const effectiveXi = new Set([...startingXi].filter((id) => id !== 7).concat(13));
    expect(benchPoints(squad, effectiveXi)).toBe(7);
  });

  it("is zero when the bench genuinely scored nothing", () => {
    const blanked = squad.map((r) => (r.pickPosition > 11 ? { ...r, display: 0 } : r));
    expect(benchPoints(blanked, startingXi)).toBe(0);
  });

  describe("under Bench Boost, composed with autoSubView", () => {
    // THE REGRESSION, and it only appears when the two functions are used
    // together — which is why testing `benchPoints` alone with a hand-made
    // "starting XI" set proved nothing at all.
    //
    // Starter #7 blanked. The auto-sub projection is chip-blind, so it offers
    // to bring #13 (9 pts) on for him. Under Bench Boost FPL performs no
    // substitution: all fifteen play, and the chip is worth the whole bench,
    // 2 + 9 + 1 + 4 = 16. Handing the raw projection straight to `benchPoints`
    // dropped #13 and reported 7 — a plausible-looking number, understating
    // the chip by the score of its best bench player, in the only week the
    // figure exists to be read.
    const projection = {
      effectiveXi: [...startingXi].filter((id) => id !== 7).concat(13),
      in: [13],
      out: [7],
    };
    const starters = [...startingXi];

    it("counts the whole bench and draws no substitution arrows", () => {
      const view = autoSubView(starters, projection, true);
      expect(benchPoints(squad, view.xi)).toBe(16);
      expect(view.subbedIn.size).toBe(0);
      expect(view.subbedOut.size).toBe(0);
    });

    it("differs from the chip-blind reading, which is the whole point", () => {
      const chipBlind = autoSubView(starters, projection, false);
      expect(benchPoints(squad, chipBlind.xi)).toBe(7);
      expect(benchPoints(squad, autoSubView(starters, projection, true).xi)).not.toBe(7);
    });

    it("still applies the substitution in an ordinary week", () => {
      const view = autoSubView(starters, projection, false);
      expect(view.xi.has(13)).toBe(true);
      expect(view.xi.has(7)).toBe(false);
      expect([...view.subbedIn]).toEqual([13]);
      expect([...view.subbedOut]).toEqual([7]);
    });
  });
});

describe("autoSubView", () => {
  const starters = [1, 2, 3];

  it("falls back to the picked eleven when there is no projection yet", () => {
    const view = autoSubView(starters, null, false);
    expect([...view.xi]).toEqual(starters);
    expect(view.subbedIn.size).toBe(0);
  });

  it("ignores the projection entirely under Bench Boost", () => {
    const view = autoSubView(starters, { effectiveXi: [9, 9, 9], in: [9], out: [1] }, true);
    expect([...view.xi]).toEqual(starters);
    expect(view.xi.has(9)).toBe(false);
  });
});

describe("netEventPoints", () => {
  // The reconciliation exists because the feed does not say which convention
  // `entry.summary_event_points` uses. Both readings have to come out net.
  it("takes the hit off when the summary is the gross figure", () => {
    expect(netEventPoints(61, { points: 61, event_transfers_cost: 4 })).toBe(57);
  });

  it("leaves an already-net summary alone", () => {
    // The row must NOT agree with the summary here. `{points: 61, cost: 4}`
    // would be a useless fixture: 61 − 4 is 57 either way, so a version that
    // blindly subtracts passes it. The live summary is 57 against a history
    // row still reading 70 gross — only a version that recognises "the summary
    // is not the gross figure, so leave it" returns 57 rather than 66.
    expect(netEventPoints(57, { points: 70, event_transfers_cost: 4 })).toBe(57);
    expect(netEventPoints(57, { points: 70, event_transfers_cost: 4 })).not.toBe(66);
  });

  it("is a no-op in a week with no hit, whichever convention holds", () => {
    expect(netEventPoints(61, { points: 61, event_transfers_cost: 0 })).toBe(61);
  });

  it("passes a live summary through when the history has not caught up", () => {
    // Different gameweek is filtered out by the caller, but a null row is the
    // shape that reaches here, and the summary must survive it untouched.
    expect(netEventPoints(23, null)).toBe(23);
  });

  it("falls back to the history row when there is no summary", () => {
    expect(netEventPoints(null, { points: 61, event_transfers_cost: 4 })).toBe(57);
  });
});

describe("netGwPoints / netGwDelta", () => {
  it("takes the hit off the gameweek score", () => {
    expect(netGwPoints({ points: 61, event_transfers_cost: 4 })).toBe(57);
    expect(netGwPoints({ points: 61, event_transfers_cost: 0 })).toBe(61);
  });

  it("differences two gameweeks after hits, not before", () => {
    // THE REGRESSION, with the numbers that make it visible. 61 gross with a
    // −4 is 57 net; against a clean 60 the week was three points WORSE, not
    // one point better. The old code differenced the gross figures and put
    // "+1 pts" under a headline that already read 57.
    const curr = { points: 61, event_transfers_cost: 4 };
    const past = { points: 60, event_transfers_cost: 0 };
    expect(netGwDelta(curr, past)).toBe(-3);
    expect(netGwDelta(curr, past)).not.toBe(curr.points - past.points);
  });

  it("agrees with the gross difference when neither week took a hit", () => {
    const curr = { points: 61, event_transfers_cost: 0 };
    const past = { points: 60, event_transfers_cost: 0 };
    expect(netGwDelta(curr, past)).toBe(1);
  });

  it("cancels equal hits in both weeks", () => {
    expect(netGwDelta({ points: 61, event_transfers_cost: 4 }, { points: 60, event_transfers_cost: 4 })).toBe(1);
  });
});

describe("averageFdr / fdrSortKey", () => {
  it("averages the fixtures it has", () => {
    expect(averageFdr([2, 3, 4])).toBe(3);
    expect(averageFdr([5])).toBe(5);
  });

  it("returns null rather than zero for a club with no fixtures", () => {
    // THE REGRESSION. `sum / Math.max(1, n)` returned 0, and 0 is not a
    // neutral placeholder here — it is better than the best legal FDR.
    expect(averageFdr([])).toBeNull();
    expect(averageFdr([])).not.toBe(0);
  });

  it("sorts a blank club last, not first, in an ascending sort", () => {
    const blank = averageFdr([]);
    const hardest = averageFdr([5, 5, 5, 5, 5]);
    const easiest = averageFdr([1, 1, 1, 1, 1]);
    const order = [blank, hardest, easiest].sort((a, b) => fdrSortKey(a) - fdrSortKey(b));
    expect(order).toEqual([easiest, hardest, blank]);
    // Belt and braces: the failure mode was specifically the blank leading a
    // table captioned "easiest first".
    expect(order[0]).not.toBeNull();
  });

  it("gives a finite key, so two blank clubs subtract to 0 rather than NaN", () => {
    // `Infinity - Infinity` is NaN. `Array#sort` coerces that to "equal" and
    // survives, but any other comparison built on this key would not.
    expect(Number.isFinite(fdrSortKey(null))).toBe(true);
    expect(fdrSortKey(null) - fdrSortKey(null)).toBe(0);
    expect(fdrSortKey(null)).toBeGreaterThan(fdrSortKey(5));
  });
});

describe("signedPrice", () => {
  const fmt = (v: number) => (v / 10).toFixed(1);

  it("signs a rise and a fall", () => {
    expect(signedPrice(1, fmt)).toBe("+£0.1m");
    expect(signedPrice(-2, fmt)).toBe("−£0.2m");
  });

  it("puts no sign on an unmoved price", () => {
    // THE REGRESSION: `diff > 0 ? "+" : "−"` sent zero down the minus branch.
    expect(signedPrice(0, fmt)).toBe("£0.0m");
    expect(signedPrice(0, fmt)).not.toContain("−");
    expect(signedPrice(0, fmt)).not.toContain("+");
  });

  it("renders an unknown price as a dash", () => {
    expect(signedPrice(null, fmt)).toBe("–");
  });
});
