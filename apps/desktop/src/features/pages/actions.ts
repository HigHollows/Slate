import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNav } from '../navigation';
import { toast } from '../../shared/ui';
import { descendantIds, displayTitle } from './model';
import { usePagesStore } from './context';

/** Actions partagées par la barre latérale, la palette et les vues (une seule logique, plusieurs entrées). */
export function useNodeActions() {
  const store = usePagesStore();
  const { t } = useTranslation();

  const open = useCallback(
    (id: string, opts?: { newTab?: boolean; background?: boolean }) => {
      const kind = store.getState().nodes.find((n) => n.id === id)?.kind;
      const route =
        kind === 'database' ? ({ name: 'database', id } as const) : ({ name: 'page', id } as const);
      // Nouvel onglet : Ctrl/⌘+clic, clic du milieu ou menu ; sinon la page remplace celle de l'onglet actif.
      if (opts?.newTab)
        useNav.getState().openTab(route, opts.background ? { background: true } : undefined);
      else useNav.getState().navigate(route);
    },
    [store],
  );

  /** Note du jour : la page « AAAA-MM-JJ » du dossier « Journal » (créés au besoin), puis on l'ouvre. Idempotent. */
  const openToday = useCallback(async () => {
    const day = new Date().toLocaleDateString('sv-SE'); // AAAA-MM-JJ, date LOCALE
    const nodes = () => store.getState().nodes;
    let folder = nodes().find(
      (n) => n.kind === 'folder' && n.parentId === null && n.title === 'Journal',
    );
    folder ??= await store
      .getState()
      .createNode({ parentId: null, kind: 'folder', title: 'Journal' });
    if (!folder) return undefined;
    let page = nodes().find(
      (n) => n.kind === 'page' && n.parentId === folder.id && n.title === day,
    );
    page ??= await store.getState().createNode({ parentId: folder.id, kind: 'page', title: day });
    if (page) useNav.getState().navigate({ name: 'page', id: page.id });
    return page;
  }, [store]);

  const createPage = useCallback(
    async (parentId: string | null = null) => {
      const row = await store.getState().createNode({ parentId, kind: 'page' });
      if (row) useNav.getState().navigate({ name: 'page', id: row.id });
      return row;
    },
    [store],
  );

  const createDatabase = useCallback(
    async (parentId: string | null = null) => {
      const row = await store.getState().createDatabase({
        parentId,
        title: '',
        titlePropertyName: t('databases.titleProperty'),
        viewName: t('databases.defaultView'),
      });
      if (row) useNav.getState().navigate({ name: 'database', id: row.id });
      return row;
    },
    [store, t],
  );

  const createFolder = useCallback(
    (parentId: string | null = null) =>
      store.getState().createNode({ parentId, kind: 'folder', title: t('pages.newFolder') }),
    [store, t],
  );

  /** Met à la corbeille avec possibilité d'annuler. Si la page ouverte disparaît, retour à l'accueil. */
  const remove = useCallback(
    async (id: string) => {
      const s = store.getState();
      const node = s.nodes.find((n) => n.id === id);
      if (!node) return;
      const gone = descendantIds(s.nodes, id).add(id);
      const count = await s.remove(id);
      if (count === undefined) return;
      const route = useNav.getState().route;
      if ((route.name === 'page' || route.name === 'database') && gone.has(route.id))
        useNav.getState().navigate({ name: 'home' });
      toast.info(t('pages.movedToTrash', { title: displayTitle(node, t('pages.untitled')) }), {
        label: t('pages.undo'),
        run: () => {
          void store.getState().restore(id);
        },
      });
    },
    [store, t],
  );

  return { open, createPage, createDatabase, createFolder, remove, openToday };
}
