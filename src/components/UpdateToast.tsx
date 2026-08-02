"use client";

import { useEffect, useRef, useState } from "react";

const CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * Detects when a newer deployment is live than the one this page was built
 * from, and offers a one-tap refresh. Checks when the tab regains focus
 * (the common phone case) and every few minutes while open.
 */
export default function UpdateToast() {
  /** The newer build id we are advertising, or null when there is nothing to say. */
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  /**
   * The build id the user has already waved away. Held in a ref because the
   * polling closure below reads it on every tick and a state variable would be
   * captured stale. Keyed on the VERSION rather than a plain boolean so that
   * dismissing today's deploy does not silence tomorrow's.
   */
  const dismissed = useRef<string | null>(null);

  useEffect(() => {
    const mine = process.env.NEXT_PUBLIC_BUILD_ID;
    if (!mine) return;
    let stopped = false;

    async function check() {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { v } = await res.json();
        if (
          !stopped &&
          v &&
          v !== "dev" &&
          !mine!.startsWith("dev-") &&
          v !== mine &&
          v !== dismissed.current
        ) {
          setUpdateAvailable(v);
        }
      } catch {}
    }

    check();
    const t = setInterval(check, CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!updateAvailable) return null;

  // Refreshing is a SUGGESTION, so there has to be a way to decline it. This
  // bar is `fixed` at the bottom with `z-50`; with no close affordance the only
  // exit was to accept the reload, and on a 360px viewport it covers the bottom
  // of the page for the rest of the session.
  const dismiss = () => {
    dismissed.current = updateAvailable;
    setUpdateAvailable(null);
  };

  return (
    <div
      // This bar appears on its own, minutes after the page loaded, so it has
      // to announce itself: without a live region a screen-reader user is
      // never told it is there and so never learns there is anything to
      // dismiss. `polite` because a background deploy is not an interruption.
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 z-50 flex justify-center px-4"
      style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      <div className="card flex items-center gap-2 border-accent/50 py-2.5 pl-4 pr-2 shadow-lg">
        <span className="text-sm font-medium">
          <span aria-hidden="true">✨ </span>App updated — refresh for the latest version
        </span>
        <button
          onClick={() => window.location.reload()}
          className="btn-primary shrink-0 rounded-lg px-3 py-1.5 text-sm"
        >
          Refresh
        </button>
        <button
          onClick={dismiss}
          aria-label="Dismiss update notice"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-lg text-muted hover:bg-panel-2 hover:text-fg"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </div>
  );
}
