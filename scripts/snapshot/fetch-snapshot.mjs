// Pull a complete, self-contained snapshot of the live FPL API to disk.
//
// Why this exists: the development sandbox this repo is worked on from has a
// host allowlist for outbound network traffic, and `fantasy.premierleague.com`
// is not on it. Every fetch returns the literal string
//   "Host not in allowlist: fantasy.premierleague.com."
// so no amount of retrying helps. That makes it impossible to run `projectAll`
// against the actual current season from there, which in turn makes it
// impossible to check the model's output against anything real during
// pre-season, when the archived CSVs in fpl-data are the WRONG season and the
// squads people are actually picking are the only thing worth grading.
//
// A GitHub Actions runner has no such restriction. So the snapshot is taken
// there and committed to a data branch, and the sandbox reads it out of git.
// This is a transport workaround, not a data source change: everything below
// comes from the official public API and nothing else.
//
// Three of the files written are exactly the three inputs `XpContext` needs:
// `bootstrap-static`, `fixtures`, and one `element-summary` per player (reduced
// to the rows `fetchPastSeason` and `fetchRecentForm` actually read, because the
// full summaries are ~40x larger and the rest is never looked at).
//
// The fourth, `event-live.json`, is not a model input at all — it is there so
// the live payload can be READ. Three defects shipped for a season because it
// could not be; see the note beside the fetch below.

import { writeFile, mkdir } from "node:fs/promises";

const BASE = "https://fantasy.premierleague.com/api";
const OUT = "snapshot";
const CONCURRENCY = 8;

// A browser-ish UA. The API is public and unauthenticated, but Cloudflare in
// front of it is less friendly to a bare Node default UA.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/json",
};

async function getJson(path, tries = 4) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) {
      // Linear-ish backoff. 429 is the common failure at this concurrency and
      // it clears in well under a second; a long exponential wait would just
      // make a 700-request run take minutes for no benefit.
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    try {
      const res = await fetch(`${BASE}/${path}`, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${path}: ${lastErr?.message ?? "failed"}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const bootstrap = await getJson("bootstrap-static/");
  const fixtures = await getJson("fixtures/");
  console.log(
    `bootstrap: ${bootstrap.elements.length} elements, ${bootstrap.teams.length} teams; fixtures: ${fixtures.length}`
  );

  const ids = bootstrap.elements.map((e) => e.id);
  const summaries = {};
  const failed = [];
  let done = 0;
  const queue = [...ids];

  const worker = async () => {
    for (;;) {
      const id = queue.shift();
      if (id == null) return;
      try {
        const s = await getJson(`element-summary/${id}/`);
        // Reduced to what the model reads. `history` is only ever sliced to the
        // last 5 rounds by `fetchRecentForm`; 8 is kept so a change of that
        // window does not require a new snapshot. `history_past` is kept whole
        // because `fetchPastSeason` walks it backwards looking for the most
        // recent season with minutes, which can be any row.
        summaries[id] = {
          history: (s.history ?? []).slice(-8),
          history_past: s.history_past ?? [],
        };
      } catch (e) {
        failed.push({ id, error: String(e.message ?? e) });
      }
      done++;
      if (done % 100 === 0) console.log(`element-summary ${done}/${ids.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // The count is written into the file rather than only logged. A snapshot that
  // silently dropped 200 players would produce a projection that looks fine and
  // is quietly running on price priors for a third of the league.
  /*
   * THE LIVE FEED, WHICH THIS SNAPSHOT DID NOT CARRY AND SHOULD HAVE.
   *
   * Three defects shipped for a season because nobody could look at
   * `event/{gw}/live/`: the match clock was estimated while `minutes` sat
   * unread in the fixtures payload, full time was read off the wrong flag while
   * `finished_provisional` sat beside it, and provisional bonus was computed
   * from gameweek-total BPS as if it described one match. All three were
   * answerable from the payload. None was answerable from this snapshot.
   *
   * Best-effort and non-fatal: off-season there is no current event, and a
   * failure here must not lose the bootstrap and summaries that took minutes to
   * fetch. `explain` makes this the biggest file of the four during a live
   * gameweek, and it is worth it.
   */
  const liveEvent =
    bootstrap.events.find((e) => e.is_current)?.id ??
    [...bootstrap.events].reverse().find((e) => e.finished)?.id ??
    null;
  let live = null;
  if (liveEvent != null) {
    try {
      live = await getJson(`event/${liveEvent}/live/`);
      console.log(`live: GW${liveEvent}, ${live.elements?.length ?? 0} elements`);
    } catch (err) {
      console.log(`live: GW${liveEvent} unavailable (${String(err)})`);
    }
  }

  const meta = {
    fetchedAt: new Date().toISOString(),
    liveEvent: live ? liveEvent : null,
    elements: ids.length,
    summariesOk: Object.keys(summaries).length,
    summariesFailed: failed.length,
    failures: failed.slice(0, 40),
    events: bootstrap.events.length,
    nextEvent: bootstrap.events.find((e) => e.is_next)?.id ?? null,
    currentEvent: bootstrap.events.find((e) => e.is_current)?.id ?? null,
  };

  await writeFile(`${OUT}/bootstrap-static.json`, JSON.stringify(bootstrap));
  await writeFile(`${OUT}/fixtures.json`, JSON.stringify(fixtures));
  await writeFile(`${OUT}/element-summaries.json`, JSON.stringify(summaries));
  if (live) await writeFile(`${OUT}/event-live.json`, JSON.stringify(live));
  await writeFile(`${OUT}/meta.json`, JSON.stringify(meta, null, 2));

  console.log(JSON.stringify(meta, null, 2));
  if (failed.length > ids.length * 0.05) {
    throw new Error(`too many element-summary failures: ${failed.length}/${ids.length}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
