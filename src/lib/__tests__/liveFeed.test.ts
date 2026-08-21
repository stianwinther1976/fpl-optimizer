import { describe, it, expect } from "vitest";
import { isLiveFeed } from "../fpl";

/*
 * WHICH FEEDS MAY NOT BE ANSWERED FROM THE BROWSER'S OWN STORE.
 *
 * These two change DURING a match rather than between matches, and they are
 * polled every 30 seconds while a gameweek is in play. A poll served out of the
 * phone's HTTP cache is not a poll, and the failure is silent — the request
 * resolves, `updatedAt` is stamped, and the numbers are minutes old. The proxy's
 * `max-age=0` is the primary fix; this predicate is the belt to that brace and
 * decides where `cache: "no-store"` is sent.
 */
describe("isLiveFeed", () => {
  it("covers the two feeds that move during a match", () => {
    expect(isLiveFeed("fixtures/")).toBe(true);
    expect(isLiveFeed("event/1/live/")).toBe(true);
    expect(isLiveFeed("event/38/live/")).toBe(true);
  });

  it("leaves the between-match feeds alone", () => {
    // These are fetched once per reader and cost a round trip each; making them
    // uncacheable would spend the client cache's whole purpose to no end.
    for (const p of [
      "bootstrap-static/",
      "entry/123/",
      "entry/123/history/",
      "entry/123/transfers/",
      "entry/123/event/1/picks/",
      "element-summary/42/",
      "leagues-classic/314/standings/",
    ]) {
      expect({ path: p, live: isLiveFeed(p) }).toEqual({ path: p, live: false });
    }
  });

  it("does not match a path that merely mentions an event", () => {
    // `entry/{id}/event/{gw}/picks/` contains "event/" and is NOT a live feed.
    expect(isLiveFeed("entry/123/event/1/picks/")).toBe(false);
  });
});
