// Which players get a history lookup before the launch draft.
//
// This is the cheapest place in the app to lose a lot of accuracy, because
// failure is silent: a player left out of the pool is not flagged anywhere, he
// simply gets projected from his price and quietly ranks like every other
// player at that price. The tests below pin the properties that stop that
// happening — the pool must not be filled by an ordering that carries no
// information, it must stay honest when a ranking is nearly rather than exactly
// flat, and it must be big enough that the drafter's rejections are rejections
// rather than omissions.

import { describe, expect, it } from "vitest";
import { launchPool } from "../pool";
import type { Element } from "../types";

/**
 * A bootstrap, grouped by position so that id order runs OPPOSITE to quality.
 *
 * That opposition is deliberate and is the whole point of the fixture: a pool
 * filled by id picks the wrong end of the game, and a fixture where id happens
 * to agree with price cannot tell the two apart. (It did not, at first — the
 * mutation that removes the variance filter survived until this was turned
 * round.) It is NOT what the real bootstrap looks like — that one is grouped by
 * club, so position cycles with id and an id-order fill gives a merely
 * arbitrary selection rather than the worst one. The exaggeration is what makes
 * the failure legible; `positionOf` below does not depend on it.
 *
 * `own` overrides ownership per index, for the realistic case: FPL publishes it
 * to one decimal, so most of a position sits in a huge tie block near zero.
 */
function preseason(
  count: number,
  opts?: {
    chg?: (i: number) => number;
    starts?: (i: number) => number;
    own?: (i: number) => number;
    status?: (i: number) => string;
    flatPrice?: boolean;
  }
): Element[] {
  const out: Element[] = [];
  let id = 1;
  for (const pos of [1, 2, 3, 4] as const) {
    for (let i = 0; i < count; i++) {
      out.push({
        id: id++,
        web_name: `P${pos}_${i}`,
        team: (i % 20) + 1,
        element_type: pos,
        now_cost: opts?.flatPrice ? 40 : 40 + i,
        selected_by_percent: (opts?.own ? opts.own(i) : i / 10).toFixed(1),
        cost_change_start: opts?.chg ? opts.chg(i) : 0,
        starts: opts?.starts ? opts.starts(i) : 0,
        status: opts?.status ? opts.status(i) : "a",
        minutes: 0,
        total_points: 0,
        form: "0.0",
        points_per_game: "0.0",
      } as unknown as Element);
    }
  }
  return out;
}

/** Position from the fixture itself, not from arithmetic on the id. */
function positionOf(all: Element[]): Map<number, number> {
  return new Map(all.map((e) => [e.id, e.element_type]));
}

function countByPos(all: Element[], picked: number[]): Map<number, number> {
  const pos = positionOf(all);
  const out = new Map<number, number>();
  for (const id of picked) {
    const p = pos.get(id)!;
    out.set(p, (out.get(p) ?? 0) + 1);
  }
  return out;
}

describe("launchPool", () => {
  it("does not spend half the quota on player id order", () => {
    // In August `starts` and `cost_change_start` are zero for everyone: FPL has
    // wiped the counters and prices are frozen until after the GW1 deadline. A
    // comparator that returns 0 for every pair leaves a stable sort untouched,
    // so those two rankings used to hand their quarter of the quota each to
    // whoever happened to hold the lowest ids.
    const all = preseason(300);
    const picked = new Set(launchPool(all));
    const mids = all.filter((e) => e.element_type === 3);
    // The 160 midfielders the pool wants are the 160 best by price/ownership,
    // which here are the LAST 160 in id order.
    const wanted = mids.slice(-160).filter((e) => picked.has(e.id)).length;
    // Measured 160/160. With the flat rankings still taking slots it is 80 —
    // the other 80 go to the cheapest, least-owned midfielders in the game
    // purely because their ids sort first.
    expect(wanted).toBe(160);
  });

  it("does not fill a near-flat ranking's share by id either", () => {
    // The variance filter only catches a PERFECTLY flat ranking, and that is the
    // pre-season state, not the general one. This is GW2: `starts` is 1 for the
    // players who started and 0 for everyone else, and exactly one price has
    // moved all season. Both rankings now pass `max > min` and claim a full
    // share, which they must resolve almost entirely inside a tie block — and a
    // stable sort leaves a tie block in id order.
    //
    // Measured on the archive before the tie-break: 68 of 140 defender slots and
    // 78 of 160 midfield slots at GW2 of 2023-24 were resolved this way. FPL ids
    // are grouped by club, so those are the alphabetically-early clubs.
    const all = preseason(300, {
      starts: (i) => (i < 150 ? 1 : 0),
      chg: (i) => (i === 299 ? 1 : 0),
    });
    const picked = new Set(launchPool(all));
    const mids = all.filter((e) => e.element_type === 3);
    // The assertion here was first written as "all 160 of the dearest are in",
    // and it failed at 130 — correctly. `starts` is a live ranking that genuinely
    // prefers the 150 who played, and this fixture makes those the cheap half, so
    // a working `starts` share SHOULD reach down. Asserting it does not would
    // have pinned the ranking as broken. What matters is not which band the
    // near-flat rankings reach into but where inside it they land: on the best of
    // the tie block, or on the lowest ids in it.
    const dearest = mids.slice(-40);
    expect(dearest.filter((e) => picked.has(e.id)).length).toBe(40);
    // `starts` ties 150 players at 1 and takes 40 of them; broken by ownership
    // then price that is the top 40 OF THAT BLOCK, so nothing below index 110 is
    // ever reached. Broken by id it is the bottom 40 of the game, and the 100
    // cheapest, least-owned midfielders alive turn up in the pool.
    const worst = mids.slice(0, 100);
    expect(worst.filter((e) => picked.has(e.id)).length).toBe(0);
  });

  it("keeps the sub-1% tail in ownership order, not id order", () => {
    // FPL publishes ownership to one decimal. At GW1 a real position has about
    // fifty distinct values across ~280 players, with over a third tied at
    // exactly "0.0" — and that dense tail is precisely the cheap band the pool
    // exists to cover. The ownership ranking passes the variance test on the
    // strength of its top end and then hands its last slots out arbitrarily.
    //
    // Here every midfielder is under 1% and 200 of the 300 read "0.0". Price is
    // flat so ownership is the only live ranking and has to carry the position
    // alone.
    const all = preseason(300, {
      flatPrice: true,
      own: (i) => (i < 200 ? 0 : (i - 199) / 10),
    });
    const picked = new Set(launchPool(all));
    const mids = all.filter((e) => e.element_type === 3);
    // Everyone at 0.5% or better must be in; there are 95 of them and 160 slots,
    // so there is no excuse. `parseInt` in place of `parseFloat` collapses this
    // whole band to a tie and fails here.
    const owned = mids.filter((e) => parseFloat(e.selected_by_percent) >= 0.5);
    expect(owned.length).toBeGreaterThan(50);
    expect(owned.every((e) => picked.has(e.id))).toBe(true);
  });

  it("still interleaves rankings that do carry information", () => {
    // The variance filter must not turn into "price only". Give ownership an
    // order of its own and it has to keep its share: a heavily-owned cheap
    // player is exactly the case the pool exists for.
    const all = preseason(300).map((e, i) =>
      // Reverse ownership against price for forwards only, so the two live
      // rankings genuinely disagree and each has something to contribute.
      e.element_type === 4
        ? ({ ...e, selected_by_percent: ((299 - (i % 300)) / 10).toFixed(1) } as Element)
        : e
    );
    const picked = new Set(launchPool(all));
    const fwds = all.filter((e) => e.element_type === 4);
    const dearest = fwds.slice(-44);
    const mostOwned = [...fwds]
      .sort((a, b) => parseFloat(b.selected_by_percent) - parseFloat(a.selected_by_percent))
      .slice(0, 44);
    // Both ends are represented in full; neither ranking has been starved.
    // These were `toBeGreaterThan(20)` against measured values of 44, and that
    // 24-point cushion was wide enough for a `parseFloat` -> `parseInt` mutation
    // to change the picked set and still pass.
    expect(dearest.filter((e) => picked.has(e.id)).length).toBe(44);
    expect(mostOwned.filter((e) => picked.has(e.id)).length).toBe(44);
  });

  it("meets the quota exactly when every ranking is live", () => {
    // Four live rankings that disagree is the mid-season state, and it is the
    // one where the round-robin's bookkeeping can go wrong: a dedupe skip that
    // advances one step instead of looping counts a no-op `Set.add` as a pick
    // and silently returns half a pool, and dropping the inner `picked < target`
    // guard overshoots. Neither is visible with only two live rankings, because
    // the quota divides by two and single-step skipping is always enough.
    const all = preseason(300, {
      starts: (i) => (i * 7) % 300,
      chg: (i) => (i * 13) % 300,
      own: (i) => ((i * 3) % 300) / 10,
    });
    const picked = launchPool(all);
    expect(picked.length).toBe(420);
    expect(new Set(picked).size).toBe(420);
    const byPos = countByPos(all, picked);
    expect(byPos.get(1)).toBe(32);
    expect(byPos.get(2)).toBe(140);
    expect(byPos.get(3)).toBe(160);
    expect(byPos.get(4)).toBe(88);
  });

  it("breaks a near-flat ranking's ties on ownership, not on price alone", () => {
    // The tie-break has to be ownership FIRST, then price. Price is already a
    // whole ranking of its own; if a near-flat ranking resolves its tie block by
    // price it just becomes a second copy of that ranking, and the pool quietly
    // doubles down on the dearest players instead of covering the well-owned
    // cheap ones the drafter actually needs an opinion about.
    //
    // Ownership runs OPPOSITE to price here, so the two orderings cannot be
    // confused, and `starts` is near-flat: one player has come off the bench.
    const all = preseason(300, {
      own: (i) => (299 - i) / 10,
      starts: (i) => (i === 299 ? 1 : 0),
    });
    const picked = new Set(launchPool(all));
    const mids = all.filter((e) => e.element_type === 3);
    // Three live rankings — price, ownership, starts — so 160 midfield slots
    // split 54/53/53. `starts` ties 299 players at 0 and orders them by
    // ownership, which makes it an extension of the ownership run: together they
    // reach 106 deep from the well-owned end, comfortably past 100.
    const mostOwned = mids.slice(0, 100);
    expect(mostOwned.every((e) => picked.has(e.id))).toBe(true);
    // Tie-broken by price instead, `starts` extends the PRICE run and ownership
    // is left with 53 of its own — the 100th most-owned midfielder is missed.
    // A `starts` ranking that has been unplugged (hardcoded, or pointed at
    // `minutes`, which is 0 pre-season) goes flat, gets dropped by the variance
    // filter, and leaves ownership with 80. Both fail the line above.
    //
    // 160 is not divisible by 3, so the counts below also pin the round-robin's
    // last partial round: without the inner `picked < target` guard it completes
    // the round and overshoots to 162.
    const byPos = countByPos(all, launchPool(all));
    expect(byPos.get(3)).toBe(160);
    expect(byPos.get(1)).toBe(32);
    expect(byPos.get(4)).toBe(88);
  });

  it("falls through to price when ownership cannot separate them either", () => {
    // The last term of the tie-break. Ownership is published to one decimal, so
    // the bottom of a real position is one enormous block reading exactly "0.0"
    // — over a third of the midfielders at GW1. Inside that block ownership has
    // nothing left to say, and price is the only thing standing between the pool
    // and id order.
    //
    // Everyone is on 0.0% here, so the ownership ranking goes flat and is
    // dropped; `starts` is near-flat and survives, and its 299-player tie block
    // can only be resolved on price.
    const all = preseason(300, { own: () => 0, starts: (i) => (i === 299 ? 1 : 0) });
    const picked = new Set(launchPool(all));
    const mids = all.filter((e) => e.element_type === 3);
    // Two live rankings, both now ordered by price, so the pool is exactly the
    // 160 dearest. Drop the price fall-through and `starts` fills its 80 slots
    // from the cheapest end instead.
    expect(mids.slice(-160).every((e) => picked.has(e.id))).toBe(true);
    expect(mids.slice(0, 100).filter((e) => picked.has(e.id)).length).toBe(0);
  });

  it("gives each live ranking its own share of the slots", () => {
    // `starts` and `cost_change_start` are not decoration: mid-season they are
    // the two rankings that know who is actually playing and who the market is
    // moving on. Point each at a different set of players from price and
    // ownership, and each must bring its own leaders in.
    const all = preseason(300, {
      // Reverse: the highest `starts` and the biggest riser are the CHEAPEST.
      starts: (i) => 299 - i,
      chg: (i) => 299 - i,
      own: (i) => i / 10,
    });
    const picked = new Set(launchPool(all));
    const mids = all.filter((e) => e.element_type === 3);
    const dearest = mids.slice(-40);
    const mostStarts = [...mids].sort((a, b) => (b.starts ?? 0) - (a.starts ?? 0)).slice(0, 40);
    expect(dearest.filter((e) => picked.has(e.id)).length).toBe(40);
    // Four rankings share 160 midfield slots, so `starts` gets 40 of its own.
    // Swapping this ranking for `minutes`, or hardcoding it to 0, fails here.
    expect(mostStarts.filter((e) => picked.has(e.id)).length).toBe(40);
  });

  it("covers more than a squad's worth of each position", () => {
    // The pool is not a shortlist. A 15-man squad needs 2 keepers, but the
    // drafter has to be able to reject the 25th-best keeper on evidence rather
    // than because nobody looked him up. Sizes come from the sweep recorded in
    // `pool.ts`: below these the launch squad measurably loses points.
    const all = preseason(300);
    const picked = launchPool(all);
    const byPos = countByPos(all, picked);
    expect(byPos.get(1)).toBeGreaterThanOrEqual(32);
    expect(byPos.get(2)).toBeGreaterThanOrEqual(140);
    expect(byPos.get(3)).toBeGreaterThanOrEqual(160);
    expect(byPos.get(4)).toBeGreaterThanOrEqual(88);
    expect(picked.length).toBe(420);
  });

  it("never asks for a player who cannot be picked", () => {
    // `u` has left the league, `n` is not in the squad. Both are unpickable, so
    // a lookup is wasted on them.
    const all = preseason(60, { status: (i) => (i % 7 === 0 ? "u" : i % 11 === 0 ? "n" : "a") });
    const picked = new Set(launchPool(all));
    const barred = all.filter((e) => e.status === "u" || e.status === "n");
    // Guard the guard: a fixture edit that stopped producing them would
    // otherwise leave this test green with nothing asserted.
    expect(barred.length).toBeGreaterThan(20);
    for (const e of barred) expect(picked.has(e.id)).toBe(false);
  });

  it("still looks up players who are doubtful or injured", () => {
    // The mirror of the test above, and the more valuable half. `d` and `i` are
    // pickable, and they are exactly the players whose last-season record
    // decides whether to buy the cover — narrowing the filter to `status === "a"`
    // would drop them and hand that decision to the price prior.
    const all = preseason(300, { status: (i) => (i % 3 === 0 ? "d" : i % 3 === 1 ? "i" : "a") });
    const picked = new Set(launchPool(all));
    const mids = all.filter((e) => e.element_type === 3);
    const dearest = mids.slice(-160);
    expect(dearest.some((e) => e.status !== "a")).toBe(true);
    expect(dearest.filter((e) => picked.has(e.id)).length).toBe(160);
  });

  it("fills the position even when nothing about it varies", () => {
    // The documented "belt and braces" branch. If every ranking is flat there is
    // no information to rank on, but returning nobody would be much worse than
    // returning an arbitrary set: those players would each be projected from a
    // price prior instead. Falling back to `live` alone yields an empty pool.
    const all = preseason(300, { flatPrice: true, own: () => 0 });
    const picked = launchPool(all);
    expect(picked.length).toBe(420);
    const byPos = countByPos(all, picked);
    expect(byPos.get(2)).toBe(140);
  });

  it("uses the one live ranking when it is the only one", () => {
    // Price flat, ownership real. The fallback must not trigger here: reinstating
    // a flat price ranking alongside the live one would hand it half the slots
    // and fill them by id.
    const all = preseason(300, { flatPrice: true });
    const picked = new Set(launchPool(all));
    const gks = all.filter((e) => e.element_type === 1);
    const mostOwned = [...gks]
      .sort((a, b) => parseFloat(b.selected_by_percent) - parseFloat(a.selected_by_percent))
      .slice(0, 32);
    expect(mostOwned.filter((e) => picked.has(e.id)).length).toBe(32);
  });

  it("judges variance within a position, not across the whole game", () => {
    // Keepers are the cheapest position and the flattest. If liveness were
    // measured over every player at once, a ranking that says nothing about
    // keepers would still be handed a share of their slots — and with the
    // tie-break in place it does not fill them by id any more, it fills them as
    // a DUPLICATE of the ownership ranking, which is subtler and still wrong:
    // ownership gets two shares of the position and price gets starved.
    //
    // So ownership has to disagree with price for this to be visible at all.
    // Keepers here are owned in inverse proportion to their price, and `starts`
    // varies among midfielders while being identical for every keeper.
    const all = preseason(300, { starts: (i) => i }).map((e) =>
      e.element_type === 1
        ? ({
            ...e,
            starts: 5,
            selected_by_percent: ((299 - ((e.id - 1) % 300)) / 10).toFixed(1),
          } as Element)
        : e
    );
    const picked = new Set(launchPool(all));
    const gks = all.filter((e) => e.element_type === 1);
    // Two live rankings for keepers, so price gets a clean 16 of the 32 slots
    // and every one of the 16 dearest is looked up. Judged over `alive`, `starts`
    // survives into the keeper round, the split becomes three ways, and price is
    // cut to 11 — five of the most expensive keepers in the game go unfetched.
    expect(gks.slice(-16).filter((e) => picked.has(e.id)).length).toBe(16);
  });

  it("asks for everyone when there are fewer players than the quota", () => {
    // Small leagues, and the demo bootstrap. Two things stop this running past
    // the end: `Math.min(quota, inPos.length)` makes `target` reachable, and the
    // `advanced` guard breaks when every cursor is exhausted. They are mutually
    // redundant — removing either alone changes nothing, removing both hangs
    // forever — so no assertion here can distinguish them, and this comment says
    // so rather than claiming cover the test does not have. (An earlier version
    // of it had the roles the wrong way round.)
    const all = preseason(5);
    expect(launchPool(all).length).toBe(20);
  });
});

// Two more mutants survive this file and are recorded rather than papered over,
// because both became equivalent the moment the tie-break went in and writing an
// assertion for either would mean asserting something untrue.
//
// `parseFloat` -> `parseInt` on the ownership ranking. It looks like the classic
// precision bug — every player under 1% collapses to a tie — but the tie-break
// then orders that tie by `parseFloat` of the same field. Sorting by
// (floor(x), x) is sorting by x, so the output is identical for every input.
//
// `live.length > 0` -> `live.length > 1`. This only differs when exactly one
// ranking varies, and there the fallback installs the flat price ranking, whose
// ties are broken by ownership — reproducing the live ranking's order exactly.
//
// Both were real holes before the tie-break and are worth re-testing if it ever
// changes.
