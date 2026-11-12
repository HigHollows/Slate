import { Icon, type IconName } from '@slate/icons';
import { useMemo, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, cx } from '../../shared/ui';
import { MAX_TABS, useNav, type Route, type Tab } from '../navigation';
import { displayTitle, usePages } from '../pages';

const routeOf = (t: Tab): Route => t.stack[t.index] as Route;
const ICON: Record<Route['name'], IconName> = {
  home: 'home',
  settings: 'gears',
  trash: 'trash',
  page: 'paper',
  database: 'grid',
};

/**
 * Onglets (à la Obsidian) : cliquer une page de l'arbre la montre dans l'onglet actif ; Ctrl/⌘+clic ou clic du milieu
 * l'ouvre dans un nouvel onglet. Chaque onglet a son historique. Glisser pour réordonner, clic droit pour fermer les autres.
 * Barre de navigation (et non « tablist ») : chaque onglet est un vrai bouton, avec son bouton de fermeture à côté.
 */
export function TabBar() {
  const { t } = useTranslation();
  const tabs = useNav((s) => s.tabs);
  const activeId = useNav((s) => s.activeId);
  const nodes = usePages((s) => s.nodes);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const nav = useNav;

  const titles = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return new Map(
      tabs.map((tab) => {
        const r = routeOf(tab);
        let title: string;
        if (r.name === 'home') title = t('nav.home');
        else if (r.name === 'settings') title = t('nav.settings');
        else if (r.name === 'trash') title = t('pages.trash');
        else {
          const n = byId.get(r.id);
          title = n ? displayTitle(n, t('pages.untitled')) : t('tabs.unavailable');
        }
        return [tab.id, title] as const;
      }),
    );
  }, [tabs, nodes, t]);

  const onKey = (e: KeyboardEvent, tab: Tab) => {
    if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      nav.getState().closeTab(tab.id);
    }
  };
  const onDrop = (e: DragEvent, target: Tab) => {
    e.preventDefault();
    const from = dragId;
    setDragId(null);
    setOverId(null);
    if (!from || from === target.id) return;
    nav.getState().moveTab(
      from,
      tabs.findIndex((x) => x.id === target.id),
    );
  };

  return (
    <nav
      aria-label={t('tabs.label')}
      className="shrink-0 border-b border-line bg-surface px-1.5 pt-1"
    >
      <ul className="flex items-end gap-0.5 overflow-x-auto">
        {tabs.map((tab, i) => {
          const active = tab.id === activeId;
          const title = titles.get(tab.id) ?? '';
          return (
            <li
              key={tab.id}
              draggable
              onDragStart={(e) => {
                setDragId(tab.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', tab.id);
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setOverId(tab.id);
              }}
              onDragLeave={() => setOverId((x) => (x === tab.id ? null : x))}
              onDrop={(e) => onDrop(e, tab)}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onContextMenu={(e: MouseEvent) => {
                e.preventDefault();
                setMenuFor(tab.id);
              }}
              className={cx(
                'group relative flex h-8 min-w-0 max-w-56 shrink-0 items-center rounded-t-md border border-b-0 transition-colors',
                active ? 'border-line bg-bg' : 'border-transparent hover:bg-hover',
                dragId === tab.id && 'opacity-40',
                overId === tab.id && dragId !== tab.id && 'ring-1 ring-accent',
              )}
            >
              <Menu
                open={menuFor === tab.id}
                onOpenChange={(o) => setMenuFor(o ? tab.id : null)}
                trigger={<span aria-hidden className="absolute inset-x-0 bottom-0 h-px" />}
                items={[
                  {
                    id: 'close',
                    label: t('tabs.close'),
                    onSelect: () => nav.getState().closeTab(tab.id),
                  },
                  {
                    id: 'others',
                    label: t('tabs.closeOthers'),
                    onSelect: () => nav.getState().closeOthers(tab.id),
                  },
                  ...(i < tabs.length - 1
                    ? [
                        {
                          id: 'right',
                          label: t('tabs.closeRight'),
                          onSelect: () => nav.getState().closeToRight(tab.id),
                        },
                      ]
                    : []),
                ]}
              />
              <button
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => nav.getState().activateTab(tab.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    nav.getState().closeTab(tab.id);
                  }
                }}
                onKeyDown={(e) => onKey(e, tab)}
                title={title}
                className={cx(
                  'flex h-full min-w-0 items-center gap-1.5 rounded-t-md pl-2.5 pr-1 text-[0.8125rem] outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  active ? 'font-medium' : 'text-muted',
                )}
              >
                <Icon name={ICON[routeOf(tab).name]} size={13} className="shrink-0" />
                <span className="truncate">{title}</span>
              </button>
              <button
                type="button"
                aria-label={t('tabs.closeNamed', { title })}
                onClick={() => nav.getState().closeTab(tab.id)}
                className={cx(
                  'mr-1 grid size-5 shrink-0 place-items-center rounded text-muted outline-none hover:bg-pressed hover:text-fg focus-visible:ring-2 focus-visible:ring-accent',
                  active
                    ? 'opacity-100'
                    : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                )}
              >
                <Icon name="cross" size={11} />
              </button>
            </li>
          );
        })}
        <li className="shrink-0 pb-0.5">
          <button
            type="button"
            aria-label={t('tabs.new')}
            title={tabs.length >= MAX_TABS ? t('tabs.max', { count: MAX_TABS }) : t('tabs.new')}
            disabled={tabs.length >= MAX_TABS}
            onClick={() => nav.getState().openTab({ name: 'home' })}
            className="grid size-7 place-items-center rounded-md text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
          >
            <Icon name="plus" size={14} />
          </button>
        </li>
      </ul>
    </nav>
  );
}
