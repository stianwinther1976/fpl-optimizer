// FPL's Price Change Predictor (new for 2026/27).
//
// `price_change_percent` is how far a player has travelled toward his next price
// change, signed: positive climbs toward a rise, negative toward a fall. Past
// ±100% the change is expected at the next update, which happens at 00:00 UK
// time and can move a player by at most 0.1 per day.
//
// FPL's own page also shows a "predicted progress" that extrapolates to the
// deadline; the public API exposes only the live figure, so the thresholds below
// classify what has actually happened rather than a forecast of it. That makes
// this read a little more conservative than the site near the cut-off.

import type { Element } from "./types";

export type PriceTrend =
  | "very-likely-rise"
  | "likely-rise"
  | "steady"
  | "likely-drop"
  | "very-likely-drop";

export interface PriceChangeRead {
  /** Signed progress, clamped to a sane range for display. */
  percent: number;
  trend: PriceTrend;
  /** +1 rising, -1 falling, 0 going nowhere. */
  direction: 1 | 0 | -1;
  label: string;
  /** True once the move is expected at the next 00:00 UK update. */
  imminent: boolean;
}

/** Below this a player isn't close enough for the movement to be worth saying. */
const NOTABLE = 85;

const LABELS: Record<PriceTrend, string> = {
  "very-likely-rise": "Very likely to rise",
  "likely-rise": "Likely to rise",
  steady: "Unlikely to change",
  "likely-drop": "Likely to drop",
  "very-likely-drop": "Very likely to drop",
};

/**
 * Read the predictor for one player. Returns null when FPL hasn't published a
 * figure — pre-season, and for any player the feed omits — so callers can leave
 * the UI empty rather than claim "unlikely to change" on missing data.
 */
export function readPriceChange(el: Pick<Element, "price_change_percent">): PriceChangeRead | null {
  const raw = el.price_change_percent;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const percent = Math.max(-200, Math.min(200, n));
  const mag = Math.abs(percent);

  let trend: PriceTrend = "steady";
  if (mag >= NOTABLE) {
    const strong = mag >= 100;
    trend = percent > 0 ? (strong ? "very-likely-rise" : "likely-rise") : strong ? "very-likely-drop" : "likely-drop";
  }
  return {
    percent,
    trend,
    direction: trend === "steady" ? 0 : percent > 0 ? 1 : -1,
    label: LABELS[trend],
    imminent: mag >= 100,
  };
}

/**
 * One line of transfer-timing advice, or null when the price isn't moving
 * enough to change what you'd do.
 *
 * The four cases aren't symmetric. Buying before a rise, or after a fall, is
 * worth the full 0.1. Selling before a fall protects 0.1. But holding a player
 * through a rise is worth far less than it looks: you only bank half of any
 * profit when you sell, rounded down, so a single 0.1 rise often returns
 * nothing at all.
 */
export function priceTimingHint(
  el: Pick<Element, "price_change_percent">,
  side: "in" | "out"
): string | null {
  const read = readPriceChange(el);
  if (!read || read.direction === 0) return null;
  /*
   * SAY "IF" WHEN IT IS AN IF.
   *
   * The hint fires from `NOTABLE` (85%), but `imminent` needs 100 — so between
   * the two the move is explicitly NOT expected tonight, and the copy stated
   * the 0.1 as fact anyway: "buy before 00:00 UK and he costs you 0.1 less."
   * A reader acting on that at 85% is being told the outcome of something the
   * read does not claim. The only hedge was the adverb "soon", buried inside a
   * sentence whose main clause was a promise.
   *
   * The two registers are now different sentences, not the same sentence with
   * one word swapped: at 100% the move is expected and the copy commits; below
   * it the copy says the move is approaching and what it WOULD be worth.
   */
  const soon = read.imminent;
  if (side === "in") {
    if (read.direction === 1) {
      return soon
        ? "Rising tonight — buy before 00:00 UK and he costs you 0.1 less."
        : "Rising soon — not expected tonight, but if it lands before you buy he costs 0.1 more.";
    }
    return soon
      ? "Falling tonight — waiting a day gets him 0.1 cheaper."
      : "Falling soon — not expected tonight, but waiting would get him 0.1 cheaper if it lands.";
  }
  if (read.direction === -1) {
    return soon
      ? "Falling tonight — sell before 00:00 UK to keep 0.1 of your team value."
      : "Falling soon — not expected tonight, but selling before it lands keeps 0.1 of your team value.";
  }
  return soon
    ? "Rising tonight — worth little to wait for: you bank only half of a profit, rounded down."
    : "Rising soon — worth little to wait for either way: you bank only half of a profit, rounded down.";
}
