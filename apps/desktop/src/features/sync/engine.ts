import type {
  PendingOp,
  WorkspaceSync,
  RemoteNode,
  RemoteStruct,
  SyncAck,
  SyncStatus,
} from '../../shared/ipc/client';
import { SyncError, type PullDoc, type PullNode, type PushOp, type SyncClient } from './client';
import { mergeUpdates } from './merge';
import type { SyncStore } from './store';
import type * as Y from 'yjs';

/** Accès local (commandes IPC du cœur Rust). */
export interface SyncLocal {
  syncStatus(): Promise<SyncStatus>;
  syncPending(limit?: number): Promise<PendingOp[]>;
  syncAck(results: SyncAck[]): Promise<void>;
  syncApplyNodes(
    ws: string,
    nodes: RemoteNode[],
    cursor: number | null,
  ): Promise<{ applied: number; unresolved: number }>;
  syncApplyStruct(
    ws: string,
    items: RemoteStruct[],
    cursor: number | null,
  ): Promise<{ applied: number; skipped: number; unresolved: number }>;
  syncDocGet(nodeId: string): Promise<{ docState: string; updatedAt: string } | null>;
  syncApplyDoc(a: {
    nodeId: string;
    docState: string;
    contentJson: string;
    textPlain: string;
    expectedUpdatedAt: string | null;
  }): Promise<'applied' | 'stale' | 'missing'>;
  syncSetDocCursor(ws: string, cursor: number): Promise<void>;
  syncRecordError(ws: string, message: string): Promise<void>;
  syncSetRole(ws: string, role: string | null): Promise<SyncStatus>;
}

export interface SyncEngineDeps {
  api: SyncLocal;
  client: SyncClient;
  store: SyncStore;
  /** Compte connecté : identifiant (propriétaire de l'espace) ; `null` = pas de session. */
  user(): { id: string } | null;
  workspaceName(ws: string): string;
  /** Instantané JSON/texte d'un document fusionné (éditeur sans affichage). */
  snapshot(doc: Y.Doc): { contentJson: string; textPlain: string };
  /** Pages ouvertes : les mises à jour distantes y sont appliquées en direct (l'enregistrement automatique persiste). */
  live: { get(nodeId: string): Y.Doc | undefined; applyUpdate(doc: Y.Doc, update: string): void };
  pageSize?: number;
}

/** Recouvrement des curseurs : les séquences Postgres peuvent être validées dans le désordre ; réappliquer est sans effet. */
export const CURSOR_OVERLAP = 50;
/** Compaction : à partir de ce nombre de mises à jour pour une page, et au plus une passe par espace et par délai. */
export const COMPACT_MIN_UPDATES = 100;
export const COMPACT_EVERY_MS = 10 * 60_000;
/** Curseur « au-delà de tout » : demande au serveur de ne rien renvoyer pour la partie qu'on ne veut pas. */
const NONE = Number.MAX_SAFE_INTEGER;
const MAX_LOOPS = 50;
const TEMPORARY = /parent_missing|node_missing|thread_missing/;

export type RunSummary = {
  pushed: number;
  pulledNodes: number;
  pulledStruct: number;
  mergedDocs: number;
  /** Journaux de pages remplacés par leur état fusionné (compaction). */
  compacted: number;
  stalled: boolean;
};

const toError = (e: unknown): SyncError =>
  e instanceof SyncError
    ? e
    : new SyncError('server', undefined, e instanceof Error ? e.message : String(e));
const errText = (e: SyncError) => `${e.code}${e.status ? ` ${e.status}` : ''}`;

export function createSyncEngine(d: SyncEngineDeps) {
  let running: Promise<RunSummary> | null = null;
  const size = d.pageSize ?? 200;
  const lastCompact = new Map<string, number>();

  const toPush = (o: PendingOp): PushOp => ({
    op_id: o.opId,
    entity: o.entity,
    entity_id: o.entityId,
    ...(o.entity === 'doc' ? { update: o.update ?? '' } : { fields: o.fields }),
    clock: { ms: o.clockMs, device: o.deviceId },
  });
  const toNode = (n: PullNode): RemoteNode => ({
    id: n.id,
    parentId: n.parent_id,
    kind: n.kind,
    title: n.title,
    position: n.position,
    deletedAt: n.deleted_at,
    purgedAt: n.purged_at ?? null,
    createdAt: n.created_at,
  });

  async function push(ws: string): Promise<number> {
    let sent = 0;
    for (let i = 0; i < MAX_LOOPS; i++) {
      // La file est commune à tous les espaces : on n'envoie ici que ceux de l'espace traité.
      const ops = (await d.api.syncPending(100)).filter((o) => o.workspaceId === ws);
      if (ops.length === 0) return sent;
      const results = await d.client.push(ws, ops.map(toPush));
      await d.api.syncAck(
        results.map((r) => ({ opId: r.op_id, status: r.status, reason: r.reason })),
      );
      const done = results.filter((r) => r.status !== 'rejected').length;
      sent += done;
      // Plus aucune progression (tout est refusé temporairement) : on s'arrête, la prochaine passe réessaiera.
      if (
        done === 0 &&
        results.every((r) => r.status === 'rejected' && TEMPORARY.test(r.reason ?? ''))
      )
        return sent;
    }
    return sent;
  }

  async function pullNodes(ws: string, st: WorkspaceSync): Promise<{ count: number; ok: boolean }> {
    let cursor = st.nodeCursor;
    let count = 0;
    for (let i = 0; i < MAX_LOOPS; i++) {
      const res = await d.client.pull(ws, Math.max(0, cursor - CURSOR_OVERLAP), NONE, size);
      const next = res.node_cursor ?? cursor;
      const rep = await d.api.syncApplyNodes(ws, res.nodes.map(toNode), next);
      count += rep.applied;
      if (rep.unresolved > 0) return { count, ok: false }; // parent absent : le curseur n'a pas avancé
      cursor = Math.max(cursor, next);
      if (!res.more_nodes) return { count, ok: true };
    }
    return { count, ok: false };
  }

  async function pullStruct(
    ws: string,
    st: WorkspaceSync,
  ): Promise<{ count: number; ok: boolean }> {
    let cursor = st.structCursor;
    let count = 0;
    for (let i = 0; i < MAX_LOOPS; i++) {
      const res = await d.client.pullStruct(ws, Math.max(0, cursor - CURSOR_OVERLAP), size);
      const next = res.cursor ?? cursor;
      const rep = await d.api.syncApplyStruct(ws, res.items, next);
      count += rep.applied;
      if (rep.unresolved > 0) return { count, ok: false }; // une base ou une ligne n'est pas encore là : le curseur n'avance pas
      cursor = Math.max(cursor, next);
      if (!res.more) return { count, ok: true };
    }
    return { count, ok: false };
  }

  async function mergeNode(nodeId: string, updates: string[]): Promise<'ok' | 'retry'> {
    const live = d.live.get(nodeId);
    if (live) {
      for (const u of updates) d.live.applyUpdate(live, u);
      return 'ok';
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const local = await d.api.syncDocGet(nodeId);
      const m = mergeUpdates(local?.docState ?? null, updates);
      if (!m.changed && local) return 'ok';
      const snap = d.snapshot(m.doc);
      const out = await d.api.syncApplyDoc({
        nodeId,
        docState: m.state,
        contentJson: snap.contentJson,
        textPlain: snap.textPlain,
        expectedUpdatedAt: local?.updatedAt ?? null,
      });
      if (out === 'applied') return 'ok';
      if (out === 'missing') return 'retry'; // la page n'est pas (encore) là : on ne perd pas le contenu, on réessaiera
    }
    return 'retry'; // la page n'arrête pas de changer localement : on réessaiera
  }

  async function pullDocs(
    ws: string,
    st: WorkspaceSync,
    deviceId: string,
  ): Promise<{ count: number; ok: boolean }> {
    let cursor = st.docCursor;
    let count = 0;
    for (let i = 0; i < MAX_LOOPS; i++) {
      const res = await d.client.pull(ws, NONE, Math.max(0, cursor - CURSOR_OVERLAP), size);
      const mine = deviceId;
      const byNode = new Map<string, PullDoc[]>();
      for (const u of res.docs) {
        if (u.device_id === mine) continue; // nos propres mises à jour sont déjà dans l'état local
        byNode.set(u.node_id, [...(byNode.get(u.node_id) ?? []), u]);
      }
      let allOk = true;
      for (const [nodeId, ups] of byNode) {
        const r = await mergeNode(
          nodeId,
          ups.map((u) => u.update),
        );
        if (r === 'ok') count++;
        else allOk = false;
      }
      if (!allOk) return { count, ok: false }; // le curseur n'avance pas : on retentera ces mises à jour
      const next = res.doc_cursor ?? cursor;
      await d.api.syncSetDocCursor(ws, next);
      cursor = Math.max(cursor, next);
      if (!res.more_docs) return { count, ok: true };
    }
    return { count, ok: false };
  }

  /**
   * Remplace les longs journaux d'une page par leur état fusionné. Le serveur ne fusionne pas (Yjs est côté client) : on
   * relit toutes les mises à jour de la page, on les fusionne, et on demande le remplacement de CETTE liste exacte — une
   * mise à jour arrivée entre-temps n'est jamais supprimée. Échec = on réessaiera plus tard, sans conséquence.
   */
  async function compact(ws: string, deviceId: string): Promise<number> {
    const now = Date.now();
    if (now - (lastCompact.get(ws) ?? 0) < COMPACT_EVERY_MS) return 0;
    lastCompact.set(ws, now);
    let done = 0;
    for (const s of await d.client.docStats(ws, COMPACT_MIN_UPDATES)) {
      const ups = await d.client.pullNodeDocs(ws, s.node_id);
      if (ups.length < 2) continue;
      const m = mergeUpdates(
        null,
        ups.map((u) => u.update),
      );
      await d.client.compactDoc({
        workspaceId: ws,
        nodeId: s.node_id,
        ids: ups.map((u) => u.id),
        opId: crypto.randomUUID(),
        deviceId,
        stateBase64: m.state,
      });
      done++;
    }
    return done;
  }

  const EMPTY: RunSummary = {
    pushed: 0,
    pulledNodes: 0,
    pulledStruct: 0,
    mergedDocs: 0,
    compacted: 0,
    stalled: false,
  };

  /** Rôles réels côté serveur : un accès retiré arrête la synchronisation de l'espace (données locales conservées). */
  async function refreshRoles(st: SyncStatus, userId: string): Promise<SyncStatus> {
    let members = await d.client.myMemberships();
    const known = new Set(members.map((m) => m.workspace_id));
    for (const w of st.workspaces) {
      // Seul l'espace personnel de l'utilisateur est créé côté serveur ; un espace partagé doit déjà exister.
      if (w.kind === 'personal' && !known.has(w.workspaceId)) {
        await d.client.ensureWorkspace(w.workspaceId, d.workspaceName(w.workspaceId), userId);
        members = await d.client.myMemberships();
        break;
      }
    }
    const roles = new Map(members.map((m) => [m.workspace_id, m.role]));
    let cur = st;
    for (const w of st.workspaces) {
      const role = roles.get(w.workspaceId) ?? null;
      if (role !== w.role) cur = await d.api.syncSetRole(w.workspaceId, role);
    }
    return cur;
  }

  async function run(): Promise<RunSummary> {
    const user = d.user();
    let st = await d.api.syncStatus();
    d.store.getState().set({ status: st });
    if (!st.enabled || st.workspaces.length === 0) {
      d.store.getState().set({ phase: 'off' });
      return EMPTY;
    }
    if (!user) {
      d.store.getState().set({ phase: 'auth', error: null });
      return EMPTY;
    }
    d.store.getState().set({ phase: 'syncing', error: null });
    const total: RunSummary = { ...EMPTY };
    let firstError: SyncError | null = null;
    try {
      st = await refreshRoles(st, user.id);
      for (const w0 of st.workspaces) {
        const ws = w0.workspaceId;
        try {
          total.pushed += await push(ws);
          const get = async () =>
            (await d.api.syncStatus()).workspaces.find((x) => x.workspaceId === ws) ?? w0;
          const nodes = await pullNodes(ws, await get());
          const struct = await pullStruct(ws, await get());
          const docs = await pullDocs(ws, await get(), st.deviceId);
          total.pulledNodes += nodes.count;
          total.pulledStruct += struct.count;
          total.mergedDocs += docs.count;
          if (w0.role !== 'viewer') {
            // La compaction est facultative : son échec ne doit jamais empêcher la synchronisation.
            total.compacted += await compact(ws, st.deviceId).catch(() => 0);
          }
          if (!nodes.ok || !struct.ok || !docs.ok) total.stalled = true;
        } catch (e) {
          const err = toError(e);
          // Réseau ou session : inutile d'essayer les autres espaces.
          if (err.code === 'network' || err.code === 'auth') throw err;
          // Autre refus : cet espace est en erreur, les autres continuent.
          total.stalled = true;
          firstError ??= err;
          await d.api.syncRecordError(ws, errText(err)).catch(() => undefined);
        }
      }
      st = await d.api.syncStatus();
      // « À jour » seulement après accusé du serveur, file vide, et aucune reprise en attente.
      const upToDate = st.pending === 0 && !total.stalled;
      d.store.getState().set({
        phase: firstError ? 'error' : 'idle',
        status: st,
        error: firstError ? firstError.code : null,
        ...(upToDate ? { lastOkAt: new Date().toISOString() } : {}),
      });
      return total;
    } catch (e) {
      const err = toError(e);
      for (const w of st.workspaces)
        await d.api.syncRecordError(w.workspaceId, errText(err)).catch(() => undefined);
      d.store.getState().set({
        phase: err.code === 'network' ? 'offline' : err.code === 'auth' ? 'auth' : 'error',
        error: err.code,
        status: await d.api.syncStatus().catch(() => st),
      });
      return { ...EMPTY, stalled: true };
    }
  }

  return {
    /** Lance une synchronisation ; les appels simultanés partagent la même exécution (jamais deux à la fois). */
    runOnce(): Promise<RunSummary> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
    isRunning: () => running !== null,
  };
}
export type SyncEngine = ReturnType<typeof createSyncEngine>;
