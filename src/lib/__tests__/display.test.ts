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
  scoreTier,
  RETURN_THRESHOLD,
  teamValue,
  valueDelta,
  type BenchRow,
  kickoffLabel,
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

describe("teamValue", () => {
  it("does not add the bank to a value that already contains it", () => {
    // The whole content of the bug: `value` is squad PLUS bank, so the obvious
    // sum returns the bank twice. A card reading £115.4m opened into a table
    // reading £116.9m for the same gameweek.
    expect(teamValue({ value: 1154, bank: 15 })).toBe(1154);
    expect(teamValue({ value: 1154, bank: 15 })).not.toBe(1154 + 15);
  });

  it("reconciles with the squad-derived figure the Team value card shows", () => {
    // The card computes Σ sellPrice + bank from the squad; the history table
    // reads the row. FPL's definition makes those the same number, and the
    // point of the helper is that they cannot drift apart again.
    //
    // THE EXPECTATION IS THE CARD'S SIDE OF THE IDENTITY, NOT THE ROW'S. An
    // earlier draft built `row.value` as `Σ sellPrice + bank` and then asserted
    // `teamValue(row)` equalled that same expression — true for `r.value`, and
    // equally true for `r.value + r.bank`, `r.value * 1`, or anything else that
    // happens to be handed the number it was given. A test that passes for the
    // bug it was written to catch is worse than no test: it reports coverage.
    // So the two sides are computed independently and only the squad total plus
    // the bank appears on the right.
    const sellPrices = [130, 95, 80, 75, 70, 65, 60, 55, 50, 50, 45, 45, 45, 40, 40];
    const squad = sellPrices.reduce((a, b) => a + b, 0);
    const bank = 15;
    expect(teamValue({ value: squad + bank, bank })).toBe(squad + bank);
    // The positive control: the same row, read the buggy way, is 15 too high.
    // If this ever stops being a distinct number the test above has gone vacuous.
    expect(teamValue({ value: squad + bank, bank })).not.toBe(squad + bank + bank);
  });

  it("is the row's own value whatever the bank happens to be", () => {
    // The bank must not reach the answer at all — not scaled, not conditional
    // on being zero, not added back under some other name. Holding `value`
    // fixed and sweeping `bank` is the cheapest way to say that: any
    // implementation that reads `bank` produces a different number somewhere in
    // the sweep, and every one of these rows is one FPL could really serve.
    for (const bank of [0, 1, 5, 15, 47, 300]) {
      expect({ bank, v: teamValue({ value: 1154, bank }) }).toEqual({ bank, v: 1154 });
    }
  });

  it("leaves a season that started on budget starting on budget", () => {
    // Every manager's GW1 team value is exactly 1000 whatever they left
    // unspent. Adding the bank made a manager who banked £1.5m look as though
    // he had begun the season £1.5m over the £100.0m everyone gets.
    expect(teamValue({ value: 1000, bank: 15 })).toBe(1000);
  });

});

/*
 * THE BENCH/XI BOUNDARY, WHICH NO FIXTURE EVER TOUCHED.
 *
 * Every case in this file subs out pick #7, so `pickPosition > 11` could be
 * flipped to `>= 11` with the whole suite green — and under that mutant a
 * STARTER at position 11 who is subbed out is counted as bench points, adding
 * his score to a total that is supposed to exclude him.
 */
describe("benchPoints at the boundary", () => {
  const rows = [
    { pickPosition: 11, elementId: 11, display: 7 },
    { pickPosition: 12, elementId: 12, display: 5 },
  ];

  it("counts position 12 and not position 11", () => {
    // Neither is in the effective XI, so only the boundary decides.
    expect(benchPoints(rows, new Set<number>())).toBe(5);
  });

  it("still excludes a bench player the auto-subs promoted", () => {
    expect(benchPoints(rows, new Set([12]))).toBe(0);
  });

  it("counts a starter at 11 for nothing even when he is out of the XI", () => {
    // Position 11 is the last STARTER. A blanking starter is not bench points;
    // he is a hole in the eleven, and the sub who replaced him is in the XI.
    expect(benchPoints([rows[0]], new Set<number>())).toBe(0);
  });
});

describe("valueDelta", () => {
  it("points the sign at the later gameweek", () => {
    // The card renders `good: diff > 0` and an up/down arrow off this number,
    // so an inverted subtraction is not a rounding error — it paints a squad
    // that has LOST £2.0m green and pointing upward. The argument order is the
    // whole content of the function and it needs saying out loud.
    expect(valueDelta({ value: 1174, bank: 5 }, { value: 1154, bank: 15 })).toBe(20);
    expect(valueDelta({ value: 1134, bank: 5 }, { value: 1154, bank: 15 })).toBe(-20);
  });

  it("counts a bank movement once", () => {
    // Selling £1.0m of squad into the bank moves nothing: team value is flat.
    // The rows differ in `bank` ALONE — under the double-counting reading this
    // returns +10 and the card reports a £1.0m gain for a sale. The earlier
    // version of this test gave both rows the same bank as well as the same
    // value, so it subtracted a number from itself and could not fail.
    expect(valueDelta({ value: 1100, bank: 15 }, { value: 1100, bank: 5 })).toBe(0);
    expect(valueDelta({ value: 1100, bank: 5 }, { value: 1100, bank: 15 })).toBe(0);
  });

  it("reports no movement across a gameweek nothing happened in", () => {
    // `valueDelta(x, x) === 0` is true for any definition of `teamValue`, so
    // this is paired with a case that actually moved.
    expect(valueDelta({ value: 1154, bank: 15 }, { value: 1154, bank: 15 })).toBe(0);
    expect(valueDelta({ value: 1155, bank: 15 }, { value: 1154, bank: 15 })).toBe(1);
  });

  it("agrees with a hand-computed answer, not with itself", () => {
    /*
     * THIS USED TO BE A TAUTOLOGY. `valueDelta` IS
     * `teamValue(later) - teamValue(earlier)`, so asserting that equality with
     * the same helper on the right-hand side holds for ANY definition of
     * `teamValue` — including the bank double-count this module's header says
     * it exists to prevent. Mutation-tested: with `teamValue` returning
     * `value + bank`, six tests in this file went red and this one stayed
     * green. The expected number is now written out.
     *
     * `entry_history.value` ALREADY INCLUDES the bank — the game defines team
     * value as squad plus bank — so `teamValue` returns it untouched and the
     * delta is just the change in the published figure:
     *   1183 − 1154 = 29
     * The bug this guards against is `value + bank`, which would give
     *   (1183 + 2) − (1154 + 15) = 14
     * and it is the difference between those two numbers that the assertion
     * has to be able to see.
     */
    const later = { value: 1183, bank: 2 };
    const earlier = { value: 1154, bank: 15 };
    expect(valueDelta(later, earlier)).toBe(29);
    expect(valueDelta(later, earlier)).not.toBe(14);
    // And the helper it replaced an inline subtraction with still agrees.
    expect(valueDelta(later, earlier)).toBe(teamValue(later) - teamValue(earlier));
  });
});

/*
 * THE COLOUR USED TO TRACK THE CLOCK, NOT THE SCORE.
 *
 * Every live score was painted accent green while the gameweek was unfinished
 * and plain once it finished, so before kick-off a whole fifteen-man list was
 * bright green noughts and nothing stood out — which is what the reader
 * reported. These pin the boundaries to FPL's scoring rules rather than to a
 * scale someone chose.
 */
describe("scoreTier", () => {
  it("treats nought as nothing to look at", () => {
    expect(scoreTier(0)).toBe("blank");
  });

  it("separates an appearance from a return at 3, the smallest scoring event", () => {
    // 1 for playing, 2 from 60 minutes: present, nothing returned.
    expect(scoreTier(1)).toBe("played");
    expect(scoreTier(2)).toBe("played");
    // An assist is 3; a defender's clean sheet 4; a goal 4-6.
    expect(scoreTier(3)).toBe("returned");
    expect(scoreTier(RETURN_THRESHOLD)).toBe("returned");
  });

  it("keeps every haul in the same tier rather than inventing a boundary", () => {
    // There is no FPL rule that says where a haul begins, so there is no fourth
    // tier. If one is ever added it has to be measured first.
    for (const p of [3, 6, 9, 13, 21]) expect(scoreTier(p)).toBe("returned");
  });

  it("calls a negative score out rather than folding it in with nought", () => {
    // A score only goes under zero through a card, an own goal, a missed
    // penalty or goals conceded. Painting that as "nothing happened" hides the
    // row most worth seeing, and the first version of this function did.
    expect(scoreTier(-1)).toBe("negative");
    expect(scoreTier(-3)).toBe("negative");
    expect(scoreTier(-0.5)).toBe("negative");
  });

  it("does not shout about a broken number", () => {
    expect(scoreTier(NaN)).toBe("blank");
    expect(scoreTier(Infinity)).toBe("blank");
    expect(scoreTier(-Infinity)).toBe("blank");
  });

  it("says nothing about whether the score is final", () => {
    // Live-or-final is a fact about the gameweek, not the player. Spending the
    // per-row colour on it is what caused the original problem, so the tier
    // takes one argument and there is nowhere to put the clock.
    expect(scoreTier.length).toBe(1);
  });
});

/*
 * FPL PUBLISHES A PLACEHOLDER KICKOFF FOR A FIXTURE AWAITING RESCHEDULING and
 * flags it with `provisional_start_time`. Both places that render a kickoff
 * printed the placeholder as a settled time — "Sat 15:00" for a match nobody
 * has scheduled — because the `Fixture` type did not carry the flag, so nobody
 * knew to look. Same shape as the `minutes` and `finished_provisional` misses.
 */
describe("kickoffLabel", () => {
  const fmt = () => "Sat 15:00";

  it("prints a confirmed time as fact", () => {
    expect(kickoffLabel({ kickoff_time: "2026-01-01T15:00:00Z" }, fmt)).toBe("Sat 15:00");
    expect(
      kickoffLabel({ kickoff_time: "2026-01-01T15:00:00Z", provisional_start_time: false }, fmt)
    ).toBe("Sat 15:00");
  });

  it("marks a provisional time rather than hiding it", () => {
    // The date is still the best guide there is; it just is not a promise.
    expect(
      kickoffLabel({ kickoff_time: "2026-01-01T15:00:00Z", provisional_start_time: true }, fmt)
    ).toBe("Sat 15:00 (TBC)");
  });

  it("says TBC when there is no time at all", () => {
    expect(kickoffLabel({ kickoff_time: null }, fmt)).toBe("TBC");
    expect(kickoffLabel({ kickoff_time: null, provisional_start_time: true }, fmt)).toBe("TBC");
  });
});
