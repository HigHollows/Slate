import { useTranslation } from 'react-i18next';
import { Button, EmptyState, Kbd } from '../../shared/ui';
import { useCommandsState, useCommandsStore, resolveBindings, type Command } from '../commands';
import { useCreateGoalList, useCreateHabitTracker, useCreateTaskList } from '../databases';
import { useNav } from '../navigation';

export function Home({ commands }: { commands: Command[] }) {
  const { t } = useTranslation();
  const store = useCommandsStore();
  const overrides = useCommandsState((s) => s.overrides);
  const createTaskList = useCreateTaskList();
  const createGoalList = useCreateGoalList();
  const createHabits = useCreateHabitTracker();
  const combo = resolveBindings(commands, overrides).get('palette.open');
  return (
    <div className="grid h-full place-items-center p-8">
      <EmptyState icon="sparkles" title={t('home.title')} description={t('home.description')}>
        <Button
          variant="primary"
          icon="search"
          onClick={() => store.getState().setPaletteOpen(true)}
        >
          {t('home.openPalette')}
          {combo ? <Kbd combo={combo} /> : null}
        </Button>
        <Button
          icon="palette"
          onClick={() => useNav.getState().navigate({ name: 'settings', tab: 'appearance' })}
        >
          {t('home.customize')}
        </Button>
        <Button icon="tasks" onClick={() => void createTaskList()}>
          {t('tasks.newList')}
        </Button>
        <Button icon="star" onClick={() => void createGoalList()}>
          {t('goals.newList')}
        </Button>
        <Button icon="check" onClick={() => void createHabits()}>
          {t('habits.newTracker')}
        </Button>
      </EmptyState>
    </div>
  );
}
