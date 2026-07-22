"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, FplApiError } from "@/lib/fpl";
import type { Entry } from "@/lib/types";
import ThemeToggle from "@/components/ThemeToggle";

export default function Home() {
  const router = useRouter();
  const [id, setId] = useState("");
  const [checking, setChecking] = useState(false);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("fpl-id");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring persisted input on mount
    if (saved) setId(saved);
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
      const e = await api.entry(num);
      setEntry(e);
      localStorage.setItem("fpl-id", String(num));
    } catch (err) {
      setError(err instanceof FplApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="relative flex-1 flex flex-col items-center justify-center px-4 py-16">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-xl text-center">
        <div className="text-6xl mb-4">⚽</div>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
          FPL <span className="text-accent">Optimizer</span>
        </h1>
        <p className="mt-4 text-lg text-muted">
          Enter your FPL ID and get the mathematically best team for the next gameweek —
          transfers, captaincy and chips, with every official rule built in.
        </p>

        <div className="mt-8 card p-6 text-left">
          <label htmlFor="fpl-id" className="block text-sm font-medium text-muted">
            Your FPL ID
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="fpl-id"
              inputMode="numeric"
              value={id}
              onChange={(e) => setId(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && check()}
              placeholder="e.g. 1234567"
              className="flex-1 rounded-lg bg-panel-2 border border-border-c px-4 py-3 text-lg outline-none focus:border-accent"
            />
            <button
              onClick={check}
              disabled={checking}
              className="btn-primary rounded-lg px-5 py-3"
            >
              {checking ? "Checking…" : "Load team"}
            </button>
          </div>
          <p className="mt-3 text-xs text-muted">
            Find your ID: log in at fantasy.premierleague.com → “Points” — the number in the
            URL (…/entry/<b>1234567</b>/event/…) is your ID.
          </p>

          {error && (
            <div className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
              {error}
            </div>
          )}

          {entry && (
            <div className="mt-4 rounded-lg border border-accent/40 bg-accent/10 px-4 py-3">
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

        <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-4 text-left">
          {[
            ["🧠", "Optimal team", "Best XI, formation and bench order from expected points."],
            ["🔄", "Transfer plans", "0–3 moves weighed against -4 hits — only moves that pay off."],
            ["🃏", "Chip advisor", "When Wildcard, Free Hit, Bench Boost and Triple Captain gain the most."],
          ].map(([icon, title, desc]) => (
            <div key={title} className="card p-4">
              <div className="text-2xl">{icon}</div>
              <div className="mt-2 font-semibold">{title}</div>
              <div className="mt-1 text-sm text-muted">{desc}</div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
