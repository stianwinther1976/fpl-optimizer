// What the rest of the field owns — and what that does, and does not, mean.
//
// This is the app's only model of its competition. Everything else in
// `src/lib` answers "how many points will this player score"; nothing answered
// "and will that move me past anybody", which is the question the game is
// actually scored on.
//
// ---------------------------------------------------------------------------
// THE MISTAKE THIS MODULE EXISTS TO NOT MAKE
// ---------------------------------------------------------------------------
//
// The obvious first move is to multiply every projection by `1 - EO` and
// re-run the optimiser on that. It is wrong, and it is worth being precise
// about why, because the result LOOKS like a smarter model and is in fact a
// different objective adopted by accident.
//
// Write your score as `S = sum over your XI of xp(p)`, and the field's as
// `F = sum over ALL players of xp(p) * EO(p)`. Your rank is driven by `S - F`.
// But `F` does not contain a single term you control: it is what two million
// other managers own, whatever you do. It is a CONSTANT with respect to your
// picks. So `argmax (S - F) = argmax S` — maximising expected points already
// maximises expected points-against-the-field, exactly, and any reweighting of
// `xp` by ownership is not a correction to that. It optimises something else.
//
// So what does ownership actually change? The VARIANCE of `S - F`, not its
// mean. Own what everyone owns and your score moves when theirs moves: your
// relative score is nearly deterministic and your rank is sticky, for better
// and for worse. Own players they do not and the same expected points arrive
// with spread around them, which is the only way a rank moves a long distance
// in either direction.
//
// That is why nothing here silently re-scores anybody. Ownership enters as
// INFORMATION — how much of your projected haul the field has already banked —
// and, where the user asks for it, as a stated appetite for that spread. It is
// not a better estimate of points, because it is not an estimate of points.
//
// ---------------------------------------------------------------------------
// WHAT THE OFFICIAL API WILL AND WILL NOT TELL US
// ---------------------------------------------------------------------------
//
// True effective ownership is `ownership + captaincy share`, because a captain
// scores twice. FPL publishes the first and not the second: `selected_by_percent`
// is on every element, but no public endpoint carries the distribution of
// armbands. `events[].most_captained` names the single most-captained player
// once a gameweek has finished, and that is the whole of it — an id, never a
// share.
//
// Every EO in this file is therefore a LOWER BOUND, and is named
// `ownership` rather than `eo` wherever that is what it is. The gap is not
// uniform either: it is almost exactly zero for the 600-odd players nobody
// captains, and largest for the handful at the top, which is precisely where
// the armband decision is made. Anything here that reads like a captaincy
// share is either measured from `most_captained` or absent.

import type { Bootstrap, Element, Event } from "./types";

/**
 * The share of the field owning a player, as a fraction in [0, 1].
 *
 * ABSTAIN, DO NOT DEMOTE — the same discipline as `ownershipPercentiles` in
 * `xp.ts`, and for the same reason. `parseFloat(...) || 0` turns a missing or
 * malformed field into a confident claim that nobody owns him, sourced from a
 * parse failure. `null` means "not published", and every consumer here handles
 * it by saying nothing rather than by inventing a differential.
 */
export function ownershipShare(el: Element): number | null {
  const n = parseFloat(el.selected_by_percent);
  if (!Number.isFinite(n)) return null;
  // FPL publishes a percentage; clamping guards a feed that has sent something
  // outside the range rather than silently propagating it into a `1 - own`.
  return Math.min(1, Math.max(0, n / 100));
}

/**
 * How a pick reads against the field.
 *
 * THESE CUTS ARE LABELS, NOT PARAMETERS. They decide which word appears on
 * screen and nothing else — no projection, no ordering and no recommendation
 * reads them. They are round numbers chosen to match how the game talks about
 * itself ("template", "differential"), and they have not been fitted to
 * anything, because there is no quantity here for them to be fitted TO. Do not
 * sweep them, and do not let a future change quietly promote them into the
 * objective.
 *
 * For scale, over the 2026/27 pre-season snapshot of 2026-08-07 (573 elements,
 * every one of them with a published ownership): 4 land in `template`, 24 in
 * `popular`, 45 in `mid` and 500 in `differential`. The long tail is the point —
 * most of the game is owned by almost nobody, which is why "differential" on its
 * own is a weak statement and the number beside it is the one that matters.
 */
export type TemplateClass = "template" | "popular" | "mid" | "differential";

export function templateClass(share: number): TemplateClass {
  if (share >= 0.4) return "template";
  if (share >= 0.15) return "popular";
  if (share >= 0.05) return "mid";
  return "differential";
}

export const TEMPLATE_LABEL: Record<TemplateClass, string> = {
  template: "Template",
  popular: "Popular",
  mid: "Mid-owned",
  differential: "Differential",
};

/**
 * A projection split into the part the field already has and the part it does
 * not.
 *
 * `shared` is the weight of your projected points that arrives for the field at
 * the same time it arrives for you — points that cannot move you past anyone,
 * however many of them there are. `differential` is the remainder: the only
 * part of the projection with any leverage on rank.
 *
 * Note what this is NOT. `differential` is not an expected gain — the field's
 * managers hold other players in the slots where they do not hold yours, and
 * those score too. It is a measure of EXPOSURE: how much of your week rides on
 * outcomes the field is not equally exposed to. Read it as spread, not as edge.
 */
export interface FieldSplit {
  total: number;
  shared: number;
  differential: number;
  /**
   * `differential / total`, or null when nothing is projected at all.
   *
   * DO NOT PUT THIS ON SCREEN AS A BARE PERCENTAGE. It has a floor a long way
   * above zero and reads as far bolder than it is. Ownership is spread across
   * the whole element list, so no legal XI can be mostly-shared: measured on
   * the 2026/27 pre-season snapshot of 2026-08-07 (573 elements, GW1 next), the
   * most-owned legal 3-4-3 in the game still comes out at 0.603, while the app's
   * own £100m launch XI sits at 0.783. The usable range is therefore roughly
   * [0.6, 1.0] and a reader shown "78% differential" with no floor will hear
   * something the number does not say.
   *
   * `differential` in POINTS is the honest headline, and it is what the UI
   * shows.
   */
  differentialShare: number | null;
  /** Players whose ownership FPL did not publish, and so are not counted. */
  unknown: number;
}

export function splitByField(
  players: { element: Element; xp: number }[]
): FieldSplit {
  /*
   * AN ABSTENTION MUST NOT READ AS MAXIMUM EXPOSURE.
   *
   * `differential` is `total - shared`, and a player whose ownership FPL did
   * not publish used to be added to `total` and then skipped past `shared` —
   * so his whole projection landed in `differential`, i.e. he was counted as
   * 100% differential. That is the loudest possible reading of "we do not
   * know", on the number the UI shows as its headline, and it contradicts
   * `FieldSplit.unknown`'s own doc, which says such players are not counted.
   *
   * They are now genuinely not counted: out of `total` as well as out of
   * `shared`, with `unknown` reporting how many were dropped so the caller can
   * say the split covers less than the whole squad.
   *
   * Not reachable on the 2026-08 snapshot — every element published an
   * ownership — which is why it never bit.
   */
  let total = 0;
  let shared = 0;
  let unknown = 0;
  for (const p of players) {
    const own = ownershipShare(p.element);
    if (own == null) {
      unknown++;
      continue;
    }
    total += p.xp;
    shared += p.xp * own;
  }
  const differential = total - shared;
  return {
    total,
    shared,
    differential,
    differentialShare: total > 0 ? differential / total : null,
    unknown,
  };
}

/**
 * The player the field captained most in a given finished gameweek, if FPL has
 * said so yet.
 *
 * The only hard fact about armbands the public API publishes. It is null until
 * FPL fills it in — pre-season that is every gameweek — so every caller has to
 * be able to say nothing.
 *
 * IT IS NOT GATED ON `finished`, and this doc used to say it was. FPL fills
 * `most_captained` in at the DEADLINE, not at bonus confirmation: the
 * 2026-08-21 snapshot publishes 411 for GW1 with `finished: false` and
 * `is_current: true`. That is the same `finished`-versus-actually-over mistake
 * this repo has now made four times, in a fourth place.
 */
export function templateCaptain(events: Event[], gw: number): number | null {
  const ev = events.find((e) => e.id === gw);
  return ev?.most_captained ?? null;
}

/**
 * The most recent gameweek FPL has published a most-captained player for.
 *
 * "PUBLISHED" IS THE WHOLE TEST, and this used to also require `finished`.
 * FPL fills the field in at the deadline, so through an entire in-progress
 * gameweek this returned null while `templateCaptain` on the same data returned
 * a player — the two disagreed, and `CaptainRead.wasTemplateCaptain` was false
 * for everyone for the whole week, which is exactly when a reader is looking at
 * it. Verified on the 2026-08-21 snapshot: GW1 carries `most_captained: 411`
 * with `finished: false`.
 *
 * Scanning by gameweek id rather than array position, because nothing promises
 * `events` is ordered and the old loop assumed it.
 */
export function lastTemplateCaptain(events: Event[]): { gw: number; element: number } | null {
  let best: { gw: number; element: number } | null = null;
  for (const e of events) {
    if (e.most_captained == null) continue;
    if (best == null || e.id > best.gw) best = { gw: e.id, element: e.most_captained };
  }
  return best;
}

/**
 * How the armband reads against the field.
 *
 * The captaincy decision is where ownership bites hardest and where the
 * published data is thinnest, so this reports the two things that are true
 * rather than estimating the one that would be convenient.
 */
export interface CaptainRead {
  element: Element;
  /** Projected points for the gameweek, before the armband doubles them. */
  xp: number;
  ownership: number | null;
  klass: TemplateClass | null;
  /**
   * Was this the field's most-captained player the last time FPL published one?
   *
   * Not a share — it names one player, not a percentage. And IT MAY WELL BE
   * THIS WEEK'S: FPL fills `most_captained` in at the deadline, not at bonus
   * confirmation, so from the moment a gameweek locks this is that gameweek's
   * answer. (It said "not this week's" while `lastTemplateCaptain` required
   * `finished`, which made the sentence true and the behaviour wrong — through
   * an in-progress gameweek nobody was marked at all.)
   *
   * Still the one hard statement about armbands the public API makes, and it
   * identifies the pick that moves nobody.
   */
  wasTemplateCaptain: boolean;
}

export function readCaptains(
  candidates: { element: Element; xp: number }[],
  bootstrap: Bootstrap
): CaptainRead[] {
  const last = lastTemplateCaptain(bootstrap.events);
  return candidates.map((c) => {
    const ownership = ownershipShare(c.element);
    return {
      element: c.element,
      xp: c.xp,
      ownership,
      klass: ownership == null ? null : templateClass(ownership),
      wasTemplateCaptain: last != null && last.element === c.element.id,
    };
  });
}

/**
 * Reorder a ranking to prefer the more differential pick, but only among picks
 * that are close enough in projected points to be a genuine choice.
 *
 * `tolerance` is IN POINTS and is the user's to set — "I will give up this much
 * expected return for a pick the field is not on". That unit is the whole
 * design. A dimensionless weight on ownership would be a model parameter, and
 * this repo does not ship those without a sweep; there is nothing here to
 * sweep, because the quantity being traded away is not an error to be
 * minimised but a preference about the spread of an outcome. Someone defending
 * a lead and someone chasing from 400k back want different numbers and both are
 * right.
 *
 * At `tolerance = 0` this is the identity, which is the default everywhere.
 * Ordering is otherwise by projected points exactly as before, so a pick can
 * only be promoted over another it is within `tolerance` of — never over one it
 * actually trails.
 */
export function preferDifferential<T extends { xp: number; element: Element }>(
  ranked: T[],
  tolerance: number
): T[] {
  if (tolerance <= 0 || ranked.length < 2) return ranked;
  const out = [...ranked].sort((a, b) => b.xp - a.xp);
  const best = out[0].xp;
  // Only the band within `tolerance` of the leader is reordered. Everything
  // below it keeps its points ordering: a differential three points worse is
  // not a bolder version of the same decision, it is a worse pick.
  const inBand = out.filter((r) => best - r.xp <= tolerance);
  const rest = out.filter((r) => best - r.xp > tolerance);
  /*
   * PARTITION, DO NOT MIX TWO ORDERINGS IN ONE COMPARATOR.
   *
   * This used to fall back to `b.xp - a.xp` whenever EITHER side had no
   * published ownership, which is not a total order: with A(9.5, unknown),
   * B(10, 0.9) and C(9, 0.1) you get C < B, A < C and B < A — a cycle, and
   * `Array#sort` is then free to return anything. The intent was right ("a
   * player we know nothing about keeps his points position"); expressing it
   * inside the comparator is what broke it.
   *
   * Splitting the band first says the same thing and is a valid ordering:
   * players with a published share are sorted by it, players without keep
   * their points ordering, and the known ones lead because a stated appetite
   * for spread is about players the field's holding of is actually known.
   */
  const known = inBand.filter((r) => ownershipShare(r.element) != null);
  const unknown = inBand.filter((r) => ownershipShare(r.element) == null);
  known.sort((a, b) => {
    const oa = ownershipShare(a.element)!;
    const ob = ownershipShare(b.element)!;
    return oa - ob || b.xp - a.xp;
  });
  unknown.sort((a, b) => b.xp - a.xp);
  return [...known, ...unknown, ...rest];
}
