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
/** Route files, which live beside `components/` rather than inside it. */
const readApp = (f: string) => fs.readFileSync(path.join(DIR, "../app", f), "utf8");
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

  it.each(["tabIndex=", "onKeyDown="])("every one declares %s", (attr) => {
    const missing = rowsWithClick.filter((r) => !r.block.includes(attr));
    expect(missing.map((m) => m.file)).toEqual([]);
  });

  it("every one says what activating it does", () => {
    /*
     * Dropping `role="button"` is right for table semantics, but it leaves the
     * row a focus stop that announces only "row" with nothing saying it is
     * operable. `tabIndex` and the Enter/Space handler make it work; the label
     * is what makes it discoverable.
     */
    const unlabelled = rowsWithClick.filter((r) => !r.block.includes("aria-label="));
    expect(unlabelled.map((m) => m.file)).toEqual([]);
  });

  it("none of them claims to be a button", () => {
    /*
     * `role="button"` WAS THE WRONG FIX AND THIS TEST USED TO REQUIRE IT.
     *
     * `<tr>` permits only row and presentation roles. Given `button`, Chromium
     * exposes the enclosing `<tbody>` as role `none` and drops its rows: the
     * sixty data rows of the Stats table became flat buttons named
     * "BOU BOU Mid 1 BOU MID £12…", so price, xP, form, points, xGI and
     * ownership were read as one unlabelled run-on with no column association —
     * on the app's main comparison table. Confirmed in Chromium's AX tree.
     *
     * The keyboard half was never the problem: `tabIndex` and the Enter/Space
     * handler above are what make the row operable, and they stay. Losing the
     * role costs nothing a reader can hear, because the row's own cells carry
     * the meaning once the table survives.
     */
    const claiming = rowsWithClick.filter((r) => /role=\{[^}]*"button"/.test(r.block));
    expect(claiming.map((m) => m.file)).toEqual([]);
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

  it("Pitch colours live scores by the score, not by the clock", () => {
    const src = read("Pitch.tsx");
    expect(src).toContain("scoreTier(");
    // The original, in both the pitch card and the list row: green until the
    // gameweek finished, so a nought and a fifteen were painted the same and a
    // pre-kick-off list was fifteen identical bright-green rows.
    expect(src).not.toMatch(/live\.final \? .* : "text-\[#00ff87\]"/);
    expect(src).not.toMatch(/live\.final \? "" : "text-accent"/);
    // Both views go through it — the pitch card and the list are different
    // grounds and it would be easy to convert one and leave the other.
    expect(src.match(/scoreTier\(p\.live\.points\)/g)?.length).toBe(2);
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
    // ...and actually hands it on. FOUR projection sites, not four engines:
    // optimize projects twice — once over the transfer horizon (via its
    // XpContext) and once over the chip windows, which run to the end of the
    // half-season and so cannot share the shorter one — plus planHorizon and
    // chipScenario.
    //
    // The second `optimize` projection spells `pastSeason` out instead of
    // letting `{ ...ctx }` carry it. The compiler is satisfied either way; the
    // brace-scanning backstop above is not, because it reads how the call is
    // written. An exact count is what makes a silently-added fifth projection
    // that forgets the record show up here.
    expect(opt.match(/pastSeason: input\.pastSeason/g)?.length ?? 0).toBe(4);
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

describe("the launch card's BEST badge cannot contradict its own number", () => {
  // `rankLaunchVariants` calls two drafts level when they round equal at
  // `HORIZON_DECIMALS`. That rule is only honest if the card prints at the same
  // precision: at `toFixed(0)` the measured top two both read "223" while one
  // carried the badge, which is the bug this pair of checks exists to stop
  // coming back. There is no DOM here, so the coupling is guarded at the token.
  it("prints the horizon figure at HORIZON_DECIMALS", () => {
    const src = read("OptimizePanel.tsx");
    expect(src).toMatch(/horizonXp\.toFixed\(HORIZON_DECIMALS\)/);
    // Not a literal. A literal is what it was, and it drifted from the rule.
    expect(src).not.toMatch(/horizonXp\.toFixed\(\s*\d/);
  });

  it("badges from the shared ranking rather than its own argmax", () => {
    const src = read("OptimizePanel.tsx");
    // Both the badge and the pre-selection come from one call, so a tie cannot
    // be recognised in one place and ignored in the other.
    expect(src).toMatch(/rankLaunchVariants\(launch\)\.leaders/);
    expect(src).toMatch(/rankLaunchVariants\(variants\)\.bestIndex/);
    // And nothing re-derives a winner locally by sorting on the horizon.
    expect(src).not.toMatch(/sort\([^)]*horizonXp/);
  });
});

describe("a refresh the reader asked for is not answered from a cache", () => {
  /*
   * Two caches sit between "Refresh now" and the FPL API, and both used to win.
   * The client memo holds a live feed for 25 seconds, so a press inside that
   * window returned the promise the caller already had; and the proxy's header
   * carried no `max-age`, so the phone could answer out of its own store. Both
   * are silent: the promise resolves, `updatedAt` is stamped, and the numbers
   * are minutes old. Pressed, of course, exactly when they look wrong.
   */
  const src = read("LiveTab.tsx");

  it("forces past the client memo when the button is pressed", () => {
    // `lastIndexOf`: the doc block on `refresh` names the button too, and
    // anchoring on the first mention pointed this at a comment — where it
    // failed against correct code, which is how it was caught.
    const at = src.lastIndexOf("Refresh now");
    expect(at).toBeGreaterThan(0);
    // The button's own onClick, just above its label.
    expect(src.slice(Math.max(0, at - 400), at)).toContain("refresh(true)");
  });

  it("does not force on the timer, which would spend the memo's whole purpose", () => {
    const at = src.indexOf("const t = setInterval(");
    expect(src.slice(at, at + 200)).toMatch(/refresh\(\)/);
  });

  it("passes the flag down to both feeds, not just one", () => {
    // Forcing `live` and letting `fixtures` come from the memo would refresh
    // the scores and leave the clock and the finished-flags behind.
    const at = src.indexOf("Promise.all([api.live(");
    expect(src.slice(at, at + 120)).toMatch(/api\.live\(currentEvent, force\), api\.fixtures\(force\)/);
  });
});

describe("the squad view's live poll can actually stop", () => {
  /*
   * The Team tab took its live scores once at page load and never again, while
   * the Live tab had refreshed itself all along — so the default tab, the one
   * people watch a match on, quietly went stale with nothing on screen saying
   * so. It polls now, and these pin the two halves that make that safe.
   *
   * The subtle one is the stop condition. "Every fixture this gameweek is
   * finished" read off `data.fixtures` — the page-load copy — can never become
   * true while the page is open, so the poll would outlive the matches and run
   * until the tab closed. The poll therefore refetches fixtures and decides
   * from those.
   */
  const src = read("Dashboard.tsx");

  it("decides when to stop from the polled fixtures, not the page-load copy", () => {
    const at = src.indexOf("const livePollDone =");
    expect(at).toBeGreaterThan(0);
    const decl = src.slice(at, src.indexOf(";", src.indexOf("every((f) => f.finished)", at)));
    expect(decl).toContain("pollFixtures");
    expect(decl).not.toContain("data.fixtures");
    // And `pollFixtures` prefers the polled copy over the page-load one.
    expect(src).toMatch(/const pollFixtures = liveFixtures \?\? data\?\.fixtures/);
  });

  it("fetches fixtures alongside the scores, or the stop condition never moves", () => {
    const at = src.indexOf("const pull = () => {");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("};", at));
    expect(body).toContain("api\n        .live(");
    expect(body).toContain("api\n        .fixtures()");
  });

  it("does not tick while the tab is hidden, and catches up when it returns", () => {
    // A phone in a pocket must not poll for ninety minutes.
    // Anchored past `pull`, because `DeadlineChip`'s countdown declares a
    // `setInterval` earlier in the file and a bare indexOf finds that one.
    const at = src.indexOf("const t = setInterval(", src.indexOf("const pull = () => {"));
    expect(at).toBeGreaterThan(0);
    const region = src.slice(at, at + 500);
    expect(region).toContain("document.hidden");
    expect(region).toContain("visibilitychange");
    expect(region).toContain('document.visibilityState === "visible"');
  });

  it("tears the interval and the listener down together", () => {
    const at = src.indexOf("const onVisible = () => {");
    const region = src.slice(at, at + 500);
    expect(region).toContain("clearInterval(t)");
    expect(region).toContain('removeEventListener("visibilitychange"');
  });

  it("orders its own polls, so an older response cannot overwrite a newer", () => {
    /*
     * `cancelled` is per-EFFECT, not per-request. Two polls are on the wire
     * together whenever the client memo has expired, and if the earlier is the
     * slower it lands last and overwrites the newer scores — points going
     * backwards. `LiveTab` has always had a `seq` guard and names that symptom;
     * this poll was added later, copied the shape and not the reason.
     */
    const at = src.indexOf("const pull = () => {");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("};", at));
    expect(body).toContain("++livePollSeq.current");
    // Both setters are gated on it, not just one.
    expect(body).toMatch(/mine === livePollSeq\.current && setLiveData/);
    expect(body).toMatch(/mine === livePollSeq\.current && setLiveFixtures/);
  });

  it("shares one interval with the Live tab rather than redeclaring it", () => {
    // Two screens polling the same endpoints at different rates would make one
    // of them staler than the other for no reason a reader could see.
    expect(src).toContain("LIVE_REFRESH_MS");
    const live = read("LiveTab.tsx");
    expect(live).toContain("LIVE_REFRESH_MS");
    expect(live).not.toMatch(/const REFRESH_MS\s*=/);
    expect(fs.readFileSync(path.join(LIB, "live.ts"), "utf8")).toMatch(
      /export const LIVE_REFRESH_MS\s*=/
    );
  });
});

describe("only the topmost sheet traps focus", () => {
  /*
   * Both Tab listeners are on `document`, so with two sheets open every press
   * was handled twice: the lower yanked focus into itself, then the upper
   * yanked it to its first control — focus pinned to one element and the
   * middle of the top sheet unreachable by keyboard, which is worse than the
   * no-trap behaviour it replaced. Reachable via a chip sheet's player row,
   * which opens `PlayerModal` without closing the sheet underneath.
   */
  const src = read("Sheet.tsx");

  it("returns early when it is not the last dialog in the document", () => {
    expect(src).toMatch(/document\.querySelectorAll\('\[role="dialog"\]'\)/);
    expect(src).toMatch(/dialogs\.length > 1 && dialogs\[dialogs\.length - 1\] !== panel/);
  });

  it("checks that before doing any focus work, not after", () => {
    const at = src.indexOf("const onKey = (e: KeyboardEvent)");
    const guard = src.indexOf("dialogs[dialogs.length - 1] !== panel", at);
    const firstFocusCall = src.indexOf(".focus()", at);
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(firstFocusCall);
  });

  it("closes one sheet per Escape, not the stack", () => {
    /*
     * REVERSED FROM WHAT THIS TEST USED TO PIN. It required Escape to be
     * handled BEFORE the stacking guard, on the reading that letting it through
     * from either sheet was the generous behaviour. It is not — both listeners
     * are on `document`, so one press ran both handlers and closed both sheets.
     * WAI-ARIA's dialog pattern is that Escape dismisses the dialog it is in,
     * and the sheet underneath here is a chip scenario that took seconds to
     * compute. So the guard comes first and Escape obeys it.
     */
    const onKey = src.indexOf("const onKey = (e: KeyboardEvent)");
    const guard = src.indexOf("dialogs[dialogs.length - 1] !== panel", onKey);
    const esc = src.indexOf('if (e.key === "Escape")', onKey);
    expect(esc).toBeGreaterThan(0);
    expect(guard).toBeLessThan(esc);
    // Escape still reaches the handler at all: it is in the early-out's list.
    expect(src).toContain('if (e.key !== "Escape" && e.key !== "Tab") return;');
  });
});

describe("the launch drafter reads the store, not the transport", () => {
  /*
   * `loadPastSeason` resolves with the answer THAT load fetched, even when the
   * store rejected it as thinner than what it already holds. The other call
   * site in this file reads `cachedPastSeason()` for exactly this reason and
   * says so in a long note; `runLaunch` read `past.data` directly, so a
   * re-draft that came back worse (300 held, 250 returned) drafted from the
   * 250 while the pitch beside it projected from the 300 — the split the store
   * exists to close.
   */
  const src = read("OptimizePanel.tsx");

  it("prefers the held records when they are fuller", () => {
    expect(src).toMatch(/const held = cachedPastSeason\(\);/);
    expect(src).toMatch(/held\.size > past\.data\.size \? held : past\.data/);
  });

  it("drafts from those records rather than the transport's map", () => {
    const at = src.indexOf("buildLaunchVariants(");
    expect(at).toBeGreaterThan(0);
    const call = src.slice(at, src.indexOf(");", at));
    expect(call).toContain("records");
    expect(call).not.toContain("past.data");
  });

  it("counts the gap against what is actually being drafted from", () => {
    // Reporting `past.failed` beside a fuller set of records tells the reader
    // players are missing that the draft in front of them does have.
    expect(src).toMatch(/past\.requested - records\.size/);
  });
});

describe("the recent-teams pill keeps its two actions apart", () => {
  // A `<button>` inside a `<button>` is invalid HTML — React renders it and the
  // browser reparents it, so the remove control ends up outside the pill it
  // belongs to. It also puts a small target inside a large one that navigates
  // away, which on a phone is the wrong way round. There is no DOM here, so
  // both halves are guarded at the source.
  it("does not nest the remove control inside the open control", () => {
    const src = readApp("page.tsx");
    const from = src.indexOf("{recent.map((t) => (");
    expect(from).toBeGreaterThan(0);
    // The pill runs to its own closing tag; only buttons live inside it.
    const block = src.slice(from, src.indexOf("</span>", from));
    expect(block).toContain("removeTeam(t.id)");

    // Walk the button tags in order. Depth above 1 is a button inside a button.
    let depth = 0;
    let max = 0;
    let opens = 0;
    for (let i = 0; i < block.length; i++) {
      if (block.startsWith("</button>", i)) depth--;
      else if (block.startsWith("<button", i)) {
        depth++;
        opens++;
        max = Math.max(max, depth);
      }
    }
    expect(opens).toBe(2); // open-team and remove
    expect(max).toBe(1);
    expect(depth).toBe(0);
  });

  it("suppresses navigation while the list is being edited", () => {
    const src = readApp("page.tsx");
    const at = src.indexOf("router.push(`/team/${t.id}`)");
    expect(src.slice(at, at + 220)).toMatch(/disabled=\{editing\}/);
  });

  it("gives the remove control an accessible name", () => {
    // It renders as a bare "✕", which a screen reader announces as nothing.
    const src = readApp("page.tsx");
    const at = src.indexOf("removeTeam(t.id)");
    expect(src.slice(at, at + 220)).toMatch(/aria-label=/);
  });
});

describe("the reader's line-up calls are hydrated per feed", () => {
  // A call saved against the demo's id 42 must never be applied to the real
  // id 42, who is a different footballer. `lineup.ts` keys storage on the feed;
  // this is the other half of that contract, and it is the half a refactor can
  // silently drop — losing the dependency turns the hydration into a
  // mount-once, and the demo's overrides then survive into the real squad.
  it("re-hydrates when the entry changes", () => {
    const dash = read("Dashboard.tsx");
    const at = dash.indexOf("hydrateStartCalls(");
    expect(at).toBeGreaterThan(0);
    // The effect's dependency array, within a few lines of the call.
    const tail = dash.slice(at, at + 200);
    expect(tail).toMatch(/\}, \[entryId, squadNextEvent\]\)/);
    // And it is told WHICH feed, rather than assuming one.
    expect(dash.slice(at, at + 90)).toMatch(/DEMO_ENTRY_ID/);
  });

  it("re-hydrates when the gameweek moves, and stamps the call with it", () => {
    /*
     * A call is about ONE match. `loadStartCalls` drops a payload stamped with
     * a gameweek that is no longer next, but only the STORE expires — the
     * in-memory set does not, so a session that stays open across a deadline
     * would keep applying the expired call until a remount. The gameweek has
     * to be in the dependency array for the expiry to reach the screen.
     */
    const dash = read("Dashboard.tsx");
    expect(dash).toMatch(/const squadNextEvent = data\?\.squad\?\.nextEvent \?\? null;/);
    expect(dash).toMatch(/hydrateStartCalls\([^)]*squadNextEvent\)/);
    // And the write path carries the same gameweek, or nothing saved could
    // ever be loaded back.
    const modal = read("PlayerModal.tsx");
    expect(modal).toMatch(/setStartCall\(\s*demo,\s*nextEvent,/);
  });
});

describe("the pitch's bench survives an auto-substitution", () => {
  /*
   * `benchSortKey` and `benchBadgeFor` are tested properly in `display.test.ts`.
   * What cannot be tested there is that the components CALL them: the bench
   * arrays are built inline in JSX, and the bug was a `.sort()` on the raw pick
   * position. Both pitches on the Dashboard render an auto-subbed gameweek —
   * the live one and the time machine — and the fix has to reach both.
   */
  it("orders and badges both Dashboard benches through the shared rule", () => {
    const dash = read("Dashboard.tsx");
    const sorts = dash.match(/benchSortKey\(/g) ?? [];
    const badges = dash.match(/benchBadgeFor\(/g) ?? [];
    expect(sorts.length).toBe(4); // two comparators, two operands each
    expect(badges.length).toBe(2); // one per pitch
    // And no bench is still sorted on the bare pick order.
    expect(dash).not.toMatch(/\.sort\(\(a, b\) => a\.pickPosition - b\.pickPosition\)/);
    expect(dash).not.toMatch(/\.sort\(\(a, b\) => a\.position - b\.position\)/);
  });

  it("lets Pitch draw no badge at all, rather than defaulting to the row number", () => {
    // `undefined` means "number it by list position"; `null` means "no number".
    // Collapsing the two is how a substituted-off starter gets badged "1".
    const pitch = read("Pitch.tsx");
    expect(pitch).toMatch(/benchOrder\?: number \| null;/);
    expect(pitch).toMatch(/p\.benchOrder === undefined \? i \+ 1 : p\.benchOrder/);
    // Both layouts go through it, and neither keeps the old index-only badge.
    expect((pitch.match(/benchBadge\(p, i\)/g) ?? []).length).toBe(3);
    expect(pitch).not.toMatch(/row\(p, i \+ 1\)/);
  });
});

describe("the optimizer panel's horizon control", () => {
  it("does not throw away the Multi-GW plan, which never depended on it", () => {
    /*
     * `runPlan` passes a fixed `horizon: 6`, the button says "Plan next 6 GWs"
     * and the copy says "the next six deadlines" — so the plan on screen is
     * still an exact answer to the question it was asked. Clearing it cost the
     * reader the panel's most expensive computation for nothing.
     */
    const src = read("OptimizePanel.tsx");
    const at = src.indexOf("setHorizon(parseInt(");
    expect(at).toBeGreaterThan(0);
    const handler = src.slice(at, src.indexOf("}}", at));
    expect(handler).toContain("setResult(null)");
    expect(handler).toContain("setChipView(null)");
    // The stale error belongs to the results being cleared, so it goes too.
    expect(handler).toContain("setFailure(null)");
    expect(handler).not.toContain("setPlan(null)");
    // And the plan really is horizon-independent, which is why the above holds.
    expect(src).toContain("horizon: 6,");
  });

  it("announces a failure assertively", () => {
    // `status` is polite and queues behind whatever the panel is already
    // saying — which is the progress text for the work that just failed.
    const src = read("OptimizePanel.tsx");
    const at = src.indexOf("{failure && (");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 200)).toContain('role="alert"');
  });
});

describe("the mini-league ownership panel", () => {
  it("counts my squad the way it counts the field's", () => {
    /*
     * `eoCount` credits a rival's player on `position <= 11 || bboost`, so
     * effective ownership is about STARTING elevens. Three different rules were
     * in play: threats and shields tested all fifteen of mine, differentials
     * tested `pickPosition <= 11` with no Bench Boost case. A heavily-owned
     * player on my bench was therefore excluded from "Threats" for being mine
     * and listed under "Shields", which inverts what he actually is.
     */
    const src = read("MiniLeague.tsx");
    // One rule, and it matches the EO denominator on both halves.
    expect(src).toMatch(/const inMyXi = \(p: \{ pickPosition: number \}\) =>\s*p\.pickPosition <= 11 \|\| benchBoosted;/);
    expect(src).toContain('const benchBoosted = data.squad.activeChip === "bboost";');
    expect(src).toContain("p.position <= 11 || bboost");
    // Every consumer goes through it — one definition, two uses, no second
    // filter open-coded beside it.
    expect((src.match(/inMyXi\b/g) ?? []).length).toBe(3);
    expect(src).not.toMatch(/p\.pickPosition <= 11 &&/);
    // `myIds` — the XI — is what threats and shields split on.
    expect(src).toMatch(/threats[\s\S]{0,120}!myIds\.has\(id\) && v >= 0\.4/);
    expect(src).toMatch(/shields = ranked\.filter\(\(\[id, v\]\) => myIds\.has\(id\) && v >= 0\.4\)/);
  });

  it("says which threats are already in your squad, sitting on your bench", () => {
    /*
     * Narrowing `myIds` to the XI fixed the shield inversion and handed the
     * benched player the other wrong label: not in `myIds`, so printed under a
     * heading asserting you do not own him — and, because the column is
     * `slice(0, 5)`, displacing players the reader could actually buy. There
     * are three states, not two, and the third one's move is to start him.
     */
    const src = read("MiniLeague.tsx");
    expect(src).toContain(
      "const mySquadIds = new Set(data.squad.currentPlayers.map((p) => p.element.id));"
    );
    expect(src).toMatch(/benched: mySquadIds\.has\(id\)/);
    expect(src).toContain('note={t.benched ? "(on your bench)" : undefined}');
    // The heading and the empty state must not claim you do not own them.
    expect(src).not.toContain("they own, you don&apos;t");
    expect(src).not.toMatch(
      /<div className="text-xs text-muted">\s*No high-ownership player is missing/
    );
  });
});

describe("a sheet that is not on screen", () => {
  it("gets out of the keyboard's way instead of trapping it", () => {
    /*
     * These mount inside a tab panel, so a slow one can land after the reader
     * has changed tabs and end up `display:none`. It is then invisible but is
     * still the only `[role="dialog"]` in the document, so the Tab trap is
     * live, nothing inside it has an `offsetParent`, and the "nothing
     * focusable" branch focuses a hidden element — measured in Chromium as six
     * Tab presses that never move focus off `<body>`, with no visible dialog
     * and no reason for the reader to press Escape.
     */
    const src = read("Sheet.tsx");
    const guard = src.indexOf("panel.offsetParent === null");
    expect(guard).toBeGreaterThan(0);
    // Before any focus work — the trap's first act is to enumerate `items`.
    const onKey = src.indexOf("const onKey = (e: KeyboardEvent)");
    expect(guard).toBeGreaterThan(onKey);
    expect(guard).toBeLessThan(src.indexOf("const items = ", onKey));
    // But AFTER Escape: a sheet nobody can see must still be dismissible.
    expect(src.indexOf('if (e.key === "Escape")', onKey)).toBeLessThan(guard);
  });
});

describe("things the accessibility tree has to be told", () => {
  /*
   * All of these were verified in Chromium against the demo before being
   * pinned here, because a source-level guard cannot see a rendered tree. What
   * this block protects is the tokens surviving a refactor; what proved they
   * WORK was the browser.
   */
  it("announces the live score, since the tab rewrites it every 30 seconds", () => {
    // The app had no live region anywhere. The Live tab repaints the total, the
    // bench, the clock and the "Updated" stamp on a 30-second poll, and a
    // reader who cannot see the number had no way to know it moved — which on
    // that tab is the whole point of the tab. Polite: a score is worth hearing
    // at the next pause, not worth interrupting a sentence for.
    const src = read("LiveTab.tsx");
    expect(src).toContain('aria-live="polite"');
    expect(src).toMatch(/role="status"[\s\S]{0,80}aria-live="polite"/);
    // On the header, not on the fifteen rows: announcing every row on every
    // poll is noise. There is exactly one, and it is the score header's card.
    expect((src.match(/aria-live=/g) ?? []).length).toBe(1);
    const at = src.indexOf('aria-live="polite"');
    expect(src.slice(Math.max(0, at - 400), at)).toContain("card flex flex-wrap items-center");
  });

  it("keeps the promise `role=tablist` makes about the keyboard", () => {
    // Every tab had `tabindex` unset and the arrow keys did nothing, so the
    // strip announced a pattern it did not implement — worse than plain
    // buttons, which at least do not lie about how they work. Verified in
    // Chromium: ArrowRight moves selection and focus, End goes to the last tab.
    const src = read("Dashboard.tsx");
    expect(src).toContain("tabIndex={tab === key ? 0 : -1}");
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(src, `${key} is not handled`).toContain(`"${key}"`);
    }
    expect(src).toContain("document.getElementById(`tab-${order[to]}`)?.focus()");
  });

  it("states which layout is selected somewhere other than the colour", () => {
    // The two buttons differed only by `btn-primary` versus `text-muted`, so
    // the accessibility tree held two buttons and no state.
    expect(read("Pitch.tsx")).toContain("aria-pressed={layout === v}");
  });

  it("lets a keyboard reach every horizontally scrolling panel", () => {
    /*
     * Measured at 420px on the fixtures table: scrollWidth 562 against
     * clientWidth 386, with every focusable element inside it in the leftmost
     * column — so 45 Tab stops left `scrollLeft` at 0 and two gameweeks and the
     * average-difficulty column were unreachable without a pointer. This is a
     * rule over the directory rather than a list of the panels someone thought
     * of, which is how that one came to be missed.
     */
    const offenders: string[] = [];
    for (const f of componentFiles) {
      const src = read(f);
      for (const m of src.matchAll(/className=(?:\{`|")[^"`]*overflow-x-auto[^"`]*(?:`\}|")/g)) {
        const after = src.slice(m.index ?? 0, (m.index ?? 0) + 400);
        const before = src.slice(Math.max(0, (m.index ?? 0) - 400), m.index ?? 0);
        if (!/tabIndex=\{0\}/.test(after + before)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the match sheet reads one match", () => {
  it("goes through fixtureLines rather than the gameweek totals", () => {
    /*
     * `live.elements[].stats` is a GAMEWEEK total. Read as a per-match figure
     * it listed players who only appeared in the other leg, showed them at
     * 180', and ranked "top performers in this match" on two legs of BPS —
     * the same family of defect `provisionalBonus` was rewritten to remove,
     * still live one file over.
     */
    const src = read("MatchModal.tsx");
    expect(src).toMatch(/fixtureLines\(fixture, live,/);
    expect(src).not.toMatch(/live\?\.elements\.map\(\(e\) => \[e\.id, e\.stats\]\)/);
    expect(src).not.toContain("total_points");
  });
});

describe("the chip advisor's copy", () => {
  const src = read("OptimizePanel.tsx");

  it("carries the wildcard caveat on the sheet as well as the card", () => {
    /*
     * `wcGain` is `max(0, bestSquadWithinValue − keepSquad)`: bounded below by
     * zero, and a freshly optimised squad beats a held one over any window, so
     * it is almost always comfortably positive. The advisor card says in so
     * many words that this is the size of a gap and not a reason to play the
     * chip; the sheet showed the identical quantity under a bigger heading with
     * no such sentence.
     */
    const at = src.indexOf('s.chip === "wildcard" && (');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 500)).toMatch(/not a reason to play the chip this week/);
  });

  it("gives a chip the reader does not hold no call to action", () => {
    // The card dims and badges itself "Used / outside window", but the timing
    // note rendered at full strength regardless — urging the reader to wait for
    // a gameweek they cannot play it in, in the one colour that means "act".
    const at = src.indexOf("{a.timing.note && (");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 1400);
    expect(
      (block.match(/available && a\.timing\.verdict === "structural-window-ahead"/g) ?? []).length
    ).toBe(2); // the colour and the hourglass
  });

  it("uses the reader's spent chips to decide which window to reason about", () => {
    // Two of each chip since 2025/26, one per half. Without this the advisor
    // reasons over a window the reader has no chip left for.
    expect(src).toContain("usedChips: data.history?.chips ?? []");
    expect((src.match(/usedChips: data\.history\?\.chips \?\? \[\]/g) ?? []).length).toBe(2);
  });

  it("scores a chip preview on the same projection as the advisor", () => {
    // `showChip` awaited the past-season load and not the recent-form load, so
    // a chip tapped before Optimize projected without recent form while the
    // advisor projected with it — Wildcard "+2.3 pts" against +0.0.
    const at = src.indexOf("async function showChip");
    const body = src.slice(at, src.indexOf("setChipView(scen)", at));
    expect(body).toContain("await loadRecentForm()");
    expect(body).toContain("recentForm: recent");
  });
});

describe("tap targets on a phone", () => {
  /*
   * Measured in Chromium at 360x740 across every tab, before and after. The
   * worst offenders were the fixtures table's club buttons at 71x20, the Stats
   * sort headers at 34x24, "Refresh now" at 100x30, the Optimize chip badges at
   * 34 tall, and the price slider's 16px track. The tab strip and the
   * Pitch/List toggle already used `min-h-11`, so the 44px floor was known and
   * applied to two controls out of thirty.
   *
   * `min-h-11` is 2.75rem = 44px. What is deliberately NOT enforced is WIDTH:
   * seven tabs across 360px cannot each be 44 wide, and a table column header
   * is as wide as its label. Height is the axis a thumb misses on.
   */
  const sites: [string, string][] = [
    ["FixtureTicker.tsx", "min-h-11 text-left hover:text-accent"], // club buttons, were 20 tall
    ["StatsTable.tsx", "-m-1 min-h-11 p-1 uppercase"], // sort headers, were 24
    ["StatsTable.tsx", "min-h-11 rounded-md px-3 py-1.5"], // position pills, were 32
    ["StatsTable.tsx", 'className="h-11 accent-[var(--accent)]"'], // price slider, 16px track
    ["LiveTab.tsx", "mt-1 min-h-11 rounded-md border"], // Refresh now, was 30
    ["LiveTab.tsx", "flex min-h-11 w-full items-center gap-3"], // player rows, were 41
    ["OptimizePanel.tsx", "-m-1.5 flex min-h-11 items-center p-1.5"], // chip badges, were 34
    ["MiniLeague.tsx", "flex min-h-11 cursor-pointer items-center"], // <summary>, was 16
    ["PastSeasons.tsx", "grid min-h-11 w-full"], // season rows, were 36
    ["PointsBreakdown.tsx", "min-h-11 rounded-lg border border-border-c"], // select, was 36
  ];

  it("keeps every control that was under 44px tall at the floor", () => {
    const missing = sites.filter(([file, token]) => !read(file).includes(token));
    expect(missing.map(([f, t]) => `${f}: ${t}`)).toEqual([]);
  });

  it("keeps the remove control on the landing page a full target", () => {
    // It renders as a bare "✕" and was h-9 w-9.
    const src = fs.readFileSync(path.resolve(__dirname, "../../app/page.tsx"), "utf8");
    expect(src).toContain("flex h-11 w-11 items-center justify-center rounded-full");
  });
});

describe("this gameweek's squad versus the squad to optimize from", () => {
  /*
   * `SquadState.players` carries next gameweek's transfers and, in a Free Hit
   * week, is the fifteen the Free Hit replaced. `currentPlayers` is what is on
   * the pitch. Anything rendered against THIS gameweek's live scores — or
   * compared against rivals' teams for this gameweek — wants the second.
   *
   * A rule over the directory, because the first pass switched the Dashboard
   * and the Live tab and missed the mini-league, which compares my side against
   * `api.picks(rival, currentEvent)`.
   */
  it("uses currentPlayers everywhere a live score or a rival comparison is drawn", () => {
    for (const f of ["Dashboard.tsx", "LiveTab.tsx", "MiniLeague.tsx"]) {
      const src = read(f);
      for (const m of src.matchAll(/(?:data\.)?squad!?\.players\b/g)) {
        const at = m.index ?? 0;
        const line = src.slice(src.lastIndexOf("\n", at) + 1, src.indexOf("\n", at));
        // Team value is the one legitimate use: it pairs with `squad.bank`,
        // which `buildSquadState` adjusts by the same pending transfers.
        const isTeamValue = line.includes("sellPrice");
        // A mention inside a comment is documentation, not a call site.
        const isComment = /^\s*(\*|\/\/|\/\*)/.test(line);
        expect(isTeamValue || isComment, `${f}: ${line.trim()}`).toBe(true);
      }
    }
  });

  it("keeps the optimizer on `players`, which is what it is for", () => {
    // The mirror rule: the panel that plans NEXT gameweek must not be moved to
    // `currentPlayers` by someone applying the rule above too broadly.
    const src = read("OptimizePanel.tsx");
    expect((src.match(/owned: squad!\.players/g) ?? []).length).toBe(3);
    expect(src).not.toContain("owned: squad!.currentPlayers");
  });
});

describe("the vice-captain takes over on the same signal in both tabs", () => {
  it("asks the auto-sub projection, not just whether bonus is confirmed", () => {
    /*
     * `LiveTab` uses `gwDone || the projection dropped him`; the Dashboard used
     * `gwFinished` alone, which waits for `finished` — bonus confirmed — on
     * every fixture. Since the projection was moved to full time, the two
     * disagreed for the hours FPL takes to settle a Saturday: probed at six
     * points apart on identical data, 66 against 72. A takeover turns on
     * MINUTES, which are settled at the whistle.
     */
    const dash = read("Dashboard.tsx");
    expect(dash).toContain("autoSubs?.out.has(cap.element.id)");
    const live = read("LiveTab.tsx");
    expect(live).toContain("gwDone || blankedStarters.has(cap.element.id)");
    // And both read the armband off the fifteen actually fielded.
    for (const src of [dash, live]) {
      expect(src).toMatch(/currentPlayers\.find\(\(p\) => p\.isCaptain\)/);
      expect(src).toMatch(/currentPlayers\.find\(\(p\) => p\.isViceCaptain\)/);
    }
  });
});

describe("the player sheet in the gameweek time machine", () => {
  /*
   * Everything below the score is present tense, and under a GW15 heading that
   * is a sheet lying about which week it describes. Read off the demo before
   * the fix: "Recent gameweeks — started 5 of last 5" listed GW20 down to
   * GW16 — every one LATER than the gameweek on display, one still in play —
   * the transfer badge was GW20's, and the price predictor, FPL's next-gameweek
   * projection and "Upcoming fixtures GW21-23" were all about today.
   */
  const modal = read("PlayerModal.tsx");

  it("cuts the recent list at the gameweek being viewed", () => {
    expect(modal).toContain("s.history.filter((r) => r.round < asOfGw)");
    // And re-cuts it when the reader moves the time machine with the sheet open.
    expect(modal).toContain("}, [element.id, asOfGw]);");
  });

  it("drops every block that has no past-tense reading", () => {
    for (const token of [
      // FPL's next-gameweek projection, its price predictor, and the fixtures
      // AFTER today — all three about a week later than the heading.
      "{asOfGw == null && element.ep_next != null",
      "{asOfGw == null && price && (",
      "{asOfGw == null && upcoming.length > 0 && (",
      // Injury news and the set-piece depth chart are statements about now
      // with no historic value published, so there is nothing to relabel.
      "{asOfGw == null && element.news && (",
      "{asOfGw == null && (duties.length > 0 || netTransfers !== 0) && (",
      // The reader's team-news buttons: a press conference cannot be held
      // about a match that has been played, and tapping them wrote a call
      // stamped with TODAY'S gameweek from a sheet describing a past one.
      "{asOfGw == null && nextEvent != null && (",
    ]) {
      expect(modal, token).toContain(token);
    }
    // The transfer badges sit inside the duties wrapper, so they must not
    // carry a second guard of their own — an unreachable branch reads as a
    // protection that is doing something.
    expect(modal).not.toContain("asOfGw == null && netTransfers");
  });

  it("sums the season it is showing rather than printing today's", () => {
    /*
     * The block read POINTS / FORM / OWNED / GOALS / ASSISTS / XGI straight
     * off the `element` row, which is today's, under a past gameweek's
     * heading. The sheet already fetches this player's rounds, so the four
     * countable figures have a real past-tense reading; form and ownership do
     * not, and are dropped rather than relabelled.
     */
    expect(modal).toContain("`Season to GW${asOfGw}`");
    expect(modal).toMatch(/points \+= r\.total_points/);
    expect(modal).not.toMatch(/\["Form", element\.form\][\s\S]{0,400}asOfGw != null/);
  });

  it("counts only matches that have been played", () => {
    // FPL emits a history row from the DEADLINE with `minutes: 0` and
    // `starts: 0`. 538 of 600 players on the 2026-08-21 snapshot carried one
    // inside their last-five window, so "started 4 of last 5" was read off a
    // match that had not kicked off — and the chip for it rendered a red 0'.
    expect(modal).toMatch(/rows\.filter\(\(r\) => r\.team_h_score !== null\)/);
  });

  it("is told which gameweek it is showing", () => {
    const dash = read("Dashboard.tsx");
    expect(dash).toContain('asOfGw={tab === "team" && hist ? hist.gw : null}');
  });
});

describe("nobody reads FPL's gameweek average raw", () => {
  /*
   * `publishedAverage` is tested properly in `display.test.ts`. What cannot be
   * tested there is that the components CALL it — the bug was three separate
   * `?? null` expressions inline in JSX, each of which reads FPL's 0-for-not-
   * published as a real score. Extracting the helper and leaving any one of
   * them behind would pass every test in `display.test.ts` while shipping the
   * original bug on that screen, which is exactly the failure mode this file
   * exists for.
   */
  it("routes every average through the helper", () => {
    for (const f of ["LiveTab.tsx", "HistoryChart.tsx", "KpiHistoryModal.tsx"]) {
      const src = read(f);
      expect(src, f).toMatch(/publishedAverage\(/);
      // No raw read left in the CODE. The comments explaining the fix name the
      // field, so they are stripped first — matching the bare token would pin
      // the prose rather than the call.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code.match(/average_entry_score/g) ?? [], f).toHaveLength(0);
    }
  });
});
