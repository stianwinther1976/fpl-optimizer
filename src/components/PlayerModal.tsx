"use client";

import type { Element, EventLive, Team } from "@/lib/types";
import { fmtPrice, POSITION_NAMES } from "@/lib/rules";
import { Badge } from "./ui";
import { PlayerAvatar } from "./Pitch";

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
}: {
  element: Element;
  team: Team | undefined;
  live: EventLive | null;
  event: number | null;
  gwFinished: boolean;
  onClose: () => void;
}) {
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
