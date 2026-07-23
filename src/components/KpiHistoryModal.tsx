"use client";

import type { TeamData } from "@/lib/fpl";
import { CHIP_LABELS, fmtPrice, remainingChips } from "@/lib/rules";
import Sheet, { SheetClose } from "./Sheet";

export type KpiMetric = "points" | "rank" | "gw" | "value" | "transfers" | "chips";

const TITLES: Record<KpiMetric, string> = {
  points: "Total points by gameweek",
  rank: "Overall rank by gameweek",
  gw: "Gameweek scores",
  value: "Team value by gameweek",
  transfers: "Transfers by gameweek",
  chips: "Chips — used & remaining",
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

  const nameOf = new Map(data.bootstrap.elements.map((e) => [e.id, e.web_name]));
  const chipShort: Record<string, string> = {
    wildcard: "WC",
    freehit: "FH",
    bboost: "BB",
    "3xc": "TC",
  };

  // Transfers grouped by gameweek, newest first.
  const transfersByGw = new Map<number, typeof data.transfers>();
  for (const t of data.transfers) {
    const arr = transfersByGw.get(t.event);
    if (arr) arr.push(t);
    else transfersByGw.set(t.event, [t]);
  }
  const transferGws = [...transfersByGw.keys()].sort((a, b) => b - a);
  const hitAt = (gw: number) =>
    data.history.current.find((r) => r.event === gw)?.event_transfers_cost ?? 0;

  const usedChips = [...data.history.chips].sort((a, b) => b.event - a.event);
  const chipsRemaining = remainingChips(
    data.history.chips.map((c) => ({ name: c.name, event: c.event })),
    data.bootstrap.chips ?? null,
    data.squad?.nextEvent ?? null,
    "season"
  );
  const remainingCounts = new Map<string, number>();
  for (const c of chipsRemaining) {
    remainingCounts.set(c.name, (remainingCounts.get(c.name) ?? 0) + 1);
  }

  return (
    <Sheet onClose={onClose} labelledBy="kpi-modal-title" maxWidth="max-w-md">
      <div>
        <div className="flex items-center justify-between">
          <h2 id="kpi-modal-title" className="text-lg font-bold">{TITLES[metric]}</h2>
          <SheetClose onClose={onClose} />
        </div>

        {/* Transfer history: every move, gameweek by gameweek */}
        {metric === "transfers" &&
          (transferGws.length === 0 ? (
            <p className="mt-4 text-sm text-muted">
              No transfers made yet this season — the moves you make will show up here, round by
              round.
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              {transferGws.map((gw) => {
                const moves = transfersByGw.get(gw)!;
                const chip = chipAt(gw);
                const hit = chip ? 0 : hitAt(gw);
                return (
                  <div key={gw} className="rounded-lg border border-border-c bg-panel-2/50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="font-semibold">
                        GW{gw}
                        <span className="ml-1.5 font-normal text-muted">
                          · {moves.length} transfer{moves.length === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5 text-xs">
                        {chip && (
                          <span className="rounded bg-accent-2/15 px-1.5 py-0.5 font-bold text-accent-2">
                            {CHIP_LABELS[chip] ?? chip} — free
                          </span>
                        )}
                        {hit > 0 && <span className="font-semibold text-danger">−{hit} hit</span>}
                        {!chip && hit === 0 && <span className="text-muted">free</span>}
                      </span>
                    </div>
                    <div className="mt-2 space-y-1 text-sm">
                      {moves.map((m, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-x-1.5">
                          <span className="text-danger">
                            {nameOf.get(m.element_out) ?? `#${m.element_out}`} £
                            {fmtPrice(m.element_out_cost)}m
                          </span>
                          <span className="text-muted">→</span>
                          <span className="text-accent">
                            {nameOf.get(m.element_in) ?? `#${m.element_in}`} £
                            {fmtPrice(m.element_in_cost)}m
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

        {/* Chip usage: what was played when, and what's still in hand */}
        {metric === "chips" && (
          <div className="mt-3 space-y-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                Played this season
              </div>
              {usedChips.length === 0 ? (
                <p className="mt-1.5 text-sm text-muted">
                  No chips played yet — all of them are still in hand.
                </p>
              ) : (
                <div className="mt-1.5 space-y-1.5">
                  {usedChips.map((c, i) => {
                    const row = data.history.current.find((r) => r.event === c.event);
                    return (
                      <div
                        key={i}
                        className="flex items-center justify-between rounded-lg bg-panel-2 px-3 py-2 text-sm"
                      >
                        <span className="flex items-center gap-2">
                          <span className="rounded bg-accent-2/15 px-1.5 py-0.5 text-xs font-bold text-accent-2">
                            {chipShort[c.name] ?? c.name}
                          </span>
                          <span className="font-medium">{CHIP_LABELS[c.name] ?? c.name}</span>
                        </span>
                        <span className="text-xs text-muted">
                          GW{c.event}
                          {row && (
                            <span className="ml-1.5 font-mono text-foreground">{row.points} pts</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                Still available
              </div>
              {remainingCounts.size === 0 ? (
                <p className="mt-1.5 text-sm text-muted">All chips have been played. 🃏</p>
              ) : (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {[...remainingCounts.entries()].map(([name, count]) => (
                    <span
                      key={name}
                      className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent"
                    >
                      {CHIP_LABELS[name] ?? name}
                      {count > 1 ? ` ×${count}` : ""}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs text-muted">
                Chips come in two sets — one per half-season (split at GW19/20). Unused
                first-half chips don&apos;t carry over.
              </p>
            </div>
          </div>
        )}

        {metric === "transfers" || metric === "chips" ? null : rows.length === 0 ? (
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
