"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FplApiError, loadTeamData, fmtRank, type TeamData } from "@/lib/fpl";
import { fmtPrice, remainingChips } from "@/lib/rules";
import Pitch from "./Pitch";
import OptimizePanel from "./OptimizePanel";
import StatsTable from "./StatsTable";
import FixtureTicker from "./FixtureTicker";
import HistoryChart from "./HistoryChart";
import LiveTab from "./LiveTab";
import MiniLeague from "./MiniLeague";
import { ErrorBox, Skeleton, Stat } from "./ui";

const TABS = [
  ["team", "Laget mitt"],
  ["optimize", "Optimalisér"],
  ["stats", "Stats"],
  ["fixtures", "Fixtures"],
  ["live", "Live"],
  ["league", "Mini-liga"],
  ["history", "Historikk"],
] as const;

type TabKey = (typeof TABS)[number][0];

export default function Dashboard({ entryId }: { entryId: number }) {
  const [data, setData] = useState<TeamData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("team");

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset view when entryId changes
    setData(null);
    setError(null);
    loadTeamData(entryId)
      .then((d) => !cancelled && setData(d))
      .catch((e) =>
        !cancelled &&
        setError(e instanceof FplApiError ? e.message : "Klarte ikke å laste laget.")
      );
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  const teams = useMemo(
    () => (data ? new Map(data.bootstrap.teams.map((t) => [t.id, t])) : new Map()),
    [data]
  );

  if (error) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-16">
        <ErrorBox message={error} />
        <Link href="/" className="mt-4 inline-block text-accent hover:underline">
          ← Prøv en annen FPL-ID
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
  const prev = history.current.length > 1 ? history.current[history.current.length - 2] : null;
  const curr = history.current.length > 0 ? history.current[history.current.length - 1] : null;
  const rankDelta =
    prev?.overall_rank != null && curr?.overall_rank != null
      ? prev.overall_rank - curr.overall_rank
      : null;

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
            ← Bytt lag
          </Link>
          <h1 className="text-2xl font-bold">
            {entry.name}{" "}
            <span className="text-base font-normal text-muted">
              — {entry.player_first_name} {entry.player_last_name}
            </span>
          </h1>
        </div>
        {squad?.nextEvent != null && (
          <div className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm font-semibold text-accent">
            Neste: GW{squad.nextEvent}
          </div>
        )}
      </div>

      {/* Stat row */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        <Stat label="Totalpoeng" value={String(entry.summary_overall_points)} accent />
        <Stat
          label="Overall rank"
          value={fmtRank(entry.summary_overall_rank)}
          sub={
            rankDelta != null
              ? rankDelta > 0
                ? `▲ ${rankDelta.toLocaleString("nb-NO")}`
                : `▼ ${Math.abs(rankDelta).toLocaleString("nb-NO")}`
              : undefined
          }
        />
        <Stat label="Siste GW" value={`${entry.summary_event_points} p`} />
        <Stat
          label="Lagverdi"
          value={squad ? `£${fmtPrice(squad.players.reduce((s, p) => s + p.sellPrice, 0) + squad.bank)}` : "–"}
          sub={squad ? `Bank £${fmtPrice(squad.bank)}` : undefined}
        />
        <Stat label="Gratis bytter" value={squad ? String(squad.freeTransfers) : "–"} />
        <Stat
          label="Chips igjen"
          value={String(chipsLeft.length)}
          sub={chipsLeft.map((c) => c.label).join(", ") || "Ingen"}
        />
      </div>

      {/* Tabs */}
      <div className="mt-6 flex gap-1 overflow-x-auto border-b border-border-c">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`whitespace-nowrap px-4 py-2.5 text-sm font-medium ${
              tab === key
                ? "border-b-2 border-accent text-accent"
                : "text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
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
                  }))}
                bench={squad.players
                  .filter((p) => p.pickPosition > 11)
                  .sort((a, b) => a.pickPosition - b.pickPosition)
                  .map((p) => ({ element: p.element }))}
                teams={teams}
                fixtures={data.fixtures}
                nextEvent={squad.nextEvent}
              />
              <p className="text-xs text-muted">
                Laget ditt fra GW{squad.currentEvent}. Salgspriser er beregnet etter
                50%-regelen fra kjøpsprisene dine.
              </p>
            </div>
          ) : (
            <div className="card p-6 text-muted">
              Fant ikke lagoppstilling — har laget spilt en runde denne sesongen ennå?
            </div>
          ))}
        {tab === "optimize" && <OptimizePanel data={data} />}
        {tab === "stats" && <StatsTable data={data} />}
        {tab === "fixtures" && <FixtureTicker data={data} />}
        {tab === "live" && <LiveTab data={data} />}
        {tab === "league" && <MiniLeague entryId={entryId} />}
        {tab === "history" && <HistoryChart data={data} />}
      </div>
    </main>
  );
}
