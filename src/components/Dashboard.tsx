"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { api, entryNotFoundMessage, FplApiError, loadTeamData, fmtNum, fmtRank, rankPercentile, DEMO_ENTRY_ID, type TeamData } from "@/lib/fpl";
import type { Element, EntryEventPicks, EventLive, Fixture } from "@/lib/types";
import { fmtPrice, remainingChips } from "@/lib/rules";
import { projectAll } from "@/lib/xp";
import { projectAutoSubs, LIVE_REFRESH_MS } from "@/lib/live";
import { netEventPoints, netGwDelta, netGwPoints, valueDelta } from "@/lib/display";
import { saveRecentTeam } from "@/lib/recent";
import { currentSeasonName } from "@/lib/seasonArchive";
import { launchPool } from "@/lib/pool";
import {
  cachedPastSeason,
  loadPastSeason,
  pastSeasonVersion,
  subscribePastSeason,
} from "@/lib/pastSeasonStore";
import {
  reconcileFinishedGws,
  seedDemoCalibration,
  snapshotPredictions,
} from "@/lib/calibration";
import {
  hydrateStartCalls,
  startCallsVersion,
  subscribeStartCalls,
} from "@/lib/lineup";
import PlayerModal from "./PlayerModal";
import KpiHistoryModal, { type KpiMetric } from "./KpiHistoryModal";
import Pitch from "./Pitch";
import OptimizePanel from "./OptimizePanel";
import StatsTable from "./StatsTable";
import FixtureTicker from "./FixtureTicker";
import LiveTab from "./LiveTab";
import MiniLeague from "./MiniLeague";
import ModelAccuracy from "./ModelAccuracy";
import PointsBreakdown from "./PointsBreakdown";
import ThemeToggle from "./ThemeToggle";
import { ErrorBox, Skeleton, Stat, type StatDelta } from "./ui";

// recharts is heavy — load the History tab's chart bundle only when needed.
const HistoryChart = dynamic(() => import("./HistoryChart"), {
  loading: () => <Skeleton className="h-96" />,
});

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
  /** Fixtures as of the last live poll — used only to decide when to stop. */
  const [liveFixtures, setLiveFixtures] = useState<Fixture[] | null>(null);
  /** Orders live polls against each other; see the effect that uses it. */
  const livePollSeq = useRef(0);
  const [selected, setSelected] = useState<Element | null>(null);
  const [kpiModal, setKpiModal] = useState<KpiMetric | null>(null);
  // Time machine: view the squad exactly as it was in an earlier gameweek.
  const [viewGw, setViewGw] = useState<number | null>(null);
  const [hist, setHist] = useState<{ gw: number; picks: EntryEventPicks; live: EventLive } | null>(null);
  const [histError, setHistError] = useState<string | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [histRetry, setHistRetry] = useState(0);
  const [tab, setTab] = useState<TabKey>(
    TABS.some(([k]) => k === initialTab) ? (initialTab as TabKey) : "team"
  );
  // Tabs stay mounted once visited: switching back keeps state (optimizer
  // results, league standings, live data) instead of refetching everything.
  const [visited, setVisited] = useState<Set<TabKey>>(() => new Set([tab]));
  const selectTab = useCallback((k: TabKey) => {
    setTab(k);
    setVisited((v) => (v.has(k) ? v : new Set(v).add(k)));
  }, []);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset view when entryId changes
    setData(null);
    setError(null);
    loadTeamData(entryId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // Remember the team so the landing page can offer one-tap re-entry.
        if (entryId !== DEMO_ENTRY_ID) {
          saveRecentTeam({
            id: entryId,
            name: d.entry.name,
            manager: `${d.entry.player_first_name} ${d.entry.player_last_name}`.trim(),
          });
        }
      })
      .catch(async (e) => {
        if (cancelled) return;
        if (e instanceof FplApiError && e.status === 404) {
          setError(await entryNotFoundMessage());
        } else {
          setError(e instanceof FplApiError ? e.message : "Could not load this team.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, reloadKey]);

  const teams = useMemo(
    () => (data ? new Map(data.bootstrap.teams.map((t) => [t.id, t])) : new Map()),
    [data]
  );

  // Self-learning loop: grade past predictions against actual points, fold
  // the outcome into the calibration factors, then snapshot the (freshly
  // calibrated) prediction for the upcoming GW so IT can be graded next.
  const [calVersion, setCalVersion] = useState(0);
  /*
    * The pitch re-projects when the shared last-season record changes, so it is
    * always drawn on the same evidence the drafter used.
    *
    * This was a counter this component bumped itself, in one place, right after
    * its own load. That is only correct if the cache changes in one place, and
    * it does not. Pre-GW1 with no squad, this load can fail while the drafter's
    * — a different call, seconds later, on the same pool — succeeds: the cache
    * fills, nothing bumps, and the pitch spends the rest of the session quoting
    * a projection built without last season while the squad beside it was
    * drafted with it. A partial load later completed by a full one does the
    * same. The store knows when its records move; asking it is the whole fix.
    *
    * `useSyncExternalStore` rather than `useState` + a subscribing effect,
    * which is the same idea with a hole in it. An effect subscribes AFTER the
    * render that read the initial value, so a commit landing in that window is
    * never seen: the component would hold the pre-commit version for the rest
    * of the session and the pitch would stay on a record-blind projection with
    * nothing able to recover it. That window is empty today only by accident —
    * this component's first render has no `data`, so nothing has started a load
    * yet — and "correct because of what another effect happens to do first" is
    * not a property worth relying on. `useSyncExternalStore` re-reads the
    * snapshot after subscribing and re-renders if it moved, which is precisely
    * that gap, closed by the framework instead of by luck. The third argument
    * is the server snapshot: this is a client component under the App Router,
    * so it is still rendered once on the server.
    */
  const pastReady = useSyncExternalStore(
    subscribePastSeason,
    pastSeasonVersion,
    pastSeasonVersion
  );
  /*
   * The reader's own team news, restored from this device.
   *
   * Hydrated per FEED and re-hydrated whenever it changes: a call saved against
   * the demo's id 42 must not survive into the real feed, where 42 is a
   * different footballer. `lineup.ts` keys storage the same way, so this is the
   * one place the two have to agree.
   */
  const callsVersion = useSyncExternalStore(
    subscribeStartCalls,
    startCallsVersion,
    startCallsVersion
  );
  useEffect(() => {
    hydrateStartCalls(entryId === DEMO_ENTRY_ID);
  }, [entryId]);
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    const demo = entryId === DEMO_ENTRY_ID;
    (async () => {
      if (demo) seedDemoCalibration();
      const changed = await reconcileFinishedGws(demo, data.bootstrap, async (gw) => {
        const live = await api.live(gw);
        return new Map(live.elements.map((e) => [e.id, e.stats.total_points]));
      });
      if (cancelled) return;
      const nextEv = data.bootstrap.events.find((e) => e.is_next)?.id ?? null;
      if (nextEv != null) {
        // Grade the model we actually ship. Before GW1 the whole projection
        // rests on last season's per-player record, so snapshotting a run that
        // never loaded it would teach the calibration a correction for a model
        // nobody uses. Load it (cached; the drafter shares this) and wait.
        //
        // The `!demo` half is now a cost decision and nothing more. It used to
        // be load-bearing by accident — the store keyed on pool size and lowest
        // id, both of which the demo's 1..300 share with three hundred real
        // footballers, so loading here in demo mode would have poisoned the
        // cache for the real feed and vice versa. `pastSeasonStore` keys on the
        // feed now, so the choice is free: the demo is a MID-SEASON fixture,
        // every one of its players has minutes, `statLine` therefore prefers
        // the bootstrap, and three hundred round trips would buy nothing.
        let past = cachedPastSeason() ?? undefined;
        if (!past && !demo) {
          try {
            past = (await loadPastSeason(launchPool(data.bootstrap.elements))).data;
          } catch {
            past = undefined;
          }
          if (cancelled) return;
        }
        const xp = projectAll({
          bootstrap: data.bootstrap,
          fixtures: data.fixtures,
          nextEvent: nextEv,
          pastSeason: past && past.size > 0 ? past : undefined,
          /*
           * THE MODEL'S OWN OPINION, DELIBERATELY WITHOUT THE READER'S.
           *
           * This projection exists only to be graded once the gameweek
           * finishes, and the grade drives a per-POSITION multiplier applied to
           * every player in the game. Snapshotting an overridden run would feed
           * the reader's own team news into that: set a £4.0m defender to
           * "starts", have him not play, and the calibration concludes the
           * MODEL over-rates defenders and scales all of them down. The
           * correction would be real, applied globally, and sourced from
           * somebody else's mistake.
           *
           * Note this is the one place the rule "grade the model we actually
           * ship" is knowingly not followed, because what is being measured
           * here is the model's bias, and an override is not the model.
           */
          startCalls: new Map(),
        });
        snapshotPredictions(demo, nextEv, xp, currentSeasonName(data.bootstrap.events));
      }
      if (changed || demo) setCalVersion((v) => v + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [data, entryId]);

  const currentEventObj = data?.bootstrap.events.find((e) => e.is_current) ?? null;
  const currentEvent = currentEventObj?.id ?? data?.squad?.currentEvent ?? null;
  const gwFinished =
    (currentEventObj?.finished ?? false) ||
    (currentEvent != null &&
      data != null &&
      data.fixtures.some((f) => f.event === currentEvent) &&
      data.fixtures.filter((f) => f.event === currentEvent).every((f) => f.finished));

  /*
   * When to STOP polling, which is not the same question as `gwFinished`.
   *
   * `gwFinished` reads `data.fixtures`, fetched once when the page loaded. It
   * therefore cannot become true while the page is open, so using it to stop
   * the poll would mean never stopping. This reads the fixtures the poll itself
   * brings down, falling back to the page-load copy until the first tick lands.
   */
  const pollFixtures = liveFixtures ?? data?.fixtures ?? [];
  const livePollDone =
    currentEvent == null ||
    (currentEventObj?.finished ?? false) ||
    (pollFixtures.some((f) => f.event === currentEvent) &&
      pollFixtures.filter((f) => f.event === currentEvent).every((f) => f.finished));

  /*
   * LIVE POINTS FOR THE SQUAD VIEW, POLLED — this used to be a single fetch.
   *
   * The Live tab has refreshed itself since it was written; the Team tab, which
   * is the one that opens by default and the one people watch a match on, took
   * its scores once at page load and then sat there. Nothing on screen said so,
   * so a score that had stopped updating looked exactly like a score that had
   * not changed.
   *
   * Same terms as `LiveTab`, and each of them is load-bearing:
   *  - nothing at all once the gameweek is done, or off-season;
   *  - no tick while the tab is hidden, and one immediate catch-up when it
   *    comes back, so a phone in a pocket is not polling for ninety minutes;
   *  - fixtures come down WITH the scores. The stop condition is "every fixture
   *    this gameweek is finished", and reading that off the page-load copy
   *    would mean it could never become true — the poll would outlive the
   *    matches and keep going until the tab closed. `LiveTab` gets this right
   *    by refetching both, and the same reason applies here.
   *
   * The fresh fixtures are kept local rather than written back over
   * `data.fixtures`: half the dashboard reads that, and widening a
   * thirty-second poll into a re-render of all of it is not what this is for.
   */
  useEffect(() => {
    if (currentEvent == null) return;
    let cancelled = false;
    /*
     * LATEST WINS. `cancelled` is per-EFFECT, not per-request, so it does not
     * order two polls against each other: at 30-second ticks both are on the
     * wire whenever the client memo has expired, and if the earlier one is the
     * slower it lands last and overwrites the newer scores. Visible as points
     * going backwards. `LiveTab` has always had this guard and says so; the
     * squad view's poll was added later and did not, which is the kind of gap
     * that only appears when a fix is copied without its reasons.
     */
    const pull = () => {
      const mine = ++livePollSeq.current;
      api
        .live(currentEvent)
        .then((l) => !cancelled && mine === livePollSeq.current && setLiveData(l))
        .catch(() => {});
      api
        .fixtures()
        .then((f) => !cancelled && mine === livePollSeq.current && setLiveFixtures(f))
        .catch(() => {});
    };
    pull();
    if (livePollDone) return () => void (cancelled = true);
    const t = setInterval(() => {
      if (!document.hidden) pull();
    }, LIVE_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") pull();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [currentEvent, livePollDone]);

  // Load a past gameweek's picks + points when the time machine is used.
  useEffect(() => {
    if (viewGw == null || data == null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the time machine when leaving it
      setHist(null);
      setHistError(null);
      return;
    }
    let cancelled = false;
    setHistLoading(true);
    setHistError(null);
    Promise.all([api.picks(entryId, viewGw), api.live(viewGw)])
      .then(([picks, live]) => {
        if (!cancelled) setHist({ gw: viewGw, picks, live });
      })
      .catch(() => {
        if (!cancelled)
          setHistError(
            "Couldn't load that gameweek — FPL may have retired the data (last season's rounds disappear over the summer reset)."
          );
      })
      .finally(() => !cancelled && setHistLoading(false));
    return () => {
      cancelled = true;
    };
  }, [viewGw, entryId, data, histRetry]);

  const livePointsOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of liveData?.elements ?? []) m.set(e.id, e.stats.total_points);
    return m;
  }, [liveData]);

  // xP for the pitch view's "xP" mode (next gameweek). calVersion re-projects
  // after the calibration factors update; callsVersion after the reader
  // overrides someone's line-up status.
  const xpOf = useMemo(() => {
    const nextEv = data?.bootstrap.events.find((e) => e.is_next)?.id ?? null;
    if (!data || nextEv == null) return null;
    void calVersion;
    void pastReady;
    void callsVersion;
    const past = cachedPastSeason();
    return projectAll({
      bootstrap: data.bootstrap,
      fixtures: data.fixtures,
      nextEvent: nextEv,
      pastSeason: past ?? undefined,
    });
  }, [data, calVersion, pastReady, callsVersion]);

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

  // Effective XI after projected auto-subs. FPL swaps in bench players once a
  // starter's fixtures finish with 0 minutes, so the "final" team total must
  // count those subs (matches the official score before FPL processes it).
  const effectiveXiIds = useMemo(() => {
    if (!liveData || !data?.picks || currentEvent == null) return null;
    const elementById = new Map(data.bootstrap.elements.map((e) => [e.id, e]));
    const { effectiveXi } = projectAutoSubs(
      data.picks.picks,
      elementById,
      liveData,
      data.fixtures,
      currentEvent
    );
    return new Set(effectiveXi);
  }, [liveData, data, currentEvent]);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-16">
        <ErrorBox message={error} onRetry={() => setReloadKey((k) => k + 1)} />
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
  //
  // NET OF HITS ON BOTH SIDES. `history.current[].points` is gross — the cost
  // of the week's hits sits beside it in `event_transfers_cost` — and a
  // manager's gameweek score is the number after that cost, which is what the
  // gameweek time machine below, the live tab's header, and the points
  // breakdown's "Net" line all print. Differencing the gross figure made a −4
  // week read four points better than it was and disagreed with all three.
  // The headline this delta hangs under is reconciled to the same convention
  // by `netEventPoints` further down.
  let gwDelta: StatDelta | null = null;
  if (comparable) {
    const diff = netGwDelta(curr, past);
    gwDelta = {
      text: `${fmtSigned(diff)} pts`,
      period,
      good: diff === 0 ? null : diff > 0,
      direction: diff >= 0 ? "up" : "down",
    };
  }

  // Team value (squad + bank, which is what `value` already is), month over month.
  let valueStat: StatDelta | null = null;
  if (comparable) {
    const diff = valueDelta(curr, past);
    valueStat = {
      text: `${fmtSigned(diff / 10, 1)}m`,
      period,
      good: diff === 0 ? null : diff > 0,
      direction: diff >= 0 ? "up" : "down",
    };
  }

  // The headline for the "Latest GW" card, reconciled to the same net
  // convention as the delta printed under it. The history row is only handed
  // over when it is unambiguously the SAME gameweek the summary describes —
  // otherwise (a live week the history has not caught up with) a numeric
  // coincidence with the previous week's gross score could subtract a hit that
  // belongs to a different gameweek.
  const latestGwPoints = netEventPoints(
    entry.summary_event_points ?? null,
    curr != null && curr.event === entry.current_event ? curr : null
  );

  // Net, like every other gameweek figure in the app: a sparkline of gross
  // scores puts a spike on the very week a hit turned into a loss.
  const pointsTrend = rows.slice(-8).map((r) => netGwPoints(r));

  // "Chips left" shows everything still available this season; the subtitle
  // notes how many are usable right now (windows can open later).
  const chipsLeft = squad
    ? remainingChips(
        history.chips.map((c) => ({ name: c.name, event: c.event })),
        data.bootstrap.chips ?? null,
        squad.nextEvent,
        "season"
      )
    : [];
  const chipsNow = squad
    ? remainingChips(
        history.chips.map((c) => ({ name: c.name, event: c.event })),
        data.bootstrap.chips ?? null,
        squad.nextEvent,
        "now"
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
                <span className="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-accent opacity-60" />
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
          value={fmtNum(entry.summary_overall_points)}
          accent
          delta={pointsDelta}
          trend={pointsTrend.length > 1 ? pointsTrend : undefined}
          onClick={() => setKpiModal("points")}
        />
        <Stat
          label="Overall rank"
          value={fmtRank(entry.summary_overall_rank)}
          sub={
            rankPercentile(entry.summary_overall_rank, data.bootstrap.total_players) ?? undefined
          }
          delta={rankDelta}
          onClick={() => setKpiModal("rank")}
        />
        <Stat
          label="Latest GW"
          value={
            latestGwPoints != null ? `${latestGwPoints} pts` : "–"
          }
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
          delta={valueStat}
          onClick={() => setKpiModal("value")}
        />
        <Stat
          label="Free transfers"
          value={squad ? String(squad.freeTransfers) : "–"}
          sub={data.transfers.length > 0 ? `${data.transfers.length} made this season` : undefined}
          onClick={() => setKpiModal("transfers")}
        />
        <Stat
          label="Chips left"
          value={String(chipsLeft.length)}
          sub={
            chipsLeft.length > 0
              ? `${[...new Set(chipsLeft.map((c) => c.label))].join(", ")}${
                  chipsNow.length !== chipsLeft.length ? ` (${chipsNow.length} usable now)` : ""
                }`
              : "None"
          }
          onClick={() => setKpiModal("chips")}
        />
      </div>

      {/* Tabs — full-width hit areas on mobile, ≥44px tall */}
      <div className="sticky top-0 z-20 mt-4 -mx-4 flex border-b border-border-c bg-background/85 px-2 backdrop-blur sm:justify-start sm:gap-1 sm:px-4">
        {TABS.map(([key, label, short]) => (
          <button
            key={key}
            type="button"
            onClick={() => selectTab(key)}
            className={`flex-1 whitespace-nowrap border-b-2 px-1 py-3 text-xs font-medium sm:flex-none sm:px-3 sm:text-sm ${
              tab === key
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-foreground active:text-foreground"
            }`}
          >
            <span className="sm:hidden">{short}</span>
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      <div className="mt-4">
        <div hidden={tab !== "team"}>
        {visited.has("team") &&
          (squad ? (
            <div className="space-y-4">
              {/* Gameweek time machine */}
              {history.current.length > 1 && (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-sm text-muted">Gameweek:</label>
                  <select
                    value={viewGw ?? "latest"}
                    onChange={(e) =>
                      setViewGw(e.target.value === "latest" ? null : parseInt(e.target.value))
                    }
                    className="rounded-lg border border-border-c bg-panel-2 px-3 py-1.5 text-sm"
                  >
                    <option value="latest">Latest (GW{squad.currentEvent})</option>
                    {[...history.current]
                      .map((r) => r.event)
                      .filter((ev) => ev !== squad.currentEvent)
                      .sort((a, b) => b - a)
                      .map((ev) => (
                        <option key={ev} value={ev}>
                          GW{ev}
                        </option>
                      ))}
                  </select>
                  {viewGw != null && (
                    <button
                      onClick={() => setViewGw(null)}
                      className="rounded-lg border border-border-c bg-panel px-3 py-1.5 text-sm hover:border-accent"
                    >
                      ← Back to latest
                    </button>
                  )}
                </div>
              )}

              {viewGw != null ? (
                histLoading ? (
                  <Skeleton className="h-96" />
                ) : histError ? (
                  <ErrorBox message={histError} onRetry={() => setHistRetry((k) => k + 1)} />
                ) : hist ? (
                  (() => {
                    const elementById = new Map(data.bootstrap.elements.map((e) => [e.id, e]));
                    const ptsOf = new Map(hist.live.elements.map((e) => [e.id, e.stats.total_points]));
                    const toPlayer = (pk: (typeof hist.picks.picks)[number]) => {
                      const el = elementById.get(pk.element);
                      if (!el) return null;
                      return {
                        element: el,
                        isCaptain: pk.is_captain,
                        isVice: pk.is_vice_captain,
                        live: {
                          points:
                            (ptsOf.get(pk.element) ?? 0) * (pk.multiplier > 1 ? pk.multiplier : 1),
                          final: true,
                        },
                      };
                    };
                    const starters = hist.picks.picks
                      .filter((p) => p.position <= 11)
                      .map(toPlayer)
                      .filter((x): x is NonNullable<typeof x> => x != null);
                    const bench = hist.picks.picks
                      .filter((p) => p.position > 11)
                      .sort((a, b) => a.position - b.position)
                      .map(toPlayer)
                      .filter((x): x is NonNullable<typeof x> => x != null);
                    const eh = hist.picks.entry_history;
                    return (
                      <>
                        <Pitch
                          starters={starters}
                          bench={bench}
                          teams={teams}
                          fixtures={data.fixtures}
                          nextEvent={null}
                          onSelect={setSelected}
                          cornerTotal={{
                            title: `GW${hist.gw}`,
                            points: eh.points - eh.event_transfers_cost,
                            final: true,
                          }}
                        />
                        <p className="text-xs text-muted">
                          GW{hist.gw}: {eh.points - eh.event_transfers_cost} pts
                          {eh.event_transfers_cost > 0 && ` (after −${eh.event_transfers_cost} hit)`}
                          {" · "}bench {eh.points_on_bench} pts
                          {eh.rank != null && ` · GW rank ${eh.rank.toLocaleString("en-GB")}`}
                          {" · "}
                          {eh.event_transfers} transfer{eh.event_transfers === 1 ? "" : "s"} made
                          {hist.picks.active_chip &&
                            ` · chip: ${hist.picks.active_chip}`}{" "}
                          — tap a player for that week&apos;s breakdown.
                        </p>
                      </>
                    );
                  })()
                ) : null
              ) : (
                <>
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
                            .filter((p) =>
                              squad.activeChip === "bboost"
                                ? true
                                : effectiveXiIds
                                  ? effectiveXiIds.has(p.element.id)
                                  : p.pickPosition <= 11
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
                </>
              )}
            </div>
          ) : (
            (() => {
              const seasonStarted = data.bootstrap.events.some(
                (e) => e.is_current || e.finished
              );
              return seasonStarted ? (
                <div className="card p-6 text-muted">
                  No squad found — has this team played a gameweek this season yet?
                </div>
              ) : (
                <div className="card space-y-3 p-6">
                  <p className="font-semibold text-fg">Your squad isn&apos;t visible yet — that&apos;s normal before Gameweek 1.</p>
                  <p className="text-sm text-muted">
                    Even if you&apos;ve already picked your team in the FPL app, FPL
                    doesn&apos;t publish anyone&apos;s squad through its data feed until the
                    first deadline passes and Gameweek 1 kicks off. Until then this
                    tab, your points and rank all show a dash — nothing is wrong with
                    your team or your ID.
                  </p>
                  <p className="text-sm text-muted">
                    In the meantime, open{" "}
                    <button
                      type="button"
                      onClick={() => selectTab("optimize")}
                      className="font-semibold text-accent underline underline-offset-2"
                    >
                      Optimize
                    </button>{" "}
                    to plan and compare launch squads for Gameweek 1. Everything
                    fills in automatically once the season starts.
                  </p>
                </div>
              );
            })()
          ))}
        </div>
        {visited.has("optimize") && (
          <div hidden={tab !== "optimize"} className="space-y-6">
            <OptimizePanel data={data} onSelect={setSelected} />
            {/* How trustworthy are the projections above? key re-reads after
                the reconcile pass updates storage. */}
            <ModelAccuracy demo={entryId === DEMO_ENTRY_ID} key={calVersion} />
          </div>
        )}
        {visited.has("stats") && (
          <div hidden={tab !== "stats"}>
            <StatsTable data={data} onSelect={setSelected} xp={xpOf} />
          </div>
        )}
        {visited.has("fixtures") && (
          <div hidden={tab !== "fixtures"}>
            <FixtureTicker data={data} onSelect={setSelected} />
          </div>
        )}
        {visited.has("live") && (
          <div hidden={tab !== "live"}>
            <LiveTab data={data} onSelect={setSelected} active={tab === "live"} />
          </div>
        )}
        {visited.has("league") && (
          <div hidden={tab !== "league"}>
            <MiniLeague data={data} entryId={entryId} />
          </div>
        )}
        {visited.has("history") && (
          <div hidden={tab !== "history"} className="space-y-6">
            <HistoryChart data={data} entryId={entryId} />
            <PointsBreakdown data={data} entryId={entryId} onSelect={setSelected} />
          </div>
        )}
      </div>

      {kpiModal && (
        <KpiHistoryModal metric={kpiModal} data={data} onClose={() => setKpiModal(null)} />
      )}

      {selected && (
        <PlayerModal
          element={selected}
          team={teams.get(selected.team)}
          live={tab === "team" && hist ? hist.live : liveData}
          event={tab === "team" && hist ? hist.gw : currentEvent}
          gwFinished={tab === "team" && hist ? true : gwFinished}
          onClose={() => setSelected(null)}
          fixtures={data.fixtures}
          teams={teams}
          nextEvent={data.squad?.nextEvent ?? null}
        />
      )}
    </main>
  );
}
