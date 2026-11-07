import { Icon, type IconName } from '@slate/icons';
import { useTranslation } from 'react-i18next';
import { useCommandsState, useCommandsStore, resolveBindings, type Command } from '../commands';
import { useNav } from '../navigation';
import { useAccount } from '../account';
import { PagesSidebar, usePages, usePagesStore } from '../pages';
import { IconButton, Kbd, cx } from '../../shared/ui';
import { Logo } from './Logo';
import { useMemo } from 'react';

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: IconName;
  label: string;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex h-[var(--row-h)] w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-hover',
        active ? 'bg-pressed font-medium' : 'text-muted hover:text-fg',
      )}
    >
      <Icon name={icon} size={16} />
      <span className="truncate">{label}</span>
    </button>
  );
}

export function Sidebar({
  commands,
  cloudEnabled,
  onCollapse,
}: {
  commands: Command[];
  cloudEnabled: boolean;
  onCollapse(): void;
}) {
  const { t } = useTranslation();
  const route = useNav((s) => s.route);
  const account = useAccount((s) =>
    s.status === 'signedIn' || s.status === 'offline' ? s.email : null,
  );
  const navigate = useNav((s) => s.navigate);
  const workspaces = usePages((s) => s.workspaces);
  const workspaceId = usePages((s) => s.workspaceId);
  const pagesStore = usePagesStore();
  const store = useCommandsStore();
  const overrides = useCommandsState((s) => s.overrides);
  const paletteCombo = useMemo(
    () => resolveBindings(commands, overrides).get('palette.open') ?? null,
    [commands, overrides],
  );

  return (
    <nav aria-label={t('shell.navigation')} className="flex h-full flex-col gap-3 bg-surface p-2.5">
      <div className="flex h-8 items-center justify-between pl-1.5">
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo size={18} />
          {t('app.name')}
        </span>
        <IconButton icon="menu" label={t('shell.hideSidebar')} onClick={onCollapse} />
      </div>

      <button
        type="button"
        onClick={() => store.getState().setPaletteOpen(true)}
        className="flex h-[var(--row-h)] items-center gap-2 rounded-md border border-line bg-elevated px-2 text-muted transition-colors hover:text-fg"
      >
        <Icon name="search" size={15} />
        <span className="flex-1 text-left">{t('shell.search')}</span>
        {paletteCombo ? <Kbd combo={paletteCombo} /> : null}
      </button>

      <div className="flex flex-col gap-0.5">
        <NavItem
          icon="home"
          label={t('nav.home')}
          active={route.name === 'home'}
          onClick={() => navigate({ name: 'home' })}
        />
        <NavItem
          icon="gears"
          label={t('nav.settings')}
          active={route.name === 'settings'}
          onClick={() => navigate({ name: 'settings', tab: 'appearance' })}
        />
      </div>

      {workspaces.length > 1 ? (
        <select
          aria-label={t('sharing.switcher')}
          value={workspaceId ?? ''}
          onChange={(e) => void pagesStore.getState().setWorkspace(e.target.value)}
          className="h-[var(--row-h)] rounded-md border border-line bg-elevated px-2 outline-none focus-visible:border-accent"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      ) : null}

      <PagesSidebar />

      <div className="flex items-center gap-2 px-1.5 text-xs text-muted" role="status">
        <span
          aria-hidden
          className={cx('size-2 rounded-full', cloudEnabled ? 'bg-fg' : 'bg-muted')}
        />
        {account
          ? t('status.account', { email: account })
          : cloudEnabled
            ? t('status.cloudIdle')
            : t('status.local')}
      </div>
    </nav>
  );
}
