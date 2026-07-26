import { describe, expect, it } from "vitest";
import { repairStartsColumn, type StartsRow } from "../../../scripts/archiveRepair";

// The 2022-23 backtest archive carries `starts = 0` for every player in
// gameweeks 1-15 while ~300 played each week. Undetected, it zeroed the
// model's strongest in-season minutes signal across the whole first half of
// the only archived season with no prior season behind it, and every 2022-23
// minutes measurement taken before the repair was written is contaminated by
// it. Repairing it moved that season's rho from 0.2784 to 0.4189.
//
// These tests pin the two things that make the repair safe to run blind over
// every season: it fires when the column is broken, and it does NOTHING when
// the column is fine.

const row = (round: number, starts: number, minutes: number): StartsRow => ({
  round,
  starts,
  minutes,
});

describe("repairStartsColumn", () => {
  it("leaves an intact season completely untouched", () => {
    // Round 1 deliberately has ONE recorded start against four players with
    // minutes. The detector's safety argument rests on "nobody started" being
    // the trigger; a looser rule — say, fewer than half the players who played
    // also started — would fire here and quietly rewrite a healthy round.
    const rows = [
      row(1, 1, 90),
      row(1, 0, 12), // a real substitute — must stay a substitute
      row(1, 0, 62), // a long substitute appearance, over the half-match line
      row(1, 0, 46),
      row(1, 0, 0),
      row(2, 1, 61),
      row(2, 0, 80), // a real sub who played 80 minutes: NOT promoted to a start
    ];
    const before = rows.map((r) => r.starts);
    expect(repairStartsColumn(rows)).toEqual([]);
    expect(rows.map((r) => r.starts)).toEqual(before);
  });

  it("repairs exactly the rounds where nobody started and somebody played", () => {
    const rows = [
      // Round 1: broken — minutes everywhere, not one start recorded.
      row(1, 0, 90),
      row(1, 0, 46),
      row(1, 0, 44), // just under the half-match line
      row(1, 0, 0),
      // Round 2: healthy — must survive the repair unchanged.
      row(2, 1, 90),
      row(2, 0, 89), // a real 89-minute substitute, above the threshold
    ];
    expect(repairStartsColumn(rows)).toEqual([1]);
    expect(rows.map((r) => r.starts)).toEqual([1, 1, 0, 0, 1, 0]);
  });

  it("treats a genuinely blank round as nothing to repair", () => {
    // A postponed round has zero starts AND zero minutes. Promoting it would
    // invent starts for players who did not play.
    const rows = [row(1, 0, 0), row(1, 0, 0), row(2, 1, 90)];
    expect(repairStartsColumn(rows)).toEqual([]);
    expect(rows.map((r) => r.starts)).toEqual([0, 0, 1]);
  });

  it("uses the half-match line, not any non-zero minutes", () => {
    const rows = [row(9, 0, 45), row(9, 0, 44), row(9, 0, 1)];
    expect(repairStartsColumn(rows)).toEqual([9]);
    expect(rows.map((r) => r.starts)).toEqual([1, 0, 0]);
  });

  it("reports every broken round, in ascending order", () => {
    const rows = [row(3, 0, 90), row(1, 0, 90), row(2, 1, 90), row(7, 0, 90)];
    expect(repairStartsColumn(rows)).toEqual([1, 3, 7]);
  });
});
