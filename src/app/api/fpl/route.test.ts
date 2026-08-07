import { describe, expect, it } from "vitest";
import { cacheSeconds, staleSeconds } from "./[...path]/route";

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
