"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchRecentStarts, type TeamData } from "@/lib/fpl";
import {
  optimize,
  buildLaunchVariants,
  planHorizon,
  chipScenario,
  type LaunchVariant,
  type OptimizerResult,
  type SeasonPlan,
  type ChipScenario,
} from "@/lib/optimizer";
import { projectAll } from "@/lib/xp";
import { fmtPrice, remainingChips, CHIP_LABELS } from "@/lib/rules";
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
  const [recentStarts, setRecentStarts] = useState<Map<number, number> | null>(null);
  const [plan, setPlan] = useState<SeasonPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [chipView, setChipView] = useState<ChipScenario | null>(null);
  const [chipLoading, setChipLoading] = useState<string | null>(null);

  const squad = data.squad;
  const teams = useMemo(
    () => new Map(data.bootstrap.teams.map((t) => [t.id, t])),
    [data.bootstrap]
  );

  const upcomingEvent = data.bootstrap.events.find((e) => e.is_next)?.id ?? null;

  // Season-launch mode: no squad yet (pre-GW1) but the new season's data is live.
  if ((!squad || squad.nextEvent == null) && upcomingEvent != null) {
    const runLaunch = () => {
      setLaunchRunning(true);
      setTimeout(() => {
        try {
          const { variants } = buildLaunchVariants(data.bootstrap, data.fixtures, upcomingEvent, 5);
          setLaunch(variants);
          setLaunchPick(0);
        } finally {
          setLaunchRunning(false);
        }
      }, 30);
    };
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
        </div>

        {launch && chosen && (
          <>
            {/* Strategy selector — several viable drafts, not one answer */}
            <div className="grid gap-2 sm:grid-cols-3">
              {launch.map((v, i) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setLaunchPick(i)}
                  className={`card p-3 text-left ${i === launchPick ? "border-accent" : "hover:border-accent"}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">{v.label}</span>
                    <span className="font-mono text-xs text-accent">{v.xi.totalXp.toFixed(1)} xp</span>
                  </div>
                  <div className="mt-1 text-[11px] leading-tight text-muted">{v.description}</div>
                </button>
              ))}
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
                <b className="text-accent">{chosen.xi.totalXp.toFixed(1)} xp</b>
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
  async function loadRecentStarts(): Promise<Map<number, number>> {
    if (recentStarts) return recentStarts;
    const prelim = projectAll({
      bootstrap: data.bootstrap,
      fixtures: data.fixtures,
      nextEvent: squad!.nextEvent!,
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
    const map = await fetchRecentStarts([...ids], 5, 8, (done, total) =>
      setPhase(`Checking recent line-ups… ${done}/${total}`)
    );
    setRecentStarts(map);
    return map;
  }

  async function run() {
    setRunning(true);
    setPhase("Checking recent line-ups…");
    try {
      const recent = await loadRecentStarts();
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
        recentStarts: recent,
      });
      setResult(res);
    } finally {
      setRunning(false);
      setPhase(null);
    }
  }

  async function runPlan() {
    setPlanning(true);
    setPhase("Checking recent line-ups…");
    try {
      const recent = await loadRecentStarts();
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
          recentStarts: recent,
        })
      );
    } finally {
      setPlanning(false);
      setPhase(null);
    }
  }

  // "What if I play this chip?" — computed on demand when a chip badge is tapped.
  async function showChip(chip: string) {
    setChipLoading(chip);
    try {
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
          recentStarts: recentStarts ?? undefined,
        },
        chip
      );
      setChipView(scen);
    } finally {
      setChipLoading(null);
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
          <label className="text-sm text-muted">Horizon:</label>
          <select
            value={horizon}
            onChange={(e) => setHorizon(parseInt(e.target.value))}
            className="rounded-lg bg-panel-2 border border-border-c px-3 py-2 text-sm"
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
            className="-m-1.5 p-1.5"
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
            className="-m-1.5 p-1.5"
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
              className="-m-1.5 p-1.5"
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

      {!result && !running && (
        <div className="card p-6 text-sm text-muted">
          Hit “Optimize team” to compute the highest-projected XI, transfer plans, captaincy and chip
          advice for GW{squad.nextEvent}, based on your squad from GW{squad.currentEvent}.
          Projections weigh who actually started your rivals&apos; last five matches, not just
          season averages.
        </div>
      )}

      {(running || planning) && (
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
            className="rounded-lg border border-accent/50 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent hover:bg-accent/20 active:bg-accent/20 disabled:opacity-50"
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
              {result.captainRanking.map((c, i) => (
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
                    </div>
                  </div>
                  <div className="whitespace-nowrap font-mono text-accent">
                    {c.xp.toFixed(1)} xp
                  </div>
                  {i === 0 && <Badge tone="green">Captain</Badge>}
                  {i === 1 && <Badge>Vice</Badge>}
                </button>
              ))}
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
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted">
              Only one chip per gameweek. Watch for double/blank gameweeks — Bench Boost and
              Triple Captain usually pay most in doubles, Free Hit in blanks.
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

      <div className="mt-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2.5 text-sm">
        <div className="font-semibold text-accent">
          Best in GW{s.bestGw}
          {s.note && <span className="font-normal"> — {s.note}</span>}
        </div>
        <div className="mt-0.5 text-muted">
          {s.chip === "wildcard" && (
            <>Projected to gain <b className="text-foreground">+{s.gain.toFixed(1)} pts</b> over {s.horizon} gameweeks vs keeping your team.</>
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

      {isSquadChip && s.xi && s.squad && (
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
