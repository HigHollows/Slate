import { describe, expect, it } from 'vitest';
import { docStats } from './stats';
import { filterSlash } from './slashItems';

describe('statistiques du document', () => {
  it('vide', () => {
    expect(docStats('')).toEqual({
      words: 0,
      chars: 0,
      charsNoSpaces: 0,
      paragraphs: 0,
      lines: 0,
      readingMinutes: 0,
    });
    expect(docStats('  \n \n').words).toBe(0);
  });
  it('mots, apostrophes, accents, tirets, chiffres', () => {
    expect(docStats("L'été est là, c'est 2026 — très bien.").words).toBe(7);
    expect(docStats('porte-monnaie  x').words).toBe(2);
  });
  it('caractères, paragraphes, lignes', () => {
    const s = docStats('ab cd\n\nef');
    expect(s.chars).toBe(7);
    expect(s.charsNoSpaces).toBe(6);
    expect(s.paragraphs).toBe(2);
    expect(s.lines).toBe(3);
  });
  it('temps de lecture : au moins une minute, proportionnel ensuite', () => {
    expect(docStats('mot').readingMinutes).toBe(1);
    expect(docStats(Array(460).fill('mot').join(' ')).readingMinutes).toBe(2);
  });
  it('compte les emoji comme un caractère', () => {
    expect(docStats('a😀').chars).toBe(2);
  });
});

describe('menu / : titres 4 à 6 et surlignage', () => {
  it('sont proposés', () => {
    const t = (id: string) => id;
    for (const id of ['h4', 'h5', 'h6', 'highlight'])
      expect(filterSlash(id, t).map((i) => i.id)).toContain(id);
  });
});
