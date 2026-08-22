// The back control's one question: is there a screen inside this app to go
// back to? Getting it wrong ejects the reader from the site.

import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canGoBack, markNavigation, resetNavigation } from "../nav";

beforeEach(() => resetNavigation());

describe("whether there is a step to go back to", () => {
  it("says no on a cold arrival", () => {
    // A shared link, a bookmark, the home-screen icon. `history.back()` here
    // leaves the app — to whatever the reader was doing before, or a blank tab.
    expect(canGoBack()).toBe(false);
  });

  it("says yes once the reader has moved inside the app", () => {
    markNavigation();
    expect(canGoBack()).toBe(true);
  });

  it("stays yes across further navigation", () => {
    // Landing -> team -> a rival's team. Every step is still a step back.
    markNavigation();
    markNavigation();
    expect(canGoBack()).toBe(true);
  });

  it("forgets on a full page load, which is what the reset stands for", () => {
    markNavigation();
    resetNavigation();
    expect(canGoBack()).toBe(false);
  });
});

describe("every in-app route push is recorded", () => {
  /*
   * The failure mode is one unrecorded `router.push`: the reader arrives on a
   * team page believing they came from the landing page, `canGoBack()` says no,
   * and the button silently changes destination. Source-level, because the
   * pushes are in components this repo cannot render.
   */
  const read = (f: string) =>
    fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8");

  it("routes every team push through a marker", () => {
    for (const f of ["app/page.tsx", "components/MiniLeague.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("markNavigation");
      /*
       * Every push to a team page must sit immediately after the marker. One
       * helper per file does, and nothing else may push — a second call site
       * that skips the marker is the whole failure mode, and it would read
       * perfectly well on its own line.
       */
      const pushes = [...src.matchAll(/router\.push\(/g)];
      expect(pushes.length, f).toBe(1);
      const before = src.slice(Math.max(0, pushes[0].index! - 160), pushes[0].index!);
      expect(before, f).toContain("markNavigation();");
    }
  });

  it("gives the dashboard a fallback rather than a bare back()", () => {
    const src = read("components/Dashboard.tsx");
    expect(src).toMatch(/backable \? router\.back\(\) : router\.push\("\/"\)/);
    // And the label says which one it is about to do.
    expect(src).toMatch(/backable \? "Back" : "Switch team"/);
  });
});
