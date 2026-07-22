"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type TeamData } from "@/lib/fpl";
import type { EventLive, Fixture } from "@/lib/types";
import { matchMinute, provisionalBonus } from "@/lib/live";
import { ErrorBox, Skeleton, Badge } from "./ui";

const REFRESH_MS = 30_000;

export default function LiveTab({ data }: { data: TeamData }) {
  const [live, setLive] = useState<EventLive | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>(data.fixtures);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const currentEventObj = data.bootstrap.events.find((e) => e.is_current) ?? null;
  const currentEvent = currentEventObj?.id ?? data.squad?.currentEvent ?? null;

  const refresh = useCallback(async () => {
    if (currentEvent == null) return;
    try {
      const [l, fx] = await Promise.all([api.live(currentEvent), api.fixtures()]);
      setLive(l);
      setFixtures(fx);
      setUpdatedAt(new Date());
      setError(null);
    } catch {
      setError("Could not fetch live data.");
    }
  }, [currentEvent]);

  // One initial fetch (also shows final points after the GW is done).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh() only sets state after awaiting the network
    refresh();
  }, [refresh]);

  // Poll only while the gameweek can still change: not finished, and at least
  // one fixture not yet completed. Off-season and finished GWs stay quiet.
  const gwDone =
    currentEvent == null ||
    (currentEventObj?.finished ?? false) ||
    (fixtures.some((f) => f.event === currentEvent) &&
      fixtures.filter((f) => f.event === currentEvent).every((f) => f.finished));

  useEffect(() => {
    if (currentEvent == null || gwDone) return;
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh, currentEvent, gwDone]);

  const teams = useMemo(
    () => new Map(data.bootstrap.teams.map((t) => [t.id, t])),
    [data.bootstrap]
  );

  const gwFixtures = useMemo(
    () =>
      fixtures
        .filter((f) => f.event === currentEvent)
        .sort((a, b) => (a.kickoff_time ?? "").localeCompare(b.kickoff_time ?? "")),
    [fixtures, currentEvent]
  );

  const bonus = useMemo(
    () =>
      live && currentEvent != null
        ? provisionalBonus(data.bootstrap, fixtures, live, currentEvent)
        : null,
    [live, fixtures, data.bootstrap, currentEvent]
  );

  if (currentEvent == null) {
    const next = data.bootstrap.events.find((e) => e.is_next);
    return (
      <div className="card p-6 text-muted">
        <div className="text-2xl">🏖️</div>
        <div className="mt-2 font-semibold text-foreground">It&apos;s the off-season break.</div>
        <p className="mt-1 text-sm">
          The live view wakes up automatically on matchday
          {next?.deadline_time
            ? ` — ${next.name} kicks things off after the deadline on ${new Date(next.deadline_time).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}.`
            : "."}{" "}
          No live data is fetched until then.
        </p>
      </div>
    );
  }
  if (error) return <ErrorBox message={error} />;
  if (!live || !data.squad) return <Skeleton className="h-64" />;

  const anyLive = gwFixtures.some((f) => f.started && !f.finished);
  const statById = new Map(live.elements.map((e) => [e.id, e.stats]));
  const bboost = data.squad.activeChip === "bboost";

  const rows = data.squad.players
    .map((p) => {
      const s = statById.get(p.element.id);
      const counts = p.pickPosition <= 11 || bboost;
      const mult = p.isCaptain ? (data.squad!.activeChip === "3xc" ? 3 : 2) : 1;
      const raw = s?.total_points ?? 0;
      const proj = bonus?.byElement.get(p.element.id) ?? 0;
      return {
        p,
        stats: s,
        projBonus: proj,
        points: counts ? (raw + proj) * mult : 0,
        display: raw + proj,
      };
    })
    .sort((a, b) => a.p.pickPosition - b.p.pickPosition);

  const total = rows.reduce((sum, r) => sum + r.points, 0);
  const benchTotal = rows
    .filter((r) => r.p.pickPosition > 11)
    .reduce((s, r) => s + r.display, 0);
  const gwAvg =
    data.bootstrap.events.find((e) => e.id === currentEvent)?.average_entry_score ?? null;

  return (
    <div className="space-y-4">
      {/* Score header */}
      <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
            {anyLive && (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
            )}
            {anyLive ? "Live" : gwDone ? "Final — gameweek" : "Gameweek"} {currentEvent}
          </div>
          <div className="text-4xl font-bold text-accent">
            {total}
            <span className="ml-1 text-base font-medium text-muted">pts</span>
          </div>
        </div>
        <div className="text-sm text-muted">
          <div>Bench: {benchTotal} pts{bboost ? " (Bench Boost active)" : ""}</div>
          {gwAvg != null && <div>GW average: {gwAvg} pts</div>}
        </div>
        <div className="ml-auto text-right text-xs text-muted">
          {updatedAt && <div>Updated {updatedAt.toLocaleTimeString("en-GB")}</div>}
          <div>{gwDone ? "Gameweek complete — auto-refresh off" : "Auto-refresh every 30s"}</div>
          <button onClick={refresh} className="mt-1 rounded-md border border-border-c bg-panel-2 px-3 py-1 hover:border-accent">
            Refresh now
          </button>
        </div>
      </div>

      {/* Match scores */}
      {gwFixtures.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {gwFixtures.map((f) => {
            const minute = matchMinute(f, updatedAt ?? new Date(0));
            const liveNow = f.started && !f.finished;
            return (
              <div
                key={f.id}
                className={`card flex min-w-32 shrink-0 flex-col items-center px-3 py-2 text-sm ${liveNow ? "border-accent/50" : ""}`}
              >
                <div className="flex items-center gap-2 font-semibold">
                  <span>{teams.get(f.team_h)?.short_name}</span>
                  <span className={liveNow ? "text-accent" : ""}>
                    {f.started ? `${f.team_h_score ?? 0}–${f.team_a_score ?? 0}` : "v"}
                  </span>
                  <span>{teams.get(f.team_a)?.short_name}</span>
                </div>
                <div className={`text-xs ${liveNow ? "font-semibold text-accent" : "text-muted"}`}>
                  {f.started
                    ? minute
                    : f.kickoff_time
                      ? new Date(f.kickoff_time).toLocaleString("en-GB", {
                          weekday: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "TBC"}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Player rows */}
      <div className="card divide-y divide-border-c/60">
        {rows.map(({ p, stats, points, display, projBonus }) => (
          <div key={p.element.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="w-6 text-xs text-muted">{p.pickPosition}</span>
            <span className="flex-1 font-medium">
              {p.element.web_name}
              {p.isCaptain && <Badge tone="green"> C </Badge>}
              {p.isViceCaptain && <Badge> V </Badge>}
              {p.pickPosition > 11 && <span className="ml-1 text-xs text-muted">(bench)</span>}
              {projBonus > 0 && (
                <span className="ml-1.5 rounded bg-warn/15 px-1.5 py-0.5 text-[11px] font-semibold text-warn" title="Projected bonus from current BPS">
                  ★+{projBonus}
                </span>
              )}
            </span>
            <span className="hidden text-xs text-muted sm:inline">
              {stats
                ? `${stats.minutes}' · ${stats.goals_scored}g ${stats.assists}a · bps ${stats.bps}`
                : "–"}
            </span>
            <span className="w-10 text-right font-mono font-bold">
              {p.pickPosition <= 11 || bboost ? points : display}
            </span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted">
        ★ = projected bonus from live BPS (not confirmed until the match finishes). Captain
        doubling{data.squad.activeChip === "3xc" ? " (3x — Triple Captain active)" : ""} included
        in the total.
      </p>
    </div>
  );
}
