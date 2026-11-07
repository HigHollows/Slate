import { describe, expect, it } from 'vitest';
import { MAX_DIFF_LINES, diffLines, diffSummary } from './diff';

const kinds = (a: string, b: string) => diffLines(a, b)!.map((o) => `${o.kind[0]}:${o.text}`);

describe('différence entre versions', () => {
  it('identique, vide, ajout, suppression, remplacement', () => {
    expect(kinds('a\nb', 'a\nb')).toEqual(['s:a', 's:b']);
    expect(kinds('', '')).toEqual([]);
    expect(kinds('', 'x')).toEqual(['a:x']);
    expect(kinds('x', '')).toEqual(['d:x']);
    expect(kinds('a\nb\nc', 'a\nB\nc')).toEqual(['s:a', 'd:b', 'a:B', 's:c']);
    expect(kinds('a\nc', 'a\nb\nc')).toEqual(['s:a', 'a:b', 's:c']);
  });
  it('reconstitue exactement les deux textes (propriété)', () => {
    const rnd = (seed: number) => () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const r = rnd(42);
    for (let k = 0; k < 200; k++) {
      const gen = () =>
        Array.from({ length: Math.floor(r() * 12) }, () => 'abcd'[Math.floor(r() * 4)]).join('\n');
      const a = gen();
      const b = gen();
      const ops = diffLines(a, b)!;
      expect(
        ops
          .filter((o) => o.kind !== 'add')
          .map((o) => o.text)
          .join('\n'),
      ).toBe(a);
      expect(
        ops
          .filter((o) => o.kind !== 'del')
          .map((o) => o.text)
          .join('\n'),
      ).toBe(b);
    }
  });
  it('résumé et limite de taille', () => {
    expect(diffSummary(diffLines('a\nb', 'a\nc\nd')!)).toEqual({ added: 2, removed: 1 });
    const big = Array(MAX_DIFF_LINES + 1)
      .fill('x')
      .join('\n');
    expect(diffLines(big, 'y')).toBeNull();
  });
});
