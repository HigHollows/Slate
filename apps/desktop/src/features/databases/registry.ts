import type { IconName } from '@slate/icons';
import { normalize } from '../../shared/text';
import { optionsOf, type FilterOp, type Property, type PropertyType } from './types';

/** Définition d'un type de propriété : tout ce que le système doit savoir pour l'afficher, le comparer, le filtrer, le coller. */
export interface PropertyTypeDef {
  type: PropertyType;
  icon?: IconName;
  glyph?: string;
  /** La valeur se saisit à la main. */
  editable: boolean;
  /** La valeur est calculée (formule, identifiant, dates système) : jamais écrite par l'utilisateur. */
  computed: boolean;
  filterOps: FilterOp[];
  /** Valeur → texte (affichage de repli, copie dans le presse-papiers, recherche). */
  toText(v: unknown, p: Property, lookup?: (id: string) => string | undefined): string;
  /** Texte → valeur (collage, saisie). `undefined` = texte refusé. `null` = effacer. */
  fromText(text: string, p: Property, lookup?: (name: string) => string | undefined): unknown;
  compare(a: unknown, b: unknown, p: Property): number;
}

const empty = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const cmpNum = (a: unknown, b: unknown) => (a as number) - (b as number);
const cmpStr = (a: unknown, b: unknown) =>
  String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
const TEXT_OPS: FilterOp[] = [
  'contains',
  'notContains',
  'is',
  'isNot',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
];
const NUM_OPS: FilterOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'];
const DATE_OPS: FilterOp[] = [
  'is',
  'isNot',
  'before',
  'after',
  'onOrBefore',
  'onOrAfter',
  'isEmpty',
  'isNotEmpty',
];
const SEL_OPS: FilterOp[] = ['is', 'isNot', 'isEmpty', 'isNotEmpty'];
const MULTI_OPS: FilterOp[] = ['contains', 'notContains', 'isEmpty', 'isNotEmpty'];

const text = (type: PropertyType, validate?: (s: string) => boolean): PropertyTypeDef => ({
  type,
  editable: true,
  computed: false,
  filterOps: TEXT_OPS,
  toText: (v) => (typeof v === 'string' ? v : ''),
  fromText: (s) => {
    const t = type === 'longtext' ? s : s.trim();
    if (t === '') return null;
    return validate && !validate(t) ? undefined : t;
  },
  compare: cmpStr,
});

export function formatNumber(v: number, p: Property, locale?: string, percent = false): string {
  const decimals =
    typeof p.config['decimals'] === 'number' ? Math.min(8, Math.max(0, p.config['decimals'])) : 0;
  const body = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: Math.max(
      decimals,
      decimals === 0 && !Number.isInteger(v) ? 2 : decimals,
    ),
  }).format(v);
  const prefix = typeof p.config['prefix'] === 'string' ? p.config['prefix'] : '';
  const suffix = typeof p.config['suffix'] === 'string' ? p.config['suffix'] : '';
  return `${prefix}${body}${percent ? ' %' : ''}${suffix}`;
}

const parseNumber = (s: string): number | undefined => {
  const t = s.trim().replace(/\s/g, '').replace('%', '').replace(',', '.');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n) <= 1e15 ? n : undefined;
};

const optionName = (p: Property, id: unknown) => optionsOf(p).find((o) => o.id === id)?.name ?? '';

const REGISTRY: Record<PropertyType, PropertyTypeDef> = {
  title: { ...text('title'), type: 'title', glyph: 'Aa' },
  text: { ...text('text'), glyph: 'T' },
  longtext: { ...text('longtext'), glyph: '¶' },
  url: { ...text('url', (s) => /^https?:\/\/\S{3,}$/i.test(s)), icon: 'link' },
  email: { ...text('email', (s) => /^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(s)), icon: 'mail' },
  phone: { ...text('phone', (s) => /^[\d+\-.() ]+$/.test(s) && /\d/.test(s)), icon: 'phone' },
  number: {
    type: 'number',
    glyph: '#',
    editable: true,
    computed: false,
    filterOps: NUM_OPS,
    toText: (v) => (typeof v === 'number' ? String(v) : ''),
    fromText: (s) => (s.trim() === '' ? null : parseNumber(s)),
    compare: cmpNum,
  },
  percent: {
    type: 'percent',
    glyph: '%',
    editable: true,
    computed: false,
    filterOps: NUM_OPS,
    toText: (v) => (typeof v === 'number' ? String(v) : ''),
    fromText: (s) => (s.trim() === '' ? null : parseNumber(s)),
    compare: cmpNum,
  },
  checkbox: {
    type: 'checkbox',
    icon: 'check',
    editable: true,
    computed: false,
    filterOps: ['checked', 'unchecked'],
    toText: (v) => (v === true ? 'true' : 'false'),
    fromText: (s) => {
      const t = normalize(s.trim());
      if (['true', 'vrai', 'oui', 'yes', '1', 'x'].includes(t)) return true;
      if (['false', 'faux', 'non', 'no', '0', ''].includes(t)) return false;
      return undefined;
    },
    compare: (a, b) => Number(a === true) - Number(b === true),
  },
  date: {
    type: 'date',
    icon: 'calendar',
    editable: true,
    computed: false,
    filterOps: DATE_OPS,
    toText: (v) => (typeof v === 'string' ? v : ''),
    fromText: (s) => {
      const t = s.trim();
      if (t === '') return null;
      const fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
      const iso = fr ? `${fr[3]}-${fr[2]!.padStart(2, '0')}-${fr[1]!.padStart(2, '0')}` : t;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
      if (!m) return undefined;
      const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
      return d.getUTCFullYear() === +m[1]! &&
        d.getUTCMonth() === +m[2]! - 1 &&
        d.getUTCDate() === +m[3]!
        ? iso
        : undefined;
    },
    compare: cmpStr,
  },
  datetime: {
    type: 'datetime',
    icon: 'clock',
    editable: true,
    computed: false,
    filterOps: DATE_OPS,
    toText: (v) => (typeof v === 'string' ? v : ''),
    fromText: (s) => {
      const t = s.trim();
      if (t === '') return null;
      const ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(t) ? Date.parse(t) : NaN;
      return Number.isNaN(ms) ? undefined : t;
    },
    compare: cmpStr,
  },
  select: {
    type: 'select',
    icon: 'list',
    editable: true,
    computed: false,
    filterOps: SEL_OPS,
    toText: (v, p) => optionName(p, v),
    fromText: (s, p) => {
      const t = s.trim();
      if (t === '') return null;
      return optionsOf(p).find((o) => normalize(o.name) === normalize(t))?.id;
    },
    compare: (a, b, p) => {
      const o = optionsOf(p);
      return o.findIndex((x) => x.id === a) - o.findIndex((x) => x.id === b);
    },
  },
  status: {
    type: 'status',
    icon: 'tasks',
    editable: true,
    computed: false,
    filterOps: SEL_OPS,
    toText: (v, p) => optionName(p, v),
    fromText: (s, p) => {
      const t = s.trim();
      if (t === '') return null;
      return optionsOf(p).find((o) => normalize(o.name) === normalize(t))?.id;
    },
    compare: (a, b, p) => {
      const o = optionsOf(p);
      return o.findIndex((x) => x.id === a) - o.findIndex((x) => x.id === b);
    },
  },
  multiselect: {
    type: 'multiselect',
    icon: 'list',
    editable: true,
    computed: false,
    filterOps: MULTI_OPS,
    toText: (v, p) =>
      Array.isArray(v)
        ? v
            .map((id) => optionName(p, id))
            .filter(Boolean)
            .join(', ')
        : '',
    fromText: (s, p) => {
      if (s.trim() === '') return null;
      const ids: string[] = [];
      for (const part of s.split(/[,;]/)) {
        const id = optionsOf(p).find((o) => normalize(o.name) === normalize(part.trim()))?.id;
        if (!id) return undefined;
        if (!ids.includes(id)) ids.push(id);
      }
      return ids;
    },
    compare: (a, b, p) =>
      cmpStr(REGISTRY.multiselect.toText(a, p), REGISTRY.multiselect.toText(b, p)),
  },
  relation: {
    type: 'relation',
    icon: 'arrow-right-box',
    editable: true,
    computed: false,
    filterOps: MULTI_OPS,
    toText: (v, _p, lookup) =>
      Array.isArray(v)
        ? v
            .map((id) => lookup?.(String(id)) ?? '')
            .filter(Boolean)
            .join(', ')
        : '',
    fromText: (s, _p, lookup) => {
      if (s.trim() === '') return null;
      const ids: string[] = [];
      for (const part of s.split(/[,;]/)) {
        const id = lookup?.(part.trim());
        if (!id) return undefined;
        if (!ids.includes(id)) ids.push(id);
      }
      return ids;
    },
    compare: (a, b, p) => cmpStr(REGISTRY.relation.toText(a, p), REGISTRY.relation.toText(b, p)),
  },
  formula: {
    type: 'formula',
    glyph: 'ƒ',
    editable: false,
    computed: true,
    filterOps: [...TEXT_OPS, ...NUM_OPS, 'checked', 'unchecked'],
    toText: (v) => (v === null || v === undefined ? '' : String(v)),
    fromText: () => undefined,
    compare: (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : cmpStr(a, b)),
  },
  id: {
    type: 'id',
    glyph: 'ID',
    editable: false,
    computed: true,
    filterOps: NUM_OPS,
    toText: (v, p) =>
      typeof v === 'number'
        ? `${typeof p.config['prefix'] === 'string' ? p.config['prefix'] : ''}${v}`
        : '',
    fromText: () => undefined,
    compare: cmpNum,
  },
  created_time: {
    type: 'created_time',
    icon: 'clock',
    editable: false,
    computed: true,
    filterOps: DATE_OPS,
    toText: (v) => (typeof v === 'string' ? v : ''),
    fromText: () => undefined,
    compare: cmpStr,
  },
  last_edited_time: {
    type: 'last_edited_time',
    icon: 'clock',
    editable: false,
    computed: true,
    filterOps: DATE_OPS,
    toText: (v) => (typeof v === 'string' ? v : ''),
    fromText: () => undefined,
    compare: cmpStr,
  },
};

export const typeDef = (t: PropertyType): PropertyTypeDef => REGISTRY[t];
export const isEmptyValue = empty;
/** Types qu'un utilisateur peut choisir à la création d'une propriété (le titre existe d'office). */
export const CREATABLE_TYPES: PropertyType[] = [
  'text',
  'longtext',
  'number',
  'percent',
  'select',
  'multiselect',
  'status',
  'date',
  'datetime',
  'checkbox',
  'url',
  'email',
  'phone',
  'relation',
  'formula',
  'id',
  'created_time',
  'last_edited_time',
];
