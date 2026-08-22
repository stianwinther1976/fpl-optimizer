import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ALLOWED, cacheControl, cdnCacheControl, cacheSeconds, staleSeconds } from "./[...path]/route";

/*
 * THE CACHE POLICY IS PART OF THE MODEL, NOT JUST PLUMBING.
 *
 * `element-summary/{id}/` is fetched once per PLAYER rather than once per
 * reader, so what this file decides is not "how fresh is the page" but "how
 * many hundreds of requests reach FPL when a draft is loaded". And the failure
 * mode is not a slow page: `fetchPastSeason` counts refusals, and a player it
 * could not fetch falls back to a price prior — the exact guess the whole
 * past-season path exists to avoid. A rate-limit is therefore a modelling
 * problem, which is why it is asserted here rather than left to a header.
 */
describe("proxy cache policy", () => {
  it("gives an element summary the same lifetime as the other gameweek-scoped feeds", () => {
    // It changes when results land and not otherwise, exactly like the entry
    // history beside it. It used to take the catch-all instead.
    expect(cacheSeconds("element-summary/123/")).toBe(cacheSeconds("entry/1/history/"));
    expect(cacheSeconds("element-summary/123/")).toBeGreaterThan(120);
  });

  it("lets a summary be served stale for far longer than anything else", () => {
    // The asymmetry that justifies it: one cold miss here is hundreds of
    // requests arriving together, not one.
    expect(staleSeconds("element-summary/123/")).toBeGreaterThan(
      staleSeconds("entry/1/history/") * 10
    );
  });

  it("does not let the in-play feeds go stale to pay for it", () => {
    // Fixtures and live scores drive a 30s poll. Whatever the summaries need,
    // these two must keep their own short leash.
    for (const p of ["fixtures/", "event/5/live/"]) {
      expect(cacheSeconds(p)).toBe(25);
      expect(staleSeconds(p)).toBe(50);
    }
  });
});

/*
 * THE HEADER THAT LET A PHONE ANSWER ITS OWN POLL.
 *
 * `public, s-maxage=25, stale-while-revalidate=50` binds the CDN and says
 * NOTHING to a browser: `s-maxage` is shared-cache only, and with no `max-age`
 * the browser has no freshness lifetime to apply, so it falls back to heuristic
 * caching and chooses one itself. The 30-second live poll was then served out
 * of the phone's own store while `updatedAt` was stamped "now" on every hit.
 * Measured during a live match: the app sat on 83' while FPL had moved to 89'.
 */
describe("cacheControl", () => {
  it("gives the browser an explicit directive, not a heuristic", () => {
    // `no-cache` rather than `max-age=0`: both forbid reuse without asking, but
    // `max-age=0` leaves `stale-while-revalidate` free to hand a private cache
    // a stale copy anyway, and `no-cache` does not.
    for (const p of ["fixtures/", "event/1/live/", "bootstrap-static/", "element-summary/1/"]) {
      expect(cacheControl(p)).toMatch(/(^|,\s*)no-cache(,|$)/);
    }
  });

  it("still lets the CDN hold it for the endpoint's own TTL", () => {
    expect(cacheControl("fixtures/")).toContain(`s-maxage=${cacheSeconds("fixtures/")}`);
    expect(cacheControl("event/1/live/")).toContain("s-maxage=25");
    expect(cacheControl("bootstrap-static/")).toContain("s-maxage=300");
  });

  it("keeps the stale-while-revalidate window", () => {
    // `must-revalidate` would bind shared caches too and cost this window,
    // which is what keeps a cold miss off the reader's critical path.
    expect(cacheControl("element-summary/1/")).toContain("stale-while-revalidate=86400");
    expect(cacheControl("fixtures/")).not.toContain("must-revalidate");
  });

  it("stops a browser serving a stale bootstrap around a deadline", () => {
    /*
     * `stale-while-revalidate` binds PRIVATE caches too — Chrome has had it in
     * the HTTP cache since M75 — so `max-age=0` alone let a browser serve a
     * ten-minute-old `bootstrap-static/` while refreshing behind. Around a
     * deadline that is the wrong `is_current` / `is_next`, at the one moment
     * the app must not be wrong about which gameweek it is.
     */
    for (const p of ["bootstrap-static/", "entry/1/history/", "element-summary/1/"]) {
      expect(cacheControl(p)).toMatch(/(^|,\s*)no-cache(,|$)/);
    }
  });

  it("uses no-cache, NOT proxy-revalidate, which is backwards on both counts", () => {
    /*
     * RFC 9111 §5.2.2.9: `proxy-revalidate` means the same as
     * `must-revalidate` "except that it does not apply to private caches". So
     * it says nothing to the browser — the case it was reached for — while
     * forbidding the CDN to serve stale, which is exactly the grace
     * `staleSeconds` exists to buy. It was shipped for one commit and this
     * pins that it does not come back.
     */
    for (const p of ["bootstrap-static/", "element-summary/1/", "fixtures/"]) {
      expect(cacheControl(p)).not.toContain("proxy-revalidate");
      expect(cacheControl(p)).not.toContain("must-revalidate");
    }
  });

  it("says the opposite thing to the CDN, in its own header", () => {
    /*
     * The two layers want opposite things and one header cannot say both.
     * `no-cache` is unqualified, so by RFC 9111 §5.2.2.4 it binds SHARED caches
     * too — `s-maxage` overrides `max-age`/`Expires`, not `no-cache`. Relying
     * on the two coexisting in one header was the fourth wrong version of this.
     */
    const cdn = cdnCacheControl("element-summary/1/");
    expect(cdn).toContain("s-maxage=300");
    expect(cdn).toContain("stale-while-revalidate=86400");
    // And the CDN's header must NOT carry the browser's directive, or the
    // separation buys nothing.
    expect(cdn).not.toContain("no-cache");
  });

  it("actually sends both headers, not just computes them", () => {
    /*
     * `cdnCacheControl` being correct is worth nothing if the route does not
     * emit it — and the pure function is testable while the emission is not,
     * which is exactly the gap where a fix looks shipped and is not.
     */
    const src = fs.readFileSync(
      path.join(__dirname, "[...path]", "route.ts"),
      "utf8"
    );
    expect(src).toMatch(/"Cache-Control": cacheControl\(joined\)/);
    expect(src).toMatch(/"CDN-Cache-Control": cdnCacheControl\(joined\)/);
  });

  it("keeps the two headers on the same TTLs", () => {
    // They answer different questions but must not drift apart on the numbers.
    for (const p of ["fixtures/", "event/1/live/", "bootstrap-static/", "element-summary/1/"]) {
      expect(cdnCacheControl(p)).toContain(`s-maxage=${cacheSeconds(p)}`);
      expect(cdnCacheControl(p)).toContain(`stale-while-revalidate=${staleSeconds(p)}`);
    }
  });

  it("never hands a browser a reuse window", () => {
    // A positive `max-age` lets a browser reuse without asking, which is the
    // whole defect. `no-cache` must not be accompanied by one.
    for (const p of ["fixtures/", "event/1/live/", "bootstrap-static/"]) {
      const m = /(?:^|,\s*)max-age=(\d+)/.exec(cacheControl(p));
      expect({ path: p, maxAge: m?.[1] ?? "absent" }).toEqual({ path: p, maxAge: "absent" });
    }
  });
});

describe("the allowlist, which is the security-relevant half of this route", () => {
  /*
   * This file had 149 lines about cache headers and NOT ONE about the
   * allowlist. Every case below was run against the live route before being
   * written down; what this pins is that they stay refused.
   */
  const allowed = (joined: string) => ALLOWED.some((re) => re.test(joined));
  /** What `GET` does to the raw segments before matching. */
  const normalise = (path: string[]) => {
    let joined = path.join("/");
    if (!joined.endsWith("/")) joined += "/";
    return joined;
  };

  it("accepts exactly the nine endpoint shapes the app uses", () => {
    for (const p of [
      "bootstrap-static/",
      "fixtures/",
      "entry/1/",
      "entry/1234567/event/38/picks/",
      "entry/1/history/",
      "entry/1/transfers/",
      "element-summary/999/",
      "event/1/live/",
      "leagues-classic/314/standings/",
    ]) {
      expect(allowed(p), p).toBe(true);
    }
  });

  it("refuses everything else, including the ways people try", () => {
    for (const p of [
      "../secret/",
      "entry/1/../../etc/passwd/",
      "ENTRY/1/",
      "entry/+1/",
      "entry/1.0/",
      "entry/0x1/",
      "entry/-1/",
      "entry//",
      "entry/1/history/extra/",
      "element-summary/1/history/",
      "bootstrap-static/x/",
      "fixtures/?a=1/",
      "me/",
      "",
      "entry/1e5/",
      // Fullwidth and Arabic-Indic digits are not `\d` under a non-unicode
      // regex, and must not become one by accident.
      "entry/１２３/",
      "entry/١٢٣/",
    ]) {
      expect(allowed(normalise(p === "" ? [] : p.split("/").filter(Boolean))), p).toBe(false);
    }
  });

  it("bounds the id, so the cache key space is finite", () => {
    // Every distinct id is a distinct edge key and a distinct upstream fetch.
    expect(allowed("entry/9999999999/")).toBe(true); // 10 digits
    expect(allowed("entry/10000000000/")).toBe(false); // 11
    expect(allowed(`entry/${"9".repeat(4000)}/`)).toBe(false);
  });

  it("cannot be made to end in a newline, which `$` would match", () => {
    // JS `$` matches before a trailing \n. Unreachable here because the
    // handler appends a slash whenever the string does not end in one, so a
    // joined path can never end in a newline — pinned because it is the kind of
    // thing a refactor of that one line would silently reintroduce.
    expect(normalise(["fixtures\n"]).endsWith("/")).toBe(true);
    expect(allowed(normalise(["fixtures\n"]))).toBe(false);
  });
});

describe("an error is never a cached one", () => {
  it("routes every error return through the no-store helper", () => {
    /*
     * The four error returns carried NO cache directive at all — measured on a
     * production build, only `vary:`. That is the same shape as the bug the
     * note on `cacheControl` is about: with no freshness lifetime a browser may
     * fall back to heuristic caching and pick its own, and "FPL is updating the
     * game" is the one answer that must not be remembered.
     */
    const route = fs.readFileSync(
      path.resolve(__dirname, "[...path]/route.ts"),
      "utf8"
    );
    expect(route).toContain('headers: { "Cache-Control": "no-store" }');
    // Four error paths: unknown endpoint, upstream not-ok, non-JSON, unreachable.
    expect((route.match(/return errorJson\(/g) ?? []).length).toBe(4);
    // And no error path bypasses it.
    expect(route).not.toMatch(/return NextResponse\.json\(\s*\{ error:/);
  });

  it("keeps a hard bound on how long the upstream may take", () => {
    // There was no signal at all: against a stub that never answers, this route
    // never answered either — measured at 45 seconds and still waiting — and it
    // kept the upstream socket after the client gave up at 3.
    const route = fs.readFileSync(path.resolve(__dirname, "[...path]/route.ts"), "utf8");
    expect(route).toContain("signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)");
    expect(route).toMatch(/const UPSTREAM_TIMEOUT_MS = [\d_]+;/);
    // And never follows a redirect: the upstream is fixed, so a 302 can only
    // come from FPL itself, and following one serves an off-host body under our
    // origin labelled publicly cacheable at the edge.
    expect(route).toContain('redirect: "error"');
  });
});
