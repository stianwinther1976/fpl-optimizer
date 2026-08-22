import { describe, it, expect } from "vitest";
import type { Element } from "../types";
import { readPriceChange, priceTimingHint } from "../priceChange";

const p = (v: string | undefined) => ({ price_change_percent: v });

describe("readPriceChange", () => {
  it("classifies the five states FPL shows", () => {
    expect(readPriceChange(p("107"))?.trend).toBe("very-likely-rise");
    expect(readPriceChange(p("96"))?.trend).toBe("likely-rise");
    expect(readPriceChange(p("40"))?.trend).toBe("steady");
    expect(readPriceChange(p("-88"))?.trend).toBe("likely-drop");
    expect(readPriceChange(p("-102"))?.trend).toBe("very-likely-drop");
  });

  it("flags a move as imminent only once it is past the threshold", () => {
    expect(readPriceChange(p("99"))?.imminent).toBe(false);
    expect(readPriceChange(p("100"))?.imminent).toBe(true);
    expect(readPriceChange(p("-100"))?.imminent).toBe(true);
  });

  it("reads direction from the sign", () => {
    expect(readPriceChange(p("96"))?.direction).toBe(1);
    expect(readPriceChange(p("-96"))?.direction).toBe(-1);
    expect(readPriceChange(p("10"))?.direction).toBe(0);
  });

  it("returns null when FPL hasn't published a figure", () => {
    // Pre-season the field is absent or empty for everyone. Rendering
    // "unlikely to change" there would be a claim we can't support.
    expect(readPriceChange(p(undefined))).toBeNull();
    expect(readPriceChange(p(""))).toBeNull();
    expect(readPriceChange(p("nonsense"))).toBeNull();
  });

  it("treats a flat zero as a stopped predictor, not as a forecast", () => {
    /*
     * THIS TEST USED TO ASSERT THE OPPOSITE, and the belief it shared with the
     * code was measurable and wrong. FPL sends the string "0" while the
     * predictor is switched off rather than omitting the field, so on both live
     * snapshots every player came back `steady` — 595/595 and 600/600, zero
     * nulls — and `PlayerModal` rendered "Price change — Unlikely to change ·
     * Hasn't moved toward either" for the entire game, under a comment saying
     * "silence is honest, 'unlikely to change' on missing data isn't". Every
     * one of them also carried `price_change_hourly_rate: 0`.
     */
    expect(readPriceChange(p("0"))).toBeNull();
    expect(readPriceChange({ price_change_percent: "0", price_change_hourly_rate: 0 })).toBeNull();
  });

  it("still speaks for a player the predictor IS tracking at zero progress", () => {
    // Zero progress with a live hourly rate is a real reading: he has just
    // changed price and is being watched again. It is the pair of zeroes that
    // means nothing is running.
    const r = readPriceChange({ price_change_percent: "0", price_change_hourly_rate: 3 });
    expect(r?.trend).toBe("steady");
    expect(r?.direction).toBe(0);
  });

  it("clamps absurd values so the bar can't overflow", () => {
    expect(readPriceChange(p("5000"))?.percent).toBe(200);
    expect(readPriceChange(p("-5000"))?.percent).toBe(-200);
  });
});

describe("priceTimingHint", () => {
  it("says nothing when the price isn't moving", () => {
    expect(priceTimingHint(p("30"), "in")).toBeNull();
    expect(priceTimingHint(p(undefined), "out")).toBeNull();
  });

  it("tells you to buy a riser before midnight", () => {
    expect(priceTimingHint(p("104"), "in")).toMatch(/buy before 00:00 UK/);
  });

  it("tells you to wait a day on a faller you're buying", () => {
    expect(priceTimingHint(p("-104"), "in")).toMatch(/waiting a day/i);
  });

  it("tells you to sell a faller before midnight", () => {
    expect(priceTimingHint(p("-104"), "out")).toMatch(/sell before 00:00 UK/);
  });

  it("does not promise a full 0.1 for holding a riser you're selling", () => {
    // You bank only half of a profit, rounded down — a single rise often
    // returns nothing, so this must not read as "wait and gain 0.1".
    const hint = priceTimingHint(p("104"), "out");
    expect(hint).toMatch(/half of a profit/);
    expect(hint).not.toMatch(/0\.1/);
  });

  it("softens the wording before the threshold is crossed", () => {
    expect(priceTimingHint(p("104"), "in")).toMatch(/tonight/);
    expect(priceTimingHint(p("90"), "in")).toMatch(/soon/);
  });
});

/*
 * THE HINT FIRES AT 85% AND ONLY COMMITS AT 100%.
 *
 * Between the two the move is explicitly NOT expected tonight, and the copy
 * stated the 0.1 as fact anyway. A reader acting on "buy before 00:00 UK and
 * he costs you 0.1 less" at 85% is being told the outcome of something the
 * read does not claim.
 */
describe("priceTimingHint hedges when the read does", () => {
  const at = (pct: number) =>
    ({ price_change_percent: String(pct) }) as Pick<Element, "price_change_percent">;

  it("commits only when the move is imminent", () => {
    const rising = priceTimingHint(at(100), "in")!;
    expect(rising).toContain("tonight");
    expect(rising).not.toMatch(/not expected/);
  });

  it("says the move is not expected tonight when it is not", () => {
    for (const [pct, side] of [
      [90, "in"],
      [-90, "in"],
      [-90, "out"],
      [90, "out"],
    ] as const) {
      const hint = priceTimingHint(at(pct), side)!;
      expect(hint, `${pct}% ${side}`).toMatch(/not expected tonight|either way/);
      expect(hint, `${pct}% ${side}`).not.toContain("tonight —");
    }
  });

  it("still says nothing at all when the price is not moving", () => {
    expect(priceTimingHint(at(10), "in")).toBeNull();
    expect(priceTimingHint(at(0), "out")).toBeNull();
  });
});
