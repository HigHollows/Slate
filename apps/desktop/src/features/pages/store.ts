import { createStore } from 'zustand';
import { bus } from '../../shared/bus';
import type { Ipc, NodeRow, WorkspaceRow } from '../../shared/ipc/client';

export type PagesApi = Pick<
  Ipc,
  | 'workspaceDefault'
  | 'workspaceList'
  | 'syncStatus'
  | 'treeList'
  | 'nodeCreate'
  | 'dbCreate'
  | 'nodeRename'
  | 'nodeMove'
  | 'nodeSetFavorite'
  | 'nodeDelete'
  | 'nodeRestore'
  | 'trashList'
  | 'nodePurge'
  | 'trashEmpty'
  | 'recentTouch'
  | 'recentList'
  | 'settingsGetAll'
  | 'settingsSet'
>;

export const EXPANDED_KEY = 'ui.tree-expanded';
export const WORKSPACE_KEY = 'ui.workspace';

export interface PagesState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  workspaceId: string | null;
  /** Espaces locaux : le personnel d'abord, puis les espaces partagés rejoints. */
  workspaces: WorkspaceRow[];
  /** Faux pour un espace partagé où l'on est simple lecteur : toute modification est alors refusée aussi côté serveur. */
  canEdit: boolean;
  /** Rôle dans l'espace affiché (l'espace personnel non synchronisé = administrateur). */
  role: 'viewer' | 'editor' | 'admin';
  nodes: NodeRow[];
  trash: NodeRow[];
  recents: NodeRow[];
  expanded: string[];
  init(): Promise<void>;
  /** Change d'espace affiché (mémorisé) ; sans effet si l'espace est inconnu. */
  setWorkspace(id: string): Promise<void>;
  refresh(): Promise<void>;
  createNode(a: {
    parentId: string | null;
    kind: 'folder' | 'page';
    title?: string;
    beforeId?: string | null;
  }): Promise<NodeRow | undefined>;
  createDatabase(a: {
    parentId: string | null;
    title: string;
    titlePropertyName: string;
    viewName: string;
  }): Promise<NodeRow | undefined>;
  rename(id: string, title: string): Promise<NodeRow | undefined>;
  move(id: string, parentId: string | null, beforeId: string | null): Promise<boolean>;
  toggleFavorite(id: string): Promise<void>;
  remove(id: string): Promise<number | undefined>;
  restore(id: string): Promise<NodeRow | undefined>;
  purge(id: string): Promise<boolean>;
  emptyTrash(): Promise<boolean>;
  loadTrash(): Promise<void>;
  touch(id: string): Promise<void>;
  setExpanded(id: string, open: boolean): void;
}

/** Les erreurs sont signalées via `onError` (toast) ; les actions ne rejettent pas : le résultat est `undefined`/`false`. */
export function createPagesStore(api: PagesApi, onError: (e: unknown) => void = () => {}) {
  return createStore<PagesState>((set, get) => {
    const ws = (): string => {
      const id = get().workspaceId;
      if (!id) throw new Error('espace non chargé');
      return id;
    };
    async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
      try {
        return await fn();
      } catch (e) {
        onError(e);
        return undefined;
      }
    }
    const persistExpanded = () =>
      guard(() => api.settingsSet(EXPANDED_KEY, JSON.stringify(get().expanded.slice(0, 2000))));

    return {
      status: 'idle',
      workspaceId: null,
      workspaces: [],
      canEdit: true,
      role: 'admin',
      nodes: [],
      trash: [],
      recents: [],
      expanded: [],

      async setWorkspace(id) {
        if (id === get().workspaceId || !get().workspaces.some((x) => x.id === id)) return;
        set({ workspaceId: id });
        await guard(() => api.settingsSet(WORKSPACE_KEY, JSON.stringify(id)));
        await get().init();
      },

      async init() {
        set({ status: 'loading' });
        try {
          const def = await api.workspaceDefault();
          const [workspaces, rows] = await Promise.all([api.workspaceList(), api.settingsGetAll()]);
          const known = (id: string | null | undefined) =>
            id != null && workspaces.some((x) => x.id === id);
          let saved: string | null = null;
          const wrow = rows.find((r) => r.key === WORKSPACE_KEY);
          if (wrow) {
            try {
              const v: unknown = JSON.parse(wrow.valueJson);
              if (typeof v === 'string') saved = v;
            } catch {
              /* valeur illisible : espace par défaut */
            }
          }
          const current = get().workspaceId;
          const w = { id: known(current) ? current! : known(saved) ? saved! : def.id };
          const [nodes, recents, sync] = await Promise.all([
            api.treeList(w.id),
            api.recentList(w.id),
            api.syncStatus().catch(() => null),
          ]);
          const role = sync?.workspaces.find((x) => x.workspaceId === w.id)?.role ?? 'admin';
          let expanded: string[] = [];
          const row = rows.find((r) => r.key === EXPANDED_KEY);
          if (row) {
            try {
              const v: unknown = JSON.parse(row.valueJson);
              if (Array.isArray(v)) expanded = v.filter((x): x is string => typeof x === 'string');
            } catch {
              /* valeur illisible : dossiers repliés par défaut */
            }
          }
          set({
            workspaceId: w.id,
            workspaces,
            canEdit: role !== 'viewer',
            role,
            nodes,
            recents,
            expanded,
            status: 'ready',
          });
        } catch (e) {
          set({ status: 'error' });
          onError(e);
        }
      },

      async refresh() {
        await guard(async () => {
          const id = ws();
          const [nodes, recents] = await Promise.all([api.treeList(id), api.recentList(id)]);
          set({ nodes, recents });
        });
      },

      async createNode({ parentId, kind, title = '', beforeId = null }) {
        const row = await guard(() =>
          api.nodeCreate({ workspaceId: ws(), parentId, kind, title, beforeId }),
        );
        if (!row) return undefined;
        if (parentId) get().setExpanded(parentId, true);
        await get().refresh();
        return row;
      },

      async createDatabase({ parentId, title, titlePropertyName, viewName }) {
        const d = await guard(() =>
          api.dbCreate({ workspaceId: ws(), parentId, title, titlePropertyName, viewName }),
        );
        if (!d) return undefined;
        if (parentId) get().setExpanded(parentId, true);
        await get().refresh();
        return d.node;
      },

      async rename(id, title) {
        const row = await guard(() => api.nodeRename(id, title));
        if (row) bus.emit('node-renamed', { id, title: row.title });
        if (row)
          set((s) => ({
            nodes: s.nodes.map((n) => (n.id === id ? row : n)),
            recents: s.recents.map((n) => (n.id === id ? row : n)),
          }));
        return row;
      },

      async move(id, parentId, beforeId) {
        const row = await guard(() => api.nodeMove(id, parentId, beforeId));
        if (!row) return false;
        if (parentId) get().setExpanded(parentId, true);
        await get().refresh();
        return true;
      },

      async toggleFavorite(id) {
        const cur = get().nodes.find((n) => n.id === id);
        if (!cur) return;
        const row = await guard(() => api.nodeSetFavorite(id, !cur.isFavorite));
        if (row) set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? row : n)) }));
      },

      async remove(id) {
        const n = await guard(() => api.nodeDelete(id));
        if (n !== undefined) await get().refresh();
        return n;
      },

      async restore(id) {
        const row = await guard(() => api.nodeRestore(id));
        if (row) {
          await get().refresh();
          await get().loadTrash();
          bus.emit('nodes-changed', { ids: [id] });
        }
        return row;
      },

      async purge(id) {
        const n = await guard(() => api.nodePurge(id));
        if (n === undefined) return false;
        await get().loadTrash();
        await get().refresh();
        return true;
      },

      async emptyTrash() {
        const n = await guard(() => api.trashEmpty(ws()));
        if (n === undefined) return false;
        await get().loadTrash();
        return true;
      },

      async loadTrash() {
        const trash = await guard(() => api.trashList(ws()));
        if (trash) set({ trash });
      },

      async touch(id) {
        const ok = await guard(async () => {
          await api.recentTouch(id);
          return true;
        });
        if (ok) await get().refresh();
      },

      setExpanded(id, open) {
        const cur = get().expanded;
        const has = cur.includes(id);
        if (open === has) return;
        set({ expanded: open ? [...cur, id] : cur.filter((x) => x !== id) });
        void persistExpanded();
      },
    };
  });
}
export type PagesStore = ReturnType<typeof createPagesStore>;
