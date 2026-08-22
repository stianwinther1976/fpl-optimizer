import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED,
  cacheControl,
  cdnCacheControl,
  cacheSeconds,
  staleSeconds,
  fetchUpstream,
  inflightSize,
  memoSize,
  resetMemo,
  staleIfErrorSeconds,
} from "./[...path]/route";

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
    /*
     * THE LEASH WAS 75 SECONDS LONG. `cacheSeconds * 2` gave these two a
     * 25-second freshness window and 50 seconds of grace on top, so an edge was
     * entitled to hand a reader a score or a match clock 75 seconds old — and
     * the UI polls every 30, which adds up to another 30 before the next
     * attempt. Reported from a live match twice: the clock behind the
     * television, and scores "langt bak".
     *
     * The whole budget now has to stay under one poll interval, which is what
     * this asserts rather than the two numbers separately.
     */
    for (const p of ["fixtures/", "event/5/live/"]) {
      expect(cacheSeconds(p) + staleSeconds(p), p).toBeLessThanOrEqual(30);
      // But not zero grace: a 20-second-old score beats an error while the
      // origin retries, and the origin's own deadline is 10 seconds.
      expect(staleSeconds(p), p).toBeGreaterThanOrEqual(10);
    }
    // And nothing else was dragged down with them — staleness costs nothing on
    // a feed that does not move mid-afternoon.
    expect(staleSeconds("bootstrap-static/")).toBe(cacheSeconds("bootstrap-static/") * 2);
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
    expect(cacheControl("event/1/live/")).toContain("s-maxage=10");
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
    /*
     * Three `return errorJson(` sites now, not four: the upstream's own two
     * failure shapes — not-ok and non-JSON — moved into `readUpstream`, which
     * returns them as DATA so they can be shared between deduped callers. They
     * reach the client through the one `result.kind === "error"` return, which
     * is an `errorJson` like the others. What must not change is that no error
     * ever leaves this file any other way.
     */
    expect((route.match(/return errorJson\(/g) ?? []).length).toBe(3);
    expect(route).toMatch(/if \(result\.kind === "error"\) \{/);
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

describe("a hung upstream cannot hold the response open", () => {
  /*
   * WHAT THIS FILE CANNOT TEST, SAID PLAINLY. Everything below stubs
   * `globalThis.fetch` directly, so nothing here goes through Next's patched
   * `fetch` — and the defect being fixed lives entirely inside that patch:
   * `withExecuteRevalidates` awaits a background revalidation whose signal
   * `patch-fetch` has stripped. A test at this level could not have failed on
   * it and still cannot, which is the CLAUDE.md failure mode where the test and
   * the code share a belief. It was found by building the route and pointing
   * `FPL_API_BASE` at a stub that accepts the connection and never answers:
   *
   *   entry stale, hung upstream, Data Cache on ... still open at 120 s
   *   entry stale, hung upstream, `no-store` ...... 502 at 10.01 s
   *   cold miss,   hung upstream, `no-store` ...... 502 at 10.01 s
   *
   * A HANG IS NOT THE WORST OF IT. Measured again on 2026-08-22, same method,
   * with the stub answering 200 once and then 503 the way a rate-limited FPL
   * does on a Saturday afternoon. Production build, `fixtures/` polled every
   * 4 s for 48 s against a 25 s TTL:
   *
   *   Data Cache on  ... 200 every time, body frozen at the one good read,
   *                      `minutes` stuck on 23 for the whole window
   *   `no-store` ....... 503 every time, which is what actually happened
   *
   * Six upstream attempts served twelve client requests and every failure was
   * swallowed, so the route's own `!upstream.ok` branch never ran: the client
   * was handed a 200 and had no way to know the numbers were an hour old. That
   * is the defect a reader hit during GW1 — a match at the hour mark rendering
   * 2' and 0-0 under a current "Updated" stamp. With a HEALTHY upstream the
   * same build tracked correctly (`minutes` 1 then 27, three upstream reads in
   * 40 s), so staleness required upstream failure and nothing else.
   *
   * So the source guard below is the honest half: it pins the ONE decision the
   * measurement turned on, which is that this fetch does not enter the Data
   * Cache. The behavioural tests pin the parts that are this module's own.
   */
  const route = () =>
    fs.readFileSync(path.resolve(__dirname, "[...path]/route.ts"), "utf8");

  it("opts the upstream fetch out of the Data Cache", () => {
    expect(route()).toContain('cache: "no-store"');
    // In the CODE. Two comments name `next: { revalidate }` — one explaining
    // what it used to do, one warning what reinstating it would cost — and
    // matching the bare token would pin the prose instead of the call.
    const code = route()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/next:\s*\{\s*revalidate/);
  });

  it("reads the body inside the deadline, not after it", () => {
    // `fetch` resolving means the HEADERS arrived. An upstream that sends them
    // and then stalls the body would be unbounded again, one layer down.
    const src = route();
    const at = src.indexOf("async function readUpstream");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("export function fetchUpstream"));
    expect(body).toContain("await res.json()");
    expect(src).toMatch(/withDeadline\(readUpstream\(url\), UPSTREAM_TIMEOUT_MS\)/);
  });

  it("makes one upstream request when many readers ask at once", async () => {
    // 20 concurrent identical requests against a slow stub produced exactly one
    // upstream fetch, measured on a production build. This is that, in-process.
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ ok: true }),
      } as unknown as Response;
    }) as typeof fetch;
    try {
      const out = await Promise.all(
        Array.from({ length: 20 }, () => fetchUpstream("http://x/api/event/1/live/"))
      );
      expect(calls).toBe(1);
      expect(out.every((r) => r.kind === "ok")).toBe(true);
      // And two different URLs are two reads, not one.
      calls = 0;
      await Promise.all([fetchUpstream("http://x/a/"), fetchUpstream("http://x/b/")]);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not remember a read once it has finished", async () => {
    // The map is the whole memory footprint of the dedupe. An entry that
    // outlived its fetch would be a cache with no expiry and no eviction.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;
    try {
      await fetchUpstream("http://x/api/fixtures/");
      expect(inflightSize()).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("shares a failure as well as a success, and forgets it too", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      throw new Error("upstream down");
    }) as unknown as typeof fetch;
    try {
      const results = await Promise.allSettled([
        fetchUpstream("http://x/api/down/"),
        fetchUpstream("http://x/api/down/"),
      ]);
      expect(calls).toBe(1);
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      expect(inflightSize()).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("the origin absorbs a launch draft, and only a launch draft", () => {
  /*
   * Dropping Next's Data Cache took origin-side absorption away with it, and
   * the note on `cdnCacheControl` still claimed it was there. Measured on a
   * production build, two readers asking for the same fifty summaries back to
   * back: 50 upstream fetches then 0 with the Data Cache, 50 then 50 without.
   * A launch draft is ~420 summaries per reader and CLAUDE.md classifies an
   * FPL rate-limit here as a MODELLING failure, not a slow page.
   *
   * The live feeds are deliberately NOT memoised: answering "Refresh now" from
   * a copy up to 25 seconds old is a defect the owner has already reported.
   */
  const okFetch = () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ n: calls }),
      } as unknown as Response;
    }) as typeof fetch;
    return () => calls;
  };

  it("stores an element summary and serves the next reader from memory", async () => {
    const original = globalThis.fetch;
    resetMemo();
    const calls = okFetch();
    try {
      const { GET } = await import("./[...path]/route");
      const req = { nextUrl: { searchParams: new URLSearchParams() } } as unknown as Parameters<typeof GET>[0];
      const params = Promise.resolve({ path: ["element-summary", "42"] });
      const a = await GET(req, { params });
      const b = await GET(req, { params: Promise.resolve({ path: ["element-summary", "42"] }) });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(calls()).toBe(1);
      expect(memoSize()).toBe(1);
    } finally {
      globalThis.fetch = original;
      resetMemo();
    }
  });

  it("does not memoise the live feeds, whatever their TTL says", async () => {
    const original = globalThis.fetch;
    resetMemo();
    const calls = okFetch();
    try {
      const { GET } = await import("./[...path]/route");
      const req = { nextUrl: { searchParams: new URLSearchParams() } } as unknown as Parameters<typeof GET>[0];
      await GET(req, { params: Promise.resolve({ path: ["fixtures"] }) });
      await GET(req, { params: Promise.resolve({ path: ["fixtures"] }) });
      await GET(req, { params: Promise.resolve({ path: ["event", "7", "live"] }) });
      await GET(req, { params: Promise.resolve({ path: ["event", "7", "live"] }) });
      expect(calls()).toBe(4);
      expect(memoSize()).toBe(0);
    } finally {
      globalThis.fetch = original;
      resetMemo();
    }
  });

  it("never stores a failure", async () => {
    // `pastSeasonStore` states the rule this follows: recording a miss would
    // take back the drafter's "try them again" button.
    const original = globalThis.fetch;
    resetMemo();
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      headers: { get: () => "application/json" },
    })) as unknown as typeof fetch;
    try {
      const { GET } = await import("./[...path]/route");
      const req = { nextUrl: { searchParams: new URLSearchParams() } } as unknown as Parameters<typeof GET>[0];
      const res = await GET(req, { params: Promise.resolve({ path: ["element-summary", "9"] }) });
      expect(res.status).toBe(503);
      expect(memoSize()).toBe(0);
    } finally {
      globalThis.fetch = original;
      resetMemo();
    }
  });

  it("keeps the map bounded, evicting the least recently used", async () => {
    // The 600 summaries on the 2026-08-21 snapshot are a median of 2.8 KB and
    // 1.85 MB in total; a full season's rows are roughly ten times that, so the
    // ceiling is tens of megabytes at worst — but it has to exist, because
    // `fetchCache` not having one is a defect this repo already recorded.
    const original = globalThis.fetch;
    resetMemo();
    const calls = okFetch();
    try {
      const { GET } = await import("./[...path]/route");
      const req = { nextUrl: { searchParams: new URLSearchParams() } } as unknown as Parameters<typeof GET>[0];
      for (let i = 1; i <= 900; i++) {
        await GET(req, { params: Promise.resolve({ path: ["element-summary", String(i)] }) });
      }
      expect(memoSize()).toBe(900);
      /*
       * AND LEAST RECENTLY *USED*, WHICH THIS TEST DID NOT CHECK. It was named
       * for the property and asserted only the size, so a plain
       * insertion-ordered map with no promotion on read would have passed.
       * Touch #1, then overflow: #1 must survive and #2 must go.
       */
      await GET(req, { params: Promise.resolve({ path: ["element-summary", "1"] }) });
      await GET(req, { params: Promise.resolve({ path: ["element-summary", "901"] }) });
      expect(memoSize()).toBe(900);
      // #2 was evicted, so asking for it goes upstream again; #1 did not.
      const before = calls();
      await GET(req, { params: Promise.resolve({ path: ["element-summary", "1"] }) });
      expect(calls()).toBe(before);
      await GET(req, { params: Promise.resolve({ path: ["element-summary", "2"] }) });
      expect(calls()).toBe(before + 1);
    } finally {
      globalThis.fetch = original;
      resetMemo();
    }
  });
});

describe("stale-if-error: the edge may cover an outage, except on live feeds", () => {
  /*
   * The `no-store` change removed the origin's ability to serve a cached body
   * behind a failed upstream. That is measured and correct for the live feeds —
   * a stale score under a current "Updated" stamp is a lie. It was applied to
   * every endpoint though, and a reader on a Saturday teatime got
   * "League not found" for a league he had just picked out of his own list.
   *
   * Slow-moving endpoints get the cover back at the EDGE, where it cannot hold
   * a response open the way the Data Cache did.
   */
  it("gives the live feeds no cover at all", () => {
    expect(staleIfErrorSeconds("fixtures/")).toBe(0);
    expect(staleIfErrorSeconds("event/1/live/")).toBe(0);
    expect(cdnCacheControl("fixtures/")).not.toContain("stale-if-error");
    expect(cdnCacheControl("event/1/live/")).not.toContain("stale-if-error");
  });

  it("covers the endpoints a gameweek-scale staleness cannot mislead about", () => {
    for (const p of ["leagues-classic/123/standings/", "entry/1/history/", "element-summary/1/"]) {
      expect(staleIfErrorSeconds(p)).toBe(staleSeconds(p));
      expect(cdnCacheControl(p)).toContain(`stale-if-error=${staleSeconds(p)}`);
    }
  });

  it("keeps it off the browser header, which must not serve stale live data", () => {
    // `Cache-Control` is the browser's copy; the whole point of the split is
    // that the two layers want different things.
    for (const p of ["fixtures/", "leagues-classic/123/standings/"]) {
      expect(cacheControl(p)).not.toContain("stale-if-error");
    }
  });
});
