// FPL's Price Change Predictor (new for 2026/27).
//
// `price_change_percent` is how far a player has travelled toward his next price
// change, signed: positive climbs toward a rise, negative toward a fall. Past
// ±100% the change is expected at the next update, which happens at 00:00 UK
// time and can move a player by at most 0.1 per day.
//
// FPL's own page also shows a "predicted progress" that extrapolates to the
// deadline, and THE API PUBLISHES IT — this comment used to say it did not, and
// used that as the reason for the design. It is the fourth instance of the
// pattern CLAUDE.md's "the lesson those two cost" is written about, and the
// first where the wrong belief was stated in prose as a justification. Every
// element on both live snapshots carries:
//
//   price_change_projections   [{offset: 0|1|2, projected_percent, likelihood}]
//   price_change_hourly_rate
//   price_change_locked_until
//   price_change_calibrating
//
// `likelihood` is exactly the confidence the hand-picked `NOTABLE` / `imminent`
// thresholds below are approximating; `locked_until` would suppress "buy before
// 00:00 UK" on a locked price, and `calibrating` would suppress it on a
// percentage FPL says it does not yet trust.
//
// NONE OF IT IS USED, AND THAT IS DELIBERATE FOR NOW. Counted on the
// 2026-08-19 and 2026-08-21 snapshots, all 600 elements: `price_change_percent`
// is the string "0", `hourly_rate` 0, `locked_until` null, `calibrating` false,
// and all three projection rows `{projected_percent: "0", likelihood: 0}` —
// because FPL freezes prices until after the GW1 deadline. So the whole
// predictor has never been observed firing on real data; it has only ever been
// exercised on the demo, which generates its own values. That is the same
// epistemic position as `buildStrengths.usable`, and building thresholds on
// fields whose live behaviour nobody has seen is exactly the mistake CLAUDE.md
// convention 3 is about. Take a snapshot with prices moving and look first.
// The fields are modelled in `types.ts` so the next person can see them.

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
 *
 * A FLAT ZERO IS MISSING DATA, AND WAS BEING READ AS A FORECAST. `PlayerModal`
 * says in so many words that "silence is honest, 'unlikely to change' on
 * missing data isn't" — and then rendered "Price change — Unlikely to change ·
 * Hasn't moved toward either" for every player in the game, because FPL sends
 * the string "0" while the predictor is switched off rather than omitting the
 * field. Counted on both live snapshots: 595/595 and 600/600 players returned
 * `steady`, zero nulls, every one of them also carrying
 * `price_change_hourly_rate: 0`.
 *
 * Zero progress AND zero rate is the honest "nothing to say" state: it is what
 * a stopped predictor looks like, and it is also what a player who has just
 * changed price looks like, for whom "unlikely to change" is equally wrong. A
 * player the predictor is actually tracking has a non-zero one or the other.
 * `hourly_rate` absent is treated as zero, which errs toward silence — the
 * direction this block's own comment asks for.
 */
export function readPriceChange(
  el: Pick<Element, "price_change_percent" | "price_change_hourly_rate">
): PriceChangeRead | null {
  /*
   * `price_change_hourly_rate` IS TYPED AS A NUMBER AND HAS ONLY EVER BEEN SEEN
   * AS ZERO. Both snapshots are pre-season, so nothing establishes its
   * in-season shape — and FPL ships `price_change_percent` as a STRING, so a
   * string here would make `rate === 0` never match and silently restore the
   * "speak for all 600" behaviour. This repo is three for three on unmodelled
   * field shapes, so the read is coerced rather than trusted.
   */
  const raw = el.price_change_percent;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const rate = Number(el.price_change_hourly_rate ?? 0);
  if (n === 0 && (!Number.isFinite(rate) || rate === 0)) return null;
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
