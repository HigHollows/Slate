import { Icon } from '@slate/icons';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNav } from '../navigation';
import { Popover, cx } from '../../shared/ui';
import { CellDisplay, InlineInput, OptionPicker, RelationPicker, editorKind } from './cells';
import { useDatabase, useDatabasesStore } from './context';
import { useViewQuery } from './hooks';
import { optionsOf, type Property } from './types';
import { typeDef } from './registry';

/** Panneau des propriétés d'une ligne ouverte comme page complète. Mêmes données que les vues (source partagée). */
export function RowProperties({ databaseId, rowId }: { databaseId: string; rowId: string }) {
  const { t, i18n } = useTranslation();
  const store = useDatabasesStore();
  const db = useDatabase(databaseId);
  const query = useViewQuery(databaseId, undefined, '');
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    void store.getState().load(databaseId);
  }, [databaseId, store]);

  const row = db?.rows.find((r) => r.id === rowId);
  if (!db || !query || !row) return null;
  const props = db.properties.filter((p) => p.type !== 'title');

  const commit = (p: Property, v: unknown) =>
    store.getState().setCells(databaseId, [{ rowId, propertyId: p.id, value: v }]);
  const createOption = async (p: Property, name: string): Promise<string | undefined> => {
    const updated = await store.getState().updateProperty(databaseId, p.id, {
      config: {
        ...p.config,
        options: [...optionsOf(p), { name, color: 'gray' }].map((o) =>
          'id' in o && o.id ? o : { name: o.name, color: 'gray' },
        ),
      },
    });
    return optionsOf(updated ?? p).find((o) => o.name === name)?.id;
  };

  return (
    <section
      aria-label={t('databases.rowProperties')}
      className="mb-6 rounded-xl border border-line bg-surface/60 p-3"
    >
      <button
        type="button"
        onClick={() => useNav.getState().navigate({ name: 'database', id: databaseId })}
        className="mb-2 flex items-center gap-1.5 text-xs text-muted hover:text-fg"
      >
        <Icon name="grid" size={13} />
        {db.node?.title.trim() || t('pages.untitled')}
      </button>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
        {props.map((p) => {
          const def = typeDef(p.type);
          const kind = editorKind(p);
          const isEditing = editing === p.id;
          const cell = (
            <CellDisplay
              row={row}
              prop={p}
              ev={query.evaluator}
              locale={i18n.language}
              relationTitle={query.ctx.relationTitle}
            />
          );
          return (
            <div key={p.id} className="contents">
              <dt className="flex h-8 items-center gap-1.5 truncate text-muted">
                {def.icon ? (
                  <Icon name={def.icon} size={13} />
                ) : (
                  <span aria-hidden className="w-3.5 text-center text-[0.6875rem] font-semibold">
                    {def.glyph}
                  </span>
                )}
                {p.name}
              </dt>
              <dd className="min-h-8">
                {kind === 'none' ? (
                  <div className="flex h-8 items-center text-muted">{cell}</div>
                ) : kind === 'toggle' ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={row.props[p.id] === true}
                    aria-label={p.name}
                    onClick={() => void commit(p, row.props[p.id] !== true)}
                    className="flex h-8 items-center"
                  >
                    {cell}
                  </button>
                ) : kind === 'input' ? (
                  isEditing ? (
                    <div className="relative h-8">
                      <InlineInput
                        row={row}
                        prop={p}
                        ev={query.evaluator}
                        onCommit={(v) => {
                          void commit(p, v);
                          setEditing(null);
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={t('databases.editValue', { name: p.name })}
                      onClick={() => setEditing(p.id)}
                      className={cx(
                        'flex h-8 w-full min-w-0 items-center rounded-md px-2 text-left hover:bg-hover',
                        !row.props[p.id] && 'text-muted',
                      )}
                    >
                      {cell}
                      {!row.props[p.id] ? <span>{t('databases.empty')}</span> : null}
                    </button>
                  )
                ) : (
                  <Popover
                    label={p.name}
                    open={isEditing}
                    onOpenChange={(o) => setEditing(o ? p.id : null)}
                    trigger={
                      <button
                        type="button"
                        aria-label={t('databases.editValue', { name: p.name })}
                        className="flex min-h-8 w-full min-w-0 items-center rounded-md px-2 text-left hover:bg-hover"
                      >
                        {cell}
                        {!row.props[p.id] ||
                        (Array.isArray(row.props[p.id]) &&
                          (row.props[p.id] as unknown[]).length === 0) ? (
                          <span className="text-muted">{t('databases.empty')}</span>
                        ) : null}
                      </button>
                    }
                  >
                    {p.type === 'relation' ? (
                      <RelationPicker
                        prop={p}
                        value={row.props[p.id]}
                        onChange={(v) => void commit(p, v)}
                        onClose={() => setEditing(null)}
                      />
                    ) : (
                      <OptionPicker
                        prop={p}
                        value={row.props[p.id]}
                        onChange={(v) => void commit(p, v)}
                        onCreate={(n) => createOption(p, n)}
                        onClose={() => setEditing(null)}
                      />
                    )}
                  </Popover>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
