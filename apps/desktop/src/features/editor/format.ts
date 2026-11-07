/**
 * Modèle de formatage du document (version de schéma 2).
 *
 * Principes :
 *  - le document stocke des VALEURS VALIDÉES (identifiants de palette, #rrggbb, identifiants de police, entiers) :
 *    jamais une chaîne CSS libre, jamais de HTML ;
 *  - les couleurs de palette sont des identifiants résolus par des variables CSS qui ont une variante claire et sombre ;
 *  - les couleurs personnalisées gardent leur #rrggbb, mais une classe de luminance permet d'éclaircir/assombrir
 *    à l'affichage pour qu'elles restent lisibles dans les deux thèmes.
 */

export type ColorKind = 'text' | 'highlight';

export const TEXT_COLORS = [
  'gray',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
] as const;
export const HIGHLIGHT_COLORS = ['yellow', 'gray', 'beige', 'pink', 'green', 'blue'] as const;

export const FONT_FAMILIES = ['sans', 'serif', 'mono', 'document'] as const;
export type FontFamilyId = (typeof FONT_FAMILIES)[number];

/** Piles de polices locales ou système : aucune police distante n'est chargée. */
export const FONT_STACKS: Record<FontFamilyId, string> = {
  sans: 'var(--font-ui)',
  serif: "ui-serif, 'New York', Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
  document: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
};

export const FONT_SIZES = [10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48] as const;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 96;

export const LINE_HEIGHTS = ['1', '1.15', '1.5', '2'] as const;
export const ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const;

const HEX = /^#[0-9a-f]{6}$/i;
const SHORT_HEX = /^#[0-9a-f]{3}$/i;

/** Normalise une couleur : identifiant de palette, ou #rrggbb en minuscules. `null` si invalide. */
export function sanitizeColor(value: unknown, kind: ColorKind): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  const palette: readonly string[] = kind === 'text' ? TEXT_COLORS : HIGHLIGHT_COLORS;
  if (palette.includes(v)) return v;
  if (HEX.test(v)) return v;
  if (SHORT_HEX.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return null;
}

export function sanitizeFontFamily(value: unknown): FontFamilyId | null {
  return typeof value === 'string' && (FONT_FAMILIES as readonly string[]).includes(value)
    ? (value as FontFamilyId)
    : null;
}

/** Taille en pixels entière dans [8, 96], sinon `null`. */
export function sanitizeFontSize(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= MIN_FONT_SIZE && r <= MAX_FONT_SIZE ? r : null;
}

export function sanitizeLineHeight(value: unknown): string | null {
  return typeof value === 'string' && (LINE_HEIGHTS as readonly string[]).includes(value)
    ? value
    : null;
}

/** Luminance relative WCAG d'un #rrggbb (0 = noir, 1 = blanc). */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/** Classe de luminance d'une couleur personnalisée : le CSS s'en sert pour garder le texte lisible dans les deux thèmes. */
export function luminanceClass(hex: string): 'low' | 'mid' | 'high' {
  const l = luminance(hex);
  return l < 0.12 ? 'low' : l > 0.6 ? 'high' : 'mid';
}

/** Valeur CSS d'une couleur validée. */
export function cssColor(value: string, kind: ColorKind): string {
  return HEX.test(value) ? value : `var(--doc-${kind}-${value})`;
}

// ── Conversion depuis du HTML collé (Word, Google Docs, sites) ───────────────────
export function parseCssColor(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (HEX.test(s) || SHORT_HEX.test(s)) return sanitizeColor(s, 'text');
  const m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(
    s,
  );
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
  if (r > 255 || g > 255 || b > 255) return null;
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return null; // transparent
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export function parseCssFontSize(v: string): number | null {
  const m = /^\s*([\d.]+)\s*(px|pt)\s*$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]!) * (m[2]!.toLowerCase() === 'pt' ? 96 / 72 : 1);
  return sanitizeFontSize(n);
}

export function parseCssFontFamily(v: string): FontFamilyId | null {
  const s = v.toLowerCase();
  if (/mono|courier|consolas|menlo/.test(s)) return 'mono';
  if (/georgia|times|garamond|palatino|serif/.test(s) && !/sans/.test(s)) return 'serif';
  if (/arial|helvetica|calibri|segoe|inter|sans/.test(s)) return 'sans';
  return null;
}

/** Couleurs de fond ignorées au collage : blanc/noir (artefacts de pages web), le surlignage reste un choix explicite. */
export function isNeutralBackground(hex: string): boolean {
  return ['#ffffff', '#000000', '#f5f4f0', '#090909'].includes(hex);
}
