/**
 * Small pure functions for numbers the UI puts on screen.
 *
 * WHY THIS FILE EXISTS. Every function here was previously an expression
 * inline in a component, and every one of them was WRONG in a case the
 * component could reach — a bench total that read zero in the only gameweek
 * anyone reads it, a gameweek delta differenced on a different convention from
 * the figure printed above it, an average difficulty of `0.0` for a club with
 * no fixture, a minus sign in front of a zero. None of that was reachable by a
 * test, because the arithmetic lived inside JSX and the project has no render
 * harness. Moving it here is the fix for the class, not just the four
 * instances: display arithmetic is arithmetic, and arithmetic belongs
 * somewhere it can be asserted against.
 */

/** One squad pick, reduced to what a points summary needs from it. */
export interface BenchRow {
  elementId: number;
  /** 1..15, FPL's pick order. 12..15 are the bench slots. */
  pickPosition: number;
  /** The player's own score for the gameweek, before any captain multiplier. */
  display: number;
}

/**
 * Points sitting on the bench.
 *
 * `effectiveXi` is the ELEVEN THAT ACTUALLY PLAYED — the starting eleven with
 * auto-substitutions applied. Membership of it is the question being asked;
 * "does this player's score count toward my total" is a DIFFERENT question,
 * and the two come apart under Bench Boost, where every one of the fifteen
 * counts. Keying the filter off "counts" therefore emptied it in exactly the
 * week a manager wants the number, and the header printed a confident
 * `Bench: 0 pts (Bench Boost active)`.
 *
 * A bench player promoted by an auto-sub is in the effective XI and so is not
 * counted here, which is the intent: this is what the bench contributed while
 * on the bench.
 */
export function benchPoints(rows: readonly BenchRow[], effectiveXi: ReadonlySet<number>): number {
  let total = 0;
  for (const r of rows) {
    if (r.pickPosition > 11 && !effectiveXi.has(r.elementId)) total += r.display;
  }
  return total;
}

/** A gameweek's entry in `history.current`, reduced to the scoring fields. */
export interface GwScore {
  points: number;
  event_transfers_cost: number;
}

/**
 * A gameweek's score as a manager reads it: after the cost of any hits.
 *
 * FPL's `history.current[].points` is GROSS and carries `event_transfers_cost`
 * alongside it, while the `entry` endpoint's `summary_event_points` is already
 * net. Mixing the two conventions in one card — a net headline with a gross
 * delta under it — overstated a −4 week by exactly four points and disagreed
 * with the gameweek time machine on the same screen.
 */
export function netGwPoints(r: GwScore): number {
  return r.points - r.event_transfers_cost;
}

/** Change in net gameweek score between two gameweeks, `later` minus `earlier`. */
export function netGwDelta(later: GwScore, earlier: GwScore): number {
  return netGwPoints(later) - netGwPoints(earlier);
}

/**
 * Mean fixture difficulty over a window, or null when there are no fixtures.
 *
 * NULL RATHER THAN A NUMBER, and that is the whole point. The obvious guard
 * against dividing by zero is `sum / Math.max(1, n)`, which does prevent the
 * NaN — by substituting zero, a value that is not merely wrong but wrong in
 * the direction that matters. Legal FDRs run 1..5, so zero sorts BELOW every
 * real fixture run, and a club playing nothing at all led a table captioned
 * "easiest first" while advertising `0.0` in the difficulty column. A missing
 * average has to stay missing; the caller decides where to put it.
 */
export function averageFdr(fdrs: readonly number[]): number | null {
  if (fdrs.length === 0) return null;
  let sum = 0;
  for (const f of fdrs) sum += f;
  return sum / fdrs.length;
}

/**
 * Sort key that puts "no fixtures" last however the list is ordered ascending.
 *
 * `Number.MAX_VALUE` rather than `Infinity` on purpose. Comparators are
 * routinely written as `a - b`, and `Infinity - Infinity` is `NaN`; two
 * fixtureless clubs would then hand `Array#sort` a `NaN`, which the spec
 * silently coerces to "equal" — fine here, a trap the moment this key is used
 * in a `reduce`, a `Math.min`, or a hand-rolled `< 0` comparison.
 * `MAX_VALUE - MAX_VALUE` is `0`, which is what "equally last" should mean.
 */
export function fdrSortKey(avg: number | null): number {
  return avg ?? Number.MAX_VALUE;
}

/** What `projectAutoSubs` returns, reduced to the ids the UI needs. */
export interface AutoSubIds {
  effectiveXi: readonly number[];
  in: readonly number[];
  out: readonly number[];
}

/** The eleven whose scores count, plus the arrows to draw for auto-subs. */
export interface AutoSubView {
  xi: ReadonlySet<number>;
  subbedIn: ReadonlySet<number>;
  subbedOut: ReadonlySet<number>;
}

/**
 * Reconcile projected auto-substitutions with the active chip.
 *
 * FPL MAKES NO SUBSTITUTIONS IN A BENCH BOOST WEEK. All fifteen play, so there
 * is no vacancy for anyone to fill. The auto-sub projection is computed from
 * picks and live minutes alone and has no way to know that, so left to itself
 * it happily "promotes" a bench player to cover a blanking starter — and every
 * consumer of that set then goes wrong in the same direction: the bench total
 * loses the promoted player's score, and the pitch draws in/out arrows for a
 * substitution that will never be processed.
 *
 * This is the seam where the chip is known, so this is where it gets applied.
 */
export function autoSubView(
  startingXi: readonly number[],
  autoSub: AutoSubIds | null,
  benchBoost: boolean
): AutoSubView {
  const none: ReadonlySet<number> = new Set<number>();
  if (benchBoost || !autoSub) {
    return { xi: new Set(startingXi), subbedIn: none, subbedOut: none };
  }
  return {
    xi: new Set(autoSub.effectiveXi),
    subbedIn: new Set(autoSub.in),
    subbedOut: new Set(autoSub.out),
  };
}

/**
 * The headline gameweek score, net of hits, whichever convention the feed uses.
 *
 * Two endpoints report the same number and the docs for neither are ours:
 * `entry.summary_event_points`, and `history.current[]`'s `points` alongside a
 * separate `event_transfers_cost`. The history pair is unambiguous — `points`
 * is gross, because a cost is carried next to it — but whether the `entry`
 * summary has already had that cost taken off is not something the payload
 * says, and this repo's own demo fixture and the delta underneath it had
 * drifted onto opposite assumptions.
 *
 * So do not assume: ASK THE DATA. If the summary equals the gross figure it is
 * gross and the cost comes off; otherwise it is already net (or is a live
 * value the history has not caught up with) and is passed through untouched.
 * When there is no hit the two branches agree, so the reconciliation only ever
 * moves a number in the weeks it is actually needed.
 */
export function netEventPoints(summary: number | null, row: GwScore | null): number | null {
  if (row == null) return summary;
  if (summary == null) return netGwPoints(row);
  return summary === row.points ? netGwPoints(row) : summary;
}

/**
 * A price movement, signed — with NO sign on zero.
 *
 * `diff > 0 ? "+" : "−"` reads as exhaustive and is not: zero falls into the
 * minus branch and an unmoved price rendered as `−£0.0m`, contradicting the
 * neutral styling the same cell applies to it.
 */
export function signedPrice(diffTenths: number | null, fmt: (v: number) => string): string {
  if (diffTenths == null) return "–";
  const sign = diffTenths > 0 ? "+" : diffTenths < 0 ? "−" : "";
  return `${sign}£${fmt(Math.abs(diffTenths))}m`;
}
