import type { RemoteStruct } from '../../shared/ipc/client';

/**
 * Client HTTP de la synchronisation (PostgREST de Supabase). Aucun secret : la clé publique + le jeton de l'utilisateur ;
 * l'accès est entièrement gouverné par la RLS côté serveur.
 */

export type SyncErrorCode = 'auth' | 'forbidden' | 'network' | 'server' | 'invalid';
export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    readonly status?: number,
    detail?: string,
  ) {
    super(detail ?? code);
    this.name = 'SyncError';
  }
}

export interface PushOp {
  op_id: string;
  entity: 'node' | 'doc' | 'prop' | 'view' | 'row' | 'thread' | 'comment';
  entity_id: string;
  fields?: Record<string, unknown>;
  update?: string;
  clock: { ms: number; device: string };
}
export interface PushResult {
  op_id: string;
  status: 'applied' | 'merged' | 'duplicate' | 'rejected';
  reason: string | null;
}
export interface PullNode {
  id: string;
  parent_id: string | null;
  kind: string;
  title: string;
  position: string;
  deleted_at: string | null;
  purged_at?: string | null;
  created_at: string;
  server_seq: number;
}
export interface PullDoc {
  id: number;
  node_id: string;
  device_id: string;
  update: string;
  created_at: string;
}
export interface PullResult {
  nodes: PullNode[];
  node_cursor: number | null;
  more_nodes: boolean;
  docs: PullDoc[];
  doc_cursor: number | null;
  more_docs: boolean;
}

export interface PullStructResult {
  items: RemoteStruct[];
  cursor: number | null;
  more: boolean;
}

export type WorkspaceRole = 'viewer' | 'editor' | 'admin';
export interface Invitation {
  id: string;
  email: string;
  role: WorkspaceRole;
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}
export interface CreatedInvitation {
  id: string;
  token: string;
  email: string;
  role: WorkspaceRole;
  expires_at: string;
}
export interface Member {
  user_id: string;
  role: WorkspaceRole;
  display_name: string;
  email: string;
  is_me: boolean;
}

export interface DocStat {
  node_id: string;
  count: number;
  bytes: number;
}

export interface SyncClient {
  /**
   * Demande au serveur d'envoyer l'invitation PAR E-MAIL à l'adresse de l'invitation (jamais une adresse fournie ici).
   * Résout seulement si le fournisseur d'envoi a accepté le message ; échoue avec `not_configured` si l'envoi n'est pas
   * configuré, `rate_limited` au-delà de 3 envois (ou moins d'une minute après le précédent).
   */
  emailInvitation(token: string, locale: 'fr' | 'en'): Promise<void>;
  /** Pages dont le journal compte au moins `minCount` mises à jour (candidates à la compaction). */
  docStats(workspaceId: string, minCount: number): Promise<DocStat[]>;
  /** Mises à jour (identifiant + contenu base64) d'une page. */
  pullNodeDocs(workspaceId: string, nodeId: string): Promise<{ id: number; update: string }[]>;
  /** Remplace `ids` par l'état fusionné `stateBase64` (le serveur vérifie la liste exacte). Retourne l'identifiant créé. */
  compactDoc(a: {
    workspaceId: string;
    nodeId: string;
    ids: number[];
    opId: string;
    deviceId: string;
    stateBase64: string;
  }): Promise<number>;
  /** Rôle de l'utilisateur dans chacun de ses espaces. */
  myMemberships(): Promise<{ workspace_id: string; role: WorkspaceRole }[]>;
  createInvitation(
    workspaceId: string,
    email: string,
    role: WorkspaceRole,
    ttlHours?: number,
  ): Promise<CreatedInvitation>;
  acceptInvitation(
    token: string,
  ): Promise<{ workspace_id: string; name: string; role: WorkspaceRole }>;
  revokeInvitation(id: string): Promise<void>;
  listInvitations(workspaceId: string): Promise<Invitation[]>;
  listMembers(workspaceId: string): Promise<Member[]>;
  setMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
  pullStruct(workspaceId: string, since: number, limit?: number): Promise<PullStructResult>;
  ensureWorkspace(id: string, name: string, ownerId: string): Promise<void>;
  push(workspaceId: string, ops: PushOp[]): Promise<PushResult[]>;
  pull(
    workspaceId: string,
    nodeSince: number,
    docSince: number,
    limit?: number,
  ): Promise<PullResult>;
}

export function createSyncClient(opts: {
  url: string;
  anonKey: string;
  token(): Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SyncClient {
  const base = opts.url.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function call(
    path: string,
    body: unknown,
    extra: Record<string, string> = {},
    method: 'POST' | 'GET' | 'PATCH' | 'DELETE' = 'POST',
  ): Promise<unknown> {
    const token = await opts.token();
    if (!token) throw new SyncError('auth', 401, 'pas de session');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          apikey: opts.anonKey,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...extra,
        },
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
        signal: ctl.signal,
      });
    } catch {
      throw new SyncError('network');
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const text = await res.text();
      return text === '' ? null : (JSON.parse(text) as unknown);
    }
    const text = await res.text().catch(() => '');
    // 42501 (privilège insuffisant) arrive en 403 ou 401 selon le chemin ; le détail n'est pas affiché tel quel.
    if (res.status === 401) throw new SyncError('auth', 401);
    if (res.status === 403 || /42501/.test(text)) throw new SyncError('forbidden', res.status);
    // Envoi d'e-mail : « non configuré » (503) et « limite atteinte » (429) sont des états attendus, pas des pannes.
    if (/not_configured/.test(text)) throw new SyncError('invalid', res.status, 'not_configured');
    if (/rate_limited/.test(text)) throw new SyncError('invalid', res.status, 'rate_limited');
    if (res.status >= 500) throw new SyncError('server', res.status);
    if (/invitation_invalid/.test(text))
      throw new SyncError('invalid', res.status, 'invitation_invalid');
    if (/too_many_invitations/.test(text))
      throw new SyncError('invalid', res.status, 'too_many_invitations');
    if (/invalid_email/.test(text)) throw new SyncError('invalid', res.status, 'invalid_email');
    throw new SyncError('invalid', res.status, text.slice(0, 200));
  }

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const must = (v: string) => {
    if (!uuid.test(v)) throw new SyncError('invalid', undefined, 'identifiant invalide'); // jamais d'identifiant libre dans une URL
    return v;
  };

  return {
    async docStats(workspaceId, minCount) {
      const r = await call('/rest/v1/rpc/sync_doc_stats', {
        p_workspace: workspaceId,
        p_min_count: minCount,
      });
      if (!Array.isArray(r)) throw new SyncError('server', 200, 'réponse inattendue');
      return r as DocStat[];
    },
    async pullNodeDocs(workspaceId, nodeId) {
      const r = await call('/rest/v1/rpc/sync_pull_node_docs', {
        p_workspace: workspaceId,
        p_node: nodeId,
        p_limit: 500,
      });
      if (!Array.isArray(r)) throw new SyncError('server', 200, 'réponse inattendue');
      return r as { id: number; update: string }[];
    },
    async compactDoc(a) {
      const hex = Array.from(atob(a.stateBase64), (c) =>
        c.charCodeAt(0).toString(16).padStart(2, '0'),
      ).join('');
      const r = await call('/rest/v1/rpc/sync_compact_doc', {
        p_workspace: a.workspaceId,
        p_node: a.nodeId,
        p_ids: a.ids,
        p_op: a.opId,
        p_device: a.deviceId,
        p_state: `\\x${hex}`,
      });
      if (typeof r !== 'number') throw new SyncError('server', 200, 'réponse inattendue');
      return r;
    },
    async emailInvitation(token, locale) {
      await call('/functions/v1/send-invitation', { token, locale });
    },
    async myMemberships() {
      const r = await call('/rest/v1/workspace_members?select=workspace_id,role', null, {}, 'GET');
      if (!Array.isArray(r)) throw new SyncError('server', 200, 'réponse inattendue');
      return r as { workspace_id: string; role: WorkspaceRole }[];
    },
    async createInvitation(workspaceId, email, role, ttlHours = 168) {
      const r = await call('/rest/v1/rpc/create_invitation', {
        p_workspace: workspaceId,
        p_email: email,
        p_role: role,
        p_ttl_hours: ttlHours,
      });
      if (!r || typeof (r as CreatedInvitation).token !== 'string')
        throw new SyncError('server', 200, 'réponse inattendue');
      return r as CreatedInvitation;
    },
    async acceptInvitation(token) {
      const r = await call('/rest/v1/rpc/accept_invitation', { p_token: token });
      if (!r || typeof (r as { workspace_id?: string }).workspace_id !== 'string')
        throw new SyncError('server', 200, 'réponse inattendue');
      return r as { workspace_id: string; name: string; role: WorkspaceRole };
    },
    async revokeInvitation(id) {
      await call('/rest/v1/rpc/revoke_invitation', { p_id: id });
    },
    async listInvitations(workspaceId) {
      const r = await call(
        `/rest/v1/workspace_invitations?workspace_id=eq.${must(workspaceId)}&select=id,email,role,expires_at,created_at,accepted_at,revoked_at&order=created_at.desc&limit=200`,
        null,
        {},
        'GET',
      );
      if (!Array.isArray(r)) throw new SyncError('server', 200, 'réponse inattendue');
      return r as Invitation[];
    },
    async listMembers(workspaceId) {
      const r = await call('/rest/v1/rpc/list_members', { p_workspace: workspaceId });
      if (!Array.isArray(r)) throw new SyncError('server', 200, 'réponse inattendue');
      return r as Member[];
    },
    async setMemberRole(workspaceId, userId, role) {
      await call(
        `/rest/v1/workspace_members?workspace_id=eq.${must(workspaceId)}&user_id=eq.${must(userId)}`,
        { role },
        { Prefer: 'return=minimal' },
        'PATCH',
      );
    },
    async removeMember(workspaceId, userId) {
      await call(
        `/rest/v1/workspace_members?workspace_id=eq.${must(workspaceId)}&user_id=eq.${must(userId)}`,
        null,
        { Prefer: 'return=minimal' },
        'DELETE',
      );
    },
    async ensureWorkspace(id, name, ownerId) {
      // Création idempotente : si l'espace existe déjà (même identifiant), rien ne change.
      await call(
        '/rest/v1/workspaces',
        { id, name, owner_id: ownerId },
        { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      );
    },
    async push(workspaceId, ops) {
      const r = await call('/rest/v1/rpc/sync_push', { p_workspace: workspaceId, p_ops: ops });
      if (!Array.isArray(r)) throw new SyncError('server', 200, 'réponse inattendue');
      return r as PushResult[];
    },
    async pullStruct(workspaceId, since, limit = 200) {
      const r = (await call('/rest/v1/rpc/sync_pull_struct', {
        p_workspace: workspaceId,
        p_since: since,
        p_limit: limit,
      })) as PullStructResult | null;
      if (!r || !Array.isArray(r.items)) throw new SyncError('server', 200, 'réponse inattendue');
      return r;
    },
    async pull(workspaceId, nodeSince, docSince, limit = 200) {
      const r = (await call('/rest/v1/rpc/sync_pull', {
        p_workspace: workspaceId,
        p_node_since: nodeSince,
        p_doc_since: docSince,
        p_limit: limit,
      })) as PullResult | null;
      if (!r || !Array.isArray(r.nodes) || !Array.isArray(r.docs))
        throw new SyncError('server', 200, 'réponse inattendue');
      return r;
    },
  };
}

/** Client de remplacement quand le cloud n'est pas disponible : chaque appel échoue explicitement (aucune réussite simulée). */
export function createUnavailableSyncClient(make: () => Error): SyncClient {
  const fail = () => Promise.reject(make());
  return {
    myMemberships: fail,
    emailInvitation: fail,
    docStats: fail,
    pullNodeDocs: fail,
    compactDoc: fail,
    createInvitation: fail,
    acceptInvitation: fail,
    revokeInvitation: fail,
    listInvitations: fail,
    listMembers: fail,
    setMemberRole: fail,
    removeMember: fail,
    ensureWorkspace: fail,
    push: fail,
    pull: fail,
    pullStruct: fail,
  };
}
