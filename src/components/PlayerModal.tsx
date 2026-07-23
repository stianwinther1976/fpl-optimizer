"use client";

import type { Element, EventLive, Fixture, Team } from "@/lib/types";
import { fmtPrice, POSITION_NAMES } from "@/lib/rules";
import { teamFixtures } from "@/lib/xp";
import { Badge } from "./ui";
import { PlayerAvatar } from "./Pitch";

const FDR_BADGE: Record<number, string> = {
  1: "bg-emerald-600 text-white",
  2: "bg-emerald-500/90 text-black",
  3: "bg-zinc-500 text-white",
  4: "bg-rose-500/90 text-white",
  5: "bg-rose-700 text-white",
};

const STAT_LABELS: Record<string, string> = {
  minutes: "Minutes played",
  goals_scored: "Goals scored",
  assists: "Assists",
  clean_sheets: "Clean sheet",
  goals_conceded: "Goals conceded",
  own_goals: "Own goals",
  penalties_saved: "Penalties saved",
  penalties_missed: "Penalties missed",
  saves: "Saves",
  yellow_cards: "Yellow card",
  red_cards: "Red card",
  bonus: "Bonus",
  defensive_contribution: "Defensive contribution",
};

export default function PlayerModal({
  element,
  team,
  live,
  event,
  gwFinished,
  onClose,
  fixtures = [],
  teams,
  nextEvent = null,
}: {
  element: Element;
  team: Team | undefined;
  live: EventLive | null;
  event: number | null;
  gwFinished: boolean;
  onClose: () => void;
  fixtures?: Fixture[];
  teams?: Map<number, Team>;
  nextEvent?: number | null;
}) {
  // Next three gameweeks of fixtures for this player's club.
  const upcoming: { gw: number; opp: string; home: boolean; fdr: number }[] = [];
  if (nextEvent != null && teams) {
    for (let gw = nextEvent; gw < nextEvent + 3; gw++) {
      for (const f of teamFixtures(fixtures, element.team, gw)) {
        const home = f.team_h === element.team;
        upcoming.push({
          gw,
          opp: teams.get(home ? f.team_a : f.team_h)?.short_name ?? "?",
          home,
          fdr: home ? f.team_h_difficulty : f.team_a_difficulty,
        });
      }
    }
  }
  const liveEl = live?.elements.find((e) => e.id === element.id) ?? null;
  const rows =
    liveEl?.explain?.flatMap((fx) => fx.stats).filter((s) => s.points !== 0 || s.identifier === "minutes") ??
    [];
  const total = liveEl?.stats.total_points ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="card w-full max-w-md rounded-b-none rounded-t-2xl p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <PlayerAvatar el={element} teamShort={team?.short_name} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-bold">
              {element.first_name} {element.second_name}
            </div>
            <div className="text-sm text-muted">
              {team?.name} · {POSITION_NAMES[element.element_type]} · £{fmtPrice(element.now_cost)}m
            </div>
            {element.news && <div className="mt-1 text-xs text-warn">{element.news}</div>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border border-border-c bg-panel-2 px-2.5 py-1 text-sm hover:border-accent"
          >
            ✕
          </button>
        </div>

        {/* GW point breakdown */}
        {event != null && liveEl && (
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">
                GW{event} points
                <span className="ml-2">
                  {gwFinished ? <Badge>Final</Badge> : <Badge tone="green">Live</Badge>}
                </span>
              </div>
              <div className={`text-xl font-bold ${gwFinished ? "" : "text-accent"}`}>
                {total} pts
              </div>
            </div>
            {rows.length > 0 ? (
              <table className="mt-2 w-full text-sm">
                <tbody className="divide-y divide-border-c/60">
                  {rows.map((s, i) => (
                    <tr key={i}>
                      <td className="py-1.5">{STAT_LABELS[s.identifier] ?? s.identifier}</td>
                      <td className="py-1.5 text-right font-mono text-muted">{s.value}</td>
                      <td
                        className={`w-14 py-1.5 text-right font-mono font-semibold ${
                          s.points > 0 ? "text-accent" : s.points < 0 ? "text-danger" : "text-muted"
                        }`}
                      >
                        {s.points > 0 ? `+${s.points}` : s.points}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-2 text-sm text-muted">No point-scoring actions yet.</p>
            )}
          </div>
        )}

        {/* Upcoming fixtures (next 3 GWs, like the official FPL view) */}
        {upcoming.length > 0 && (
          <div className="mt-4">
            <div className="text-sm font-semibold">Upcoming fixtures</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {upcoming.map((u, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1.5 rounded-lg bg-panel-2 px-2 py-1.5 text-xs"
                >
                  <span className="text-muted">GW{u.gw}</span>
                  <span className="font-semibold">
                    {u.opp} ({u.home ? "H" : "A"})
                  </span>
                  <span className={`rounded px-1 font-bold ${FDR_BADGE[u.fdr] ?? FDR_BADGE[3]}`}>
                    {u.fdr}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Season stats */}
        <div className="mt-4">
          <div className="text-sm font-semibold">Season</div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            {[
              ["Points", String(element.total_points)],
              ["Form", element.form],
              ["Owned", `${element.selected_by_percent}%`],
              ["Goals", String(element.goals_scored)],
              ["Assists", String(element.assists)],
              ["xGI", element.expected_goal_involvements],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-panel-2 px-2 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
                <div className="font-mono font-semibold">{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
