"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type TeamData } from "@/lib/fpl";
import type { EventLive, LeagueStandings } from "@/lib/types";
import { CHIP_LABELS } from "@/lib/rules";
import { ErrorBox, Skeleton, Badge } from "./ui";

const MAX_RIVAL_DETAILS = 20;

interface RivalDetail {
  captain: string | null;
  viceCaptain: string | null;
  chip: string | null;
  livePoints: number | null; // incl. hits (net)
  hits: number;
}

export default function MiniLeague({ data, entryId }: { data: TeamData; entryId: number }) {
  const [leagueId, setLeagueId] = useState("");
  const [standings, setStandings] = useState<LeagueStandings | null>(null);
  const [details, setDetails] = useState<Map<number, RivalDetail>>(new Map());
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentEvent =
    data.bootstrap.events.find((e) => e.is_current)?.id ?? data.squad?.currentEvent ?? null;

  const elementName = useMemo(
    () => new Map(data.bootstrap.elements.map((e) => [e.id, e.web_name])),
    [data.bootstrap]
  );

  // The user's own leagues straight from the FPL entry — no manual IDs needed.
  const myLeagues = useMemo(() => {
    const classic = data.entry.leagues?.classic ?? [];
    return [...classic].sort((a, b) => {
      const ap = a.league_type === "x" ? 0 : 1; // private mini-leagues first
      const bp = b.league_type === "x" ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    });
  }, [data.entry]);

  useEffect(() => {
    const saved = localStorage.getItem("fpl-league-id");
    const initial =
      (saved && myLeagues.some((l) => String(l.id) === saved) ? saved : null) ??
      (myLeagues[0] ? String(myLeagues[0].id) : saved);
    if (initial) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring persisted selection on mount
      setLeagueId(initial);
      load(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(idStr?: string) {
    const num = parseInt(idStr ?? leagueId, 10);
    if (!num) {
      setError("Enter a league ID (the number in the URL on the league page).");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const s = await api.league(num);
      setStandings(s);
      localStorage.setItem("fpl-league-id", String(num));
      loadDetails(s);
    } catch {
      setError("League not found — check the ID.");
    } finally {
      setLoading(false);
    }
  }

  async function loadDetails(s: LeagueStandings) {
    if (currentEvent == null) return;
    setDetailsLoading(true);
    try {
      const rivals = s.standings.results.slice(0, MAX_RIVAL_DETAILS);
      const live: EventLive = await api.live(currentEvent);
      const pointsOf = new Map(live.elements.map((e) => [e.id, e.stats.total_points]));
      const results = await Promise.all(
        rivals.map(async (r) => {
          try {
            const picks = await api.picks(r.entry, currentEvent);
            const bboost = picks.active_chip === "bboost";
            let pts = 0;
            for (const p of picks.picks) {
              const mult = bboost && p.multiplier === 0 ? 1 : p.multiplier;
              pts += (pointsOf.get(p.element) ?? 0) * mult;
            }
            const hits = picks.entry_history.event_transfers_cost;
            const cap = picks.picks.find((p) => p.is_captain);
            const vice = picks.picks.find((p) => p.is_vice_captain);
            const detail: RivalDetail = {
              captain: cap ? (elementName.get(cap.element) ?? null) : null,
              viceCaptain: vice ? (elementName.get(vice.element) ?? null) : null,
              chip: picks.active_chip,
              livePoints: pts - hits,
              hits,
            };
            return [r.entry, detail] as const;
          } catch {
            return null;
          }
        })
      );
      setDetails(new Map(results.filter((x): x is NonNullable<typeof x> => x != null)));
    } finally {
      setDetailsLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-3 p-4">
        {myLeagues.length > 0 ? (
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Your leagues
            </div>
            <div className="flex flex-wrap gap-2">
              {myLeagues
                .filter((l) => l.league_type === "x")
                .map((l) => (
                  <button
                    key={l.id}
                    onClick={() => {
                      setLeagueId(String(l.id));
                      load(String(l.id));
                    }}
                    className={`rounded-full border px-3 py-1.5 text-sm ${
                      String(l.id) === leagueId
                        ? "border-accent bg-accent/15 font-semibold text-accent"
                        : "border-border-c bg-panel-2 hover:border-accent"
                    }`}
                  >
                    {l.name}
                    {l.entry_rank != null && (
                      <span className="ml-1.5 text-xs opacity-70">#{l.entry_rank}</span>
                    )}
                  </button>
                ))}
            </div>
            {myLeagues.some((l) => l.league_type !== "x") && (
              <select
                value={
                  myLeagues.some((l) => String(l.id) === leagueId && l.league_type !== "x")
                    ? leagueId
                    : ""
                }
                onChange={(e) => {
                  if (e.target.value) {
                    setLeagueId(e.target.value);
                    load(e.target.value);
                  }
                }}
                className="mt-2 w-full rounded-lg border border-border-c bg-panel-2 px-3 py-2 text-sm sm:w-auto"
              >
                <option value="">Public leagues (Overall, country, club …)</option>
                {myLeagues
                  .filter((l) => l.league_type !== "x")
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                      {l.entry_rank != null ? ` — #${l.entry_rank.toLocaleString("en-GB")}` : ""}
                    </option>
                  ))}
              </select>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted">
            No leagues found on this FPL account yet.
          </div>
        )}
        <details className="text-xs text-muted">
          <summary className="cursor-pointer hover:text-accent">Enter a league ID manually</summary>
          <div className="mt-2 flex gap-2">
            <input
              value={leagueId}
              onChange={(e) => setLeagueId(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && load()}
              placeholder="League ID (classic league)"
              className="min-w-0 flex-1 rounded-lg bg-panel-2 border border-border-c px-3 py-2 text-sm"
            />
            <button
              onClick={() => load()}
              disabled={loading}
              className="btn-primary shrink-0 rounded-lg px-4 py-2 text-sm disabled:opacity-50"
            >
              {loading ? "Loading…" : "Load"}
            </button>
          </div>
        </details>
      </div>

      {error && <ErrorBox message={error} />}
      {loading && <Skeleton className="h-64" />}

      {standings && !loading && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border-c px-4 py-3">
            <span className="font-semibold">{standings.league.name}</span>
            {detailsLoading && (
              <span className="text-xs text-muted">Loading rival details…</span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-xs uppercase text-muted">
                <tr className="border-b border-border-c">
                  <th className="sticky left-0 z-10 w-12 bg-[var(--panel)] px-3 py-2 text-left">#</th>
                  <th className="sticky left-12 z-10 bg-[var(--panel)] px-2 py-2 text-left">Team</th>
                  <th className="px-2 py-2 text-left">Captain</th>
                  <th className="px-2 py-2 text-left">Chip</th>
                  <th className="px-2 py-2 text-right" title="Live gameweek points minus transfer hits">
                    GW (live)
                  </th>
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-c/60">
                {standings.standings.results.map((r) => {
                  const d = details.get(r.entry);
                  return (
                    <tr
                      key={r.entry}
                      className={r.entry === entryId ? "bg-accent/10" : "hover:bg-panel-2/60"}
                    >
                      <td className="sticky left-0 z-10 w-12 bg-[var(--panel)] px-3 py-2 font-mono">
                        {r.rank}
                        {r.last_rank > 0 && r.last_rank !== r.rank && (
                          <span className={r.rank < r.last_rank ? "text-accent" : "text-danger"}>
                            {r.rank < r.last_rank ? " ▲" : " ▼"}
                          </span>
                        )}
                      </td>
                      <td className="sticky left-12 z-10 bg-[var(--panel)] px-2 py-2">
                        <div className="font-medium">{r.entry_name}</div>
                        <div className="text-xs text-muted">{r.player_name}</div>
                      </td>
                      <td className="px-2 py-2">
                        {d?.captain ?? "–"}
                        {d?.viceCaptain && (
                          <span className="text-xs text-muted"> ({d.viceCaptain})</span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {d?.chip ? (
                          <Badge tone="purple">{CHIP_LABELS[d.chip] ?? d.chip}</Badge>
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        {d?.livePoints ?? r.event_total}
                        {d && d.hits > 0 && (
                          <span className="text-xs text-danger"> (−{d.hits})</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-bold">{r.total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {standings.standings.results.length > MAX_RIVAL_DETAILS && (
            <div className="border-t border-border-c px-4 py-2 text-xs text-muted">
              Captain/chip/live details shown for the top {MAX_RIVAL_DETAILS} teams.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
