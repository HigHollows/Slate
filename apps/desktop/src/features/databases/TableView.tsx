import { Icon } from '@slate/icons';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNav } from '../navigation';
import { usePreferences } from '../preferences';
import { Button, IconButton, Menu, Popover, cx, toast } from '../../shared/ui';
import { CellDisplay, InlineInput, OptionPicker, RelationPicker, editorKind } from './cells';
import { useDatabasesStore } from './context';
import { aggregate, aggregationsFor } from './engine';
import type { QueryState } from './hooks';
import { formatNumber, typeDef } from './registry';
import {
  optionsOf,
  relationTarget,
  type Aggregation,
  type Property,
  type Row,
  type ViewConfig,
} from './types';
import { useDatabase } from './context';

const MIN_W = 80;
const DEFAULT_W = 180;
const SELECT_W = 36;
const ADD_W = 44;
interface Pos {
  r: number;
  c: number;
}

export function TableView({
  dbId,
  viewId,
  query,
  onEditProperty,
  onAddProperty,
  onNewRow,
}: {
  dbId: string;
  viewId: string;
  query: QueryState;
  onEditProperty(p: Property): void;
  onAddProperty(): void;
  onNewRow(): Promise<Row | undefined>;
}) {
  const { t, i18n } = useTranslation();
  const store = useDatabasesStore();
  const density = usePreferences((s) => s.prefs.density);
  const { rows, properties, config, ev } = {
    rows: query.rows,
    properties: query.properties,
    config: query.config,
    ev: query.evaluator,
  };
  const db = useDatabase(dbId);
  const rowH = density === 'compact' ? 30 : 38;

  const cols = useMemo(() => {
    const title = properties.find((p) => p.type === 'title');
    const rest = properties.filter((p) => p.type !== 'title' && !config.hidden.includes(p.id));
    return title ? [title, ...rest] : rest;
  }, [properties, config.hidden]);
  const [resizing, setResizing] = useState<{ id: string; w: number } | null>(null);
  const widthOf = (p: Property) =>
    resizing?.id === p.id
      ? resizing.w
      : (config.widths[p.id] ?? (p.type === 'title' ? 260 : DEFAULT_W));
  const template = `${SELECT_W}px ${cols.map((p) => `${widthOf(p)}px`).join(' ')} ${ADD_W}px`;
  const totalW = SELECT_W + cols.reduce((n, p) => n + widthOf(p), 0) + ADD_W;

  const [active, setActive] = useState<Pos | null>(null);
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; initial?: string } | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [pendingEdit, setPendingEdit] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowH,
    overscan: 10,
    initialRect: { width: 1200, height: 800 },
  });

  const patch = useCallback(
    (p: Partial<ViewConfig>) => store.getState().patchViewConfig(dbId, viewId, p),
    [store, dbId, viewId],
  );

  // Après création d'une ligne : curseur dans son titre.
  useEffect(() => {
    if (!pendingEdit) return;
    const i = rows.findIndex((r) => r.id === pendingEdit);
    if (i >= 0) {
      setPendingEdit(null);
      setActive({ r: i, c: 0 });
      setAnchor(null);
      setEditing({ r: i, c: 0 });
      virt.scrollToIndex(i);
    }
  }, [pendingEdit, rows, virt]);

  const clampPos = (p: Pos): Pos => ({
    r: Math.max(0, Math.min(rows.length - 1, p.r)),
    c: Math.max(0, Math.min(cols.length - 1, p.c)),
  });
  const moveTo = (p: Pos, extend = false) => {
    if (rows.length === 0 || cols.length === 0) return;
    const n = clampPos(p);
    if (extend) setAnchor((a) => a ?? active ?? n);
    else setAnchor(null);
    setActive(n);
    virt.scrollToIndex(n.r);
  };

  const lookupTitle = useMemo(() => query.ctx.relationTitle, [query.ctx.relationTitle]);

  const commit = async (pos: Pos, value: unknown): Promise<boolean> => {
    const row = rows[pos.r];
    const p = cols[pos.c];
    if (!row || !p) return false;
    if (p.type === 'title')
      return store.getState().setTitle(dbId, row.id, typeof value === 'string' ? value : '');
    return store.getState().setCells(dbId, [{ rowId: row.id, propertyId: p.id, value }]);
  };

  const range = useMemo(() => {
    if (!active) return null;
    const a = anchor ?? active;
    return {
      r0: Math.min(a.r, active.r),
      r1: Math.max(a.r, active.r),
      c0: Math.min(a.c, active.c),
      c1: Math.max(a.c, active.c),
    };
  }, [active, anchor]);

  const clearRange = async () => {
    if (!range) return;
    const changes = [];
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) {
        const p = cols[c];
        const row = rows[r];
        if (!p || !row || !typeDef(p.type).editable) continue;
        if (p.type === 'title') await store.getState().setTitle(dbId, row.id, '');
        else
          changes.push({
            rowId: row.id,
            propertyId: p.id,
            value: p.type === 'checkbox' ? false : null,
          });
      }
    }
    if (changes.length) await store.getState().setCells(dbId, changes);
  };

  const startEdit = (initial?: string) => {
    if (!active) return;
    const p = cols[active.c];
    if (!p) return;
    const kind = editorKind(p);
    if (kind === 'none') return;
    if (kind === 'toggle') {
      const row = rows[active.r];
      if (row) void commit(active, ev.raw(row, p) !== true);
      return;
    }
    if (kind === 'picker' && initial !== undefined) return;
    setEditing({ r: active.r, c: active.c, ...(initial !== undefined ? { initial } : {}) });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (editing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!active) {
      if (['ArrowDown', 'ArrowRight', 'Enter'].includes(e.key) && rows.length) {
        moveTo({ r: 0, c: 0 });
        e.preventDefault();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        moveTo({ r: active.r + 1, c: active.c }, e.shiftKey);
        break;
      case 'ArrowUp':
        moveTo({ r: active.r - 1, c: active.c }, e.shiftKey);
        break;
      case 'ArrowRight':
        moveTo({ r: active.r, c: active.c + 1 }, e.shiftKey);
        break;
      case 'ArrowLeft':
        moveTo({ r: active.r, c: active.c - 1 }, e.shiftKey);
        break;
      case 'Tab':
        moveTo({ r: active.r, c: active.c + (e.shiftKey ? -1 : 1) });
        break;
      case 'Home':
        moveTo({ r: active.r, c: 0 }, e.shiftKey);
        break;
      case 'End':
        moveTo({ r: active.r, c: cols.length - 1 }, e.shiftKey);
        break;
      case 'PageDown':
        moveTo({ r: active.r + 10, c: active.c }, e.shiftKey);
        break;
      case 'PageUp':
        moveTo({ r: active.r - 10, c: active.c }, e.shiftKey);
        break;
      case 'Enter':
      case 'F2':
        startEdit();
        break;
      case ' ': {
        const p = cols[active.c];
        if (p && editorKind(p) === 'toggle') startEdit();
        else if (p && editorKind(p) === 'picker') startEdit();
        else return;
        break;
      }
      case 'Delete':
      case 'Backspace':
        void clearRange();
        break;
      case 'Escape':
        setAnchor(null);
        setSelectedRows(new Set());
        break;
      case 'a':
        if (mod) {
          setAnchor({ r: 0, c: 0 });
          setActive({ r: rows.length - 1, c: cols.length - 1 });
          break;
        }
        if (!startTyping(e)) return;
        break;
      default:
        if (mod || !startTyping(e)) return;
    }
    e.preventDefault();
  };
  function startTyping(e: KeyboardEvent): boolean {
    if (e.key.length !== 1 || e.altKey || e.metaKey || e.ctrlKey) return false;
    const p = active ? cols[active.c] : undefined;
    if (!p || editorKind(p) !== 'input') return false;
    startEdit(e.key);
    return true;
  }

  // ── Presse-papiers (TSV) ──
  const onCopy = (e: ClipboardEvent) => {
    if (editing || !range) return;
    const lines: string[] = [];
    for (let r = range.r0; r <= range.r1; r++) {
      const cells: string[] = [];
      for (let c = range.c0; c <= range.c1; c++) {
        const row = rows[r];
        const p = cols[c];
        cells.push(row && p ? ev.text(row, p, i18n.language).replace(/[\t\r\n]+/g, ' ') : '');
      }
      lines.push(cells.join('\t'));
    }
    e.clipboardData.setData('text/plain', lines.join('\n'));
    e.preventDefault();
  };
  const onPaste = async (e: ClipboardEvent) => {
    if (editing || !active) return;
    const text = e.clipboardData.getData('text/plain');
    if (text === '') return;
    e.preventDefault();
    const matrix = text
      .replace(/\r\n/g, '\n')
      .replace(/\n$/, '')
      .split('\n')
      .map((l) => l.split('\t'));
    const changes: { rowId: string; propertyId: string; value: unknown }[] = [];
    const titles: { rowId: string; title: string }[] = [];
    let refused = 0;
    let skipped = 0;
    const rowIdByTitle = new Map<string, string>();
    for (const p of cols) {
      const target = p.type === 'relation' ? relationTarget(p) : null;
      if (target)
        for (const r of rowsOfDatabase(store, target))
          rowIdByTitle.set(r.title.trim().toLowerCase(), r.id);
    }
    matrix.forEach((cells, dr) =>
      cells.forEach((cell, dc) => {
        const row = rows[active.r + dr];
        const p = cols[active.c + dc];
        if (!row || !p) return skipped++;
        const def = typeDef(p.type);
        if (!def.editable) return skipped++;
        if (p.type === 'title') return void titles.push({ rowId: row.id, title: cell.trim() });
        const v = def.fromText(cell, p, (name) => rowIdByTitle.get(name.trim().toLowerCase()));
        if (v === undefined) return refused++;
        changes.push({ rowId: row.id, propertyId: p.id, value: v });
      }),
    );
    let ok = true;
    if (changes.length) ok = await store.getState().setCells(dbId, changes);
    for (const tt of titles) ok = (await store.getState().setTitle(dbId, tt.rowId, tt.title)) && ok;
    if (ok)
      toast.success(
        t('databases.pasted', { count: changes.length + titles.length, refused, skipped }),
      );
  };

  const deleteSelected = async () => {
    const ids = [...selectedRows];
    if (!ids.length) return;
    if (await store.getState().deleteRows(dbId, ids)) {
      setSelectedRows(new Set());
      setActive(null);
      toast.info(t('databases.rowsDeleted', { count: ids.length }), {
        label: t('pages.undo'),
        run: () => void store.getState().restoreRows(dbId, ids),
      });
    }
  };

  const toggleRow = (id: string) =>
    setSelectedRows((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = rows.length > 0 && rows.every((r) => selectedRows.has(r.id));

  // ── Colonnes ──
  const resizeStart = (e: React.PointerEvent, p: Property) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(p);
    (e.target as Element).setPointerCapture(e.pointerId);
    let w = startW;
    const move = (ev2: PointerEvent) => {
      w = Math.max(MIN_W, Math.min(900, startW + ev2.clientX - startX));
      setResizing({ id: p.id, w });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setResizing(null);
      if (w !== startW) patch({ widths: { ...config.widths, [p.id]: Math.round(w) } });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const setWidth = (p: Property, delta: number) =>
    patch({
      widths: { ...config.widths, [p.id]: Math.max(MIN_W, Math.min(900, widthOf(p) + delta)) },
    });
  const neighborMove = (p: Property, dir: -1 | 1) => {
    const order = properties.filter((x) => x.type !== 'title');
    const i = order.findIndex((x) => x.id === p.id);
    const before = dir === -1 ? order[i - 1] : order[i + 2];
    if (dir === -1 && !before) return;
    void store.getState().moveProperty(dbId, p.id, before?.id ?? null);
  };
  const sortBy = (p: Property, direction: 'asc' | 'desc') =>
    patch({ sorts: [{ propertyId: p.id, direction }] });
  const aggLabel = (a: Aggregation) => t(`databases.agg.${a}`);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} data-virtual-scroller className="relative min-h-0 flex-1 overflow-auto">
        <div style={{ width: totalW, minWidth: '100%' }} className="relative">
          <div
            ref={grid}
            role="grid"
            aria-label={t('databases.tableLabel')}
            aria-rowcount={rows.length + 1}
            aria-colcount={cols.length + 1}
            aria-multiselectable
            tabIndex={0}
            onKeyDown={onKeyDown}
            onCopy={onCopy}
            onPaste={(e) => void onPaste(e)}
            onFocus={(e) => {
              if (e.target === grid.current && !active && rows.length) setActive({ r: 0, c: 0 });
            }}
            className="relative outline-none"
          >
            {/* En-tête */}
            <div role="rowgroup" className="sticky top-0 z-20 bg-bg">
              <div
                role="row"
                aria-rowindex={1}
                className="grid border-b border-line bg-bg"
                style={{ gridTemplateColumns: template, height: 34 }}
              >
                <div role="columnheader" className="grid place-items-center">
                  <input
                    type="checkbox"
                    aria-label={t('databases.selectAll')}
                    checked={allSelected}
                    onChange={() =>
                      setSelectedRows(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
                    }
                    className="size-4 accent-[var(--accent)]"
                  />
                </div>
                {cols.map((p, ci) => {
                  const def = typeDef(p.type);
                  const sort = config.sorts.find((s) => s.propertyId === p.id);
                  return (
                    <div
                      key={p.id}
                      role="columnheader"
                      aria-colindex={ci + 2}
                      aria-sort={
                        sort ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
                      }
                      className={cx(
                        'group relative flex items-center border-l border-line',
                        ci === 0 && 'sticky left-0 z-10 bg-bg',
                      )}
                      style={ci === 0 ? { left: 0 } : undefined}
                    >
                      <Menu
                        trigger={
                          <button
                            type="button"
                            className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left font-medium text-muted hover:bg-hover hover:text-fg"
                          >
                            {def.icon ? (
                              <Icon name={def.icon} size={13} />
                            ) : (
                              <span
                                aria-hidden
                                className="w-3.5 text-center text-[0.6875rem] font-semibold"
                              >
                                {def.glyph}
                              </span>
                            )}
                            <span className="truncate">{p.name}</span>
                            {sort ? (
                              <Icon
                                name={sort.direction === 'asc' ? 'arrow-up' : 'arrow-down'}
                                size={12}
                              />
                            ) : null}
                          </button>
                        }
                        items={[
                          {
                            id: 'asc',
                            label: t('databases.sortAsc'),
                            onSelect: () => sortBy(p, 'asc'),
                          },
                          {
                            id: 'desc',
                            label: t('databases.sortDesc'),
                            onSelect: () => sortBy(p, 'desc'),
                          },
                          ...(sort
                            ? [
                                {
                                  id: 'nosort',
                                  label: t('databases.sortRemove'),
                                  onSelect: () =>
                                    patch({
                                      sorts: config.sorts.filter((s) => s.propertyId !== p.id),
                                    }),
                                },
                              ]
                            : []),
                          {
                            id: 'wider',
                            label: t('databases.widen'),
                            onSelect: () => setWidth(p, 40),
                          },
                          {
                            id: 'narrower',
                            label: t('databases.narrow'),
                            onSelect: () => setWidth(p, -40),
                          },
                          ...(p.type !== 'title'
                            ? [
                                {
                                  id: 'left',
                                  label: t('databases.moveLeft'),
                                  onSelect: () => neighborMove(p, -1),
                                },
                                {
                                  id: 'right',
                                  label: t('databases.moveRight'),
                                  onSelect: () => neighborMove(p, 1),
                                },
                                {
                                  id: 'hide',
                                  label: t('databases.hide'),
                                  onSelect: () => patch({ hidden: [...config.hidden, p.id] }),
                                },
                              ]
                            : []),
                          {
                            id: 'edit',
                            label: t('databases.editProperty'),
                            onSelect: () => onEditProperty(p),
                          },
                        ]}
                      />
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={t('databases.resizeColumn', { name: p.name })}
                        onPointerDown={(e) => resizeStart(e, p)}
                        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-accent/40"
                      />
                    </div>
                  );
                })}
                <div role="columnheader" className="grid place-items-center border-l border-line">
                  <IconButton
                    icon="plus"
                    label={t('databases.addProperty')}
                    onClick={onAddProperty}
                  />
                </div>
              </div>
            </div>

            {/* Corps virtualisé */}
            <div role="rowgroup" style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {virt.getVirtualItems().map((vi) => {
                const row = rows[vi.index];
                if (!row) return null;
                const isSel = selectedRows.has(row.id);
                return (
                  <div
                    key={row.id}
                    role="row"
                    aria-rowindex={vi.index + 2}
                    aria-selected={isSel}
                    className={cx(
                      'absolute left-0 grid border-b border-line',
                      isSel && 'bg-accent/10',
                    )}
                    style={{
                      transform: `translateY(${vi.start}px)`,
                      height: rowH,
                      gridTemplateColumns: template,
                      width: '100%',
                    }}
                  >
                    <div role="gridcell" className="grid place-items-center">
                      <input
                        type="checkbox"
                        aria-label={t('databases.selectRow', {
                          title: row.title || t('pages.untitled'),
                        })}
                        checked={isSel}
                        onChange={() => toggleRow(row.id)}
                        className="size-4 accent-[var(--accent)]"
                      />
                    </div>
                    {cols.map((p, ci) => {
                      const isActive = active?.r === vi.index && active.c === ci;
                      const inRange =
                        range &&
                        vi.index >= range.r0 &&
                        vi.index <= range.r1 &&
                        ci >= range.c0 &&
                        ci <= range.c1 &&
                        !(range.r0 === range.r1 && range.c0 === range.c1);
                      const isEditing = editing?.r === vi.index && editing.c === ci;
                      const kind = editorKind(p);
                      return (
                        <div
                          key={p.id}
                          role="gridcell"
                          aria-colindex={ci + 2}
                          aria-selected={isActive}
                          aria-readonly={kind === 'none'}
                          data-cell={`${vi.index}:${ci}`}
                          onMouseDown={(e) => {
                            if (isEditing) return;
                            grid.current?.focus({ preventScroll: true });
                            if (e.shiftKey && active) setAnchor((a) => a ?? active);
                            else setAnchor(null);
                            setActive({ r: vi.index, c: ci });
                            if (kind === 'toggle' && !e.shiftKey)
                              void commit({ r: vi.index, c: ci }, ev.raw(row, p) !== true);
                          }}
                          onDoubleClick={() => {
                            if (kind === 'input' || kind === 'picker')
                              setEditing({ r: vi.index, c: ci });
                          }}
                          className={cx(
                            'relative flex min-w-0 items-center overflow-hidden border-l border-line px-2',
                            ci === 0 && 'sticky left-0 z-[5] bg-bg',
                            isActive && 'cell-active',
                            inRange && 'cell-range',
                            kind === 'none' && 'text-muted',
                          )}
                        >
                          {isEditing && kind === 'input' ? (
                            <InlineInput
                              row={row}
                              prop={p}
                              ev={ev}
                              initial={editing.initial}
                              className="-mx-2 px-2"
                              onCommit={(v) => {
                                void commit({ r: vi.index, c: ci }, v);
                                setEditing(null);
                                grid.current?.focus({ preventScroll: true });
                                moveTo({ r: vi.index + 1, c: ci });
                              }}
                              onCancel={() => {
                                setEditing(null);
                                grid.current?.focus({ preventScroll: true });
                              }}
                              onTab={(dir) => {
                                setEditing(null);
                                grid.current?.focus({ preventScroll: true });
                                moveTo({ r: vi.index, c: ci + dir });
                              }}
                            />
                          ) : isEditing && kind === 'picker' ? (
                            <PickerCell
                              dbId={dbId}
                              row={row}
                              prop={p}
                              onDone={() => {
                                setEditing(null);
                                grid.current?.focus({ preventScroll: true });
                              }}
                              commit={(v) => commit({ r: vi.index, c: ci }, v)}
                            >
                              <CellDisplay
                                row={row}
                                prop={p}
                                ev={ev}
                                locale={i18n.language}
                                relationTitle={lookupTitle}
                              />
                            </PickerCell>
                          ) : (
                            <CellDisplay
                              row={row}
                              prop={p}
                              ev={ev}
                              locale={i18n.language}
                              relationTitle={lookupTitle}
                            />
                          )}
                          {ci === 0 ? (
                            <button
                              type="button"
                              tabIndex={-1}
                              aria-label={t('databases.openRow', {
                                title: row.title || t('pages.untitled'),
                              })}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={() =>
                                useNav.getState().navigate({ name: 'page', id: row.id })
                              }
                              className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs text-muted opacity-0 hover:bg-hover hover:text-fg group-hover:opacity-100 focus:opacity-100 [div:hover>&]:opacity-100"
                            >
                              {t('databases.open')}
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                    <div role="gridcell" className="border-l border-line" />
                  </div>
                );
              })}
            </div>
          </div>

          {rows.length === 0 ? (
            <p role="status" className="px-4 py-6 text-muted">
              {query.total === 0 ? t('databases.noRowsYet') : t('databases.noMatch')}
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => void onNewRow().then((r) => r && setPendingEdit(r.id))}
            className="flex h-9 w-full items-center gap-2 border-b border-line px-3 text-left text-muted hover:bg-hover hover:text-fg"
          >
            <Icon name="plus" size={14} />
            {t('databases.newRow')}
          </button>

          {/* Pied : agrégations */}
          <div
            role="group"
            aria-label={t('databases.calculations')}
            className="sticky bottom-0 z-20 grid border-t border-line bg-bg"
            style={{ gridTemplateColumns: template, height: 32 }}
          >
            <div />
            {cols.map((p, ci) => {
              const agg = config.aggregations[p.id] ?? 'none';
              const val = agg === 'none' ? null : aggregate(rows, p, agg, ev);
              const shown =
                val === null
                  ? ''
                  : agg.startsWith('percent')
                    ? `${Math.round(val * 10) / 10} %`
                    : p.type === 'number' || p.type === 'percent' || p.type === 'formula'
                      ? p.type === 'formula'
                        ? String(Math.round(val * 1000) / 1000)
                        : formatNumber(val, p, i18n.language)
                      : String(Math.round(val * 1000) / 1000);
              return (
                <div
                  key={p.id}
                  className={cx(
                    'flex items-center border-l border-line',
                    ci === 0 && 'sticky left-0 z-10 bg-bg',
                  )}
                >
                  <Menu
                    trigger={
                      <button
                        type="button"
                        aria-label={t('databases.aggregateFor', { name: p.name })}
                        className="flex h-full w-full items-center gap-1.5 px-2 text-left text-xs text-muted hover:bg-hover hover:text-fg"
                      >
                        {agg === 'none' ? (
                          <span className="opacity-0 hover:opacity-100 focus:opacity-100">
                            {t('databases.calculate')}
                          </span>
                        ) : (
                          <>
                            <span>{aggLabel(agg)}</span>
                            <span className="font-medium text-fg tabular-nums">{shown}</span>
                          </>
                        )}
                      </button>
                    }
                    items={aggregationsFor(p).map((a) => ({
                      id: a,
                      label: aggLabel(a),
                      onSelect: () =>
                        patch({ aggregations: { ...config.aggregations, [p.id]: a } }),
                    }))}
                  />
                </div>
              );
            })}
            <div />
          </div>
        </div>
      </div>

      {selectedRows.size > 0 ? (
        <div
          role="status"
          className="flex items-center gap-3 border-t border-line bg-surface px-4 py-2"
        >
          <span>{t('databases.selectedRows', { count: selectedRows.size })}</span>
          <Button variant="danger" icon="trash" onClick={() => void deleteSelected()}>
            {t('databases.deleteRows')}
          </Button>
          <Button variant="ghost" onClick={() => setSelectedRows(new Set())}>
            {t('databases.deselect')}
          </Button>
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {db?.status === 'error' ? t('databases.loadFailed') : ''}
      </span>
    </div>
  );
}

function rowsOfDatabase(store: ReturnType<typeof useDatabasesStore>, dbId: string): Row[] {
  return store.getState().dbs[dbId]?.rows ?? [];
}

/** Sélecteur d'options / de lignes ancré à la cellule en cours d'édition. */
function PickerCell({
  dbId,
  row,
  prop,
  onDone,
  commit,
  children,
}: {
  dbId: string;
  row: Row;
  prop: Property;
  onDone(): void;
  commit(v: unknown): Promise<boolean>;
  children: React.ReactNode;
}) {
  const store = useDatabasesStore();
  const value = row.props[prop.id];
  const create = async (name: string): Promise<string | undefined> => {
    const options = [...optionsOf(prop), { id: '', name, color: 'gray' }].map((o) =>
      o.id === '' ? { name: o.name, color: 'gray' } : o,
    );
    const updated = await store
      .getState()
      .updateProperty(dbId, prop.id, { config: { ...prop.config, options } });
    return optionsOf(updated ?? prop).find((o) => o.name === name)?.id;
  };
  return (
    <Popover
      open
      onOpenChange={(o) => !o && onDone()}
      label={prop.name}
      trigger={<div className="flex min-w-0 flex-1 items-center">{children}</div>}
    >
      {prop.type === 'relation' ? (
        <RelationPicker
          prop={prop}
          value={value}
          onChange={(v) => void commit(v)}
          onClose={onDone}
        />
      ) : (
        <OptionPicker
          prop={prop}
          value={value}
          onChange={(v) => void commit(v)}
          onCreate={create}
          onClose={onDone}
        />
      )}
    </Popover>
  );
}
