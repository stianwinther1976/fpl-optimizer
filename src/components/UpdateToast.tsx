"use client";

import { useEffect, useState } from "react";

const CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * Detects when a newer deployment is live than the one this page was built
 * from, and offers a one-tap refresh. Checks when the tab regains focus
 * (the common phone case) and every few minutes while open.
 */
export default function UpdateToast() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    const mine = process.env.NEXT_PUBLIC_BUILD_ID;
    if (!mine) return;
    let stopped = false;

    async function check() {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { v } = await res.json();
        if (!stopped && v && v !== "dev" && !mine!.startsWith("dev-") && v !== mine) {
          setUpdateAvailable(true);
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

  return (
    <div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="card flex items-center gap-3 border-accent/50 px-4 py-2.5 shadow-lg">
        <span className="text-sm font-medium">✨ App updated — refresh for the latest version</span>
        <button
          onClick={() => window.location.reload()}
          className="btn-primary shrink-0 rounded-lg px-3 py-1.5 text-sm"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
