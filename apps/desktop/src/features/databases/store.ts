import { createStore } from 'zustand';
import { bus } from '../../shared/bus';
import type { DatabaseData, Ipc, NodeRow, ViewRow } from '../../shared/ipc/client';
import {
  parseViewConfig,
  toProperty,
  toRow,
  type Property,
  type Row,
  type ViewConfig,
} from './types';

export type DatabasesApi = Pick<
  Ipc,
  | 'dbGet'
  | 'dbRows'
  | 'rowGet'
  | 'propCreate'
  | 'propUpdate'
  | 'propDelete'
  | 'propMove'
  | 'viewCreate'
  | 'viewUpdate'
  | 'viewDelete'
  | 'cellsSet'
  | 'rowCreate'
  | 'rowsDelete'
  | 'nodeRename'
  | 'nodeRestore'
  | 'habitLogList'
  | 'habitLogSet'
>;

export interface Loaded {
  status: 'loading' | 'ready' | 'error';
  node: NodeRow | null;
  properties: Property[];
  views: ViewRow[];
  rows: Row[];
}
const empty = (): Loaded => ({
  status: 'loading',
  node: null,
  properties: [],
  views: [],
  rows: [],
});

export interface CellEdit {
  rowId: string;
  propertyId: string;
  value: unknown;
}

export interface DatabasesState {
  dbs: Record<string, Loaded>;
  load(id: string, force?: boolean): Promise<void>;
  forget(id: string): void;
  createRow(
    id: string,
    init?: { title?: string; props?: Record<string, unknown> },
  ): Promise<Row | undefined>;
  setCells(id: string, changes: CellEdit[]): Promise<boolean>;
  setTitle(id: string, rowId: string, title: string): Promise<boolean>;
  deleteRows(id: string, rowIds: string[]): Promise<boolean>;
  restoreRows(id: string, rowIds: string[]): Promise<void>;
  addProperty(
    id: string,
    a: {
      name: string;
      type: string;
      config: Record<string, unknown>;
      twoWayName?: string;
      beforeId?: string | null;
    },
  ): Promise<Property | undefined>;
  updateProperty(
    id: string,
    propertyId: string,
    patch: { name?: string; config?: Record<string, unknown>; type?: string },
  ): Promise<Property | undefined>;
  removeProperty(id: string, propertyId: string): Promise<boolean>;
  moveProperty(id: string, propertyId: string, beforeId: string | null): Promise<void>;
  addView(
    id: string,
    name: string,
    layout: ViewRow['layout'],
    config?: Partial<ViewConfig>,
  ): Promise<ViewRow | undefined>;
  renameView(id: string, viewId: string, name: string): Promise<void>;
  removeView(id: string, viewId: string): Promise<boolean>;
  /** Modifie localement tout de suite ; l'enregistrement est regroupé (debounce) et réessayé au prochain changement en cas d'échec. */
  patchViewConfig(id: string, viewId: string, patch: Partial<ViewConfig>): void;
  flushViews(): Promise<void>;
  hasPendingViews(): boolean;
  /** Jours pointés des habitudes de la base entre deux jours (inclus). */
  habitDays(id: string, from: string, to: string): Promise<{ rowId: string; day: string }[]>;
  setHabitDay(rowId: string, day: string, done: boolean, today: string): Promise<boolean>;
}

const sortProps = (ps: Property[]) =>
  [...ps].sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1,
  );

export function createDatabasesStore(
  api: DatabasesApi,
  onError: (e: unknown) => void = () => {},
  debounceMs = 400,
) {
  return createStore<DatabasesState>((set, get) => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const pending = new Map<string, { id: string; viewId: string }>();

    const patchDb = (id: string, f: (d: Loaded) => Partial<Loaded>) =>
      set((s) => {
        const cur = s.dbs[id];
        return cur ? { dbs: { ...s.dbs, [id]: { ...cur, ...f(cur) } } } : s;
      });
    async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
      try {
        return await fn();
      } catch (e) {
        onError(e);
        return undefined;
      }
    }
    const apply = (data: DatabaseData, rows: Row[]): Loaded => ({
      status: 'ready',
      node: data.node,
      properties: sortProps(data.properties.map(toProperty)),
      views: data.views,
      rows,
    });

    const persistView = async (id: string, viewId: string) => {
      const v = get().dbs[id]?.views.find((x) => x.id === viewId);
      if (!v) return;
      pending.delete(viewId);
      await guard(() => api.viewUpdate({ id: viewId, config: v.config }));
    };

    // Synchronisation avec les autres stores : renommages et restaurations.
    bus.on('node-renamed', ({ id, title }) =>
      set((s) => {
        let changed = false;
        const dbs: Record<string, Loaded> = {};
        for (const [k, d] of Object.entries(s.dbs)) {
          if (d.rows.some((r) => r.id === id)) {
            changed = true;
            dbs[k] = { ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, title } : r)) };
          } else if (d.node?.id === id) {
            changed = true;
            dbs[k] = { ...d, node: { ...d.node, title } };
          } else dbs[k] = d;
        }
        return changed ? { dbs } : s;
      }),
    );
    bus.on('nodes-changed', () => {
      for (const id of Object.keys(get().dbs)) void get().load(id, true);
    });

    return {
      dbs: {},

      async load(id, force = false) {
        const cur = get().dbs[id];
        if (cur && !force && cur.status !== 'error') return;
        if (!cur) set((s) => ({ dbs: { ...s.dbs, [id]: empty() } }));
        try {
          const [data, rows] = await Promise.all([api.dbGet(id), api.dbRows(id)]);
          set((s) => ({ dbs: { ...s.dbs, [id]: apply(data, rows.map(toRow)) } }));
        } catch (e) {
          set((s) => ({ dbs: { ...s.dbs, [id]: { ...(s.dbs[id] ?? empty()), status: 'error' } } }));
          onError(e);
        }
      },

      forget(id) {
        set((s) => {
          const { [id]: _drop, ...rest } = s.dbs;
          void _drop;
          return { dbs: rest };
        });
      },

      async createRow(id, init = {}) {
        const row = await guard(() =>
          api.rowCreate({ databaseId: id, title: init.title ?? '', props: init.props ?? null }),
        );
        if (!row) return undefined;
        const r = toRow(row);
        patchDb(id, (d) => ({ rows: [...d.rows, r] }));
        return r;
      },

      async setCells(id, changes) {
        const current = get().dbs[id]?.rows;
        if (!current || changes.length === 0) return false;
        const norm = (v: unknown) => (v === undefined ? null : v);
        const same = (a: unknown, b: unknown) =>
          JSON.stringify(norm(a)) === JSON.stringify(norm(b));
        // Valeurs d'origine, pour n'annuler QUE ces cellules en cas d'échec (des modifications concurrentes ne sont pas touchées).
        const undo = changes.map((c) => ({
          ...c,
          old: current.find((r) => r.id === c.rowId)?.props[c.propertyId] ?? null,
        }));
        const setValue = (rows: Row[], rowId: string, propertyId: string, value: unknown) =>
          rows.map((r) => {
            if (r.id !== rowId) return r;
            const props = { ...r.props };
            if (value === null || value === undefined) delete props[propertyId];
            else props[propertyId] = value;
            return { ...r, props };
          });
        // Optimiste : la cellule change immédiatement dans TOUTES les vues (même source de données).
        patchDb(id, (d) => ({
          rows: changes.reduce((rows, c) => setValue(rows, c.rowId, c.propertyId, c.value), d.rows),
        }));
        const out = await guard(() =>
          api.cellsSet(
            changes.map((c) => ({
              rowId: c.rowId,
              propertyId: c.propertyId,
              value: c.value ?? null,
            })),
          ),
        );
        if (!out) {
          // Échec : retour à la valeur d'avant, cellule par cellule, si personne ne l'a modifiée entre-temps. L'erreur est déjà signalée.
          patchDb(id, (d) => ({
            rows: undo.reduce((rows, u) => {
              const row = rows.find((r) => r.id === u.rowId);
              return row && same(row.props[u.propertyId], u.value)
                ? setValue(rows, u.rowId, u.propertyId, u.old)
                : rows;
            }, d.rows),
          }));
          return false;
        }
        const fresh = new Map(out.map((r) => [r.id, toRow(r)]));
        // Les lignes touchées dans d'autres bases (rétro-liens de relation) sont rafraîchies si chargées.
        // Les lignes inconnues de la base (occurrence suivante d'une tâche récurrente) sont ajoutées à la fin.
        set((s) => {
          const dbs: Record<string, Loaded> = {};
          for (const [k, d] of Object.entries(s.dbs)) {
            const known = new Set(d.rows.map((r) => r.id));
            const added = [...fresh.values()].filter((r) => r.databaseId === k && !known.has(r.id));
            dbs[k] =
              added.length > 0 || d.rows.some((r) => fresh.has(r.id))
                ? { ...d, rows: [...d.rows.map((r) => fresh.get(r.id) ?? r), ...added] }
                : d;
          }
          return { dbs };
        });
        return true;
      },

      async setTitle(id, rowId, title) {
        const before = get().dbs[id]?.rows;
        if (!before) return false;
        patchDb(id, (d) => ({ rows: d.rows.map((r) => (r.id === rowId ? { ...r, title } : r)) }));
        const row = await guard(() => api.nodeRename(rowId, title));
        if (!row) {
          patchDb(id, () => ({ rows: before }));
          return false;
        }
        bus.emit('node-renamed', { id: rowId, title: row.title });
        return true;
      },

      async deleteRows(id, rowIds) {
        const n = await guard(() => api.rowsDelete(rowIds));
        if (n === undefined) return false;
        const gone = new Set(rowIds);
        patchDb(id, (d) => ({ rows: d.rows.filter((r) => !gone.has(r.id)) }));
        return true;
      },

      async restoreRows(id, rowIds) {
        for (const r of rowIds) await guard(() => api.nodeRestore(r));
        await get().load(id, true);
      },

      async addProperty(id, a) {
        const p = await guard(() =>
          api.propCreate({
            databaseId: id,
            name: a.name,
            kind: a.type,
            config: a.config,
            beforeId: a.beforeId ?? null,
            twoWayName: a.twoWayName ?? null,
          }),
        );
        if (!p) return undefined;
        const prop = toProperty(p);
        // Numéros automatiques / relation inverse : les lignes (ou l'autre base) ont changé côté serveur.
        await get().load(id, true);
        const target =
          typeof prop.config['targetDatabaseId'] === 'string'
            ? prop.config['targetDatabaseId']
            : null;
        if (target && target !== id && get().dbs[target]) await get().load(target, true);
        return prop;
      },

      async updateProperty(id, propertyId, patch) {
        const p = await guard(() => api.propUpdate({ id: propertyId, ...patch }));
        if (!p) return undefined;
        await get().load(id, true); // conversion de type / options retirées : valeurs modifiées côté serveur
        return toProperty(p);
      },

      async removeProperty(id, propertyId) {
        const ok = await guard(async () => {
          await api.propDelete(propertyId);
          return true;
        });
        if (!ok) return false;
        patchDb(id, (d) => ({ properties: d.properties.filter((p) => p.id !== propertyId) }));
        for (const [k, d] of Object.entries(get().dbs))
          if (k !== id && d.properties.some((p) => p.config['reversePropertyId'] === propertyId))
            void get().load(k, true);
        return true;
      },

      async moveProperty(id, propertyId, beforeId) {
        const p = await guard(() => api.propMove(propertyId, beforeId));
        if (!p) return;
        const moved = toProperty(p);
        patchDb(id, (d) => ({
          properties: sortProps(d.properties.map((x) => (x.id === propertyId ? moved : x))),
        }));
      },

      async addView(id, name, layout, config = {}) {
        const v = await guard(() =>
          api.viewCreate({
            databaseId: id,
            name,
            layout,
            config: config as Record<string, unknown>,
          }),
        );
        if (v) patchDb(id, (d) => ({ views: [...d.views, v] }));
        return v;
      },

      async renameView(id, viewId, name) {
        const v = await guard(() => api.viewUpdate({ id: viewId, name }));
        if (v)
          patchDb(id, (d) => ({
            views: d.views.map((x) => (x.id === viewId ? { ...x, name: v.name } : x)),
          }));
      },

      async removeView(id, viewId) {
        const ok = await guard(async () => {
          await api.viewDelete(viewId);
          return true;
        });
        if (ok) patchDb(id, (d) => ({ views: d.views.filter((x) => x.id !== viewId) }));
        return ok === true;
      },

      patchViewConfig(id, viewId, patch) {
        const cur = get().dbs[id]?.views.find((v) => v.id === viewId);
        if (!cur) return;
        const next = { ...parseViewConfig(cur.config), ...patch };
        patchDb(id, (d) => ({
          views: d.views.map((v) =>
            v.id === viewId ? { ...v, config: next as unknown as Record<string, unknown> } : v,
          ),
        }));
        pending.set(viewId, { id, viewId });
        const t = timers.get(viewId);
        if (t) clearTimeout(t);
        timers.set(
          viewId,
          setTimeout(() => {
            timers.delete(viewId);
            void persistView(id, viewId);
          }, debounceMs),
        );
      },

      hasPendingViews: () => pending.size > 0,

      async habitDays(id, from, to) {
        return (await guard(() => api.habitLogList(id, from, to))) ?? [];
      },

      async setHabitDay(rowId, day, done, today) {
        let ok = false;
        await guard(async () => {
          await api.habitLogSet(rowId, day, done, today);
          ok = true;
        });
        return ok;
      },

      async flushViews() {
        for (const [viewId, t] of timers) {
          clearTimeout(t);
          timers.delete(viewId);
        }
        await Promise.all([...pending.values()].map((p) => persistView(p.id, p.viewId)));
      },
    };
  });
}
export type DatabasesStore = ReturnType<typeof createDatabasesStore>;
