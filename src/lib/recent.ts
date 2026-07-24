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
