"use client";

import type { TeamData } from "@/lib/fpl";
import { fmtPrice } from "@/lib/rules";
import Sheet, { SheetClose } from "./Sheet";

export type KpiMetric = "points" | "rank" | "gw" | "value";

const TITLES: Record<KpiMetric, string> = {
  points: "Total points by gameweek",
  rank: "Overall rank by gameweek",
  gw: "Gameweek scores",
  value: "Team value by gameweek",
};

export default function KpiHistoryModal({
  metric,
  data,
  onClose,
}: {
  metric: KpiMetric;
  data: TeamData;
  onClose: () => void;
}) {
  const rows = [...data.history.current].sort((a, b) => b.event - a.event);
  const avgOf = (gw: number) =>
    data.bootstrap.events.find((e) => e.id === gw)?.average_entry_score ?? null;
  const chipAt = (gw: number) => data.history.chips.find((c) => c.event === gw)?.name ?? null;

  const num = (n: number) => n.toLocaleString("en-GB");
  const signed = (n: number) => (n > 0 ? `+${num(n)}` : num(n));

  return (
    <Sheet onClose={onClose} labelledBy="kpi-modal-title" maxWidth="max-w-md">
      <div>
        <div className="flex items-center justify-between">
          <h2 id="kpi-modal-title" className="text-lg font-bold">{TITLES[metric]}</h2>
          <SheetClose onClose={onClose} />
        </div>

        {rows.length === 0 ? (
          <p className="mt-4 text-sm text-muted">No gameweeks played yet this season.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="border-b border-border-c text-xs uppercase text-muted">
              <tr>
                <th className="px-1.5 py-1.5 text-left">GW</th>
                {metric === "points" && (
                  <>
                    <th className="px-1.5 py-1.5 text-right">Pts</th>
                    <th className="px-1.5 py-1.5 text-right">Total</th>
                  </>
                )}
                {metric === "rank" && (
                  <>
                    <th className="px-1.5 py-1.5 text-right">Overall rank</th>
                    <th className="px-1.5 py-1.5 text-right">Change</th>
                  </>
                )}
                {metric === "gw" && (
                  <>
                    <th className="px-1.5 py-1.5 text-right">Pts</th>
                    <th className="px-1.5 py-1.5 text-right">Avg</th>
                    <th className="px-1.5 py-1.5 text-right">± Avg</th>
                  </>
                )}
                {metric === "value" && (
                  <>
                    <th className="px-1.5 py-1.5 text-right">Value</th>
                    <th className="px-1.5 py-1.5 text-right">Change</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-c/60">
              {rows.map((r, i) => {
                const prev = rows[i + 1] ?? null; // previous gameweek (rows are desc)
                const chip = chipAt(r.event);
                const chipShort: Record<string, string> = {
                  wildcard: "WC",
                  freehit: "FH",
                  bboost: "BB",
                  "3xc": "TC",
                };
                return (
                  <tr key={r.event}>
                    <td className="px-1.5 py-1.5 font-mono text-xs">
                      {r.event}
                      {chip && (
                        <span className="ml-1 rounded bg-accent-2/15 px-1 py-px text-[9px] font-bold text-accent-2">
                          {chipShort[chip] ?? chip}
                        </span>
                      )}
                      {r.event_transfers_cost > 0 && metric === "gw" && (
                        <span className="ml-1 text-[10px] text-danger">−{r.event_transfers_cost}</span>
                      )}
                    </td>

                    {metric === "points" && (
                      <>
                        <td className="px-1.5 py-1.5 text-right font-mono">{r.points}</td>
                        <td className="px-1.5 py-1.5 text-right font-mono font-bold">
                          {num(r.total_points)}
                        </td>
                      </>
                    )}

                    {metric === "rank" &&
                      (() => {
                        const diff =
                          prev?.overall_rank != null && r.overall_rank != null
                            ? prev.overall_rank - r.overall_rank // positive = climbed
                            : null;
                        return (
                          <>
                            <td className="px-1.5 py-1.5 text-right font-mono">
                              {r.overall_rank != null ? num(r.overall_rank) : "–"}
                            </td>
                            <td
                              className={`px-1.5 py-1.5 text-right font-mono text-xs ${
                                diff == null || diff === 0
                                  ? "text-muted"
                                  : diff > 0
                                    ? "text-accent"
                                    : "text-danger"
                              }`}
                            >
                              {diff == null ? "–" : `${diff > 0 ? "▲" : diff < 0 ? "▼" : ""} ${num(Math.abs(diff))}`}
                            </td>
                          </>
                        );
                      })()}

                    {metric === "gw" &&
                      (() => {
                        const avg = avgOf(r.event);
                        const diff = avg != null ? r.points - avg : null;
                        return (
                          <>
                            <td className="px-1.5 py-1.5 text-right font-mono font-bold">{r.points}</td>
                            <td className="px-1.5 py-1.5 text-right font-mono text-muted">
                              {avg ?? "–"}
                            </td>
                            <td
                              className={`px-1.5 py-1.5 text-right font-mono text-xs ${
                                diff == null || diff === 0
                                  ? "text-muted"
                                  : diff > 0
                                    ? "text-accent"
                                    : "text-danger"
                              }`}
                            >
                              {diff == null ? "–" : signed(diff)}
                            </td>
                          </>
                        );
                      })()}

                    {metric === "value" &&
                      (() => {
                        const cur = r.value + r.bank;
                        const prevVal = prev ? prev.value + prev.bank : null;
                        const diff = prevVal != null ? cur - prevVal : null;
                        return (
                          <>
                            <td className="px-1.5 py-1.5 text-right font-mono">£{fmtPrice(cur)}m</td>
                            <td
                              className={`px-1.5 py-1.5 text-right font-mono text-xs ${
                                diff == null || diff === 0
                                  ? "text-muted"
                                  : diff > 0
                                    ? "text-accent"
                                    : "text-danger"
                              }`}
                            >
                              {diff == null ? "–" : `${diff > 0 ? "+" : "−"}£${fmtPrice(Math.abs(diff))}m`}
                            </td>
                          </>
                        );
                      })()}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Sheet>
  );
}
