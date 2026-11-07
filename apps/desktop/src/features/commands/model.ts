import type { IconName } from '@slate/icons';
import { normalize } from '../../shared/text';

export type CommandGroup = 'navigation' | 'view' | 'appearance' | 'language';

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  icon: IconName;
  defaultShortcut?: string;
  keywords?: string[];
  /** Commande de plomberie (ex. ouverture de la palette) : listée dans les raccourcis, absente de la palette. */
  hidden?: boolean;
  run(): void;
}

// ── Raccourcis ───────────────────────────────────────────────────────────
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph']);
const NAMED: Record<string, string> = { ' ': 'Space', Esc: 'Escape' };

/** Normalise un événement clavier en combinaison portable : `Mod+Shift+k`. `Mod` = ⌘ (macOS) ou Ctrl. */
export function eventToCombo(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  mac: boolean,
): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const mod = mac ? e.metaKey : e.ctrlKey;
  const ctrl = mac ? e.ctrlKey : false;
  if (!mac && e.metaKey) return null; // touche Windows : jamais liée
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else key = NAMED[key] ?? (key.length === 1 ? key.toLowerCase() : key);
  const parts = [
    mod && 'Mod',
    ctrl && 'Ctrl',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    key,
  ].filter(Boolean) as string[];
  return parts.join('+');
}

/** Une combinaison liable doit comporter Mod, Ctrl ou Alt (pas de lettre nue qui gênerait la saisie). */
export const isBindable = (combo: string): boolean => /^(Mod|Ctrl|Alt)\+./.test(combo);

/** Raccourcis du système/édition que Slate ne laisse pas réaffecter. */
export const RESERVED_COMBOS = [
  'Mod+c',
  'Mod+v',
  'Mod+x',
  'Mod+z',
  'Mod+Shift+z',
  'Mod+a',
  'Mod+q',
  'Mod+w',
  'Mod+s',
];

export type Overrides = Record<string, string | null>;

export function resolveBindings(
  commands: Pick<Command, 'id' | 'defaultShortcut'>[],
  overrides: Overrides,
): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const c of commands) {
    m.set(c.id, c.id in overrides ? (overrides[c.id] ?? null) : (c.defaultShortcut ?? null));
  }
  return m;
}

export type Conflict = { kind: 'command'; id: string } | { kind: 'reserved' };

export function findConflict(
  bindings: Map<string, string | null>,
  id: string,
  combo: string,
): Conflict | null {
  if (RESERVED_COMBOS.includes(combo)) return { kind: 'reserved' };
  for (const [other, c] of bindings)
    if (other !== id && c === combo) return { kind: 'command', id: other };
  return null;
}

// ── Recherche floue (insensible à la casse et aux accents) ───────────────

/** Score ≥ 0 si correspondance (plus haut = meilleur), -1 sinon. */
export function fuzzyScore(query: string, text: string): number {
  const q = normalize(query).trim();
  if (!q) return 0;
  const t = normalize(text);
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx * 10 - (t.length - q.length);
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return -1;
    gaps += f - ti;
    ti = f + 1;
  }
  return Math.max(0, 500 - gaps * 5);
}

export function searchCommands(commands: Command[], query: string): Command[] {
  if (!query.trim()) return commands;
  return commands
    .map((c) => ({
      c,
      s: Math.max(
        fuzzyScore(query, c.title),
        ...(c.keywords ?? []).map((k) => fuzzyScore(query, k) - 100),
      ),
    }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}
