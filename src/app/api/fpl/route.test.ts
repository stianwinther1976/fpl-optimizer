import { describe, expect, it } from "vitest";
import { cacheControl, cacheSeconds, staleSeconds } from "./[...path]/route";

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

  it("keeps the CDN's window and its stale-while-revalidate grace", () => {
    // `no-cache` forbids reuse without revalidation, but a shared cache with
    // `s-maxage` may still serve inside that window — which is what keeps a
    // launch draft's ~420 element-summary fetches off FPL's rate-limited API.
    expect(cacheControl("element-summary/1/")).toContain("s-maxage=300");
    expect(cacheControl("element-summary/1/")).toContain("stale-while-revalidate=86400");
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
