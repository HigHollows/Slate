import type { TFunction } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNav } from '../navigation';
import { usePagesStore } from '../pages';
import { useDatabasesStore } from './context';
import type { DatabasesStore } from './store';

/**
 * Modèle « liste de tâches » : une base ordinaire (mêmes vues, filtres, relations, pages complètes) munie des propriétés
 * d'une tâche. Une tâche reste ainsi UN seul objet, cohérent dans la liste, le kanban, le calendrier et sa page.
 * Les propriétés sont créées une à une : en cas d'échec en cours de route, l'erreur est signalée et la base garde ce qui existe.
 */
export async function applyTaskTemplate(
  store: DatabasesStore,
  dbId: string,
  t: TFunction,
): Promise<boolean> {
  const s = store.getState();
  await s.load(dbId, true);
  const base = store.getState().dbs[dbId];
  const firstView = base?.views[0];
  if (!base || !firstView) return false;

  const done = t('tasks.status.done');
  const add = (
    name: string,
    type: string,
    config: Record<string, unknown> = {},
    twoWayName?: string,
  ) => s.addProperty(dbId, { name, type, config, ...(twoWayName ? { twoWayName } : {}) });

  const status = await add(t('tasks.props.status'), 'status', {
    options: [
      { name: t('tasks.status.todo'), group: 'todo' },
      { name: t('tasks.status.doing'), group: 'doing' },
      { name: done, group: 'done' },
    ],
  });
  if (!status) return false;
  const steps: [string, string, Record<string, unknown>, string?][] = [
    [
      t('tasks.props.priority'),
      'select',
      {
        options: ['low', 'medium', 'high', 'urgent'].map((k) => ({
          name: t(`tasks.priority.${k}`),
        })),
      },
    ],
    [t('tasks.props.start'), 'date', { role: 'start' }],
    [t('tasks.props.due'), 'date', { role: 'due' }],
    [
      t('tasks.props.recurrence'),
      'select',
      {
        role: 'recurrence',
        options: ['daily', 'weekly', 'monthly', 'yearly'].map((k) => ({
          id: k,
          name: t(`tasks.recurrence.${k}`),
        })),
      },
    ],
    [t('tasks.props.reminder'), 'datetime', { role: 'reminder' }],
    [t('tasks.props.progress'), 'percent', { decimals: 0 }],
    [t('tasks.props.timeSpent'), 'number', { decimals: 0, suffix: ' min' }],
    [t('tasks.props.parent'), 'relation', { targetDatabaseId: dbId }, t('tasks.props.subtasks')],
    [t('tasks.props.blockedBy'), 'relation', { targetDatabaseId: dbId }, t('tasks.props.blocks')],
  ];
  let due: Awaited<ReturnType<typeof add>>;
  for (const [name, type, config, twoWay] of steps) {
    const p = await add(name, type, config, twoWay);
    if (!p) return false;
    if (name === t('tasks.props.due')) due = p;
  }
  if (!due) return false;
  const late = await add(t('tasks.props.late'), 'formula', {
    expression: `if(empty(prop("${t('tasks.props.due')}")), false, and(prop("${t('tasks.props.due')}") < today(), prop("${t('tasks.props.status')}") != "${done}"))`,
  });
  if (!late) return false;

  // Vues : la vue existante devient la liste (triée par échéance), plus un kanban par statut et un calendrier des échéances.
  await s.renameView(dbId, firstView.id, t('tasks.views.list'));
  s.patchViewConfig(dbId, firstView.id, { sorts: [{ propertyId: due.id, direction: 'asc' }] });
  const kanban = await s.addView(dbId, t('tasks.views.board'), 'kanban', { groupBy: status.id });
  const cal = await s.addView(dbId, t('tasks.views.calendar'), 'calendar', {
    dateProperty: due.id,
  });
  await s.flushViews();
  return Boolean(kanban && cal);
}

/** Crée une base « tâches » dans l'espace et l'ouvre. */
export function useCreateTaskList() {
  const { t } = useTranslation();
  const pages = usePagesStore();
  const databases = useDatabasesStore();
  return useCallback(async () => {
    const node = await pages.getState().createDatabase({
      parentId: null,
      title: t('tasks.title'),
      titlePropertyName: t('tasks.props.name'),
      viewName: t('databases.defaultView'),
    });
    if (!node) return undefined;
    const ok = await applyTaskTemplate(databases, node.id, t);
    useNav.getState().navigate({ name: 'database', id: node.id });
    return ok ? node : undefined;
  }, [pages, databases, t]);
}
