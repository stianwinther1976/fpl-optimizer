// Recently viewed teams — so "I don't remember my ID" is a one-tap fix.
// Stored locally on the device (no accounts, no backend).

export interface RecentTeam {
  id: number;
  name: string; // team name
  manager: string;
  at: number;
}

const KEY = "fpl-recent-teams";
const MAX = 5;

export function getRecentTeams(): RecentTeam[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as RecentTeam[];
    return Array.isArray(list) ? list.filter((t) => t && t.id > 0 && t.name) : [];
  } catch {
    return [];
  }
}

export function saveRecentTeam(t: Omit<RecentTeam, "at">): void {
  try {
    const list = getRecentTeams().filter((x) => x.id !== t.id);
    list.unshift({ ...t, at: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {}
}

/**
 * Drop one team from the list, and hand back what is left.
 *
 * IT RETURNS THE NEW LIST RATHER THAN VOID, on purpose. `getRecentTeams` reads
 * and re-parses storage, so a caller that removed and then re-read would be
 * trusting a second read to agree with the first — and in the one case that
 * matters, a `setItem` that threw on a full or blocked store, it would not.
 * Returning the list the caller is about to render keeps the screen and the
 * storage telling the same story even when the write fails.
 *
 * Removal is not a deletion in any lasting sense: this list is a convenience
 * cache of ids the reader has typed, and opening the team again re-adds it.
 * Nothing about the team, its history or its saved line-up calls is touched.
 */
export function removeRecentTeam(id: number): RecentTeam[] {
  const left = getRecentTeams().filter((t) => t.id !== id);
  try {
    if (left.length > 0) localStorage.setItem(KEY, JSON.stringify(left));
    // An empty array round-trips fine, but leaving `[]` behind means every
    // later visit parses a value that means nothing. Drop the key instead.
    else localStorage.removeItem(KEY);
  } catch {}
  return left;
}
