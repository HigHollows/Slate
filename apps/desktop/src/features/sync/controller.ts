import type { SyncStatus } from '../../shared/ipc/client';
import type { SyncClient, WorkspaceRole } from './client';
import type { SyncEngine, SyncLocal } from './engine';
import type { SyncStore } from './store';

export interface SyncControl {
  /** Active la synchronisation de l'espace (envoie tout l'existant) puis lance une passe. */
  enable(workspaceId: string): Promise<void>;
  disable(): Promise<void>;
  syncNow(): Promise<void>;
  refreshStatus(): Promise<void>;
  /** Accepte une invitation (jeton) : rejoint l'espace localement puis le synchronise. `null` en cas d'échec (erreur déjà signalée). */
  join(token: string): Promise<{
    workspaceId: string;
    name: string;
    role: WorkspaceRole;
    nodeId: string | null;
  } | null>;
  /** Accès direct aux opérations de gestion (membres, invitations) : toujours validées côté serveur. */
  readonly client: SyncClient;
}

export interface SyncControlDeps {
  api: SyncLocal & {
    syncEnable(ws: string): Promise<SyncStatus>;
    syncDisable(): Promise<SyncStatus>;
    syncJoinWorkspace(ws: string, name: string, role: string): Promise<SyncStatus>;
  };
  client: SyncClient;
  engine: SyncEngine;
  store: SyncStore;
  /** Rafraîchit l'arborescence quand des nœuds distants ont été appliqués. */
  onRemoteChange(): void;
  /** Un espace vient d'être rejoint (invitation acceptée, première synchronisation faite) : l'afficher. */
  onJoined?(workspaceId: string, nodeId: string | null): void;
  onError(e: unknown): void;
}

export function createSyncControl(d: SyncControlDeps): SyncControl {
  const run = async () => {
    const r = await d.engine.runOnce();
    if (r.pulledNodes > 0 || r.pulledStruct > 0 || r.mergedDocs > 0) d.onRemoteChange();
  };
  return {
    client: d.client,
    async join(token) {
      try {
        // On peut coller le message d'invitation entier : le jeton (64 caractères hexadécimaux) y est retrouvé.
        const found = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i.exec(token);
        const r = await d.client.acceptInvitation(found ? found[0].toLowerCase() : token.trim());
        d.store
          .getState()
          .set({ status: await d.api.syncJoinWorkspace(r.workspace_id, r.name, r.role) });
        d.onRemoteChange(); // l'espace rejoint doit apparaître tout de suite dans la liste
        await run();
        d.onJoined?.(r.workspace_id, r.node_id ?? null);
        return {
          workspaceId: r.workspace_id,
          name: r.name,
          role: r.role,
          nodeId: r.node_id ?? null,
        };
      } catch (e) {
        d.onError(e);
        return null;
      }
    },
    async enable(workspaceId) {
      try {
        d.store.getState().set({ status: await d.api.syncEnable(workspaceId) });
        await run();
      } catch (e) {
        d.onError(e);
      }
    },
    async disable() {
      try {
        d.store.getState().set({ status: await d.api.syncDisable(), phase: 'off', error: null });
      } catch (e) {
        d.onError(e);
      }
    },
    async syncNow() {
      try {
        await run();
      } catch (e) {
        d.onError(e);
      }
    },
    async refreshStatus() {
      try {
        const st = await d.api.syncStatus();
        d.store.getState().set({ status: st, ...(st.enabled ? {} : { phase: 'off' as const }) });
      } catch (e) {
        d.onError(e);
      }
    },
  };
}
