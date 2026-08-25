// What a manager needs to know before the next deadline, as FACTS.
//
// Deliberately NOT a transfer recommendation. Ranking moves is the model's job
// — `planHorizon` in the app, which needs the projection, the price pool and
// the whole squad state — and a watcher that guessed at it would be a second,
// worse optimizer disagreeing with the first. What this reports is the set of
// things that make a transfer NECESSARY, each of which is a published field:
//
//   - how long until the deadline;
//   - anyone in the squad FPL has flagged: injured, suspended, doubtful, or
//     with a chance-of-playing below 100;
//   - anyone whose price moved this gameweek, in either direction;
//   - free transfers and money in the bank.
//
// It prints "QUIET" when none of that applies, so the caller can stay silent
// rather than sending a notification that says nothing.
//
// FPL_ENTRY_ID selects the team. Without it only the deadline half runs.

const BASE = "https://fantasy.premierleague.com/api";

async function get(path) {
  const res = await fetch(`${BASE}/${path}`, {
    headers: {
      "User-Agent": "fpl-optimizer deadline watch (personal, non-commercial)",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const ct = res.headers.get("content-type") ?? "";
  return { ok: res.ok, status: res.status, body: res.ok && ct.includes("json") ? await res.json() : null };
}

const hours = (ms) => Math.floor(ms / 3_600_000);

async function main() {
  const now = Date.now();
  const boot = await get("bootstrap-static/");
  if (!boot.ok || !boot.body) return console.log(`bootstrap failed: ${boot.status}`);

  const next = boot.body.events.find((e) => Date.parse(e.deadline_time) > now);
  if (!next) return console.log("no deadline ahead — season over");
  const untilMs = Date.parse(next.deadline_time) - now;
  const h = hours(untilMs);
  console.log(`NEXT DEADLINE: GW${next.id} at ${next.deadline_time} (${Math.floor(h / 24)}d ${h % 24}h away)`);

  const id = process.env.FPL_ENTRY_ID;
  if (!id) {
    console.log("no FPL_ENTRY_ID set — deadline only, no squad check");
    console.log(h <= 72 ? "STATUS: DEADLINE_NEAR" : "STATUS: QUIET");
    return;
  }

  // The squad to act on is the CURRENT gameweek's picks; `is_current` is the
  // one FPL flags, and before the first deadline there are none at all.
  const current = boot.body.events.find((e) => e.is_current)?.id;
  const picks = current == null ? { ok: false, status: 0 } : await get(`entry/${id}/event/${current}/picks/`);
  const entry = await get(`entry/${id}/`);
  if (!picks.ok || !entry.ok) {
    console.log(`entry ${id}: entry ${entry.status}, picks ${picks.status} — squad check skipped`);
    console.log(h <= 72 ? "STATUS: DEADLINE_NEAR" : "STATUS: QUIET");
    return;
  }

  const byId = new Map(boot.body.elements.map((e) => [e.id, e]));
  const teams = new Map(boot.body.teams.map((t) => [t.id, t.short_name]));
  const flagged = [];
  const priced = [];
  for (const pk of picks.body.picks ?? []) {
    const el = byId.get(pk.element);
    if (!el) continue;
    const who = `${el.web_name} (${teams.get(el.team) ?? "?"})`;
    // `status` 'a' is available; anything else is FPL saying something.
    const chance = el.chance_of_playing_next_round;
    if (el.status !== "a" || (chance != null && chance < 100)) {
      flagged.push(`${who}: status ${el.status}${chance != null ? `, ${chance}% chance` : ""}${el.news ? ` — ${el.news}` : ""}`);
    }
    if (el.cost_change_event !== 0) {
      priced.push(`${who}: ${el.cost_change_event > 0 ? "+" : ""}${(el.cost_change_event / 10).toFixed(1)}m this gameweek`);
    }
  }

  const eh = picks.body.entry_history ?? {};
  console.log(
    `SQUAD ${id}: ${entry.body.name} — bank £${((eh.bank ?? 0) / 10).toFixed(1)}m, ` +
      `${boot.body.events.find((e) => e.id === next.id)?.id === next.id ? "" : ""}` +
      `free transfers unknown from this endpoint (the app computes them)`
  );
  console.log(flagged.length ? "FLAGGED:" : "FLAGGED: none");
  for (const f of flagged) console.log(`  ${f}`);
  console.log(priced.length ? "PRICE MOVES:" : "PRICE MOVES: none");
  for (const p of priced) console.log(`  ${p}`);

  const worth = flagged.length > 0 || priced.length > 0 || h <= 72;
  console.log(`STATUS: ${worth ? "SPEAK" : "QUIET"}`);
}

main().catch((e) => console.log(`watch failed: ${e?.message ?? e}`));
