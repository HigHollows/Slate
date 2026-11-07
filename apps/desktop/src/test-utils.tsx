import { createHash } from 'node:crypto';
import { render } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { AppRoot, type AppDeps } from './app/AppRoot';
import { createCommandsStore } from './features/commands';
import { useNav } from './features/navigation';
import { createPagesStore } from './features/pages';
import { createDatabasesStore } from './features/databases';
import { createPreferencesStore } from './features/preferences';
import type { Reminder } from './features/reminders';
import { createSecurityStore } from './features/security';
import { createAccountStore, type AuthClient } from './features/account';
import {
  SyncError,
  createUnavailableSyncClient,
  type SyncClient,
  createSyncControl,
  createSyncEngine,
  createSyncStore,
} from './features/sync';
import { i18n, initI18n } from './shared/i18n';
import type { PresenceService } from './shared/presence';
import type {
  DbRow,
  NodeRow,
  PropertyRow,
  SearchHit,
  SyncStatus,
  ViewRow,
} from './shared/ipc/client';
import { useToasts } from './shared/ui';

const ioError = { code: 'io', messageKey: 'errors.io', retryable: true, detail: 'disque plein' };

/** Faux cœur Rust en mémoire (mêmes contrats que l'IPC) avec injection de pannes. */
export function fakeBackend(initial: Record<string, string> = {}) {
  const settings = new Map(Object.entries(initial));
  const state = { failWrites: false, failPageSave: false, failRename: false, failCells: false };
  const dbProps = new Map<string, PropertyRow[]>();
  const dbViews = new Map<string, ViewRow[]>();
  const rowProps = new Map<string, Record<string, unknown>>();
  const nextAuto = new Map<string, number>();
  const habitLog = new Set<string>();
  const mediaStore = new Map<string, string>();
  const extraWorkspaces: { id: string; name: string; kind: 'shared' }[] = [];
  const syncState = {
    enabled: false,
    workspaceId: null as string | null,
    pending: 0,
    rejected: 0,
    nodeCursor: 0,
    docCursor: 0,
    structCursor: 0,
    lastError: null as string | null,
  };
  const syncStatusNow = (): SyncStatus => ({
    enabled: syncState.enabled,
    deviceId: 'dev-test',
    pending: syncState.pending,
    rejected: syncState.rejected,
    workspaces: syncState.workspaceId
      ? [
          {
            workspaceId: syncState.workspaceId,
            name: 'Personnel',
            kind: 'personal' as const,
            role: 'admin' as const,
            nodeCursor: syncState.nodeCursor,
            docCursor: syncState.docCursor,
            structCursor: syncState.structCursor,
            lastPushAt: null,
            lastPullAt: null,
            lastError: syncState.lastError,
          },
        ]
      : [],
  });
  const opened: string[] = [];
  type FakeVersion = {
    id: string;
    nodeId: string;
    createdAt: string;
    reason: 'auto' | 'manual' | 'restore';
    label: string | null;
    author: string | null;
    bytes: number;
    words: number;
    contentJson: string;
    textPlain: string;
  };
  const versions: FakeVersion[] = [];
  type FakeThread = import('./shared/ipc/client').CommentThread;
  const threads: FakeThread[] = [];
  let commentSeq = 0;
  const stamp = () => new Date(2026, 5, 17, 11, commentSeq++).toISOString();
  const noThread = () => ({ code: 'not_found', messageKey: 'errors.notFound', retryable: false });
  const metaOf = (v: FakeVersion) => ({
    id: v.id,
    nodeId: v.nodeId,
    createdAt: v.createdAt,
    reason: v.reason,
    label: v.label,
    author: v.author,
    bytes: v.bytes,
    words: v.words,
  });
  const pin = {
    code: null as string | null,
    failed: 0,
    lockedUntil: 0,
    lockOnStart: true,
    idle: 0,
    locked: false,
  };
  const lockedErr = { code: 'locked', messageKey: 'errors.locked', retryable: false };
  const notLocked = () => {
    if (pin.locked) throw lockedErr;
  };
  const pinState = () => ({
    enabled: pin.code !== null,
    lockOnStart: pin.lockOnStart,
    idleMinutes: pin.idle,
    failedCount: pin.failed,
    retryAfterMs: Math.max(0, pin.lockedUntil - Date.now()),
    locked: pin.locked,
  });
  const checkPin = (code: string | null | undefined) => {
    if (pin.code === null)
      throw { code: 'ipc.invalid', messageKey: 'errors.ipc.invalid', retryable: false };
    if (pin.lockedUntil > Date.now())
      throw {
        code: 'pin.locked',
        messageKey: 'errors.pin.locked',
        retryable: false,
        retryAfterMs: pin.lockedUntil - Date.now(),
      };
    if (code === pin.code) {
      pin.failed = 0;
      pin.lockedUntil = 0;
      return;
    }
    pin.failed += 1;
    if (pin.failed >= 5) {
      pin.lockedUntil = Date.now() + 30_000;
      throw {
        code: 'pin.locked',
        messageKey: 'errors.pin.locked',
        retryable: false,
        retryAfterMs: 30_000,
      };
    }
    throw {
      code: 'pin.invalid',
      messageKey: 'errors.pin.invalid',
      retryable: false,
      failedCount: pin.failed,
    };
  };
  let nodes: NodeRow[] = [];
  const pages = new Map<
    string,
    { docState: string; textPlain: string; contentJson: string; linkTargets: string[] }
  >();
  let seq = 0;
  let clock = 0;
  const ts = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString();
  const pos = (n: number) => n.toFixed(6).padStart(16, '0');
  const posNum = (s: string) => Number(s);
  const live = () => nodes.filter((n) => !n.deletedAt);
  const siblings = (parentId: string | null, except?: string) =>
    live()
      .filter((n) => n.parentId === parentId && n.id !== except)
      .sort((a, b) => (a.position < b.position ? -1 : 1));
  const slot = (parentId: string | null, beforeId: string | null, except?: string) => {
    const sib = siblings(parentId, except);
    if (beforeId === null) return pos((sib.length ? posNum(sib[sib.length - 1]!.position) : 0) + 1);
    const i = sib.findIndex((n) => n.id === beforeId);
    const next = posNum(sib[i]!.position);
    const prev = i === 0 ? next - 2 : posNum(sib[i - 1]!.position);
    return pos((prev + next) / 2);
  };
  const desc = (id: string): string[] =>
    nodes.filter((n) => n.parentId === id).flatMap((n) => [n.id, ...desc(n.id)]);
  const put = (row: NodeRow) => (nodes = nodes.map((n) => (n.id === row.id ? row : n)));
  const get = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    if (!n) throw { code: 'not_found', messageKey: 'errors.notFound', retryable: false };
    return n;
  };
  const write = () => {
    if (state.failWrites) throw ioError;
  };

  const isDb = (id: string | null) =>
    id !== null && nodes.some((n) => n.id === id && n.kind === 'database');
  const toRow = (n: NodeRow): DbRow => ({
    id: n.id,
    databaseId: n.parentId as string,
    title: n.title,
    props: { ...(rowProps.get(n.id) ?? {}) },
    createdAt: n.updatedAt,
    updatedAt: n.updatedAt,
  });
  const optIds = (p: PropertyRow) =>
    new Set(((p.config['options'] as { id: string }[] | undefined) ?? []).map((o) => o.id));
  const dbRows = (id: string) => live().filter((n) => n.parentId === id && rowProps.has(n.id));
  const propById = (id: string) => [...dbProps.values()].flat().find((p) => p.id === id);
  const bad = (m = 'invalide') => ({
    code: 'ipc.invalid',
    messageKey: 'errors.ipc.invalid',
    retryable: false,
    detail: m,
  });
  const checkValue = (p: PropertyRow, v: unknown) => {
    if (v === null) return;
    switch (p.type) {
      case 'number':
      case 'percent':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('nombre');
        break;
      case 'checkbox':
        if (typeof v !== 'boolean') throw bad('booléen');
        break;
      case 'select':
      case 'status':
        if (typeof v !== 'string' || !optIds(p).has(v)) throw bad('option');
        break;
      case 'multiselect':
        if (!Array.isArray(v) || v.some((x) => !optIds(p).has(String(x)))) throw bad('options');
        break;
      case 'relation':
        if (
          !Array.isArray(v) ||
          v.some((x) => !dbRows(String(p.config['targetDatabaseId'])).some((r) => r.id === x))
        )
          throw bad('relation');
        break;
      case 'formula':
      case 'id':
      case 'created_time':
      case 'last_edited_time':
      case 'title':
        throw bad('calculée');
      default:
        if (typeof v !== 'string') throw bad('texte');
    }
  };
  const api = {
    settings,
    data: settings,
    state,
    get nodes() {
      return nodes;
    },
    pages,
    settingsGetAll: vi.fn(async () => {
      notLocked();
      return [...settings].map(([key, valueJson]) => ({ key, valueJson }));
    }),
    settingsSet: vi.fn(async (k: string, v: string) => {
      write();
      settings.set(k, v);
      return undefined;
    }),
    settingsDelete: vi.fn(async (k: string) => {
      write();
      settings.delete(k);
      return undefined;
    }),
    systemInfo: vi.fn(async () => ({
      appVersion: '0.1.0',
      schemaVersion: 2,
      deviceId: 'dev-1',
      dbPath: '/x/slate.sqlite',
      integrityOk: true,
    })),
    workspaceDefault: vi.fn(async () => ({ id: 'ws', name: 'Personnel' })),
    workspaceList: vi.fn(async () => [
      { id: 'ws', name: 'Personnel', kind: 'personal' as const },
      ...extraWorkspaces,
    ]),
    treeList: vi.fn(async () =>
      (notLocked(), live()).filter((n) => !rowProps.has(n.id)).map((n) => ({ ...n })),
    ),
    dbCreate: vi.fn(
      async (a: {
        parentId: string | null;
        title: string;
        titlePropertyName: string;
        viewName: string;
      }) => {
        write();
        const id = `d${++seq}`;
        const row: NodeRow = {
          id,
          workspaceId: 'ws',
          parentId: a.parentId,
          kind: 'database',
          title: a.title,
          position: slot(a.parentId, null),
          isFavorite: false,
          updatedAt: ts(),
          deletedAt: null,
        };
        nodes = [...nodes, row];
        const p: PropertyRow = {
          id: `p${++seq}`,
          databaseId: id,
          name: a.titlePropertyName,
          type: 'title',
          config: {},
          position: '0000000000000001',
        };
        const v: ViewRow = {
          id: `v${++seq}`,
          databaseId: id,
          name: a.viewName,
          layout: 'table',
          config: {},
          position: '0000000000000001',
        };
        dbProps.set(id, [p]);
        dbViews.set(id, [v]);
        nextAuto.set(id, 1);
        return { node: row, properties: [p], views: [v] };
      },
    ),
    dbGet: vi.fn(async (id: string) => ({
      node: get(id),
      properties: [...(dbProps.get(id) ?? [])],
      views: [...(dbViews.get(id) ?? [])],
    })),
    dbRows: vi.fn(async (id: string) => dbRows(id).map(toRow)),
    rowGet: vi.fn(async (id: string) => toRow(get(id))),
    nodeGet: vi.fn(async (id: string) => {
      const node = get(id);
      return { node, databaseId: rowProps.has(id) ? node.parentId : null };
    }),
    rowCreate: vi.fn(
      async (a: { databaseId: string; title: string; props: Record<string, unknown> | null }) => {
        write();
        const id = `r${++seq}`;
        const row: NodeRow = {
          id,
          workspaceId: 'ws',
          parentId: a.databaseId,
          kind: 'page',
          title: a.title,
          position: slot(a.databaseId, null),
          isFavorite: false,
          updatedAt: ts(),
          deletedAt: null,
        };
        nodes = [...nodes, row];
        const props: Record<string, unknown> = {};
        for (const p of dbProps.get(a.databaseId) ?? []) {
          if (p.type === 'id') {
            const n = nextAuto.get(a.databaseId) ?? 1;
            nextAuto.set(a.databaseId, n + 1);
            props[p.id] = n;
          }
        }
        for (const [k, v] of Object.entries(a.props ?? {})) {
          const p = propById(k);
          if (!p) throw bad('propriété');
          checkValue(p, v);
          props[k] = v;
        }
        rowProps.set(id, props);
        return toRow(row);
      },
    ),
    rowsDelete: vi.fn(async (ids: string[]) => {
      write();
      const stamp = ts();
      nodes = nodes.map((n) => (ids.includes(n.id) ? { ...n, deletedAt: stamp } : n));
      return ids.length;
    }),
    cellsSet: vi.fn(async (changes: { rowId: string; propertyId: string; value: unknown }[]) => {
      if (state.failCells || state.failWrites) throw ioError;
      const snapshot = new Map([...rowProps].map(([k, v]) => [k, { ...v }]));
      const touched = new Set<string>();
      try {
        for (const c of changes) {
          const p = propById(c.propertyId);
          if (!p || !rowProps.has(c.rowId)) throw bad('introuvable');
          checkValue(p, c.value);
          const cur = rowProps.get(c.rowId)!;
          const before = (cur[p.id] as string[] | undefined) ?? [];
          if (c.value === null) delete cur[p.id];
          else cur[p.id] = c.value;
          touched.add(c.rowId);
          const rev = p.config['reversePropertyId'] as string | undefined;
          if (p.type === 'relation' && rev) {
            const after = (c.value as string[] | null) ?? [];
            for (const gone of before.filter((x) => !after.includes(x))) {
              const o = rowProps.get(gone);
              if (o) {
                o[rev] = ((o[rev] as string[]) ?? []).filter((x) => x !== c.rowId);
                if (!(o[rev] as string[]).length) delete o[rev];
                touched.add(gone);
              }
            }
            for (const add of after.filter((x) => !before.includes(x))) {
              const o = rowProps.get(add);
              if (o) {
                o[rev] = [...new Set([...((o[rev] as string[]) ?? []), c.rowId])];
                touched.add(add);
              }
            }
          }
        }
      } catch (e) {
        rowProps.clear();
        for (const [k, v] of snapshot) rowProps.set(k, v);
        throw e;
      }
      return [...touched].map((id) => toRow(get(id)));
    }),
    propCreate: vi.fn(
      async (a: {
        databaseId: string;
        name: string;
        kind: string;
        config: Record<string, unknown>;
        beforeId: string | null;
        twoWayName: string | null;
      }) => {
        write();
        const list = dbProps.get(a.databaseId) ?? [];
        if (list.some((p) => p.name.toLowerCase() === a.name.toLowerCase()))
          throw bad('nom déjà utilisé');
        const opts = Array.isArray(a.config['options'])
          ? (a.config['options'] as { id?: string; name: string }[]).map((o, i) => ({
              color: 'gray',
              ...o,
              id: o.id ?? `o${seq}-${i}`,
            }))
          : undefined;
        const p: PropertyRow = {
          id: `p${++seq}`,
          databaseId: a.databaseId,
          name: a.name,
          type: a.kind,
          config: opts ? { ...a.config, options: opts } : { ...a.config },
          position: String(list.length + 1).padStart(16, '0'),
        };
        dbProps.set(a.databaseId, [...list, p]);
        if (a.kind === 'id') {
          for (const r of dbRows(a.databaseId)) {
            const n = nextAuto.get(a.databaseId) ?? 1;
            nextAuto.set(a.databaseId, n + 1);
            rowProps.get(r.id)![p.id] = n;
          }
        }
        if (a.kind === 'relation' && a.twoWayName) {
          const target = String(a.config['targetDatabaseId']);
          const rev: PropertyRow = {
            id: `p${++seq}`,
            databaseId: target,
            name: a.twoWayName,
            type: 'relation',
            config: { targetDatabaseId: a.databaseId, reversePropertyId: p.id },
            position: String((dbProps.get(target)?.length ?? 0) + 1).padStart(16, '0'),
          };
          dbProps.set(target, [...(dbProps.get(target) ?? []), rev]);
          p.config = { ...p.config, reversePropertyId: rev.id };
        }
        return { ...p };
      },
    ),
    propUpdate: vi.fn(
      async (a: { id: string; name?: string; config?: Record<string, unknown>; kind?: string }) => {
        write();
        const p = propById(a.id);
        if (!p) throw bad('introuvable');
        if (a.name) p.name = a.name;
        if (a.kind) p.type = a.kind;
        if (a.config) {
          const opts = Array.isArray(a.config['options'])
            ? (a.config['options'] as { id?: string; name: string }[]).map((o, i) => ({
                color: 'gray',
                ...o,
                id: o.id ?? `o${++seq}-${i}`,
              }))
            : undefined;
          p.config = opts ? { ...a.config, options: opts } : { ...a.config };
        }
        return { ...p };
      },
    ),
    propDelete: vi.fn(async (id: string) => {
      write();
      for (const [db, list] of dbProps)
        dbProps.set(
          db,
          list.filter((p) => p.id !== id),
        );
      return undefined;
    }),
    propMove: vi.fn(async (id: string) => ({ ...propById(id)! })),
    viewCreate: vi.fn(
      async (a: {
        databaseId: string;
        name: string;
        layout: string;
        config: Record<string, unknown>;
      }) => {
        write();
        const list = dbViews.get(a.databaseId) ?? [];
        const v = {
          id: `v${++seq}`,
          databaseId: a.databaseId,
          name: a.name,
          layout: a.layout as ViewRow['layout'],
          config: a.config,
          position: String(list.length + 1).padStart(16, '0'),
        };
        dbViews.set(a.databaseId, [...list, v]);
        return v;
      },
    ),
    viewUpdate: vi.fn(
      async (a: { id: string; name?: string; config?: Record<string, unknown> }) => {
        write();
        for (const list of dbViews.values()) {
          const v = list.find((x) => x.id === a.id);
          if (v) {
            if (a.name) v.name = a.name;
            if (a.config) v.config = a.config;
            return { ...v };
          }
        }
        throw bad('vue');
      },
    ),
    viewDelete: vi.fn(async (id: string) => {
      write();
      for (const [db, list] of dbViews)
        dbViews.set(
          db,
          list.filter((v) => v.id !== id),
        );
      return undefined;
    }),
    pin,
    syncState,
    extraWorkspaces,
    syncStatus: vi.fn(async () => syncStatusNow()),
    syncEnable: vi.fn(async (ws: string) => {
      syncState.enabled = true;
      syncState.workspaceId = ws;
      syncState.pending = 2;
      return syncStatusNow();
    }),
    syncDisable: vi.fn(async () => {
      syncState.enabled = false;
      syncState.pending = 0;
      return syncStatusNow();
    }),
    syncPending: vi.fn(async () =>
      syncState.pending > 0
        ? [
            {
              opId: 'op1',
              workspaceId: syncState.workspaceId ?? 'ws',
              entity: 'node' as const,
              entityId: 'n1',
              fields: { title: 'x' },
              update: null,
              clockMs: 1,
              deviceId: 'dev-test',
            },
          ]
        : [],
    ),
    syncAck: vi.fn(async () => {
      syncState.pending = 0;
      return undefined;
    }),
    syncApplyNodes: vi.fn(async () => ({ applied: 0, unresolved: 0 })),
    syncApplyStruct: vi.fn(async () => ({ applied: 0, skipped: 0, unresolved: 0 })),
    syncDocGet: vi.fn(async () => null),
    syncApplyDoc: vi.fn(async () => 'applied' as const),
    syncSetDocCursor: vi.fn(async () => undefined),
    syncSetRole: vi.fn(async () => syncStatusNow()),
    syncJoinWorkspace: vi.fn(async () => syncStatusNow()),
    syncRecordError: vi.fn(async (_w: string, m: string) => {
      syncState.lastError = m;
      return undefined;
    }),
    opened: [] as string[],
    openExternal: vi.fn(async (url: string) => {
      opened.push(url);
      return undefined;
    }),
    mediaStore,
    threads,
    threadCreate: vi.fn(
      async (id: string, nodeId: string, quote: string, body: string, author: string | null) => {
        if (!body.trim())
          throw { code: 'ipc.invalid', messageKey: 'errors.invalid', retryable: false };
        const at = stamp();
        const t: FakeThread = {
          id,
          nodeId,
          quote: quote.trim(),
          createdAt: at,
          createdBy: author,
          resolvedAt: null,
          resolvedBy: null,
          comments: [
            {
              id: `c${++commentSeq}`,
              threadId: id,
              body: body.trim(),
              author,
              createdAt: at,
              editedAt: null,
            },
          ],
        };
        threads.push(t);
        return structuredClone(t);
      },
    ),
    threadList: vi.fn(async (nodeId: string) =>
      structuredClone(threads.filter((t) => t.nodeId === nodeId)),
    ),
    commentAdd: vi.fn(async (threadId: string, body: string, author: string | null) => {
      const t = threads.find((x) => x.id === threadId);
      if (!t) throw noThread();
      const c = {
        id: `c${++commentSeq}`,
        threadId,
        body: body.trim(),
        author,
        createdAt: stamp(),
        editedAt: null,
      };
      t.comments.push(c);
      return structuredClone(c);
    }),
    commentEdit: vi.fn(async (id: string, body: string) => {
      for (const t of threads) {
        const c = t.comments.find((x) => x.id === id);
        if (c) {
          c.body = body.trim();
          c.editedAt = stamp();
          return structuredClone(c);
        }
      }
      throw noThread();
    }),
    commentDelete: vi.fn(async (id: string) => {
      const t = threads.find((x) => x.comments.some((c) => c.id === id));
      if (!t) throw noThread();
      t.comments = t.comments.filter((c) => c.id !== id);
      if (t.comments.length === 0) threads.splice(threads.indexOf(t), 1);
      return t.comments.length === 0;
    }),
    threadResolve: vi.fn(async (threadId: string, resolved: boolean, author: string | null) => {
      const t = threads.find((x) => x.id === threadId);
      if (!t) throw noThread();
      t.resolvedAt = resolved ? stamp() : null;
      t.resolvedBy = resolved ? author : null;
      return structuredClone(t);
    }),
    threadDelete: vi.fn(async (threadId: string) => {
      const i = threads.findIndex((x) => x.id === threadId);
      if (i < 0) throw noThread();
      threads.splice(i, 1);
      return undefined;
    }),
    versions,
    versionCreate: vi.fn(
      async (
        nodeId: string,
        reason: FakeVersion['reason'],
        label: string | null,
        author: string | null,
      ) => {
        const page = pages.get(nodeId);
        if (!page) throw { code: 'not_found', messageKey: 'errors.notFound', retryable: false };
        const last = versions.filter((v) => v.nodeId === nodeId).at(-1);
        if (last && last.contentJson === page.contentJson) {
          if (reason !== 'auto')
            Object.assign(last, {
              label: label ?? last.label,
              reason: last.reason === 'auto' ? reason : last.reason,
            });
          return metaOf(last);
        }
        const v: FakeVersion = {
          id: `ver${versions.length + 1}`,
          nodeId,
          createdAt: new Date(2026, 5, 17, 10, versions.length).toISOString(),
          reason,
          label,
          author,
          bytes: page.contentJson.length,
          words: page.textPlain.split(/\s+/).filter(Boolean).length,
          contentJson: page.contentJson,
          textPlain: page.textPlain,
        };
        versions.push(v);
        return metaOf(v);
      },
    ),
    versionList: vi.fn(async (nodeId: string) =>
      versions
        .filter((v) => v.nodeId === nodeId)
        .map(metaOf)
        .reverse(),
    ),
    versionGet: vi.fn(async (id: string) => {
      const v = versions.find((x) => x.id === id);
      if (!v) throw { code: 'not_found', messageKey: 'errors.notFound', retryable: false };
      return v;
    }),
    versionRename: vi.fn(async (id: string, label: string | null) => {
      const v = versions.find((x) => x.id === id);
      if (v)
        Object.assign(v, { label, reason: v.reason === 'auto' && label ? 'manual' : v.reason });
      return undefined;
    }),
    versionDelete: vi.fn(async (id: string) => {
      const i = versions.findIndex((x) => x.id === id);
      if (i >= 0) versions.splice(i, 1);
      return undefined;
    }),
    mediaPut: vi.fn(async (data: string) => {
      const hash = createHash('sha256').update(data).digest('hex');
      mediaStore.set(hash, data);
      return { hash, mime: 'image/png', size: data.length };
    }),
    mediaGet: vi.fn(async (hash: string) => {
      const data = mediaStore.get(hash);
      if (data === undefined) throw { code: 'not_found', messageKey: 'errors.notFound' };
      return { data, mime: 'image/png' };
    }),
    habitLogList: vi.fn(async (_db: string, from: string, to: string) =>
      [...habitLog]
        .map((k) => ({ rowId: k.split('|')[0]!, day: k.split('|')[1]! }))
        .filter((e) => e.day >= from && e.day <= to),
    ),
    habitLogSet: vi.fn(async (rowId: string, day: string, done: boolean) => {
      if (done) habitLog.add(`${rowId}|${day}`);
      else habitLog.delete(`${rowId}|${day}`);
      return undefined;
    }),
    remindersDue: vi.fn(async () => [] as Reminder[]),
    reminderAck: vi.fn(async () => undefined),
    reminderNotify: vi.fn(async () => undefined),
    pinStatus: vi.fn(async () => pinState()),
    pinSet: vi.fn(async (code: string, current: string | null) => {
      if (!/^(\d{4}|\d{6})$/.test(code))
        throw { code: 'ipc.invalid', messageKey: 'errors.ipc.invalid', retryable: false };
      if (pin.code !== null) checkPin(current);
      pin.code = code;
      pin.failed = 0;
      return pinState();
    }),
    pinDisable: vi.fn(async (code: string) => {
      checkPin(code);
      pin.code = null;
      return pinState();
    }),
    pinVerify: vi.fn(async (code: string) => {
      checkPin(code);
      pin.locked = false;
      return pinState();
    }),
    pinLock: vi.fn(async () => {
      if (pin.code === null)
        throw { code: 'ipc.invalid', messageKey: 'errors.ipc.invalid', retryable: false };
      pin.locked = true;
      return pinState();
    }),
    pinOptions: vi.fn(async (code: string, lockOnStart: boolean, idle: number) => {
      checkPin(code);
      pin.lockOnStart = lockOnStart;
      pin.idle = idle;
      return pinState();
    }),
    isDb,
    rowProps,
    dbProps,
    dbViews,
    nodeCreate: vi.fn(
      async (a: {
        parentId: string | null;
        kind: 'folder' | 'page';
        title: string;
        beforeId: string | null;
      }) => {
        write();
        const id = `0192f0a0-0000-7000-8000-${String(++seq).padStart(12, '0')}`;
        const row: NodeRow = {
          id,
          workspaceId: 'ws',
          parentId: a.parentId,
          kind: a.kind,
          title: a.title,
          position: slot(a.parentId, a.beforeId),
          isFavorite: false,
          updatedAt: ts(),
          deletedAt: null,
        };
        nodes = [...nodes, row];
        return row;
      },
    ),
    nodeRename: vi.fn(async (id: string, title: string) => {
      write();
      if (state.failRename) throw ioError;
      const row = { ...get(id), title, updatedAt: ts() };
      put(row);
      return row;
    }),
    nodeMove: vi.fn(async (id: string, parentId: string | null, beforeId: string | null) => {
      write();
      if (parentId && (parentId === id || desc(id).includes(parentId)))
        throw { code: 'ipc.invalid', messageKey: 'errors.ipc.invalid', retryable: false };
      const row = { ...get(id), parentId, position: slot(parentId, beforeId, id), updatedAt: ts() };
      put(row);
      return row;
    }),
    nodeSetFavorite: vi.fn(async (id: string, favorite: boolean) => {
      write();
      const row = { ...get(id), isFavorite: favorite };
      put(row);
      return row;
    }),
    nodeDelete: vi.fn(async (id: string) => {
      write();
      const stamp = ts();
      const ids = [id, ...desc(id)].filter((i) => !get(i).deletedAt);
      nodes = nodes.map((n) => (ids.includes(n.id) ? { ...n, deletedAt: stamp } : n));
      return ids.length;
    }),
    nodeRestore: vi.fn(async (id: string) => {
      write();
      const stamp = get(id).deletedAt;
      nodes = nodes.map((n) =>
        n.deletedAt === stamp && (n.id === id || desc(id).includes(n.id))
          ? { ...n, deletedAt: null }
          : n,
      );
      return get(id);
    }),
    trashList: vi.fn(async () =>
      nodes.filter(
        (n) => n.deletedAt && !(n.parentId && get(n.parentId).deletedAt === n.deletedAt),
      ),
    ),
    nodePurge: vi.fn(async (id: string) => {
      write();
      const stamp = get(id).deletedAt;
      const ids = [id, ...desc(id)].filter((i) => get(i).deletedAt === stamp);
      nodes = nodes.filter((n) => !ids.includes(n.id));
      return ids.length;
    }),
    trashEmpty: vi.fn(async () => {
      write();
      const n = nodes.filter((x) => x.deletedAt).length;
      nodes = nodes.filter((x) => !x.deletedAt);
      return n;
    }),
    recentTouch: vi.fn(async () => undefined),
    recentList: vi.fn(async () => [] as NodeRow[]),
    pageGet: vi.fn(async (id: string) => ({
      docState: pages.get(id)?.docState ?? null,
      updatedAt: null,
    })),
    pageSave: vi.fn(
      async (a: {
        id: string;
        docState: string;
        contentJson: string;
        textPlain: string;
        linkTargets: string[];
      }) => {
        if (state.failPageSave) throw ioError;
        pages.set(a.id, a);
        return { updatedAt: ts(), version: 2 };
      },
    ),
    backlinksList: vi.fn(async (id: string) =>
      live().filter((n) => pages.get(n.id)?.linkTargets.includes(id)),
    ),
    searchPages: vi.fn(async (_ws: string, q: string): Promise<SearchHit[]> => {
      const needle = q.toLowerCase();
      return live()
        .filter(
          (n) =>
            n.title.toLowerCase().includes(needle) ||
            (pages.get(n.id)?.textPlain ?? '').toLowerCase().includes(needle),
        )
        .map((n) => ({
          nodeId: n.id,
          kind: n.kind,
          title: n.title,
          snippet: `\u0002${q}\u0003`,
          updatedAt: n.updatedAt,
        }));
    }),
  };
  return api;
}
export type FakeBackend = ReturnType<typeof fakeBackend>;

export interface RenderOptions {
  /** PIN préconfiguré (démarre verrouillé si `locked`). */
  pin?: { code: string; locked?: boolean; idle?: number; lockOnStart?: boolean };
  /** Faux client d'authentification (sinon : cloud non configuré). */
  authClient?: AuthClient;
  /** Faux serveur de synchronisation. */
  syncClient?: SyncClient;
  /** Faux transport de présence (sinon : éditeur purement local). */
  presence?: PresenceService;
}

export async function renderApp(initial: Record<string, string> = {}, options: RenderOptions = {}) {
  await initI18n('fr');
  await i18n.changeLanguage('fr');
  useNav.setState({
    stack: [{ name: 'home' }],
    index: 0,
    route: { name: 'home' },
    canBack: false,
    canForward: false,
  });
  useToasts.setState({ toasts: [] });
  const api = fakeBackend({ 'pref.locale': '"fr"', ...initial });
  if (options.pin) {
    api.pin.code = options.pin.code;
    api.pin.locked = options.pin.locked ?? false;
    api.pin.idle = options.pin.idle ?? 0;
    api.pin.lockOnStart = options.pin.lockOnStart ?? true;
  }
  const onError = vi.fn();
  const report = (e: unknown) => {
    onError(e);
    useToasts.getState().push('error', String((e as { messageKey?: string }).messageKey ?? e));
  };
  const preferences = createPreferencesStore(api, report);
  const databases = createDatabasesStore(api, report, 10);
  const commands = createCommandsStore(api, report);
  const pages = createPagesStore(api, report);
  const security = createSecurityStore(api, report);
  const account = createAccountStore({
    client: options.authClient ?? null,
    vault: { load: async () => null, save: async () => {}, clear: async () => {} },
    onError: report,
  });
  const syncStore = createSyncStore();
  const syncControl = createSyncControl({
    api,
    client: options.syncClient ?? createUnavailableSyncClient(() => new SyncError('network')),
    store: syncStore,
    engine: createSyncEngine({
      api,
      client: options.syncClient ?? createUnavailableSyncClient(() => new SyncError('network')),
      store: syncStore,
      user: () => (account.getState().userId ? { id: account.getState().userId as string } : null),
      workspaceName: () => 'Personnel',
      snapshot: () => ({ contentJson: '{"type":"doc"}', textPlain: '' }),
      live: { get: () => undefined, applyUpdate: () => undefined },
    }),
    onRemoteChange: () => undefined,
    onError: report,
  });
  const deps: AppDeps = {
    sync: { store: syncStore, control: syncControl },
    presence: options.presence ?? null,
    account,
    onError: report,
    preferences,
    commands,
    pages,
    databases,
    security,
    ipc: api,
    config: { supabaseUrl: null, supabaseAnonKey: null, cloudEnabled: false },
  };
  const utils = render(<AppRoot deps={deps} />);
  await vi.waitFor(() => expect(security.getState().status).toBe('ready'));
  if (!api.pin.locked) {
    await vi.waitFor(() => expect(preferences.getState().loaded).toBe(true));
    await vi.waitFor(() => expect(pages.getState().status).toBe('ready'));
  }
  return {
    ...utils,
    api,
    preferences,
    commands,
    pages,
    databases,
    security,
    account,
    syncStore,
    onError,
  };
}
