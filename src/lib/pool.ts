// Which players are worth a per-player history lookup before drafting.

import type { Element } from "./types";

/**
 * Which players to pull last-season records for before drafting a launch squad.
 *
 * Price alone is the wrong filter here: a £100m squad is decided as much by
 * which £4.0m defender actually starts as by which premium forward to captain,
 * and the cheap end is exactly where "does he play at all?" is unknown. So the
 * pool interleaves several rankings per position, filling a fixed quota.
 *
 * Crucially, none of the rankings may depend on a field FPL wipes before GW1.
 * Ranking by the bootstrap's `starts` looked right in July and would have
 * degenerated into "the first N players by id" in August — silently, and
 * precisely when the feature matters most. Ownership and price movement survive
 * the reset, and they carry something no stored statistic does: five weeks of
 * managers reacting to pre-season friendlies and team news.
 *
 * That paragraph was written and then not acted on, so both of the things it
 * warned about were live in the shipped pool until they were measured. See the
 * variance filter and the tie-break below for the first. The second is the size
 * of the quota, and it turned out to matter more than anything the rankings do.
 *
 * A player outside the pool is projected with no record at all, which pins him
 * near the price prior — the guess the lookup exists to replace. The backtest
 * could not see this, because it handed last season's record to all ~690
 * players while the app fetched 210. Restricting it (`POOL=1`, see
 * `scripts/simulate.test.ts`) and sweeping the quota (`QUOTA=`, same file):
 *
 *   quota   launch-squad pts   managed   all    cheapR   topR
 *     210         6272           8805    .576    .510    .382
 *     315         6315           8805    .589    .527    .407
 *     420         6315           8805    .593    .533    .410
 *    none         6315           8805    .623    .577    .409
 *
 * THE `managed` COLUMN PREDATES `inSeasonPast` in `scripts/simulate.test.ts` and
 * has not been re-measured; run with `NO_PAST_INSEASON=1` to reproduce it. The
 * other four columns are unaffected — they are launch-time quantities, and the
 * launch drafter saw last season's record then and still does. The quota
 * conclusion rests on those four, so it stands as written.
 *
 * Read that table honestly and it does not say what picking 420 wants it to say.
 * Every point of the 43 is bought by 315, and so is .025 of the .028 of premium
 * ordering; 315 -> 420 is 105 more requests for .004 of `all`, which is inside
 * the run-to-run noise of the harness's ownership quantisation. 420 is kept
 * because the metric the extra breadth would show up in is the one the archive
 * cannot measure — a season where the drafter's 12th-choice defender is right —
 * and because the cost is paid in a progress bar rather than in points. It is a
 * judgement call, not a measurement, and the table is the honest record of it.
 *
 * Note also that the deltas come from THREE seasons, not four: the archive has
 * no 2021-22, so `loadPreviousSeason("2022-23")` returns undefined and that
 * season's launch squad is drafted with no record for anybody, identically at
 * every row above. Per contributing season the old quota cost about 14 points.
 *
 * The wait is the real cost. `Dashboard` is honest about it — it renders and
 * projects without the record and sharpens when it lands — but `OptimizePanel`
 * AWAITS the whole fetch before it shows a squad, so doubling the quota doubled
 * a blocking wait, from roughly 21 rounds of 10 to 40 — the note on
 * `LAUNCH_QUOTA` explains why it is 40 and not the 42 this used to say. A progress counter is not
 * the same thing as not blocking, and an earlier draft of this comment claimed
 * it was. The fix is two-pass: draft on a first tranche and keep fetching the
 * remainder in the background. That needs `pastSeasonStore` to merge rather than
 * replace, which it currently cannot.
 */
/**
 * Every player who could plausibly be looked at, by position. Sized from the
 * sweep in the doc comment above, not from a guess about squad shape: the old
 * set (16/70/80/44) was the shape of a realistic SQUAD, which is the wrong
 * thing to cover — the pool has to be big enough that the players the drafter
 * rejects were rejected on evidence rather than on a missing lookup.
 *
 * Exported and overridable so the sweep in the doc comment can be reproduced
 * without hand-editing this file, which is how the recorded numbers went stale
 * against the code once already.
 *
 * THE FORWARD QUOTA IS UNREACHABLE, AND THE POOL IS 396 RATHER THAN 420. There
 * are not 88 selectable forwards in the game: measured on both live snapshots,
 * 64 pre-season and 64 with a gameweek played, out of 71 and 72 in the game at
 * all. `Math.min(quota[pos], inPos.length)` therefore caps at 64 and every
 * forward who can be picked is already in — the four interleaved rankings do
 * nothing at that position. Picked per position, both snapshots:
 * `{GK 32, DEF 140, MID 160, FWD 64}`.
 *
 * That does not change the judgement above, which was about breadth in defence
 * and midfield and is unaffected. What it does mean is that the sweep's "420"
 * row and the "315 -> 420 is 105 more requests" arithmetic describe a pool size
 * the real feed cannot produce, and that the true blocking wait is 40 rounds of
 * ten rather than 42. Left at 88 deliberately: it is a ceiling, FPL's forward
 * count moves between windows, and lowering it to today's 64 would be fitting
 * the constant to one afternoon's squad lists.
 */
export const LAUNCH_QUOTA: Record<number, number> = { 1: 32, 2: 140, 3: 160, 4: 88 };

export function launchPool(all: Element[], quota: Record<number, number> = LAUNCH_QUOTA): number[] {
  // `u` is "left the league", `n` is "not in the squad" — neither can be picked,
  // so a lookup is wasted. Everything else stays, deliberately: a doubtful or
  // injured player is exactly the case where last season's record decides
  // whether his understudy is worth a punt, and dropping him would leave that
  // decision to the price prior.
  const alive = all.filter(
    (e) => e.element_type >= 1 && e.element_type <= 4 && e.status !== "u" && e.status !== "n"
  );
  const rankings: ((e: (typeof alive)[number]) => number)[] = [
    (e) => e.now_cost,
    (e) => parseFloat(e.selected_by_percent) || 0,
    (e) => e.starts ?? 0,
    (e) => e.cost_change_start ?? 0,
  ];
  const ids = new Set<number>();
  for (const pos of [1, 2, 3, 4]) {
    const inPos = alive.filter((e) => e.element_type === pos);
    // Drop any ranking that has no variance before it is given slots.
    //
    // The comment above worried about exactly this and then did not act on it.
    // In August FPL has wiped `starts` to 0 for all 700 players, and prices are
    // frozen until after the GW1 deadline so `cost_change_start` is 0 too. A
    // comparator that returns 0 for every pair leaves a stable sort in its
    // original order, so those two rankings did not "cost coverage" as the
    // round-robin comment claims — they kept their quarter of the quota each
    // and filled it with the lowest player ids. Half the pool was arbitrary.
    //
    // Measured on the archive at the old quota of 210, with real GW1 ownership
    // wired into the harness, counting how many of a season's 150 highest
    // scorers were left with no record at all:
    //
    //              2023-24   2024-25   2025-26
    //   old split     83        81        89
    //   variance      50        50        53
    //
    // and in the top fifty, 22/22/27 down to 7/10/16. A well-owned starter like
    // Munoz — 3.9% at the GW1 deadline, and the 142-point return that followed —
    // stops being missed outright.
    const live = rankings.filter((r) => {
      let min = Infinity;
      let max = -Infinity;
      for (const e of inPos) {
        const v = r(e);
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return max > min;
    });
    // `now_cost` always varies, so this is belt and braces rather than a real path.
    const active = live.length > 0 ? live : rankings.slice(0, 1);
    // Break ties on ownership, then price — never on player id DIRECTLY.
    //
    // THE RESIDUAL IS STILL CLUB ORDER, and saying so is the honest version of
    // that first line. Three keys resolve a tie and when all three are equal
    // `Array#sort` stability leaves the input order, which is `bootstrap.elements`
    // — FPL serves that grouped by club ascending. Measured: reversing the input
    // array changes 11 of the 396 picks on both live snapshots, and over the tie
    // blocks that straddle the pool boundary the picked side has a mean club id
    // of 8.2 against 15.4 rejected. So the alphabetically-early clubs still win
    // the last few slots, exactly as the paragraphs below describe for the
    // pre-tie-break state.
    //
    // Not fixed here, because every remaining fix is worse: a hash of the id is
    // arbitrary dressed as fair, and a fourth real key would have to be a
    // ranking, which is what the tie says there is no evidence for. What the
    // tie-break did buy is that the residual is now reached only by players
    // equal on ownership AND price, rather than by a whole flat ranking.
    //
    // The variance filter above only catches a ranking that is PERFECTLY flat,
    // and that is the pre-season state, not the general one. Mid-season the two
    // reset-prone rankings are near-flat rather than flat, which is worse:
    // one player moves and `max > min` resurrects the whole ranking, which then
    // fills its share out of a tie block that a stable sort leaves in id order.
    // Measured at GW2 of 2023-24, 68 of the 140 defender slots and 78 of the 160
    // midfield slots were resolved inside a tie block — every one of `starts`'s
    // picks sat at `starts = 1`. FPL ids are grouped by club, so that is not even
    // an unbiased sample; it is the alphabetically-early clubs.
    //
    // Ownership has the same disease at the other end. FPL publishes it to one
    // decimal, so at GW1 a position has about fifty distinct values across ~280
    // players and over a third of them are tied at exactly "0.0" — precisely the
    // cheap tail this pool exists to cover. The ownership ranking passes the
    // variance test on the strength of its top end and then hands its last few
    // slots out by id.
    //
    // A tie-break makes both harmless: a ranking that has gone flat now degrades
    // into "by ownership, then price" rather than into noise, which is a bad
    // ranking instead of an arbitrary one. The variance filter stays, because a
    // fully flat ranking degrades into an exact DUPLICATE of another live one and
    // would then draw a second share of the quota for it.
    //
    // What this did NOT do is move any outcome number, and that belongs here
    // rather than in a commit message nobody reads. At the shipped quota the
    // launch squad still scores 6315 and the correlations sit at .593/.533/.410
    // against .594/.535/.409 without it — noise, in both directions. At the old
    // 210 it is a small real gain (missed top-150 scorers 50/50/53 -> 48/48/51),
    // which is the tell: at 420 the pool is already past the point where picking
    // better inside it changes what the drafter buys. It ships because the state
    // it actually repairs is mid-season, and the harness only ever calls
    // `launchPool` at GW1, so the 68-of-140 defender result above is a defect no
    // outcome metric in this repo can see. Neutral where measurable, correct
    // where it is not.
    const sorted = active.map((r) =>
      [...inPos].sort(
        (a, b) =>
          r(b) - r(a) ||
          (parseFloat(b.selected_by_percent) || 0) - (parseFloat(a.selected_by_percent) || 0) ||
          b.now_cost - a.now_cost
      )
    );
    // Round-robin so the quota is met exactly, whatever the overlap between
    // rankings.
    const cursor = new Array(sorted.length).fill(0);
    const target = Math.min(quota[pos], inPos.length);
    let picked = 0;
    while (picked < target) {
      let advanced = false;
      for (let r = 0; r < sorted.length && picked < target; r++) {
        while (cursor[r] < sorted[r].length && ids.has(sorted[r][cursor[r]].id)) cursor[r]++;
        if (cursor[r] >= sorted[r].length) continue;
        ids.add(sorted[r][cursor[r]++].id);
        picked++;
        advanced = true;
      }
      if (!advanced) break;
    }
  }
  return [...ids];
}

