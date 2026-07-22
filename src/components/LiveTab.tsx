"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type TeamData } from "@/lib/fpl";
import type { EventLive } from "@/lib/types";
import { ErrorBox, Skeleton, Badge } from "./ui";

export default function LiveTab({ data }: { data: TeamData }) {
  const [live, setLive] = useState<EventLive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const currentEvent =
    data.bootstrap.events.find((e) => e.is_current)?.id ?? data.squad?.currentEvent ?? null;

  const refresh = useCallback(async () => {
    if (currentEvent == null) return;
    try {
      const l = await api.live(currentEvent);
      setLive(l);
      setUpdatedAt(new Date());
      setError(null);
    } catch {
      setError("Could not fetch live data.");
    }
  }, [currentEvent]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh() only sets state after awaiting the network
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (currentEvent == null) {
    return <div className="card p-6 text-muted">No gameweek in progress right now.</div>;
  }
  if (error) return <ErrorBox message={error} />;
  if (!live || !data.squad) return <Skeleton className="h-64" />;

  const statById = new Map(live.elements.map((e) => [e.id, e.stats]));
  const rows = data.squad.players
    .map((p) => {
      const s = statById.get(p.element.id);
      const mult = p.isCaptain ? 2 : 1;
      return {
        p,
        stats: s,
        points: (s?.total_points ?? 0) * (p.pickPosition <= 11 ? mult : 0),
        rawPoints: s?.total_points ?? 0,
      };
    })
    .sort((a, b) => a.p.pickPosition - b.p.pickPosition);

  const total = rows.reduce((sum, r) => sum + r.points, 0);
  const benchTotal = rows.filter((r) => r.p.pickPosition > 11).reduce((s, r) => s + r.rawPoints, 0);

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-4 p-4">
        <div>
          <div className="text-xs uppercase text-muted">Live GW{currentEvent}</div>
          <div className="text-3xl font-bold text-accent">{total} pts</div>
        </div>
        <div className="text-sm text-muted">
          Bench: {benchTotal} pts
          {updatedAt && (
            <div className="text-xs">
              Updated {updatedAt.toLocaleTimeString("en-GB")} · auto-refresh 60s
            </div>
          )}
        </div>
        <button
          onClick={refresh}
          className="ml-auto rounded-lg border border-border-c bg-panel-2 px-4 py-2 text-sm hover:border-accent"
        >
          Refresh now
        </button>
      </div>

      <div className="card divide-y divide-border-c/60">
        {rows.map(({ p, stats, points, rawPoints }) => (
          <div key={p.element.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="w-6 text-xs text-muted">{p.pickPosition}</span>
            <span className="flex-1 font-medium">
              {p.element.web_name}
              {p.isCaptain && <Badge tone="green"> C </Badge>}
              {p.isViceCaptain && <Badge> V </Badge>}
              {p.pickPosition > 11 && <span className="ml-1 text-xs text-muted">(bench)</span>}
            </span>
            <span className="text-xs text-muted">
              {stats ? `${stats.minutes}' · ${stats.goals_scored}g ${stats.assists}a · bps ${stats.bps}` : "–"}
            </span>
            <span className="w-10 text-right font-mono font-bold">
              {p.pickPosition <= 11 ? points : rawPoints}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
