/**
 * Calcul calendaire pur (sans dépendance), en jours « AAAA-MM-JJ ».
 * Fuseaux : une propriété `date` est un jour civil (aucune conversion) ; une propriété `datetime` est stockée en UTC
 * et placée dans le jour civil LOCAL de l'utilisateur. Déplacer une date-heure conserve son heure locale.
 */
export type Ymd = string;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const toYmd = (d: Date): Ymd =>
  `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const fromYmd = (s: Ymd): Date => new Date(`${s}T00:00:00Z`);
export const isYmd = (s: unknown): s is Ymd =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toYmd(fromYmd(s)) === s;

export function addDays(s: Ymd, n: number): Ymd {
  const d = fromYmd(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toYmd(d);
}

export function addMonths(s: Ymd, n: number): Ymd {
  const d = fromYmd(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return toYmd(d);
}

/** Lundi = 0 … dimanche = 6. */
export const weekdayIndex = (s: Ymd): number => (fromYmd(s).getUTCDay() + 6) % 7;
export const startOfWeek = (s: Ymd): Ymd => addDays(s, -weekdayIndex(s));
export const startOfMonth = (s: Ymd): Ymd => `${s.slice(0, 7)}-01`;

/** Grille d'un mois : semaines complètes (lundi→dimanche) couvrant le mois, 4 à 6 lignes. */
export function monthGrid(cursor: Ymd): Ymd[][] {
  const first = startOfMonth(cursor);
  const last = addDays(addMonths(first, 1), -1);
  const weeks: Ymd[][] = [];
  for (let d = startOfWeek(first); d <= last; d = addDays(d, 7))
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  return weeks;
}

export const weekDays = (cursor: Ymd): Ymd[] =>
  Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i));

/** Jour civil local d'un instant UTC. */
export function localYmd(iso: string): Ymd | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayLocal(now = Date.now()): Ymd {
  return localYmd(new Date(now).toISOString()) as Ymd;
}

/** Jour où afficher une valeur de propriété (`date` : tel quel ; `datetime` : jour local). */
export function dayOfValue(value: unknown, type: 'date' | 'datetime' | string): Ymd | null {
  if (typeof value !== 'string' || value === '') return null;
  if (type === 'datetime') return localYmd(value);
  return isYmd(value) ? value : null;
}

/** Valeur à enregistrer pour placer `value` sur le jour `day` (une date-heure garde son heure locale). */
export function moveValueToDay(
  value: unknown,
  type: 'date' | 'datetime' | string,
  day: Ymd,
  defaultHour = 9,
): string {
  if (type !== 'datetime') return day;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const prev = typeof value === 'string' ? new Date(value) : null;
  const hh = prev && !Number.isNaN(prev.getTime()) ? prev.getHours() : defaultHour;
  const mm = prev && !Number.isNaN(prev.getTime()) ? prev.getMinutes() : 0;
  return `${new Date(y, m - 1, d, hh, mm, 0).toISOString().slice(0, 19)}Z`;
}
