import { Icon } from '@slate/icons';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNav } from '../navigation';
import { IconButton, cx } from '../../shared/ui';
import type { NodeRow } from '../../shared/ipc/client';
import { useNodeActions } from './actions';
import { usePages } from './context';
import { displayTitle } from './model';
import { PageTree } from './PageTree';

function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section aria-label={title} className="flex min-h-0 flex-col">
      <div className="group flex h-6 items-center justify-between pl-1.5 pr-0.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 text-xs font-medium text-muted hover:text-fg"
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
          {title}
        </button>
        <span className="flex opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          {actions}
        </span>
      </div>
      {open ? <div className="min-h-0 overflow-y-auto">{children}</div> : null}
    </section>
  );
}

function NodeLink({ node }: { node: NodeRow }) {
  const { t } = useTranslation();
  const route = useNav((s) => s.route);
  const { open } = useNodeActions();
  const current = (route.name === 'page' || route.name === 'database') && route.id === node.id;
  return (
    <button
      type="button"
      onClick={() => open(node.id)}
      aria-current={current ? 'page' : undefined}
      className={cx(
        'flex h-[var(--row-h)] w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover',
        current && 'bg-pressed font-medium',
      )}
    >
      <Icon
        name={node.kind === 'database' ? 'grid' : 'paper'}
        size={15}
        className="shrink-0 text-muted"
      />
      <span className={cx('truncate', node.title.trim() === '' && 'text-muted')}>
        {displayTitle(node, t('pages.untitled'))}
      </span>
    </button>
  );
}

/** Favoris, récents et arbre des pages : sections repliables, vides masquées pour garder la barre compacte. */
export function PagesSidebar() {
  const { t } = useTranslation();
  const nodes = usePages((s) => s.nodes);
  const recents = usePages((s) => s.recents);
  const actions = useNodeActions();
  const canEdit = usePages((s) => s.canEdit);
  const guest = usePages((s) => s.workspaceId !== null && s.guestSpaces.includes(s.workspaceId));
  const favorites = nodes.filter((n) => n.isFavorite && n.kind !== 'folder');
  const route = useNav((s) => s.route);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
      {favorites.length > 0 ? (
        <Section title={t('pages.favorites')}>
          {favorites.map((n) => (
            <NodeLink key={n.id} node={n} />
          ))}
        </Section>
      ) : null}
      {recents.length > 0 ? (
        <Section title={t('pages.recents')}>
          {recents.slice(0, 5).map((n) => (
            <NodeLink key={n.id} node={n} />
          ))}
        </Section>
      ) : null}
      <Section
        title={t('pages.title')}
        actions={
          canEdit && !guest ? (
            <>
              <IconButton
                icon="grid"
                label={t('pages.newDatabase')}
                className="size-6"
                onClick={() => void actions.createDatabase(null)}
              />
              <IconButton
                icon="folder"
                label={t('pages.newFolder')}
                className="size-6"
                onClick={() => void actions.createFolder(null)}
              />
              <IconButton
                icon="plus"
                label={t('pages.newPage')}
                className="size-6"
                onClick={() => void actions.createPage(null)}
              />
            </>
          ) : undefined
        }
      >
        <PageTree />
      </Section>
      <button
        type="button"
        onClick={() => useNav.getState().navigate({ name: 'trash' })}
        aria-current={route.name === 'trash' ? 'page' : undefined}
        className={cx(
          'mt-auto flex h-[var(--row-h)] w-full items-center gap-2.5 rounded-md px-2 text-left text-muted hover:bg-hover hover:text-fg',
          route.name === 'trash' && 'bg-pressed font-medium text-fg',
        )}
      >
        <Icon name="trash" size={16} />
        {t('pages.trash')}
      </button>
    </div>
  );
}
