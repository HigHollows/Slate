import type { NodeRow } from '../../shared/ipc/client';

export interface TreeItem {
  node: NodeRow;
  children: TreeItem[];
  depth: number;
}

const byPosition = (a: NodeRow, b: NodeRow) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1;

/** Construit la forêt (tri par position). Un nœud dont le parent est absent est traité comme une racine. */
export function buildTree(nodes: NodeRow[]): TreeItem[] {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map<string | null, NodeRow[]>();
  for (const n of nodes) {
    const key = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    const list = kids.get(key) ?? [];
    list.push(n);
    kids.set(key, list);
  }
  const make = (parent: string | null, depth: number): TreeItem[] =>
    (kids.get(parent) ?? [])
      .sort(byPosition)
      .map((node) => ({ node, depth, children: make(node.id, depth + 1) }));
  return make(null, 0);
}

export function flattenVisible(items: TreeItem[], expanded: ReadonlySet<string>): TreeItem[] {
  const out: TreeItem[] = [];
  const walk = (list: TreeItem[]) => {
    for (const it of list) {
      out.push(it);
      if (expanded.has(it.node.id)) walk(it.children);
    }
  };
  walk(items);
  return out;
}

export function descendantIds(nodes: NodeRow[], id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const n of nodes) {
      if (n.parentId === cur && !out.has(n.id)) {
        out.add(n.id);
        stack.push(n.id);
      }
    }
  }
  return out;
}

/** Ancêtres du nœud, de la racine vers le parent direct. */
export function ancestors(nodes: NodeRow[], id: string): NodeRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: NodeRow[] = [];
  let cur = byId.get(id)?.parentId ?? null;
  const seen = new Set<string>();
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const n = byId.get(cur) as NodeRow;
    out.unshift(n);
    cur = n.parentId;
  }
  return out;
}

export type DropZone = 'before' | 'inside' | 'after';

/** Quart haut = avant, quart bas = après, milieu = à l'intérieur. */
export function zoneFromOffset(offsetY: number, height: number): DropZone {
  const r = height > 0 ? offsetY / height : 0.5;
  return r < 0.25 ? 'before' : r > 0.75 ? 'after' : 'inside';
}

export interface DropTarget {
  parentId: string | null;
  beforeId: string | null;
}

/** Traduit un dépôt (zone sur une cible) en destination ; `null` si invalide (soi-même ou descendant). */
export function computeDrop(
  nodes: NodeRow[],
  draggedId: string,
  targetId: string,
  zone: DropZone,
): DropTarget | null {
  const target = nodes.find((n) => n.id === targetId);
  if (!target || draggedId === targetId) return null;
  if (descendantIds(nodes, draggedId).has(targetId)) return null;
  if (zone === 'inside') return { parentId: targetId, beforeId: null };
  const siblings = nodes
    .filter((n) => n.parentId === target.parentId && n.id !== draggedId)
    .sort(byPosition);
  const i = siblings.findIndex((n) => n.id === targetId);
  if (zone === 'before') return { parentId: target.parentId, beforeId: targetId };
  return { parentId: target.parentId, beforeId: siblings[i + 1]?.id ?? null };
}

export const displayTitle = (n: Pick<NodeRow, 'title'>, untitled: string): string =>
  n.title.trim() === '' ? untitled : n.title;
