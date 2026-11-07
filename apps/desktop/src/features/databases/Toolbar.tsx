import { useTranslation } from 'react-i18next';
import { Button, IconButton, Popover, Segmented, cx } from '../../shared/ui';
import { countRules } from './engine';
import { typeDef } from './registry';
import { groupableProps } from './BoardViews';
import {
  optionsOf,
  type FilterGroup,
  type FilterNode,
  type FilterOp,
  type FilterRule,
  type Property,
  type ViewConfig,
} from './types';

const uid = () => Math.random().toString(36).slice(2, 10);
const select =
  'h-8 rounded-md border border-line bg-surface px-2 outline-none focus-visible:border-accent';

function ValueInput({
  prop,
  rule,
  onChange,
}: {
  prop: Property;
  rule: FilterRule;
  onChange(v: unknown): void;
}) {
  const { t } = useTranslation();
  if (['isEmpty', 'isNotEmpty', 'checked', 'unchecked'].includes(rule.op)) return null;
  if (prop.type === 'select' || prop.type === 'status' || prop.type === 'multiselect') {
    return (
      <select
        aria-label={t('databases.filter.value')}
        className={select}
        value={typeof rule.value === 'string' ? rule.value : ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {optionsOf(prop).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  if (
    prop.type === 'date' ||
    prop.type === 'datetime' ||
    prop.type === 'created_time' ||
    prop.type === 'last_edited_time'
  ) {
    const v = rule.value;
    const mode =
      typeof v === 'object' && v !== null && 'mode' in v
        ? String((v as { mode: string }).mode)
        : 'exact';
    return (
      <span className="flex gap-1">
        <select
          aria-label={t('databases.filter.dateMode')}
          className={select}
          value={mode}
          onChange={(e) =>
            onChange(
              e.target.value === 'today'
                ? { mode: 'today' }
                : e.target.value === 'daysFromNow'
                  ? { mode: 'daysFromNow', n: 0 }
                  : { mode: 'exact', date: '' },
            )
          }
        >
          <option value="exact">{t('databases.filter.exactDate')}</option>
          <option value="today">{t('databases.filter.today')}</option>
          <option value="daysFromNow">{t('databases.filter.daysFromNow')}</option>
        </select>
        {mode === 'exact' ? (
          <input
            type="date"
            aria-label={t('databases.filter.value')}
            className={select}
            value={
              typeof v === 'object' && v !== null && 'date' in v
                ? String((v as { date: string }).date)
                : typeof v === 'string'
                  ? v
                  : ''
            }
            onChange={(e) => onChange({ mode: 'exact', date: e.target.value })}
          />
        ) : null}
        {mode === 'daysFromNow' ? (
          <input
            type="number"
            aria-label={t('databases.filter.days')}
            className={cx(select, 'w-20')}
            value={
              typeof v === 'object' && v !== null && 'n' in v ? Number((v as { n: number }).n) : 0
            }
            onChange={(e) => onChange({ mode: 'daysFromNow', n: Number(e.target.value) })}
          />
        ) : null}
      </span>
    );
  }
  const numeric = ['number', 'percent', 'id'].includes(prop.type);
  return (
    <input
      aria-label={t('databases.filter.value')}
      type={numeric ? 'number' : 'text'}
      className={cx(select, 'w-36 select-text')}
      value={
        typeof rule.value === 'string' || typeof rule.value === 'number' ? String(rule.value) : ''
      }
      onChange={(e) => onChange(numeric ? e.target.value : e.target.value)}
    />
  );
}

function opsFor(p: Property): FilterOp[] {
  return p.type === 'relation' ? ['isEmpty', 'isNotEmpty'] : typeDef(p.type).filterOps;
}

function Group({
  node,
  props,
  depth,
  onChange,
  onRemove,
}: {
  node: FilterGroup;
  props: Property[];
  depth: number;
  onChange(n: FilterGroup): void;
  onRemove?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const set = (i: number, c: FilterNode) =>
    onChange({ ...node, children: node.children.map((x, j) => (j === i ? c : x)) });
  const del = (i: number) =>
    onChange({ ...node, children: node.children.filter((_, j) => j !== i) });
  const first = props[0];
  return (
    <div className={cx('space-y-1.5', depth > 0 && 'rounded-lg border border-line bg-surface p-2')}>
      {depth > 0 ? (
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted">{t('databases.filter.group')}</span>
          <IconButton
            icon="cross"
            label={t('databases.filter.removeGroup')}
            onClick={onRemove ?? (() => undefined)}
          />
        </div>
      ) : null}
      {node.children.map((c, i) => (
        <div key={c.id} className="flex items-start gap-1.5">
          <span className="w-14 shrink-0 pt-1.5 text-xs text-muted">
            {i === 0 ? (
              t('databases.filter.where')
            ) : i === 1 ? (
              <select
                aria-label={t('databases.filter.combine')}
                className="h-7 w-14 rounded border border-line bg-surface px-1 text-xs"
                value={node.op}
                onChange={(e) => onChange({ ...node, op: e.target.value as 'and' | 'or' })}
              >
                <option value="and">{t('databases.filter.and')}</option>
                <option value="or">{t('databases.filter.or')}</option>
              </select>
            ) : (
              t(`databases.filter.${node.op}`)
            )}
          </span>
          {c.type === 'group' ? (
            <div className="flex-1">
              <Group
                node={c}
                props={props}
                depth={depth + 1}
                onChange={(g) => set(i, g)}
                onRemove={() => del(i)}
              />
            </div>
          ) : (
            <RuleRow rule={c} props={props} onChange={(r) => set(i, r)} onRemove={() => del(i)} />
          )}
        </div>
      ))}
      <div className="flex gap-1.5 pl-[3.875rem]">
        <Button
          variant="ghost"
          icon="plus"
          disabled={!first}
          onClick={() =>
            first &&
            onChange({
              ...node,
              children: [
                ...node.children,
                {
                  type: 'rule',
                  id: uid(),
                  propertyId: first.id,
                  op: opsFor(first)[0] ?? 'contains',
                },
              ],
            })
          }
        >
          {t('databases.filter.addRule')}
        </Button>
        {depth < 2 ? (
          <Button
            variant="ghost"
            onClick={() =>
              onChange({
                ...node,
                children: [...node.children, { type: 'group', id: uid(), op: 'and', children: [] }],
              })
            }
          >
            {t('databases.filter.addGroup')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  props,
  onChange,
  onRemove,
}: {
  rule: FilterRule;
  props: Property[];
  onChange(r: FilterRule): void;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  const prop = props.find((p) => p.id === rule.propertyId);
  const ops = prop ? opsFor(prop) : [];
  return (
    <div className="flex flex-1 flex-wrap items-center gap-1.5">
      <select
        aria-label={t('databases.filter.property')}
        className={select}
        value={rule.propertyId}
        onChange={(e) => {
          const np = props.find((p) => p.id === e.target.value);
          onChange({
            type: 'rule',
            id: rule.id,
            propertyId: e.target.value,
            op: np ? (opsFor(np)[0] ?? 'contains') : rule.op,
          });
        }}
      >
        {!prop ? <option value={rule.propertyId}>{t('databases.filter.deleted')}</option> : null}
        {props.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select
        aria-label={t('databases.filter.operator')}
        className={select}
        value={rule.op}
        onChange={(e) => onChange({ ...rule, op: e.target.value as FilterOp })}
      >
        {ops.map((o) => (
          <option key={o} value={o}>
            {t(`databases.filter.op.${o}`)}
          </option>
        ))}
      </select>
      {prop ? (
        <ValueInput prop={prop} rule={rule} onChange={(v) => onChange({ ...rule, value: v })} />
      ) : null}
      <IconButton icon="cross" label={t('databases.filter.removeRule')} onClick={onRemove} />
    </div>
  );
}

export function FilterButton({
  properties,
  config,
  onChange,
}: {
  properties: Property[];
  config: ViewConfig;
  onChange(f: FilterGroup): void;
}) {
  const { t } = useTranslation();
  const n = countRules(config.filter);
  return (
    <Popover
      label={t('databases.filter.title')}
      width={560}
      trigger={
        <Button variant={n ? 'secondary' : 'ghost'} icon="filter">
          {t('databases.filter.title')}
          {n ? ` · ${n}` : ''}
        </Button>
      }
    >
      <Group node={config.filter} props={properties} depth={0} onChange={onChange} />
      {n === 0 ? <p className="px-1 pt-2 text-muted">{t('databases.filter.empty')}</p> : null}
    </Popover>
  );
}

export function SortButton({
  properties,
  config,
  onChange,
}: {
  properties: Property[];
  config: ViewConfig;
  onChange(s: ViewConfig['sorts']): void;
}) {
  const { t } = useTranslation();
  const n = config.sorts.length;
  return (
    <Popover
      label={t('databases.sort.title')}
      width={400}
      trigger={
        <Button variant={n ? 'secondary' : 'ghost'} icon="list">
          {t('databases.sort.title')}
          {n ? ` · ${n}` : ''}
        </Button>
      }
    >
      <div className="space-y-1.5">
        {config.sorts.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <select
              aria-label={t('databases.filter.property')}
              className={cx(select, 'flex-1')}
              value={s.propertyId}
              onChange={(e) =>
                onChange(
                  config.sorts.map((x, j) => (j === i ? { ...x, propertyId: e.target.value } : x)),
                )
              }
            >
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Segmented
              label={t('databases.sort.direction')}
              value={s.direction}
              onChange={(d) =>
                onChange(config.sorts.map((x, j) => (j === i ? { ...x, direction: d } : x)))
              }
              options={[
                { value: 'asc', label: t('databases.sort.asc') },
                { value: 'desc', label: t('databases.sort.desc') },
              ]}
            />
            <IconButton
              icon="cross"
              label={t('databases.sort.remove')}
              onClick={() => onChange(config.sorts.filter((_, j) => j !== i))}
            />
          </div>
        ))}
        {n < 8 && properties[0] ? (
          <Button
            variant="ghost"
            icon="plus"
            onClick={() =>
              onChange([
                ...config.sorts,
                {
                  propertyId: (properties.find(
                    (p) => !config.sorts.some((s) => s.propertyId === p.id),
                  ) ?? properties[0])!.id,
                  direction: 'asc',
                },
              ])
            }
          >
            {t('databases.sort.add')}
          </Button>
        ) : null}
        {n === 0 ? <p className="px-1 text-muted">{t('databases.sort.empty')}</p> : null}
      </div>
    </Popover>
  );
}

export function PropertiesButton({
  properties,
  config,
  layout,
  onHidden,
  onGroupBy,
  onMove,
  onAdd,
  onEdit,
}: {
  properties: Property[];
  config: ViewConfig;
  layout: string;
  onHidden(ids: string[]): void;
  onGroupBy(id: string | null): void;
  onMove(p: Property, dir: -1 | 1): void;
  onAdd(): void;
  onEdit(p: Property): void;
}) {
  const { t } = useTranslation();
  const hiddenCount = config.hidden.length;
  const rest = properties.filter((p) => p.type !== 'title');
  return (
    <Popover
      label={t('databases.properties')}
      width={320}
      align="end"
      trigger={
        <Button variant={hiddenCount ? 'secondary' : 'ghost'} icon="gears">
          {t('databases.properties')}
          {hiddenCount ? ` · ${hiddenCount}` : ''}
        </Button>
      }
    >
      <ul className="space-y-0.5">
        {rest.map((p, i) => {
          const hidden = config.hidden.includes(p.id);
          return (
            <li
              key={p.id}
              className="flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-hover"
            >
              <input
                type="checkbox"
                aria-label={t('databases.showProperty', { name: p.name })}
                checked={!hidden}
                onChange={() =>
                  onHidden(
                    hidden ? config.hidden.filter((x) => x !== p.id) : [...config.hidden, p.id],
                  )
                }
                className="size-4 accent-[var(--accent)]"
              />
              <button
                type="button"
                onClick={() => onEdit(p)}
                className="min-w-0 flex-1 truncate px-1 text-left"
              >
                {p.name}
              </button>
              <IconButton
                icon="arrow-up"
                label={t('databases.moveUp', { name: p.name })}
                disabled={i === 0}
                onClick={() => onMove(p, -1)}
              />
              <IconButton
                icon="arrow-down"
                label={t('databases.moveDown', { name: p.name })}
                disabled={i === rest.length - 1}
                onClick={() => onMove(p, 1)}
              />
            </li>
          );
        })}
      </ul>
      <Button variant="ghost" icon="plus" className="mt-1" onClick={onAdd}>
        {t('databases.addProperty')}
      </Button>
      {layout !== 'table' ? (
        <label className="mt-2 flex items-center justify-between gap-2 border-t border-line px-1 pt-2">
          {t('databases.groupBy')}
          <select
            aria-label={t('databases.groupBy')}
            className={select}
            value={config.groupBy ?? ''}
            onChange={(e) => onGroupBy(e.target.value || null)}
          >
            <option value="">
              {layout === 'kanban' ? t('databases.groupAuto') : t('databases.groupNone')}
            </option>
            {groupableProps(properties).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </Popover>
  );
}
