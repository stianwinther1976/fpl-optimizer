"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { api, entryNotFoundMessage, FplApiError, loadTeamData, fmtNum, fmtRank, rankPercentile, DEMO_ENTRY_ID, type TeamData } from "@/lib/fpl";
import type { Element, EntryEventPicks, EventLive, Fixture } from "@/lib/types";
import { fmtPrice, remainingChips } from "@/lib/rules";
import { projectAll } from "@/lib/xp";
import { projectAutoSubs, provisionalBonus, LIVE_REFRESH_MS } from "@/lib/live";
import {
  benchBadgeFor,
  benchSortKey,
  benchSummary,
  liveCornerNote,
  netEventPoints,
  netGwDelta,
  netGwPoints,
  valueDelta,
} from "@/lib/display";
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
  cachedRecentForm,
  recentFormVersion,
  subscribeRecentForm,
} from "@/lib/recentFormStore";
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
  const recentReady = useSyncExternalStore(
    subscribeRecentForm,
    recentFormVersion,
    recentFormVersion
  );
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
  // The gameweek a line-up call is about. Same anchor `projectAll` calls
  // offset 0, so a stamped call and the projection cannot disagree.
  const squadNextEvent = data?.squad?.nextEvent ?? null;
  const callsVersion = useSyncExternalStore(
    subscribeStartCalls,
    startCallsVersion,
    startCallsVersion
  );
  /*
   * RE-HYDRATED ON THE GAMEWEEK, NOT JUST ON THE FEED. A call is about one
   * match, and `loadStartCalls` now enforces that by dropping a payload
   * stamped with a gameweek that is no longer next. Keying this effect on
   * `entryId` alone would leave the expired set in memory until a remount, so
   * the reader would keep seeing a stale call applied for the rest of the
   * session. `squadNextEvent` is null while the team is still loading, which
   * hydrates to empty — the right way round: no call is applied until the app
   * knows which gameweek it would be applied to.
   */
  useEffect(() => {
    hydrateStartCalls(entryId === DEMO_ENTRY_ID, squadNextEvent);
  }, [entryId, squadNextEvent]);
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
          /*
           * RECENT FORM IS NOT AN OVERRIDE, AND WAS BEING TREATED AS ONE BY
           * OMISSION. It is model input fetched from the official API, not a
           * reader's opinion, so leaving it out here graded a projection the
           * app does not ship: once `OptimizePanel` has run, the pitch and the
           * Stats table are built WITH it while the calibration snapshot was
           * built without. That is verbatim the failure `pastSeasonStore`
           * records — "calibration was grading predictions the shipped drafter
           * never made" — reintroduced for a different input, and the
           * calibration's output is a per-position multiplier applied to every
           * player in the game.
           *
           * `recentReady` is in this effect's dependency array for the same
           * reason: without it the snapshot is taken once, before the fetch
           * lands, and never revisited. `snapshotPredictions` overwrites, so
           * the last projection before the deadline wins — which is the most
           * informed one.
           */
          recentForm: cachedRecentForm() ?? undefined,
        });
        snapshotPredictions(demo, nextEv, xp, currentSeasonName(data.bootstrap.events));
      }
      if (changed || demo) setCalVersion((v) => v + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [data, entryId, recentReady]);

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

  /*
   * THE SAME POINTS THE LIVE TAB SHOWS, PROVISIONAL BONUS INCLUDED.
   *
   * This map is what the Team pitch draws its per-player scores and its corner
   * total from, and it was `stats.total_points` alone while `LiveTab` adds
   * `provisionalBonus` — so between the final whistle and bonus confirmation,
   * hours after a Saturday, the two tabs disagreed about the same squad by two
   * to eight points. Invisible on the demo, whose in-play fixtures itemise
   * bonus into `explain` so `provisionalBonus` returns an empty map, which is
   * why it survived every browser sweep.
   */
  const liveBonus = useMemo(
    () =>
      liveData && currentEvent != null
        ? provisionalBonus(data!.bootstrap, data!.fixtures, liveData, currentEvent)
        : null,
    [liveData, data, currentEvent]
  );
  const livePointsOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of liveData?.elements ?? []) {
      m.set(e.id, e.stats.total_points + (liveBonus?.byElement.get(e.id) ?? 0));
    }
    return m;
  }, [liveData, liveBonus]);

  // xP for the pitch view's "xP" mode (next gameweek). calVersion re-projects
  // after the calibration factors update; callsVersion after the reader
  // overrides someone's line-up status.
  const xpOf = useMemo(() => {
    const nextEv = data?.bootstrap.events.find((e) => e.is_next)?.id ?? null;
    if (!data || nextEv == null) return null;
    void calVersion;
    void pastReady;
    void callsVersion;
    void recentReady;
    const past = cachedPastSeason();
    return projectAll({
      bootstrap: data.bootstrap,
      fixtures: data.fixtures,
      nextEvent: nextEv,
      pastSeason: past ?? undefined,
      /*
       * THE SAME RECENT FORM THE OPTIMIZE PANEL USES, once it has fetched it.
       * Without this the Stats table and the transfer plans quoted different
       * five-gameweek xP for the same player in one page load — 13.8 against
       * 14.5 on a player the plan was recommending selling, with nothing on
       * either screen to say why. `StatsTable`'s header claims that defect was
       * closed by handing it this projection; it was only moved here.
       */
      recentForm: cachedRecentForm() ?? undefined,
    });
  }, [data, calVersion, pastReady, callsVersion, recentReady]);

  const liveMinutesOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of liveData?.elements ?? []) m.set(e.id, e.stats.minutes);
    return m;
  }, [liveData]);


  // Effective XI after projected auto-subs. FPL swaps in bench players once a
  // starter's fixtures finish with 0 minutes, so the "final" team total must
  // count those subs (matches the official score before FPL processes it).
  const autoSubs = useMemo(() => {
    if (!liveData || !data?.picks || currentEvent == null) return null;
    /*
     * THIS SET DESCRIBES `data.picks`, WHICH IS NOT ALWAYS `squad.players`.
     *
     * Two cases where using it to split the pitch draws the wrong team:
     *
     *  - FREE HIT. `loadTeamData` deliberately builds `squad.players` from the
     *    PREVIOUS gameweek's picks, because the one-week team is not the squad
     *    that matters for transfers. Intersecting the base squad with the Free
     *    Hit XI leaves whoever happens to be in both — probed at 2 cards on the
     *    pitch and 13 on the bench, in an impossible formation, possibly with
     *    no keeper. The pitch now draws `squad.currentPlayers`, which IS the
     *    Free Hit fifteen, so the sets agree again — but the bail stays,
     *    because it is also what stops a Free Hit week being rendered from a
     *    squad the reader is not fielding if a caller ever passes `players`.
     *  - BENCH BOOST. All fifteen score and FPL makes no substitution at all,
     *    so the "effective XI" is the picked eleven. `display.ts`'s
     *    `autoSubView` exists for this seam and `componentInvariants` has a
     *    whole block on it — which reads only `LiveTab.tsx`, so it could not
     *    see this call site. The time-machine branch below has the guard; the
     *    live branch did not.
     *
     * Returning null in both cases sends every consumer back to
     * `pickPosition <= 11`, which is the right answer for each.
     */
    if (data.picks.active_chip === "bboost") return null;
    if (data.picks.active_chip === "freehit") return null;
    const elementById = new Map(data.bootstrap.elements.map((e) => [e.id, e]));
    const { effectiveXi, out } = projectAutoSubs(
      data.picks.picks,
      elementById,
      liveData,
      data.fixtures,
      currentEvent
    );
    return { xi: new Set(effectiveXi), out: new Set(out) };
  }, [liveData, data, currentEvent]);
  const effectiveXiIds = autoSubs?.xi ?? null;

  /*
   * Effective captain: Triple Captain aware; once the GW is final, the vice
   * takes over if the captain played 0 minutes (official rule).
   *
   * `currentPlayers`, not `players` — this is a statement about THIS
   * gameweek's armband, and `players` carries next gameweek's transfers (and,
   * in a Free Hit week, an entirely different fifteen).
   */
  const capMult = data?.squad?.activeChip === "3xc" ? 3 : 2;
  const effCaptainId = useMemo(() => {
    const squad = data?.squad;
    if (!squad) return null;
    const cap = squad.currentPlayers.find((p) => p.isCaptain);
    const vice = squad.currentPlayers.find((p) => p.isViceCaptain);
    /*
     * THE SAME TEST THE LIVE TAB USES, WHICH THIS ONE WAS NOT.
     *
     * `gwFinished` waits for `finished` on every fixture — bonus confirmed —
     * while `LiveTab` asks `gwDone || the auto-sub projection dropped him`, and
     * that projection was moved to full time (`finished_provisional`) earlier
     * in this session. So for the hours FPL takes to settle a Saturday the Live
     * tab swapped the armband and the Team pitch did not: probed at six points
     * apart on identical data, 66 against 72.
     *
     * The Dashboard was the wrong one. A takeover turns on MINUTES, which are
     * settled at the whistle — the same argument that moved `doneOnZero`.
     * `autoSubs.out` is that judgement already made, so using it also means the
     * two tabs cannot drift apart again.
     */
    const capBlanked =
      cap != null && (gwFinished || (autoSubs?.out.has(cap.element.id) ?? false));
    if (
      capBlanked &&
      cap &&
      (liveMinutesOf.get(cap.element.id) ?? 0) === 0 &&
      vice &&
      (liveMinutesOf.get(vice.element.id) ?? 0) > 0
    ) {
      return vice.element.id;
    }
    return cap?.element.id ?? null;
  }, [data, gwFinished, liveMinutesOf, autoSubs]);

  /*
   * The gross the eleven on the pitch have scored, and the hit that separates
   * it from the corner total. Lifted out of the JSX so both can be printed:
   * the corner is net and the cards are not, and nothing said so.
   */
  const liveHit = data?.picks?.entry_history.event_transfers_cost ?? 0;
  const liveGross = useMemo(() => {
    const squad = data?.squad;
    if (!squad || !liveData) return 0;
    return squad.currentPlayers
      .filter((p) =>
        squad.activeChip === "bboost"
          ? true
          : effectiveXiIds
            ? effectiveXiIds.has(p.element.id)
            : p.pickPosition <= 11
      )
      .reduce(
        (s, p) =>
          s + (livePointsOf.get(p.element.id) ?? 0) * (p.element.id === effCaptainId ? capMult : 1),
        0
      );
  }, [data, liveData, effectiveXiIds, livePointsOf, effCaptainId, capMult]);
  const liveHitNote = liveCornerNote(liveGross, liveHit);


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

  const fmtSigned = (n: number, digits = 0, unit = "") =>
    `${n > 0 ? "+" : n < 0 ? "−" : "±"}${unit}${Math.abs(n).toLocaleString("en-GB", {
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
      // `£` on both sides of the sign, because the modal that opens from this
      // card renders `£0.0m` for the same pair and the card rendered `±0.0m`.
      text: `${fmtSigned(diff / 10, 1, "£")}m`,
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

  /*
   * "Chips left" shows everything still available this season; the subtitle
   * notes how many are usable right now (windows can open later).
   *
   * NOT GATED ON `squad`, WHICH MADE IT SAY ZERO. Before GW1 there are no picks
   * to build a squad from, and the card read `Chips left / 0 / None` while the
   * modal it opens — which has no such gate — listed all six. A manager who has
   * played nothing holds every chip; zero is not "unknown", it is the opposite
   * of the truth. The page's own copy two inches below says a missing squad is
   * normal before GW1 and that only points and rank show a dash.
   *
   * `squad?.nextEvent ?? null` is what the modal passes, and `remainingChips`
   * treats null as "no window filter", which is right when there is no
   * gameweek to filter on.
   */
  const chipsUsed = history.chips.map((c) => ({ name: c.name, event: c.event }));
  const chipsLeft = remainingChips(
    chipsUsed,
    data.bootstrap.chips ?? null,
    squad?.nextEvent ?? null,
    "season"
  );
  const chipsNow = remainingChips(
    chipsUsed,
    data.bootstrap.chips ?? null,
    squad?.nextEvent ?? null,
    "now"
  );

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/"
            className="-ml-2 inline-flex min-h-11 items-center px-2 text-xs text-muted hover:text-accent"
          >
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
      {/*
          SEVEN BUTTONS ARE NOT A TAB STRIP UNTIL THEY SAY SO.
          The accessibility tree contained no `tab` and no `tablist`, no
          `aria-selected` and no `aria-current`, so a screen-reader user got
          seven identically-shaped buttons with nothing stating which view they
          were in. The only difference between selected and unselected was
          accent green on muted grey — colour alone, which for a red/green
          deficient reader is no difference at all. `aria-selected` fixes the
          first; the `font-semibold` below fixes the second without needing a
          second colour.
      */}
      <div
        role="tablist"
        aria-label="Dashboard sections"
        className="sticky top-0 z-20 mt-4 -mx-4 flex border-b border-border-c bg-background/85 px-2 backdrop-blur sm:justify-start sm:gap-1 sm:px-4"
      >
        {TABS.map(([key, label, short]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            /*
             * ROVING TABINDEX AND ARROW KEYS, because `role="tablist"` is a
             * PROMISE about the keyboard and the strip was making it without
             * keeping it: every tab had `tabindex` unset and the arrow keys did
             * nothing, so a screen-reader user was told "tab, 1 of 7" and then
             * found the only way through was Tab, seven stops, exactly as if
             * the roles were not there. Announcing a pattern and not
             * implementing it is worse than plain buttons, which at least do
             * not lie about how they work.
             */
            tabIndex={tab === key ? 0 : -1}
            onKeyDown={(e) => {
              const order = TABS.map(([k]) => k);
              const at = order.indexOf(tab);
              const to =
                e.key === "ArrowRight" || e.key === "ArrowDown"
                  ? (at + 1) % order.length
                  : e.key === "ArrowLeft" || e.key === "ArrowUp"
                    ? (at - 1 + order.length) % order.length
                    : e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? order.length - 1
                        : -1;
              if (to < 0) return;
              e.preventDefault();
              selectTab(order[to]);
              // Focus follows selection, which is the automatic-activation
              // variant of the pattern — right here, because selecting a tab is
              // cheap and every panel is already mounted.
              document.getElementById(`tab-${order[to]}`)?.focus();
            }}
            onClick={() => selectTab(key)}
            className={`min-h-11 flex-1 whitespace-nowrap border-b-2 px-1 py-3 text-xs sm:flex-none sm:px-3 sm:text-sm ${
              tab === key
                ? "border-accent font-semibold text-accent"
                : "border-transparent font-medium text-muted hover:text-foreground active:text-foreground"
            }`}
          >
            <span className="sm:hidden">{short}</span>
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      <div className="mt-4">
        <div hidden={tab !== "team"} role="tabpanel" id="panel-team" aria-labelledby="tab-team">
        {visited.has("team") &&
          (squad ? (
            <div className="space-y-4">
              {/* Gameweek time machine */}
              {history.current.length > 1 && (
                <div className="flex flex-wrap items-center gap-2">
                  {/* `htmlFor` is what makes the visible label the accessible
                      name; without it this reads as an unnamed combo box, and
                      it changes the entire squad view. */}
                  <label htmlFor="gw-time-machine" className="text-sm text-muted">
                    Gameweek:
                  </label>
                  <select
                    id="gw-time-machine"
                    aria-label="View the squad as it was in an earlier gameweek"
                    value={viewGw ?? "latest"}
                    onChange={(e) =>
                      setViewGw(e.target.value === "latest" ? null : parseInt(e.target.value))
                    }
                    className="min-h-11 rounded-lg border border-border-c bg-panel-2 px-3 py-1.5 text-sm"
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
                    /*
                       THE TIME MACHINE HAS THE SAME SPLIT, AND WORSE.
                       A finished gameweek's auto-subs are settled fact, not a
                       projection, so drawing the picked eleven here is simply
                       showing the wrong team. Measured on the demo's GW5: the
                       eleven cards summed to 30 against a caption reading 40,
                       because a keeper who blanked was drawn in goal while the
                       bench keeper who replaced him and scored 10 was drawn on
                       the bench.
                       Under Bench Boost all fifteen count and no sub happens,
                       so the picked split is the right one there.
                    */
                    const histXi =
                      hist.picks.active_chip === "bboost"
                        ? null
                        : new Set(
                            projectAutoSubs(
                              hist.picks.picks,
                              elementById,
                              hist.live,
                              data.fixtures,
                              hist.gw
                            ).effectiveXi
                          );
                    const starters = hist.picks.picks
                      .filter((p) => (histXi ? histXi.has(p.element) : p.position <= 11))
                      .map(toPlayer)
                      .filter((x): x is NonNullable<typeof x> => x != null);
                    const bench = hist.picks.picks
                      .filter((p) => (histXi ? !histXi.has(p.element) : p.position > 11))
                      .sort((a, b) => benchSortKey(a.position) - benchSortKey(b.position))
                      .map((p) => {
                        const card = toPlayer(p);
                        return card && { ...card, benchOrder: benchBadgeFor(p.position) };
                      })
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
                          {" · "}
                          {benchSummary(
                            eh.points_on_bench,
                            bench.map((c) => ({ points: c.live?.points ?? 0 })),
                            hist.picks.active_chip === "bboost"
                          )}
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
              {/*
                  DRAW THE ELEVEN THAT SCORED, NOT THE ELEVEN THAT WAS PICKED.
                  The corner total is computed from `effectiveXiIds` — the XI
                  after projected auto-subs — while the cards were filtered on
                  `pickPosition <= 11`. So a starter who blanked was drawn on
                  the pitch and the substitute who replaced him was drawn on
                  the bench, and the eleven cards did not add up to the number
                  printed on the same pitch. Measured on the demo's live GW20:
                  the picked eleven's cards summed to 50 while the effective
                  eleven scored 52, so the corner read 48 after the week's
                  4-point hit — a blanking forward drawn on the pitch and the
                  2-point defender who replaced him drawn on the bench.
                  Two tabs away `LiveTab` renders the same gameweek correctly.
                  Falls back to the picked eleven before any live data exists.
              */}
              <Pitch
                starters={squad.currentPlayers
                  .filter((p) =>
                    effectiveXiIds ? effectiveXiIds.has(p.element.id) : p.pickPosition <= 11
                  )
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
                bench={squad.currentPlayers
                  .filter((p) =>
                    effectiveXiIds ? !effectiveXiIds.has(p.element.id) : p.pickPosition > 11
                  )
                  .sort((a, b) => benchSortKey(a.pickPosition) - benchSortKey(b.pickPosition))
                  .map((p) => ({
                    element: p.element,
                    xp: xpOf?.get(p.element.id)?.next,
                    benchOrder: benchBadgeFor(p.pickPosition),
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
                    ? { title: `GW${currentEvent}`, points: liveGross - liveHit, final: gwFinished }
                    : null
                }
              />
              <p className="text-xs text-muted">
                {liveData
                  ? gwFinished
                    ? `Final GW${currentEvent} points shown under each player — tap a player for the full breakdown.`
                    : `Live GW${currentEvent} points shown in green under each player (captain doubled) — tap a player for the breakdown.`
                  : "Tap a player for details."}{" "}
                {/*
                  SAY WHERE THE MISSING FOUR POINTS WENT. The corner is net of
                  the gameweek's transfer cost and the cards above it are not,
                  so a −4 week put 48 in the corner over eleven cards summing to
                  52 with the word "hit" appearing nowhere on the tab. The
                  historic view of this very pitch already discloses it, and so
                  does the Live tab; only this one did not.
                */}
                {liveData && liveHitNote ? `${liveHitNote} ` : ""}
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
          <div hidden={tab !== "optimize"} role="tabpanel" id="panel-optimize" aria-labelledby="tab-optimize" className="space-y-6">
            <OptimizePanel data={data} onSelect={setSelected} />
            {/* How trustworthy are the projections above? key re-reads after
                the reconcile pass updates storage. */}
            <ModelAccuracy demo={entryId === DEMO_ENTRY_ID} key={calVersion} />
          </div>
        )}
        {visited.has("stats") && (
          <div hidden={tab !== "stats"} role="tabpanel" id="panel-stats" aria-labelledby="tab-stats">
            <StatsTable
              data={data}
              onSelect={setSelected}
              xp={xpOf}
              recentFormApplied={cachedRecentForm() != null}
            />
          </div>
        )}
        {visited.has("fixtures") && (
          <div hidden={tab !== "fixtures"} role="tabpanel" id="panel-fixtures" aria-labelledby="tab-fixtures">
            <FixtureTicker data={data} onSelect={setSelected} />
          </div>
        )}
        {visited.has("live") && (
          <div hidden={tab !== "live"} role="tabpanel" id="panel-live" aria-labelledby="tab-live">
            <LiveTab data={data} onSelect={setSelected} active={tab === "live"} />
          </div>
        )}
        {visited.has("league") && (
          <div hidden={tab !== "league"} role="tabpanel" id="panel-league" aria-labelledby="tab-league">
            <MiniLeague data={data} entryId={entryId} />
          </div>
        )}
        {visited.has("history") && (
          <div hidden={tab !== "history"} role="tabpanel" id="panel-history" aria-labelledby="tab-history" className="space-y-6">
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
          /* The card the reader tapped applies this; the sheet must agree. In
             the time machine the armband is that gameweek's, not today's. */
          /* The time machine's gameweek, so the sheet stops describing today
             under a past week's heading. */
          asOfGw={tab === "team" && hist ? hist.gw : null}
          multiplier={
            tab === "team" && hist
              ? (hist.picks.picks.find((p) => p.element === selected.id)?.multiplier ?? 1)
              : selected.id === effCaptainId
                ? capMult
                : 1
          }
        />
      )}
    </main>
  );
}
