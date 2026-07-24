import { describe, it, expect } from "vitest";
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

  it("treats a published zero as real data, not missing data", () => {
    expect(readPriceChange(p("0"))?.trend).toBe("steady");
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
