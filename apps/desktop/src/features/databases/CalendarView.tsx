import { Icon } from '@slate/icons';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNav } from '../navigation';
import { Button, EmptyState, IconButton, Menu, Segmented, cx } from '../../shared/ui';
import {
  addDays,
  addMonths,
  dayOfValue,
  monthGrid,
  moveValueToDay,
  todayLocal,
  weekDays,
  type Ymd,
} from './calendar';
import { useDatabasesStore } from './context';
import type { QueryState } from './hooks';
import type { Property, Row, ViewConfig } from './types';

const open = (id: string) => useNav.getState().navigate({ name: 'page', id });
const isDateProp = (p: Property) => p.type === 'date' || p.type === 'datetime';

/** Propriété date de la vue : choisie, sinon la première date/date-heure. */
export function dateProperty(q: QueryState): Property | undefined {
  return (
    q.properties.find((p) => p.id === q.config.dateProperty && isDateProp(p)) ??
    q.properties.find(isDateProp)
  );
}

/** Calendrier mensuel/hebdomadaire d'une base : mêmes lignes que les autres vues, déplacement = modification de la date. */
export function CalendarView({
  dbId,
  query,
  patch,
  onNewRow,
  onAddProperty,
}: {
  dbId: string;
  query: QueryState;
  patch(p: Partial<ViewConfig>): void;
  onNewRow(props?: Record<string, unknown>): Promise<Row | undefined>;
  onAddProperty(): void;
}) {
  const { t, i18n } = useTranslation();
  const store = useDatabasesStore();
  const [cursor, setCursor] = useState<Ymd>(() => todayLocal());
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<Ymd | null>(null);
  const dp = dateProperty(query);
  const mode = query.config.calendarMode;
  const today = todayLocal();

  const byDay = useMemo(() => {
    const map = new Map<Ymd, Row[]>();
    const undated: Row[] = [];
    if (!dp) return { map, undated };
    for (const r of query.rows) {
      const day = dayOfValue(r.props[dp.id], dp.type);
      if (!day) undated.push(r);
      else map.set(day, [...(map.get(day) ?? []), r]);
    }
    return { map, undated };
  }, [query.rows, dp]);

  if (!dp) {
    return (
      <div className="grid flex-1 place-items-center p-8">
        <EmptyState
          icon="calendar"
          title={t('databases.calendarNeedsDate')}
          description={t('databases.calendarNeedsDateHint')}
        >
          <Button variant="primary" onClick={onAddProperty}>
            {t('databases.addProperty')}
          </Button>
        </EmptyState>
      </div>
    );
  }

  const fmt = (opts: Intl.DateTimeFormatOptions, ymd: Ymd) =>
    new Intl.DateTimeFormat(i18n.language, { ...opts, timeZone: 'UTC' }).format(
      new Date(`${ymd}T00:00:00Z`),
    );
  const title =
    mode === 'month'
      ? fmt({ month: 'long', year: 'numeric' }, cursor)
      : t('databases.weekOf', { date: fmt({ dateStyle: 'long' }, weekDays(cursor)[0] as Ymd) });
  const step = (dir: -1 | 1) =>
    setCursor((c) => (mode === 'month' ? addMonths(c, dir) : addDays(c, dir * 7)));
  const weeks = mode === 'month' ? monthGrid(cursor) : [weekDays(cursor)];
  const weekdayNames = weekDays('2026-06-15').map((d) => fmt({ weekday: 'short' }, d));
  const inMonth = (d: Ymd) => d.slice(0, 7) === cursor.slice(0, 7);

  const moveRow = (rowId: string, day: Ymd) => {
    const row = query.rows.find((r) => r.id === rowId);
    if (!row) return;
    const prev = dayOfValue(row.props[dp.id], dp.type);
    if (prev === day) return;
    void store
      .getState()
      .setCells(dbId, [
        { rowId, propertyId: dp.id, value: moveValueToDay(row.props[dp.id], dp.type, day) },
      ]);
  };

  const card = (r: Row, day: Ymd) => (
    <div
      key={r.id}
      draggable
      onDragStart={(e) => {
        setDragId(r.id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', r.id);
      }}
      onDragEnd={() => {
        setDragId(null);
        setOver(null);
      }}
      className={cx(
        'group/card flex items-center gap-1 rounded-md border border-line bg-elevated px-1.5 py-0.5',
        dragId === r.id && 'opacity-40',
      )}
    >
      <button
        type="button"
        onClick={() => open(r.id)}
        className="min-w-0 flex-1 truncate text-left text-xs"
      >
        {r.title.trim() === '' ? t('pages.untitled') : r.title}
      </button>
      <Menu
        trigger={
          <button
            type="button"
            aria-label={t('databases.moveDateOf', { title: r.title || t('pages.untitled') })}
            className="grid size-5 shrink-0 place-items-center rounded text-muted opacity-0 hover:bg-hover focus:opacity-100 group-hover/card:opacity-100"
          >
            <Icon name="calendar" size={12} />
          </button>
        }
        items={[
          {
            id: 'prev',
            label: t('databases.dayBefore'),
            onSelect: () => moveRow(r.id, addDays(day, -1)),
          },
          {
            id: 'next',
            label: t('databases.dayAfter'),
            onSelect: () => moveRow(r.id, addDays(day, 1)),
          },
          {
            id: 'week',
            label: t('databases.weekAfter'),
            onSelect: () => moveRow(r.id, addDays(day, 7)),
          },
          { id: 'today', label: t('databases.moveToToday'), onSelect: () => moveRow(r.id, today) },
        ]}
      />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pb-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 aria-live="polite" className="min-w-40 text-base font-semibold capitalize">
          {title}
        </h2>
        <IconButton icon="chevron-left" label={t('databases.previous')} onClick={() => step(-1)} />
        <Button onClick={() => setCursor(today)}>{t('databases.today')}</Button>
        <IconButton icon="chevron-right" label={t('databases.next')} onClick={() => step(1)} />
        <span className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-muted">
            {t('databases.dateProperty')}
            <select
              aria-label={t('databases.dateProperty')}
              className="h-8 rounded-md border border-line bg-surface px-2 text-fg"
              value={dp.id}
              onChange={(e) => patch({ dateProperty: e.target.value })}
            >
              {query.properties.filter(isDateProp).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Segmented
            label={t('databases.calendarMode')}
            value={mode}
            onChange={(m) => patch({ calendarMode: m })}
            options={[
              { value: 'month', label: t('databases.month') },
              { value: 'week', label: t('databases.week') },
            ]}
          />
        </span>
      </div>

      <div
        role="grid"
        aria-label={t('databases.calendarLabel')}
        className="grid min-h-0 flex-1 grid-rows-[auto_1fr] overflow-hidden rounded-lg border border-line"
      >
        <div role="row" className="grid grid-cols-7 border-b border-line bg-surface">
          {weekdayNames.map((n) => (
            <div
              key={n}
              role="columnheader"
              className="px-2 py-1 text-xs font-medium capitalize text-muted"
            >
              {n}
            </div>
          ))}
        </div>
        <div
          className="grid min-h-0 overflow-y-auto"
          style={{
            gridTemplateRows: `repeat(${weeks.length}, minmax(${mode === 'week' ? 240 : 96}px, 1fr))`,
          }}
        >
          {weeks.map((week) => (
            <div key={week[0]} role="row" className="grid grid-cols-7">
              {week.map((day) => {
                const rows = byDay.map.get(day) ?? [];
                const shown = mode === 'month' ? rows.slice(0, 3) : rows;
                return (
                  <div
                    key={day}
                    role="gridcell"
                    aria-label={`${fmt({ dateStyle: 'full' }, day)}${rows.length ? ` — ${t('databases.itemCount', { count: rows.length })}` : ''}`}
                    onDragOver={(e) => {
                      if (dragId) {
                        e.preventDefault();
                        setOver(day);
                      }
                    }}
                    onDragLeave={() => setOver((o) => (o === day ? null : o))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setOver(null);
                      if (dragId) moveRow(dragId, day);
                      setDragId(null);
                    }}
                    className={cx(
                      'group/day flex min-h-0 flex-col gap-0.5 border-b border-r border-line p-1',
                      mode === 'month' && !inMonth(day) && 'bg-surface/60 text-muted',
                      over === day && 'bg-accent/10 ring-1 ring-inset ring-accent',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        aria-hidden
                        className={cx(
                          'grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs',
                          day === today && 'bg-accent font-semibold text-accent-fg',
                        )}
                      >
                        {Number(day.slice(8))}
                      </span>
                      <button
                        type="button"
                        aria-label={t('databases.addOn', { date: fmt({ dateStyle: 'long' }, day) })}
                        onClick={() =>
                          void onNewRow({ [dp.id]: moveValueToDay(null, dp.type, day) })
                        }
                        className="grid size-5 place-items-center rounded text-muted opacity-0 hover:bg-hover focus:opacity-100 group-hover/day:opacity-100"
                      >
                        <Icon name="plus" size={12} />
                      </button>
                    </div>
                    {shown.map((r) => card(r, day))}
                    {mode === 'month' && rows.length > shown.length ? (
                      <button
                        type="button"
                        onClick={() => {
                          setCursor(day);
                          patch({ calendarMode: 'week' });
                        }}
                        className="px-1 text-left text-xs text-muted hover:text-fg"
                      >
                        {t('databases.moreItems', { count: rows.length - shown.length })}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {byDay.undated.length > 0 ? (
        <section aria-label={t('databases.undated')} className="mt-3">
          <h3 className="mb-1 text-xs font-medium text-muted">
            {t('databases.undated')} · {byDay.undated.length}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {byDay.undated.slice(0, 30).map((r) => (
              <span
                key={r.id}
                className="flex items-center gap-1 rounded-md border border-line bg-elevated px-1.5 py-0.5"
              >
                <button
                  type="button"
                  onClick={() => open(r.id)}
                  className="max-w-48 truncate text-xs"
                >
                  {r.title.trim() === '' ? t('pages.untitled') : r.title}
                </button>
                <button
                  type="button"
                  aria-label={t('databases.scheduleToday', {
                    title: r.title || t('pages.untitled'),
                  })}
                  onClick={() => moveRow(r.id, today)}
                  className="grid size-5 place-items-center rounded text-muted hover:bg-hover"
                >
                  <Icon name="calendar" size={12} />
                </button>
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
