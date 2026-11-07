import type { Preferences } from './model';

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Couleur de texte (blanc ou quasi-noir) offrant le meilleur contraste sur l'accent choisi. */
export function accentForeground(accent: string): '#ffffff' | '#0a0a0a' {
  return contrastRatio(accent, '#ffffff') >= contrastRatio(accent, '#0a0a0a')
    ? '#ffffff'
    : '#0a0a0a';
}

export function resolveTheme(
  theme: Preferences['theme'],
  systemPrefersDark: boolean,
): 'light' | 'dark' {
  return theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : theme;
}

export function applyPreferences(
  p: Preferences,
  systemPrefersDark: boolean,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset['theme'] = resolveTheme(p.theme, systemPrefersDark);
  root.dataset['density'] = p.density;
  root.dataset['font'] = p.font;
  root.dataset['taskStrike'] = String(p.taskStrike);
  if (p.accent === 'auto') {
    // L'accent suit le thème (encre) : on retire toute surcharge.
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-fg');
  } else {
    root.style.setProperty('--accent', p.accent);
    root.style.setProperty('--accent-fg', accentForeground(p.accent));
  }
  root.style.fontSize = `${16 * p.fontScale}px`;
}
