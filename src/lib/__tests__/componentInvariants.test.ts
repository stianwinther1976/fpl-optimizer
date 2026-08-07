import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * SOURCE-LEVEL GUARDS, AND WHAT THEY ARE AND ARE NOT WORTH.
 *
 * The project has no render harness — no jsdom, no testing-library — and
 * adding one to a deployed app is a bigger change than the defects below
 * justify. The arithmetic that could be extracted has been, into
 * `src/lib/display.ts`, where it is tested properly. What is left here is four
 * fixes that are structural rather than computational: a piece of state that
 * has to be cleared, a React key that has to be unique, a keyboard handler
 * that has to exist, a dismiss control that has to exist. None of those is a
 * function you can call.
 *
 * So these read the component source and assert a property of it. That is a
 * weaker guard than a behavioural test and it is worth being explicit about
 * how: it catches the exact regression coming back, and it catches nothing
 * else. A rewrite that keeps the token and loses the behaviour passes. Each
 * assertion below therefore states the behaviour in prose, so the next reader
 * knows what the token is standing in for.
 *
 * The first test is different in kind and is the one that earns its keep: it
 * is a rule over EVERY component, so a new clickable table row inherits it
 * without anyone remembering to.
 */
const DIR = path.resolve(__dirname, "../../components");
const LIB = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8");
const componentFiles = fs.readdirSync(DIR).filter((f) => f.endsWith(".tsx"));

describe("clickable table rows are reachable from a keyboard", () => {
  // A `<tr onClick>` that opens a detail sheet is a button wearing a table
  // row. Mouse and touch find it; Tab does not, and a screen reader announces
  // an ordinary row. `StatsTable` and `MiniLeague` already did this correctly
  // and `PointsBreakdown` did not, which is how the inconsistency was found.
  // Stated as a rule over the whole directory so the next such row is covered
  // whether or not anyone thinks to add a test for it.
  /**
   * The opening `<tr ...>` tags in one file, attribute list included.
   *
   * Scanned rather than matched with a regex, and the reason is the bug this
   * whole block is about: a keyboard handler is `onKeyDown={(ev) => {...}}`,
   * which CONTAINS a `>`. A lazy `/<tr[\s\S]*?>/` therefore stops inside the
   * arrow function, truncating away the very attributes being asserted on —
   * and it truncates them for the files that HAVE the handler, so the test
   * fails on the correct code and passes on the broken code. Depth counting
   * over the JSX braces is what makes the extraction honest.
   *
   * Quoted strings are skipped for the same reason one level down: a
   * `title="Rank > 100"` would otherwise end the tag mid-attributes and
   * reintroduce exactly the false failure the depth counter exists to prevent.
   */
  const openingTrTags = (src: string): string[] => {
    const out: string[] = [];
    for (let i = src.indexOf("<tr"); i >= 0; i = src.indexOf("<tr", i + 3)) {
      // Guard against matching a longer tag name that happens to start "tr".
      if (/[A-Za-z0-9_-]/.test(src[i + 3] ?? "")) continue;
      let depth = 0;
      let quote: string | null = null;
      for (let j = i + 3; j < src.length; j++) {
        const c = src[j];
        if (quote) {
          if (c === "\\") j++;
          else if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) {
          out.push(src.slice(i, j + 1));
          break;
        }
      }
    }
    return out;
  };

  it("the tag scanner survives a `>` inside a quoted attribute", () => {
    // The exact false failure this guards against: without quote handling the
    // block below is cut after `Rank ` and `onKeyDown=` vanishes from it, so
    // correct code is reported as missing its keyboard handler.
    const [block] = openingTrTags(
      `<tr title="Rank > 100" onKeyDown={(ev) => { if (ev.key > "a") {} }}>`
    );
    expect(block).toContain("onKeyDown=");
    expect(block.endsWith(">")).toBe(true);
  });

  const rowsWithClick: { file: string; block: string }[] = [];
  for (const f of componentFiles) {
    for (const block of openingTrTags(read(f))) {
      if (block.includes("onClick")) rowsWithClick.push({ file: f, block });
    }
  }

  it("finds the clickable rows it means to check", () => {
    // Without this the suite passes vacuously the moment the regex drifts.
    expect(rowsWithClick.length).toBeGreaterThanOrEqual(3);
    expect(rowsWithClick.map((r) => r.file)).toContain("PointsBreakdown.tsx");
  });

  it.each(["role=", "tabIndex=", "onKeyDown="])("every one declares %s", (attr) => {
    const missing = rowsWithClick.filter((r) => !r.block.includes(attr));
    expect(missing.map((m) => m.file)).toEqual([]);
  });

  it("every one handles Enter and Space", () => {
    const missing = rowsWithClick.filter(
      (r) => !(r.block.includes('"Enter"') && r.block.includes('" "'))
    );
    expect(missing.map((m) => m.file)).toEqual([]);
  });
});

describe("the display arithmetic is called, not re-inlined", () => {
  // `src/lib/display.ts` is only a fix if the components actually go through
  // it. Extracting the arithmetic and leaving the old expression at the call
  // site would pass every test in `display.test.ts` while shipping the
  // original bug, so each site is pinned to the helper and, where the old
  // expression is recognisable, to NOT containing it.
  it("LiveTab totals the bench with benchPoints, not with the counts flag", () => {
    const src = read("LiveTab.tsx");
    expect(src).toContain("benchPoints(");
    // The original: `.filter((r) => r.p.pickPosition > 11 && !r.counts)`. Under
    // Bench Boost `counts` is true for all fifteen, so this emptied the bench.
    expect(src).not.toMatch(/!r\.counts/);
  });

  it("Dashboard's gameweek delta goes through netGwDelta", () => {
    const src = read("Dashboard.tsx");
    expect(src).toContain("netGwDelta(");
    expect(src).not.toMatch(/curr\.points\s*-\s*past\.points/);
  });

  it("FixtureTicker averages difficulty through averageFdr", () => {
    const src = read("FixtureTicker.tsx");
    expect(src).toContain("averageFdr(");
    expect(src).toContain("fdrSortKey(");
    // The original divisor guard, which substituted 0 for "no fixtures".
    expect(src).not.toMatch(/Math\.max\(1,\s*cells\.flat\(\)\.length\)/);
  });

  it("KpiHistoryModal signs price moves through signedPrice", () => {
    const src = read("KpiHistoryModal.tsx");
    expect(src).toContain("signedPrice(");
    expect(src).not.toMatch(/diff > 0 \? "\+" : "−"/);
  });
});

describe("MiniLeague drops the previous league's numbers before fetching", () => {
  const src = read("MiniLeague.tsx");
  const body = src.slice(src.indexOf("async function loadDetails"));
  const beforeTry = body.slice(0, body.indexOf("try {"));

  it("clears details and ownership before the network calls, not after", () => {
    // Rival details take up to MAX_RIVAL_DETAILS sequential `picks` calls.
    // Both maps used to be written only at the END of that, so league A's
    // effective ownership sat under league B's heading for the whole fetch —
    // and if league B was too small to sample, the stale panel was all the
    // user ever saw, because `setOwnership(null)` lives in an else-branch that
    // only runs at the finish.
    expect(beforeTry).toContain("setDetails(");
    expect(beforeTry).toContain("setOwnership(null)");
  });
});

describe("PlayerModal keys recent fixtures uniquely", () => {
  const src = read("PlayerModal.tsx");

  it("does not key the recent-fixture chips on round alone", () => {
    // A double gameweek gives one player two history rows in the same round,
    // so `key={r.round}` is not unique and React reconciles the two chips as
    // one — stat values swap between them on re-render.
    expect(src).not.toMatch(/key=\{r\.round\}/);
    expect(src).toMatch(/key=\{`\$\{r\.round\}-\$\{r\.opponent_team\}`\}/);
  });
});

describe("gameweek scores are net of transfer hits wherever they are shown", () => {
  // `history.current[].points` is GROSS — the week's hit sits beside it in
  // `event_transfers_cost` — while `total_points`, `average_entry_score`, the
  // live tab's header and the points breakdown's "Net" line are all after the
  // hit. Any screen that prints the raw `points` therefore flatters a −4 week
  // by four and contradicts the screen one tap away from it. The three sites
  // below are every remaining place a gameweek score is rendered.
  it("the Latest GW card reconciles its headline with its delta", () => {
    const src = read("Dashboard.tsx");
    expect(src).toContain("netEventPoints(");
    expect(src).toContain("netGwDelta(");
    // The headline used to print the raw summary while the delta was net.
    expect(src).not.toMatch(/\$\{entry\.summary_event_points\}\s*pts/);
  });

  it("the gameweek sparkline is net", () => {
    const src = read("Dashboard.tsx");
    expect(src).not.toMatch(/pointsTrend\s*=\s*rows\.slice\(-8\)\.map\(\(r\) => r\.points\)/);
    expect(src).toMatch(/pointsTrend\s*=\s*rows\.slice\(-8\)\.map\(\(r\) => netGwPoints\(r\)\)/);
  });

  it("the KPI history modal is net in all three of its point sites", () => {
    const src = read("KpiHistoryModal.tsx");
    expect(src).not.toMatch(/font-mono">\{r\.points\}</);
    expect(src).not.toMatch(/r\.points\s*-\s*avg/);
    // EACH site pinned separately. One shared `toContain("netGwPoints(")` is
    // satisfied by any single site alone, so it would let the others quietly
    // go back to gross — which is exactly what happened: the sweep pinned two
    // columns by hand, and the third, in the Chips panel, kept printing the
    // gross figure for months because its variable is `row` rather than `r`.
    expect(src).toContain('font-mono">{netGwPoints(r)}<'); // the "Pts" column
    expect(src).toMatch(/const mine = netGwPoints\(r\);/); // the "± Avg" column
    expect(src).not.toMatch(/const mine = r\.points;/);
    expect(src).toContain("{netGwPoints(row)} pts"); // the Chips panel
    expect(src).not.toMatch(/\{row\.points\}\s*pts/);
  });

  it("no component renders a raw history-row score anywhere", () => {
    // The generalisation, and the reason the case above exists at all. Pinning
    // sites by hand is how the Chips panel was missed: the list was written
    // from the sites someone thought of. This is a rule over the directory, so
    // the next `{someRow.points}` fails the moment it is written, whatever the
    // variable happens to be called.
    //
    // `cornerTotal.points` is the one legitimate exception: it is not a
    // history row but a caller-supplied figure, and both call sites are
    // asserted net below.
    const offenders: string[] = [];
    for (const f of componentFiles) {
      for (const m of read(f).matchAll(
        />\s*\{\s*(\w+)\.points\s*\}|\{\s*(\w+)\.points\s*\}\s*pts/g
      )) {
        const name = m[1] ?? m[2];
        if (name !== "cornerTotal") offenders.push(`${f}: ${name}.points`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the pitch's corner total is net before it is handed over", () => {
    // Justifies the exception above rather than merely asserting it.
    const src = read("Dashboard.tsx");
    expect(src).toContain("points: eh.points - eh.event_transfers_cost,");
    expect(src).not.toMatch(/points:\s*eh\.points,/);
  });

  it("the points-per-gameweek chart is net", () => {
    const src = read("HistoryChart.tsx");
    expect(src).not.toMatch(/points:\s*r\.points/);
    expect(src).toContain("points: netGwPoints(r)");
  });
});

describe("Bench Boost cancels auto-substitutions", () => {
  // FPL makes no substitutions in a Bench Boost week: all fifteen play, so
  // there is no vacancy to fill. `projectAutoSubs` is computed from picks and
  // minutes alone and cannot know that, so the chip has to be applied at the
  // consuming end — otherwise the bench total silently loses the score of a
  // player the projection "promoted", and the pitch draws arrows for a
  // substitution that will never be processed.
  const src = read("LiveTab.tsx");

  it("LiveTab routes the projection through autoSubView with the chip", () => {
    expect(src).toContain("autoSubView(");
    expect(src).toMatch(/autoSubView\([\s\S]{0,200}bboost\s*\)/);
  });

  it("does not build the effective XI straight from the raw projection", () => {
    expect(src).not.toMatch(/new Set\(\s*autoSubs\?\.effectiveXi/);
    expect(src).not.toMatch(/subbedIn\s*=\s*new Set\(autoSubs\?\.in/);
  });

  it("still applies the vice-captain rule, which the chip does not cancel", () => {
    // The vice takes over from a captain who did not play in EVERY week,
    // Bench Boost included — so this one signal is read from the chip-blind
    // projection on purpose.
    expect(src).toContain("blankedStarters");
    expect(src).not.toMatch(/gwDone \|\| subbedOut\.has\(cap/);
  });
});

describe("MiniLeague's rival fetch is race-safe and fails visibly", () => {
  const src = read("MiniLeague.tsx");

  it("guards writes with a latest-wins sequence number", () => {
    // Two leagues picked in quick succession leave two fetches in flight; the
    // slower one writes last, so without this league A's rivals land under
    // league B's heading.
    expect(src).toMatch(/detailsSeq\s*=\s*useRef/);
    expect(src).toContain("++detailsSeq.current");
    // The guard has to sit BEFORE the write, which is the only place it does
    // any good. Merely mentioning `superseded()` somewhere in the function —
    // in the catch, in the finally — leaves the stale overwrite wide open.
    const write = src.indexOf("setDetails(new Map(results");
    const guard = src.indexOf("if (superseded()) return;");
    expect(write).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(write);
  });

  it("catches its own failures instead of leaving a silent blank panel", () => {
    // `loadDetails` is fired un-awaited from `load`, so its rejection cannot
    // reach `load`'s catch; and the state is cleared before the fetch starts.
    const body = src.slice(src.indexOf("async function loadDetails"));
    expect(body.slice(0, body.indexOf("}\n\n"))).toContain("catch {");
    expect(src).toContain("setDetailsError(true)");
  });
});

describe("theme tokens used by components actually exist", () => {
  // Tailwind emits nothing for a colour class with no matching `--color-*`
  // entry, so a typo'd token is not a compile error and not a lint error — it
  // is a class that silently does nothing. `hover:text-fg` was exactly that.
  const css = fs.readFileSync(
    path.resolve(__dirname, "../../app/globals.css"),
    "utf8"
  );
  const start = css.indexOf("@theme inline");
  const theme = css.slice(start, css.indexOf("}", start));
  const themeTokens = new Set(
    [...theme.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1])
  );

  // Every `text-…` / `bg-…` / `border-…` class the components use. The
  // lookbehind matters: without it `divide-border-c` and `border-border-c`
  // both also yield a phantom bare `c`, and a checker that has to be told to
  // ignore its own noise is a checker nobody trusts.
  const used = new Set<string>();
  for (const f of componentFiles) {
    for (const m of read(f).matchAll(
      /(?<![\w-])(?:hover:|focus:|active:|group-hover:)?(?:text|bg|border)-([a-z][a-z0-9-]*)/g
    )) {
      used.add(m[1]);
    }
  }

  // Tailwind ships these; only what is left over has to come from `@theme`.
  const PALETTE =
    "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
  const KEYWORD = /^(?:white|black|transparent|current|inherit|none)$/;
  // `text-` also spells sizes and alignment, which share the prefix but are
  // not colours at all.
  const TEXT_UTIL =
    /^(?:xs|sm|base|lg|[2-9]?xl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/;
  const builtIn = (t: string): boolean => {
    // `border-b-2`, `border-t-transparent`: drop the side, judge the rest.
    const side = /^([tblrxyse])-(.+)$/.exec(t);
    if (side) return builtIn(side[2]);
    if (/^[tblrxyse]$/.test(t)) return true; // border-t
    if (/^\d+$/.test(t)) return true; // border-2
    if (KEYWORD.test(t) || TEXT_UTIL.test(t)) return true;
    return new RegExp(`^(?:${PALETTE})(?:-\\d{2,3})?$`).test(t);
  };

  it("finds both halves of the comparison it is about to make", () => {
    // A check that silently scans nothing passes forever. Both sides have to
    // be non-trivially populated before the assertion below means anything.
    expect(used.size).toBeGreaterThan(20);
    expect(themeTokens.size).toBeGreaterThan(8);
    expect(themeTokens.has("fg")).toBe(true);
    expect(themeTokens.has("no-such-token")).toBe(false);
  });

  it("classifies Tailwind's own utilities apart from project tokens", () => {
    // The classifier is the load-bearing part: too greedy and it waves the
    // real defect through, too strict and it fails on `text-sm`.
    for (const t of ["zinc-500", "white", "transparent", "sm", "2xl", "b-2", "t-transparent", "t", "4"]) {
      expect(builtIn(t), t).toBe(true);
    }
    for (const t of ["fg", "ink", "panel-2", "border-c", "accent-2", "muted"]) {
      expect(builtIn(t), t).toBe(false);
    }
  });

  it("defines every project colour token the components actually use", () => {
    // THE REGRESSION, generalised. `hover:text-fg` and `active:text-ink` were
    // both classes Tailwind emitted NOTHING for — no compile error, no lint
    // error, just a hover state that never changed colour. Pinning a
    // hand-written list of tokens could not catch them, because the whole
    // failure mode is a token nobody remembered to write down.
    const custom = [...used].filter((t) => !builtIn(t)).sort();
    expect(custom).toContain("fg");
    expect(custom).toContain("ink");
    expect(custom.length).toBeGreaterThan(8);
    expect(custom.filter((t) => !themeTokens.has(t))).toEqual([]);
  });
});

describe("UpdateToast can be declined", () => {
  const src = read("UpdateToast.tsx");

  it("offers a dismiss control alongside the refresh", () => {
    // A fixed, z-50 bar pinned to the bottom of the viewport with no way out
    // but accepting a page reload.
    expect(src).toContain('aria-label="Dismiss update notice"');
  });

  it("announces itself, so the dismiss control can be found at all", () => {
    // The bar appears minutes after load, unprompted. Without a live region a
    // screen-reader user is never told it exists, and therefore never learns
    // there is anything to press.
    expect(src).toContain('role="status"');
    expect(src).toContain('aria-live="polite"');
  });

  it("remembers the dismissed build so a later deploy still announces itself", () => {
    // Dismissing must silence THIS version, not the mechanism. The polling
    // closure reads the value every tick, so it has to be a ref, not state.
    expect(src).toMatch(/dismissed\s*=\s*useRef/);
    expect(src).toContain("v !== dismissed.current");
  });
});

describe("team value is read the way FPL defines it", () => {
  // `entry_history.value` ALREADY INCLUDES the bank — that is why every
  // manager's team value is exactly 1000 after GW1 however much they left
  // unspent. Two screens nonetheless wrote `value + bank`, so the Team value
  // card ("£115.4m — £113.9m squad + £1.5m bank", derived from the squad)
  // opened into a history table claiming £116.9m for the same gameweek, and
  // the month-over-month delta counted every bank movement twice.
  //
  // The definition now lives once, in `display.ts:teamValue`, which is tested
  // properly. This guard is only here to stop the open-coded sum coming back.
  const offenders = componentFiles.filter((f) =>
    /\.value\s*\+\s*\w*\.?bank|\.bank\s*\+\s*\w*\.?value/.test(read(f))
  );

  it("never adds the bank to a history row's value", () => {
    expect(offenders).toEqual([]);
  });

  it("does not add the bank back on the far side of the helper", () => {
    // The guard above only forbids the sum written on the ROW. Routing through
    // `teamValue` and then writing `teamValue(r) + r.bank` reinstates the exact
    // same double-count while satisfying every other check in this block — the
    // file mentions the helper, and the forbidden `.value + .bank` shape never
    // appears. Name the shape rather than trusting the mention.
    const reAdders = componentFiles.filter((f) =>
      /teamValue\([^)]*\)\s*\+|\+\s*teamValue\(/.test(read(f))
    );
    expect(reAdders).toEqual([]);
  });

  it("routes both readers through the single definition", () => {
    // The card is squad-derived (Σ sellPrice + bank) and needs no helper; the
    // two row-derived readers do. Dashboard reads a DIFFERENCE of two rows, so
    // its helper is `valueDelta` — accepting either name here, rather than
    // demanding the literal string `teamValue`, is what stops the guard from
    // pushing the subtraction back inline to satisfy itself.
    for (const f of ["KpiHistoryModal.tsx", "Dashboard.tsx"]) {
      expect({ f, routed: /\b(teamValue|valueDelta)\s*\(/.test(read(f)) }).toEqual({
        f,
        routed: true,
      });
    }
  });

  it("does not difference two team values by hand", () => {
    // `valueDelta` exists so the SIGN of the month-over-month movement is
    // assertable; an inline `teamValue(a) - teamValue(b)` puts it back out of
    // reach of every test, and an inverted one paints a falling squad green.
    const inline = componentFiles.filter((f) => /teamValue\([^)]*\)\s*-\s*teamValue\(/.test(read(f)));
    expect(inline).toEqual([]);
  });
});

/*
 * EVERY PROJECTION IN THE APP READS THE SAME EVIDENCE.
 *
 * `projectAll` takes an optional `pastSeason` — last season's per-player
 * record, fetched once and shared through `pastSeasonStore`. Optional is the
 * problem: a component that forgets it still compiles, still renders, and still
 * produces a plausible number. `StatsTable` forgot it, so the Stats tab and the
 * pitch quoted different xP for the same man; `OptimizePanel`'s candidate
 * pre-rank forgot it, so the players the record helps most — a summer signing,
 * a returning absentee, anyone on no minutes this season — ranked near zero and
 * never had their line-ups looked up at all.
 *
 * Neither showed up as a failure anywhere. Both are cases of the same rule, so
 * the rule is stated over the whole directory rather than over the two files
 * that happened to break it.
 */
describe("nothing projects without last season's record", () => {
  /*
   * A FUNCTION, NOT A CONSTANT — and that is a bug fix, not a style choice.
   *
   * This was `const CALL = /projectAll\(\s*\{/g` shared between the two tests
   * below. A `/g` regex carries `lastIndex`, `RegExp.test` advances it, and
   * `String.matchAll` SEEDS ITS CLONE FROM IT. So the first test's `.test`
   * sweep left an offset behind and the second test began scanning every file
   * from that byte — roughly 218,000 characters in, which is past the end of
   * every source it looks at. The rule found zero call sites and passed.
   *
   * It survived only because the last file in the scan order is `lib/xp.ts`,
   * which does not itself call `projectAll` and therefore reset `lastIndex` to
   * 0 on its way out. Adding one `projectAll` call to the module that DEFINES
   * `projectAll` would have blinded the whole rule — silently, in the same
   * commit as a genuine violation. A guard that fails open on an unrelated
   * edit is worse than no guard, because it reports success.
   */
  const call = () => /projectAll\(\s*\{/g;

  /*
   * Comments are not code. `projectAll({ bootstrap, /* TODO: pastSeason * / })`
   * satisfied the check below on the strength of a note saying the work had
   * NOT been done. In a file set this heavily commented that is not a
   * contrived case, so the argument text is stripped before it is read.
   */
  const decomment = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  /*
   * The scan covers `src/lib` as well as `src/components`, and that is not
   * tidiness. The first version of this rule looked at components only, and
   * while it was green the actual second opinion was in `optimizer.ts`: the
   * optimizer, the six-week planner and the chip scenarios all projected with
   * no `pastSeason` because their input types had no field for one. The two
   * tabs agreed; the tab that makes the recommendation did not.
   */
  /*
   * RECURSIVE, and over `src` rather than over two hand-listed directories.
   * The flat `readdirSync` pair missed `src/app` entirely, missed any `.ts`
   * file sitting among the components, and would miss the first subdirectory
   * anyone adds under either. None of those are hypothetical places to project
   * from — `src/app` is where the pages live.
   */
  const walk = (dir: string, rel: string): { file: string; src: string }[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const full = path.join(dir, d.name);
      const name = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) return walk(full, name);
      if (!/\.tsx?$/.test(d.name) || /\.test\.tsx?$/.test(d.name)) return [];
      return [{ file: name, src: fs.readFileSync(full, "utf8") }];
    });
  const sources = walk(path.resolve(LIB, ".."), "");

  it("scans the files it means to scan", () => {
    // Without this the rule passes vacuously the day someone moves a file.
    const names = sources.map((s) => s.file);
    expect(names).toContain("components/StatsTable.tsx");
    expect(names).toContain("components/Dashboard.tsx");
    expect(names).toContain("lib/optimizer.ts");
    expect(names).toContain("lib/xp.ts");
    // `app/` is in scope too, and a scan that silently stopped covering it
    // would look exactly like a scan that found nothing wrong there.
    expect(names.some((n) => n.startsWith("app/"))).toBe(true);
    expect(sources.filter((s) => call().test(s.src)).length).toBeGreaterThanOrEqual(3);
  });

  it("passes pastSeason wherever it projects", () => {
    const offenders: { file: string; call: number }[] = [];
    for (const { file, src } of sources) {
      for (const m of src.matchAll(call())) {
        // The argument object, brace-matched: `pastSeason: past && past.size > 0
        // ? past : undefined` contains no closing brace, but a nested
        // `bootstrap: {...}` one day would, and a lazy match would stop there.
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (let i = end; i < src.length; i++) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}" && --depth === 0) {
            end = i;
            break;
          }
        }
        const arg = decomment(src.slice(m.index, end + 1));
        // Shorthand counts: `projectAll({ bootstrap, pastSeason })` passes the
        // record perfectly well, and a rule that fails correct code gets
        // deleted by the next person in a hurry.
        if (!/\bpastSeason\s*[:,}]/.test(arg)) offenders.push({ file, call: m.index });
      }
    }
    expect(offenders).toEqual([]);
  });

  /*
   * THE SCAN ABOVE IS A BACKSTOP. This is the rule.
   *
   * Everything the scan does is defeatable by writing the call differently:
   * `projectAll(ctx)` has no object literal to read, a nested brace inside a
   * string truncates the argument, and `pastSeason: undefined` satisfies a
   * regex looking for the word. A regex over source text can only ever
   * describe how the code is spelled.
   *
   * So `XpContext.pastSeason` is declared REQUIRED — `Map | undefined` rather
   * than `?: Map` — and the compiler enforces at every call site, in every
   * spelling, that somebody decided. `undefined` is still a legal answer; what
   * is no longer legal is not answering. See the note on the field itself in
   * `xp.ts` for why silence was the wrong default.
   */
  it("makes the compiler ask about last season, not this file", () => {
    const xp = fs.readFileSync(path.join(LIB, "xp.ts"), "utf8");
    const at = xp.indexOf("export interface XpContext {");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = xp.slice(at, xp.indexOf("\n}", at));
    // Optional would let a caller forget in silence, which is the whole defect.
    expect(/\bpastSeason\?:/.test(body)).toBe(false);
    expect(/\bpastSeason: Map<number, PastSeasonStats> \| undefined;/.test(body)).toBe(true);
  });

  /*
   * The engines take `pastSeason` optionally — they have a dozen inputs and a
   * caller who wants the default is not making a mistake — but they must at
   * least be ABLE to be told, and they must hand it on. `optimize` builds an
   * `XpContext` internally, so the compiler now catches the omission there;
   * `planHorizon` and `chipScenario` do too. This counts the forwarding.
   */
  it("lets every engine be told about last season", () => {
    const opt = fs.readFileSync(path.join(LIB, "optimizer.ts"), "utf8");
    for (const iface of ["OptimizerInput", "PlannerInput"]) {
      const at = opt.indexOf(`export interface ${iface} {`);
      expect({ iface, declared: at >= 0 }).toEqual({ iface, declared: true });
      const body = opt.slice(at, opt.indexOf("\n}", at));
      expect({ iface, takesRecord: /\bpastSeason\?:/.test(body) }).toEqual({
        iface,
        takesRecord: true,
      });
    }
    // ...and actually hands it on. Three engines project: optimize (via its
    // XpContext), planHorizon, chipScenario.
    expect(opt.match(/pastSeason: input\.pastSeason/g)?.length ?? 0).toBe(3);
  });

  it("keeps the stats table on the projection the pitch is drawn from", () => {
    // Two projections of a three-hundred-player league that agree today can
    // stop agreeing tomorrow, and the reader has no way to tell which one the
    // optimizer used. The table takes the dashboard's — and cannot make its
    // own, which is stronger than requiring it to pass the record: an optional
    // prop with a fallback is an untested second projection waiting to drift,
    // and this one could not even be reached.
    const table = read("StatsTable.tsx");
    expect(/projectAll\s*\(/.test(table)).toBe(false);
    // Required, not `xp?:`. The dashboard decides what "no next gameweek"
    // means; the table does not guess around a missing prop.
    expect(/^\s*xp: Map<number, PlayerXp> \| null;/m.test(table)).toBe(true);

    // Depth- and quote-aware, for the reason set out over `openingTrTags`: a
    // `[^>]*` scan is broken by the first prop containing a `>`, and
    // `onSelect={(el) => …}` is one keystroke away. It would then fail on
    // correct code.
    const dash = read("Dashboard.tsx");
    const uses: string[] = [];
    for (let i = dash.indexOf("<StatsTable"); i >= 0; i = dash.indexOf("<StatsTable", i + 11)) {
      let depth = 0;
      let quote: string | null = null;
      for (let j = i + 11; j < dash.length; j++) {
        const c = dash[j];
        if (quote) {
          if (c === "\\") j++;
          else if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) {
          uses.push(dash.slice(i, j + 1));
          break;
        }
      }
    }
    // EVERY use, not "some use" — a `.test()` on the whole file passes while a
    // second, record-blind table sits three hundred lines below the good one.
    expect(uses.length).toBeGreaterThanOrEqual(1);
    expect(uses.filter((u) => /\bxp=\{/.test(u))).toEqual(uses);
  });
});

describe("the captain's field read is looked up, never indexed", () => {
  // `captainReads` is keyed by element id precisely so the labels cannot drift
  // off the players they describe. A parallel array is the obvious shape and
  // the trap: `captainRanking` and the reads are built by different code, so
  // the day one of them is re-sorted, an ownership figure and a "the field's
  // last captain" note appear against another man's name — worse than showing
  // nothing, because it is wrong rather than missing.
  //
  // This guards the token, not the behaviour: the lookup must be by id. The
  // ordering itself is tested in `optimizer.test.ts`.
  it("reads the map by element id in OptimizePanel", () => {
    const src = read("OptimizePanel.tsx");
    expect(src).toMatch(/captainReads\.get\(\s*c\.element\.id\s*\)/);
    // And nothing indexes it. `captainReads[` would be an array subscript
    // returning undefined against a Map, which renders as a silently missing
    // label rather than an error.
    expect(src).not.toMatch(/captainReads\[/);
  });
});
