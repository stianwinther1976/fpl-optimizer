import Link from "next/link";
import type { Metadata } from "next";
import Dashboard from "@/components/Dashboard";

/**
 * A team page is not the homepage, which the inherited metadata said it was.
 *
 * `robots.txt` already disallows `/team/`, so this was never indexed and never
 * mattered — but the root layout's `canonical: "/"` is inherited, so every
 * dashboard rendered a tag claiming to be a different page. `noindex` states
 * the same intent as robots.txt in the one place a crawler that ignored it
 * would still look: these pages are one reader's team, not content.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  alternates: { canonical: null },
};

/**
 * An FPL entry id, or null.
 *
 * `parseInt` ALONE IS NOT A VALIDATOR, and this route used to pass its result
 * straight through. Measured against the running app:
 *
 *   /team/abc      -> "FPL API error (400)"   (three requests fired for NaN)
 *   /team/-5       -> "FPL API error (400)"
 *   /team/1e999    -> silently loaded TEAM 1  (parseInt stops at the `e`)
 *   /team/0000001  -> silently loaded TEAM 1  (leading zeros, after the first
 *                     version of this guard)
 *
 * The last one is the reason this is not just cosmetics: a typo quietly showed
 * somebody else's team. The allowlist in the proxy refuses all of them before
 * anything reaches FPL, so nothing was ever exposed — but "FPL API error (400)"
 * is developer-speak for a plain input mistake, and it costs three round trips
 * to produce.
 *
 * Ten digits is past every real id and matches the proxy's own bound.
 */
function entryId(raw: string): number | null {
  // NO LEADING ZEROS. `/^\d{1,10}$/` admits `0000001`, and `Number` reads it as
  // 1 — so `/team/0000001` quietly showed team 1, which is the same "a typo
  // showed somebody else's team" this function exists to close. It also gave
  // every id ten accepted spellings, and each one is a distinct upstream fetch
  // and a distinct edge-cache key, which undercuts the proxy's own bound.
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  return Number(raw);
}

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const entry = entryId(id);
  if (entry == null) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-lg font-semibold">That is not an FPL team ID</h1>
        <p className="mt-2 text-sm text-muted">
          An ID is a plain number — you can find yours in the address bar on the FPL site, in
          the link that ends <code className="rounded bg-panel-2 px-1">/entry/1234567/</code>.
        </p>
        <Link
          href="/"
          className="btn-primary mt-6 inline-flex min-h-11 items-center rounded-lg px-5"
        >
          Enter an ID
        </Link>
      </main>
    );
  }
  return <Dashboard entryId={entry} initialTab={tab} />;
}
