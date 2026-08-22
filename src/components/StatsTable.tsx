"use client";

import { useMemo, useState } from "react";
import type { TeamData } from "@/lib/fpl";
import { fmtPrice, POSITION_NAMES } from "@/lib/rules";
import type { PlayerXp } from "@/lib/xp";
import type { ElementType } from "@/lib/types";
import { PlayerAvatar } from "./Pitch";

type SortKey = "xp" | "total_points" | "form" | "now_cost" | "selected" | "xgi";

/** Stable identity, so the row memo below does not rebuild on every render. */
const NO_XP: Map<number, PlayerXp> = new Map();

/** How many rows the table draws. Named so the caption can quote it. */
const ROW_LIMIT = 60;

export default function StatsTable({
  data,
  onSelect,
  xp: sharedXp,
  recentFormApplied = false,
}: {
  data: TeamData;
  onSelect?: (el: import("@/lib/types").Element) => void;
  /*
   * ONE PROJECTION, NOT TWO — AND REQUIRED, NOT OPTIONAL.
   *
   * This used to run its own `projectAll` with no `pastSeason`, while the
   * dashboard ran one WITH it. So the two tabs disagreed about the same
   * player, and they disagreed hardest exactly where the number matters most:
   * a player on no minutes this season — a new signing, a returning long-term
   * absentee — is projected almost entirely from last season's record, and
   * this table was the one place in the app quoting him without it. Two xP
   * columns, one player, no way for the reader to tell which the optimizer had
   * used. It was also a second full projection of the league on every mount.
   *
   * The prop is required rather than defaulted on purpose. A fallback here
   * could not be reached — the dashboard returns null from its projection
   * under exactly the condition that would trigger it — so it was an untested
   * branch that would have been wrong the first time anyone leaned on it, and
   * it re-created the bug in miniature by reading module state React cannot
   * see change. `null` means "there is no next gameweek", which is the
   * caller's business to decide, not this table's to guess around.
   */
  xp: Map<number, PlayerXp> | null;
  /**
   * True once the app has fetched recent line-ups and the projection above is
   * built with them.
   *
   * THE NUMBER IN THIS COLUMN CHANGES MID-SESSION AND NOTHING SAID SO. Recent
   * form is fetched by `OptimizePanel`, published to `recentFormStore`, and
   * picked up by the Dashboard's projection — so a reader who looks at Stats,
   * presses Optimize, and comes back sees a different xP for the same player
   * in one page load (measured on the demo: ARS Back 3, 19.5 then 19.4). The
   * convergence is the point — the two tabs used to disagree permanently — but
   * an unannounced change to a number the reader is comparing players on is
   * its own defect.
   */
  recentFormApplied?: boolean;
}) {
  const [posFilter, setPosFilter] = useState<0 | ElementType>(0);
  const [sortKey, setSortKey] = useState<SortKey>("xp");
  /*
   * SORTING WAS DESCENDING-ONLY, on the one screen built for finding budget
   * enablers. `setSortKey(key)` never toggled, `aria-sort` was hard-coded
   * "descending", and a second click on the active header was a verified
   * no-op — so there was no way to ask for the cheapest player, and at
   * `Max price: £5.0m` the 59 cheapest were the ones the top-sixty cut threw
   * away.
   */
  const [sortAsc, setSortAsc] = useState(false);
  // Slider max tracks the actual priciest player, so record-price premiums
  // (e.g. Haaland at £15.5m) are never cut off. null = show everyone.
  const priceCeiling = useMemo(() => {
    const hi = Math.max(150, ...data.bootstrap.elements.map((e) => e.now_cost));
    return Math.ceil(hi / 5) * 5;
  }, [data.bootstrap]);
  const [maxPrice, setMaxPrice] = useState<number | null>(null);
  const effMaxPrice = maxPrice ?? priceCeiling;
  const [search, setSearch] = useState("");

  const teams = useMemo(
    () => new Map(data.bootstrap.teams.map((t) => [t.id, t])),
    [data.bootstrap]
  );

  const xp = sharedXp ?? NO_XP;

  // Pre-season everyone is on 0 minutes/points — don't hide the whole game then.
  const playedGws = data.bootstrap.events.filter((e) => e.finished).length;
  const view = useMemo(() => {
    let els = data.bootstrap.elements.filter((e) => e.element_type >= 1 && e.element_type <= 4);
    if (playedGws > 0) els = els.filter((e) => e.minutes > 0 || e.total_points > 0);
    if (posFilter !== 0) els = els.filter((e) => e.element_type === posFilter);
    els = els.filter((e) => e.now_cost <= effMaxPrice);
    if (search) {
      // ALSO THE CLUB CODE, WHICH IS THE ONE THE TABLE PRINTS. Every row shows
      // `short_name` ("BOU", "NFO") while the filter matched only `web_name`
      // and the full `name`, so typing the exact token visible in the column
      // returned nothing. Invisible on the demo, whose `web_name`s embed the
      // code ("NFO Striker 1"), which is why it survived.
      const q = search.toLowerCase();
      els = els.filter((e) => {
        const t = teams.get(e.team);
        return (
          e.web_name.toLowerCase().includes(q) ||
          t?.name.toLowerCase().includes(q) ||
          t?.short_name.toLowerCase().includes(q)
        );
      });
    }
    const val = (e: (typeof els)[number]): number => {
      switch (sortKey) {
        case "xp":
          return xp.get(e.id)?.total ?? 0;
        case "total_points":
          return e.total_points;
        case "form":
          return parseFloat(e.form) || 0;
        case "now_cost":
          return e.now_cost;
        case "selected":
          return parseFloat(e.selected_by_percent) || 0;
        case "xgi":
          return parseFloat(e.expected_goal_involvements) || 0;
      }
    };
    const ordered = els.sort((a, b) => (sortAsc ? val(a) - val(b) : val(b) - val(a)));
    // The count is returned beside the rows so the caption can say what was
    // cut. It read the top sixty with nothing on screen to say so — with DEF
    // selected, 100 qualify and 60 render.
    return { rows: ordered.slice(0, ROW_LIMIT), total: ordered.length };
  }, [data, posFilter, sortKey, sortAsc, effMaxPrice, playedGws, search, teams, xp]);
  const rows = view.rows;

  const th = (key: SortKey, label: string) => (
    <th
      className="px-2 py-2 text-right"
      aria-sort={sortKey === key ? (sortAsc ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        onClick={() => {
          if (sortKey === key) setSortAsc((v) => !v);
          else {
            setSortKey(key);
            setSortAsc(false);
          }
        }}
        className={`-m-1 min-h-11 p-1 uppercase hover:text-accent active:text-accent ${sortKey === key ? "text-accent" : ""}`}
      >
        {label}
        {sortKey === key ? (sortAsc ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-3 p-4 text-sm">
        <div className="flex gap-1 rounded-lg bg-panel-2 p-1">
          {([0, 1, 2, 3, 4] as const).map((t) => (
            <button
              key={t}
              onClick={() => setPosFilter(t)}
              className={`min-h-11 rounded-md px-3 py-1.5 ${posFilter === t ? "btn-primary" : "text-muted"}`}
            >
              {t === 0 ? "All" : POSITION_NAMES[t]}
            </button>
          ))}
        </div>
        <label className="flex min-h-11 items-center gap-2 text-muted">
          Max price: £{fmtPrice(effMaxPrice)}m
          {/*
            `h-11` on a range input gives the TRACK a 44px hit area — the thumb
            is drawn centred in it, so the whole strip is draggable rather than
            the 16px the control defaults to on a phone.
          */}
          <input
            type="range"
            min={40}
            max={priceCeiling}
            step={5}
            value={effMaxPrice}
            onChange={(e) => setMaxPrice(parseInt(e.target.value))}
            className="h-11 accent-[var(--accent)]"
          />
        </label>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search player/club…"
          aria-label="Search players or clubs"
          className="ml-auto min-h-11 rounded-lg bg-panel-2 border border-border-c px-3 py-2"
        />
      </div>

      <div
        className="card overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Player statistics, scrollable"
      >
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-border-c text-xs uppercase text-muted">
            <tr>
              <th className="sticky left-0 z-10 bg-[var(--panel)] px-3 py-2 text-left">Player</th>
              <th className="px-2 py-2 text-left">Pos</th>
              {th("now_cost", "Price")}
              {th("xp", `xP (5 GW)`)}
              {th("form", "Form")}
              {th("total_points", "Pts")}
              {th("xgi", "xGI")}
              {th("selected", "Own %")}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-c/60">
            {rows.map((e) => {
              const netT = (e.transfers_in_event ?? 0) - (e.transfers_out_event ?? 0);
              return (
              <tr
                key={e.id}
                className={`hover:bg-panel-2/60 active:bg-panel-2 ${onSelect ? "cursor-pointer" : ""}`}
                onClick={onSelect ? () => onSelect(e) : undefined}
                tabIndex={onSelect ? 0 : undefined}
                /* The row keeps its ROW role so the table survives in the
                   accessibility tree (see `componentInvariants`), which
                   leaves nothing saying it is operable. The label does. */
                aria-label={onSelect ? `${e.web_name} — open player details` : undefined}
                onKeyDown={
                  onSelect
                    ? (ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          onSelect(e);
                        }
                      }
                    : undefined
                }
              >
                <td className="sticky left-0 z-10 bg-[var(--panel)] px-3 py-2">
                  <span className="flex items-center gap-2">
                    <PlayerAvatar
                      el={e}
                      teamShort={teams.get(e.team)?.short_name}
                      size="sm"
                      center={false}
                    />
                    <span>
                      <span className="font-medium">{e.web_name}</span>{" "}
                      <span className="text-xs text-muted">{teams.get(e.team)?.short_name}</span>
                      {e.status !== "a" && (
                        <span className="ml-1 text-xs" title={e.news}>
                          {e.status === "d" ? "⚠️" : "🤕"}
                        </span>
                      )}
                    </span>
                  </span>
                </td>
                <td className="px-2 py-2 text-muted">{POSITION_NAMES[e.element_type]}</td>
                <td className="px-2 py-2 text-right font-mono">
                  £{fmtPrice(e.now_cost)}m
                  {netT > 25_000 && (
                    <span className="ml-0.5 text-accent" title={`${netT.toLocaleString("en-GB")} net transfers in this GW — price-rise pressure`}>
                      ▲
                    </span>
                  )}
                  {netT < -25_000 && (
                    <span className="ml-0.5 text-danger" title={`${Math.abs(netT).toLocaleString("en-GB")} net transfers out this GW — price-fall pressure`}>
                      ▼
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 text-right font-mono text-accent">
                  {(xp.get(e.id)?.total ?? 0).toFixed(1)}
                </td>
                <td className="px-2 py-2 text-right font-mono">{e.form}</td>
                <td className="px-2 py-2 text-right font-mono">{e.total_points}</td>
                <td className="px-2 py-2 text-right font-mono">{e.expected_goal_involvements}</td>
                <td className="px-2 py-2 text-right font-mono">{e.selected_by_percent}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/*
        SAY WHAT WAS CUT. The table drew the top sixty with nothing on screen to
        say so — with DEF selected, 100 players qualify and 60 render, and at
        `Max price: £5.0m` the 59 cheapest were exactly the ones thrown away, on
        the screen built for finding budget enablers.
      */}
      <p className="text-xs text-muted" role="status">
        {view.total === 0
          ? "No players match these filters."
          : view.total > rows.length
            ? `Showing ${rows.length} of ${view.total} — narrow the filters, or sort by the column you care about.`
            : `Showing all ${view.total}.`}{" "}
        {recentFormApplied
          ? "xP includes recent line-ups, so it matches the Optimize tab exactly."
          : "xP sharpens once you run Optimize, which fetches recent line-ups for the players it considers."}
      </p>
    </div>
  );
}
