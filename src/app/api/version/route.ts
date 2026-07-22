// Returns the id of the deployment currently serving the domain.
// A page whose baked-in build id differs from this is stale.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const v = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";
  return NextResponse.json(
    { v },
    { headers: { "Cache-Control": "no-store" } }
  );
}
