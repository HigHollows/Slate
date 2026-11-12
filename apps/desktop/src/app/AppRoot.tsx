import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import {
  CommandPalette,
  CommandsProvider,
  useCommands,
  useGlobalShortcuts,
  type CommandsStore,
} from '../features/commands';
import { PreferencesProvider, type PreferencesStore } from '../features/preferences';
import { useReminders, type RemindersApi } from '../features/reminders';
import { AccountProvider, type AccountStore } from '../features/account';
import { SyncProvider, useSyncScheduler, type SyncControl, type SyncStore } from '../features/sync';
import { Shell } from '../features/shell';
import {
  LockGate,
  SecurityProvider,
  type SecurityApi,
  type SecurityStore,
} from '../features/security';
import { DatabasesProvider, type DatabasesApi, type DatabasesStore } from '../features/databases';
import { PagesProvider, type PagesStore } from '../features/pages';
import { PresenceProvider, installCloseGuard, type EditorApi } from '../features/editor';
import type { PresenceService } from '../shared/presence';
import { UpdatesProvider, useAutoUpdateCheck, type UpdatesStore } from '../features/updates';
import { useTabsPersistence } from '../features/navigation';
import type { AppConfig } from '../shared/config/env';
import { detectLocale, i18n as i18nInstance } from '../shared/i18n';
import type { Ipc } from '../shared/ipc/client';
import { Toaster, TooltipProvider, toast } from '../shared/ui';

export interface AppDeps {
  preferences: PreferencesStore;
  commands: CommandsStore;
  pages: PagesStore;
  databases: DatabasesStore;
  security: SecurityStore;
  account: AccountStore;
  sync: { store: SyncStore; control: SyncControl };
  /** Présence en direct ; absent = éditeur purement local. */
  presence?: PresenceService | null;
  /** Mises à jour de l'application (module Tauri signé). */
  updates: UpdatesStore;
  onError: (e: unknown) => void;
  ipc: Pick<Ipc, 'systemInfo' | 'settingsGetAll' | 'settingsSet' | 'searchPages'> &
    EditorApi &
    DatabasesApi &
    SecurityApi &
    RemindersApi;
  config: AppConfig;
}

function Workspace({ deps }: { deps: AppDeps }) {
  const { i18n, t } = useTranslation();
  const commands = useCommands(deps.ipc);
  const locale = useStore(deps.preferences, (s) => s.prefs.locale);
  useGlobalShortcuts(commands);

  const searchContent = useCallback(
    async (q: string) => {
      const ws = deps.pages.getState().workspaceId;
      return ws ? deps.ipc.searchPages(ws, q) : [];
    },
    [deps],
  );

  useEffect(() => {
    void i18n.changeLanguage(locale === 'auto' ? detectLocale(navigator.language) : locale);
  }, [locale, i18n]);
  useEffect(() => {
    document.documentElement.lang = i18n.language;
    document.title = t('app.name');
  }, [i18n.language, t]);

  return (
    <>
      <Shell commands={commands} config={deps.config} ipc={deps.ipc} />
      <CommandPalette commands={commands} searchContent={searchContent} />
    </>
  );
}

/** Chargement des données : monté seulement APRÈS le déverrouillage (le cœur refuse toute donnée tant que le PIN n'est pas saisi). */
function DataBoot({ deps }: { deps: AppDeps }) {
  useEffect(() => {
    void deps.preferences.getState().hydrate();
    void deps.pages.getState().init();
    void deps.account.getState().init();
    let off: (() => void) | undefined;
    let closed = false;
    void installCloseGuard(() => toast.error(i18nInstance.t('editor.closeBlocked')), {
      pending: () => deps.databases.getState().hasPendingViews(),
      flush: () => deps.databases.getState().flushViews(),
    }).then((u) => {
      if (closed) u();
      else off = u;
    });
    deps.ipc.settingsGetAll().then(
      (rows) => deps.commands.getState().hydrate(rows),
      () => undefined, // l'échec est déjà signalé par l'hydratation des préférences
    );
    return () => {
      closed = true;
      off?.();
    };
  }, [deps]);
  useReminders(deps.ipc, deps.onError);
  useSyncScheduler(deps.sync.control);
  useAutoUpdateCheck(deps.updates);
  useTabsPersistence(deps.ipc, deps.onError);
  return <Workspace deps={deps} />;
}

export function AppRoot({ deps }: { deps: AppDeps }) {
  return (
    <PreferencesProvider store={deps.preferences}>
      <SecurityProvider store={deps.security}>
        <AccountProvider store={deps.account}>
          <SyncProvider value={deps.sync}>
            <CommandsProvider store={deps.commands}>
              <PagesProvider store={deps.pages}>
                <DatabasesProvider store={deps.databases}>
                  <TooltipProvider>
                    <PresenceProvider value={deps.presence ?? null}>
                      <UpdatesProvider store={deps.updates}>
                        <LockGate>
                          <DataBoot deps={deps} />
                        </LockGate>
                      </UpdatesProvider>
                    </PresenceProvider>
                    <Toaster />
                  </TooltipProvider>
                </DatabasesProvider>
              </PagesProvider>
            </CommandsProvider>
          </SyncProvider>
        </AccountProvider>
      </SecurityProvider>
    </PreferencesProvider>
  );
}
