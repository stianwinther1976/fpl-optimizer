"use client";

import { useMemo, useState } from "react";
import type { TeamData } from "@/lib/fpl";
import { fmtPrice, POSITION_NAMES } from "@/lib/rules";
import { projectAll } from "@/lib/xp";
import type { ElementType } from "@/lib/types";

type SortKey = "xp" | "total_points" | "form" | "now_cost" | "selected" | "xgi";

export default function StatsTable({ data }: { data: TeamData }) {
  const [posFilter, setPosFilter] = useState<0 | ElementType>(0);
  const [sortKey, setSortKey] = useState<SortKey>("xp");
  const [maxPrice, setMaxPrice] = useState(150);
  const [search, setSearch] = useState("");

  const teams = useMemo(
    () => new Map(data.bootstrap.teams.map((t) => [t.id, t])),
    [data.bootstrap]
  );

  const nextEvent = data.bootstrap.events.find((e) => e.is_next)?.id ?? null;
  const xp = useMemo(
    () =>
      nextEvent != null
        ? projectAll({ bootstrap: data.bootstrap, fixtures: data.fixtures, nextEvent })
        : new Map(),
    [data, nextEvent]
  );

  const rows = useMemo(() => {
    let els = data.bootstrap.elements.filter((e) => e.minutes > 0 || e.total_points > 0);
    if (posFilter !== 0) els = els.filter((e) => e.element_type === posFilter);
    els = els.filter((e) => e.now_cost <= maxPrice);
    if (search) {
      const q = search.toLowerCase();
      els = els.filter(
        (e) =>
          e.web_name.toLowerCase().includes(q) ||
          teams.get(e.team)?.name.toLowerCase().includes(q)
      );
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
    return els.sort((a, b) => val(b) - val(a)).slice(0, 60);
  }, [data, posFilter, sortKey, maxPrice, search, teams, xp]);

  const th = (key: SortKey, label: string) => (
    <th
      className={`cursor-pointer px-2 py-2 text-right hover:text-accent ${sortKey === key ? "text-accent" : ""}`}
      onClick={() => setSortKey(key)}
    >
      {label}
      {sortKey === key ? " ↓" : ""}
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
              className={`rounded-md px-3 py-1.5 ${posFilter === t ? "bg-accent text-black font-semibold" : "text-muted"}`}
            >
              {t === 0 ? "Alle" : POSITION_NAMES[t]}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-muted">
          Maks pris: £{fmtPrice(maxPrice)}
          <input
            type="range"
            min={40}
            max={150}
            step={5}
            value={maxPrice}
            onChange={(e) => setMaxPrice(parseInt(e.target.value))}
            className="accent-[var(--accent)]"
          />
        </label>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Søk spiller/klubb…"
          className="ml-auto rounded-lg bg-panel-2 border border-border-c px-3 py-2"
        />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-border-c text-xs uppercase text-muted">
            <tr>
              <th className="px-3 py-2 text-left">Spiller</th>
              <th className="px-2 py-2 text-left">Pos</th>
              {th("now_cost", "Pris")}
              {th("xp", `xP (5 GW)`)}
              {th("form", "Form")}
              {th("total_points", "Poeng")}
              {th("xgi", "xGI")}
              {th("selected", "Eid %")}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-c/60">
            {rows.map((e) => (
              <tr key={e.id} className="hover:bg-panel-2/60">
                <td className="px-3 py-2">
                  <span className="font-medium">{e.web_name}</span>{" "}
                  <span className="text-xs text-muted">{teams.get(e.team)?.short_name}</span>
                  {e.status !== "a" && (
                    <span className="ml-1 text-xs" title={e.news}>
                      {e.status === "d" ? "⚠️" : "🤕"}
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 text-muted">{POSITION_NAMES[e.element_type]}</td>
                <td className="px-2 py-2 text-right font-mono">£{fmtPrice(e.now_cost)}</td>
                <td className="px-2 py-2 text-right font-mono text-accent">
                  {(xp.get(e.id)?.total ?? 0).toFixed(1)}
                </td>
                <td className="px-2 py-2 text-right font-mono">{e.form}</td>
                <td className="px-2 py-2 text-right font-mono">{e.total_points}</td>
                <td className="px-2 py-2 text-right font-mono">{e.expected_goal_involvements}</td>
                <td className="px-2 py-2 text-right font-mono">{e.selected_by_percent}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
