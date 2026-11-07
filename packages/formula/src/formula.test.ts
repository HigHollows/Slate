import { describe, expect, it } from 'vitest';
import {
  FormulaError,
  compile,
  evaluate,
  parse,
  run,
  LIMITS,
  FUNCTION_NAMES,
  type Value,
} from './index';

const NOW = Date.UTC(2026, 5, 15, 12, 30, 0); // 2026-06-15 12:30 UTC
const env = (props: Record<string, Value> = {}) => ({
  prop: (n: string): Value => {
    if (!Object.prototype.hasOwnProperty.call(props, n))
      throw new FormulaError('name', `Propriété inconnue : ${n}`);
    return props[n] as Value;
  },
  now: () => NOW,
});
const val = (src: string, props?: Record<string, Value>): Value => {
  const r = run(src, env(props));
  if (!r.ok) throw r.error;
  return r.value;
};
const fails = (src: string, code?: string, props?: Record<string, Value>) => {
  const r = run(src, env(props));
  expect(r.ok, `« ${src} » devait échouer`).toBe(false);
  if (!r.ok && code) expect(r.error.code, r.error.message).toBe(code);
};

describe('arithmétique et priorités', () => {
  it('opérateurs, parenthèses, unaires', () => {
    expect(val('1 + 2 * 3')).toBe(7);
    expect(val('(1 + 2) * 3')).toBe(9);
    expect(val('10 - 4 - 3')).toBe(3);
    expect(val('-2 * -3')).toBe(6);
    expect(val('7 % 4')).toBe(3);
    expect(val('1.5 + .5')).toBe(2);
    expect(val('1e3')).toBe(1000);
    expect(val('2 > 1 && 3 >= 3 || false')).toBe(true);
    expect(val('!(1 == 2)')).toBe(true);
  });
  it('division par zéro et types : erreurs claires, jamais NaN/Infinity', () => {
    fails('1 / 0', 'range');
    fails('5 % 0', 'range');
    fails('mod(1, 0)', 'range');
    fails('1 + "a"', 'type');
    fails('"a" - 1', 'type');
    fails('1 && true', 'type');
    fails('pow(10, 1000)', 'range');
    fails('sqrt(-1)', 'range');
  });
  it('comparaisons strictes entre types identiques', () => {
    expect(val('"a" == "a"')).toBe(true);
    expect(val('1 == "1"')).toBe(false);
    expect(val('"Abc" == "abc"')).toBe(false);
    expect(val('"b" > "a"')).toBe(true);
    fails('1 < "a"', 'type');
  });
});

describe('fonctions', () => {
  it('logique et condition paresseuse', () => {
    expect(val('if(true, 1, 2)')).toBe(1);
    expect(val('true ? "oui" : "non"')).toBe('oui');
    expect(val('if(false, 1/0, 5)')).toBe(5); // la branche non prise n'est pas évaluée
    expect(val('and(true, 1 < 2)')).toBe(true);
    expect(val('or(false, false)')).toBe(false);
    expect(val('not(false)')).toBe(true);
    expect(val('false && (1/0 > 1)')).toBe(false); // court-circuit
    fails('if(1, 2, 3)', 'type');
    fails('if(true, 2)', 'arity');
  });
  it('nombres', () => {
    expect(val('round(2.456, 2)')).toBe(2.46);
    expect(val('round(2.5)')).toBe(3);
    expect(val('floor(2.9) + ceil(2.1)')).toBe(5);
    expect(val('abs(-4)')).toBe(4);
    expect(val('sum(1, 2, 3)')).toBe(6);
    expect(val('min(3, 1, 2)')).toBe(1);
    expect(val('max(prop("l"))', { l: [4, 9, 2] })).toBe(9);
    expect(val('mean(2, 4)')).toBe(3);
    expect(val('min()')).toBeNull();
    expect(val('count("a", "", null, 1)')).toBe(2);
  });
  it('texte', () => {
    expect(val('concat("a", 1, true)')).toBe('a1true');
    expect(val('upper("é") + lower("ÀB")')).toBe('Éàb');
    expect(val('length("héllo")')).toBe(5);
    expect(val('contains("Bonjour", "JOUR")')).toBe(true);
    expect(val('replace("a-b-c", "-", "+")')).toBe('a+b+c');
    expect(val('slice("abcdef", 1, 3)')).toBe('bc');
    expect(val('trim("  x ")')).toBe('x');
    expect(val('join(prop("t"), " / ")', { t: ['a', 'b'] })).toBe('a / b');
    expect(val('toNumber("3,5")')).toBe(3.5);
    fails('toNumber("abc")', 'type');
    expect(val('startsWith("abc", "ab") && endsWith("abc", "bc")')).toBe(true);
    expect(val('"a\\"b\\n"')).toBe('a"b\n');
  });
  it('listes', () => {
    expect(val('length(prop("l"))', { l: [1, 2, 3] })).toBe(3);
    expect(val('contains(prop("l"), "x")', { l: ['x', 'y'] })).toBe(true);
    expect(val('at(prop("l"), 1)', { l: ['x', 'y'] })).toBe('y');
    expect(val('empty(prop("l"))', { l: [] })).toBe(true);
    expect(val('empty(prop("v"))', { v: null })).toBe(true);
    expect(val('length(prop("v"))', { v: null })).toBe(0);
  });
  it('dates (UTC, horloge injectée)', () => {
    expect(val('formatDate(now(), "YYYY-MM-DD HH:mm")')).toBe('2026-06-15 12:30');
    expect(val('formatDate(today())')).toBe('2026-06-15');
    expect(val('formatDate(dateAdd(date("2024-01-31"), 1, "months"))')).toBe('2024-02-29');
    expect(val('formatDate(dateAdd(date("2026-06-15"), 2, "weeks"))')).toBe('2026-06-29');
    expect(val('formatDate(dateSubtract(date("2026-03-01"), 1, "days"))')).toBe('2026-02-28');
    expect(val('dateBetween(date("2026-06-20"), date("2026-06-15"), "days")')).toBe(5);
    expect(val('year(date("2026-06-15")) * 100 + month(date("2026-06-15"))')).toBe(202606);
    expect(val('weekday(date("2026-06-15"))')).toBe(1); // lundi
    expect(val('date("2026-06-15") < date("2026-06-16")')).toBe(true);
    expect(val('date("2026-06-15") == date("2026-06-15")')).toBe(true);
    fails('date("15/06/2026")', 'range');
    fails('dateAdd(date("2026-01-01"), 1, "siècles")', 'range');
    fails('year("2026")', 'type');
  });
  it('propriétés : lecture, absence, valeurs vides', () => {
    expect(val('prop("Prix") * prop("Qté")', { Prix: 4, Qté: 3 })).toBe(12);
    expect(val('prop("Nom") + "!"', { Nom: 'A' })).toBe('A!');
    fails('prop("Inconnue")', 'name');
    fails('prop(1)', 'syntax');
    fails('prop("a", "b")', 'syntax');
    expect(val('if(empty(prop("x")), "vide", "plein")', { x: null })).toBe('vide');
  });
});

describe('syntaxe', () => {
  it('erreurs de syntaxe positionnées', () => {
    for (const bad of [
      '',
      '   ',
      '1 +',
      '(1',
      '1)',
      '1 2',
      'foo',
      'sum(1,',
      '"abc',
      '#',
      '1 ? 2',
      ',',
      '@x',
    ]) {
      const r = run(bad, env());
      expect(r.ok, bad).toBe(false);
    }
    const r = run('1 + #', env());
    expect(!r.ok && r.error.position).toBe(4);
  });
  it('references extraites', () => {
    expect(parse('prop("A") + prop("B") + prop("A")').refs).toEqual(['A', 'B']);
  });
  it('insensible à la casse pour true/false/null mais pas pour les fonctions', () => {
    expect(val('TRUE && False == false')).toBe(true);
    fails('SUM(1)', 'name');
  });
  it('liste blanche documentée', () => {
    expect(FUNCTION_NAMES).toContain('dateBetween');
    expect(FUNCTION_NAMES).not.toContain('eval');
  });
});

describe('sécurité : aucune exécution de code', () => {
  const attacks = [
    'constructor("return 1")()',
    '__proto__',
    'prop("__proto__")',
    'prop("constructor")',
    'toString()',
    'hasOwnProperty("x")',
    'Function("return process")()',
    'eval("1")',
    'globalThis',
    'window.alert(1)',
    'this',
    'process.exit()',
    'import("x")',
    '`${1}`',
    '[].constructor',
    '1..constructor',
  ];
  it.each(attacks)('refuse %s', (src) => {
    const r = run(src, env());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(FormulaError);
  });
  it('les noms hérités du prototype ne sont pas des fonctions', () => {
    for (const n of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])
      fails(`${n}()`, 'name');
  });
  it("n'utilise ni eval ni Function dans le code du paquet", async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('./', import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const code = readFileSync(new URL(f, dir), 'utf8')
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
        .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
      expect(code, f).not.toMatch(/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/);
    }
  });
});

describe('limites de ressources', () => {
  it('expression trop longue, trop profonde, trop grosse', () => {
    expect(() => compile('1+'.repeat(1500) + '1')).toThrow(FormulaError);
    expect(() => compile('('.repeat(5000) + '1' + ')'.repeat(5000))).toThrow(FormulaError);
    expect(() => compile('-'.repeat(1000) + '1')).toThrow(FormulaError);
    const many = Array.from({ length: LIMITS.maxNodes + 10 }, () => '1').join('+');
    expect(many.length).toBeLessThan(LIMITS.maxLength);
    expect(() => compile(many)).toThrow(FormulaError);
  });
  it('profondeur: erreur « limit », jamais de dépassement de pile', () => {
    const r = run('('.repeat(3000) + '1' + ')'.repeat(3000), env());
    expect(!r.ok && r.error.code).toBe('limit');
  });
  it('croissance de texte bornée', () => {
    let e = '"aaaaaaaaaa"';
    for (let i = 0; i < 12; i++) e = `concat(${e}, ${e})`;
    const r = run(e, env());
    expect(r.ok).toBe(false);
  });
  it('évaluation bornée en pas et en temps', () => {
    const src = Array.from({ length: 200 }, () => '1').join('+');
    const t0 = performance.now();
    expect(val(src)).toBe(200);
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it('compilation une fois, évaluation de 50 000 lignes rapide', () => {
    const f = compile('prop("a") * prop("b") + if(prop("c"), 1, 0)');
    const t0 = performance.now();
    let s = 0;
    for (let i = 0; i < 50_000; i++) {
      const v = evaluate(f, { prop: (n) => (n === 'a' ? i : n === 'b' ? 2 : i % 2 === 0) });
      s += v as number;
    }
    expect(s).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('fuzzing : seules des FormulaError peuvent sortir', () => {
  let seed = 123456789;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
  const ATOMS = [
    '1',
    '2.5',
    '"x"',
    "'y'",
    'true',
    'null',
    'prop("a")',
    'prop("l")',
    'now()',
    'date("2026-01-01")',
    '(',
    ')',
    ',',
    '+',
    '-',
    '*',
    '/',
    '%',
    '==',
    '!=',
    '<',
    '>=',
    '&&',
    '||',
    '!',
    '?',
    ':',
    ...FUNCTION_NAMES.map((n) => n + '('),
    'foo',
    '"',
    '\\',
    '\u0000',
    'é',
    '.5',
    '1e999',
  ];
  it('10 000 expressions aléatoires', () => {
    const props = { a: 3, l: [1, 'x', null] as Value[] };
    for (let i = 0; i < 10_000; i++) {
      const n = 1 + Math.floor(rnd() * 14);
      const src = Array.from({ length: n }, () => pick(ATOMS)).join(rnd() < 0.5 ? ' ' : '');
      try {
        const r = run(src, env(props));
        if (r.ok && typeof r.value === 'number') expect(Number.isNaN(r.value)).toBe(false);
      } catch (e) {
        throw new Error(`fuite non contrôlée pour « ${src} » : ${String(e)}`);
      }
    }
  });
  it('chaînes aléatoires de caractères', () => {
    const chars = '()"\'+-*/%<>=!&|?:,. \tabcXYZ019\\é€\n';
    for (let i = 0; i < 5000; i++) {
      const src = Array.from(
        { length: 1 + Math.floor(rnd() * 40) },
        () => chars[Math.floor(rnd() * chars.length)],
      ).join('');
      try {
        run(src, env({ a: 1 }));
      } catch (e) {
        throw new Error(`fuite non contrôlée pour ${JSON.stringify(src)} : ${String(e)}`);
      }
    }
  });
});
