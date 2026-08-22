"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type TeamData } from "@/lib/fpl";
import type { EntryEventPicks, EventLive, Fixture, Pick } from "@/lib/types";
import {
  bandMedianScore,
  matchMinute,
  projectAutoSubs,
  provisionalBonus,
  isInPlay,
  LIVE_REFRESH_MS,
  feedStallMs,
  advanceFeedWatch,
  type FeedWatch,
} from "@/lib/live";
import {
  autoSubView,
  benchPoints,
  kickOffPassed,
  liveStaleMinutes,
  kickoffLabel,
  publishedAverage,
} from "@/lib/display";
import { ErrorBox, Skeleton, Badge } from "./ui";
import MatchModal from "./MatchModal";

// Interval lives in `lib/live.ts` so this and the squad view stay in step.

export default function LiveTab({
  data,
  onSelect,
  active = true,
}: {
  data: TeamData;
  onSelect?: (el: import("@/lib/types").Element) => void;
  /** false while the tab is hidden — pauses polling. */
  active?: boolean;
}) {
  const [live, setLive] = useState<EventLive | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>(data.fixtures);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // 0 until the first tick, which reads as "not stale" — correct, because
  // `updatedAt` is still null then and there is nothing on screen to be stale.
  const [nowMs, setNowMs] = useState(0);
  /*
   * State, not a ref: it is read during render, and `react-hooks/refs` rejects
   * that — correctly, since a ref written on a poll and read on a repaint is a
   * tearing hazard. `advanceFeedWatch` returns the SAME object when nothing
   * moved, so setting it every thirty seconds costs no repaint.
   */
  const [feedWatch, setFeedWatch] = useState<FeedWatch>({ sig: "", at: 0 });
  const [bandPicks, setBandPicks] = useState<EntryEventPicks[] | null>(null);
  const bandTried = useRef(false);
  const [matchOpen, setMatchOpen] = useState<Fixture | null>(null);
  // Latest-wins guard: an older in-flight response must never overwrite a
  // newer one (visible as scores briefly going backwards).
  const seq = useRef(0);

  const currentEventObj = data.bootstrap.events.find((e) => e.is_current) ?? null;
  const currentEvent = currentEventObj?.id ?? data.squad?.currentEvent ?? null;

  /**
   * @param force for the "Refresh now" button. The client memo holds a live
   *   feed for 25 seconds, so without this a reader who presses it inside that
   *   window gets the promise they already had — a control labelled "now" that
   *   demonstrably does nothing, pressed precisely when the numbers look wrong.
   */
  const refresh = useCallback(async (force = false) => {
    if (currentEvent == null) return;
    const my = ++seq.current;
    try {
      const [l, fx] = await Promise.all([api.live(currentEvent, force), api.fixtures(force)]);
      if (my !== seq.current) return; // stale response
      setLive(l);
      setFixtures(fx);
      setUpdatedAt(new Date());
      // The watch advances on the PAYLOAD, not on the request succeeding.
      setFeedWatch((w) => advanceFeedWatch(w, fx, currentEvent, Date.now()));
      setError(null);
    } catch {
      if (my !== seq.current) return;
      setError("Could not fetch live data.");
    }
  }, [currentEvent]);

  // One initial fetch (also shows final points after the GW is done).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh() only sets state after awaiting the network
    refresh();
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- seq is a plain counter, not a DOM ref; bumping it is exactly the point
      seq.current++; // invalidate in-flight responses on unmount/entry switch
    };
  }, [refresh]);

  // Poll only while the gameweek can still change: not finished, and at least
  // one fixture not yet completed. Off-season and finished GWs stay quiet.
  const gwDone =
    currentEvent == null ||
    (currentEventObj?.finished ?? false) ||
    (fixtures.some((f) => f.event === currentEvent) &&
      fixtures.filter((f) => f.event === currentEvent).every((f) => f.finished));

  useEffect(() => {
    if (currentEvent == null || gwDone || !active) return;
    // Skip ticks while the browser tab is hidden; catch up when it returns.
    const t = setInterval(() => {
      if (!document.hidden) refresh();
    }, LIVE_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, currentEvent, gwDone, active]);

  /*
   * The staleness clock. Runs only while the gameweek can still change, so a
   * finished gameweek and the off-season repaint nothing. A third of the poll
   * interval, which is what makes "N min old" tick up rather than jump.
   */
  useEffect(() => {
    if (gwDone) return;
    // No eager set: `nowMs` starts at 0, which reads as "not stale", and that
    // is the right answer for the first tick's worth of a freshly opened tab.
    const t = setInterval(() => setNowMs(Date.now()), LIVE_REFRESH_MS / 3);
    return () => clearInterval(t);
  }, [gwDone]);

  const elementById = useMemo(
    () => new Map(data.bootstrap.elements.map((e) => [e.id, e])),
    [data.bootstrap]
  );

  /*
   * Personalised safety score: sample ~20 managers at the reader's overall-rank
   * band (the Overall league is paged in rank order) and take the median of
   * their net live scores — the score needed to keep pace with their peers.
   *
   * FETCHED ONCE, SCORED EVERY POLL. It used to be both: one effect fetched the
   * picks AND scored them, behind a `bandTried` ref that never reset, so the
   * benchmark was a snapshot of the first live payload while the reader's own
   * total kept moving every thirty seconds. Left long enough that is not a
   * comparison at all — the number the app tells you to beat is the score your
   * rivals had when you opened the tab, and "you're N above; on course to climb"
   * is what almost everyone sees by the end of a Saturday.
   *
   * Picks genuinely do not change during a gameweek, so fetching them once is
   * right; the scoring is what has to follow the feed. Splitting the two also
   * closes the second asymmetry in the same comparison — see the bonus note in
   * the memo below.
   */
  useEffect(() => {
    if (bandTried.current || currentEvent == null) return;
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
        const picks = (
          await Promise.all(
            sample.map((r) => api.picks(r.entry, currentEvent).catch(() => null))
          )
        ).filter((p): p is EntryEventPicks => p != null);
        if (picks.length >= 5) setBandPicks(picks);
      } catch {}
    })();
  }, [currentEvent, data.entry]);

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

  /**
   * The rank band's median live score, recomputed on every poll.
   *
   * PROVISIONAL BONUS ON BOTH SIDES, WHICH IT WAS NOT. The reader's own total
   * is `(raw + projectedBonus) * multiplier`; the benchmark was
   * `stats.total_points` alone. So through the window CLAUDE.md describes as
   * "hours apart" — final whistle to bonus confirmation — the app credited the
   * reader two to eight points it credited nobody they were being compared
   * against, and then printed "you're N above; on course to climb". Everything
   * else in this comparison is already symmetric: both sides net of hits, both
   * with projected auto-subs. `provisionalBonus` is per PLAYER, so the same map
   * applies to a rival's picks unchanged.
   *
   * It does not bite on the demo — `demo.ts` itemises bonus in `explain` for
   * in-play fixtures, so `provisionalBonus` returns an empty map there — which
   * is why it could only be found by reading the two code paths against each
   * other.
   */
  const bandSafety = useMemo(
    () =>
      bandPicks && live && currentEvent != null
        ? bandMedianScore(
            bandPicks,
            elementById,
            live,
            fixtures,
            currentEvent,
            bonus?.byElement ?? null,
            gwDone
          )
        : null,
    [bandPicks, live, bonus, elementById, fixtures, currentEvent, gwDone]
  );

  // Projected auto-subs: once a starter's matches have finished with 0
  // minutes, the bench steps in (like FPL will do when the GW is processed).
  const autoSubs = useMemo(() => {
    if (!live || !data.squad || currentEvent == null) return null;
    /*
   * `currentPlayers` THROUGHOUT THIS FILE, and it is the whole file's subject.
   *
   * `squad.players` is the squad to optimize from: it has next gameweek's
   * transfers already applied and, in a Free Hit week, is the fifteen the Free
   * Hit replaced. Every number on this tab is about THIS gameweek's scores, so
   * rendering that list meant a player who actually played vanishing from the
   * table and an incoming player appearing with points he scored for someone
   * else — and, because the auto-sub projection reads the real picks, the two
   * disagreeing about who is even in the team.
   */
  const picks: Pick[] = data.squad.currentPlayers.map((p) => ({
      element: p.element.id,
      position: p.pickPosition,
      multiplier: 0,
      is_captain: p.isCaptain,
      is_vice_captain: p.isViceCaptain,
    }));
    return projectAutoSubs(picks, elementById, live, fixtures, currentEvent);
  }, [live, data.squad, elementById, fixtures, currentEvent]);

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
  /*
   * BLANK THE TAB ONLY WHEN THERE IS NOTHING TO BLANK. This used to return the
   * error box on any failed poll, which threw away a working live view — fifteen
   * rows, the scores, the bench — because one request out of a hundred timed
   * out. During a match that is the worst possible moment to have the screen
   * replaced by a message. With data in hand the failure is reported by the
   * staleness strip below instead, which says how old the numbers are rather
   * than hiding them.
   */
  if (error && !live)
    return (
      <ErrorBox
        message={`${error}${gwDone ? "" : " Retrying automatically every 30s."}`}
        onRetry={refresh}
      />
    );
  if (!live || !data.squad) return <Skeleton className="h-64" />;

  // `isInPlay`, not `started && !finished`: `finished` means BONUS CONFIRMED,
  // so for hours after a Saturday the header showed a pulsing dot and
  // "Live GW n" over fixture chips that all read "FT" in muted styling. The
  // commit that introduced `isInPlay` converted the chips one line below this
  // and missed the header.
  const anyLive = gwFixtures.some(isInPlay);
  const statById = new Map(live.elements.map((e) => [e.id, e.stats]));
  /** Projected bonus on the rows this screen actually draws — see the legend. */
  const myStarBonus = data.squad.currentPlayers.reduce(
    (n, p) => n + (bonus?.byElement.get(p.element.id) ?? 0),
    0
  );
  const bboost = data.squad.activeChip === "bboost";
  const hits = data.picks?.entry_history.event_transfers_cost ?? 0;
  // Chip-aware: a Bench Boost week has no substitutions to project, so the
  // effective eleven is simply the eleven that were picked. See `autoSubView`.
  const { xi: effXi, subbedIn, subbedOut } = autoSubView(
    data.squad.currentPlayers.filter((p) => p.pickPosition <= 11).map((p) => p.element.id),
    autoSubs,
    bboost
  );
  // Read straight off the RAW projection, which is chip-blind on purpose:
  // Bench Boost cancels the substitution but not the vice-captain rule, which
  // FPL applies in every week regardless of chip.
  //
  // Precisely: this is "starters who blanked AND for whom a legal replacement
  // was found" — `projectAutoSubs` only pushes to `out` once it has a partner
  // to push to `in`. A blanking starter with no legal sub (bench all blanked
  // too, or no formation-valid swap) is therefore ABSENT here, so the vice
  // takeover is not triggered until the gameweek finishes and `gwDone` covers
  // it. That is the pre-existing behaviour, kept deliberately: the narrower
  // set never fires the takeover early, it only fires it late.
  const blankedStarters = new Set(autoSubs?.out ?? []);

  // Effective captain: vice takes over once the captain can no longer play
  // (GW final, or all of the captain's matches finished on 0 minutes).
  const capMult = data.squad.activeChip === "3xc" ? 3 : 2;
  const cap = data.squad.currentPlayers.find((p) => p.isCaptain);
  const vice = data.squad.currentPlayers.find((p) => p.isViceCaptain);
  const capGone = cap != null && (gwDone || blankedStarters.has(cap.element.id));
  const effCapId =
    capGone &&
    (statById.get(cap.element.id)?.minutes ?? 0) === 0 &&
    vice &&
    (statById.get(vice.element.id)?.minutes ?? 0) > 0
      ? vice.element.id
      : cap?.element.id;

  const rows = data.squad.currentPlayers
    .map((p) => {
      const s = statById.get(p.element.id);
      const counts = bboost || effXi.has(p.element.id);
      const mult = p.element.id === effCapId ? capMult : 1;
      const raw = s?.total_points ?? 0;
      const proj = bonus?.byElement.get(p.element.id) ?? 0;
      return {
        p,
        stats: s,
        projBonus: proj,
        counts,
        points: counts ? (raw + proj) * mult : 0,
        display: raw + proj,
      };
    })
    .sort((a, b) => a.p.pickPosition - b.p.pickPosition);

  const total = rows.reduce((sum, r) => sum + r.points, 0) - hits;
  const benchTotal = benchPoints(
    rows.map((r) => ({
      elementId: r.p.element.id,
      pickPosition: r.p.pickPosition,
      display: r.display,
    })),
    effXi
  );
  // Null while FPL has not published one — it is 0 for a gameweek in progress,
  // and this tab is only ever open during one. See `publishedAverage`.
  const gwAvg = publishedAverage(data.bootstrap.events.find((e) => e.id === currentEvent));

  /*
   * HOW OLD THE NUMBERS ARE, which is not the same question as whether the
   * last request succeeded. See `liveStaleMinutes`.
   *
   * IT NEEDS ITS OWN CLOCK, for two reasons that both bite. Reading `Date.now()`
   * during render is impure and `react-hooks/purity` rejects it outright — and
   * the tempting answer, "a failing poll calls `setError` so the tab repaints
   * anyway", is wrong: `setError` is handed the SAME string every time, and
   * React bails out of a re-render when the next state is identical. A feed
   * that stops answering therefore produces no repaints at all, which is
   * precisely the case this has to detect.
   */
  const staleMin = gwDone ? null : liveStaleMinutes(updatedAt, nowMs, LIVE_REFRESH_MS);
  /*
   * THE SECOND KIND OF STALE, and the one that survives both other defences.
   * `staleMin` catches a feed that has stopped ANSWERING. This catches a feed
   * that answers 200 with numbers that have not moved — which is what a reader
   * actually hit: a match that had finished 2-0 rendering `55'` under a current
   * "Updated" stamp. See `feedStallMs`.
   */
  const stallMs = gwDone || nowMs === 0 ? null : feedStallMs(feedWatch, nowMs);
  const stallMin = stallMs === null ? null : Math.floor(stallMs / 60_000);
  const stale = staleMin !== null || stallMin !== null;
  const ageMin = staleMin ?? stallMin ?? 0;

  return (
    <div className="space-y-4">
      {/*
        THE ONE THING ON THIS TAB THAT MUST BE ANNOUNCED.
        The page repaints the total, the bench, the clock and the "Updated"
        stamp every thirty seconds, and "Refresh now" repaints them on demand —
        and none of it reached a screen reader, because the app had no live
        region anywhere. A reader who cannot see the number has no way to know
        it moved, which on this tab is the entire point of the tab.

        `polite`, not `assertive`: a score changing is worth hearing at the next
        pause, not worth interrupting a sentence for. It wraps the header rather
        than the fifteen rows for the same reason — announcing every row on
        every poll is noise, and the header is the summary the reader wants.
      */}
      <div
        className="card flex flex-wrap items-center gap-x-6 gap-y-2 p-4"
        role="status"
        aria-live="polite"
        aria-atomic="false"
      >
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
            {anyLive && (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-accent opacity-60" />
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
          {subbedIn.size > 0 && !gwDone && (
            <div className="text-[11px] text-muted">incl. projected auto-subs</div>
          )}
        </div>
        <div className="text-sm text-muted">
          <div>Bench: {benchTotal} pts{bboost ? " (Bench Boost active)" : ""}</div>
          {gwAvg != null && (
            <div>
              GW average: {gwAvg} pts{" "}
              {total - gwAvg !== 0 && (
                <span className={total > gwAvg ? "text-accent" : "text-danger"}>
                  ({total > gwAvg ? "+" : ""}
                  {total - gwAvg})
                </span>
              )}
            </div>
          )}
          {data.picks?.entry_history.rank != null && (
            <div>GW rank: {data.picks.entry_history.rank.toLocaleString("en-GB")}</div>
          )}
        </div>
        <div className="ml-auto text-right text-xs text-muted">
          {updatedAt && (
            <div className={stale ? "font-semibold text-warn" : undefined}>
              Updated {updatedAt.toLocaleTimeString("en-GB")}
            </div>
          )}
          {/*
            "Auto-refresh every 30s" IS A CLAIM ABOUT THE REQUEST, and while the
            feed was refusing it sat there unchanged next to numbers that had
            not moved for an hour. Once the data is stale the line says what is
            actually known: polling continues, and it is not getting through.
          */}
          <div className={stale ? "font-semibold text-warn" : undefined}>
            {gwDone
              ? "Gameweek complete — auto-refresh off"
              : stale
                ? `Not updating — ${ageMin} min old`
                : "Auto-refresh every 30s"}
          </div>
          <button
            type="button"
            onClick={() => refresh(true)}
            className="mt-1 min-h-11 rounded-md border border-border-c bg-panel-2 px-3 py-1.5 hover:border-accent active:border-accent"
          >
            Refresh now
          </button>
        </div>

        {/*
          Safety score: median live score of ~20 managers at your overall-rank
          band when available; falls back to FPL's own gameweek average.

          THAT FALLBACK IS NOT AVAILABLE DURING PLAY, and it used to look as
          though it were. `average_entry_score` is 0 until FPL publishes it
          (see `publishedAverage`), so a failed rank-band sample mid-gameweek
          produced "Safety score (est.): 0 pts — you're 34 above; on course to
          climb". With the 0 read as "unpublished" the box simply does not
          render then, which is the honest answer: nothing in the official API
          says what the field is scoring right now except the sample this tab
          takes itself. The fallback still has a real state — after the
          gameweek, where the average is published and the box explains the
          final margin.
        */}
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
                {/*
                  LEVEL IS LEVEL. `total >= needed` sent an exact tie down the
                  "climbing" branch, which then read "you're 0 above; on course
                  to climb ▲" — matching the median holds your rank, it does not
                  improve it, and that is the whole meaning of the number.
                */}
                {total === needed
                  ? "level with your rank band — on course to hold your rank"
                  : total > needed
                    ? `you're ${total - needed} above; on course to climb ▲`
                    : `${needed - total} more needed to hold your rank`}
              </div>
            );
          })()}
      </div>

      {/* Match scores — two rows so twice as many fit on screen */}
      {gwFixtures.length > 0 && (
        <div
          className="grid grid-flow-col grid-rows-2 gap-1.5 overflow-x-auto pb-1 auto-cols-max"
          tabIndex={0}
          role="region"
          aria-label="Match scores, scrollable"
        >
          {gwFixtures.map((f) => {
            const minute = matchMinute(f, updatedAt ?? undefined);
            /*
              `isInPlay` IS A FACT ABOUT THE PAYLOAD, not about the screen. A
              fixture kept its green border and its accent-coloured clock while
              the number in it was an hour old, because the flag it reads was
              itself an hour old. Nothing here can be styled as live unless the
              data behind it is current.
            */
            const liveNow = isInPlay(f) && !stale;
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
                type="button"
                onClick={() => setMatchOpen(f)}
                className={`card flex min-h-11 min-w-28 cursor-pointer flex-col items-center px-2 py-1.5 text-xs hover:border-accent active:border-accent sm:min-w-32 sm:text-sm ${liveNow ? "border-accent/50" : ""}`}
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
                {/*
                  THREE STATES, NOT TWO. A card reading "HUL v MUN / Sat 13:30"
                  two minutes after the whistle is indistinguishable from an app
                  that has stopped fetching — and "live doesn't work" is the
                  reasonable conclusion the screen gives no way to check. When
                  the kick-off has passed and FPL still has not flagged it, the
                  card says so. See `kickOffPassed`.
                */}
                <div className={`text-xs ${liveNow ? "font-semibold text-accent" : "text-muted"}`}>
                  {f.started
                    ? stale
                      ? `${minute} · ${ageMin}m old`
                      : minute
                    : kickOffPassed(f, (updatedAt ?? new Date()).getTime())
                      ? "waiting on FPL"
                      : kickoffLabel(f, (iso) =>
                          new Date(iso).toLocaleString("en-GB", {
                            weekday: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          }))}
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
          squadIds={new Set(data.squad.currentPlayers.map((p) => p.element.id))}
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
        {rows.map(({ p, stats, points, display, projBonus, counts }) => {
          const Row = onSelect ? "button" : "div";
          return (
            <Row
              key={p.element.id}
              type={onSelect ? "button" : undefined}
              className={`flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm ${onSelect ? "cursor-pointer hover:bg-panel-2/60 active:bg-panel-2" : ""}`}
              onClick={onSelect ? () => onSelect(p.element) : undefined}
            >
              <span className="w-6 text-xs text-muted">{p.pickPosition}</span>
              <span className="min-w-0 flex-1 font-medium">
                {p.element.web_name}
                {p.isCaptain && <Badge tone="green"> C </Badge>}
                {p.isViceCaptain && <Badge> V </Badge>}
                {p.pickPosition > 11 && !counts && (
                  <span className="ml-1 text-xs text-muted">(bench)</span>
                )}
                {subbedIn.has(p.element.id) && (
                  <span
                    className="ml-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-semibold text-accent"
                    title="Projected auto-sub: comes on for a starter who didn't play"
                  >
                    ↑ auto-sub
                  </span>
                )}
                {subbedOut.has(p.element.id) && (
                  <span
                    className="ml-1.5 rounded bg-danger/15 px-1.5 py-0.5 text-[11px] font-semibold text-danger"
                    title="Projected auto-sub: didn't play — bench comes on"
                  >
                    ↓ 0 min
                  </span>
                )}
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
              <span className="w-10 shrink-0 text-right font-mono font-bold">
                {counts ? points : display}
              </span>
            </Row>
          );
        })}
      </div>
      <p className="text-xs text-muted">
        {/*
            EXPLAIN THE MARKER ONLY WHEN THERE IS ONE. Since 2026/27 FPL
            publishes its own projected bonus past the 20-minute mark, and
            `provisionalBonus` correctly adds nothing on top of that — so for
            most of a live gameweek there is no ★ anywhere, and a legend for it
            reads as a feature that is missing rather than one not currently
            needed. Confirmed on the real GW1 payload: FPL had already awarded
            3/2/1 and the projection was empty.
        */}
        {/* Over the rows actually drawn, not over the gameweek: the badge
            renders only for the reader's own squad, so a ★ somewhere else in
            the league still left the legend explaining a marker not on screen. */}
        {myStarBonus > 0 &&
          "★ = projected bonus from live BPS (not confirmed until the match finishes). "}
        Auto-subs are projected once a starter&apos;s matches finish with 0 minutes. Captain
        doubling
        {data.squad.activeChip === "3xc" ? " (3x — Triple Captain active)" : ""} included in the
        total.
      </p>
    </div>
  );
}
