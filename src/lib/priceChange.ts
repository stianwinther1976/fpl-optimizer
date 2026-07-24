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
  const when = read.imminent ? "tonight" : "soon";
  if (side === "in") {
    return read.direction === 1
      ? `Rising ${when} — buy before 00:00 UK and he costs you 0.1 less.`
      : `Falling ${when} — waiting a day gets him 0.1 cheaper.`;
  }
  return read.direction === -1
    ? `Falling ${when} — sell before 00:00 UK to keep 0.1 of your team value.`
    : `Rising ${when} — worth little to wait for: you bank only half of a profit, rounded down.`;
}
