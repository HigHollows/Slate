import { Icon } from '@slate/icons';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, cx } from '../../shared/ui';
import type { NodeRow } from '../../shared/ipc/client';
import { buildTree, descendantIds, displayTitle, flattenVisible } from './model';

/** Alternative accessible (clavier/lecteur d'écran) au glisser-déposer : choisir la destination dans une liste. */
export function MoveDialog({
  node,
  nodes,
  onClose,
  onMove,
}: {
  node: NodeRow | null;
  nodes: NodeRow[];
  onClose(): void;
  onMove(parentId: string | null): void;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);
  const options = useMemo(() => {
    if (!node) return [];
    const banned = descendantIds(nodes, node.id).add(node.id);
    const all = new Set(nodes.map((n) => n.id));
    const flat = flattenVisible(buildTree(nodes.filter((n) => !banned.has(n.id))), all);
    return [
      { id: null as string | null, label: t('pages.moveToRoot'), depth: 0 },
      ...flat.map((i) => ({
        id: i.node.id as string | null,
        label: displayTitle(i.node, t('pages.untitled')),
        depth: i.depth + 1,
      })),
    ];
  }, [node, nodes, t]);

  const choose = (i: number) => {
    const o = options[i];
    if (o) onMove(o.id);
  };
  return (
    <Dialog
      open={node !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t('pages.moveTitle')}
      description={t('pages.moveHint')}
    >
      <ul
        role="listbox"
        tabIndex={0}
        aria-label={t('pages.moveTitle')}
        aria-activedescendant={`move-opt-${active}`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(options.length - 1, a + 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
          else if (e.key === 'Enter') choose(active);
          else return;
          e.preventDefault();
        }}
        className="m-3 max-h-72 overflow-y-auto rounded-lg border border-line p-1"
      >
        {options.map((o, i) => (
          <li
            key={o.id ?? 'root'}
            id={`move-opt-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseMove={() => setActive(i)}
            onClick={() => choose(i)}
            style={{ paddingLeft: 8 + o.depth * 14 }}
            className={cx(
              'flex h-8 items-center gap-2 rounded-md pr-2',
              i === active && 'bg-hover',
            )}
          >
            <Icon name={o.id === null ? 'home' : 'folder'} size={14} className="text-muted" />
            <span className="truncate">{o.label}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
