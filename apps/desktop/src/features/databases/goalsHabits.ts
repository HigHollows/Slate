import type { TFunction } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNav } from '../navigation';
import { usePagesStore } from '../pages';
import { useDatabasesStore } from './context';
import type { DatabasesStore } from './store';

/**
 * Modèle « objectifs » : une base ordinaire (statut, échéance, progression saisie à la main, sous-objectifs).
 * La progression n'est PAS calculée à partir des sous-objectifs (les cumuls n'existent pas encore) : elle se saisit.
 */
export async function applyGoalTemplate(
  store: DatabasesStore,
  dbId: string,
  t: TFunction,
): Promise<boolean> {
  const s = store.getState();
  await s.load(dbId, true);
  const base = store.getState().dbs[dbId];
  const firstView = base?.views[0];
  if (!base || !firstView) return false;
  const add = (
    name: string,
    type: string,
    config: Record<string, unknown> = {},
    twoWayName?: string,
  ) => s.addProperty(dbId, { name, type, config, ...(twoWayName ? { twoWayName } : {}) });

  const status = await add(t('goals.props.status'), 'status', {
    options: [
      { name: t('goals.status.todo'), group: 'todo' },
      { name: t('goals.status.doing'), group: 'doing' },
      { name: t('goals.status.done'), group: 'done' },
    ],
  });
  if (!status) return false;
  const due = await add(t('goals.props.due'), 'date', { role: 'due' });
  if (!due) return false;
  if (!(await add(t('goals.props.progress'), 'percent', { decimals: 0 }))) return false;
  if (
    !(await add(
      t('goals.props.parent'),
      'relation',
      { targetDatabaseId: dbId },
      t('goals.props.children'),
    ))
  )
    return false;
  await s.renameView(dbId, firstView.id, t('goals.views.list'));
  s.patchViewConfig(dbId, firstView.id, { sorts: [{ propertyId: due.id, direction: 'asc' }] });
  const board = await s.addView(dbId, t('goals.views.board'), 'kanban', { groupBy: status.id });
  await s.flushViews();
  return Boolean(board);
}

/**
 * Modèle « habitudes » : une base dont la propriété numérique « Objectif / semaine » porte le rôle `habit_goal`.
 * Le suivi quotidien s'affiche au-dessus des vues ; seuls les pointages sont stockés.
 */
export async function applyHabitTemplate(
  store: DatabasesStore,
  dbId: string,
  t: TFunction,
): Promise<boolean> {
  const s = store.getState();
  await s.load(dbId, true);
  const firstView = store.getState().dbs[dbId]?.views[0];
  if (!firstView) return false;
  const goal = await s.addProperty(dbId, {
    name: t('habits.props.goal'),
    type: 'number',
    config: { decimals: 0, role: 'habit_goal' },
  });
  if (!goal) return false;
  await s.renameView(dbId, firstView.id, t('habits.views.list'));
  await s.flushViews();
  return true;
}

function useCreate(
  apply: (store: DatabasesStore, id: string, t: TFunction) => Promise<boolean>,
  title: string,
  nameKey: string,
) {
  const { t } = useTranslation();
  const pages = usePagesStore();
  const databases = useDatabasesStore();
  return useCallback(async () => {
    const node = await pages.getState().createDatabase({
      parentId: null,
      title: t(title),
      titlePropertyName: t(nameKey),
      viewName: t('databases.defaultView'),
    });
    if (!node) return undefined;
    const ok = await apply(databases, node.id, t);
    useNav.getState().navigate({ name: 'database', id: node.id });
    return ok ? node : undefined;
  }, [pages, databases, t, apply, title, nameKey]);
}

export const useCreateGoalList = () =>
  useCreate(applyGoalTemplate, 'goals.title', 'goals.props.name');
export const useCreateHabitTracker = () =>
  useCreate(applyHabitTemplate, 'habits.title', 'habits.props.name');
