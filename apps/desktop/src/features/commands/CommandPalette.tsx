import { Icon } from '@slate/icons';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, Kbd, cx } from '../../shared/ui';
import type { SearchHit } from '../../shared/ipc/client';
import { useNav } from '../navigation';
import { Highlighted } from './Highlighted';
import { resolveBindings, searchCommands, type Command } from './model';
import { useCommandsState, useCommandsStore } from './context';

type Row =
  | { kind: 'cmd'; key: string; c: Command; section: string | null }
  | { kind: 'hit'; key: string; hit: SearchHit; section: string | null };

export function CommandPalette({
  commands,
  searchContent,
}: {
  commands: Command[];
  /** Recherche plein texte dans les pages (hors ligne). Absente => commandes seulement. */
  searchContent?: (query: string) => Promise<SearchHit[]>;
}) {
  const { t } = useTranslation();
  const store = useCommandsStore();
  const open = useCommandsState((s) => s.paletteOpen);
  const history = useCommandsState((s) => s.history);
  const overrides = useCommandsState((s) => s.overrides);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const requestId = useRef(0);

  const visible = useMemo(() => commands.filter((c) => !c.hidden), [commands]);
  const bindings = useMemo(() => resolveBindings(commands, overrides), [commands, overrides]);

  // Recherche de contenu : légèrement différée, les réponses obsolètes sont ignorées.
  useEffect(() => {
    const q = query.trim();
    if (!open || !searchContent || q === '') {
      setHits([]);
      return;
    }
    const id = ++requestId.current;
    const h = setTimeout(() => {
      searchContent(q).then(
        (r) => id === requestId.current && setHits(r.slice(0, 6)),
        () => id === requestId.current && setHits([]),
      );
    }, 120);
    return () => clearTimeout(h);
  }, [query, open, searchContent]);

  const rows = useMemo<Row[]>(() => {
    if (query.trim()) {
      const hitRows: Row[] = hits.map((hit, i) => ({
        kind: 'hit',
        key: `hit-${hit.nodeId}`,
        hit,
        section: i === 0 ? t('palette.group.pages') : t('palette.group.pages'),
      }));
      const cmdRows: Row[] = searchCommands(visible, query).map((c, i) => ({
        kind: 'cmd',
        key: c.id,
        c,
        section: i === 0 && hitRows.length > 0 ? t('palette.commands') : null,
      }));
      return [...hitRows, ...cmdRows];
    }
    const recent = history
      .map((id) => visible.find((c) => c.id === id))
      .filter((c): c is Command => !!c);
    const recentIds = new Set(recent.map((c) => c.id));
    return [
      ...recent.map<Row>((c) => ({ kind: 'cmd', key: c.id, c, section: t('palette.recent') })),
      ...visible
        .filter((c) => !recentIds.has(c.id))
        .map<Row>((c) => ({ kind: 'cmd', key: c.id, c, section: t(`palette.group.${c.group}`) })),
    ];
  }, [query, visible, history, hits, t]);

  useEffect(() => setActive(0), [query, open, hits]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (r: Row) => {
    store.getState().setPaletteOpen(false);
    if (r.kind === 'hit') {
      setTimeout(
        () =>
          useNav
            .getState()
            .navigate(
              r.hit.kind === 'database'
                ? { name: 'database', id: r.hit.nodeId }
                : { name: 'page', id: r.hit.nodeId },
            ),
        0,
      );
      return;
    }
    void store.getState().recordRun(r.c.id);
    // Après la fermeture, pour que le focus revienne avant l'action (ex. ouverture d'un autre dialogue).
    setTimeout(() => r.c.run(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[active];
      if (r) run(r);
    }
  };

  const activeRow = rows[active];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => store.getState().setPaletteOpen(o)}
      title={t('palette.title')}
      hideTitle
      align="top"
      className="w-[min(92vw,38rem)] overflow-hidden"
    >
      <div className="flex items-center gap-2 border-b border-line px-4 focus-within:border-accent">
        <Icon name="search" size={16} className="text-muted" />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={activeRow ? `${listId}-${activeRow.key}` : undefined}
          aria-label={t('palette.placeholder')}
          placeholder={t('palette.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="h-12 w-full bg-transparent text-[0.9375rem] outline-none placeholder:text-muted focus-visible:outline-none"
        />
      </div>
      {rows.length === 0 ? (
        <p role="status" className="px-4 py-8 text-center text-muted">
          {t('palette.empty', { query })}
        </p>
      ) : (
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label={t('palette.title')}
          className="max-h-[50vh] overflow-y-auto p-1.5"
        >
          {rows.map((r, i) => {
            const showHeader = r.section !== null && rows[i - 1]?.section !== r.section;
            const combo = r.kind === 'cmd' ? bindings.get(r.c.id) : null;
            return (
              <li key={r.key} role="presentation">
                {showHeader ? (
                  <div className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted">{r.section}</div>
                ) : null}
                <div
                  id={`${listId}-${r.key}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(r)}
                  className={cx(
                    'flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-1',
                    i === active && 'bg-hover',
                  )}
                >
                  <Icon
                    name={
                      r.kind === 'cmd' ? r.c.icon : r.hit.kind === 'database' ? 'grid' : 'paper'
                    }
                    size={16}
                    className="shrink-0 text-muted"
                  />
                  {r.kind === 'cmd' ? (
                    <span className="flex-1 truncate">{r.c.title}</span>
                  ) : (
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {r.hit.title.trim() === '' ? t('pages.untitled') : r.hit.title}
                      </span>
                      {r.hit.snippet ? (
                        <span className="block truncate text-xs text-muted">
                          <Highlighted text={r.hit.snippet} />
                        </span>
                      ) : null}
                    </span>
                  )}
                  {combo ? <Kbd combo={combo} /> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex gap-4 border-t border-line px-4 py-2 text-xs text-muted">
        <span>↑↓ {t('palette.hintNavigate')}</span>
        <span>↵ {t('palette.hintRun')}</span>
        <span>Esc {t('palette.hintClose')}</span>
      </div>
    </Dialog>
  );
}
