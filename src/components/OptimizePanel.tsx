"use client";

import { useEffect, useMemo, useState } from "react";
import { currentFeed, fetchRecentForm, type TeamData } from "@/lib/fpl";
import { setRecentForm as publishRecentForm } from "@/lib/recentFormStore";
import type { RecentForm } from "@/lib/types";
import { cachedPastSeason, loadPastSeason } from "@/lib/pastSeasonStore";
import { launchPool } from "@/lib/pool";
import {
  optimize,
  buildLaunchVariants,
  rankLaunchVariants,
  HORIZON_DECIMALS,
  planHorizon,
  chipScenario,
  type LaunchVariant,
  type OptimizerResult,
  type SeasonPlan,
  type ChipScenario,
} from "@/lib/optimizer";
import { projectAll } from "@/lib/xp";
import { fmtPrice, remainingChips, CHIP_LABELS } from "@/lib/rules";
import { priceTimingHint } from "@/lib/priceChange";
import { TEMPLATE_LABEL } from "@/lib/field";
import { Badge, SectionTitle } from "./ui";
import Pitch from "./Pitch";
import Sheet, { SheetClose } from "./Sheet";

/** Compact deadline countdown so the decision-critical time lives where the
 * decisions are made. */
function DeadlineNote({ gw, deadline }: { gw: number; deadline: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - now;
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const txt = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  const urgent = ms < 24 * 3_600_000;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${
        urgent ? "border-warn/50 bg-warn/10 text-warn" : "border-accent/40 bg-accent/10 text-accent"
      }`}
    >
      ⏰ GW{gw} deadline: {txt}
    </span>
  );
}

export default function OptimizePanel({
  data,
  onSelect,
}: {
  data: TeamData;
  onSelect?: (el: import("@/lib/types").Element) => void;
}) {
  const [horizon, setHorizon] = useState(5);
  const [result, setResult] = useState<OptimizerResult | null>(null);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<"plans" | "xi" | "dream">("plans");
  const [infoOpen, setInfoOpen] = useState<{ title: string; body: string[] } | null>(null);
  const [launch, setLaunch] = useState<LaunchVariant[] | null>(null);
  const [launchPick, setLaunchPick] = useState(0);
  const [launchRunning, setLaunchRunning] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [recentForm, setRecentForm] = useState<Map<number, RecentForm> | null>(null);
  const [plan, setPlan] = useState<SeasonPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [chipView, setChipView] = useState<ChipScenario | null>(null);
  const [chipLoading, setChipLoading] = useState<string | null>(null);
  // Non-null when the last-season lookup came back incomplete: how many of
  // the drafted pool fell back to a price guess.
  const [gap, setGap] = useState<{ failed: number; requested: number } | null>(null);
  /*
   * `run`, `runPlan` and `showChip` were `try/finally` with no `catch`. A throw
   * inside `optimize`, `planHorizon` or `chipScenario` cleared the spinner and
   * produced NOTHING: no result, no message, no retry — and being un-awaited
   * from an `onClick`, an unhandled rejection rather than the error boundary.
   * The reader taps Optimize, watches "Crunching…" disappear, and is left with
   * an empty panel and no idea whether it worked.
   */
  const [failure, setFailure] = useState<string | null>(null);

  const squad = data.squad;
  const teams = useMemo(
    () => new Map(data.bootstrap.teams.map((t) => [t.id, t])),
    [data.bootstrap]
  );

  const upcomingEvent = data.bootstrap.events.find((e) => e.is_next)?.id ?? null;

  // Season-launch mode: no squad yet (pre-GW1) but the new season's data is live.
  if ((!squad || squad.nextEvent == null) && upcomingEvent != null) {
    const runLaunch = async () => {
      setLaunchRunning(true);
      setPhase("Checking last season's minutes & returns…");
      setGap(null);
      try {
        const pool = launchPool(data.bootstrap.elements);
        const past = await loadPastSeason(pool, (done, total) =>
          setPhase(`Checking last season… ${done}/${total}`)
        );
        /*
         * READ THE STORE, NOT THE TRANSPORT — the same mistake the note two
         * hundred lines below says was fixed for the other call site.
         *
         * `loadPastSeason` resolves with the answer THIS load fetched, even
         * when the store rejected it as thinner than what it already holds
         * (`pastSeasonStore`'s `keep` rule). On a flaky connection — 300
         * players held, a re-draft returning 250 — the drafter built from the
         * 250 and reported the higher failure count, while the pitch beside it
         * projected from the 300. That split is what this whole path exists to
         * close. The same call also surfaces an aborted load's partial map,
         * since `fetchPastSeason` resolves rather than rejects on abort.
         */
        const held = cachedPastSeason();
        const records = held && held.size > past.data.size ? held : past.data;
        // A player we failed to look up falls back to his price, which is the
        // guess the lookup exists to replace. Say so rather than presenting a
        // thinner draft as if it were the full one — but only count the ones
        // still missing from the records actually being drafted from.
        const missing = Math.max(0, past.requested - records.size);
        if (missing > 0) setGap({ failed: missing, requested: past.requested });
        setPhase("Drafting your options…");
        await new Promise((r) => setTimeout(r, 20));
        const { variants } = buildLaunchVariants(
          data.bootstrap,
          data.fixtures,
          upcomingEvent,
          5,
          records.size > 0 ? records : undefined
        );
        setLaunch(variants);
        // Pre-select the draft that scores most over the horizon. Index 0 is
        // construction order, which is not a recommendation and used to look
        // like one. `rankLaunchVariants` owns the tie rule so the pre-selection
        // and the badge below cannot disagree.
        setLaunchPick(rankLaunchVariants(variants).bestIndex);
      } catch {
        setGap({ failed: -1, requested: 0 });
      } finally {
        setLaunchRunning(false);
        setPhase(null);
      }
    };
    /*
     * RANK BY THE HORIZON, NOT BY THE OPENING WEEK.
     *
     * The drafts are returned in construction order and stay that way — the
     * library test that lists them by name is a completeness check and should
     * not be turned into a presentation one. The ranking the READER needs is
     * applied here instead: `horizonXp` is what a launch squad is kept for, and
     * it ranks these close to the reverse of `xi.totalXp`.
     *
     * The rule itself lives in `rankLaunchVariants`, not here, because the
     * pre-selection above needs the same answer — and because a tie has to be
     * shown as a tie rather than resolved into a winner. Read its note.
     */
    const launchLeaders = launch ? rankLaunchVariants(launch).leaders : new Set<string>();
    const chosen = launch?.[launchPick] ?? null;
    return (
      <div className="space-y-4">
        <div className="card p-5">
          <div className="text-lg font-bold">🚀 Season launch: build your £100m squad</div>
          <p className="mt-1 text-sm text-muted">
            No squad registered yet — perfect timing. Pre-season there isn&apos;t one single
            &quot;best&quot; team (nobody&apos;s kicked a ball yet), so the drafter gives you a
            few viable structures within the £100.0m budget — built from prices, FPL&apos;s own
            projections, team strength and the GW{upcomingEvent}–{upcomingEvent + 4} fixtures.
            Pick the approach you like.
          </p>
          <button onClick={runLaunch} disabled={launchRunning} className="btn-primary mt-3 rounded-lg px-5 py-2.5">
            {launchRunning ? "Drafting…" : launch ? "Re-draft" : "Build my launch squads"}
          </button>
          {launchRunning && phase && <div className="mt-2 text-xs text-muted">{phase}</div>}
          {!launchRunning && gap && (
            <div className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {gap.failed < 0
                ? "Couldn't reach FPL for last season's minutes — this draft is based on prices and FPL's own projections only. Try again in a moment."
                : `Last season's record was unavailable for ${gap.failed} of ${gap.requested} players, so those were estimated from price. Re-draft to try them again.`}
            </div>
          )}
        </div>

        {launch && chosen && (
          <>
            {/* Strategy selector — several viable drafts, not one answer */}
            <div>
              <p className="mb-2 text-xs font-medium text-muted">
                Choose an approach — tap to switch squad:
              </p>
              {/* Two columns from `sm` up, not three: with four drafts a
                  three-wide grid leaves one card stranded on its own row. */}
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {launch.map((v, i) => {
                  const selected = i === launchPick;
                  return (
                    <button
                      key={v.key}
                      type="button"
                      onClick={() => setLaunchPick(i)}
                      aria-pressed={selected}
                      className={`card p-3 text-left transition ${
                        selected
                          ? "border-accent bg-accent/10 ring-2 ring-accent"
                          : "opacity-80 hover:border-accent hover:opacity-100"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-sm font-semibold">
                          {selected && <span className="text-accent">✓</span>}
                          {launchLeaders.has(v.key) && (
                            <span
                              className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-white"
                              title={
                                launchLeaders.size > 1
                                  ? `Level on projected points over ${v.horizonGws} gameweeks with ${launchLeaders.size - 1} other draft${launchLeaders.size > 2 ? "s" : ""} — take either`
                                  : `Highest projected points over ${v.horizonGws} gameweeks`
                              }
                            >
                              BEST
                            </span>
                          )}
                          {v.label}
                        </span>
                        {/*
                          THE HORIZON NUMBER IS THE HEADLINE, NOT NEXT-GW.
                          `xi.totalXp` is one gameweek and it ranks these drafts
                          close to backwards — the draft that tops GW1 scores
                          least over five. See `LaunchVariant.horizonXp` for the
                          measurement. Next-GW is kept underneath because it is
                          a real answer to a different question.

                          PRINTED AT `HORIZON_DECIMALS`, WHICH IS NOT COSMETIC.
                          `rankLaunchVariants` calls two drafts level when they
                          round equal at that precision, so printing fewer
                          decimals here would show two identical figures with
                          only one badged. It did: at `toFixed(0)` the top two
                          both read "223" and one wore BEST.
                        */}
                        <span className="whitespace-nowrap text-right">
                          <span className="font-mono text-xs text-accent">
                            {v.horizonXp.toFixed(HORIZON_DECIMALS)} xp
                          </span>
                          <span className="ml-1 text-[10px] text-muted">
                            /{v.horizonGws}gw
                          </span>
                        </span>
                      </div>
                      <div className="mt-0.5 text-right font-mono text-[10px] text-muted">
                        GW{squad?.nextEvent ?? upcomingEvent}: {v.xi.totalXp.toFixed(1)}
                      </div>
                      <div className="mt-1 text-[11px] leading-tight text-muted">{v.description}</div>
                      {selected ? (
                        <div className="mt-2 inline-block rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-white">
                          Selected
                        </div>
                      ) : (
                        <div className="mt-2 inline-block rounded-full border border-current px-2 py-0.5 text-[10px] font-medium text-muted">
                          Tap to select
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="card flex flex-wrap items-center gap-4 p-4 text-sm">
              <div>
                <span className="text-muted">Squad cost:</span>{" "}
                <b>£{fmtPrice(chosen.cost)}m</b>
              </div>
              <div>
                <span className="text-muted">In the bank:</span>{" "}
                <b>£{fmtPrice(1000 - chosen.cost)}m</b>
              </div>
              <div>
                <span className="text-muted">Projected (GW{upcomingEvent}, incl. captain):</span>{" "}
                <button
                  type="button"
                  className="font-mono font-bold text-accent underline decoration-dotted underline-offset-2"
                  onClick={() =>
                    setInfoOpen({
                      title: `${chosen.xi.totalXp.toFixed(1)} expected points`,
                      body: [
                        "xP = expected points: the average return this team is likely to score, weighing each player's chance of playing, fixtures, form and underlying numbers — with the captain doubled.",
                        "It's an average, not a target. Real gameweeks swing well above it (a captain haul, clean sheets) and below it (blanks). Over many weeks the total tracks xP.",
                        "It's on a real-points scale: across four backtested seasons the teams the model picked actually scored within a few points of their projection each week — so treat this as roughly what a normal week returns, not a ceiling.",
                      ],
                    })
                  }
                >
                  {chosen.xi.totalXp.toFixed(1)} pts
                </button>
              </div>
            </div>
            <Pitch
              starters={chosen.xi.starters.map((s) => ({
                element: s.element,
                xp: s.xp,
                isCaptain: s.isCaptain,
                isVice: s.isVice,
              }))}
              bench={chosen.xi.bench.map((s) => ({ element: s.element, xp: s.xp }))}
              teams={teams}
              fixtures={data.fixtures}
              nextEvent={upcomingEvent}
              formation={chosen.xi.formation}
              onSelect={onSelect}
            />
            <div className="card p-4">
              <div className="text-sm font-semibold">Type this into fantasy.premierleague.com:</div>
              <div className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
                {chosen.squad
                  .slice()
                  .sort((a, b) => a.element_type - b.element_type || b.now_cost - a.now_cost)
                  .map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={onSelect ? () => onSelect(e) : undefined}
                      className="flex items-center justify-between rounded-lg border border-transparent bg-panel-2 px-3 py-2 text-left hover:border-accent active:border-accent"
                    >
                      <span className="truncate">
                        <span className="mr-1.5 text-xs text-muted">
                          {["GK", "DEF", "MID", "FWD"][e.element_type - 1]}
                        </span>
                        {e.web_name}{" "}
                        <span className="text-xs text-muted">
                          {teams.get(e.team)?.short_name}
                        </span>
                      </span>
                      <span className="ml-2 shrink-0 font-mono">£{fmtPrice(e.now_cost)}m</span>
                    </button>
                  ))}
              </div>
            </div>
            <p className="text-xs text-muted">
              These are starting points, not a verdict — pre-season is the model&apos;s most
              uncertain moment. Trust your own read on captaincy and a premium or two.
            </p>
          </>
        )}
      </div>
    );
  }

  if (!squad || squad.nextEvent == null) {
    return (
      <div className="card p-6 text-muted">
        Optimization needs an active squad and an upcoming gameweek. The season may be over,
        or this team hasn&apos;t played a gameweek yet.
      </div>
    );
  }

  const chipsLeft = remainingChips(
    data.history.chips.map((c) => ({ name: c.name, event: c.event })),
    data.bootstrap.chips ?? null,
    squad.nextEvent
  );

  // Recent line-up data (element-summary) for owned players + the optimizer's
  // realistic candidate pool. Fetched once and reused by both engines.
  /*
   * WAIT FOR LAST SEASON'S RECORD RATHER THAN HOPING IT HAS ARRIVED.
   *
   * Reading the cache and carrying on is not "with it if it has landed" — it is
   * a coin flip on the clock. The only unconditional load lives in the
   * pre-GW1 launch branch above, so for a manager who already has a squad the
   * store is filled solely by the dashboard's effect, which first reconciles
   * finished gameweeks and then fetches four hundred players ten at a time. A
   * manager who taps Optimize inside that window gets a different candidate
   * pool and different recommended transfers from one who waits, with nothing
   * on screen to say which happened — and it sticks, because `recentForm` is
   * memoised, so one early tap poisons every later run and the six-week plan
   * too. Awaiting is nearly free: the key is the same pool the dashboard is
   * already loading, so this joins that same in-flight promise rather than
   * starting a second one. It is not free in TIME, though — joining a load
   * already in flight cannot re-wire the progress callback, so the caller's
   * own label is set first and simply stays put for the wait.
   */
  async function ensurePastSeason(): Promise<Map<number, import("@/lib/types").PastSeasonStats> | undefined> {
    const held = cachedPastSeason();
    if (held) return held;
    // The demo is a mid-season fixture: every one of its three hundred players
    // has minutes this season, so `statLine` prefers the bootstrap and the
    // record would change nothing — it is not worth three hundred round trips
    // per tap. The dashboard makes the same call, for the same reason.
    if (currentFeed() !== "real") return undefined;
    setPhase("Checking last season…");
    try {
      await loadPastSeason(launchPool(data.bootstrap.elements), (done, total) =>
        setPhase(`Checking last season… ${done}/${total}`)
      );
    } catch {
      return undefined;
    }
    /*
     * THE STORE'S RECORD, NOT THIS FETCH'S. `loadPastSeason` resolves with the
     * result it fetched even when the store REJECTS that result as thinner than
     * what it already holds — a partial run under a flaky connection, say,
     * arriving after a complete one. Returning the transport's answer meant the
     * candidate pre-rank a few lines below could be built on the thin map while
     * `run()` a moment later read the fuller one out of the cache: two
     * different versions of last season inside a single Optimize, which is a
     * small copy of exactly the split this whole path exists to close.
     */
    return cachedPastSeason() ?? undefined;
  }

  async function loadRecentForm(): Promise<Map<number, RecentForm>> {
    if (recentForm) return recentForm;
    // With last season's record. This projection only decides WHICH players are
    // worth an element-summary lookup, but that is a decision it was making
    // badly for precisely the players the lookup would help most: a summer
    // signing or a returning long-term absentee is on no minutes this season,
    // so without `pastSeason` he projects near zero, finishes outside the top
    // fifteen of his position and never gets his line-ups fetched — after which
    // the optimizer has no recent-form evidence for him either.
    const prelim = projectAll({
      bootstrap: data.bootstrap,
      fixtures: data.fixtures,
      nextEvent: squad!.nextEvent!,
      pastSeason: await ensurePastSeason(),
    });
    const ids = new Set<number>(squad!.players.map((p) => p.element.id));
    for (const t of [1, 2, 3, 4]) {
      data.bootstrap.elements
        .filter((e) => e.element_type === t && e.status !== "u")
        .sort(
          (a, b) =>
            (prelim.get(b.id)?.totalDiscounted ?? 0) - (prelim.get(a.id)?.totalDiscounted ?? 0)
        )
        .slice(0, 15)
        .forEach((e) => ids.add(e.id));
    }
    // Captured BEFORE the fetch, not after it. This is hundreds of round trips
    // with no abort signal, and the reader can navigate to the demo while it
    // runs; `setRecentForm` drops a map whose feed is no longer current rather
    // than filing real footballers under demo ids.
    const feed = currentFeed();
    const map = await fetchRecentForm([...ids], 5, 8, (done, total) =>
      setPhase(`Checking recent line-ups… ${done}/${total}`)
    );
    setRecentForm(map);
    // And publish it, so the Dashboard's own projection stops disagreeing with
    // this one about the same player — see `recentFormStore`.
    publishRecentForm(map, feed);
    return map;
  }

  async function run() {
    setFailure(null);
    setRunning(true);
    setPhase("Checking recent line-ups…");
    try {
      const recent = await loadRecentForm();
      setPhase("Simulating thousands of squad combinations…");
      // Let the progress text paint before the (CPU-bound) search starts.
      await new Promise((r) => setTimeout(r, 30));
      const res = optimize({
        bootstrap: data.bootstrap,
        fixtures: data.fixtures,
        owned: squad!.players,
        bank: squad!.bank,
        freeTransfers: squad!.freeTransfers,
        nextEvent: squad!.nextEvent!,
        horizon,
        recentForm: recent,
        // `loadRecentForm` has already awaited this, so the read is settled.
        pastSeason: cachedPastSeason() ?? undefined,
        // Which half's chip window the reader is still reasoning about depends
        // on which copies they have spent — see `chipWindow`.
        usedChips: data.history?.chips ?? [],
      });
      setResult(res);
    } catch {
      setFailure("Couldn't work out your transfers — something in the projection failed. Try again.");
    } finally {
      setRunning(false);
      setPhase(null);
    }
  }

  async function runPlan() {
    setFailure(null);
    setPlanning(true);
    setPhase("Checking recent line-ups…");
    try {
      const recent = await loadRecentForm();
      setPhase("Planning six gameweeks ahead…");
      await new Promise((r) => setTimeout(r, 30));
      setPlan(
        planHorizon({
          bootstrap: data.bootstrap,
          fixtures: data.fixtures,
          owned: squad!.players,
          bank: squad!.bank,
          freeTransfers: squad!.freeTransfers,
          nextEvent: squad!.nextEvent!,
          horizon: 6,
          recentForm: recent,
          pastSeason: cachedPastSeason() ?? undefined,
        })
      );
    } catch {
      setFailure("Couldn't build a season plan — something in the projection failed. Try again.");
    } finally {
      setPlanning(false);
      setPhase(null);
    }
  }

  // "What if I play this chip?" — computed on demand when a chip badge is tapped.
  async function showChip(chip: string) {
    setFailure(null);
    setChipLoading(chip);
    try {
      /*
       * THIS TAP CAN BE THE FIRST THING THE READER DOES. The chip badges render
       * in the panel body, above the Optimize button, enabled from first paint
       * — so "Wildcard" is reachable before `run()` or `runPlan()` has ever been
       * called, and those two are the only callers of `loadRecentForm`, which is
       * the only thing that awaits the past-season load. Reading the cache here
       * and carrying on meant a wildcard squad built with no record of last
       * season at all: no summer signing, no returning absentee, while the
       * Optimize tab three inches away includes them the moment it is tapped.
       * The panel's own note above `ensurePastSeason` says exactly why that is
       * not acceptable; this call site was simply not obeying it.
       */
      const past = await ensurePastSeason();
      /*
       * AND RECENT FORM, FOR EXACTLY THE SAME REASON — which the note above
       * fixed for last season's record and then left half-done.
       *
       * `loadRecentForm` is awaited by `run()` and `runPlan()` and by nothing
       * else, so a chip tapped before Optimize scored with `recentForm`
       * undefined while the advisor two inches away scored with it. The two
       * disagreed on screen: measured on the demo, the Wildcard sheet said
       * "+2.3 pts over 5 gameweeks" where the advisor said +0.0, and Bench
       * Boost 13.6 against 13.4. The badges are live from first paint, so
       * tapping one first is the ordinary path, not a corner.
       *
       * `loadRecentForm` memoises, so this is free once either button has been
       * pressed, and `ensurePastSeason` above is already inside it.
       */
      const recent = await loadRecentForm();
      await new Promise((r) => setTimeout(r, 20));
      const scen = chipScenario(
        {
          bootstrap: data.bootstrap,
          fixtures: data.fixtures,
          owned: squad!.players,
          bank: squad!.bank,
          freeTransfers: squad!.freeTransfers,
          nextEvent: squad!.nextEvent!,
          horizon,
          precomputedXp: result?.xp,
          recentForm: recent,
          pastSeason: past,
          usedChips: data.history?.chips ?? [],
        },
        chip
      );
      setChipView(scen);
    } catch {
      setFailure("Couldn't score that chip — something in the projection failed. Try again.");
    } finally {
      setChipLoading(null);
      // Whoever sets `phase` clears it. This did not, so a chip preview left
      // "Checking last season… 400/400" standing in the panel's state, and the
      // next tap on Optimize opened its spinner on the previous job's caption.
      setPhase(null);
    }
  }

  return (
    <div className="space-y-6">
      {chipView && (
        <Sheet onClose={() => setChipView(null)} labelledBy="chip-title" maxWidth="max-w-md">
          <ChipSheet
            scenario={chipView}
            teams={teams}
            fixtures={data.fixtures}
            onSelect={onSelect}
            onClose={() => setChipView(null)}
          />
        </Sheet>
      )}
      {infoOpen && (
        <Sheet onClose={() => setInfoOpen(null)} labelledBy="opt-info-title" maxWidth="max-w-md">
          <div>
            <div className="flex items-center justify-between">
              <h2 id="opt-info-title" className="text-lg font-bold">{infoOpen.title}</h2>
              <SheetClose onClose={() => setInfoOpen(null)} />
            </div>
            <div className="mt-3 space-y-2 text-sm text-muted">
              {infoOpen.body.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>
        </Sheet>
      )}
      <div className="card flex flex-wrap items-center gap-4 p-4">
        <div className="w-full">
          <DeadlineNote
            gw={squad.nextEvent}
            deadline={
              data.bootstrap.events.find((e) => e.id === squad.nextEvent)?.deadline_time ?? null
            }
          />
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="opt-horizon" className="text-sm text-muted">
            Horizon:
          </label>
          <select
            id="opt-horizon"
            aria-label="How many gameweeks to plan over"
            value={horizon}
            onChange={(e) => {
              /*
               * A NEW HORIZON MEANS THE OLD RESULT IS NOT AN ANSWER TO IT.
               * Changing this only relabelled the panel: the heading read
               * "Transfer plans (next 1 GWs)" over unchanged five-gameweek
               * numbers, and the chip advisor still named a gameweek outside
               * the window it now claimed. Clearing is the honest state — the
               * reader presses Optimize again, which is one tap and cannot
               * mislead.
               *
               * `plan` IS NOT ONE OF THEM, and clearing it was a bug of the
               * same family read backwards. The Multi-GW planner does not take
               * this horizon — `runPlan` passes a fixed 6, its button says
               * "Plan next 6 GWs" and its copy says "the next six deadlines".
               * So the plan on screen is still an exact answer to the question
               * it was asked, and throwing it away costs the reader the panel's
               * single most expensive computation to fix a mislabelling that
               * was never there.
               *
               * `failure` goes, though. It is the reason the results now being
               * cleared are missing, so leaving it behind states a failure
               * about nothing the screen still shows.
               */
              setHorizon(parseInt(e.target.value));
              setResult(null);
              setChipView(null);
              setFailure(null);
            }}
            className="min-h-11 rounded-lg bg-panel-2 border border-border-c px-3 py-2 text-sm"
          >
            {[1, 2, 3, 5, 8].map((h) => (
              <option key={h} value={h}>
                {h} gameweek{h > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <button
            type="button"
            className="-m-1.5 flex min-h-11 items-center p-1.5"
            onClick={() =>
              setInfoOpen({
                title: `${squad.freeTransfers} free transfer${squad.freeTransfers === 1 ? "" : "s"}`,
                body: [
                  `You currently have ${squad.freeTransfers} free transfer${squad.freeTransfers === 1 ? "" : "s"} for GW${squad.nextEvent}.`,
                  "You gain +1 free transfer every gameweek and can bank up to 5. Each transfer beyond your free ones costs −4 points.",
                  "The optimizer already accounts for this: plans marked with a hit only appear when the projected gain outweighs the −4.",
                ],
              })
            }
          >
            <Badge tone="green">
              {squad.freeTransfers} free transfer{squad.freeTransfers === 1 ? "" : "s"}
            </Badge>
          </button>
          <button
            type="button"
            className="-m-1.5 flex min-h-11 items-center p-1.5"
            onClick={() =>
              setInfoOpen({
                title: `Bank £${fmtPrice(squad.bank)}m`,
                body: [
                  `Money left over after your squad — available to spend on transfers in addition to what you raise from sales.`,
                  "Selling prices follow the official rule: you keep your purchase price plus 50% of any price rise, rounded down to £0.1m. Price falls are absorbed in full.",
                ],
              })
            }
          >
            <Badge>Bank £{fmtPrice(squad.bank)}m</Badge>
          </button>
          {chipsLeft.map((c, i) => (
            <button
              key={i}
              type="button"
              className="-m-1.5 flex min-h-11 items-center p-1.5"
              disabled={chipLoading != null}
              onClick={() => showChip(c.name)}
            >
              <Badge tone="purple">
                {chipLoading === c.name ? "…" : c.label} {chipLoading === c.name ? "" : "▸"}
              </Badge>
            </button>
          ))}
          <span className="text-xs text-muted">← tap a chip to preview it</span>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="btn-primary ml-auto rounded-lg px-5 py-2.5"
        >
          {running ? "Crunching…" : result ? "Re-run" : "Optimize team 🚀"}
        </button>
      </div>

      {/*
       * `alert`, NOT `status`. Both are live regions, but `status` is polite:
       * a screen reader queues it behind whatever it is already saying, and
       * every one of these appears while the panel is mid-announcement about
       * the work that just failed. `alert` is assertive and interrupts, which
       * is the right register for "the thing you asked for did not happen" —
       * the reader is otherwise left waiting on a spinner that has gone.
       */}
      {failure && (
        <div
          role="alert"
          className="card border-danger/50 bg-danger/10 p-4 text-sm text-danger"
        >
          {failure}
        </div>
      )}

      {!result && !running && !failure && (
        <div className="card p-6 text-sm text-muted">
          Hit “Optimize team” to compute the highest-projected XI, transfer plans, captaincy and chip
          advice for GW{squad.nextEvent}, based on your squad from GW{squad.currentEvent}.
          Projections weigh who actually started your rivals&apos; last five matches, not just
          season averages.
        </div>
      )}

      {/*
       * `chipLoading` belongs in this condition. A chip preview can be the first
       * thing the reader taps, and since it started awaiting the past-season
       * load it is the SLOWEST thing in the panel — four hundred requests behind
       * a badge that says "…" and nothing else. The progress text was already
       * being written by `ensurePastSeason`; there was simply nowhere on screen
       * that would show it.
       */}
      {(running || planning || chipLoading) && (
        <div className="card flex items-center gap-3 p-6 text-sm text-muted">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {phase ?? "Working…"}
        </div>
      )}

      {/* Multi-GW planner: when to move, not just what to move */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionTitle>🗓️ Multi-GW plan</SectionTitle>
          <button
            type="button"
            onClick={runPlan}
            disabled={planning || running}
            className="min-h-11 rounded-lg border border-accent/50 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent hover:bg-accent/20 active:bg-accent/20 disabled:opacity-50"
          >
            {planning ? "Planning…" : plan ? "Re-plan 6 GWs" : "Plan next 6 GWs"}
          </button>
        </div>
        {!plan && !planning && (
          <p className="mt-2 text-sm text-muted">
            Sequences your transfers across the next six deadlines — when to bank a free
            transfer, when to double up, and when a −4 actually pays for itself.
          </p>
        )}
        {plan && (
          <div className="mt-3 space-y-3">
            <div className="card flex flex-wrap items-center gap-x-6 gap-y-1 p-4 text-sm">
              <div>
                <span className="text-muted">Plan value:</span>{" "}
                <b className="text-accent">
                  {plan.gainVsKeep >= 0 ? "+" : ""}
                  {plan.gainVsKeep.toFixed(1)} xp
                </b>{" "}
                <span className="text-muted">vs never transferring</span>
              </div>
              {plan.totalHits > 0 ? (
                <div className="text-danger">−{plan.totalHits} pts in hits (already priced in)</div>
              ) : (
                <div className="text-muted">No hits needed</div>
              )}
            </div>
            {plan.steps.map((st) => (
              <div key={st.gw} className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold">
                    GW{st.gw}
                    {st.note && (
                      <span className="ml-2 rounded bg-accent-2/15 px-1.5 py-0.5 text-[11px] font-semibold text-accent-2">
                        {st.note}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted">
                    {st.ftBefore} FT{st.ftBefore === 1 ? "" : "s"} available · bank £
                    {fmtPrice(st.bankAfter)}m after
                    {st.hit > 0 && <span className="text-danger"> · −{st.hit} hit</span>}
                  </div>
                </div>
                {st.transfers.length === 0 ? (
                  <div className="mt-2 text-sm text-muted">
                    💤 No transfer — bank the free transfer
                    {st.ftBefore < 5 ? ` (${Math.min(5, st.ftBefore + 1)} saved for later)` : " (already at the 5-FT cap)"}
                    .
                  </div>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    {st.transfers.map((m, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-x-2 rounded-lg bg-panel-2 px-3 py-1.5 text-sm">
                        <button
                          type="button"
                          onClick={onSelect ? () => onSelect(m.out) : undefined}
                          className="text-danger hover:underline"
                        >
                          {m.out.web_name} £{fmtPrice(m.outSell)}m
                        </button>
                        <span className="text-muted">→</span>
                        <button
                          type="button"
                          onClick={onSelect ? () => onSelect(m.in) : undefined}
                          className="text-accent hover:underline"
                        >
                          {m.in.web_name} ({teams.get(m.in.team)?.short_name}) £{fmtPrice(m.inCost)}m
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-xs text-muted">
                  XI projects <b className="text-foreground">{st.xi.totalXp.toFixed(1)} pts</b>
                  {st.xi.captain && <> · captain {st.xi.captain.element.web_name}</>}
                </div>
              </div>
            ))}
            <p className="text-xs text-muted">
              The plan re-optimizes every time prices, injuries or fixtures change — treat later
              gameweeks as direction, not gospel, and re-plan each week.
            </p>
          </div>
        )}
      </div>

      {result && (
        <>
          {/* Transfer plans */}
          <div>
            <SectionTitle>🔄 Transfer plans (next {horizon} GWs)</SectionTitle>
            <div className="mt-3 grid gap-3">
              <PlanRow
                title="Keep the team"
                sub={`0 transfers · best XI projects ${result.keepXi.totalXp.toFixed(1)} xp in GW${squad.nextEvent}`}
                net={result.keepHorizonXp}
                gain={0}
                best={!result.plans.some((p) => p.gainVsKeep > 0.05)}
              />
              {result.plans.map((plan) => (
                <div
                  key={plan.transfers.length}
                  className={`card p-4 ${
                    plan.gainVsKeep > 0.05 &&
                    plan.netXp === Math.max(...result.plans.map((p) => p.netXp))
                      ? "border-accent/60"
                      : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold">
                      {plan.transfers.length} transfer{plan.transfers.length > 1 ? "s" : ""}
                      {plan.hitCost > 0 && (
                        <span className="text-danger"> (−{plan.hitCost} hit)</span>
                      )}
                      {plan.gainVsKeep > 0.05 &&
                        plan.netXp === Math.max(...result.plans.map((p) => p.netXp)) && (
                          <span className="ml-2">
                            <Badge tone="green">Recommended</Badge>
                          </span>
                        )}
                    </div>
                    <div className="text-sm">
                      <span
                        className={plan.gainVsKeep > 0.05 ? "text-accent font-semibold" : "text-muted"}
                      >
                        {plan.gainVsKeep >= 0 ? "+" : ""}
                        {plan.gainVsKeep.toFixed(1)} xp vs keeping
                      </span>
                      <span className="text-muted"> · bank after: £{fmtPrice(plan.bankAfter)}m</span>
                    </div>
                  </div>
                  <div className="mt-3 space-y-2">
                    {plan.transfers.map((m, i) => (
                      <div key={i} className="space-y-1 rounded-lg bg-panel-2 px-3 py-2 text-sm">
                        <div className="flex items-baseline justify-between gap-2">
                          <button
                            onClick={onSelect ? () => onSelect(m.out) : undefined}
                            className="min-w-0 truncate text-left text-danger hover:underline"
                          >
                            Out: {m.out.web_name} ({teams.get(m.out.team)?.short_name}) £
                            {fmtPrice(m.outSell)}m
                          </button>
                          <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted">
                            {(result.xp.get(m.out.id)?.total ?? 0).toFixed(1)} xp
                          </span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <button
                            onClick={onSelect ? () => onSelect(m.in) : undefined}
                            className="min-w-0 truncate text-left text-accent hover:underline"
                          >
                            In: {m.in.web_name} ({teams.get(m.in.team)?.short_name}) £
                            {fmtPrice(m.inCost)}m
                          </button>
                          <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted">
                            {(result.xp.get(m.in.id)?.total ?? 0).toFixed(1)} xp
                          </span>
                        </div>
                        {/* Timing, not selection: the move is already decided
                            above — this only says whether tonight or tomorrow
                            is the cheaper moment to make it. */}
                        {[
                          priceTimingHint(m.out, "out"),
                          priceTimingHint(m.in, "in"),
                        ].map((hint, h) =>
                          hint ? (
                            <div key={h} className="text-xs text-warn">
                              💰 {h === 0 ? m.out.web_name : m.in.web_name}: {hint}
                            </div>
                          ) : null
                        )}
                      </div>
                    ))}
                  </div>
                  {plan.gainVsKeep <= 0.05 && plan.hitCost > 0 && (
                    <div className="mt-2 text-xs text-warn">
                      ⚠️ The hit doesn&apos;t pay off — better to keep your team.
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Captain */}
          <div>
            <SectionTitle>©️ Captaincy (GW{squad.nextEvent})</SectionTitle>
            <div className="mt-3 card divide-y divide-border-c">
              {result.captainRanking.map((c, i) => {
                const read = result.captainReads.get(c.element.id);
                return (
                <button
                  key={c.element.id}
                  type="button"
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left ${onSelect ? "cursor-pointer hover:bg-panel-2/60 active:bg-panel-2" : ""}`}
                  onClick={onSelect ? () => onSelect(c.element) : undefined}
                >
                  <span className="w-6 text-center font-bold text-muted">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{c.element.web_name}</div>
                    <div className="text-xs text-muted">
                      {teams.get(c.element.team)?.short_name} · {c.element.selected_by_percent}%
                      owned
                      {read?.klass ? ` · ${TEMPLATE_LABEL[read.klass].toLowerCase()}` : ""}
                      {read?.wasTemplateCaptain ? " · the field's last captain" : ""}
                    </div>
                  </div>
                  <div className="whitespace-nowrap font-mono text-accent">
                    {c.xp.toFixed(1)} xp
                  </div>
                  {i === 0 && <Badge tone="green">Captain</Badge>}
                  {i === 1 && <Badge>Vice</Badge>}
                </button>
                );
              })}
            </div>
            {/*
              Ownership is stated, never used to re-rank. The ordering above is
              on projected points and stays that way: the field's expected score
              does not depend on this choice, so reweighting by ownership would
              answer a different question rather than answer this one better.
              See the header of `field.ts`.
            */}
            <p className="mt-2 text-xs text-muted">
              Ranked on projected points. Ownership is shown because it decides how
              far this pick can move your rank, not how many points it scores:
              against a widely-owned captain you gain and lose alongside most of the
              field.
            </p>
          </div>

          {/* Against the field */}
          <div>
            <SectionTitle>🎯 Against the field</SectionTitle>
            <div className="mt-3 card p-4">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-mono text-2xl text-accent">
                  {result.fieldSplit.differential.toFixed(1)}
                </span>
                {/*
                  NOT "points from players the field does not own". The sum is
                  `xp * (1 - ownership)` per player, so it is a FRACTION OF EACH
                  man's points, not a subset of the men — a 54%-owned striker
                  still contributes 46% of his projection here. The first
                  wording said the former and a reader would have concluded the
                  XI was full of differentials.
                */}
                {/*
                  SAY WHICH 50.2 THIS IS. `splitByField` is fed
                  `keepXi.starters`, which carry each man's OWN xp — so this
                  total is the eleven un-captained, while "best XI projects 56.7
                  xp" one card above includes the captain's second multiple.
                  Two numbers, both labelled "your XI's projected points",
                  6.5 apart, and nothing said the difference was the armband.
                */}
                <span className="text-sm text-muted">
                  of your XI&apos;s {result.fieldSplit.total.toFixed(1)} projected points
                  (before the captain&apos;s second multiple) are not already shared with
                  the rest of the field.
                </span>
              </div>
              <p className="mt-2 text-xs text-muted">
                That is exposure, not edge — those managers hold other players in the
                slots where they do not hold yours. It is the part of your week that
                can move your rank a long way, in either direction.
                {result.fieldSplit.unknown > 0
                  ? ` ${result.fieldSplit.unknown} player${result.fieldSplit.unknown === 1 ? "" : "s"} left out: FPL has not published their ownership.`
                  : ""}
              </p>
            </div>
          </div>

          {/* Chips */}
          <div>
            <SectionTitle>🃏 Chip advisor</SectionTitle>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {result.chipAdvice.map((a) => {
                const available = chipsLeft.some((c) => c.name === a.chip);
                return (
                  <div key={a.chip} className={`card p-4 ${available ? "" : "opacity-50"}`}>
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">{CHIP_LABELS[a.chip] ?? a.label}</div>
                      {available ? (
                        <Badge tone="purple">Available</Badge>
                      ) : (
                        <Badge>Used / outside window</Badge>
                      )}
                    </div>
                    <div className="mt-1 text-2xl font-bold text-accent">
                      +{a.projectedGain.toFixed(1)} <span className="text-sm">xp</span>
                    </div>
                    <div className="mt-1 text-xs text-muted">{a.detail}</div>
                    {/*
                      The timing note comes from the published calendar, not from
                      the projection, and is kept visually separate for that
                      reason: the figure above it is expected points inside the
                      horizon, this is a fixture count that may be months out.
                      See the header of `chips.ts`.
                    */}
                    {a.timing.note && (
                      <div
                        className={`mt-2 border-t border-border-c pt-2 text-xs ${
                          available && a.timing.verdict === "structural-window-ahead"
                            ? "text-warn"
                            : "text-muted"
                        }`}
                      >
                        {/*
                          A CHIP YOU DO NOT HAVE GETS NO HOURGLASS. The card
                          dims and badges itself "Used / outside window", but the
                          timing note rendered at full strength regardless — so a
                          spent chip still urged the reader to wait for a
                          gameweek they cannot play it in, in the one colour on
                          the card that means "act on this".
                        */}
                        {available && a.timing.verdict === "structural-window-ahead" ? "⏳ " : ""}
                        {a.timing.note}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted">
              Only one chip per gameweek. The xp figure is what a chip is worth inside
              the projection; the note under it reads the published fixture list to the
              end of the chip&apos;s window, which is the part that can be months away.
              Bench Boost and Triple Captain usually pay most in doubles, Free Hit in
              blanks.
            </p>
          </div>

          {/* XI views */}
          <div>
            <SectionTitle>📋 Line-up</SectionTitle>
            <div className="mt-2 grid w-full grid-cols-3 gap-1 rounded-lg bg-panel-2 p-1 text-xs sm:flex sm:w-fit sm:text-sm">
              {(
                [
                  ["plans", "Best plan"],
                  ["xi", "No transfers"],
                  ["dream", "Dream £100m"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setView(key)}
                  className={`whitespace-nowrap rounded-md px-2 py-1.5 sm:px-3 ${view === key ? "btn-primary" : "text-muted"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-3">
              {(() => {
                const bestPlan = [...result.plans].sort((a, b) => b.netXp - a.netXp)[0];
                const xi =
                  view === "dream"
                    ? result.dreamTeam
                    : view === "plans" && bestPlan && bestPlan.gainVsKeep > 0.05
                      ? bestPlan.nextXi
                      : result.keepXi;
                return (
                  <Pitch
                    starters={xi.starters.map((s) => ({
                      element: s.element,
                      xp: s.xp,
                      isCaptain: s.isCaptain,
                      isVice: s.isVice,
                    }))}
                    bench={xi.bench.map((s) => ({ element: s.element, xp: s.xp }))}
                    teams={teams}
                    fixtures={data.fixtures}
                    nextEvent={squad.nextEvent}
                    formation={xi.formation}
                    onSelect={onSelect}
                  />
                );
              })()}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function PlanRow({
  title,
  sub,
  net,
  gain,
  best,
}: {
  title: string;
  sub: string;
  net: number;
  gain: number;
  best: boolean;
}) {
  return (
    <div className={`card flex items-center justify-between p-4 ${best ? "border-accent/60" : ""}`}>
      <div>
        <div className="font-semibold">
          {title} {best && <Badge tone="green">Recommended</Badge>}
        </div>
        <div className="text-sm text-muted">{sub}</div>
      </div>
      <div className="text-right">
        <div className="whitespace-nowrap font-mono font-bold">{net.toFixed(1)} xp</div>
        <div className="text-xs text-muted">{gain >= 0 ? "baseline" : ""}</div>
      </div>
    </div>
  );
}

function ChipSheet({
  scenario,
  teams,
  fixtures,
  onSelect,
  onClose,
}: {
  scenario: ChipScenario;
  teams: Map<number, import("@/lib/types").Team>;
  fixtures: import("@/lib/types").Fixture[];
  onSelect?: (el: import("@/lib/types").Element) => void;
  onClose: () => void;
}) {
  const s = scenario;
  const isSquadChip = s.chip === "wildcard" || s.chip === "freehit";
  const blurb: Record<string, string> = {
    wildcard:
      "Unlimited free transfers — a permanent rebuild. Here's the best squad within your current team value, judged over the whole horizon.",
    freehit:
      "Unlimited transfers for one gameweek only; your squad reverts afterwards. Shown for the single gameweek where it gains the most.",
    bboost: "All 15 players score this gameweek. Shown for the gameweek where your bench projects highest.",
    "3xc": "Your captain scores 3× instead of 2×. Shown for the gameweek and player where the extra multiple is worth most.",
  };
  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 id="chip-title" className="text-lg font-bold">
          🃏 {s.label}
        </h2>
        <SheetClose onClose={onClose} />
      </div>
      <p className="mt-1 text-sm text-muted">{blurb[s.chip]}</p>

      {/*
        NO GAMEWEEK IS A REAL ANSWER. `chipScenario` now clips to the chip's own
        window, so a chip that has expired — or whose window opens after the
        horizon ends — comes back with `bestGw: null` rather than naming a
        gameweek it cannot be played in. The card beside this already declined
        to name one in that state; this sheet named GW20 for a chip that dies
        at GW19.
      */}
      {s.bestGw == null ? (
        <div className="mt-3 rounded-lg border border-border-c bg-panel-2 px-3 py-2.5 text-sm text-muted">
          None of the next {s.horizon} gameweeks is inside this chip&apos;s window, so
          there is nothing here to project.
        </div>
      ) : (
      <div className="mt-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2.5 text-sm">
        <div className="font-semibold text-accent">
          Best in GW{s.bestGw}
          {s.note && <span className="font-normal"> — {s.note}</span>}
        </div>
        <div className="mt-0.5 text-muted">
          {/*
            THE SAME CAVEAT THE CARD CARRIES, ON THE MORE PROMINENT RENDER.
            `wcGain` is `max(0, bestSquadWithinValue − keepSquad)` — bounded
            below by zero, and a freshly optimised squad beats a held one over
            ANY window, so it is almost always comfortably positive. The advisor
            card says in so many words that this is the size of a gap and not a
            reason to play the chip; this sheet showed the identical quantity
            with no such sentence, under a bigger heading.
          */}
          {s.chip === "wildcard" && (
            <>Projected to gain <b className="text-foreground">+{s.gain.toFixed(1)} pts</b> over {s.horizon} gameweeks vs keeping your team. That is the size of the gap between your squad and the best one your money can buy — not a reason to play the chip this week.</>
          )}
          {s.chip === "freehit" && (
            <>A one-week squad projects <b className="text-foreground">+{s.gain.toFixed(1)} pts</b> more than your team that gameweek.</>
          )}
          {s.chip === "bboost" && (
            <>Your bench projects <b className="text-foreground">{s.gain.toFixed(1)} pts</b> that gameweek.</>
          )}
          {s.chip === "3xc" && (
            <>{s.captainName} would add <b className="text-foreground">~{s.gain.toFixed(1)} extra pts</b> (the 3rd multiple).</>
          )}
        </div>
      </div>
      )}

      {isSquadChip && s.xi && s.squad && s.bestGw != null && (
        <>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span>
              <span className="text-muted">Cost:</span> <b>£{fmtPrice(s.cost ?? 0)}m</b>
            </span>
            <span>
              <span className="text-muted">Bank:</span> <b>£{fmtPrice(s.bank ?? 0)}m</b>
            </span>
          </div>
          <div className="mt-3">
            <Pitch
              starters={s.xi.starters.map((x) => ({
                element: x.element,
                xp: x.xp,
                isCaptain: x.isCaptain,
                isVice: x.isVice,
              }))}
              bench={s.xi.bench.map((x) => ({ element: x.element, xp: x.xp }))}
              teams={teams}
              fixtures={fixtures}
              nextEvent={s.bestGw}
              formation={s.xi.formation}
              onSelect={onSelect}
            />
          </div>
        </>
      )}

      {s.chip === "bboost" && s.benchSlots && (
        <div className="mt-3">
          <div className="text-sm font-semibold">Bench that would score</div>
          <div className="mt-1.5 divide-y divide-border-c/60">
            {s.benchSlots.map((b) => (
              <button
                key={b.element.id}
                type="button"
                onClick={onSelect ? () => onSelect(b.element) : undefined}
                className="flex w-full items-center justify-between px-1 py-2 text-left text-sm hover:bg-panel-2/60 active:bg-panel-2"
              >
                <span>
                  {b.element.web_name}{" "}
                  <span className="text-xs text-muted">{teams.get(b.element.team)?.short_name}</span>
                </span>
                <span className="font-mono text-accent">{b.xp.toFixed(1)} xp</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {isSquadChip && s.squad && (
        <div className="mt-4">
          <div className="text-sm font-semibold">Type this into fantasy.premierleague.com:</div>
          <div className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
            {s.squad
              .slice()
              .sort((a, b) => a.element_type - b.element_type || b.now_cost - a.now_cost)
              .map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={onSelect ? () => onSelect(e) : undefined}
                  className="flex items-center justify-between rounded-lg border border-transparent bg-panel-2 px-3 py-2 text-left hover:border-accent active:border-accent"
                >
                  <span className="truncate">
                    <span className="mr-1.5 text-xs text-muted">
                      {["GK", "DEF", "MID", "FWD"][e.element_type - 1]}
                    </span>
                    {e.web_name}{" "}
                    <span className="text-xs text-muted">{teams.get(e.team)?.short_name}</span>
                  </span>
                  <span className="ml-2 shrink-0 font-mono">£{fmtPrice(e.now_cost)}m</span>
                </button>
              ))}
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-muted">
        A projection, not a recommendation to burn the chip — compare the gain against saving it
        for a bigger double or blank gameweek later.
      </p>
    </div>
  );
}
