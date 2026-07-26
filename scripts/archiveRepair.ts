/**
 * Repairs to the archived gameweek CSVs used by the backtest.
 *
 * These are NOT part of the app. They exist because the historical dumps the
 * backtest reads are not uniformly correct, and a silent hole in one of them
 * produces a measurement that looks fine and is wrong.
 */

/** The only two fields the repair reads or writes. */
export interface StartsRow {
  round: number;
  starts: number;
  minutes: number;
}

/**
 * REPAIR: the 2022-23 archive's `starts` column is zero for every player in
 * rounds 1-6 and 8-15 while 211-303 players a round are on the pitch. It only
 * becomes correct from round 16. (Round 7 is absent entirely — those fixtures
 * were postponed and rescheduled, so `gw7.csv` is a header with no rows. It has
 * a `starts` column; there is simply nothing in it.) Verified against all four
 * archived seasons: 2023-24, 2024-25 and 2025-26 have no broken rounds at all,
 * so the detector fires on exactly one season and repairs nothing elsewhere.
 *
 * What it costs to leave alone is much more than a degraded `recentStarts`
 * window. The backtest accumulates these rows into `Element.starts`, so with
 * the column zeroed `minutesModel` never took its `starts > 0` branch: for the
 * whole of 2022-23 GW2-16 it returned `{pStart: 0, minsPerStart: 0, share: 0}`
 * for EVERY player — a total collapse of the minutes model, not a weakened
 * signal — and the season term stayed deflated (an ever-present read 0.649
 * instead of 1.000 by GW38) for the rest of the season too. Repairing it moved
 * that season's rhoPlayed from 0.3018 to 0.3842. Every 2022-23 measurement
 * taken before this was written is contaminated.
 *
 * A round is treated as broken when NOBODY in it started and SOMEBODY played.
 * That cannot happen in a real round, so the detector is safe against a genuine
 * blank gameweek (nobody plays => nothing to repair) and against any real round
 * (somebody starts => not broken). Rounds that are fine are never touched, so
 * running this over an intact season is a no-op.
 *
 * The stand-in is `minutes >= 45`, chosen because it is the half-match line
 * rather than because it won a search. Checked against the true column on the
 * 87,087 player-gameweeks of the three intact seasons it agrees 98.65% of the
 * time; the argmax over thresholds 35-55 is 41 at 98.67%, nineteen rows in
 * eighty-seven thousand, and picking it would be fitting a constant to the same
 * data the constant is judged on.
 *
 * That 98.65% flatters it, and the honest version is worth writing down. Of the
 * 87,087 rows, 61,108 are players who neither started nor played, where both
 * sides trivially agree. Among the 9,366 non-starters who DID play, 897 (9.6%)
 * are wrongly promoted to starters — 78% of them half-time substitutions one
 * minute the wrong side of the line — against 278 real starts missed (mostly
 * red cards and early injuries). The net effect is +2.5% phantom starts, biased
 * toward the impact-substitute archetype, which is precisely the group the
 * start share exists to demote. On the quantity actually consumed — the rolling
 * five-game start fraction — that is a mean bias of +0.007. Acceptable, and
 * hugely better than a column of zeros, but not free.
 *
 * Mutates `rows` in place. Returns the rounds it repaired, ascending — empty
 * when the season is intact.
 */
export function repairStartsColumn(rows: StartsRow[]): number[] {
  const roundHasStart = new Set<number>();
  const roundHasMinutes = new Set<number>();
  for (const r of rows) {
    if (r.starts > 0) roundHasStart.add(r.round);
    if (r.minutes > 0) roundHasMinutes.add(r.round);
  }
  const broken = [...roundHasMinutes].filter((g) => !roundHasStart.has(g)).sort((a, b) => a - b);
  if (broken.length === 0) return [];
  const brokenSet = new Set(broken);
  for (const r of rows) {
    if (brokenSet.has(r.round)) r.starts = r.minutes >= 45 ? 1 : 0;
  }
  return broken;
}
