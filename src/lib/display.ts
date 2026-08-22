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
 * A gameweek row's team value in tenths, as FPL means the phrase.
 *
 * `entry_history.value` ALREADY INCLUDES the bank. That is why every manager's
 * team value is exactly 1000 after GW1 however much they left unspent: the game
 * defines team value as squad plus bank, not squad alone. Adding `bank` on top
 * of it — which the KPI history table and the month-over-month delta both did —
 * counted the bank twice, so a card reading "£115.4m (£113.9m squad + £1.5m
 * bank)" opened into a table claiming £116.9m for the very same gameweek.
 *
 * The squad-derived side of the app must therefore compare against this, not
 * against `value + bank`: `Σ sellPrice + bank === value`.
 */
export function teamValue(r: { value: number; bank: number }): number {
  return r.value;
}

/**
 * Change in team value between two gameweeks, `later` minus `earlier`.
 *
 * Here rather than open-coded in the card for the same reason `netGwDelta` is:
 * a difference of two `teamValue` calls is still display arithmetic, and while
 * it lived inside JSX its SIGN was unassertable. That matters more than it
 * looks — the card renders `good: diff > 0` and `direction: diff >= 0`, so an
 * inverted subtraction would paint a squad that had lost £2m green and
 * upward-pointing, which is exactly the sort of wrong a reader trusts.
 */
export function valueDelta(
  later: { value: number; bank: number },
  earlier: { value: number; bank: number }
): number {
  return teamValue(later) - teamValue(earlier);
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

/**
 * How much a live score is worth saying loudly: "blank", "played" or "returned".
 *
 * WHAT THIS REPLACES, AND WHY IT WAS BACKWARDS.
 * Every live score used to be painted accent green while the gameweek was
 * unfinished and plain once it finished — so the colour tracked THE CLOCK, and
 * a nought and a fifteen were rendered identically. On a fifteen-man list where
 * most rows are 0 before kick-off, that is every row shouting at once, which is
 * the same as none of them shouting. The reader's actual question is "who has
 * done something", and the number already knows.
 *
 * THE BOUNDARIES ARE FPL'S, NOT MINE. Both come off the scoring rules rather
 * than out of a fitted scale, which matters because there is nothing here to
 * fit and no data to fit it on:
 *
 *   below 0  something went wrong. A score can only go under zero through a
 *            card, an own goal, a missed penalty or goals conceded, so this is
 *            never "nothing happened" — it is the row most worth seeing, and an
 *            earlier version of this function folded it in with 0 and hid it.
 *   0        nothing has happened. Not on the pitch, or on and yet to touch it.
 *   1-2      appearance only: 1 point for playing, 2 from 60 minutes. Present,
 *            nothing returned.
 *   3+       a return. Three is the smallest scoring event in the game — an
 *            assist — with a clean sheet at 4 for a defender or keeper and a
 *            goal at 4 to 6.
 *
 * A fourth tier for a haul was considered and left out on purpose: there is no
 * rule that says where a haul starts, so the boundary would be invented, and
 * `CLAUDE.md`'s standing rule is not to ship a constant nobody has measured.
 * Measuring one means a distribution of per-player gameweek scores, which is an
 * archived-season question — `.github/workflows/measure.yml` is the path. Until
 * then the emphasis of a 15 comes from the digits, not from a third colour.
 *
 * Note the deliberate silence about whether the score is final. Live-or-final
 * is a fact about the gameweek, not about the player, and it is already stated
 * once per screen beside the total; spending the per-row colour on it is what
 * caused this.
 */
export type ScoreTier = "negative" | "blank" | "played" | "returned";

/** The smallest single scoring event in FPL: an assist. */
export const RETURN_THRESHOLD = 3;

export function scoreTier(points: number): ScoreTier {
  // A non-finite score is a bug upstream, not a return: say nothing loudly.
  if (!Number.isFinite(points)) return "blank";
  if (points < 0) return "negative";
  if (points === 0) return "blank";
  return points >= RETURN_THRESHOLD ? "returned" : "played";
}

/**
 * A fixture's kickoff as the reader should see it.
 *
 * FPL publishes a PLACEHOLDER `kickoff_time` for a fixture awaiting
 * rescheduling and flags it with `provisional_start_time`. Both places that
 * render a kickoff printed the placeholder as a settled time — "Sat 15:00" for
 * a match nobody has scheduled — because the type did not carry the flag, so
 * nobody knew to look. A provisional time is marked, not hidden: the date is
 * still the best guide there is, it just is not a promise.
 */
export function kickoffLabel(
  f: { kickoff_time: string | null; provisional_start_time?: boolean },
  fmt: (iso: string) => string
): string {
  if (!f.kickoff_time) return "TBC";
  const when = fmt(f.kickoff_time);
  return f.provisional_start_time ? `${when} (TBC)` : when;
}

/**
 * Where a player sits on the bench once auto-substitutions have been applied.
 *
 * After a sub the bench is "everyone not in the effective eleven", and that set
 * contains the STARTER WHO CAME OFF as well as the three subs who never came
 * on. Sorted by FPL's pick order he lands at the front — pick position 3 sorts
 * ahead of bench slot 12 — so the card captioned "Bench (in order)" opened with
 * the player who had just been substituted OUT, badged "1" as if he were the
 * next man on. He is not in the queue at all.
 *
 * So: the bench proper keeps FPL's order, and anyone who came off the eleven
 * goes after all of it. `Number.MAX_SAFE_INTEGER` is not needed — a demoted
 * starter's pick position is at most 11 and a bench slot at least 12 — but
 * adding a constant keeps demoted starters in pick order among themselves,
 * which matters under Bench Boost's zero subs only in that it never fires.
 */
export function benchSortKey(pickPosition: number): number {
  return pickPosition > 11 ? pickPosition : pickPosition + 100;
}

/**
 * The sub-priority badge for a bench card: `null` for a demoted starter.
 *
 * Returned rather than folded into `benchSortKey` because `Pitch` treats
 * `undefined` as "number it by list position" and `null` as "no number at all",
 * and those are genuinely different answers. Only the second case is a claim
 * this function is qualified to make.
 */
export function benchBadgeFor(pickPosition: number): number | null | undefined {
  return pickPosition > 11 ? undefined : null;
}



/**
 * The bench figure to print beside a finished gameweek.
 *
 * FPL REPORTS `points_on_bench` AS ZERO IN A BENCH BOOST WEEK, because none of
 * those points sat on the bench — they counted. Printed literally, the caption
 * read `GW15: 61 pts · bench 0 pts` directly beneath four bench cards showing
 * 8, 10, 2 and 1. Worse, the zero is the one number that would let a reader
 * reconcile the corner with the eleven cards above it: the XI summed to 40, the
 * bench to 21, and the corner said 61.
 *
 * So in a Bench Boost week the figure comes from the cards on screen and is
 * labelled as having counted. Every other week `points_on_bench` is exactly
 * right and is used unchanged — FPL's own number, not a re-derivation of it.
 */
export function benchSummary(
  reported: number,
  cards: readonly { points: number }[],
  benchBoost: boolean
): string {
  if (!benchBoost) return `bench ${reported} pts`;
  let total = 0;
  for (const c of cards) total += c.points;
  return `bench ${total} pts (counted — Bench Boost)`;
}

/**
 * The captain's xP as a pitch card should print it.
 *
 * `${(xp * 2).toFixed(1)} xp ×2` was rendering the ALREADY-DOUBLED figure with
 * a "×2" after it, so a 6.5 xp captain read `13.0 xp ×2` — which a reader
 * multiplies to 26 — while the captaincy list on the very same panel showed him
 * at 6.5. Writing the multiplier in front states both quantities and leaves
 * nothing to multiply twice.
 */
export function captainXpLabel(xp: number, isCaptain: boolean, multiplier = 2): string {
  return isCaptain ? `${multiplier}×${xp.toFixed(1)} xp` : `${xp.toFixed(1)} xp`;
}

/**
 * The sentence under the live pitch, when a hit makes the corner disagree with
 * the cards above it.
 *
 * The corner total is NET of the gameweek's transfer cost and the player cards
 * are not, so a −4 week put 48 in the corner over eleven cards summing to 52
 * with nothing on the tab to explain the gap — the word "hit" appeared nowhere
 * on it. The historic view of the same pitch already discloses this, and so
 * does the Live tab; only the live Team pitch did not.
 */
export function liveCornerNote(gross: number, hit: number): string | null {
  if (hit <= 0) return null;
  return `The eleven on the pitch have scored ${gross}; the corner shows ${gross - hit} after a −${hit} hit.`;
}

/**
 * FPL's own average score for a gameweek — or null while it has not published
 * one.
 *
 * ZERO MEANS "NOT PUBLISHED", AND WAS BEING PRINTED AS A SCORE. FPL leaves
 * `average_entry_score` at 0 until a gameweek's scores are in; it does not
 * track it live. Measured on the 2026-08-21 snapshot, taken with GW1 current
 * and its opening fixture fully played — 90 minutes, `finished_provisional`,
 * real points awarded to nine million squads — `average_entry_score` was still
 * exactly 0.
 *
 * Three screens read it and all three took the 0 at face value:
 *
 *  - The Live tab printed "GW average: 0 pts (+34)" beside a live total,
 *    which is the tab's headline comparison and it was against nothing.
 *  - Its safety score falls back to the average when the rank-band sample is
 *    unavailable, so it told a reader they needed 0 points to hold their rank
 *    and were "on course to climb".
 *  - The season chart plots the average as a line, so mid-season it ran along
 *    at fifty and then dropped to the axis on the gameweek in progress —
 *    exactly the point the reader is looking at, on the chart whose whole job
 *    is "did I beat the average".
 *
 * `> 0` is the whole test and needs no second field: an average of exactly
 * zero is impossible for a gameweek in which any football has been played, so
 * "published" and "positive" are the same question. It also stays right for a
 * gameweek that has not kicked off, where 0 is true and useless.
 */
export function publishedAverage(
  ev: { average_entry_score: number } | null | undefined
): number | null {
  const v = ev?.average_entry_score;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}


/**
 * A kick-off that has come and gone while FPL still says the match has not
 * started.
 *
 * WHY THE READER NEEDS THIS SPELLED OUT. The fixture card shows a score and a
 * clock once `started` is true, and the kick-off time before that. There is a
 * third state and it looked identical to the second: the match is under way on
 * television and FPL has not flipped the flag yet. A card reading "HUL v MUN /
 * Sat 13:30" two minutes after the whistle is indistinguishable from an app
 * that has stopped fetching, and the reader's reasonable conclusion — "live
 * doesn't work" — is one the screen gives them no way to check.
 *
 * So the card says which it is. It is not a guess about the match: it is the
 * arithmetic the reader is already doing, stated by the app instead of left to
 * them.
 *
 * The grace period exists because FPL is routinely a minute or so behind the
 * whistle, and a card that flips to "awaiting" on the stroke of kick-off would
 * cry wolf at every match. `provisional_start_time` is excluded outright — a
 * time FPL has itself marked TBC is not a time to measure lateness against.
 */
export function kickOffPassed(
  f: {
    kickoff_time: string | null;
    started?: boolean;
    provisional_start_time?: boolean;
  },
  now: number,
  graceMs = 60_000
): boolean {
  if (f.started || !f.kickoff_time || f.provisional_start_time) return false;
  const at = Date.parse(f.kickoff_time);
  if (!Number.isFinite(at)) return false;
  return now - at > graceMs;
}

/**
 * How old the numbers on screen are, in whole minutes, or null while current.
 *
 * `updatedAt` advances only on a SUCCESSFUL refresh, so this is the age of the
 * data and not the age of the last attempt — which is the distinction the Live
 * tab had no way to draw. A reader watched a match reach the hour mark with
 * the card still reading 2', beside a stamp that said "Updated" with the
 * current time and "Auto-refresh every 30s". Every one of those was true about
 * the REQUEST and none of them was true about the DATA.
 *
 * The threshold is two and a half poll intervals: one missed poll is a dropped
 * packet, three in a row is a feed that has stopped answering, and only the
 * second is worth telling anyone about.
 *
 * Whole minutes, floored, so it never claims precision it does not have — and
 * it is deliberately allowed to read "0 min" for the window between the
 * threshold and sixty seconds, because "0 min old" alongside a visible warning
 * still says the right thing: not moving.
 */
export function liveStaleMinutes(
  updatedAt: Date | null,
  now: number,
  pollMs: number
): number | null {
  if (!updatedAt) return null;
  const age = now - updatedAt.getTime();
  if (!Number.isFinite(age) || age < pollMs * 2.5) return null;
  return Math.floor(age / 60_000);
}

/**
 * A manager's overall total DURING a gameweek in play, built from the live
 * score rather than from FPL's stored summary.
 *
 * WHY THE TWO DISAGREE ON ONE SCREEN, which is the thing this fixes. The
 * header's "Total points" reads `entry.summary_overall_points` — FPL's stored
 * cumulative figure, which they refresh on their own schedule during a live
 * gameweek and which never carries provisional bonus. The Live tab computes
 * from `event/{gw}/live/`, which is about ninety seconds fresh and does. So
 * the app showed 3 and 7 for the same quantity, at the same moment, two
 * headings apart, and both were "right" about different sources.
 *
 * The cumulative half comes from the LAST COMPLETED gameweek, never from the
 * current row. `history.current[].total_points` for a gameweek in play already
 * holds FPL's partial live figure, so adding the live score to it would count
 * the same points twice — at GW1, where no earlier row exists at all, that
 * would have doubled the whole total.
 *
 * `total_points` is cumulative NET, and `liveNet` is expected net of its own
 * hit (which is what `liveEntryScore` returns), so the two compose directly.
 */
export function liveOverallPoints(
  rows: { event: number; total_points: number }[],
  currentEvent: number,
  liveNet: number
): number {
  let before = 0;
  let bestEvent = -Infinity;
  for (const r of rows) {
    if (r.event >= currentEvent) continue;
    if (r.event > bestEvent) {
      bestEvent = r.event;
      before = r.total_points;
    }
  }
  return before + liveNet;
}

/**
 * A rival's overall total DURING a live gameweek, from the live score.
 *
 * The league table had the same split the dashboard header did: the "GW"
 * column printed the live figure while "Total" printed `total` straight from
 * the standings — FPL's stored cumulative, refreshed on their schedule. In
 * GW1, where the two are by definition the same number, the table showed 7
 * beside 3.
 *
 * `total - eventTotal` is the total BEFORE this gameweek, and it is sound even
 * when the standings payload is stale, because both halves come from the same
 * snapshot: whatever partial figure FPL had for the gameweek is in `total` and
 * in `eventTotal` alike, and subtracting removes exactly it. That is a
 * stronger guarantee than the dashboard's version has, which is why this does
 * not go looking through history rows.
 *
 * Both `total` and `eventTotal` are NET of transfer costs, as is the score
 * `liveEntryScore` returns, so the three compose directly.
 */
export function liveLeagueTotal(total: number, eventTotal: number, liveNet: number): number {
  return total - eventTotal + liveNet;
}
