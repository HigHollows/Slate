/** Minuscules sans accents (comparaisons et recherches tolérantes). */
export const normalize = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
