"use client";

import { useState } from "react";
import type { TeamData } from "@/lib/fpl";
import { BREAKDOWN_CATS, CAT_LABEL, CAT_SHORT, type BreakdownCat } from "@/lib/breakdown";
import { loadSeasonArchive, type ArchivedSeason } from "@/lib/seasonArchive";
import { POSITION_NAMES } from "@/lib/rules";
import type { ElementType } from "@/lib/types";
import { SectionTitle } from "./ui";

const GWS_IN_SEASON = 38;

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-c bg-panel-2 px-3 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="font-mono text-sm font-semibold">{value}</div>
    </div>
  );
}

/** The full category breakdown, available only for seasons this app archived. */
function ArchivedDetail({ a }: { a: ArchivedSeason }) {
  const activeCats: BreakdownCat[] = BREAKDOWN_CATS.filter((c) => (a.catTotals[c] ?? 0) !== 0);
  const players = [...a.players].sort((x, y) => y.total - x.total);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {activeCats.map((c) => {
          const v = a.catTotals[c] ?? 0;
          return (
            <div
              key={c}
              className="rounded-lg border border-border-c bg-panel-2 px-3 py-1.5"
              title={CAT_LABEL[c]}
            >
              <div className="text-[10px] uppercase tracking-wide text-muted">{CAT_LABEL[c]}</div>
              <div className={`font-mono text-sm font-semibold ${v < 0 ? "text-danger" : ""}`}>
                {v > 0 ? `+${v}` : v}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        <span>
          <span className="text-muted">From players:</span>{" "}
          <b className="font-mono">{a.playersTotal}</b>
        </span>
        <span>
          <span className="text-muted">Transfer hits:</span>{" "}
          <b className={`font-mono ${a.hits > 0 ? "text-danger" : ""}`}>
            {a.hits > 0 ? `−${a.hits}` : 0}
          </b>
        </span>
        <span>
          <span className="text-muted">Net:</span>{" "}
          <b className="font-mono text-accent">{a.playersTotal - a.hits}</b>
        </span>
      </div>

      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Past seasons, scrollable"
      >
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b border-border-c text-xs uppercase text-muted">
            <tr>
              <th className="px-2 py-1.5 text-left">Player</th>
              <th className="px-2 py-1.5 text-right">Apps</th>
              {activeCats.map((c) => (
                <th key={c} className="px-2 py-1.5 text-right" title={CAT_LABEL[c]}>
                  {CAT_SHORT[c]}
                </th>
              ))}
              <th className="px-2 py-1.5 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-c/60">
            {players.map((p, i) => (
              <tr key={`${p.name}-${i}`}>
                <td className="px-2 py-1.5">
                  <span className="font-medium">{p.name}</span>{" "}
                  <span className="text-[11px] text-muted">
                    {POSITION_NAMES[p.pos as ElementType]} · {p.team}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-muted">{p.apps}</td>
                {activeCats.map((c) => {
                  const v = p.byCat[c] ?? 0;
                  return (
                    <td
                      key={c}
                      className={`px-2 py-1.5 text-right font-mono ${
                        v === 0 ? "text-muted/50" : v < 0 ? "text-danger" : ""
                      }`}
                    >
                      {v === 0 ? "–" : v}
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 text-right font-mono font-semibold text-accent">
                  {p.total}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Archived by this app after {a.gwsPlayed} gameweek{a.gwsPlayed === 1 ? "" : "s"} of{" "}
        {a.season}. Captaincy, chips and auto-subs are already applied.
      </p>
    </div>
  );
}

/** Everything FPL still publishes about a finished season, plus an honest
 *  explanation of why the category split isn't among it. */
function DerivedDetail({
  points,
  rank,
  others,
  prevRank,
  season,
}: {
  points: number;
  rank: number;
  /** Every OTHER season's total, so the comparison excludes this one. */
  others: number[];
  prevRank: number | null;
  season: string;
}) {
  const perGw = points / GWS_IN_SEASON;
  /*
   * "vs your OTHER seasons", and this compared against an average that INCLUDES
   * the season on screen. With one past season a manager therefore always saw
   * `+0` — the season was being measured against itself. With two, each is
   * pulled halfway toward the other and the gap prints at half its size.
   *
   * `avgOthers` is null when there is nothing to compare against, and the chip
   * then says nothing rather than saying zero.
   */
  const avgOthers = others.length > 0 ? others.reduce((s, p) => s + p, 0) / others.length : null;
  const diff = avgOthers == null ? null : Math.round(points - avgOthers);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Chip label="Total points" value={points.toLocaleString("en-GB")} />
        <Chip label="Overall rank" value={rank.toLocaleString("en-GB")} />
        {/* `/38` IS A CONSTANT AND A SEASON IS NOT ALWAYS 38 GAMEWEEKS FOR THE
            MANAGER — one who joined in November played fewer, and FPL publishes
            no per-season gameweek count on `history_past`. So the label says
            which denominator it used rather than implying it knows. */}
        <Chip label={`Points per GW (of ${GWS_IN_SEASON})`} value={perGw.toFixed(1)} />
        {diff != null && (
          <Chip
            label="vs your other seasons"
            value={`${diff > 0 ? "+" : diff < 0 ? "−" : ""}${Math.abs(diff).toLocaleString("en-GB")}`}
          />
        )}
        {prevRank != null && (
          <Chip
            label="Rank move"
            value={`${rank < prevRank ? "▲" : "▼"} ${Math.abs(prevRank - rank).toLocaleString("en-GB")}`}
          />
        )}
      </div>
      <p className="text-sm text-muted">
        FPL doesn&apos;t publish a squad-level breakdown for finished seasons. When a
        new season starts, the game wipes every manager&apos;s picks and the live
        scoring feed and reuses the same gameweek numbers, so the only things left
        on record for {season} are the total points and the overall rank you see
        above — there is no way to recover who you owned or where those points came
        from.
      </p>
      <p className="text-sm text-muted">
        From now on this app keeps its own copy: your category breakdown is
        archived on this device as the season plays out, so future seasons will
        open here with the full split by goals, assists, clean sheets, defensive
        contribution, bonus, cards and the rest.
      </p>
    </div>
  );
}

export default function PastSeasons({ data, entryId }: { data: TeamData; entryId: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const past = data.history.past;
  if (past.length === 0) return null;

  const last3 = past.slice(-3);
  const avgRank = Math.round(last3.reduce((s, p) => s + p.rank, 0) / last3.length);
  const bestRank = Math.min(...past.map((p) => p.rank));
  const avgPoints = past.reduce((s, p) => s + p.total_points, 0) / past.length;
  const ordered = [...past].reverse();

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>Past seasons</SectionTitle>
        <div className="text-sm text-muted">
          {past.length} season{past.length > 1 ? "s" : ""} · last {last3.length} avg rank{" "}
          <span className="font-semibold text-foreground">{avgRank.toLocaleString("en-GB")}</span> ·
          best <span className="font-semibold text-accent">{bestRank.toLocaleString("en-GB")}</span>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted">Tap a season to see how those points were earned.</p>
      {/* A list, not a table: the expanded panel holds a wide scrollable table
          of its own, and nesting that inside a table cell breaks the layout. */}
      <div className="mt-3 divide-y divide-border-c/60 border-t border-border-c">
        <div className="grid grid-cols-[1fr_auto_auto_1.25rem] gap-3 px-1 py-1.5 text-xs uppercase text-muted">
          <span>Season</span>
          <span className="text-right">Points</span>
          <span className="w-20 text-right">Rank</span>
          <span />
        </div>
        {ordered.map((p, i) => {
          const isOpen = open === p.season_name;
          // `ordered` is newest-first, so the next entry is the previous season.
          const prev = ordered[i + 1] ?? null;
          // Only touched once a row is opened: keeps localStorage out of the
          // first render (and out of SSR) entirely.
          const archive = isOpen ? loadSeasonArchive(entryId, p.season_name) : null;
          return (
            <div key={p.season_name}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : p.season_name)}
                className={`grid min-h-11 w-full grid-cols-[1fr_auto_auto_1.25rem] items-center gap-3 px-1 py-2 text-left text-sm hover:bg-panel-2/60 ${
                  p.rank === bestRank ? "text-accent" : ""
                }`}
              >
                <span className="font-medium">{p.season_name}</span>
                <span className="text-right font-mono">
                  {p.total_points.toLocaleString("en-GB")}
                </span>
                <span className="w-20 text-right font-mono">
                  {p.rank.toLocaleString("en-GB")}
                </span>
                <span className="text-right text-muted">{isOpen ? "\u25be" : "\u25b8"}</span>
              </button>
              {isOpen && (
                <div className="mb-2 rounded-lg bg-panel-2/40 p-3">
                  {archive ? (
                    <ArchivedDetail a={archive} />
                  ) : (
                    <DerivedDetail
                      points={p.total_points}
                      rank={p.rank}
                      others={past.filter((q) => q.season_name !== p.season_name).map((q) => q.total_points)}
                      prevRank={prev?.rank ?? null}
                      season={p.season_name}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
        {/* Career averages, mirroring the summary FPL added for 2026/27. A
            "top X%" finish can't be shown for past seasons: FPL doesn't publish
            how many managers played in them. */}
        <div className="grid grid-cols-[1fr_auto_auto_1.25rem] gap-3 px-1 py-2 text-sm text-muted">
          <span className="font-medium">Career average</span>
          <span className="text-right font-mono">{Math.round(avgPoints).toLocaleString("en-GB")}</span>
          <span className="w-20 text-right font-mono">
            {Math.round(past.reduce((s, p) => s + p.rank, 0) / past.length).toLocaleString("en-GB")}
          </span>
          <span />
        </div>
      </div>
    </div>
  );
}
