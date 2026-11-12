import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNav, type SettingsTab } from '../navigation';
import { useCreateGoalList, useCreateHabitTracker, useCreateTaskList } from '../databases';
import { useSecurity, useSecurityStore } from '../security';
import { duplicatePage, pageMarkdown, useWritingMode, type EditorApi } from '../editor';
import { toast } from '../../shared/ui';
import { useNodeActions, usePagesStore } from '../pages';
import { FONT_SCALES, usePreferences, usePreferencesStore, type Preferences } from '../preferences';
import type { Command } from './model';
import { useCommandsStore } from './context';

export const commandTitleKey = (id: string) => `command.${id.replace(/[.-]/g, '_')}`;

/** Liste des commandes réellement disponibles (chacune est câblée à une action existante). */
export function useCommands(api?: Pick<EditorApi, 'pageGet' | 'pageSave'>): Command[] {
  const { t } = useTranslation();
  const nav = useNav;
  const prefsStore = usePreferencesStore();
  const commandsStore = useCommandsStore();
  const scale = usePreferences((s) => s.prefs.fontScale);
  const collapsed = usePreferences((s) => s.prefs.sidebarCollapsed);
  const route = useNav((s) => s.route);
  const pages = usePagesStore();
  const nodeActions = useNodeActions();
  const createTaskList = useCreateTaskList();
  const createGoalList = useCreateGoalList();
  const createHabits = useCreateHabitTracker();
  const securityStore = useSecurityStore();
  const pinEnabled = useSecurity((x) => x.lock?.enabled === true);

  return useMemo(() => {
    // L'échec est déjà signalé à l'utilisateur par le store (toast) : on n'ajoute rien ici.
    const update = (patch: Partial<Preferences>) =>
      prefsStore
        .getState()
        .update(patch)
        .catch(() => undefined);
    const title = (id: string) => t(commandTitleKey(id));
    const go = (tab: SettingsTab) => () => nav.getState().navigate({ name: 'settings', tab });
    const stepScale = (dir: 1 | -1 | 0) => () => {
      const i = FONT_SCALES.findIndex((s) => s === scale);
      const next =
        dir === 0
          ? 1
          : FONT_SCALES[Math.min(FONT_SCALES.length - 1, Math.max(0, (i < 0 ? 1 : i) + dir))];
      if (next !== undefined) void update({ fontScale: next });
    };
    const mk = (c: Omit<Command, 'title'>): Command => ({ ...c, title: title(c.id) });
    return [
      mk({
        id: 'palette.open',
        group: 'navigation',
        icon: 'search',
        defaultShortcut: 'Mod+k',
        hidden: true,
        run: () => commandsStore.getState().setPaletteOpen(true),
      }),
      mk({
        id: 'nav.home',
        group: 'navigation',
        icon: 'home',
        keywords: ['accueil', 'home'],
        run: () => nav.getState().navigate({ name: 'home' }),
      }),
      mk({
        id: 'page.new',
        group: 'navigation',
        icon: 'plus',
        defaultShortcut: 'Mod+n',
        keywords: ['create', 'créer', 'page', 'note'],
        run: () => void nodeActions.createPage(null),
      }),
      mk({
        id: 'journal.today',
        group: 'navigation',
        icon: 'calendar',
        defaultShortcut: 'Mod+Alt+j',
        keywords: ['journal', 'jour', 'today', 'daily', 'aujourd', 'note du jour'],
        run: () => void nodeActions.openToday(),
      }),
      mk({
        id: 'database.new',
        group: 'navigation',
        icon: 'grid',
        keywords: ['create', 'créer', 'base', 'database', 'tableau', 'table'],
        run: () => void nodeActions.createDatabase(null),
      }),
      mk({
        id: 'tasks.new',
        group: 'navigation',
        icon: 'tasks',
        keywords: ['task', 'tâche', 'todo', 'projet', 'project'],
        run: () => void createTaskList(),
      }),
      mk({
        id: 'goals.new',
        group: 'navigation',
        icon: 'star',
        keywords: ['goal', 'objectif', 'okr'],
        run: () => void createGoalList(),
      }),
      mk({
        id: 'habits.new',
        group: 'navigation',
        icon: 'check',
        keywords: ['habit', 'habitude', 'routine', 'série', 'streak'],
        run: () => void createHabits(),
      }),
      ...(pinEnabled
        ? [
            mk({
              id: 'security.lock',
              group: 'navigation',
              icon: 'lock',
              defaultShortcut: 'Mod+l',
              keywords: ['pin', 'lock', 'verrouiller', 'sécurité'],
              run: () => void securityStore.getState().lockNow(),
            }),
          ]
        : []),
      mk({
        id: 'folder.new',
        group: 'navigation',
        icon: 'folder',
        keywords: ['create', 'créer', 'dossier', 'folder'],
        run: () => void nodeActions.createFolder(null),
      }),
      mk({
        id: 'nav.trash',
        group: 'navigation',
        icon: 'trash',
        keywords: ['trash', 'corbeille', 'restore', 'restaurer'],
        run: () => nav.getState().navigate({ name: 'trash' }),
      }),
      ...(route.name === 'page' && api
        ? [
            mk({
              id: 'page.duplicate',
              group: 'navigation',
              icon: 'paper',
              keywords: ['duplicate', 'dupliquer', 'copie', 'clone'],
              run: () =>
                void duplicatePage(api, pages, route.id, t('pages.copySuffix')).then((row) => {
                  if (row) useNav.getState().navigate({ name: 'page', id: row.id });
                }),
            }),
            mk({
              id: 'page.markdown',
              group: 'navigation',
              icon: 'paper',
              keywords: ['markdown', 'export', 'exporter', 'copier', 'copy'],
              run: () => {
                const node = pages.getState().nodes.find((n) => n.id === route.id);
                void pageMarkdown(api, route.id, node?.title ?? '').then(
                  (md) =>
                    navigator.clipboard.writeText(md).then(
                      () => toast.success(t('pages.markdownCopied')),
                      () => toast.error(t('pages.markdownFailed')),
                    ),
                  () => toast.error(t('pages.markdownFailed')),
                );
              },
            }),
          ]
        : []),
      ...(route.name === 'page'
        ? [
            mk({
              id: 'page.favorite',
              group: 'navigation',
              icon: 'star',
              keywords: ['favorite', 'favori'],
              run: () => void pages.getState().toggleFavorite(route.id),
            }),
          ]
        : []),
      mk({
        id: 'nav.back',
        group: 'navigation',
        icon: 'arrow-left',
        defaultShortcut: 'Mod+[',
        run: () => nav.getState().back(),
      }),
      mk({
        id: 'nav.forward',
        group: 'navigation',
        icon: 'arrow-right',
        defaultShortcut: 'Mod+]',
        run: () => nav.getState().forward(),
      }),
      mk({
        id: 'nav.settings',
        group: 'navigation',
        icon: 'gears',
        defaultShortcut: 'Mod+,',
        keywords: ['settings', 'préférences', 'options'],
        run: go('appearance'),
      }),
      mk({
        id: 'nav.settings-language',
        group: 'navigation',
        icon: 'globe',
        keywords: ['language', 'langue'],
        run: go('language'),
      }),
      mk({
        id: 'nav.settings-shortcuts',
        group: 'navigation',
        icon: 'code',
        keywords: ['keyboard', 'clavier'],
        run: go('shortcuts'),
      }),
      mk({
        id: 'nav.settings-about',
        group: 'navigation',
        icon: 'info',
        keywords: ['system', 'système', 'version'],
        run: go('about'),
      }),
      mk({
        id: 'view.toggle-sidebar',
        group: 'view',
        icon: 'menu',
        defaultShortcut: 'Mod+\\',
        keywords: ['sidebar', 'barre latérale'],
        run: () => void update({ sidebarCollapsed: !collapsed }),
      }),
      mk({
        id: 'editor.toolbar',
        group: 'view',
        icon: 'pen',
        keywords: ['barre', 'toolbar', 'mise en forme', 'formatting'],
        run: () => void update({ toolbarCollapsed: !prefsStore.getState().prefs.toolbarCollapsed }),
      }),
      mk({
        id: 'editor.read',
        group: 'view',
        icon: 'paper',
        defaultShortcut: 'Mod+Shift+e',
        keywords: ['lecture', 'read', 'lecture seule', 'read-only'],
        run: () => useWritingMode.getState().toggleReadMode(),
      }),
      mk({
        id: 'editor.focus',
        group: 'view',
        icon: 'sparkles',
        defaultShortcut: 'Mod+Shift+f',
        keywords: ['focus', 'concentration', 'zen', 'distraction'],
        run: () => useWritingMode.getState().toggleFocusMode(),
      }),
      ...(['narrow', 'normal', 'wide', 'full'] as const).map((w) =>
        mk({
          id: `editor.width-${w}`,
          group: 'view',
          icon: 'grid',
          keywords: ['largeur', 'width', 'lecture'],
          run: () => void update({ readingWidth: w }),
        }),
      ),
      mk({
        id: 'view.zoom-in',
        group: 'view',
        icon: 'plus',
        defaultShortcut: 'Mod+=',
        keywords: ['zoom', 'text size'],
        run: stepScale(1),
      }),
      mk({
        id: 'view.zoom-out',
        group: 'view',
        icon: 'minus',
        defaultShortcut: 'Mod+-',
        run: stepScale(-1),
      }),
      mk({
        id: 'view.zoom-reset',
        group: 'view',
        icon: 'search',
        defaultShortcut: 'Mod+0',
        run: stepScale(0),
      }),
      mk({
        id: 'theme.light',
        group: 'appearance',
        icon: 'sun',
        keywords: ['theme', 'clair'],
        run: () => void update({ theme: 'light' }),
      }),
      mk({
        id: 'theme.dark',
        group: 'appearance',
        icon: 'moon',
        keywords: ['theme', 'sombre'],
        run: () => void update({ theme: 'dark' }),
      }),
      mk({
        id: 'theme.system',
        group: 'appearance',
        icon: 'color-theme',
        keywords: ['theme', 'auto'],
        run: () => void update({ theme: 'system' }),
      }),
      mk({
        id: 'density.compact',
        group: 'appearance',
        icon: 'list',
        keywords: ['density', 'densité'],
        run: () => void update({ density: 'compact' }),
      }),
      mk({
        id: 'density.comfortable',
        group: 'appearance',
        icon: 'grid',
        keywords: ['density', 'densité'],
        run: () => void update({ density: 'comfortable' }),
      }),
      mk({
        id: 'locale.fr',
        group: 'language',
        icon: 'globe',
        keywords: ['français', 'french', 'langue'],
        run: () => void update({ locale: 'fr' }),
      }),
      mk({
        id: 'locale.en',
        group: 'language',
        icon: 'globe',
        keywords: ['english', 'anglais', 'language'],
        run: () => void update({ locale: 'en' }),
      }),
    ];
  }, [
    t,
    prefsStore,
    commandsStore,
    scale,
    collapsed,
    nav,
    route,
    pages,
    nodeActions,
    createTaskList,
    createGoalList,
    createHabits,
    pinEnabled,
    securityStore,
    api,
  ]);
}
