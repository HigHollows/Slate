import { z } from 'zod';

/** Identité monochrome : l'accent est l'encre (« auto » = noir en clair, blanc cassé en sombre) ou un gris. */
export const ACCENT_PRESETS = [
  { id: 'ink', hex: 'auto' },
  { id: 'graphite', hex: '#4a4a46' },
  { id: 'stone', hex: '#8a8984' },
  { id: 'ash', hex: '#b9b8b2' },
] as const;

export const READING_WIDTHS = ['narrow', 'normal', 'wide', 'full'] as const;
export const FONT_SCALES = [0.9, 1, 1.1, 1.2] as const;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const preferencesSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  accent: z.union([z.literal('auto'), hex]),
  density: z.enum(['comfortable', 'compact']),
  fontScale: z.number().min(0.8).max(1.4),
  font: z.enum(['inter', 'system', 'serif']),
  locale: z.enum(['auto', 'fr', 'en']),
  sidebarCollapsed: z.boolean(),
  sidebarWidth: z.number().int().min(200).max(420),
  readingWidth: z.enum(READING_WIDTHS),
  taskStrike: z.boolean(),
  toolbarCollapsed: z.boolean(),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export type PreferenceKey = keyof Preferences;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  accent: ACCENT_PRESETS[0].hex,
  density: 'comfortable',
  fontScale: 1,
  font: 'inter',
  locale: 'auto',
  sidebarCollapsed: false,
  sidebarWidth: 256,
  readingWidth: 'normal',
  taskStrike: true,
  toolbarCollapsed: false,
};

/** Clé de stockage SQLite (kebab-case, préfixe `pref.` accepté par le cœur Rust). */
export const storageKey = (k: PreferenceKey): string =>
  'pref.' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

const shape = preferencesSchema.shape;

/** Reconstruit les préférences depuis les lignes stockées ; toute valeur invalide retombe sur le défaut. */
export function parsePreferences(rows: { key: string; valueJson: string }[]): {
  prefs: Preferences;
  invalidKeys: string[];
} {
  const prefs: Preferences = { ...DEFAULT_PREFERENCES };
  const invalidKeys: string[] = [];
  const byKey = new Map(rows.map((r) => [r.key, r.valueJson]));
  for (const name of Object.keys(shape) as PreferenceKey[]) {
    const raw = byKey.get(storageKey(name));
    if (raw === undefined) continue;
    try {
      const parsed = shape[name].safeParse(JSON.parse(raw));
      if (parsed.success) (prefs[name] as unknown) = parsed.data;
      else invalidKeys.push(storageKey(name));
    } catch {
      invalidKeys.push(storageKey(name));
    }
  }
  return { prefs, invalidKeys };
}

export function validatePatch(patch: Partial<Preferences>): Partial<Preferences> {
  const out: Partial<Preferences> = {};
  for (const name of Object.keys(patch) as PreferenceKey[]) {
    const r = shape[name].safeParse(patch[name]);
    if (!r.success) throw new Error(`préférence invalide : ${name}`);
    (out[name] as unknown) = r.data;
  }
  return out;
}
