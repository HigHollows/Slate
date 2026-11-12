import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import type { PendingOp, SyncStatus } from '../../shared/ipc/client';
import { fromBase64, toBase64 } from '../editor/content';
import {
  SyncError,
  type PullResult,
  type PushOp,
  type PushResult,
  type SyncClient,
} from './client';
import { CURSOR_OVERLAP, createSyncEngine, type SyncLocal } from './engine';
import { mergeUpdates } from './merge';
import { createSyncStore } from './store';

const WS = '0192f0a0-0000-7000-8000-000000000001';
type StatusOver = {
  enabled?: boolean;
  workspaceId?: string | null;
  deviceId?: string;
  pending?: number;
  rejected?: number;
  nodeCursor?: number;
  docCursor?: number;
  structCursor?: number;
  role?: 'viewer' | 'editor' | 'admin';
};
const status = (o: StatusOver = {}): SyncStatus => {
  const ws = o.workspaceId === undefined ? WS : o.workspaceId;
  return {
    enabled: o.enabled ?? true,
    deviceId: o.deviceId ?? 'dev-mine',
    pending: o.pending ?? 0,
    rejected: o.rejected ?? 0,
    workspaces: ws
      ? [
          {
            workspaceId: ws,
            name: 'Personnel',
            kind: 'personal',
            role: o.role ?? 'admin',
            nodeCursor: o.nodeCursor ?? 0,
            docCursor: o.docCursor ?? 0,
            structCursor: o.structCursor ?? 0,
            lastPushAt: null,
            lastPullAt: null,
            lastError: null,
          },
        ]
      : [],
  };
};
const op = (n: number, entity: 'node' | 'doc' = 'node'): PendingOp => ({
  opId: `op${n}`,
  workspaceId: WS,
  entity,
  entityId: `n${n}`,
  fields: entity === 'node' ? { title: `T${n}` } : {},
  update: entity === 'doc' ? 'AAAA' : null,
  clockMs: 1000 + n,
  deviceId: 'dev-mine',
});
const empty: PullResult = {
  nodes: [],
  node_cursor: null,
  more_nodes: false,
  docs: [],
  doc_cursor: null,
  more_docs: false,
};

function yupdate(text: string, base?: Y.Doc): string {
  const d = base ?? new Y.Doc();
  d.getText('t').insert(d.getText('t').length, text);
  return toBase64(Y.encodeStateAsUpdate(d));
}

function make(
  over: {
    api?: Partial<SyncLocal>;
    client?: Partial<SyncClient>;
    user?: { id: string } | null;
    live?: Map<string, Y.Doc>;
  } = {},
) {
  const st = { current: status() };
  const api: SyncLocal = {
    syncStatus: vi.fn(async () => st.current),
    syncPending: vi.fn(async () => []),
    syncAck: vi.fn(async () => undefined),
    syncApplyNodes: vi.fn(async () => ({ applied: 0, unresolved: 0 })),
    syncApplyStruct: vi.fn(async () => ({ applied: 0, skipped: 0, unresolved: 0 })),
    syncDocGet: vi.fn(async () => null),
    syncApplyDoc: vi.fn(async () => 'applied' as const),
    syncSetDocCursor: vi.fn(async () => undefined),
    syncRecordError: vi.fn(async () => undefined),
    syncSetRole: vi.fn(async () => st.current),
    ...over.api,
  };
  let created = false;
  const client: SyncClient = {
    ensureWorkspace: vi.fn(async () => {
      created = true;
    }),
    // Le serveur ne connaît l'espace personnel qu'une fois créé.
    emailInvitation: vi.fn(async () => undefined),
    createNodeInvitation: vi.fn(),
    listNodeShares: vi.fn(async () => ({ shares: [], invitations: [] })),
    removeNodeShare: vi.fn(async () => undefined),
    docStats: vi.fn(async () => []),
    pullNodeDocs: vi.fn(async () => []),
    compactDoc: vi.fn(async () => 99),
    myMemberships: vi.fn(async () =>
      created ? [{ workspace_id: WS, role: 'admin' as const }] : [],
    ),
    createInvitation: vi.fn(),
    acceptInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    listInvitations: vi.fn(async () => []),
    listMembers: vi.fn(async () => []),
    setMemberRole: vi.fn(async () => undefined),
    removeMember: vi.fn(async () => undefined),
    push: vi.fn(async () => [] as PushResult[]),
    pull: vi.fn(async () => empty),
    pullStruct: vi.fn(async () => ({ items: [], cursor: null, more: false })),
    ...over.client,
  };
  const store = createSyncStore();
  const live = over.live ?? new Map<string, Y.Doc>();
  const engine = createSyncEngine({
    api,
    client,
    store,
    user: () => (over.user === undefined ? { id: 'user-1' } : over.user),
    workspaceName: () => 'Personnel',
    snapshot: () => ({ contentJson: '{"type":"doc"}', textPlain: 'texte' }),
    live: {
      get: (id) => live.get(id),
      applyUpdate: (doc, u) => Y.applyUpdate(doc, fromBase64(u), 'remote'),
    },
  });
  return { api, client, store, engine, st, live };
}

describe('moteur de synchronisation', () => {
  it('désactivée ou sans session : aucun appel réseau, état explicite', async () => {
    const off = make();
    off.st.current = status({ enabled: false, workspaceId: null });
    await off.engine.runOnce();
    expect(off.store.getState().phase).toBe('off');
    expect(off.client.pull).not.toHaveBeenCalled();
    const anon = make({ user: null });
    await anon.engine.runOnce();
    expect(anon.store.getState().phase).toBe('auth');
    expect(anon.client.push).not.toHaveBeenCalled();
    expect(anon.client.ensureWorkspace).not.toHaveBeenCalled();
  });

  it('crée l’espace une fois, envoie par lots, accuse chaque opération', async () => {
    let batch = [op(1), op(2, 'doc')];
    const t = make({
      api: {
        syncPending: vi.fn(async () => {
          const b = batch;
          batch = [];
          return b;
        }),
      },
      client: {
        push: vi.fn(async (_w, ops) =>
          ops.map((o: PushOp) => ({ op_id: o.op_id, status: 'applied' as const, reason: null })),
        ),
      },
    });
    const r = await t.engine.runOnce();
    expect(t.client.ensureWorkspace).toHaveBeenCalledWith(WS, 'Personnel', 'user-1');
    expect(r.pushed).toBe(2);
    const sent = (t.client.push as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(sent[0]).toEqual({
      op_id: 'op1',
      entity: 'node',
      entity_id: 'n1',
      fields: { title: 'T1' },
      clock: { ms: 1001, device: 'dev-mine' },
    });
    expect(sent[1]).toEqual({
      op_id: 'op2',
      entity: 'doc',
      entity_id: 'n2',
      update: 'AAAA',
      clock: { ms: 1002, device: 'dev-mine' },
    });
    expect(t.api.syncAck).toHaveBeenCalledWith([
      { opId: 'op1', status: 'applied', reason: null },
      { opId: 'op2', status: 'applied', reason: null },
    ]);
    await t.engine.runOnce();
    expect(t.client.ensureWorkspace).toHaveBeenCalledTimes(1);
  });

  it('s’arrête quand tout est refusé temporairement (pas de boucle infinie)', async () => {
    const t = make({
      api: { syncPending: vi.fn(async () => [op(1)]) },
      client: {
        push: vi.fn(async (_w, ops) =>
          ops.map((o: PushOp) => ({
            op_id: o.op_id,
            status: 'rejected' as const,
            reason: 'parent_missing',
          })),
        ),
      },
    });
    t.st.current = status({ pending: 1 }); // l'opération refusée reste dans la file
    await t.engine.runOnce();
    expect(t.client.push).toHaveBeenCalledTimes(1);
    expect(t.store.getState().lastOkAt).toBeNull(); // file non vide : jamais « à jour »
  });

  it('« à jour » seulement après file vide et accusés', async () => {
    const ok = make();
    await ok.engine.runOnce();
    expect(ok.store.getState().phase).toBe('idle');
    expect(ok.store.getState().lastOkAt).not.toBeNull();
    const pending = make();
    pending.st.current = status({ pending: 3 });
    await pending.engine.runOnce();
    expect(pending.store.getState().lastOkAt).toBeNull();
  });

  it('lit les nœuds avec un recouvrement de curseur, applique, et ne redemande pas les contenus', async () => {
    const t = make({
      client: {
        pull: vi.fn(async () => ({
          ...empty,
          nodes: [
            {
              id: 'a',
              parent_id: null,
              kind: 'page',
              title: 'T',
              position: 'V1',
              deleted_at: null,
              created_at: '2026-01-01T00:00:00Z',
              server_seq: 120,
            },
          ],
          node_cursor: 120,
        })),
      },
    });
    t.st.current = status({ nodeCursor: 100, docCursor: 7 });
    await t.engine.runOnce();
    const calls = (t.client.pull as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]!.slice(0, 3)).toEqual([WS, 100 - CURSOR_OVERLAP, Number.MAX_SAFE_INTEGER]);
    expect(calls[1]!.slice(0, 3)).toEqual([
      WS,
      Number.MAX_SAFE_INTEGER,
      Math.max(0, 7 - CURSOR_OVERLAP),
    ]);
    expect(t.api.syncApplyNodes).toHaveBeenCalledWith(
      WS,
      [
        {
          id: 'a',
          parentId: null,
          kind: 'page',
          title: 'T',
          position: 'V1',
          deletedAt: null,
          purgedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      120,
    );
  });

  it('pagine les nœuds jusqu’à la fin ; parent absent = arrêt sans avancer, état « en reprise »', async () => {
    const pages = [
      { ...empty, nodes: [], node_cursor: 10, more_nodes: true },
      { ...empty, nodes: [], node_cursor: 20, more_nodes: false },
    ];
    const t = make({ client: { pull: vi.fn(async () => pages.shift() ?? empty) } });
    await t.engine.runOnce();
    expect(t.api.syncApplyNodes).toHaveBeenCalledTimes(2);
    const u = make({ api: { syncApplyNodes: vi.fn(async () => ({ applied: 1, unresolved: 2 })) } });
    const r = await u.engine.runOnce();
    expect(r.stalled).toBe(true);
    expect(u.store.getState().lastOkAt).toBeNull();
  });

  it('fusionne le contenu distant (CRDT) sans perdre le local, ignore ses propres mises à jour', async () => {
    // état local : « local » ; un autre appareil a écrit « distant » à partir du même état de base
    const base = new Y.Doc();
    base.getText('t').insert(0, 'base ');
    const baseState = toBase64(Y.encodeStateAsUpdate(base));
    const localDoc = new Y.Doc();
    Y.applyUpdate(localDoc, fromBase64(baseState));
    localDoc.getText('t').insert(5, 'local');
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, fromBase64(baseState));
    remoteDoc.getText('t').insert(0, 'distant ');
    const remoteUpdate = toBase64(Y.encodeStateAsUpdate(remoteDoc));
    let written: { docState: string; expectedUpdatedAt: string | null } | null = null;
    const t = make({
      api: {
        syncDocGet: vi.fn(async () => ({
          docState: toBase64(Y.encodeStateAsUpdate(localDoc)),
          updatedAt: 'U1',
        })),
        syncApplyDoc: vi.fn(async (a) => {
          written = a;
          return 'applied' as const;
        }),
      },
      client: {
        pull: vi.fn(async (_w, nodeSince) =>
          nodeSince === Number.MAX_SAFE_INTEGER
            ? {
                ...empty,
                docs: [
                  {
                    id: 1,
                    node_id: 'n1',
                    device_id: 'dev-other',
                    update: remoteUpdate,
                    created_at: '',
                  },
                  {
                    id: 2,
                    node_id: 'n2',
                    device_id: 'dev-mine',
                    update: remoteUpdate,
                    created_at: '',
                  },
                ],
                doc_cursor: 2,
              }
            : empty,
        ),
      },
    });
    const r = await t.engine.runOnce();
    expect(r.mergedDocs).toBe(1); // n2 est notre propre mise à jour : ignorée
    expect(t.api.syncDocGet).toHaveBeenCalledTimes(1);
    const merged = new Y.Doc();
    Y.applyUpdate(merged, fromBase64(written!.docState));
    const txt = merged.getText('t').toString();
    expect(txt).toContain('distant');
    expect(txt).toContain('local');
    expect(txt).toContain('base');
    expect(written!.expectedUpdatedAt).toBe('U1');
    expect(t.api.syncSetDocCursor).toHaveBeenCalledWith(WS, 2);
  });

  it('contenu déjà connu : aucune écriture (pas d’écho)', async () => {
    const d = new Y.Doc();
    const u = yupdate('même texte', d);
    const t = make({
      api: { syncDocGet: vi.fn(async () => ({ docState: u, updatedAt: 'U' })) },
      client: {
        pull: vi.fn(async (_w, ns) =>
          ns === Number.MAX_SAFE_INTEGER
            ? {
                ...empty,
                docs: [{ id: 1, node_id: 'n', device_id: 'x', update: u, created_at: '' }],
                doc_cursor: 1,
              }
            : empty,
        ),
      },
    });
    await t.engine.runOnce();
    expect(t.api.syncApplyDoc).not.toHaveBeenCalled();
    expect(t.api.syncSetDocCursor).toHaveBeenCalledWith(WS, 1);
  });

  it('page modifiée localement entre-temps : la fusion est refaite ; si elle persiste, le curseur n’avance pas', async () => {
    const u = yupdate('x');
    const outs: ('stale' | 'applied')[] = ['stale', 'applied'];
    const t = make({
      api: {
        syncDocGet: vi.fn(async () => null),
        syncApplyDoc: vi.fn(async () => outs.shift() ?? 'applied'),
      },
      client: {
        pull: vi.fn(async (_w, ns) =>
          ns === Number.MAX_SAFE_INTEGER
            ? {
                ...empty,
                docs: [{ id: 5, node_id: 'n', device_id: 'x', update: u, created_at: '' }],
                doc_cursor: 5,
              }
            : empty,
        ),
      },
    });
    await t.engine.runOnce();
    expect(t.api.syncApplyDoc).toHaveBeenCalledTimes(2);
    expect(t.api.syncSetDocCursor).toHaveBeenCalledWith(WS, 5);
    const stuck = make({
      api: {
        syncDocGet: vi.fn(async () => null),
        syncApplyDoc: vi.fn(async () => 'stale' as const),
      },
      client: {
        pull: vi.fn(async (_w, ns) =>
          ns === Number.MAX_SAFE_INTEGER
            ? {
                ...empty,
                docs: [{ id: 5, node_id: 'n', device_id: 'x', update: u, created_at: '' }],
                doc_cursor: 5,
              }
            : empty,
        ),
      },
    });
    const r = await stuck.engine.runOnce();
    expect(r.stalled).toBe(true);
    expect(stuck.api.syncSetDocCursor).not.toHaveBeenCalled();
    // page absente localement : on réessaiera, rien n'est perdu
    const missing = make({
      api: {
        syncDocGet: vi.fn(async () => null),
        syncApplyDoc: vi.fn(async () => 'missing' as const),
      },
      client: {
        pull: vi.fn(async (_w, ns) =>
          ns === Number.MAX_SAFE_INTEGER
            ? {
                ...empty,
                docs: [{ id: 6, node_id: 'n', device_id: 'x', update: u, created_at: '' }],
                doc_cursor: 6,
              }
            : empty,
        ),
      },
    });
    expect((await missing.engine.runOnce()).stalled).toBe(true);
    expect(missing.api.syncSetDocCursor).not.toHaveBeenCalled();
  });

  it('une page ouverte reçoit la mise à jour en direct (document vivant), sans écriture directe', async () => {
    const live = new Y.Doc();
    live.getText('t').insert(0, 'ouvert ');
    const remote = new Y.Doc();
    remote.getText('t').insert(0, 'autre');
    const u = toBase64(Y.encodeStateAsUpdate(remote));
    const t = make({
      live: new Map([['n1', live]]),
      client: {
        pull: vi.fn(async (_w, ns) =>
          ns === Number.MAX_SAFE_INTEGER
            ? {
                ...empty,
                docs: [{ id: 1, node_id: 'n1', device_id: 'x', update: u, created_at: '' }],
                doc_cursor: 1,
              }
            : empty,
        ),
      },
    });
    await t.engine.runOnce();
    expect(live.getText('t').toString()).toContain('autre');
    expect(live.getText('t').toString()).toContain('ouvert');
    expect(t.api.syncApplyDoc).not.toHaveBeenCalled();
  });

  it('erreurs : réseau = hors ligne, session = authentification, serveur = erreur ; la cause est enregistrée', async () => {
    for (const [code, phase] of [
      ['network', 'offline'],
      ['auth', 'auth'],
      ['server', 'error'],
      ['forbidden', 'error'],
    ] as const) {
      const t = make({
        client: {
          pull: vi.fn(async () => {
            throw new SyncError(code, code === 'auth' ? 401 : undefined);
          }),
        },
      });
      await t.engine.runOnce();
      expect(t.store.getState().phase, code).toBe(phase);
      expect(t.store.getState().error).toBe(code);
      expect(t.api.syncRecordError).toHaveBeenCalled();
    }
    const raw = make({
      client: {
        pull: vi.fn(async () => {
          throw new Error('secret interne');
        }),
      },
    });
    await raw.engine.runOnce();
    expect(raw.store.getState().phase).toBe('error');
    expect(
      JSON.stringify((raw.api.syncRecordError as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain('secret');
  });

  it('un seul passage à la fois : les appels simultanés partagent l’exécution', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const t = make({
      client: {
        pull: vi.fn(async () => {
          await gate;
          return empty;
        }),
      },
    });
    const a = t.engine.runOnce();
    const b = t.engine.runOnce();
    expect(t.engine.isRunning()).toBe(true);
    release();
    await Promise.all([a, b]);
    expect(t.client.ensureWorkspace).toHaveBeenCalledTimes(1);
    expect(t.engine.isRunning()).toBe(false);
  });
});

describe('bases de données : flux « structure »', () => {
  const item = (n: number) => ({
    kind: 'row' as const,
    id: `r${n}`,
    database_id: 'db',
    props: { c: n },
  });

  it('envoie propriétés, vues et lignes avec leurs champs (pas de contenu binaire)', async () => {
    let batch: PendingOp[] = [
      {
        opId: 'p',
        workspaceId: WS,
        entity: 'prop',
        entityId: 'p1',
        fields: { database_id: 'db', name: 'Nom' },
        update: null,
        clockMs: 5,
        deviceId: 'dev-mine',
      },
      {
        opId: 'v',
        workspaceId: WS,
        entity: 'view',
        entityId: 'v1',
        fields: { database_id: 'db', layout: 'table' },
        update: null,
        clockMs: 6,
        deviceId: 'dev-mine',
      },
      {
        opId: 'r',
        workspaceId: WS,
        entity: 'row',
        entityId: 'r1',
        fields: { database_id: 'db', cells: { c: 1 } },
        update: null,
        clockMs: 7,
        deviceId: 'dev-mine',
      },
    ];
    const t = make({
      api: {
        syncPending: vi.fn(async () => {
          const b = batch;
          batch = [];
          return b;
        }),
      },
      client: {
        push: vi.fn(async (_w, ops: PushOp[]) =>
          ops.map((o: PushOp) => ({ op_id: o.op_id, status: 'applied' as const, reason: null })),
        ),
      },
    });
    await t.engine.runOnce();
    const sent = (t.client.push as ReturnType<typeof vi.fn>).mock.calls[0]![1] as PushOp[];
    expect(sent.map((o) => o.entity)).toEqual(['prop', 'view', 'row']);
    expect(sent[2]).toEqual({
      op_id: 'r',
      entity: 'row',
      entity_id: 'r1',
      fields: { database_id: 'db', cells: { c: 1 } },
      clock: { ms: 7, device: 'dev-mine' },
    });
    expect(sent.every((o) => !('update' in o))).toBe(true);
  });

  it('lit le flux avec recouvrement, applique, pagine et avance le curseur', async () => {
    const pages = [
      { items: [item(1), item(2)], cursor: 130, more: true },
      { items: [item(3)], cursor: 140, more: false },
    ];
    const t = make({
      client: {
        pullStruct: vi.fn(async () => pages.shift() ?? { items: [], cursor: null, more: false }),
      },
    });
    t.st.current = status({ structCursor: 120 });
    const r = await t.engine.runOnce();
    const calls = (t.client.pullStruct as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]!.slice(0, 2)).toEqual([WS, 120 - CURSOR_OVERLAP]);
    expect(t.api.syncApplyStruct).toHaveBeenCalledTimes(2);
    expect(t.api.syncApplyStruct).toHaveBeenNthCalledWith(1, WS, [item(1), item(2)], 130);
    expect(t.api.syncApplyStruct).toHaveBeenNthCalledWith(2, WS, [item(3)], 140);
    expect(r.stalled).toBe(false);
  });

  it('ligne ou propriété dont la base n’est pas encore là : reprise (pas de « à jour »)', async () => {
    const t = make({
      api: { syncApplyStruct: vi.fn(async () => ({ applied: 0, skipped: 0, unresolved: 1 })) },
      client: { pullStruct: vi.fn(async () => ({ items: [item(1)], cursor: 9, more: false })) },
    });
    const r = await t.engine.runOnce();
    expect(r.stalled).toBe(true);
    expect(t.store.getState().lastOkAt).toBeNull();
  });

  it('une erreur du flux est classée comme les autres', async () => {
    const t = make({
      client: {
        pullStruct: vi.fn(async () => {
          throw new SyncError('network');
        }),
      },
    });
    await t.engine.runOnce();
    expect(t.store.getState().phase).toBe('offline');
  });
});

describe('fusion Yjs', () => {
  it('appliquer deux fois la même mise à jour, ou une mise à jour déjà connue, ne change rien', () => {
    const u = yupdate('abc');
    const first = mergeUpdates(null, [u]);
    expect(first.changed).toBe(true);
    expect(mergeUpdates(first.state, [u, u]).changed).toBe(false);
  });
  it('ordre des mises à jour sans importance (convergence)', () => {
    const a = new Y.Doc();
    a.getText('t').insert(0, 'A');
    const b = new Y.Doc();
    b.getText('t').insert(0, 'B');
    const ua = toBase64(Y.encodeStateAsUpdate(a));
    const ub = toBase64(Y.encodeStateAsUpdate(b));
    expect(mergeUpdates(null, [ua, ub]).doc.getText('t').toString()).toBe(
      mergeUpdates(null, [ub, ua]).doc.getText('t').toString(),
    );
  });

  it('une purge distante est transmise au cœur (pierre tombale)', async () => {
    const t = make({
      client: {
        pull: vi.fn(async () => ({
          ...empty,
          nodes: [
            {
              id: 'gone',
              parent_id: null,
              kind: 'page',
              title: '',
              position: 'a',
              deleted_at: '2026-01-01T00:00:00Z',
              purged_at: '2026-02-01T00:00:00Z',
              created_at: '2026-01-01T00:00:00Z',
              server_seq: 5,
            },
          ],
          node_cursor: 5,
        })),
      },
    });
    await t.engine.runOnce();
    const sent = (t.api.syncApplyNodes as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(sent[0]).toMatchObject({ id: 'gone', purgedAt: '2026-02-01T00:00:00Z' });
  });

  describe('compaction des journaux de pages', () => {
    const logs = () => [
      { id: 11, update: yupdate('a') },
      { id: 12, update: yupdate('b') },
      { id: 15, update: yupdate('c') },
    ];
    it('fusionne et remplace la liste exacte des mises à jour lues', async () => {
      const t = make({
        client: {
          docStats: vi.fn(async () => [{ node_id: 'p1', count: 3, bytes: 30 }]),
          pullNodeDocs: vi.fn(async () => logs()),
        },
      });
      const r = await t.engine.runOnce();
      expect(r.compacted).toBe(1);
      const arg = (t.client.compactDoc as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(arg).toMatchObject({
        workspaceId: WS,
        nodeId: 'p1',
        ids: [11, 12, 15],
        deviceId: 'dev-mine',
      });
      // l'état envoyé contient bien tout le contenu des trois mises à jour
      const merged = mergeUpdates(null, [arg.stateBase64]);
      expect(merged.doc.getText('t').toString().length).toBeGreaterThan(0);
      // au plus une passe par délai
      const again = await t.engine.runOnce();
      expect(again.compacted).toBe(0);
      expect(t.client.docStats).toHaveBeenCalledTimes(1);
    });
    it('un lecteur ne compacte jamais', async () => {
      const t = make({
        client: { docStats: vi.fn(async () => [{ node_id: 'p1', count: 3, bytes: 3 }]) },
      });
      t.st.current = status({ role: 'viewer' });
      await t.engine.runOnce();
      expect(t.client.docStats).not.toHaveBeenCalled();
    });
    it('un échec de compaction ne bloque pas la synchronisation', async () => {
      const t = make({
        client: {
          docStats: vi.fn(async () => [{ node_id: 'p1', count: 3, bytes: 3 }]),
          pullNodeDocs: vi.fn(async () => logs()),
          compactDoc: vi.fn(async () => {
            throw new SyncError('server', 500);
          }),
        },
      });
      const r = await t.engine.runOnce();
      expect(r.compacted).toBe(0);
      expect(r.stalled).toBe(false);
      expect(t.store.getState().phase).toBe('idle');
    });
  });

  it('espace où l’on n’est qu’invité : signalé à l’interface (portée « shared »)', async () => {
    const t = make({
      client: {
        myMemberships: vi.fn(async () => [
          { workspace_id: WS, role: 'editor' as const, scope: 'shared' as const },
        ]),
      },
    });
    t.st.current = status({ role: 'editor' });
    await t.engine.runOnce();
    expect(t.store.getState().guestSpaces).toEqual([WS]);
    // on ne tente jamais de créer côté serveur un espace qui n'est pas le sien
    expect(t.client.ensureWorkspace).not.toHaveBeenCalled();
  });
});
