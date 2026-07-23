"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, FplApiError, loadTeamData, fmtRank, DEMO_ENTRY_ID, type TeamData } from "@/lib/fpl";
import type { Element, EventLive } from "@/lib/types";
import { fmtPrice, remainingChips } from "@/lib/rules";
import { projectAll } from "@/lib/xp";
import PlayerModal from "./PlayerModal";
import KpiHistoryModal, { type KpiMetric } from "./KpiHistoryModal";
import Pitch from "./Pitch";
import OptimizePanel from "./OptimizePanel";
import StatsTable from "./StatsTable";
import FixtureTicker from "./FixtureTicker";
import HistoryChart from "./HistoryChart";
import LiveTab from "./LiveTab";
import MiniLeague from "./MiniLeague";
import ThemeToggle from "./ThemeToggle";
import { ErrorBox, Skeleton, Stat, type StatDelta } from "./ui";

const TABS = [
  ["team", "My team", "Team"],
  ["optimize", "Optimize", "Optimize"],
  ["stats", "Stats", "Stats"],
  ["fixtures", "Fixtures", "Fixtures"],
  ["live", "Live", "Live"],
  ["league", "Mini-league", "League"],
  ["history", "History", "History"],
] as const;

type TabKey = (typeof TABS)[number][0];

/** Comparison window for the KPI deltas: 1 = previous gameweek. */
const COMPARE_GWS = 1;

function DeadlineChip({
  nextEvent,
  deadline,
}: {
  nextEvent: number;
  deadline: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  let countdown: string | null = null;
  let urgent = false;
  if (deadline) {
    const ms = new Date(deadline).getTime() - now;
    if (ms > 0) {
      const d = Math.floor(ms / 86_400_000);
      const h = Math.floor((ms % 86_400_000) / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      countdown = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
      urgent = ms < 24 * 3_600_000;
    }
  }
  return (
    <div
      className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
        urgent
          ? "border-warn/50 bg-warn/10 text-warn"
          : "border-accent/40 bg-accent/10 text-accent"
      }`}
    >
      GW{nextEvent} deadline{countdown ? `: ${countdown}` : ""}
      {deadline && (
        <span className="ml-1 hidden font-normal opacity-75 sm:inline">
          (
          {new Date(deadline).toLocaleString("en-GB", {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
          )
        </span>
      )}
    </div>
  );
}

export default function Dashboard({
  entryId,
  initialTab,
}: {
  entryId: number;
  initialTab?: string;
}) {
  const [data, setData] = useState<TeamData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveData, setLiveData] = useState<EventLive | null>(null);
  const [selected, setSelected] = useState<Element | null>(null);
  const [kpiModal, setKpiModal] = useState<KpiMetric | null>(null);
  const [tab, setTab] = useState<TabKey>(
    TABS.some(([k]) => k === initialTab) ? (initialTab as TabKey) : "team"
  );

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset view when entryId changes
    setData(null);
    setError(null);
    loadTeamData(entryId)
      .then((d) => !cancelled && setData(d))
      .catch((e) =>
        !cancelled &&
        setError(e instanceof FplApiError ? e.message : "Could not load this team.")
      );
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  const teams = useMemo(
    () => (data ? new Map(data.bootstrap.teams.map((t) => [t.id, t])) : new Map()),
    [data]
  );

  const currentEventObj = data?.bootstrap.events.find((e) => e.is_current) ?? null;
  const currentEvent = currentEventObj?.id ?? data?.squad?.currentEvent ?? null;
  const gwFinished =
    (currentEventObj?.finished ?? false) ||
    (currentEvent != null &&
      data != null &&
      data.fixtures.some((f) => f.event === currentEvent) &&
      data.fixtures.filter((f) => f.event === currentEvent).every((f) => f.finished));

  // One live fetch for the pitch view + player breakdowns (skipped off-season).
  useEffect(() => {
    if (currentEvent == null) return;
    let cancelled = false;
    api
      .live(currentEvent)
      .then((l) => !cancelled && setLiveData(l))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentEvent]);

  const livePointsOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of liveData?.elements ?? []) m.set(e.id, e.stats.total_points);
    return m;
  }, [liveData]);

  // xP for the pitch view's "xP" mode (next gameweek).
  const xpOf = useMemo(() => {
    const nextEv = data?.bootstrap.events.find((e) => e.is_next)?.id ?? null;
    if (!data || nextEv == null) return null;
    return projectAll({ bootstrap: data.bootstrap, fixtures: data.fixtures, nextEvent: nextEv });
  }, [data]);

  const liveMinutesOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of liveData?.elements ?? []) m.set(e.id, e.stats.minutes);
    return m;
  }, [liveData]);

  // Effective captain: Triple Captain aware; once the GW is final, the vice
  // takes over if the captain played 0 minutes (official rule).
  const capMult = data?.squad?.activeChip === "3xc" ? 3 : 2;
  const effCaptainId = useMemo(() => {
    const squad = data?.squad;
    if (!squad) return null;
    const cap = squad.players.find((p) => p.isCaptain);
    const vice = squad.players.find((p) => p.isViceCaptain);
    if (
      gwFinished &&
      cap &&
      (liveMinutesOf.get(cap.element.id) ?? 0) === 0 &&
      vice &&
      (liveMinutesOf.get(vice.element.id) ?? 0) > 0
    ) {
      return vice.element.id;
    }
    return cap?.element.id ?? null;
  }, [data, gwFinished, liveMinutesOf]);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-16">
        <ErrorBox message={error} />
        <Link href="/" className="mt-4 inline-block text-accent hover:underline">
          ← Try another FPL ID
        </Link>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 space-y-4 px-4 py-8">
        <Skeleton className="h-24" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </main>
    );
  }

  const { entry, squad, history } = data;
  const rows = history.current;
  const curr = rows.length > 0 ? rows[rows.length - 1] : null;
  const past =
    curr != null
      ? (rows.find((r) => r.event === curr.event - COMPARE_GWS) ?? rows[0])
      : null;
  const comparable = curr != null && past != null && past.event < curr.event;
  const period = comparable ? `vs GW${past.event}` : "";

  const fmtSigned = (n: number, digits = 0) =>
    `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toLocaleString("en-GB", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}`;

  // Total points: points added since the comparison GW. Cumulative — adding
  // points is always good (the pace comparison lives on the Latest GW card).
  let pointsDelta: StatDelta | null = null;
  if (comparable) {
    const gained = curr.total_points - past.total_points;
    pointsDelta = {
      text: `${fmtSigned(gained)} pts`,
      period,
      good: gained > 0 ? true : null,
      direction: "up",
    };
  }

  // Overall rank: falling number = climbing the table.
  let rankDelta: StatDelta | null = null;
  if (comparable && curr.overall_rank != null && past.overall_rank != null) {
    const improved = past.overall_rank - curr.overall_rank; // positive = better
    rankDelta = {
      text: Math.abs(improved).toLocaleString("en-GB"),
      period,
      good: improved === 0 ? null : improved > 0,
      direction: improved >= 0 ? "up" : "down",
    };
  }

  // Latest GW score vs the comparison GW's score.
  let gwDelta: StatDelta | null = null;
  if (comparable) {
    const diff = curr.points - past.points;
    gwDelta = {
      text: `${fmtSigned(diff)} pts`,
      period,
      good: diff === 0 ? null : diff > 0,
      direction: diff >= 0 ? "up" : "down",
    };
  }

  // Team value (squad + bank), month over month.
  let valueDelta: StatDelta | null = null;
  if (comparable) {
    const diff = curr.value + curr.bank - (past.value + past.bank);
    valueDelta = {
      text: `${fmtSigned(diff / 10, 1)}m`,
      period,
      good: diff === 0 ? null : diff > 0,
      direction: diff >= 0 ? "up" : "down",
    };
  }

  const pointsTrend = rows.slice(-8).map((r) => r.points);

  const chipsLeft = squad
    ? remainingChips(
        history.chips.map((c) => ({ name: c.name, event: c.event })),
        data.bootstrap.chips ?? null,
        squad.nextEvent
      )
    : [];

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/" className="text-xs text-muted hover:text-accent">
            ← Switch team
          </Link>
          <h1 className="text-xl font-bold sm:text-2xl">
            {entry.name}{" "}
            <span className="text-sm font-normal text-muted sm:text-base">
              — {entry.player_first_name} {entry.player_last_name}
            </span>
            {entryId === DEMO_ENTRY_ID && (
              <span className="ml-2 align-middle rounded-full border border-warn/50 bg-warn/10 px-2 py-0.5 text-xs font-semibold text-warn">
                DEMO DATA
              </span>
            )}
          </h1>
        </div>
        <ThemeToggle />
        {currentEvent != null && (
          <div
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold ${
              !gwFinished
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-border-c bg-panel text-foreground"
            }`}
          >
            {!gwFinished && (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
            )}
            GW{currentEvent}
            <span className={`font-normal ${gwFinished ? "text-muted" : ""}`}>
              {!gwFinished
                ? "· Live"
                : squad?.nextEvent != null
                  ? "· Finished"
                  : "· Season finished"}
            </span>
          </div>
        )}
        {squad?.nextEvent != null && (
          <DeadlineChip
            nextEvent={squad.nextEvent}
            deadline={
              data.bootstrap.events.find((e) => e.id === squad.nextEvent)?.deadline_time ?? null
            }
          />
        )}
      </div>

      {/* KPI row */}
      <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-6">
        <Stat
          label="Total points"
          value={String(entry.summary_overall_points)}
          accent
          delta={pointsDelta}
          trend={pointsTrend.length > 1 ? pointsTrend : undefined}
          onClick={() => setKpiModal("points")}
        />
        <Stat
          label="Overall rank"
          value={fmtRank(entry.summary_overall_rank)}
          delta={rankDelta}
          onClick={() => setKpiModal("rank")}
        />
        <Stat
          label="Latest GW"
          value={`${entry.summary_event_points} pts`}
          delta={gwDelta}
          sub={
            entry.summary_event_rank != null
              ? `GW rank ${fmtRank(entry.summary_event_rank)}`
              : undefined
          }
          onClick={() => setKpiModal("gw")}
        />
        <Stat
          label="Team value"
          value={
            squad
              ? `£${fmtPrice(squad.players.reduce((s, p) => s + p.sellPrice, 0) + squad.bank)}m`
              : "–"
          }
          sub={
            squad
              ? `£${fmtPrice(squad.players.reduce((s, p) => s + p.sellPrice, 0))}m squad + £${fmtPrice(squad.bank)}m bank`
              : undefined
          }
          delta={valueDelta}
          onClick={() => setKpiModal("value")}
        />
        <Stat label="Free transfers" value={squad ? String(squad.freeTransfers) : "–"} />
        <Stat
          label="Chips left"
          value={String(chipsLeft.length)}
          sub={chipsLeft.map((c) => c.label).join(", ") || "None"}
        />
      </div>

      {/* Tabs */}
      <div className="sticky top-0 z-20 mt-4 -mx-4 flex justify-between border-b border-border-c bg-background/85 px-2 backdrop-blur sm:justify-start sm:gap-1 sm:px-4">
        {TABS.map(([key, label, short]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`whitespace-nowrap px-1 py-2 text-xs font-medium sm:px-3 sm:text-sm ${
              tab === key
                ? "border-b-2 border-accent text-accent"
                : "text-muted hover:text-foreground"
            }`}
          >
            <span className="sm:hidden">{short}</span>
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "team" &&
          (squad ? (
            <div className="space-y-4">
              <Pitch
                starters={squad.players
                  .filter((p) => p.pickPosition <= 11)
                  .map((p) => ({
                    element: p.element,
                    isCaptain: p.isCaptain,
                    isVice: p.isViceCaptain,
                    xp: xpOf?.get(p.element.id)?.next,
                    live: liveData
                      ? {
                          points:
                            (livePointsOf.get(p.element.id) ?? 0) *
                            (p.element.id === effCaptainId ? capMult : 1),
                          final: gwFinished,
                        }
                      : undefined,
                  }))}
                bench={squad.players
                  .filter((p) => p.pickPosition > 11)
                  .sort((a, b) => a.pickPosition - b.pickPosition)
                  .map((p) => ({
                    element: p.element,
                    xp: xpOf?.get(p.element.id)?.next,
                    live: liveData
                      ? { points: livePointsOf.get(p.element.id) ?? 0, final: gwFinished }
                      : undefined,
                  }))}
                teams={teams}
                fixtures={data.fixtures}
                nextEvent={squad.nextEvent}
                onSelect={setSelected}
                cornerTotal={
                  liveData && currentEvent != null
                    ? {
                        title: `GW${currentEvent}`,
                        points:
                          squad.players
                            .filter(
                              (p) => p.pickPosition <= 11 || squad.activeChip === "bboost"
                            )
                            .reduce(
                              (s, p) =>
                                s +
                                (livePointsOf.get(p.element.id) ?? 0) *
                                  (p.element.id === effCaptainId ? capMult : 1),
                              0
                            ) - (data.picks?.entry_history.event_transfers_cost ?? 0),
                        final: gwFinished,
                      }
                    : null
                }
              />
              <p className="text-xs text-muted">
                {liveData
                  ? gwFinished
                    ? `Final GW${currentEvent} points shown under each player — tap a player for the full breakdown.`
                    : `Live GW${currentEvent} points shown in green under each player (captain doubled) — tap a player for the breakdown.`
                  : "Tap a player for details."}{" "}
                Selling prices follow the official 50%-of-profit rule.
              </p>
            </div>
          ) : (
            <div className="card p-6 text-muted">
              No squad found — has this team played a gameweek this season yet?
            </div>
          ))}
        {tab === "optimize" && <OptimizePanel data={data} onSelect={setSelected} />}
        {tab === "stats" && <StatsTable data={data} onSelect={setSelected} />}
        {tab === "fixtures" && <FixtureTicker data={data} onSelect={setSelected} />}
        {tab === "live" && <LiveTab data={data} onSelect={setSelected} />}
        {tab === "league" && <MiniLeague data={data} entryId={entryId} />}
        {tab === "history" && <HistoryChart data={data} />}
      </div>

      {kpiModal && (
        <KpiHistoryModal metric={kpiModal} data={data} onClose={() => setKpiModal(null)} />
      )}

      {selected && (
        <PlayerModal
          element={selected}
          team={teams.get(selected.team)}
          live={liveData}
          event={currentEvent}
          gwFinished={gwFinished}
          onClose={() => setSelected(null)}
          fixtures={data.fixtures}
          teams={teams}
          nextEvent={data.squad?.nextEvent ?? null}
        />
      )}
    </main>
  );
}
