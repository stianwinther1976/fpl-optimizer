// Canonical site URL: set NEXT_PUBLIC_SITE_URL when a custom domain exists;
// falls back to the Vercel production URL, then the current deployment.
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "https://fpl-optimizer-blond.vercel.app");
