"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type TeamData } from "@/lib/fpl";
import type { EventLive, Fixture } from "@/lib/types";
import { matchMinute, provisionalBonus } from "@/lib/live";
import { ErrorBox, Skeleton, Badge } from "./ui";
import MatchModal from "./MatchModal";

const REFRESH_MS = 30_000;

export default function LiveTab({
  data,
  onSelect,
}: {
  data: TeamData;
  onSelect?: (el: import("@/lib/types").Element) => void;
}) {
  const [live, setLive] = useState<EventLive | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>(data.fixtures);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [bandSafety, setBandSafety] = useState<number | null>(null);
  const bandTried = useRef(false);
  const [matchOpen, setMatchOpen] = useState<Fixture | null>(null);

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

  // Personalised safety score: sample ~20 managers at the user's overall-rank
  // band (the Overall league is paged in rank order) and take the median of
  // their net live scores — the score needed to keep pace with your peers.
  useEffect(() => {
    if (bandTried.current || live == null || currentEvent == null) return;
    const rank = data.entry.summary_overall_rank;
    if (rank == null) return;
    bandTried.current = true;
    (async () => {
      try {
        const overallId =
          data.entry.leagues?.classic?.find((l) => l.name === "Overall")?.id ?? 314;
        const page = Math.max(1, Math.ceil(rank / 50));
        const standings = await api.league(overallId, page);
        // Spread the sample across the whole rank page for a fairer median.
        const all = standings.standings.results;
        const sample = all.filter((_, i) => i % Math.max(1, Math.floor(all.length / 20)) === 0).slice(0, 20);
        const pointsOf = new Map(live.elements.map((e) => [e.id, e.stats.total_points]));
        const scores = (
          await Promise.all(
            sample.map(async (r) => {
              try {
                const p = await api.picks(r.entry, currentEvent);
                const bb = p.active_chip === "bboost";
                let pts = 0;
                for (const pk of p.picks) {
                  const mult = bb && pk.multiplier === 0 ? 1 : pk.multiplier;
                  pts += (pointsOf.get(pk.element) ?? 0) * mult;
                }
                return pts - p.entry_history.event_transfers_cost;
              } catch {
                return null;
              }
            })
          )
        ).filter((x): x is number => x != null);
        if (scores.length >= 5) {
          scores.sort((a, b) => a - b);
          setBandSafety(scores[Math.floor(scores.length / 2)]);
        }
      } catch {}
    })();
  }, [live, currentEvent, data.entry]);

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

  const nextEventObj = data.bootstrap.events.find((e) => e.is_next);
  const seasonOver = currentEvent != null && nextEventObj == null;

  if (currentEvent == null || (error && seasonOver)) {
    return (
      <div className="card p-6 text-muted">
        <div className="text-2xl">🏖️</div>
        <div className="mt-2 font-semibold text-foreground">It&apos;s the off-season break.</div>
        <p className="mt-1 text-sm">
          {seasonOver
            ? `The season ended with GW${currentEvent}, and FPL has retired last season's live data while the new season is being set up. `
            : ""}
          The live view wakes up automatically on matchday
          {nextEventObj?.deadline_time
            ? ` — ${nextEventObj.name} kicks things off after the deadline on ${new Date(nextEventObj.deadline_time).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}.`
            : "."}
        </p>
      </div>
    );
  }
  if (error) return <ErrorBox message={error} />;
  if (!live || !data.squad) return <Skeleton className="h-64" />;

  const anyLive = gwFixtures.some((f) => f.started && !f.finished);
  const statById = new Map(live.elements.map((e) => [e.id, e.stats]));
  const bboost = data.squad.activeChip === "bboost";
  const hits = data.picks?.entry_history.event_transfers_cost ?? 0;

  // Effective captain: vice takes over once the GW is final and the captain
  // played 0 minutes (official rule). Triple Captain aware.
  const capMult = data.squad.activeChip === "3xc" ? 3 : 2;
  const cap = data.squad.players.find((p) => p.isCaptain);
  const vice = data.squad.players.find((p) => p.isViceCaptain);
  const effCapId =
    gwDone &&
    cap &&
    (statById.get(cap.element.id)?.minutes ?? 0) === 0 &&
    vice &&
    (statById.get(vice.element.id)?.minutes ?? 0) > 0
      ? vice.element.id
      : cap?.element.id;

  const rows = data.squad.players
    .map((p) => {
      const s = statById.get(p.element.id);
      const counts = p.pickPosition <= 11 || bboost;
      const mult = p.element.id === effCapId ? capMult : 1;
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

  const total = rows.reduce((sum, r) => sum + r.points, 0) - hits;
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
            {hits > 0 && (
              <span className="ml-2 text-sm font-semibold text-danger">(−{hits} hit)</span>
            )}
          </div>
        </div>
        <div className="text-sm text-muted">
          <div>Bench: {benchTotal} pts{bboost ? " (Bench Boost active)" : ""}</div>
          {gwAvg != null && <div>GW average: {gwAvg} pts</div>}
          {data.picks?.entry_history.rank != null && (
            <div>GW rank: {data.picks.entry_history.rank.toLocaleString("en-GB")}</div>
          )}
        </div>
        <div className="ml-auto text-right text-xs text-muted">
          {updatedAt && <div>Updated {updatedAt.toLocaleTimeString("en-GB")}</div>}
          <div>{gwDone ? "Gameweek complete — auto-refresh off" : "Auto-refresh every 30s"}</div>
          <button onClick={refresh} className="mt-1 rounded-md border border-border-c bg-panel-2 px-3 py-1 hover:border-accent">
            Refresh now
          </button>
        </div>

        {/* Safety score: median live score of ~20 managers at your overall-rank
            band when available; falls back to the GW average estimate. */}
        {(bandSafety ?? gwAvg) != null &&
          (() => {
            const needed = bandSafety ?? gwAvg!;
            const personalized = bandSafety != null;
            return (
              <div
                className={`w-full rounded-lg border px-3 py-2 text-sm ${
                  total >= needed
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-warn/40 bg-warn/10 text-warn"
                }`}
                title={
                  personalized
                    ? "Median live score of ~20 managers ranked right around you in the Overall league — match it to hold your rank"
                    : "Estimate based on the live gameweek average — a rank-band sample wasn't available"
                }
              >
                🛡️ Safety score {personalized ? "(your rank band)" : "(est.)"}:{" "}
                <b>{needed} pts</b> —{" "}
                {total >= needed
                  ? `you're ${total - needed} above; on course to climb ▲`
                  : `${needed - total} more needed to hold your rank`}
              </div>
            );
          })()}
      </div>

      {/* Match scores — two rows so twice as many fit on screen */}
      {gwFixtures.length > 0 && (
        <div className="grid grid-flow-col grid-rows-2 gap-1.5 overflow-x-auto pb-1 auto-cols-max">
          {gwFixtures.map((f) => {
            const minute = matchMinute(f, updatedAt ?? undefined);
            const liveNow = f.started && !f.finished;
            const hs = f.team_h_score ?? 0;
            const as = f.team_a_score ?? 0;
            // Result colors (live and FT): winner green, loser red, draw yellow.
            const hClass = !f.started
              ? ""
              : hs > as
                ? "text-accent"
                : hs < as
                  ? "text-danger"
                  : "text-warn";
            const aClass = !f.started
              ? ""
              : as > hs
                ? "text-accent"
                : as < hs
                  ? "text-danger"
                  : "text-warn";
            return (
              <button
                key={f.id}
                onClick={() => setMatchOpen(f)}
                className={`card flex min-w-28 cursor-pointer flex-col items-center px-2 py-1.5 text-xs hover:border-accent sm:min-w-32 sm:text-sm ${liveNow ? "border-accent/50" : ""}`}
              >
                <div className="flex items-center gap-1.5 font-semibold sm:gap-2">
                  <span className={hClass}>{teams.get(f.team_h)?.short_name}</span>
                  {f.started ? (
                    <span>
                      <span className={hClass}>{hs}</span>
                      <span className="text-muted">–</span>
                      <span className={aClass}>{as}</span>
                    </span>
                  ) : (
                    <span>v</span>
                  )}
                  <span className={aClass}>{teams.get(f.team_a)?.short_name}</span>
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
              </button>
            );
          })}
        </div>
      )}

      {matchOpen && (
        <MatchModal
          fixture={fixtures.find((f) => f.id === matchOpen.id) ?? matchOpen}
          teams={teams}
          live={live}
          squadIds={new Set(data.squad.players.map((p) => p.element.id))}
          elements={data.bootstrap.elements}
          onPlayerSelect={(el) => {
            setMatchOpen(null);
            onSelect?.(el);
          }}
          onClose={() => setMatchOpen(null)}
        />
      )}

      {/* Player rows */}
      <div className="card divide-y divide-border-c/60">
        {rows.map(({ p, stats, points, display, projBonus }) => (
          <div
            key={p.element.id}
            className={`flex items-center gap-3 px-4 py-2.5 text-sm ${onSelect ? "cursor-pointer hover:bg-panel-2/60" : ""}`}
            onClick={onSelect ? () => onSelect(p.element) : undefined}
            role={onSelect ? "button" : undefined}
          >
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
