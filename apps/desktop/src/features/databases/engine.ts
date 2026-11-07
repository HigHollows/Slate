/**
 * Moteur de requêtes des bases (pur, sans I/O) : valeurs calculées, filtres ET/OU imbriqués, tris multiples,
 * regroupements, agrégations. Toutes les vues interrogent ce même moteur sur les mêmes lignes.
 */
import {
  compile,
  evaluate,
  FormulaError,
  format,
  isDate,
  type CompiledFormula,
  type FDate,
  type Value,
} from '@slate/formula';
import { normalize } from '../../shared/text';
import { isEmptyValue, typeDef } from './registry';
import {
  optionsOf,
  type Aggregation,
  type FilterNode,
  type FilterRule,
  type Property,
  type Row,
  type ViewConfig,
} from './types';

export interface EngineContext {
  properties: Property[];
  /** Titre d'une ligne d'une base liée (relations) ; `undefined` si inconnue/supprimée. */
  relationTitle?: (rowId: string) => string | undefined;
  now?: () => number;
}

export type Computed = { ok: true; value: Value } | { ok: false; error: FormulaError };

const toFDate = (v: unknown, time: boolean): FDate | null => {
  if (typeof v !== 'string' || v === '') return null;
  const ms = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(ms) ? null : { t: 'date', ms, time };
};

/** Évaluateur de valeurs : lit une cellule, calcule les formules (avec détection de cycles et mémoïsation par ligne). */
export class Evaluator {
  private readonly byName = new Map<string, Property>();
  private readonly compiled = new Map<string, CompiledFormula | FormulaError>();
  /** Mémo par OBJET ligne (les lignes sont immuables : une modification crée un nouvel objet, donc invalide le calcul). */
  private readonly memo = new WeakMap<Row, Map<string, Computed>>();

  constructor(private readonly ctx: EngineContext) {
    for (const p of ctx.properties) this.byName.set(p.name.toLowerCase(), p);
    for (const p of ctx.properties) {
      if (p.type !== 'formula') continue;
      const src = typeof p.config['expression'] === 'string' ? p.config['expression'] : '';
      try {
        this.compiled.set(p.id, compile(src));
      } catch (e) {
        if (e instanceof FormulaError) this.compiled.set(p.id, e);
        else throw e;
      }
    }
  }

  /** Valeur brute d'une cellule (typée selon la propriété ; formule → résultat ou `null` en cas d'erreur). */
  raw(row: Row, p: Property): unknown {
    switch (p.type) {
      case 'title':
        return row.title;
      case 'created_time':
        return row.createdAt;
      case 'last_edited_time':
        return row.updatedAt;
      case 'formula': {
        const r = this.formula(row, p);
        return r.ok ? r.value : null;
      }
      default:
        return row.props[p.id] ?? null;
    }
  }

  /** Résultat d'une formule, ou l'erreur à afficher. */
  formula(row: Row, p: Property, stack: string[] = []): Computed {
    const perRow = this.memo.get(row) ?? new Map<string, Computed>();
    this.memo.set(row, perRow);
    const hit = perRow.get(p.id);
    if (hit) return hit;
    const c = this.compiled.get(p.id);
    let out: Computed;
    if (!c) out = { ok: true, value: null };
    else if (c instanceof FormulaError) out = { ok: false, error: c };
    else if (stack.includes(p.id))
      out = { ok: false, error: new FormulaError('cycle', 'Référence circulaire entre formules') };
    else {
      try {
        out = {
          ok: true,
          value: evaluate(c, {
            now: this.ctx.now ?? Date.now,
            prop: (name) => {
              const target = this.byName.get(name.toLowerCase());
              if (!target) throw new FormulaError('name', `Propriété inconnue : « ${name} »`);
              return this.asFormulaValue(row, target, [...stack, p.id]);
            },
          }),
        };
      } catch (e) {
        if (e instanceof FormulaError) out = { ok: false, error: e };
        else throw e;
      }
    }
    // Un résultat issu d'un cycle n'est mémoïsé que s'il n'est pas intermédiaire (évite les faux positifs).
    if (stack.length === 0) perRow.set(p.id, out);
    return out;
  }

  private asFormulaValue(row: Row, p: Property, stack: string[]): Value {
    switch (p.type) {
      case 'formula': {
        const r = this.formula(row, p, stack);
        if (!r.ok) throw r.error;
        return r.value;
      }
      case 'date':
        return toFDate(row.props[p.id], false);
      case 'datetime':
        return toFDate(row.props[p.id], true);
      case 'created_time':
        return toFDate(row.createdAt, true);
      case 'last_edited_time':
        return toFDate(row.updatedAt, true);
      case 'select':
      case 'status': {
        const id = row.props[p.id];
        return optionsOf(p).find((o) => o.id === id)?.name ?? null;
      }
      case 'multiselect': {
        const ids = row.props[p.id];
        return Array.isArray(ids)
          ? ids
              .map((i) => optionsOf(p).find((o) => o.id === i)?.name)
              .filter((x): x is string => !!x)
          : [];
      }
      case 'relation': {
        const ids = row.props[p.id];
        return Array.isArray(ids)
          ? ids.map((i) => this.ctx.relationTitle?.(String(i))).filter((x): x is string => !!x)
          : [];
      }
      case 'number':
      case 'percent':
      case 'id': {
        const v = this.raw(row, p);
        return typeof v === 'number' ? v : null;
      }
      case 'checkbox':
        return row.props[p.id] === true;
      default: {
        const v = this.raw(row, p);
        return typeof v === 'string' ? v : null;
      }
    }
  }

  /** Texte affiché/copiable d'une cellule. */
  text(row: Row, p: Property, locale = 'fr'): string {
    if (p.type === 'formula') {
      const r = this.formula(row, p);
      return r.ok ? format(r.value, locale) : '';
    }
    return typeDef(p.type).toText(this.raw(row, p), p, this.ctx.relationTitle);
  }
}

// ── Filtres ─────────────────────────────────────────────────────────────────────
export type DateFilterValue =
  { mode: 'exact'; date: string } | { mode: 'today' } | { mode: 'daysFromNow'; n: number };

const dayOf = (iso: string): string => iso.slice(0, 10);

function resolveDate(v: unknown, now: number): string | null {
  if (typeof v === 'string') return dayOf(v);
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Partial<DateFilterValue> & { date?: unknown; n?: unknown };
  const today = new Date(now - (((now % 86_400_000) + 86_400_000) % 86_400_000));
  if (o.mode === 'today') return today.toISOString().slice(0, 10);
  if (o.mode === 'daysFromNow' && typeof o.n === 'number')
    return new Date(today.getTime() + Math.trunc(o.n) * 86_400_000).toISOString().slice(0, 10);
  if (o.mode === 'exact' && typeof o.date === 'string') return dayOf(o.date);
  return null;
}

export function matchRule(
  rule: FilterRule,
  row: Row,
  p: Property | undefined,
  ev: Evaluator,
  now: number,
): boolean {
  if (!p) return true; // propriété supprimée : la règle est ignorée (jamais de résultat vide inexplicable)
  const v = ev.raw(row, p);
  const op = rule.op;
  if (op === 'isEmpty') return isEmptyValue(v);
  if (op === 'isNotEmpty') return !isEmptyValue(v);
  if (op === 'checked') return v === true;
  if (op === 'unchecked') return v !== true;
  const arg = rule.value;

  if (Array.isArray(v) || p.type === 'multiselect' || p.type === 'relation') {
    const list = Array.isArray(v) ? v : [];
    if (op === 'contains') return typeof arg === 'string' && list.includes(arg);
    if (op === 'notContains') return !(typeof arg === 'string' && list.includes(arg));
    return true;
  }
  if (p.type === 'select' || p.type === 'status') {
    if (op === 'is') return v === arg;
    if (op === 'isNot') return v !== arg;
    return true;
  }
  if (
    p.type === 'date' ||
    p.type === 'datetime' ||
    p.type === 'created_time' ||
    p.type === 'last_edited_time'
  ) {
    const cell = typeof v === 'string' ? dayOf(v) : null;
    const target = resolveDate(arg, now);
    if (cell === null || target === null) return op === 'isNot';
    switch (op) {
      case 'is':
        return cell === target;
      case 'isNot':
        return cell !== target;
      case 'before':
        return cell < target;
      case 'after':
        return cell > target;
      case 'onOrBefore':
        return cell <= target;
      case 'onOrAfter':
        return cell >= target;
      default:
        return true;
    }
  }
  if (
    typeof v === 'number' ||
    ((p.type === 'number' || p.type === 'percent' || p.type === 'id') && v === null)
  ) {
    const n =
      typeof arg === 'number'
        ? arg
        : typeof arg === 'string' && arg.trim() !== ''
          ? Number(arg.replace(',', '.'))
          : NaN;
    if (typeof v !== 'number' || Number.isNaN(n)) return op === 'neq';
    switch (op) {
      case 'eq':
        return v === n;
      case 'neq':
        return v !== n;
      case 'gt':
        return v > n;
      case 'gte':
        return v >= n;
      case 'lt':
        return v < n;
      case 'lte':
        return v <= n;
      default:
        return true;
    }
  }
  // Opérateur numérique sur une valeur non numérique (formule en erreur, texte) : aucune correspondance.
  if (op === 'eq' || op === 'neq' || op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte')
    return op === 'neq';
  // Texte (y compris résultats de formule textuels).
  const s = normalize(typeof v === 'string' ? v : v === null ? '' : String(v));
  const a = normalize(
    typeof arg === 'string' ? arg : arg === undefined || arg === null ? '' : String(arg),
  );
  switch (op) {
    case 'contains':
      return s.includes(a);
    case 'notContains':
      return !s.includes(a);
    case 'is':
      return s === a;
    case 'isNot':
      return s !== a;
    case 'startsWith':
      return s.startsWith(a);
    case 'endsWith':
      return s.endsWith(a);
    default:
      return false;
  }
}

export function matchFilter(
  node: FilterNode,
  row: Row,
  props: Map<string, Property>,
  ev: Evaluator,
  now: number,
): boolean {
  if (node.type === 'rule') return matchRule(node, row, props.get(node.propertyId), ev, now);
  if (node.children.length === 0) return true;
  return node.op === 'and'
    ? node.children.every((c) => matchFilter(c, row, props, ev, now))
    : node.children.some((c) => matchFilter(c, row, props, ev, now));
}

/** Nombre de règles actives (affichage d'un badge sur le bouton de filtre). */
export function countRules(node: FilterNode): number {
  return node.type === 'rule' ? 1 : node.children.reduce((n, c) => n + countRules(c), 0);
}

// ── Requête complète ────────────────────────────────────────────────────────────
export interface QueryResult {
  rows: Row[];
  /** Nombre de lignes avant filtre (pour « x sur y »). */
  total: number;
}

function compareValues(a: unknown, b: unknown, p: Property): number {
  if (p.type === 'formula') {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (isDate(a as Value) && isDate(b as Value)) return (a as FDate).ms - (b as FDate).ms;
    return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
  }
  return typeDef(p.type).compare(a, b, p);
}

export function queryRows(
  rows: Row[],
  config: ViewConfig,
  ctx: EngineContext,
  search = '',
  evaluator?: Evaluator,
): QueryResult {
  const ev = evaluator ?? new Evaluator(ctx);
  const now = (ctx.now ?? Date.now)();
  const props = new Map(ctx.properties.map((p) => [p.id, p]));
  const q = normalize(search.trim());
  const searchable =
    q === ''
      ? []
      : ctx.properties.filter(
          (p) => !typeDef(p.type).computed || p.type === 'formula' || p.type === 'id',
        );

  let out = rows;
  if (config.filter.children.length > 0)
    out = out.filter((r) => matchFilter(config.filter, r, props, ev, now));
  if (q !== '') {
    out = out.filter((r) => searchable.some((p) => normalize(ev.text(r, p)).includes(q)));
  }
  const sorts = config.sorts.filter((s) => props.has(s.propertyId));
  if (sorts.length > 0) {
    // Valeurs extraites une fois par ligne (évite de recalculer pendant le tri).
    const keyed = out.map((r, i) => ({
      r,
      i,
      k: sorts.map((s) => ev.raw(r, props.get(s.propertyId) as Property)),
    }));
    keyed.sort((x, y) => {
      for (let n = 0; n < sorts.length; n++) {
        const s = sorts[n] as (typeof sorts)[number];
        const p = props.get(s.propertyId) as Property;
        const a = x.k[n];
        const b = y.k[n];
        const ea = isEmptyValue(a);
        const eb = isEmptyValue(b);
        if (ea || eb) {
          if (ea && eb) continue;
          return ea ? 1 : -1; // les valeurs vides sont toujours en dernier, quel que soit le sens
        }
        const c = compareValues(a, b, p);
        if (c !== 0) return s.direction === 'asc' ? c : -c;
      }
      return x.i - y.i; // stable
    });
    out = keyed.map((k) => k.r);
  }
  return { rows: out, total: rows.length };
}

// ── Regroupement ────────────────────────────────────────────────────────────────
export interface Group {
  /** Identifiant de l'option / valeur ; `null` = « sans valeur ». */
  key: string | null;
  label: string;
  color?: string;
  rows: Row[];
}

export function groupRows(
  rows: Row[],
  p: Property,
  ev: Evaluator,
  labels: { none: string; yes: string; no: string },
): Group[] {
  const groups: Group[] = [];
  const index = new Map<string | null, Group>();
  const add = (key: string | null, label: string, color?: string) => {
    const g: Group = color ? { key, label, color, rows: [] } : { key, label, rows: [] };
    groups.push(g);
    index.set(key, g);
    return g;
  };
  if (p.type === 'select' || p.type === 'status' || p.type === 'multiselect') {
    for (const o of optionsOf(p)) add(o.id, o.name, o.color);
    add(null, labels.none);
    for (const r of rows) {
      const v = ev.raw(r, p);
      const ids = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
      const targets = ids.length
        ? ids.map((i) => index.get(String(i)) ?? index.get(null)!)
        : [index.get(null)!];
      for (const g of new Set(targets)) g.rows.push(r);
    }
    return groups;
  }
  if (p.type === 'checkbox') {
    add('true', labels.yes);
    add('false', labels.no);
    for (const r of rows) index.get(ev.raw(r, p) === true ? 'true' : 'false')!.rows.push(r);
    return groups;
  }
  // Valeurs libres : un groupe par valeur distincte (ordre d'apparition), « sans valeur » en dernier.
  const none = new Map<string | null, Group>();
  for (const r of rows) {
    const text = ev.text(r, p);
    const key = text === '' ? null : text;
    let g = key === null ? none.get(null) : index.get(key);
    if (!g) {
      g = key === null ? { key: null, label: labels.none, rows: [] } : add(key, text);
      if (key === null) none.set(null, g);
    }
    g.rows.push(r);
  }
  if (none.has(null)) groups.push(none.get(null)!);
  return groups;
}

// ── Agrégations ─────────────────────────────────────────────────────────────────
export function aggregate(rows: Row[], p: Property, fn: Aggregation, ev: Evaluator): number | null {
  if (fn === 'none') return null;
  const vals = rows.map((r) => ev.raw(r, p));
  const nums = vals.filter((v): v is number => typeof v === 'number');
  switch (fn) {
    case 'count':
      return rows.length;
    case 'countEmpty':
      return vals.filter(isEmptyValue).length;
    case 'countNotEmpty':
      return vals.filter((v) => !isEmptyValue(v)).length;
    case 'percentEmpty':
      return rows.length ? (vals.filter(isEmptyValue).length / rows.length) * 100 : null;
    case 'percentNotEmpty':
      return rows.length ? (vals.filter((v) => !isEmptyValue(v)).length / rows.length) * 100 : null;
    case 'checked':
      return vals.filter((v) => v === true).length;
    case 'percentChecked':
      return rows.length ? (vals.filter((v) => v === true).length / rows.length) * 100 : null;
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    case 'min':
      return nums.length ? Math.min(...nums) : null;
    case 'max':
      return nums.length ? Math.max(...nums) : null;
    case 'median': {
      if (!nums.length) return null;
      const s = [...nums].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
    }
    default:
      return null;
  }
}

/** Agrégations proposées selon le type de la propriété. */
export function aggregationsFor(p: Property): Aggregation[] {
  const base: Aggregation[] = [
    'none',
    'count',
    'countEmpty',
    'countNotEmpty',
    'percentEmpty',
    'percentNotEmpty',
  ];
  if (p.type === 'checkbox') return ['none', 'count', 'checked', 'percentChecked'];
  if (p.type === 'number' || p.type === 'percent' || p.type === 'id' || p.type === 'formula')
    return [...base, 'sum', 'avg', 'min', 'max', 'median'];
  return base;
}
