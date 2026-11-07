import { Icon } from '@slate/icons';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNav } from '../navigation';
import { Button, EmptyState, Menu, cx } from '../../shared/ui';
import { CellDisplay } from './cells';
import { useDatabasesStore } from './context';
import { groupRows, type Group } from './engine';
import type { QueryState } from './hooks';
import { typeDef } from './registry';
import type { Property, Row, ViewConfig } from './types';

const open = (id: string) => useNav.getState().navigate({ name: 'page', id });
const GROUPABLE = new Set([
  'select',
  'status',
  'multiselect',
  'checkbox',
  'text',
  'number',
  'date',
]);

/** Propriété de regroupement : celle de la vue si elle existe, sinon la première sélection/statut. */
export function groupProperty(q: QueryState): Property | undefined {
  const byId = q.properties.find((p) => p.id === q.config.groupBy);
  return (
    byId ??
    q.properties.find((p) => p.type === 'status') ??
    q.properties.find((p) => p.type === 'select')
  );
}
export const groupableProps = (ps: Property[]) => ps.filter((p) => GROUPABLE.has(p.type));

function CardBody({
  row,
  q,
  locale,
  max = 3,
}: {
  row: Row;
  q: QueryState;
  locale: string;
  max?: number;
}) {
  const { t } = useTranslation();
  const shown = q.properties
    .filter((p) => p.type !== 'title' && !q.config.hidden.includes(p.id))
    .slice(0, max);
  return (
    <>
      <div className={cx('truncate font-medium', row.title.trim() === '' && 'text-muted')}>
        {row.title.trim() === '' ? t('pages.untitled') : row.title}
      </div>
      {shown.map((p) => {
        const has = q.evaluator.text(row, p, locale) !== '' || p.type === 'checkbox';
        return has ? (
          <div key={p.id} className="mt-1 flex min-w-0 items-center text-xs text-muted">
            <CellDisplay
              row={row}
              prop={p}
              ev={q.evaluator}
              locale={locale}
              relationTitle={q.ctx.relationTitle}
            />
          </div>
        ) : null;
      })}
    </>
  );
}

export function KanbanView({
  dbId,
  query,
  onNewRow,
  onAddProperty,
}: {
  dbId: string;
  query: QueryState;
  onNewRow(init?: Record<string, unknown>): Promise<Row | undefined>;
  onAddProperty(): void;
}) {
  const { t, i18n } = useTranslation();
  const store = useDatabasesStore();
  const gp = groupProperty(query);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const groups = useMemo(
    () =>
      gp
        ? groupRows(query.rows, gp, query.evaluator, {
            none: t('databases.noValue'),
            yes: t('databases.yes'),
            no: t('databases.no'),
          })
        : [],
    [gp, query.rows, query.evaluator, t],
  );

  if (!gp) {
    return (
      <div className="grid flex-1 place-items-center p-8">
        <EmptyState
          icon="grid"
          title={t('databases.kanbanNeedsProperty')}
          description={t('databases.kanbanNeedsPropertyHint')}
        >
          <Button variant="primary" onClick={onAddProperty}>
            {t('databases.addProperty')}
          </Button>
        </EmptyState>
      </div>
    );
  }

  const valueFor = (g: Group): unknown => {
    if (g.key === null) return null;
    if (gp.type === 'multiselect') return [g.key];
    if (gp.type === 'checkbox') return g.key === 'true';
    if (gp.type === 'number') return Number(g.key);
    if (gp.type === 'select' || gp.type === 'status') return g.key;
    return g.label;
  };
  const move = (rowId: string, to: Group, from?: Group) => {
    const row = query.rows.find((r) => r.id === rowId);
    if (!row) return;
    let value = valueFor(to);
    if (gp.type === 'multiselect' && from && from.key !== null) {
      const cur = Array.isArray(row.props[gp.id]) ? (row.props[gp.id] as string[]) : [];
      const next = cur.filter((x) => x !== from.key);
      value = to.key === null ? (next.length ? next : null) : [...new Set([...next, to.key])];
    }
    if (typeDef(gp.type).editable)
      void store.getState().setCells(dbId, [{ rowId, propertyId: gp.id, value }]);
  };

  return (
    <div
      className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4"
      aria-label={t('databases.boardLabel')}
      role="group"
    >
      {groups.map((g) => (
        <section
          key={g.key ?? '∅'}
          aria-label={g.label}
          onDragOver={(e) => {
            if (dragId) {
              e.preventDefault();
              setOver(g.key ?? '∅');
            }
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            const from = groups.find((x) => x.rows.some((r) => r.id === dragId));
            if (dragId) move(dragId, g, from);
            setDragId(null);
          }}
          className={cx(
            'flex w-72 shrink-0 flex-col rounded-xl bg-surface p-2',
            over === (g.key ?? '∅') && 'ring-2 ring-accent',
          )}
        >
          <header className="mb-2 flex items-center gap-2 px-1">
            <h2 className="font-medium">{g.label}</h2>
            <span className="text-xs text-muted">{g.rows.length}</span>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {g.rows.map((r) => (
              <article
                key={r.id}
                draggable
                onDragStart={(e) => {
                  setDragId(r.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', r.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOver(null);
                }}
                className={cx(
                  'group relative rounded-lg border border-line bg-elevated p-2.5 shadow-sm',
                  dragId === r.id && 'opacity-40',
                )}
              >
                <button type="button" onClick={() => open(r.id)} className="block w-full text-left">
                  <CardBody row={r} q={query} locale={i18n.language} />
                </button>
                <span className="absolute right-1 top-1 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                  <Menu
                    trigger={
                      <button
                        type="button"
                        aria-label={t('databases.moveCardOf', {
                          title: r.title || t('pages.untitled'),
                        })}
                        className="grid size-6 place-items-center rounded-md text-muted hover:bg-hover"
                      >
                        <Icon name="menu" size={14} />
                      </button>
                    }
                    items={groups
                      .filter((x) => x !== g)
                      .map((x) => ({
                        id: x.key ?? '∅',
                        label: t('databases.moveCardTo', { name: x.label }),
                        onSelect: () => move(r.id, x, g),
                      }))}
                  />
                </span>
              </article>
            ))}
          </div>
          <button
            type="button"
            onClick={() =>
              void onNewRow(
                typeDef(gp.type).editable && g.key !== null ? { [gp.id]: valueFor(g) } : undefined,
              )
            }
            className="mt-2 flex h-8 items-center gap-2 rounded-md px-2 text-left text-muted hover:bg-hover hover:text-fg"
          >
            <Icon name="plus" size={14} />
            {t('databases.newCard')}
          </button>
        </section>
      ))}
    </div>
  );
}

export function ListView({
  query,
  onNewRow,
}: {
  dbId: string;
  query: QueryState;
  onNewRow(): Promise<Row | undefined>;
}) {
  const { t, i18n } = useTranslation();
  const store = useDatabasesStore();
  void store;
  const gp = query.config.groupBy
    ? query.properties.find((p) => p.id === query.config.groupBy)
    : undefined;
  const groups = useMemo(
    () =>
      gp
        ? groupRows(query.rows, gp, query.evaluator, {
            none: t('databases.noValue'),
            yes: t('databases.yes'),
            no: t('databases.no'),
          })
        : null,
    [gp, query.rows, query.evaluator, t],
  );
  const flat = useMemo<({ kind: 'group'; g: Group } | { kind: 'row'; r: Row })[]>(
    () =>
      groups
        ? groups.flatMap((g) => [
            { kind: 'group' as const, g },
            ...g.rows.map((r) => ({ kind: 'row' as const, r })),
          ])
        : query.rows.map((r) => ({ kind: 'row' as const, r })),
    [groups, query.rows],
  );
  const ref = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: flat.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 40,
    overscan: 12,
    initialRect: { width: 1000, height: 800 },
  });
  return (
    <div ref={ref} data-virtual-scroller className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
      <ul
        role="list"
        aria-label={t('databases.listLabel')}
        style={{ height: virt.getTotalSize(), position: 'relative' }}
      >
        {virt.getVirtualItems().map((vi) => {
          const it = flat[vi.index];
          if (!it) return null;
          return (
            <li
              key={vi.key}
              role="listitem"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: vi.size,
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {it.kind === 'group' ? (
                <h2 className="flex h-full items-end gap-2 pb-1 text-xs font-medium text-muted">
                  {it.g.label}
                  <span>{it.g.rows.length}</span>
                </h2>
              ) : (
                <button
                  type="button"
                  onClick={() => open(it.r.id)}
                  className="flex h-full w-full items-center gap-3 rounded-md px-2 text-left hover:bg-hover"
                >
                  <Icon name="paper" size={15} className="shrink-0 text-muted" />
                  <span
                    className={cx(
                      'min-w-0 max-w-[40%] truncate font-medium',
                      it.r.title.trim() === '' && 'text-muted',
                    )}
                  >
                    {it.r.title.trim() === '' ? t('pages.untitled') : it.r.title}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                    {query.properties
                      .filter((p) => p.type !== 'title' && !query.config.hidden.includes(p.id))
                      .slice(0, 4)
                      .map((p) => (
                        <span key={p.id} className="flex min-w-0 items-center text-xs text-muted">
                          <CellDisplay
                            row={it.r}
                            prop={p}
                            ev={query.evaluator}
                            locale={i18n.language}
                            relationTitle={query.ctx.relationTitle}
                          />
                        </span>
                      ))}
                  </span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {query.rows.length === 0 ? (
        <p role="status" className="px-2 py-6 text-muted">
          {query.total === 0 ? t('databases.noRowsYet') : t('databases.noMatch')}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void onNewRow().then((r) => r && open(r.id))}
        className="mt-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-muted hover:bg-hover hover:text-fg"
      >
        <Icon name="plus" size={14} />
        {t('databases.newRow')}
      </button>
    </div>
  );
}

const CARD_W: Record<ViewConfig['cardSize'], number> = { s: 180, m: 240, l: 320 };

export function GalleryView({
  query,
  onNewRow,
}: {
  dbId: string;
  query: QueryState;
  onNewRow(): Promise<Row | undefined>;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div
        role="list"
        aria-label={t('databases.galleryLabel')}
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_W[query.config.cardSize]}px, 1fr))`,
        }}
      >
        {query.rows.map((r) => (
          <div key={r.id} role="listitem">
            <button
              type="button"
              onClick={() => open(r.id)}
              className="h-full w-full rounded-xl border border-line bg-elevated p-3 text-left shadow-sm transition-colors hover:bg-hover"
            >
              <CardBody row={r} q={query} locale={i18n.language} max={5} />
            </button>
          </div>
        ))}
        <div role="listitem">
          <button
            type="button"
            onClick={() => void onNewRow().then((r) => r && open(r.id))}
            className="flex min-h-20 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line text-muted hover:bg-hover hover:text-fg"
          >
            <Icon name="plus" size={14} />
            {t('databases.newRow')}
          </button>
        </div>
      </div>
      {query.rows.length === 0 ? (
        <p role="status" className="py-4 text-muted">
          {query.total === 0 ? t('databases.noRowsYet') : t('databases.noMatch')}
        </p>
      ) : null}
    </div>
  );
}
