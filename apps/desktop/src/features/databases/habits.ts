/** Calculs d'habitudes à partir des seuls jours pointés (`AAAA-MM-JJ`). Fonctions pures, sans horloge implicite. */

const MS = 86_400_000;
const parse = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return fmt(parse(day) + n * MS);
}

/** Jour local (et non UTC) d'une date : « aujourd'hui » pour l'utilisateur. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Série en cours : jours consécutifs jusqu'à aujourd'hui, ou jusqu'à hier si aujourd'hui n'est pas encore pointé. */
export function currentStreak(days: ReadonlySet<string>, today: string): number {
  let d = days.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (days.has(d)) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

export function longestStreak(days: ReadonlySet<string>): number {
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

/** Nombre de jours pointés dans la fenêtre des `window` derniers jours, aujourd'hui inclus. */
export function countInWindow(days: ReadonlySet<string>, today: string, window: number): number {
  let n = 0;
  for (let i = 0; i < window; i++) if (days.has(addDays(today, -i))) n++;
  return n;
}

/** Taux de réussite (0 à 1) sur les `window` derniers jours. */
export function completionRate(days: ReadonlySet<string>, today: string, window = 30): number {
  return window > 0 ? countInWindow(days, today, window) / window : 0;
}

/** Objectif hebdomadaire atteint sur les 7 derniers jours (objectif borné à 1–7). */
export function weeklyGoalMet(days: ReadonlySet<string>, today: string, goal: number): boolean {
  const g = Math.min(7, Math.max(1, Math.round(goal)));
  return countInWindow(days, today, 7) >= g;
}
