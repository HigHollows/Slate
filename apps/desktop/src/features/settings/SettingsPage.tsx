import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '@slate/icons';
import type { Command } from '../commands';
import { useNav, type SettingsTab } from '../navigation';
import { cx } from '../../shared/ui';
import { AboutTab } from './AboutTab';
import { AppearanceTab } from './AppearanceTab';
import { LanguageTab } from './LanguageTab';
import { AccountTab } from '../account';
import { SecurityTab } from '../security';
import { ShortcutsTab } from './ShortcutsTab';
import type { AppConfig } from '../../shared/config/env';
import type { Ipc } from '../../shared/ipc/client';

const TABS: { id: SettingsTab; icon: IconName }[] = [
  { id: 'appearance', icon: 'palette' },
  { id: 'language', icon: 'globe' },
  { id: 'account', icon: 'user' },
  { id: 'security', icon: 'lock' },
  { id: 'shortcuts', icon: 'code' },
  { id: 'about', icon: 'info' },
];

export function SettingsPage({
  commands,
  ipc,
  config,
}: {
  commands: Command[];
  ipc: Pick<Ipc, 'systemInfo'>;
  config: AppConfig;
}) {
  const { t } = useTranslation();
  const route = useNav((s) => s.route);
  const navigate = useNav((s) => s.navigate);
  const tab: SettingsTab = route.name === 'settings' ? route.tab : 'appearance';
  return (
    <div className="mx-auto flex max-w-4xl gap-8 px-8 py-4">
      <nav aria-label={t('nav.settings')} className="flex w-44 shrink-0 flex-col gap-0.5">
        {TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-current={tab === x.id ? 'page' : undefined}
            onClick={() => navigate({ name: 'settings', tab: x.id })}
            className={cx(
              'flex h-[var(--row-h)] items-center gap-2.5 rounded-md px-2 text-left hover:bg-hover',
              tab === x.id ? 'bg-pressed font-medium' : 'text-muted hover:text-fg',
            )}
          >
            <Icon name={x.icon} size={16} />
            {t(`settings.tabs.${x.id}`)}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {tab === 'appearance' ? <AppearanceTab /> : null}
        {tab === 'language' ? <LanguageTab /> : null}
        {tab === 'account' ? <AccountTab /> : null}
        {tab === 'security' ? <SecurityTab /> : null}
        {tab === 'shortcuts' ? <ShortcutsTab commands={commands} /> : null}
        {tab === 'about' ? <AboutTab ipc={ipc} config={config} /> : null}
      </div>
    </div>
  );
}
