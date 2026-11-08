import { createCommandsStore } from '../features/commands';
import { createDatabasesStore } from '../features/databases';
import { createAccountStore, createAuthClient } from '../features/account';
import { liveDocs, snapshotFromDoc } from '../features/editor';
import {
  createSyncClient,
  createUnavailableSyncClient,
  createSyncControl,
  createSyncEngine,
  createSyncStore,
} from '../features/sync';
import * as Y from 'yjs';
import { readConfig } from '../shared/config/env';
import { createSecurityStore } from '../features/security';
import { createPagesStore } from '../features/pages';
import { createPreferencesStore } from '../features/preferences';
import { bus } from '../shared/bus';
import { createPresenceService, createRealtimeSocket } from '../features/realtime';
import { cleanName } from '../shared/presence';
import { ipc } from '../shared/ipc/client';
import { toSlateError } from '../shared/ipc/errors';
import { i18n } from '../shared/i18n';
import { toast } from '../shared/ui';

/** Toute erreur de persistance est montrée à l'utilisateur : rien n'échoue silencieusement. */
export const reportError = (e: unknown) => {
  const err = toSlateError(e);
  if (err.code === 'locked') {
    // Le cœur a verrouillé l'application : on affiche l'écran de verrouillage au lieu d'une erreur.
    void securityStore.getState().refresh();
    return;
  }
  toast.error(`${i18n.t(err.messageKey)}${err.detail ? ` (${err.detail})` : ''}`);
};

export const preferencesStore = createPreferencesStore(ipc, reportError);
export const commandsStore = createCommandsStore(ipc, reportError);
export const pagesStore = createPagesStore(ipc, reportError);
export const databasesStore = createDatabasesStore(ipc, reportError);
export const securityStore = createSecurityStore(ipc, reportError);

const cloud = readConfig();
export const accountStore = createAccountStore({
  client:
    cloud.cloudEnabled && cloud.supabaseUrl && cloud.supabaseAnonKey
      ? createAuthClient({ url: cloud.supabaseUrl, anonKey: cloud.supabaseAnonKey })
      : null,
  vault: {
    load: () => ipc.vaultLoad(),
    save: (t) => ipc.vaultSave(t),
    clear: () => ipc.vaultClear(),
  },
  onError: reportError,
});

// Synchronisation : le client HTTP n'existe que si le cloud est configuré ; sans session, le moteur reste à l'arrêt.
export const syncStore = createSyncStore();
const syncClient =
  cloud.cloudEnabled && cloud.supabaseUrl && cloud.supabaseAnonKey
    ? createSyncClient({
        url: cloud.supabaseUrl,
        anonKey: cloud.supabaseAnonKey,
        token: async () => accountStore.getState().accessToken(),
      })
    : createUnavailableSyncClient(() => new Error('cloud non configuré'));
export const syncControl = createSyncControl({
  api: ipc,
  client: syncClient,
  engine: createSyncEngine({
    api: ipc,
    client: syncClient,
    store: syncStore,
    user: () => {
      const id = accountStore.getState().userId;
      return id ? { id } : null;
    },
    workspaceName: () => 'Personnel',
    snapshot: snapshotFromDoc,
    live: {
      get: liveDocs.get,
      applyUpdate: (doc, u) =>
        Y.applyUpdate(
          doc,
          Uint8Array.from(atob(u), (c) => c.charCodeAt(0)),
          'remote',
        ),
    },
  }),
  store: syncStore,
  onJoined: (id) => {
    // Rafraîchit la liste des espaces puis affiche celui qu'on vient de rejoindre (sinon on resterait sur son espace vide).
    void pagesStore
      .getState()
      .init()
      .then(() => pagesStore.getState().setWorkspace(id));
  },
  onRemoteChange: () => {
    bus.emit('sync-applied', {});
    void pagesStore.getState().init();
    // Les bases déjà chargées (ouvertes) sont relues pour afficher les changements distants.
    for (const id of Object.keys(databasesStore.getState().dbs))
      void databasesStore.getState().load(id, true);
  },
  onError: reportError,
});

// Présence en direct (curseurs, présents) : seulement si le cloud est configuré ; sans session ou hors espace synchronisé,
// le service n'attache rien. Le jeton vient du compte (jamais stocké ici).
const realtimeSocket =
  cloud.cloudEnabled && cloud.supabaseUrl && cloud.supabaseAnonKey
    ? createRealtimeSocket({
        url: cloud.supabaseUrl,
        anonKey: cloud.supabaseAnonKey,
        token: async () => accountStore.getState().accessToken(),
      })
    : null;
export const presenceService = createPresenceService({
  socket: realtimeSocket,
  workspaceOf: (nodeId) =>
    pagesStore.getState().nodes.find((n) => n.id === nodeId)?.workspaceId ?? null,
  roleOf: (ws) => {
    const st = syncStore.getState().status;
    return st?.enabled ? (st.workspaces.find((w) => w.workspaceId === ws)?.role ?? null) : null;
  },
  signedIn: () => accountStore.getState().userId !== null,
  userName: () => {
    const a = accountStore.getState();
    return cleanName(a.profile?.displayName) || cleanName(a.email?.split('@')[0]) || '?';
  },
});
