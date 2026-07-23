"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, DEMO_ENTRY_ID, fmtNum, type TeamData } from "@/lib/fpl";
import type { EventLive, LeagueStandings } from "@/lib/types";
import { CHIP_LABELS } from "@/lib/rules";
import { projectAutoSubs } from "@/lib/live";
import { ErrorBox, Skeleton } from "./ui";

const MAX_RIVAL_DETAILS = 20;

interface RivalDetail {
  captain: string | null;
  viceCaptain: string | null;
  chip: string | null;
  livePoints: number | null; // incl. hits (net)
  hits: number;
}

interface LeagueOwnership {
  sample: number; // rivals sampled (excluding you)
  /** elementId -> effective ownership share 0..2 (captaincy counts double) */
  eo: Map<number, number>;
}

export default function MiniLeague({ data, entryId }: { data: TeamData; entryId: number }) {
  const router = useRouter();
  // Rival dashboards only work with real FPL data, not the demo universe.
  const canOpenRivals = entryId !== DEMO_ENTRY_ID;
  const [leagueId, setLeagueId] = useState("");
  const [standings, setStandings] = useState<LeagueStandings | null>(null);
  const [details, setDetails] = useState<Map<number, RivalDetail>>(new Map());
  const [ownership, setOwnership] = useState<LeagueOwnership | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentEvent =
    data.bootstrap.events.find((e) => e.is_current)?.id ?? data.squad?.currentEvent ?? null;

  const elementName = useMemo(
    () => new Map(data.bootstrap.elements.map((e) => [e.id, e.web_name])),
    [data.bootstrap]
  );
  const elementById = useMemo(
    () => new Map(data.bootstrap.elements.map((e) => [e.id, e])),
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
      // Follow pagination so leagues larger than one page (~50 entries)
      // still include everyone — capped to keep request counts sane.
      const MAX_PAGES = 6;
      const first = await api.league(num);
      let page = 1;
      let hasNext = first.standings.has_next;
      while (hasNext && page < MAX_PAGES) {
        page += 1;
        const next = await api.league(num, page);
        first.standings.results.push(...next.standings.results);
        hasNext = next.standings.has_next;
      }
      setStandings(first);
      localStorage.setItem("fpl-league-id", String(num));
      loadDetails(first);
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
      const eoCount = new Map<number, number>();
      let eoSample = 0;
      const results = await Promise.all(
        rivals.map(async (r) => {
          try {
            const picks = await api.picks(r.entry, currentEvent);
            const bboost = picks.active_chip === "bboost";
            // Auto-subs projected so live scores match what FPL will process.
            const subs = projectAutoSubs(picks.picks, elementById, live, data.fixtures, currentEvent);
            const effXi = new Set(subs.effectiveXi);
            let pts = 0;
            for (const p of picks.picks) {
              if (!bboost && !effXi.has(p.element)) continue;
              const mult = p.multiplier > 1 ? p.multiplier : 1;
              pts += (pointsOf.get(p.element) ?? 0) * mult;
            }
            const hits = picks.entry_history.event_transfers_cost;
            const cap = picks.picks.find((p) => p.is_captain);
            const vice = picks.picks.find((p) => p.is_vice_captain);
            // League effective ownership: starters count 1, captain counts 2.
            if (r.entry !== entryId) {
              eoSample++;
              for (const p of picks.picks) {
                if (p.position <= 11 || bboost) {
                  eoCount.set(p.element, (eoCount.get(p.element) ?? 0) + (p.is_captain ? 2 : 1));
                }
              }
            }
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
      if (eoSample >= 3) {
        const eo = new Map<number, number>();
        for (const [id, c] of eoCount) eo.set(id, c / eoSample);
        setOwnership({ sample: eoSample, eo });
      } else {
        setOwnership(null);
      }
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

      {error && <ErrorBox message={error} onRetry={() => load()} />}
      {loading && <Skeleton className="h-64" />}

      {standings && !loading && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border-c px-4 py-3">
            <span className="font-semibold">{standings.league.name}</span>
            {detailsLoading && (
              <span className="text-xs text-muted">Loading rival details…</span>
            )}
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted">
              <tr className="border-b border-border-c">
                <th className="w-9 px-2 py-1.5 text-left">#</th>
                <th className="px-1.5 py-1.5 text-left">Team</th>
                <th
                  className="w-14 px-1.5 py-1.5 text-right"
                  title="Live gameweek points minus transfer hits"
                >
                  GW
                </th>
                <th className="w-16 px-2 py-1.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-c/60">
              {standings.standings.results.map((r) => {
                const d = details.get(r.entry);
                const mine = r.entry === entryId;
                const chipShort: Record<string, string> = {
                  wildcard: "WC",
                  freehit: "FH",
                  bboost: "BB",
                  "3xc": "TC",
                };
                const clickable = canOpenRivals && !mine;
                return (
                  <tr
                    key={r.entry}
                    className={`${mine ? "bg-accent/10" : "hover:bg-panel-2/60 active:bg-panel-2"} ${clickable ? "cursor-pointer" : ""}`}
                    onClick={clickable ? () => router.push(`/team/${r.entry}`) : undefined}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onKeyDown={
                      clickable
                        ? (ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.preventDefault();
                              router.push(`/team/${r.entry}`);
                            }
                          }
                        : undefined
                    }
                    title={clickable ? "Open this manager's dashboard" : undefined}
                  >
                    <td className="px-2 py-1.5 font-mono text-xs">
                      {r.rank}
                      {r.last_rank > 0 && r.last_rank !== r.rank && (
                        <span className={r.rank < r.last_rank ? "text-accent" : "text-danger"}>
                          {r.rank < r.last_rank ? "▲" : "▼"}
                        </span>
                      )}
                    </td>
                    <td className="px-1.5 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{r.entry_name}</span>
                        {d?.chip && (
                          <span
                            className="shrink-0 rounded bg-accent-2/15 px-1 py-px text-[10px] font-bold text-accent-2"
                            title={CHIP_LABELS[d.chip] ?? d.chip}
                          >
                            {chipShort[d.chip] ?? d.chip}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-muted">
                        {r.player_name}
                        {d?.captain && <span> ({d.captain})</span>}
                        {clickable && <span className="ml-1 opacity-60">›</span>}
                      </div>
                    </td>
                    <td className="px-1.5 py-1.5 text-right font-mono">
                      {d?.livePoints ?? r.event_total}
                      {d && d.hits > 0 && (
                        <div className="text-[10px] leading-tight text-danger">−{d.hits}</div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono font-bold">{fmtNum(r.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {standings.standings.results.length > MAX_RIVAL_DETAILS && (
            <div className="border-t border-border-c px-4 py-2 text-xs text-muted">
              Captain/chip/live details shown for the top {MAX_RIVAL_DETAILS} teams.
            </div>
          )}
        </div>
      )}

      {/* League effective ownership: who you must own (threats), who protects
          your rank (shields), and where you differ (differentials). */}
      {ownership && data.squad && !loading && (
        (() => {
          const myIds = new Set(data.squad.players.map((p) => p.element.id));
          const pct = (v: number) => `${Math.round(v * 100)}%`;
          const ranked = [...ownership.eo.entries()].sort((a, b) => b[1] - a[1]);
          const threats = ranked
            .filter(([id, v]) => !myIds.has(id) && v >= 0.4)
            .slice(0, 5);
          const shields = ranked.filter(([id]) => myIds.has(id)).slice(0, 5);
          const diffs = data.squad.players
            .filter((p) => p.pickPosition <= 11 && (ownership.eo.get(p.element.id) ?? 0) <= 0.2)
            .slice(0, 5);
          const Item = ({ id, v }: { id: number; v: number }) => (
            <li className="flex items-center justify-between gap-2">
              <span className="truncate">{elementName.get(id) ?? `#${id}`}</span>
              <span className="shrink-0 font-mono text-xs text-muted">{pct(v)} EO</span>
            </li>
          );
          return (
            <div className="card p-4">
              <div className="text-sm font-semibold">
                League ownership <span className="font-normal text-muted">(top {ownership.sample} rivals, captains count double)</span>
              </div>
              <div className="mt-3 grid gap-4 text-sm sm:grid-cols-3">
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-danger">⚔️ Threats — they own, you don&apos;t</div>
                  {threats.length > 0 ? (
                    <ul className="space-y-1">{threats.map(([id, v]) => <Item key={id} id={id} v={v} />)}</ul>
                  ) : (
                    <div className="text-xs text-muted">No high-ownership player is missing from your team. 💪</div>
                  )}
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent">🛡️ Shields — protect your rank</div>
                  {shields.length > 0 ? (
                    <ul className="space-y-1">{shields.map(([id, v]) => <Item key={id} id={id} v={v} />)}</ul>
                  ) : (
                    <div className="text-xs text-muted">None of your players are widely owned here.</div>
                  )}
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent-2">🎯 Differentials — your edge</div>
                  {diffs.length > 0 ? (
                    <ul className="space-y-1">
                      {diffs.map((p) => (
                        <Item key={p.element.id} id={p.element.id} v={ownership.eo.get(p.element.id) ?? 0} />
                      ))}
                    </ul>
                  ) : (
                    <div className="text-xs text-muted">Your XI matches the league template.</div>
                  )}
                </div>
              </div>
            </div>
          );
        })()
      )}
    </div>
  );
}
