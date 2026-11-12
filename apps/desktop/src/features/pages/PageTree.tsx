import { Icon } from '@slate/icons';
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNav } from '../navigation';
import { IconButton, Menu, cx } from '../../shared/ui';
import { bus } from '../../shared/bus';
import type { NodeRow } from '../../shared/ipc/client';
import { useNodeActions } from './actions';
import { usePages, usePagesStore } from './context';
import { MoveDialog } from './MoveDialog';
import {
  buildTree,
  computeDrop,
  displayTitle,
  flattenVisible,
  zoneFromOffset,
  type DropZone,
  type TreeItem,
} from './model';

interface Hint {
  id: string;
  zone: DropZone;
}

export function PageTree() {
  const { t } = useTranslation();
  const store = usePagesStore();
  const nodes = usePages((s) => s.nodes);
  const expandedList = usePages((s) => s.expanded);
  const status = usePages((s) => s.status);
  const route = useNav((s) => s.route);
  const actions = useNodeActions();

  const expanded = useMemo(() => new Set(expandedList), [expandedList]);
  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const rows = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const canEdit = usePages((s) => s.canEdit);
  const isAdmin = usePages((s) => s.role === 'admin');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [moving, setMoving] = useState<NodeRow | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());

  const currentId = route.name === 'page' || route.name === 'database' ? route.id : null;
  const tabbable =
    focusId && rows.some((r) => r.node.id === focusId)
      ? focusId
      : currentId && rows.some((r) => r.node.id === currentId)
        ? currentId
        : rows[0]?.node.id;

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    refs.current.get(id)?.focus();
  };

  const activate = (n: NodeRow) => {
    setFocusId(n.id);
    if (n.kind === 'folder') store.getState().setExpanded(n.id, !expanded.has(n.id));
    else actions.open(n.id);
  };

  const onKey = (e: KeyboardEvent, item: TreeItem, index: number) => {
    if (renaming) return;
    const n = item.node;
    const hasKids = item.children.length > 0;
    switch (e.key) {
      case 'ArrowDown':
        focusRow(rows[index + 1]?.node.id);
        break;
      case 'ArrowUp':
        focusRow(rows[index - 1]?.node.id);
        break;
      case 'Home':
        focusRow(rows[0]?.node.id);
        break;
      case 'End':
        focusRow(rows[rows.length - 1]?.node.id);
        break;
      case 'ArrowRight':
        if (hasKids && !expanded.has(n.id)) store.getState().setExpanded(n.id, true);
        else if (hasKids) focusRow(item.children[0]?.node.id);
        break;
      case 'ArrowLeft':
        if (hasKids && expanded.has(n.id)) store.getState().setExpanded(n.id, false);
        else if (n.parentId) focusRow(n.parentId);
        break;
      case 'Enter':
      case ' ':
        activate(n);
        break;
      case 'F2':
        setRenaming(n.id);
        break;
      case 'Delete':
        void actions.remove(n.id);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // ── Glisser-déposer ──
  const onDragOver = (e: DragEvent, id: string) => {
    if (!dragId) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zone = zoneFromOffset(e.clientY - rect.top, rect.height);
    if (!computeDrop(nodes, dragId, id, zone)) {
      setHint(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setHint((h) => (h && h.id === id && h.zone === zone ? h : { id, zone }));
  };
  const onDrop = (e: DragEvent, id: string) => {
    e.preventDefault();
    const h = hint;
    setHint(null);
    if (!dragId || !h) return;
    const target = computeDrop(nodes, dragId, id, h.zone);
    if (target) void store.getState().move(dragId, target.parentId, target.beforeId);
    setDragId(null);
  };
  const endDrag = () => {
    setDragId(null);
    setHint(null);
  };

  if (status === 'loading' || status === 'idle') {
    return (
      <p role="status" className="px-2 py-1 text-xs text-muted">
        {t('pages.loading')}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="px-2 py-3 text-xs text-muted">
        <p>{t('pages.emptyTree')}</p>
        <button
          type="button"
          onClick={() => void actions.createPage(null)}
          className="mt-2 font-medium text-fg underline underline-offset-2"
        >
          {t('pages.newPage')}
        </button>
      </div>
    );
  }

  return (
    <>
      <div role="tree" aria-label={t('pages.treeLabel')} className="flex flex-col gap-px">
        {rows.map((item, index) => {
          const n = item.node;
          const isOpen = expanded.has(n.id);
          const hasKids = item.children.length > 0;
          const selected = n.id === currentId;
          const h = hint?.id === n.id ? hint.zone : null;
          const title = displayTitle(n, t('pages.untitled'));
          return (
            <div
              key={n.id}
              ref={(el) => {
                if (el) refs.current.set(n.id, el);
                else refs.current.delete(n.id);
              }}
              role="treeitem"
              aria-level={item.depth + 1}
              aria-expanded={n.kind === 'folder' || hasKids ? isOpen : undefined}
              aria-selected={selected}
              tabIndex={n.id === tabbable ? 0 : -1}
              draggable={canEdit && renaming !== n.id}
              onDragStart={(e) => {
                setDragId(n.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', n.id);
              }}
              onDragOver={(e) => onDragOver(e, n.id)}
              onDragLeave={() => setHint((x) => (x?.id === n.id ? null : x))}
              onDrop={(e) => onDrop(e, n.id)}
              onDragEnd={endDrag}
              onKeyDown={(e) => onKey(e, item, index)}
              onFocus={() => setFocusId(n.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuFor(n.id);
              }}
              style={{ paddingLeft: 4 + item.depth * 14 }}
              className={cx(
                'group relative flex h-[var(--row-h)] items-center gap-1 rounded-md pr-1 outline-none transition-colors hover:bg-hover focus-visible:outline-2',
                selected && 'bg-pressed font-medium',
                dragId === n.id && 'opacity-40',
                h === 'inside' && 'bg-accent/15 ring-1 ring-accent',
              )}
            >
              {h === 'before' || h === 'after' ? (
                <span
                  aria-hidden
                  className={cx(
                    'pointer-events-none absolute inset-x-1 h-0.5 rounded bg-accent',
                    h === 'before' ? '-top-px' : '-bottom-px',
                  )}
                />
              ) : null}
              <button
                type="button"
                tabIndex={-1}
                aria-label={isOpen ? t('pages.collapse') : t('pages.expand')}
                onClick={() => store.getState().setExpanded(n.id, !isOpen)}
                className={cx(
                  'grid size-4 shrink-0 place-items-center rounded text-muted hover:text-fg',
                  !hasKids && n.kind !== 'folder' && 'invisible',
                )}
              >
                <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
              </button>
              <Icon
                name={n.kind === 'folder' ? 'folder' : 'paper'}
                size={15}
                className="shrink-0 text-muted"
              />
              {renaming === n.id ? (
                <RenameInput
                  initial={n.title}
                  label={t('pages.rename')}
                  onDone={(v) => {
                    setRenaming(null);
                    if (v !== null && v !== n.title) void store.getState().rename(n.id, v);
                    refs.current.get(n.id)?.focus();
                  }}
                />
              ) : (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => activate(n)}
                  onDoubleClick={() => canEdit && setRenaming(n.id)}
                  className={cx(
                    'min-w-0 flex-1 truncate text-left',
                    n.title.trim() === '' && 'text-muted',
                  )}
                >
                  {title}
                </button>
              )}
              <span className="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                <Menu
                  open={menuFor === n.id}
                  onOpenChange={(o) => setMenuFor(o ? n.id : null)}
                  trigger={
                    <IconButton
                      icon="menu"
                      label={t('pages.actionsFor', { title })}
                      tabIndex={-1}
                      className="size-6"
                    />
                  }
                  items={[
                    ...(canEdit
                      ? [
                          {
                            id: 'rename',
                            label: t('pages.rename'),
                            onSelect: () => setRenaming(n.id),
                          },
                          {
                            id: 'sub',
                            label: t('pages.newSubpage'),
                            onSelect: () => void actions.createPage(n.id),
                          },
                          ...(n.kind === 'folder'
                            ? [
                                {
                                  id: 'folder',
                                  label: t('pages.newSubfolder'),
                                  onSelect: () => void actions.createFolder(n.id),
                                },
                              ]
                            : []),
                        ]
                      : []),
                    ...(isAdmin
                      ? [
                          {
                            id: 'share',
                            label: t('sharing.node.menu'),
                            onSelect: () =>
                              bus.emit('share-node', { id: n.id, title, kind: n.kind }),
                          },
                        ]
                      : []),
                    {
                      id: 'fav',
                      label: n.isFavorite ? t('pages.unfavorite') : t('pages.favorite'),
                      onSelect: () => void store.getState().toggleFavorite(n.id),
                    },
                    ...(canEdit
                      ? [
                          { id: 'move', label: t('pages.move'), onSelect: () => setMoving(n) },
                          {
                            id: 'del',
                            label: t('pages.delete'),
                            danger: true,
                            onSelect: () => void actions.remove(n.id),
                          },
                        ]
                      : []),
                  ]}
                />
              </span>
            </div>
          );
        })}
        <div
          aria-hidden
          onDragOver={(e) => {
            if (!dragId) return;
            e.preventDefault();
            setHint(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId && canEdit) void store.getState().move(dragId, null, null);
            endDrag();
          }}
          className={cx('h-6', dragId && 'rounded-md border border-dashed border-line')}
        />
      </div>
      <MoveDialog
        node={moving}
        nodes={nodes}
        onClose={() => setMoving(null)}
        onMove={(parentId) => {
          const m = moving;
          setMoving(null);
          if (m) void store.getState().move(m.id, parentId, null);
        }}
      />
    </>
  );
}

function RenameInput({
  initial,
  label,
  onDone,
}: {
  initial: string;
  label: string;
  onDone(v: string | null): void;
}) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // Sélection du texte une seule fois, à l'ouverture (et non à chaque rendu : cela écraserait la saisie).
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (val: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(val);
  };
  return (
    <input
      ref={input}
      aria-label={label}
      value={v}
      maxLength={500}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(v.trim());
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(v.trim())}
      className="min-w-0 flex-1 select-text rounded border border-accent bg-elevated px-1 outline-none"
    />
  );
}
