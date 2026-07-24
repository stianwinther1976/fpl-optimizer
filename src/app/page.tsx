"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, entryNotFoundMessage, FplApiError, DEMO_ENTRY_ID, setDemoMode } from "@/lib/fpl";
import type { Entry } from "@/lib/types";
import ThemeToggle from "@/components/ThemeToggle";
import Lion from "@/components/Lion";
import { getRecentTeams, type RecentTeam } from "@/lib/recent";

const FEATURES: [string, string, string, string][] = [
  ["🧠", "Optimal team", "Best XI, formation and bench order from expected points.", "optimize"],
  ["🔄", "Transfer plans", "0–3 moves weighed against -4 hits — only moves that pay off.", "optimize"],
  ["🃏", "Chip advisor", "When Wildcard, Free Hit, Bench Boost and Triple Captain gain the most.", "optimize"],
];

export default function Home() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [id, setId] = useState("");
  const [checking, setChecking] = useState(false);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [recent, setRecent] = useState<RecentTeam[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem("fpl-id");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring persisted input on mount
    if (saved) setId(saved);
     
    setRecent(getRecentTeams());
  }, []);

  async function check() {
    const num = parseInt(id, 10);
    if (!num || num <= 0) {
      setError("Enter a valid number — you can find your ID in the URL on the FPL site.");
      return;
    }
    setChecking(true);
    setError(null);
    setEntry(null);
    try {
      setDemoMode(num === DEMO_ENTRY_ID);
      const e = await api.entry(num);
      setEntry(e);
      localStorage.setItem("fpl-id", String(num));
    } catch (err) {
      if (err instanceof FplApiError && err.status === 404) {
        setError(await entryNotFoundMessage());
      } else {
        setError(
          err instanceof FplApiError ? err.message : "Something went wrong. Please try again."
        );
      }
    } finally {
      setChecking(false);
    }
  }

  function openFeature(tab: string) {
    const num = parseInt(id, 10);
    if (num > 0) {
      router.push(`/team/${num}?tab=${tab}`);
    } else {
      inputRef.current?.focus();
      setError("Enter your FPL ID first — then this opens straight in the dashboard.");
    }
  }

  return (
    <main className="relative flex-1 flex flex-col items-center justify-center px-4 py-6 sm:py-16">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-xl text-center">
        <Lion className="mx-auto h-28 w-28 sm:h-36 sm:w-36" />
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-5xl">
          FPL <span className="text-accent">Optimizer</span>
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted sm:mt-4 sm:text-lg">
          Your FPL ID in — the mathematically best team out. Transfers, captaincy and
          chips, with every official rule built in.
        </p>

        <div className="card mt-4 p-4 text-left sm:mt-8 sm:p-6">
          {/* One-tap re-entry: no need to remember your ID after the first visit */}
          {recent.length > 0 && (
            <div className="mb-4">
              <div className="text-sm font-medium text-muted">Your teams</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {recent.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => router.push(`/team/${t.id}`)}
                    className="flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-semibold text-accent hover:bg-accent/20 active:bg-accent/20"
                    title={`${t.manager} · ID ${t.id}`}
                  >
                    ⚡ {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label htmlFor="fpl-id" className="block text-sm font-medium text-muted">
            {recent.length > 0 ? "Or another FPL ID" : "Your FPL ID"}
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="fpl-id"
              ref={inputRef}
              inputMode="numeric"
              value={id}
              onChange={(e) => setId(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && check()}
              placeholder="e.g. 1234567"
              className="min-w-0 flex-1 rounded-lg bg-panel-2 border border-border-c px-4 py-3 text-lg outline-none focus:border-accent"
            />
            <button
              onClick={check}
              disabled={checking}
              className="btn-primary shrink-0 whitespace-nowrap rounded-lg px-4 py-3 sm:px-5"
            >
              {checking ? "Checking…" : "Load team"}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Find it at fantasy.premierleague.com → “Points” — the number in the URL
            (…/entry/<b>1234567</b>/event/…).{" "}
            <button
              onClick={() => router.push(`/team/${DEMO_ENTRY_ID}`)}
              className="font-medium text-accent hover:underline"
            >
              Or try the mid-season demo →
            </button>
          </p>

          {error && (
            <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
              {error}
            </div>
          )}

          {entry && (
            <div className="mt-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-3">
              <div className="font-semibold">
                {entry.player_first_name} {entry.player_last_name} — “{entry.name}”
              </div>
              <div className="text-sm text-muted">
                {entry.summary_overall_points} points
                {entry.summary_overall_rank != null &&
                  ` · rank ${entry.summary_overall_rank.toLocaleString("en-GB")}`}
              </div>
              <button
                onClick={() => router.push(`/team/${entry.id}`)}
                className="btn-primary mt-3 w-full rounded-lg px-4 py-2.5"
              >
                Open dashboard →
              </button>
            </div>
          )}
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 text-left sm:mt-8 sm:gap-4">
          {FEATURES.map(([icon, title, desc, tab]) => (
            <button
              key={title}
              onClick={() => openFeature(tab)}
              className="card p-3 text-left hover:border-accent sm:p-4"
            >
              <div className="text-xl sm:text-2xl">{icon}</div>
              <div className="mt-1 text-xs font-semibold sm:mt-2 sm:text-sm">{title}</div>
              <div className="mt-1 hidden text-sm text-muted sm:block">{desc}</div>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
