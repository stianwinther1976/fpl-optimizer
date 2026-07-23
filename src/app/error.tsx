"use client";

// Global safety net: if anything in the app throws during render, the user
// gets a friendly recovery screen instead of a blank page.

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      <div className="text-4xl">🦁</div>
      <h1 className="mt-3 text-xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">
        The app hit an unexpected error — usually a hiccup in the FPL data feed. Your team and
        history are safe on FPL&apos;s servers.
      </p>
      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="btn-primary rounded-lg px-5 py-2.5 text-sm font-semibold"
        >
          Try again
        </button>
        <a
          href="/"
          className="rounded-lg border border-border-c bg-panel px-5 py-2.5 text-sm font-semibold hover:border-accent"
        >
          Back to start
        </a>
      </div>
      {error.digest && (
        <p className="mt-4 font-mono text-[11px] text-muted">ref: {error.digest}</p>
      )}
    </main>
  );
}
