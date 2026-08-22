"use client";

// The model's own report card: how predictions hit each gameweek, and the
// corrections it has taught itself from those misses.

import { useEffect, useState } from "react";
import {
  loadCalibration,
  calibrationMultiplier,
  type CalibrationState,
} from "@/lib/calibration";
import { POSITION_NAMES } from "@/lib/rules";

export default function ModelAccuracy({ demo }: { demo: boolean }) {
  const [state, setState] = useState<CalibrationState | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading persisted, client-only data on mount
    setState(loadCalibration(demo));
  }, [demo]);
  if (!state) return null;

  const { factors, log } = state;
  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;
  const first = log[0];
  const last = log[log.length - 1];
  /*
   * REPORTED IN BOTH DIRECTIONS, WHICH IT WAS NOT.
   *
   * This line was `improving = ... last.mae < first.mae` and the summary
   * rendered under `{improving && ...}`, so a reader never saw "average miss
   * UP from X to Y" — the card reported itself only when the news was good,
   * directly under the unhedged sentence "Systematic misses shrink
   * automatically over time". That is a self-grading card supplying its own
   * evidence, and a previous round already removed the causal claim from this
   * line while leaving both the paragraph and the one-sided rendering in place.
   *
   * The threshold is symmetric and the direction decides the wording and the
   * colour. Nothing is claimed for a change inside it: two gameweeks of
   * gradeable data is a handful of players and the difference between 1.71 and
   * 1.73 is not a trend.
   */
  const maeDelta = log.length >= 2 ? last.mae - first.mae : 0;
  const moved = Math.abs(maeDelta) > 0.01;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-bold">🎯 Model accuracy — it grades itself</div>
        {demo && (
          <span className="rounded-full border border-warn/50 bg-warn/10 px-2 py-0.5 text-xs font-semibold text-warn">
            demo data
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        {/* NOT "the projections above" — this card renders on first visit to
            the Optimize tab, where there is nothing above it until the reader
            presses the button. */}
        How much to trust this app&apos;s projections: before every deadline the app saves what it
        predicted, then compares against the real points once the gameweek finishes and adjusts
        its own weights. The line under the table says whether the average miss has moved
        since the first graded gameweek, in whichever direction it moved.
      </p>

      {log.length === 0 ? (
        <p className="mt-3 rounded-lg bg-panel-2 px-3 py-2.5 text-sm text-muted">
          No graded gameweeks yet — tracking starts automatically: open the app before a
          deadline (the prediction is saved), then again after the gameweek (it gets graded).
        </p>
      ) : (
        <>
          <table className="mt-3 w-full text-sm">
            <thead className="border-b border-border-c text-xs uppercase text-muted">
              <tr>
                <th className="px-1.5 py-1.5 text-left">GW</th>
                <th className="px-1.5 py-1.5 text-right" title="Players graded">
                  Players
                </th>
                <th
                  className="px-1.5 py-1.5 text-right"
                  title="Mean absolute error — average miss per player, in points"
                >
                  Avg miss
                </th>
                <th
                  className="px-1.5 py-1.5 text-right"
                  title="Positive = the model predicted too high overall"
                >
                  Bias
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-c/60">
              {[...log].reverse().map((r) => (
                <tr key={r.gw}>
                  <td className="px-1.5 py-1.5 font-mono text-xs">GW{r.gw}</td>
                  <td className="px-1.5 py-1.5 text-right font-mono text-muted">{r.n}</td>
                  <td className="px-1.5 py-1.5 text-right font-mono">{r.mae.toFixed(2)} pts</td>
                  <td
                    className={`px-1.5 py-1.5 text-right font-mono ${
                      Math.abs(r.bias) <= 0.03
                        ? "text-accent"
                        : Math.abs(r.bias) <= 0.08
                          ? "text-warn"
                          : "text-danger"
                    }`}
                  >
                    {fmtPct(r.bias)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/*
            NO CAUSAL CLAIM, AND SAY WHICH WINDOW. "The corrections are working"
            was inferred from two numbers with no counterfactual — and the
            corrections on this same card are ×0.99/×0.92/×0.95/×0.90, which
            cannot plausibly account for a 0.45-point move in mean absolute
            error. Under CLAUDE.md's own rule that is a claim nobody measured.

            `first` is also the oldest RETAINED entry, and `CAL_CONFIG.maxLog`
            is 12 — so after twelve graded gameweeks "since GW{n}" starts
            sliding forward with nothing on screen saying so.
          */}
          {log.length >= 2 && (
            <div className={`mt-2 text-xs ${!moved ? "text-muted" : maeDelta < 0 ? "text-accent" : "text-warn"}`}>
              {!moved ? (
                <>
                  ◆ Average miss flat at {last.mae.toFixed(2)} pts per player, over the{" "}
                  {log.length} graded gameweeks kept here (GW{first.gw}–GW{last.gw}).
                </>
              ) : (
                <>
                  {maeDelta < 0 ? "▼" : "▲"} Average miss {maeDelta < 0 ? "down" : "up"} from{" "}
                  {first.mae.toFixed(2)} to {last.mae.toFixed(2)} pts per player, over the{" "}
                  {log.length} graded gameweeks kept here (GW{first.gw}–GW{last.gw}).
                </>
              )}
            </div>
          )}
        </>
      )}

      <div className="mt-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">
          Current self-corrections
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {[1, 2, 3, 4].map((pos) => {
            const m = calibrationMultiplier(factors, pos);
            const off = Math.abs(m - 1) >= 0.005;
            return (
              <span
                key={pos}
                className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                  off ? "border-accent/40 bg-accent/10 text-accent" : "border-border-c bg-panel-2 text-muted"
                }`}
                title={`All ${POSITION_NAMES[pos as 1 | 2 | 3 | 4]} projections are multiplied by ${m.toFixed(2)}`}
              >
                {POSITION_NAMES[pos as 1 | 2 | 3 | 4]} ×{m.toFixed(2)}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
