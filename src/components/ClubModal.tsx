"use client";

import type { Element, Fixture, Team } from "@/lib/types";
import { fmtPrice, POSITION_NAMES } from "@/lib/rules";
import { teamFixtures } from "@/lib/xp";
import { PlayerAvatar } from "./Pitch";
import Sheet, { SheetClose } from "./Sheet";

const FDR_BADGE: Record<number, string> = {
  1: "bg-emerald-600 text-white",
  2: "bg-emerald-500/90 text-black",
  3: "bg-zinc-500 text-white",
  4: "bg-rose-500/90 text-white",
  5: "bg-rose-700 text-white",
};

export default function ClubModal({
  team,
  elements,
  fixtures,
  teams,
  nextEvent,
  onPlayerSelect,
  onClose,
}: {
  team: Team;
  elements: Element[];
  fixtures: Fixture[];
  teams: Map<number, Team>;
  nextEvent: number | null;
  onPlayerSelect: (el: Element) => void;
  onClose: () => void;
}) {
  const squad = elements
    .filter((e) => e.team === team.id && e.status !== "u")
    .sort((a, b) => b.total_points - a.total_points || parseFloat(b.selected_by_percent) - parseFloat(a.selected_by_percent))
    .slice(0, 8);

  const upcoming: { gw: number; opp: string; home: boolean; fdr: number }[] = [];
  if (nextEvent != null) {
    for (let gw = nextEvent; gw < nextEvent + 5; gw++) {
      for (const f of teamFixtures(fixtures, team.id, gw)) {
        const home = f.team_h === team.id;
        upcoming.push({
          gw,
          opp: teams.get(home ? f.team_a : f.team_h)?.short_name ?? "?",
          home,
          fdr: home ? f.team_h_difficulty : f.team_a_difficulty,
        });
      }
    }
  }

  return (
    <Sheet onClose={onClose} labelledBy="club-modal-title" maxWidth="max-w-md">
      <div>
        <div className="flex items-center justify-between">
          <h2 id="club-modal-title" className="text-lg font-bold">{team.name}</h2>
          <SheetClose onClose={onClose} />
        </div>

        {upcoming.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {upcoming.map((u, i) => (
              <span
                key={i}
                className="flex items-center gap-1 rounded-lg bg-panel-2 px-1.5 py-1 text-[11px]"
              >
                <span className="text-muted">GW{u.gw}</span>
                <span className="font-semibold">
                  {u.opp} ({u.home ? "H" : "A"})
                </span>
                <span className={`rounded px-1 font-bold ${FDR_BADGE[u.fdr] ?? FDR_BADGE[3]}`}>
                  {u.fdr}
                </span>
              </span>
            ))}
          </div>
        )}

        <div className="mt-4 text-sm font-semibold">Top FPL assets</div>
        <div className="mt-1 divide-y divide-border-c/60">
          {squad.map((el) => (
            <button
              key={el.id}
              onClick={() => onPlayerSelect(el)}
              type="button"
              className="flex w-full items-center gap-2.5 px-1 py-2 text-left text-sm hover:bg-panel-2/60 active:bg-panel-2"
            >
              <PlayerAvatar el={el} teamShort={team.short_name} size="sm" center={false} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {el.web_name}
                  {el.status !== "a" && (
                    <span className="ml-1 text-xs" title={el.news}>
                      {el.status === "d" ? "⚠️" : "🤕"}
                    </span>
                  )}
                </span>
                <span className="block text-[11px] text-muted">
                  {POSITION_NAMES[el.element_type]} · £{fmtPrice(el.now_cost)}m ·{" "}
                  {el.selected_by_percent}% owned
                </span>
              </span>
              <span className="shrink-0 font-mono font-bold">{el.total_points}</span>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
