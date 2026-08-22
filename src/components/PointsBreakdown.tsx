"use client";

import { useEffect, useMemo, useState } from "react";
import type { TeamData } from "@/lib/fpl";
import {
  loadSeasonBreakdown,
  BREAKDOWN_CATS,
  CAT_LABEL,
  CAT_SHORT,
  type SeasonBreakdown,
  type BreakdownCat,
} from "@/lib/breakdown";
import { currentSeasonName, saveSeasonArchive, toArchive } from "@/lib/seasonArchive";
import { POSITION_NAMES } from "@/lib/rules";
import type { Element, ElementType } from "@/lib/types";
import { PlayerAvatar } from "./Pitch";
import { Skeleton } from "./ui";

/** One coloured cell: positive black-on-accent-free, negative red, zero muted. */
function Num({ v, bold = false }: { v: number; bold?: boolean }) {
  const cls =
    v === 0
      ? "text-muted/50"
      : v < 0
        ? "text-danger"
        : bold
          ? "text-accent"
          : "text-fg";
  return (
    <span className={`font-mono ${bold ? "font-semibold" : ""} ${cls}`}>
      {v === 0 ? "–" : v > 0 && bold ? `+${v}` : v}
    </span>
  );
}

export default function PointsBreakdown({
  data,
  entryId,
  onSelect,
}: {
  data: TeamData;
  entryId: number;
  onSelect?: (el: Element) => void;
}) {
  const finishedGws = useMemo(
    () => data.bootstrap.events.filter((e) => e.finished).map((e) => e.id),
    [data]
  );
  const elementById = useMemo(
    () => new Map(data.bootstrap.elements.map((e) => [e.id, e])),
    [data]
  );
  const teamShort = useMemo(
    () => new Map(data.bootstrap.teams.map((t) => [t.id, t.short_name])),
    [data]
  );

  const [bd, setBd] = useState<SeasonBreakdown | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState(false);
  const [gwFilter, setGwFilter] = useState<number | "all">("all");

  useEffect(() => {
    if (finishedGws.length === 0) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the entry/GW set changes before the async load
    setBd(null);
    setErr(false);
    setProgress({ done: 0, total: finishedGws.length });
    loadSeasonBreakdown(entryId, finishedGws, elementById, data.fixtures, 6, (done, total) => {
      if (!cancelled) setProgress({ done, total });
    })
      .then((res) => {
        if (cancelled) return;
        setBd(res);
        // Archive it: FPL deletes picks and live scoring when the season rolls
        // over, so this snapshot is the only way the breakdown survives into
        // next season's "Past seasons" view.
        const season = currentSeasonName(data.bootstrap.events);
        if (season && res.gws.length > 0) {
          saveSeasonArchive(
            toArchive(entryId, season, res, elementById, data.bootstrap.teams, Date.now())
          );
        }
      })
      .catch(() => {
        if (!cancelled) setErr(true);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, finishedGws, elementById, data.fixtures, data.bootstrap]);

  if (finishedGws.length === 0) {
    return (
      <div className="card p-6 text-sm text-muted">
        Once Gameweek 1 has been played, this table shows exactly where every point
        came from — per player, per scoring category and per round.
      </div>
    );
  }

  if (err) {
    return (
      <div className="card p-6 text-sm text-muted">
        Couldn&apos;t load the points breakdown right now — try reopening this tab.
      </div>
    );
  }

  if (!bd) {
    return (
      <div className="card space-y-3 p-6">
        <p className="text-sm text-muted">
          Building your points breakdown
          {progress ? ` — ${progress.done}/${progress.total} gameweeks` : "…"}
        </p>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const gwView = gwFilter !== "all";

  // Value getter: season total or the chosen single gameweek.
  const valFor = (row: (typeof bd.rows)[number], cat: BreakdownCat): number =>
    gwView ? (row.byGwCat.get(gwFilter)?.[cat] ?? 0) : row.byCat[cat] ?? 0;

  // Rows to render for the chosen view.
  const rows = gwView
    ? bd.rows
        .filter((r) => r.byGw.has(gwFilter))
        .sort((a, b) => (b.byGw.get(gwFilter) ?? 0) - (a.byGw.get(gwFilter) ?? 0))
    : bd.rows.filter((r) => r.total !== 0 || r.apps > 0);

  // Category totals for the current view (drives which columns to show + footer).
  const catTotals: Record<string, number> = {};
  for (const r of rows) {
    for (const c of BREAKDOWN_CATS) catTotals[c] = (catTotals[c] ?? 0) + valFor(r, c);
  }
  const activeCats: BreakdownCat[] = BREAKDOWN_CATS.filter((c) => (catTotals[c] ?? 0) !== 0);

  const gwHit = gwView ? (bd.perGw.get(gwFilter)?.hits ?? 0) : bd.hits;
  const gwPlayers = gwView ? (bd.perGw.get(gwFilter)?.points ?? 0) : bd.playersTotal;

  return (
    <div className="space-y-4">
      {/* Heading + view switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Points breakdown</h3>
          {/*
            SAY WHICH GAMEWEEKS, BECAUSE IT IS NOT ALL OF THEM. This reads off
            gameweeks where `finished` is true — bonus confirmed, per the rule in
            CLAUDE.md — so an in-flight gameweek is deliberately excluded. That
            is right, and "Every point you've scored" said otherwise: the season
            total read 918 under a header showing 966, with the chart directly
            above it plotting the gameweek that makes up the difference.
          */}
          <p className="text-xs text-muted">
            {bd.gws.length > 0
              ? `Every point you've scored in GW${bd.gws[0]}–${bd.gws[bd.gws.length - 1]}, split by player and scoring rule.`
              : "Split by player and scoring rule."}{" "}
            Captain, Triple Captain, Bench Boost and auto-subs are all applied. A
            gameweek joins this once its bonus is confirmed.
          </p>
        </div>
        <select
          aria-label="Filter the breakdown by gameweek"
          value={gwFilter}
          onChange={(e) =>
            setGwFilter(e.target.value === "all" ? "all" : Number(e.target.value))
          }
          className="rounded-lg border border-border-c bg-panel-2 px-3 py-2 text-sm"
        >
          <option value="all">
            {bd.gws.length > 0
              ? `Total, GW${bd.gws[0]}–${bd.gws[bd.gws.length - 1]}`
              : "Season total"}
          </option>
          {[...bd.gws].reverse().map((g) => (
            <option key={g} value={g}>
              Gameweek {g}
            </option>
          ))}
        </select>
      </div>

      {/* Category summary chips */}
      {activeCats.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {activeCats.map((c) => {
            const v = catTotals[c] ?? 0;
            return (
              <div
                key={c}
                className="rounded-lg border border-border-c bg-panel-2 px-3 py-1.5"
                title={CAT_LABEL[c]}
              >
                <div className="text-[10px] uppercase tracking-wide text-muted">
                  {CAT_LABEL[c]}
                </div>
                <div
                  className={`font-mono text-sm font-semibold ${v < 0 ? "text-danger" : "text-fg"}`}
                >
                  {v > 0 ? `+${v}` : v}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Reconciliation line */}
      <div className="card flex flex-wrap items-center gap-x-5 gap-y-1 p-3 text-sm">
        <span>
          <span className="text-muted">{gwView ? `GW${gwFilter} players:` : "From players:"}</span>{" "}
          <b className="font-mono">{gwPlayers}</b>
        </span>
        <span>
          <span className="text-muted">Transfer hits:</span>{" "}
          <b className={`font-mono ${gwHit > 0 ? "text-danger" : ""}`}>
            {gwHit > 0 ? `−${gwHit}` : 0}
          </b>
        </span>
        <span>
          <span className="text-muted">Net:</span>{" "}
          <b className="font-mono text-accent">{gwPlayers - gwHit}</b>
        </span>
      </div>

      {/* Main table */}
      <div
        className="card overflow-x-auto p-0"
        tabIndex={0}
        role="region"
        aria-label="Points breakdown, scrollable"
      >
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-border-c text-xs uppercase text-muted">
            <tr>
              <th className="sticky left-0 z-10 bg-[var(--panel)] px-3 py-2 text-left">
                Player
              </th>
              <th className="px-2 py-2 text-right">{gwView ? "Pl" : "Apps"}</th>
              {activeCats.map((c) => (
                <th key={c} className="px-2 py-2 text-right" title={CAT_LABEL[c]}>
                  {CAT_SHORT[c]}
                </th>
              ))}
              <th className="px-3 py-2 text-right">{gwView ? `GW${gwFilter}` : "Total"}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-c/60">
            {rows.map((r) => {
              const el = elementById.get(r.elementId);
              if (!el) return null;
              const rowTotal = gwView ? (r.byGw.get(gwFilter as number) ?? 0) : r.total;
              // The row below carries the same role/tabIndex/Enter-Space
              // handling `StatsTable` and `MiniLeague` already have for the
              // identical interaction. Without it this was the one table in the
              // app whose player sheets could not be opened from a keyboard,
              // and a screen reader announced an ordinary row.
              return (
                <tr
                  key={r.elementId}
                  className="cursor-pointer hover:bg-panel-2/60"
                  onClick={() => onSelect?.(el)}
                  tabIndex={onSelect ? 0 : undefined}
                  aria-label={onSelect ? `${el.web_name} — open player details` : undefined}
                  onKeyDown={
                    onSelect
                      ? (ev) => {
                          if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            onSelect(el);
                          }
                        }
                      : undefined
                  }
                >
                  <td className="sticky left-0 z-10 bg-[var(--panel)] px-3 py-2">
                    <div className="flex items-center gap-2">
                      <PlayerAvatar el={el} teamShort={teamShort.get(el.team)} size="sm" center={false} />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{el.web_name}</div>
                        <div className="text-[11px] text-muted">
                          {POSITION_NAMES[el.element_type as ElementType]} ·{" "}
                          {teamShort.get(el.team)}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-muted">
                    {gwView ? (r.byGw.has(gwFilter as number) ? 1 : 0) : r.apps}
                  </td>
                  {activeCats.map((c) => (
                    <td key={c} className="px-2 py-2 text-right">
                      <Num v={valFor(r, c)} />
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right">
                    <Num v={rowTotal} bold />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-border-c text-sm">
            <tr>
              <td className="sticky left-0 z-10 bg-[var(--panel)] px-3 py-2 font-semibold">
                {gwView ? `GW${gwFilter} total` : "Squad total"}
              </td>
              <td className="px-2 py-2 text-right font-mono text-muted">
                {rows.length}
              </td>
              {activeCats.map((c) => (
                <td key={c} className="px-2 py-2 text-right">
                  <Num v={catTotals[c] ?? 0} />
                </td>
              ))}
              <td className="px-3 py-2 text-right">
                <Num v={gwPlayers} bold />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="text-xs text-muted">
        Minutes = appearance points (1 for a cameo, 2 for 60+). Defensive
        contribution rewards tackles, interceptions, blocks and recoveries. Bonus
        is the 1–3 pts from the BPS ranking. Negative categories (cards, goals
        conceded, own goals, penalty misses) are shown in red.
      </p>
    </div>
  );
}
