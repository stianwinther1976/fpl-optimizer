"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { markNavigation } from "@/lib/nav";
import { api, DEMO_ENTRY_ID, fmtNum, type TeamData } from "@/lib/fpl";
import type { EventLive, LeagueStandings } from "@/lib/types";
import { CHIP_LABELS } from "@/lib/rules";
import { liveLeagueTotal } from "@/lib/display";
import { liveEntryScore, provisionalBonus, squadMatchState } from "@/lib/live";
import { ErrorBox, Skeleton } from "./ui";

const MAX_RIVAL_DETAILS = 20;

interface RivalDetail {
  captain: string | null;
  viceCaptain: string | null;
  chip: string | null;
  livePoints: number | null; // incl. hits (net)
  hits: number;
  /** Counting players whose match is running, and whose has not kicked off. */
  inPlay: number;
  toStart: number;
}

interface LeagueOwnership {
  sample: number; // rivals sampled (excluding you)
  /** elementId -> effective ownership share 0..2 (captaincy counts double) */
  eo: Map<number, number>;
}

export default function MiniLeague({ data, entryId }: { data: TeamData; entryId: number }) {
  const router = useRouter();
  // Recorded, so the rival's own back control returns to this table rather
  // than to the landing page — see `nav.ts`.
  const goToTeam = (id: number) => {
    markNavigation();
    router.push(`/team/${id}`);
  };
  // Rival dashboards only work with real FPL data, not the demo universe.
  const canOpenRivals = entryId !== DEMO_ENTRY_ID;
  const [leagueId, setLeagueId] = useState("");
  const [standings, setStandings] = useState<LeagueStandings | null>(null);
  const [details, setDetails] = useState<Map<number, RivalDetail>>(new Map());
  const [ownership, setOwnership] = useState<LeagueOwnership | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState(false);
  /**
   * Latest-wins guard for `loadDetails`. Fetching one league's rivals takes up
   * to MAX_RIVAL_DETAILS `picks` calls, and nothing stops a second league being
   * picked while the first is still in flight. Without a sequence number the
   * two runs race and the SLOWER one writes last, so league A's rivals and
   * ownership can land under league B's heading. (`LiveTab` guards its refresh
   * the same way.)
   */
  const detailsSeq = useRef(0);
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
      /*
       * PAGINATE INTO A COPY. `api.league` memoises its answer for two minutes
       * (`fetchCache`), so pushing page 2 into page 1's `results` array mutates
       * the CACHED object — and the next load within that window appends to an
       * array that already has the extra pages in it. Probed: replaying this
       * three times against a two-page league gave 2, then 3, then 4 rows from
       * two network fetches. In a 250-member league that is duplicate managers,
       * duplicate React keys, and a corrupted payload that also feeds the Live
       * tab's rank-band safety score.
       */
      const first = await api.league(num);
      const results = [...first.standings.results];
      let page = 1;
      let hasNext = first.standings.has_next;
      while (hasNext && page < MAX_PAGES) {
        page += 1;
        const next = await api.league(num, page);
        results.push(...next.standings.results);
        hasNext = next.standings.has_next;
      }
      const merged = {
        ...first,
        standings: { ...first.standings, results, has_next: hasNext },
      };
      setStandings(merged);
      localStorage.setItem("fpl-league-id", String(num));
      loadDetails(merged);
    } catch {
      setError("League not found — check the ID.");
    } finally {
      setLoading(false);
    }
  }

  async function loadDetails(s: LeagueStandings) {
    if (currentEvent == null) return;
    const seq = ++detailsSeq.current;
    /** True once a newer `loadDetails` has started; this run must write nothing. */
    const superseded = () => seq !== detailsSeq.current;
    setDetailsLoading(true);
    setDetailsError(false);
    // DROP THE OUTGOING LEAGUE'S NUMBERS BEFORE FETCHING THE NEW ONE'S. The
    // standings and the heading swap the instant a different league is picked,
    // but these two were only ever overwritten at the END of a fetch that makes
    // up to MAX_RIVAL_DETAILS sequential `picks` calls — seconds on a phone —
    // so league A's effective ownership sat under league B's name the whole
    // time. Worse when the new league is too small to sample: `setOwnership`
    // then only fires in the else-branch at the very end, so the stale panel
    // was the only thing the user ever saw.
    setDetails(new Map());
    setOwnership(null);
    try {
      const rivals = s.standings.results.slice(0, MAX_RIVAL_DETAILS);
      const live: EventLive = await api.live(currentEvent);
      /*
       * THE SAME SCORE AS THE OTHER TWO TABS. This loop had neither the
       * provisional bonus nor the vice-captain takeover, so between the final
       * whistle and bonus confirmation — hours, after a Saturday — the reader's
       * own row here disagreed with the Live tab by the bonus, and with both
       * tabs by the vice's entire raw score whenever a captain blanked.
       * `liveEntryScore` is now the one definition; see its note for the three
       * numbers this produced.
       */
      const bonus = provisionalBonus(data.bootstrap, data.fixtures, live, currentEvent);
      const ev = data.bootstrap.events.find((e) => e.id === currentEvent);
      const gwDone =
        (ev?.finished ?? false) ||
        (data.fixtures.some((f) => f.event === currentEvent) &&
          data.fixtures.filter((f) => f.event === currentEvent).every((f) => f.finished));
      const eoCount = new Map<number, number>();
      let eoSample = 0;
      const results = await Promise.all(
        rivals.map(async (r) => {
          try {
            const picks = await api.picks(r.entry, currentEvent);
            const bboost = picks.active_chip === "bboost";
            // Auto-subs, provisional bonus and the vice-captain takeover all
            // live in `liveEntryScore`, which returns the score NET of the hit.
            const net = liveEntryScore(
              picks,
              elementById,
              live,
              data.fixtures,
              currentEvent,
              bonus.byElement,
              gwDone
            );
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
              livePoints: net,
              hits,
              ...squadMatchState(picks, elementById, live, data.fixtures, currentEvent),
            };
            return [r.entry, detail] as const;
          } catch {
            return null;
          }
        })
      );
      if (superseded()) return;
      setDetails(new Map(results.filter((x): x is NonNullable<typeof x> => x != null)));
      if (eoSample >= 3) {
        const eo = new Map<number, number>();
        for (const [id, c] of eoCount) eo.set(id, c / eoSample);
        setOwnership({ sample: eoSample, eo });
      } else {
        setOwnership(null);
      }
    } catch {
      // THIS CATCH IS NOT OPTIONAL. `loadDetails` is fired un-awaited from
      // `load`, so a rejection here escapes that function's try entirely and
      // surfaces as an unhandled rejection. The state above has already been
      // cleared by then, so without this the user is left staring at an empty
      // rivals column with no explanation and nothing to press.
      if (!superseded()) setDetailsError(true);
    } finally {
      if (!superseded()) setDetailsLoading(false);
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
                    className={`min-h-11 rounded-full border px-3 py-1.5 text-sm ${
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
                aria-label="Choose one of your mini-leagues"
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
                className="mt-2 min-h-11 w-full rounded-lg border border-border-c bg-panel-2 px-3 py-2 text-sm sm:w-auto"
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
          <summary className="flex min-h-11 cursor-pointer items-center hover:text-accent">
            Enter a league ID manually
          </summary>
          <div className="mt-2 flex gap-2">
            <input
              value={leagueId}
              onChange={(e) => setLeagueId(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && load()}
              placeholder="League ID (classic league)"
              aria-label="Classic league ID"
              className="min-h-11 min-w-0 flex-1 rounded-lg bg-panel-2 border border-border-c px-3 py-2 text-sm"
            />
            <button
              onClick={() => load()}
              disabled={loading}
              className="btn-primary min-h-11 shrink-0 rounded-lg px-4 py-2 text-sm disabled:opacity-50"
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
            {detailsLoading ? (
              <span className="text-xs text-muted">Loading rival details…</span>
            ) : (
              detailsError && (
                <button
                  onClick={() => standings && loadDetails(standings)}
                  className="text-xs text-danger underline underline-offset-2"
                >
                  Live scores unavailable — retry
                </button>
              )
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
                    onClick={clickable ? () => goToTeam(r.entry) : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    aria-label={clickable ? `${r.entry_name} — open this team` : undefined}
                    onKeyDown={
                      clickable
                        ? (ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.preventDefault();
                              goToTeam(r.entry);
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
                      {/*
                        WHAT THE SCORE ON ITS OWN CANNOT SAY. Two points ahead
                        with five still to kick off is a different position from
                        two points ahead with none left. See `squadMatchState`.
                        Zeroes are omitted rather than printed: a finished
                        gameweek should go quiet here, not render "0 · 0" on
                        every row.
                      */}
                      {d && (d.inPlay > 0 || d.toStart > 0) && (
                        <div className="text-[10px] leading-tight text-muted">
                          {d.inPlay > 0 && (
                            <span className="text-accent" title={`${d.inPlay} playing now`}>
                              ●{d.inPlay}
                            </span>
                          )}
                          {d.inPlay > 0 && d.toStart > 0 && " "}
                          {d.toStart > 0 && (
                            <span title={`${d.toStart} yet to kick off`}>▸{d.toStart}</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono font-bold">
                      {/*
                        LIVE ON BOTH SIDES OR NEITHER. The GW column beside this
                        one is the live score; `r.total` is FPL's stored
                        cumulative, refreshed on their schedule. In GW1, where
                        the two are by definition the same number, the row read
                        7 beside 3. See `liveLeagueTotal`.
                      */}
                      {fmtNum(
                        d?.livePoints != null
                          ? liveLeagueTotal(r.total, r.event_total, d.livePoints)
                          : r.total
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {standings.standings.results.length > MAX_RIVAL_DETAILS && (
            <div className="border-t border-border-c px-4 py-2 text-xs text-muted">
              Captain/chip/live details shown for the top {MAX_RIVAL_DETAILS} teams. ● playing now, ▸ yet to kick off.
            </div>
          )}
        </div>
      )}

      {/* League effective ownership: who you must own (threats), who protects
          your rank (shields), and where you differ (differentials). */}
      {ownership && data.squad && !loading && (
        (() => {
          /*
           * MY SIDE OF THE COMPARISON HAS TO BE COUNTED THE WAY THE FIELD'S IS.
           *
           * `eoCount` above credits a rival's player only when `position <= 11`
           * or Bench Boost is on, so effective ownership is a statement about
           * STARTING elevens. This set was all fifteen, and `diffs` below was a
           * third rule again (`pickPosition <= 11`, with no Bench Boost case).
           *
           * The consequence is not a rounding difference, it is a sign error. A
           * 60%-owned player sitting on my bench scores the field and not me —
           * the single worst place he can be — and he was excluded from
           * "Threats" for being mine and then listed under "Shields — they
           * protect your rank". He protects nothing; he is the threat.
           */
          const benchBoosted = data.squad.activeChip === "bboost";
          const inMyXi = (p: { pickPosition: number }) => p.pickPosition <= 11 || benchBoosted;
          /*
           * `currentPlayers`, BECAUSE THIS COMPARES AGAINST THIS GAMEWEEK.
           *
           * `eoCount` above is built from `api.picks(rival, currentEvent)` —
           * the teams the rivals are actually fielding. `players` is the squad
           * to optimize from: next gameweek's transfers applied, and in a Free
           * Hit week the fifteen the Free Hit replaced. So a transfer made
           * early listed the man still scoring for the reader as a Threat and
           * counted the incoming player as his, and a Free Hit week compared
           * the whole panel against a team he is not fielding. The chip flag
           * two lines up was already this gameweek's, so the file was mixing
           * one gameweek's chip with another's squad.
           */
          const myIds = new Set(
            data.squad.currentPlayers.filter(inMyXi).map((p) => p.element.id)
          );
          /*
           * OWNING HIM AND FIELDING HIM ARE DIFFERENT FACTS, AND THERE ARE
           * THREE STATES, NOT TWO.
           *
           * Narrowing `myIds` to the XI above fixed the shield inversion and
           * then handed the benched player the OTHER wrong label: he is not in
           * `myIds`, so he satisfied `!myIds.has(id)` and was printed under a
           * heading asserting you do not own him — which also made the empty
           * state ("No high-ownership player is missing from your team") false
           * in the same case, and, because the column is `slice(0, 5)`, pushed
           * out players the reader can actually go and buy.
           *
           * So the column is what it always meant: the field is scoring these
           * players and you are not. For most of them the move is a transfer;
           * for one already in your fifteen it is to start him. Saying which is
           * the difference between advice and a list.
           */
          const mySquadIds = new Set(data.squad.currentPlayers.map((p) => p.element.id));
          const pct = (v: number) => `${Math.round(v * 100)}%`;
          const ranked = [...ownership.eo.entries()].sort((a, b) => b[1] - a[1]);
          const threats = ranked
            .filter(([id, v]) => !myIds.has(id) && v >= 0.4)
            .slice(0, 5)
            .map(([id, v]) => ({ id, v, benched: mySquadIds.has(id) }));
          /*
           * A SHIELD AND A DIFFERENTIAL CANNOT BE THE SAME PLAYER.
           * Threats need `>= 0.4` and differentials `<= 0.2`, but shields were
           * just "my players, top five by ownership" with no floor at all — so
           * in a small league where nobody clears 40%, three 11%-owned players
           * were listed under both "protect your rank" and "your edge" at once.
           * The reader is told the same man both shields them and sets them
           * apart, which cannot both be true.
           *
           * The threshold is `threats`' own: a player the field is on is one
           * you are protected by holding, and the same number decides both.
           */
          const shields = ranked.filter(([id, v]) => myIds.has(id) && v >= 0.4).slice(0, 5);
          const diffs = data.squad.currentPlayers
            .filter((p) => inMyXi(p) && (ownership.eo.get(p.element.id) ?? 0) <= 0.2)
            .slice(0, 5);
          const Item = ({ id, v, note }: { id: number; v: number; note?: string }) => (
            <li className="flex items-center justify-between gap-2">
              <span className="truncate">
                {elementName.get(id) ?? `#${id}`}
                {note && <span className="ml-1 text-xs text-muted">{note}</span>}
              </span>
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
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-danger">⚔️ Threats — scoring the league, not you</div>
                  {threats.length > 0 ? (
                    <ul className="space-y-1">
                      {threats.map((t) => (
                        <Item
                          key={t.id}
                          id={t.id}
                          v={t.v}
                          note={t.benched ? "(on your bench)" : undefined}
                        />
                      ))}
                    </ul>
                  ) : (
                    <div className="text-xs text-muted">
                      Every widely-owned player here is in your starting XI. 💪
                    </div>
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
