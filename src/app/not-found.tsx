import Link from "next/link";

/**
 * The app's own 404, because Next's stock one is a bare white page.
 *
 * An unknown path used to render `404: This page could not be found.` with no
 * chrome, no theme and no way back — on a site whose only two real routes are
 * `/` and `/team/{id}`, so the likeliest visitor here is someone who mistyped
 * one of them.
 */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-lg font-semibold">There is nothing at this address</h1>
      <p className="mt-2 text-sm text-muted">
        The two pages here are the ID form and a team dashboard at
        <code className="mx-1 rounded bg-panel-2 px-1">/team/1234567</code>.
      </p>
      <Link href="/" className="btn-primary mt-6 inline-flex min-h-11 items-center rounded-lg px-5">
        Go to the ID form
      </Link>
    </main>
  );
}
