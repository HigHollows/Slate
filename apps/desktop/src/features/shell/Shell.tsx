import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Command } from '../commands';
import { useNav } from '../navigation';
import { usePreferences, usePreferencesStore, type Preferences } from '../preferences';
import { SettingsPage } from '../settings';
import { PageView, useWritingMode, type EditorApi } from '../editor';
import { DatabasePage } from '../databases';
import { TrashPage, usePages, displayTitle } from '../pages';
import { ErrorBoundary, IconButton } from '../../shared/ui';
import { Home } from './Home';
import { Resizer } from './Resizer';
import { Sidebar } from './Sidebar';
import type { AppConfig } from '../../shared/config/env';
import type { Ipc } from '../../shared/ipc/client';

export function Shell({
  commands,
  config,
  ipc,
}: {
  commands: Command[];
  config: AppConfig;
  ipc: Pick<Ipc, 'systemInfo'> & EditorApi;
}) {
  const { t } = useTranslation();
  const store = usePreferencesStore();
  const collapsed = usePreferences((s) => s.prefs.sidebarCollapsed);
  const width = usePreferences((s) => s.prefs.sidebarWidth);
  const [preview, setPreview] = useState<number | null>(null);
  const route = useNav((s) => s.route);
  const focusMode = useWritingMode((s) => s.focusMode);
  const focus = focusMode && route.name === 'page';
  useEffect(() => {
    if (focusMode && route.name !== 'page') useWritingMode.getState().setFocusMode(false);
  }, [focusMode, route.name]);
  const pageNode = usePages((s) =>
    route.name === 'page' || route.name === 'database'
      ? s.nodes.find((n) => n.id === route.id)
      : undefined,
  );
  const { canBack, canForward, back, forward } = useNav();
  // L'échec est déjà signalé à l'utilisateur par le store (toast).
  const setPrefs = (patch: Partial<Preferences>) =>
    store
      .getState()
      .update(patch)
      .catch(() => undefined);

  return (
    <div className="flex h-full">
      {collapsed || focus ? null : (
        <>
          <aside style={{ width: preview ?? width }} className="relative h-full shrink-0">
            <Sidebar
              commands={commands}
              cloudEnabled={config.cloudEnabled}
              onCollapse={() => void setPrefs({ sidebarCollapsed: true })}
            />
            <Resizer
              width={preview ?? width}
              onPreview={setPreview}
              onCommit={(w) => {
                setPreview(null);
                void setPrefs({ sidebarWidth: w });
              }}
            />
          </aside>
        </>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header hidden={focus} className="flex h-11 shrink-0 items-center gap-1 px-3">
          {collapsed ? (
            <IconButton
              icon="menu"
              label={t('shell.showSidebar')}
              onClick={() => void setPrefs({ sidebarCollapsed: false })}
            />
          ) : null}
          <IconButton icon="arrow-left" label={t('nav.back')} disabled={!canBack} onClick={back} />
          <IconButton
            icon="arrow-right"
            label={t('nav.forward')}
            disabled={!canForward}
            onClick={forward}
          />
          <h1 className="ml-2 truncate font-medium">
            {route.name === 'home'
              ? t('nav.home')
              : route.name === 'settings'
                ? t('nav.settings')
                : route.name === 'trash'
                  ? t('pages.trash')
                  : route.name === 'database' || route.name === 'page'
                    ? pageNode
                      ? displayTitle(pageNode, t('pages.untitled'))
                      : t('pages.untitled')
                    : pageNode
                      ? displayTitle(pageNode, t('pages.untitled'))
                      : t('pages.untitled')}
          </h1>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ErrorBoundary title={t('errors.unknown')} retryLabel={t('system.retry')}>
            {route.name === 'home' ? <Home commands={commands} /> : null}
            {route.name === 'settings' ? (
              <SettingsPage commands={commands} ipc={ipc} config={config} />
            ) : null}
            {route.name === 'trash' ? <TrashPage /> : null}
            {route.name === 'database' ? <DatabasePage key={route.id} id={route.id} /> : null}
            {route.name === 'page' ? <PageView key={route.id} id={route.id} api={ipc} /> : null}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
