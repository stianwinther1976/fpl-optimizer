"use client";

import { useMemo, useState } from "react";
import type { TeamData } from "@/lib/fpl";
import type { Element, Team } from "@/lib/types";
import { teamFixtures } from "@/lib/xp";
import ClubModal from "./ClubModal";

const FDR_COLORS: Record<number, string> = {
  1: "bg-emerald-600 text-white",
  2: "bg-emerald-500/80 text-black",
  3: "bg-zinc-500 text-white",
  4: "bg-rose-500/90 text-white",
  5: "bg-rose-700 text-white",
};

export default function FixtureTicker({
  data,
  onSelect,
}: {
  data: TeamData;
  onSelect?: (el: Element) => void;
}) {
  const [clubOpen, setClubOpen] = useState<Team | null>(null);
  const teamsMap = useMemo(
    () => new Map(data.bootstrap.teams.map((t) => [t.id, t])),
    [data.bootstrap]
  );
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
            return { label: `${opp?.short_name ?? "?"} (${home ? "H" : "A"})`, fdr };
          });
        });
        const avgFdr =
          cells.flat().reduce((s, c) => s + c.fdr, 0) / Math.max(1, cells.flat().length);
        return { team, cells, avgFdr };
      })
      .sort((a, b) => a.avgFdr - b.avgFdr);
  }, [data, gws]);

  if (nextEvent == null) {
    return <div className="card p-6 text-muted">No upcoming gameweeks — the season is over.</div>;
  }

  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="border-b border-border-c text-xs uppercase text-muted">
          <tr>
            <th className="sticky left-0 z-10 bg-[var(--panel)] px-3 py-2 text-left">
              Team (easiest first)
            </th>
            {gws.map((g) => (
              <th key={g} className="px-2 py-2 text-center">
                GW{g}
              </th>
            ))}
            <th className="px-2 py-2 text-right">Avg FDR</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-c/60">
          {rows.map(({ team, cells, avgFdr }) => (
            <tr key={team.id}>
              <td className="sticky left-0 z-10 bg-[var(--panel)] px-3 py-2 font-medium">
                <button
                  onClick={() => setClubOpen(team)}
                  className="hover:text-accent"
                  title="Club details and top FPL assets"
                >
                  {team.name} <span className="text-xs text-muted">›</span>
                </button>
              </td>
              {cells.map((cell, i) => (
                <td key={i} className="px-1 py-1.5 text-center">
                  {cell.length === 0 ? (
                    <span className="flex h-7 w-full items-center justify-center whitespace-nowrap rounded bg-panel-2 px-1 text-[11px] text-muted">
                      BLANK
                    </span>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {cell.map((c, j) => (
                        <span
                          key={j}
                          className={`flex h-7 w-full items-center justify-center whitespace-nowrap rounded px-1 text-[11px] font-semibold ${FDR_COLORS[c.fdr] ?? FDR_COLORS[3]}`}
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

      {clubOpen && (
        <ClubModal
          team={clubOpen}
          elements={data.bootstrap.elements}
          fixtures={data.fixtures}
          teams={teamsMap}
          nextEvent={nextEvent}
          onPlayerSelect={(el) => {
            setClubOpen(null);
            onSelect?.(el);
          }}
          onClose={() => setClubOpen(null)}
        />
      )}
    </div>
  );
}
