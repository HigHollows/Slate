import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cx } from '../../shared/ui';
import { useDatabasesStore } from './context';
import {
  addDays,
  completionRate,
  currentStreak,
  localDay,
  longestStreak,
  weeklyGoalMet,
} from './habits';
import type { Property, Row } from './types';

const WINDOW = 90;
const SHOWN = 7;

/** Suivi quotidien des habitudes d'une base (propriété au rôle `habit_goal`) : 7 derniers jours, série, taux sur 30 jours. */
export function HabitTracker({
  dbId,
  rows,
  goalProp,
}: {
  dbId: string;
  rows: Row[];
  goalProp: Property;
}) {
  const { t, i18n } = useTranslation();
  const store = useDatabasesStore();
  const today = localDay(new Date());
  const [log, setLog] = useState<Map<string, Set<string>> | null>(null);

  const reload = useCallback(async () => {
    const list = await store.getState().habitDays(dbId, addDays(today, -WINDOW), addDays(today, 1));
    const m = new Map<string, Set<string>>();
    for (const e of list) (m.get(e.rowId) ?? m.set(e.rowId, new Set()).get(e.rowId)!).add(e.day);
    setLog(m);
  }, [store, dbId, today]);
  useEffect(() => void reload(), [reload]);

  const days = useMemo(
    () => Array.from({ length: SHOWN }, (_, i) => addDays(today, i - (SHOWN - 1))),
    [today],
  );
  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }),
    [i18n.language],
  );

  const toggle = async (rowId: string, day: string, was: boolean) => {
    // Optimiste, annulé si le cœur refuse.
    const apply = (on: boolean) =>
      setLog((cur) => {
        const m = new Map(cur ?? []);
        const set = new Set(m.get(rowId) ?? []);
        if (on) set.add(day);
        else set.delete(day);
        m.set(rowId, set);
        return m;
      });
    apply(!was);
    if (!(await store.getState().setHabitDay(rowId, day, !was, today))) apply(was);
  };

  if (rows.length === 0) return <p className="px-6 py-3 text-muted">{t('habits.empty')}</p>;
  return (
    <section aria-label={t('habits.tracker')} className="px-6 py-2">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">
              {t('habits.habit')}
            </th>
            {days.map((d) => (
              <th
                key={d}
                scope="col"
                className={cx(
                  'w-12 py-1 text-center font-normal',
                  d === today ? 'text-fg' : 'text-muted',
                )}
              >
                {fmt.format(new Date(`${d}T00:00:00Z`))}
              </th>
            ))}
            <th scope="col" className="py-1 pl-3 font-normal text-muted">
              {t('habits.streak')}
            </th>
            <th scope="col" className="py-1 pl-3 font-normal text-muted">
              {t('habits.rate')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const set = log?.get(r.id) ?? new Set<string>();
            const goal = Number(r.props[goalProp.id] ?? 7) || 7;
            return (
              <tr key={r.id} className="border-t border-line">
                <th scope="row" className="py-1.5 pr-3 font-normal">
                  {r.title || t('pages.untitled')}
                  {log && weeklyGoalMet(set, today, goal) ? (
                    <span className="ml-2 text-xs text-muted">{t('habits.goalMet')}</span>
                  ) : null}
                </th>
                {days.map((d) => {
                  const on = set.has(d);
                  return (
                    <td key={d} className="text-center">
                      <button
                        type="button"
                        aria-pressed={on}
                        aria-label={t('habits.toggle', {
                          name: r.title,
                          day: fmt.format(new Date(`${d}T00:00:00Z`)),
                        })}
                        disabled={log === null}
                        onClick={() => void toggle(r.id, d, on)}
                        className={cx(
                          'size-6 rounded-md border border-line',
                          on ? 'bg-accent' : 'hover:bg-hover',
                        )}
                      />
                    </td>
                  );
                })}
                <td className="pl-3 tabular-nums">
                  {log ? t('habits.days', { count: currentStreak(set, today) }) : '…'}
                </td>
                <td
                  className="pl-3 tabular-nums"
                  title={t('habits.best', { count: longestStreak(set) })}
                >
                  {log ? `${Math.round(completionRate(set, today, 30) * 100)} %` : '…'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
