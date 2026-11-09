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
import { calibrationCaveat, maeTrend } from "@/lib/display";

export default function ModelAccuracy({ demo }: { demo: boolean }) {
  const [state, setState] = useState<CalibrationState | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading persisted, client-only data on mount
    setState(loadCalibration(demo));
  }, [demo]);
  if (!state) return null;

  const { factors, log } = state;
  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;
  /*
   * REPORTED IN BOTH DIRECTIONS, AND ONLY WHEN THERE IS A DIRECTION.
   *
   * Two rounds of this line have been wrong in the same place. It was first
   * `improving = last.mae < first.mae` rendered under `{improving && ...}`, so
   * the card reported itself only when the news was good. That was fixed to
   * report both directions — and left comparing `last.mae - first.mae` behind
   * a 0.01 threshold, which is two points out of ten against a series whose
   * neighbouring weeks differ by up to 0.51. It duly announced "▼ down from
   * 2.26 to 1.99" on a card whose second row was 1.75, lower than either end.
   *
   * `maeTrend` holds the arithmetic and its own note holds the reasoning. What
   * matters here is that the card no longer owns a threshold: the series is
   * asked whether it has a direction, and "flat" is one of the answers it can
   * give rather than the absence of one.
   */
  const trend = maeTrend(log);
  const caveat = calibrationCaveat(log);

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
        its own weights. The line under the table says whether the average miss has a
        DIRECTION across the graded gameweeks, or whether week-to-week noise is
        larger than any shift — which is the usual answer.
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
          {trend && trend.kind !== "insufficient" && (
            <div
              className={`mt-2 text-xs ${
                trend.kind === "flat" ? "text-muted" : trend.kind === "down" ? "text-accent" : "text-warn"
              }`}
            >
              {trend.kind === "flat" ? "◆" : trend.kind === "down" ? "▼" : "▲"}{" "}
              {trend.kind === "flat"
                ? `Average miss ${trend.lo.toFixed(2)}–${trend.hi.toFixed(2)} pts per player across the ${trend.n} graded gameweeks kept here (GW${trend.firstGw}–GW${trend.lastGw}); latest ${trend.latest.toFixed(2)}. No direction — the gap between the two halves (${Math.abs(trend.halfDelta).toFixed(2)}) is smaller than the ordinary week-to-week step (${trend.swing.toFixed(2)}).`
                : `Average miss ${trend.kind} by ${Math.abs(trend.halfDelta).toFixed(2)} pts per player between the first and second half of the ${trend.n} graded gameweeks kept here (GW${trend.firstGw}–GW${trend.lastGw}); range ${trend.lo.toFixed(2)}–${trend.hi.toFixed(2)}, latest ${trend.latest.toFixed(2)}.`}
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
        {/*
          WHAT THE CHIPS ARE ENTITLED TO CLAIM. "MID ×1.17" reads identically
          after one graded gameweek and after twenty, and a reader asked the
          question the card gave him no way to answer. The text is in
          `display.ts` so it can be tested; see its header for why GW1 in
          particular is the weakest possible evidence for a correction applied
          to in-season projections.
        */}
        {caveat && (
          <p className="mt-2 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
            {caveat}
          </p>
        )}
      </div>
    </div>
  );
}
