"use client";

import { useMemo } from "react";
import type { TeamData } from "@/lib/fpl";
import { teamFixtures } from "@/lib/xp";

const FDR_COLORS: Record<number, string> = {
  1: "bg-emerald-600 text-white",
  2: "bg-emerald-500/80 text-black",
  3: "bg-zinc-500 text-white",
  4: "bg-rose-500/90 text-white",
  5: "bg-rose-700 text-white",
};

export default function FixtureTicker({ data }: { data: TeamData }) {
  const nextEvent = data.bootstrap.events.find((e) => e.is_next)?.id ?? null;

  const gws = useMemo(() => {
    if (nextEvent == null) return [];
    const last = data.bootstrap.events.length;
    const out: number[] = [];
    for (let g = nextEvent; g < nextEvent + 5 && g <= last; g++) out.push(g);
    return out;
  }, [nextEvent, data.bootstrap.events.length]);

  const rows = useMemo(() => {
    return data.bootstrap.teams
      .map((team) => {
        const cells = gws.map((gw) => {
          const fx = teamFixtures(data.fixtures, team.id, gw);
          return fx.map((f) => {
            const home = f.team_h === team.id;
            const opp = data.bootstrap.teams.find(
              (t) => t.id === (home ? f.team_a : f.team_h)
            );
            const fdr = home ? f.team_h_difficulty : f.team_a_difficulty;
            return { label: `${opp?.short_name ?? "?"} (${home ? "H" : "B"})`, fdr };
          });
        });
        const avgFdr =
          cells.flat().reduce((s, c) => s + c.fdr, 0) / Math.max(1, cells.flat().length);
        return { team, cells, avgFdr };
      })
      .sort((a, b) => a.avgFdr - b.avgFdr);
  }, [data, gws]);

  if (nextEvent == null) {
    return <div className="card p-6 text-muted">Ingen kommende runder — sesongen er ferdig.</div>;
  }

  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="border-b border-border-c text-xs uppercase text-muted">
          <tr>
            <th className="px-3 py-2 text-left">Lag (lettest først)</th>
            {gws.map((g) => (
              <th key={g} className="px-2 py-2 text-center">
                GW{g}
              </th>
            ))}
            <th className="px-2 py-2 text-right">Snitt-FDR</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-c/60">
          {rows.map(({ team, cells, avgFdr }) => (
            <tr key={team.id}>
              <td className="px-3 py-2 font-medium">{team.name}</td>
              {cells.map((cell, i) => (
                <td key={i} className="px-1 py-1.5 text-center">
                  {cell.length === 0 ? (
                    <span className="inline-block w-full rounded bg-panel-2 px-1 py-1 text-xs text-muted">
                      BLANK
                    </span>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {cell.map((c, j) => (
                        <span
                          key={j}
                          className={`inline-block rounded px-1 py-1 text-xs font-semibold ${FDR_COLORS[c.fdr] ?? FDR_COLORS[3]}`}
                        >
                          {c.label}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
              ))}
              <td className="px-2 py-2 text-right font-mono text-muted">{avgFdr.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
