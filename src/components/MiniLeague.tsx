"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/fpl";
import type { LeagueStandings } from "@/lib/types";
import { ErrorBox, Skeleton } from "./ui";

export default function MiniLeague({ entryId }: { entryId: number }) {
  const [leagueId, setLeagueId] = useState("");
  const [standings, setStandings] = useState<LeagueStandings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("fpl-league-id");
    if (saved) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring persisted input on mount
      setLeagueId(saved);
      load(saved);
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
    } catch {
      setError("League not found — check the ID.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-2 p-4">
        <input
          value={leagueId}
          onChange={(e) => setLeagueId(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && load()}
          placeholder="League ID (classic league)"
          className="flex-1 min-w-40 rounded-lg bg-panel-2 border border-border-c px-3 py-2 text-sm"
        />
        <button
          onClick={() => load()}
          disabled={loading}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load standings"}
        </button>
      </div>

      {error && <ErrorBox message={error} />}
      {loading && <Skeleton className="h-64" />}

      {standings && !loading && (
        <div className="card overflow-hidden">
          <div className="border-b border-border-c px-4 py-3 font-semibold">
            {standings.league.name}
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted">
              <tr className="border-b border-border-c">
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-2 py-2 text-left">Team</th>
                <th className="px-2 py-2 text-right">GW</th>
                <th className="px-3 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-c/60">
              {standings.standings.results.map((r) => (
                <tr
                  key={r.entry}
                  className={r.entry === entryId ? "bg-accent/10" : "hover:bg-panel-2/60"}
                >
                  <td className="px-3 py-2 font-mono">
                    {r.rank}
                    {r.last_rank > 0 && r.last_rank !== r.rank && (
                      <span className={r.rank < r.last_rank ? "text-accent" : "text-danger"}>
                        {r.rank < r.last_rank ? " ▲" : " ▼"}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <div className="font-medium">{r.entry_name}</div>
                    <div className="text-xs text-muted">{r.player_name}</div>
                  </td>
                  <td className="px-2 py-2 text-right font-mono">{r.event_total}</td>
                  <td className="px-3 py-2 text-right font-mono font-bold">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
