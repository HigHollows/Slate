import { Icon } from '@slate/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNav } from '../navigation';
import { displayTitle, usePages, usePagesStore } from '../pages';
import { Button, Dialog, EmptyState, Menu, cx } from '../../shared/ui';
import { GalleryView, KanbanView, ListView, groupableProps } from './BoardViews';
import { CalendarView } from './CalendarView';
import { HabitTracker } from './HabitTracker';
import { useDatabase, useDatabasesStore } from './context';
import { useViewQuery } from './hooks';
import { PropertyDialog } from './PropertyDialog';
import { TableView } from './TableView';
import { FilterButton, PropertiesButton, SortButton } from './Toolbar';
import type { Property, Row, ViewConfig } from './types';
import type { ViewRow } from '../../shared/ipc/client';

const LAYOUTS: ViewRow['layout'][] = ['table', 'kanban', 'list', 'gallery', 'calendar'];
const LAYOUT_ICON = {
  table: 'grid',
  kanban: 'tasks',
  list: 'list',
  gallery: 'gallery',
  calendar: 'calendar',
} as const;

export function DatabasePage({ id }: { id: string }) {
  const { t } = useTranslation();
  const store = useDatabasesStore();
  const pages = usePagesStore();
  const db = useDatabase(id);
  const nodes = usePages((s) => s.nodes);
  const [viewId, setViewId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<{ property: Property | null } | null>(null);
  const [title, setTitle] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    void store.getState().load(id);
    return () => void store.getState().flushViews();
  }, [id, store]);
  useEffect(() => {
    setViewId(null);
    setSearch('');
  }, [id]);
  useEffect(() => setTitle(db?.node?.title ?? ''), [db?.node?.title]);

  const view = db?.views.find((v) => v.id === viewId) ?? db?.views[0];
  const query = useViewQuery(id, view?.config, search);
  const databases = useMemo(
    () => nodes.filter((n) => n.kind === 'database').map((n) => ({ id: n.id, title: n.title })),
    [nodes],
  );

  const patch = useCallback(
    (p: Partial<ViewConfig>) => view && store.getState().patchViewConfig(id, view.id, p),
    [store, id, view],
  );
  const newRow = useCallback(
    async (props?: Record<string, unknown>): Promise<Row | undefined> =>
      store.getState().createRow(id, props ? { props } : {}),
    [store, id],
  );

  if (!db || db.status === 'loading')
    return (
      <p role="status" className="p-8 text-muted">
        {t('databases.loading')}
      </p>
    );
  if (db.status === 'error' || !db.node || !view || !query) {
    return (
      <div className="grid h-full place-items-center p-8">
        <EmptyState
          icon="alert-circle"
          title={t('databases.loadFailed')}
          description={t('databases.loadFailedHint')}
        >
          <Button onClick={() => void store.getState().load(id, true)}>{t('system.retry')}</Button>
          <Button onClick={() => useNav.getState().navigate({ name: 'home' })}>
            {t('nav.home')}
          </Button>
        </EmptyState>
      </div>
    );
  }
  const config = query.config;
  const layout = view.layout;
  const habitGoal = db.properties.find(
    (p) => p.type === 'number' && p.config['role'] === 'habit_goal',
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-6 pt-3">
        <input
          aria-label={t('databases.titleLabel')}
          placeholder={t('pages.untitled')}
          value={title}
          maxLength={500}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== db.node?.title && void pages.getState().rename(id, title)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="mb-2 w-full select-text bg-transparent text-2xl font-bold tracking-tight outline-none placeholder:text-muted/60"
        />
        <div className="flex items-center gap-1 border-b border-line">
          <div role="tablist" aria-label={t('databases.views')} className="flex items-center gap-1">
            {db.views.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={v.id === view.id}
                onClick={() => setViewId(v.id)}
                className={cx(
                  'flex h-8 items-center gap-1.5 rounded-t-md px-2.5 hover:bg-hover',
                  v.id === view.id ? 'border-b-2 border-accent font-medium' : 'text-muted',
                )}
              >
                <Icon name={LAYOUT_ICON[v.layout]} size={14} />
                {v.name}
              </button>
            ))}
          </div>
          <Menu
            trigger={
              <button
                type="button"
                aria-label={t('databases.viewActions', { name: view.name })}
                className="grid size-6 place-items-center rounded text-muted hover:bg-hover"
              >
                <Icon name="chevron-down" size={12} />
              </button>
            }
            items={[
              {
                id: 'rename',
                label: t('databases.renameView'),
                onSelect: () => setRenaming({ id: view.id, name: view.name }),
              },
              {
                id: 'delete',
                label: t('databases.deleteView'),
                danger: true,
                onSelect: () =>
                  void store
                    .getState()
                    .removeView(id, view.id)
                    .then((ok) => {
                      if (ok) setViewId(null);
                    }),
              },
            ]}
          />
          <Menu
            trigger={
              <button
                type="button"
                aria-label={t('databases.addView')}
                className="grid size-7 place-items-center rounded-md text-muted hover:bg-hover"
              >
                <Icon name="plus" size={14} />
              </button>
            }
            items={LAYOUTS.map((l) => ({
              id: l,
              label: t(`databases.layout.${l}`),
              onSelect: () =>
                void store
                  .getState()
                  .addView(
                    id,
                    t(`databases.layout.${l}`),
                    l,
                    l === 'kanban'
                      ? {
                          groupBy:
                            groupableProps(db.properties).find(
                              (p) => p.type === 'status' || p.type === 'select',
                            )?.id ?? null,
                        }
                      : l === 'calendar'
                        ? {
                            dateProperty:
                              db.properties.find((p) => p.type === 'date' || p.type === 'datetime')
                                ?.id ?? null,
                          }
                        : {},
                  )
                  .then((nv) => nv && setViewId(nv.id)),
            }))}
          />
        </div>
      </div>

      {habitGoal ? <HabitTracker dbId={id} rows={db.rows} goalProp={habitGoal} /> : null}
      <div className="flex flex-wrap items-center gap-1 px-6 py-2">
        <FilterButton
          properties={db.properties}
          config={config}
          onChange={(filter) => patch({ filter })}
        />
        <SortButton
          properties={db.properties}
          config={config}
          onChange={(sorts) => patch({ sorts })}
        />
        <PropertiesButton
          properties={db.properties}
          config={config}
          layout={layout}
          onHidden={(hidden) => patch({ hidden })}
          onGroupBy={(groupBy) => patch({ groupBy })}
          onMove={(p, dir) => {
            const order = db.properties.filter((x) => x.type !== 'title');
            const i = order.findIndex((x) => x.id === p.id);
            void store
              .getState()
              .moveProperty(
                id,
                p.id,
                dir === -1 ? (order[i - 1]?.id ?? null) : (order[i + 2]?.id ?? null),
              );
          }}
          onAdd={() => setDialog({ property: null })}
          onEdit={(p) => setDialog({ property: p })}
        />
        <span className="ml-auto flex items-center gap-2">
          {layout === 'calendar' ? (
            <CalendarView
              dbId={id}
              query={query}
              patch={patch}
              onNewRow={newRow}
              onAddProperty={() => setDialog({ property: null })}
            />
          ) : null}
          {layout === 'gallery' ? (
            <select
              aria-label={t('databases.cardSize')}
              className="h-8 rounded-md border border-line bg-surface px-2"
              value={config.cardSize}
              onChange={(e) => patch({ cardSize: e.target.value as ViewConfig['cardSize'] })}
            >
              {(['s', 'm', 'l'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`databases.cardSizes.${s}`)}
                </option>
              ))}
            </select>
          ) : null}
          <label className="relative">
            <span className="sr-only">{t('databases.searchRowsInView')}</span>
            <Icon
              name="search"
              size={13}
              className="pointer-events-none absolute left-2 top-2.5 text-muted"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('databases.searchRowsInView')}
              className="h-8 w-48 select-text rounded-md border border-line bg-surface pl-7 pr-2 outline-none focus-visible:border-accent"
            />
          </label>
          <Button
            variant="primary"
            icon="plus"
            onClick={() =>
              void newRow().then(
                (r) =>
                  r && layout !== 'table' && useNav.getState().navigate({ name: 'page', id: r.id }),
              )
            }
          >
            {t('databases.newRow')}
          </Button>
        </span>
      </div>
      <p className="px-6 pb-1 text-xs text-muted" role="status">
        {t('databases.count', { shown: query.rows.length, total: query.total })}
      </p>

      {layout === 'table' ? (
        <TableView
          dbId={id}
          viewId={view.id}
          query={query}
          onEditProperty={(p) => setDialog({ property: p })}
          onAddProperty={() => setDialog({ property: null })}
          onNewRow={() => newRow()}
        />
      ) : null}
      {layout === 'kanban' ? (
        <KanbanView
          dbId={id}
          query={query}
          onNewRow={newRow}
          onAddProperty={() => setDialog({ property: null })}
        />
      ) : null}
      {layout === 'list' ? <ListView dbId={id} query={query} onNewRow={() => newRow()} /> : null}
      {layout === 'gallery' ? (
        <GalleryView dbId={id} query={query} onNewRow={() => newRow()} />
      ) : null}

      <PropertyDialog
        dbId={id}
        property={dialog?.property ?? null}
        databases={databases}
        open={dialog !== null}
        onClose={() => setDialog(null)}
      />
      <Dialog
        open={renaming !== null}
        onOpenChange={(o) => !o && setRenaming(null)}
        title={t('databases.renameView')}
      >
        <form
          className="space-y-3 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (renaming?.name.trim())
              void store.getState().renameView(id, renaming.id, renaming.name.trim());
            setRenaming(null);
          }}
        >
          <input
            autoFocus
            aria-label={t('databases.viewName')}
            value={renaming?.name ?? ''}
            maxLength={200}
            onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.target.value } : r))}
            className="h-9 w-full select-text rounded-md border border-line bg-surface px-2 outline-none focus-visible:border-accent"
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRenaming(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit">
              {t('common.apply')}
            </Button>
          </div>
        </form>
      </Dialog>
      <span className="sr-only">{displayTitle(db.node, t('pages.untitled'))}</span>
    </div>
  );
}
