import { z } from 'zod';
import type { DbRow, PropertyRow } from '../../shared/ipc/client';

export const PROPERTY_TYPES = [
  'title',
  'text',
  'longtext',
  'number',
  'percent',
  'date',
  'datetime',
  'checkbox',
  'select',
  'multiselect',
  'status',
  'url',
  'email',
  'phone',
  'relation',
  'formula',
  'id',
  'created_time',
  'last_edited_time',
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const OPTION_COLORS = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];
export const STATUS_GROUPS = ['todo', 'doing', 'done'] as const;

export const optionSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.enum(OPTION_COLORS).catch('gray'),
  group: z.enum(STATUS_GROUPS).optional(),
});
export type SelectOption = z.infer<typeof optionSchema>;

export interface Property {
  id: string;
  databaseId: string;
  name: string;
  type: PropertyType;
  config: Record<string, unknown>;
  position: string;
}

export function toProperty(p: PropertyRow): Property {
  const type = (PROPERTY_TYPES as readonly string[]).includes(p.type)
    ? (p.type as PropertyType)
    : 'text';
  return { ...p, type };
}

export function optionsOf(p: Property): SelectOption[] {
  const raw = p.config['options'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((o) => {
    const r = optionSchema.safeParse(o);
    return r.success ? [r.data] : [];
  });
}

export const relationTarget = (p: Property): string | null =>
  typeof p.config['targetDatabaseId'] === 'string' ? p.config['targetDatabaseId'] : null;

export interface Row {
  id: string;
  databaseId: string;
  title: string;
  props: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export const toRow = (r: DbRow): Row => r;

// ── Filtres, tris, vues ─────────────────────────────────────────────────────────
export const FILTER_OPS = [
  'contains',
  'notContains',
  'is',
  'isNot',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'before',
  'after',
  'onOrBefore',
  'onOrAfter',
  'checked',
  'unchecked',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface FilterRule {
  type: 'rule';
  id: string;
  propertyId: string;
  op: FilterOp;
  value?: unknown;
}
export interface FilterGroup {
  type: 'group';
  id: string;
  op: 'and' | 'or';
  children: FilterNode[];
}
export type FilterNode = FilterRule | FilterGroup;

const filterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal('rule'),
      id: z.string(),
      propertyId: z.string(),
      op: z.enum(FILTER_OPS),
      value: z.unknown().optional(),
    }),
    z.object({
      type: z.literal('group'),
      id: z.string(),
      op: z.enum(['and', 'or']),
      children: z.array(filterNodeSchema),
    }),
  ]),
) as z.ZodType<FilterNode>;

export const AGGREGATIONS = [
  'none',
  'count',
  'countEmpty',
  'countNotEmpty',
  'percentEmpty',
  'percentNotEmpty',
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'checked',
  'percentChecked',
] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const viewConfigSchema = z.object({
  filter: z
    .object({
      type: z.literal('group'),
      id: z.string(),
      op: z.enum(['and', 'or']),
      children: z.array(filterNodeSchema),
    })
    .catch({ type: 'group', id: 'root', op: 'and', children: [] }),
  sorts: z
    .array(z.object({ propertyId: z.string(), direction: z.enum(['asc', 'desc']) }))
    .max(8)
    .catch([]),
  groupBy: z.string().nullable().catch(null),
  hidden: z.array(z.string()).catch([]),
  widths: z.record(z.string(), z.number().min(60).max(900)).catch({}),
  aggregations: z.record(z.string(), z.enum(AGGREGATIONS)).catch({}),
  cardSize: z.enum(['s', 'm', 'l']).catch('m'),
  wrap: z.boolean().catch(false),
  /** Vue calendrier : propriété date utilisée (par défaut la première date/date-heure). */
  dateProperty: z.string().nullable().catch(null),
  calendarMode: z.enum(['month', 'week']).catch('month'),
});
export type ViewConfig = z.infer<typeof viewConfigSchema>;

export const DEFAULT_VIEW_CONFIG: ViewConfig = viewConfigSchema.parse({});

/** Lecture tolérante : toute valeur illisible retombe sur le défaut (jamais d'exception). */
export function parseViewConfig(raw: unknown): ViewConfig {
  const r = viewConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : DEFAULT_VIEW_CONFIG;
}

export type CellValue = string | number | boolean | string[] | null;
