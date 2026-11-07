import { LIMITS, parse, type Ast, type Parsed } from './parser';
import { FormulaError, isDate, type FDate, type Value } from './types';

export interface EvalContext {
  /** Valeur d'une propriété par son nom (lève `FormulaError('name')` si inconnue). */
  prop(name: string): Value;
  /** Horloge injectable (tests) ; par défaut l'heure système. */
  now?: () => number;
}

export interface CompiledFormula extends Parsed {
  source: string;
}

export function compile(source: string): CompiledFormula {
  return { source, ...parse(source) };
}

type Fn = (args: Value[], c: Ctx) => Value;
interface Ctx {
  env: EvalContext;
  steps: number;
}

const err = (code: FormulaError['code'], m: string, pos?: number) => new FormulaError(code, m, pos);
const typeName = (v: Value) =>
  v === null
    ? 'vide'
    : Array.isArray(v)
      ? 'liste'
      : isDate(v)
        ? 'date'
        : typeof v === 'number'
          ? 'nombre'
          : typeof v === 'string'
            ? 'texte'
            : 'booléen';

const num = (v: Value, fn: string): number => {
  if (typeof v !== 'number') throw err('type', `${fn} attend un nombre (reçu : ${typeName(v)})`);
  return v;
};
const str = (v: Value, fn: string): string => {
  if (typeof v !== 'string') throw err('type', `${fn} attend un texte (reçu : ${typeName(v)})`);
  return v;
};
const bool = (v: Value, fn: string): boolean => {
  if (typeof v !== 'boolean') throw err('type', `${fn} attend un booléen (reçu : ${typeName(v)})`);
  return v;
};
const date = (v: Value, fn: string): FDate => {
  if (!isDate(v)) throw err('type', `${fn} attend une date (reçu : ${typeName(v)})`);
  return v;
};
const arity = (name: string, args: Value[], min: number, max = min) => {
  if (args.length < min || args.length > max) {
    throw err(
      'arity',
      `${name}() attend ${min === max ? min : `${min} à ${max === Infinity ? '…' : max}`} argument(s), reçu ${args.length}`,
    );
  }
};

/** Aplatit les arguments (les listes sont dépliées), pour sum/min/max. */
function flat(args: Value[]): Value[] {
  const out: Value[] = [];
  for (const a of args) {
    if (Array.isArray(a)) out.push(...flat(a));
    else out.push(a);
  }
  return out;
}
const numbers = (args: Value[], fn: string): number[] =>
  flat(args)
    .filter((v) => v !== null)
    .map((v) => num(v, fn));

const guardString = (s: string): string => {
  if (s.length > LIMITS.maxString) throw err('limit', 'Résultat texte trop long');
  return s;
};

export function format(v: Value, locale = 'fr'): string {
  if (v === null) return '';
  if (typeof v === 'number')
    return Number.isInteger(v)
      ? String(v)
      : new Intl.NumberFormat(locale, { maximumFractionDigits: 10 }).format(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => format(x, locale)).join(', ');
  return v.time
    ? new Date(v.ms).toISOString().slice(0, 16).replace('T', ' ')
    : new Date(v.ms).toISOString().slice(0, 10);
}

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};
function addUnits(d: FDate, n: number, unit: string): FDate {
  if (unit === 'months' || unit === 'years') {
    const x = new Date(d.ms);
    const months = unit === 'years' ? n * 12 : n;
    const day = x.getUTCDate();
    x.setUTCDate(1);
    x.setUTCMonth(x.getUTCMonth() + months);
    const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
    x.setUTCDate(Math.min(day, last));
    return { t: 'date', ms: x.getTime(), time: d.time };
  }
  const f = UNIT_MS[unit];
  if (f === undefined)
    throw err(
      'range',
      `Unité inconnue « ${unit} » (days, weeks, months, years, hours, minutes, seconds)`,
    );
  return { t: 'date', ms: d.ms + n * f, time: d.time || f < UNIT_MS['days']! };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Table des fonctions autorisées. `Map` : jamais de résolution via la chaîne de prototypes (constructor, __proto__…). */
const FUNCTIONS = new Map<string, Fn>([
  ['not', (a) => (arity('not', a, 1), !bool(a[0]!, 'not'))],
  ['and', (a) => a.every((x) => bool(x, 'and'))],
  ['or', (a) => a.some((x) => bool(x, 'or'))],
  [
    'empty',
    (a) => (
      arity('empty', a, 1),
      a[0] === null || a[0] === '' || (Array.isArray(a[0]) && a[0].length === 0)
    ),
  ],
  ['abs', (a) => (arity('abs', a, 1), Math.abs(num(a[0]!, 'abs')))],
  [
    'round',
    (a) => {
      arity('round', a, 1, 2);
      const d = a[1] === undefined ? 0 : Math.trunc(num(a[1], 'round'));
      if (d < 0 || d > 10) throw err('range', 'round : 0 à 10 décimales');
      const f = 10 ** d;
      return Math.round((num(a[0]!, 'round') + Number.EPSILON) * f) / f;
    },
  ],
  ['floor', (a) => (arity('floor', a, 1), Math.floor(num(a[0]!, 'floor')))],
  ['ceil', (a) => (arity('ceil', a, 1), Math.ceil(num(a[0]!, 'ceil')))],
  [
    'sqrt',
    (a) => {
      arity('sqrt', a, 1);
      const x = num(a[0]!, 'sqrt');
      if (x < 0) throw err('range', 'sqrt : nombre négatif');
      return Math.sqrt(x);
    },
  ],
  [
    'pow',
    (a) => {
      arity('pow', a, 2);
      const r = num(a[0]!, 'pow') ** num(a[1]!, 'pow');
      if (!Number.isFinite(r)) throw err('range', 'pow : résultat hors limites');
      return r;
    },
  ],
  [
    'mod',
    (a) => {
      arity('mod', a, 2);
      const d = num(a[1]!, 'mod');
      if (d === 0) throw err('range', 'Division par zéro');
      return num(a[0]!, 'mod') % d;
    },
  ],
  [
    'min',
    (a) => {
      const n = numbers(a, 'min');
      return n.length ? Math.min(...n) : null;
    },
  ],
  [
    'max',
    (a) => {
      const n = numbers(a, 'max');
      return n.length ? Math.max(...n) : null;
    },
  ],
  ['sum', (a) => numbers(a, 'sum').reduce((x, y) => x + y, 0)],
  [
    'mean',
    (a) => {
      const n = numbers(a, 'mean');
      return n.length ? n.reduce((x, y) => x + y, 0) / n.length : null;
    },
  ],
  ['count', (a) => flat(a).filter((v) => v !== null && v !== '').length],
  [
    'concat',
    (a) =>
      guardString(
        flat(a)
          .map((v) => format(v))
          .join(''),
      ),
  ],
  [
    'length',
    (a) => {
      arity('length', a, 1);
      const v = a[0]!;
      if (typeof v === 'string') return v.length;
      if (Array.isArray(v)) return v.length;
      if (v === null) return 0;
      throw err('type', `length attend un texte ou une liste (reçu : ${typeName(v)})`);
    },
  ],
  ['lower', (a) => (arity('lower', a, 1), str(a[0] ?? '', 'lower').toLowerCase())],
  ['upper', (a) => (arity('upper', a, 1), str(a[0] ?? '', 'upper').toUpperCase())],
  ['trim', (a) => (arity('trim', a, 1), str(a[0] ?? '', 'trim').trim())],
  [
    'contains',
    (a) => {
      arity('contains', a, 2);
      const [h, n] = a as [Value, Value];
      if (Array.isArray(h)) return h.some((x) => x === n);
      return str(h ?? '', 'contains')
        .toLowerCase()
        .includes(str(n ?? '', 'contains').toLowerCase());
    },
  ],
  [
    'startsWith',
    (a) => (
      arity('startsWith', a, 2),
      str(a[0] ?? '', 'startsWith').startsWith(str(a[1] ?? '', 'startsWith'))
    ),
  ],
  [
    'endsWith',
    (a) => (
      arity('endsWith', a, 2),
      str(a[0] ?? '', 'endsWith').endsWith(str(a[1] ?? '', 'endsWith'))
    ),
  ],
  [
    'replace',
    (a) => {
      arity('replace', a, 3);
      return guardString(
        str(a[0] ?? '', 'replace')
          .split(str(a[1] ?? '', 'replace'))
          .join(str(a[2] ?? '', 'replace')),
      );
    },
  ],
  [
    'slice',
    (a) => {
      arity('slice', a, 2, 3);
      return str(a[0] ?? '', 'slice').slice(
        num(a[1]!, 'slice'),
        a[2] === undefined ? undefined : num(a[2], 'slice'),
      );
    },
  ],
  [
    'join',
    (a) => {
      arity('join', a, 1, 2);
      const l = a[0];
      if (!Array.isArray(l))
        throw err('type', `join attend une liste (reçu : ${typeName(l ?? null)})`);
      return guardString(
        l.map((v) => format(v)).join(a[1] === undefined ? ', ' : str(a[1], 'join')),
      );
    },
  ],
  [
    'toNumber',
    (a) => {
      arity('toNumber', a, 1);
      const v = a[0]!;
      if (typeof v === 'number') return v;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'string') {
        const n = Number(v.trim().replace(',', '.'));
        if (v.trim() === '' || !Number.isFinite(n))
          throw err('type', `toNumber : « ${v} » n'est pas un nombre`);
        return n;
      }
      if (v === null) return null;
      throw err('type', `toNumber ne convertit pas ${typeName(v)}`);
    },
  ],
  ['format', (a) => (arity('format', a, 1), format(a[0]!))],
  ['now', (a, c) => (arity('now', a, 0), { t: 'date', ms: (c.env.now ?? Date.now)(), time: true })],
  [
    'today',
    (a, c) => {
      arity('today', a, 0);
      const n = (c.env.now ?? Date.now)();
      return { t: 'date', ms: n - (((n % 86_400_000) + 86_400_000) % 86_400_000), time: false };
    },
  ],
  [
    'dateAdd',
    (a) => (
      arity('dateAdd', a, 3),
      addUnits(date(a[0]!, 'dateAdd'), num(a[1]!, 'dateAdd'), str(a[2]!, 'dateAdd'))
    ),
  ],
  [
    'dateSubtract',
    (a) => (
      arity('dateSubtract', a, 3),
      addUnits(date(a[0]!, 'dateSubtract'), -num(a[1]!, 'dateSubtract'), str(a[2]!, 'dateSubtract'))
    ),
  ],
  [
    'dateBetween',
    (a) => {
      arity('dateBetween', a, 3);
      const d = date(a[0]!, 'dateBetween').ms - date(a[1]!, 'dateBetween').ms;
      const unit = str(a[2]!, 'dateBetween');
      const f = UNIT_MS[unit];
      if (f === undefined)
        throw err('range', `Unité inconnue « ${unit} » (days, weeks, hours, minutes, seconds)`);
      return Math.trunc(d / f);
    },
  ],
  ['year', (a) => (arity('year', a, 1), new Date(date(a[0]!, 'year').ms).getUTCFullYear())],
  ['month', (a) => (arity('month', a, 1), new Date(date(a[0]!, 'month').ms).getUTCMonth() + 1)],
  ['day', (a) => (arity('day', a, 1), new Date(date(a[0]!, 'day').ms).getUTCDate())],
  [
    'weekday',
    (a) => (
      arity('weekday', a, 1),
      ((new Date(date(a[0]!, 'weekday').ms).getUTCDay() + 6) % 7) + 1
    ),
  ], // 1 = lundi
  [
    'formatDate',
    (a) => {
      arity('formatDate', a, 1, 2);
      const d = new Date(date(a[0]!, 'formatDate').ms);
      const pattern = a[1] === undefined ? 'YYYY-MM-DD' : str(a[1], 'formatDate');
      return pattern
        .replace(/YYYY/g, pad(d.getUTCFullYear(), 4))
        .replace(/MM/g, pad(d.getUTCMonth() + 1))
        .replace(/DD/g, pad(d.getUTCDate()))
        .replace(/HH/g, pad(d.getUTCHours()))
        .replace(/mm/g, pad(d.getUTCMinutes()));
    },
  ],
  [
    'date',
    (a) => {
      arity('date', a, 1);
      const s = str(a[0]!, 'date');
      const ms = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?$/.test(s)
        ? Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s.endsWith('Z') ? s : `${s}Z`)
        : NaN;
      if (Number.isNaN(ms))
        throw err('range', `date : « ${s} » n'est pas une date valide (AAAA-MM-JJ)`);
      return { t: 'date', ms, time: s.length > 10 };
    },
  ],
  [
    'at',
    (a) => {
      arity('at', a, 2);
      const l = a[0];
      if (!Array.isArray(l)) throw err('type', 'at attend une liste');
      return l[Math.trunc(num(a[1]!, 'at'))] ?? null;
    },
  ],
]);

/** Fonctions à évaluation paresseuse : seules les branches nécessaires sont évaluées. */
const LAZY = new Set(['if', 'prop']);
export const FUNCTION_NAMES: readonly string[] = [...FUNCTIONS.keys(), ...LAZY].sort();

function cmp(a: Value, b: Value): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string')
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  if (isDate(a) && isDate(b)) return a.ms - b.ms;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  throw err('type', `Comparaison impossible entre ${typeName(a)} et ${typeName(b)}`);
}

function equals(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b;
  if (isDate(a) && isDate(b)) return a.ms === b.ms;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => equals(x, b[i] as Value))
    );
  return typeof a === typeof b && a === b;
}

function ev(n: Ast, c: Ctx): Value {
  if (++c.steps > LIMITS.maxSteps) throw err('limit', 'Formule trop longue à évaluer');
  switch (n.k) {
    case 'num':
    case 'str':
    case 'bool':
      return n.v;
    case 'null':
      return null;
    case 'un': {
      const v = ev(n.arg, c);
      return n.op === '-' ? -num(v, '-') : !bool(v, '!');
    }
    case 'bin': {
      if (n.op === '&&') return bool(ev(n.l, c), '&&') && bool(ev(n.r, c), '&&');
      if (n.op === '||') return bool(ev(n.l, c), '||') || bool(ev(n.r, c), '||');
      const l = ev(n.l, c);
      const r = ev(n.r, c);
      switch (n.op) {
        case '+':
          if (typeof l === 'number' && typeof r === 'number') return l + r;
          if (typeof l === 'string' && typeof r === 'string') return guardString(l + r);
          throw err(
            'type',
            `« + » ne s'applique pas à ${typeName(l)} et ${typeName(r)} : utilisez concat() pour assembler du texte`,
            n.pos,
          );
        case '-':
          return num(l, '-') - num(r, '-');
        case '*':
          return num(l, '*') * num(r, '*');
        case '/': {
          const d = num(r, '/');
          if (d === 0) throw err('range', 'Division par zéro', n.pos);
          return num(l, '/') / d;
        }
        case '%': {
          const d = num(r, '%');
          if (d === 0) throw err('range', 'Division par zéro', n.pos);
          return num(l, '%') % d;
        }
        case '==':
          return equals(l, r);
        case '!=':
          return !equals(l, r);
        case '<':
          return cmp(l, r) < 0;
        case '<=':
          return cmp(l, r) <= 0;
        case '>':
          return cmp(l, r) > 0;
        case '>=':
          return cmp(l, r) >= 0;
        default:
          throw err('syntax', `Opérateur inconnu ${n.op}`, n.pos);
      }
    }
    case 'call': {
      if (n.name === 'prop') return c.env.prop((n.args[0] as { v: string }).v);
      if (n.name === 'if') {
        if (n.args.length !== 3)
          throw err('arity', 'if() attend 3 arguments (condition, si vrai, si faux)', n.pos);
        return bool(ev(n.args[0] as Ast, c), 'if')
          ? ev(n.args[1] as Ast, c)
          : ev(n.args[2] as Ast, c);
      }
      const fn = FUNCTIONS.get(n.name);
      if (!fn) throw err('name', `Fonction inconnue : ${n.name}()`, n.pos);
      const args = n.args.map((a) => ev(a, c));
      return fn(args, c);
    }
  }
}

/** Évalue une formule compilée. Ne lève que des `FormulaError`. Limites : pas, profondeur, longueur des textes. */
export function evaluate(f: CompiledFormula, env: EvalContext): Value {
  try {
    return ev(f.ast, { env, steps: 0 });
  } catch (e) {
    if (e instanceof FormulaError) throw e;
    if (e instanceof RangeError) throw err('limit', 'Formule trop profonde');
    throw e; // bug réel : ne pas masquer
  }
}

export type Result = { ok: true; value: Value } | { ok: false; error: FormulaError };

export function run(source: string, env: EvalContext): Result {
  try {
    return { ok: true, value: evaluate(compile(source), env) };
  } catch (e) {
    if (e instanceof FormulaError) return { ok: false, error: e };
    throw e;
  }
}
