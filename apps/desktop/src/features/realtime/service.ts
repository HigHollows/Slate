import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { PresenceService } from '../../shared/presence';
import { startPageSession, type SessionRole } from './session';
import type { RealtimeSocket } from './socket';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PresenceDeps {
  /** `null` : cloud non configuré, aucune présence. */
  socket: RealtimeSocket | null;
  /** Espace de la page, s'il est connu localement. */
  workspaceOf(nodeId: string): string | null;
  /** Rôle SUR LE SERVEUR dans l'espace, seulement si cet espace est synchronisé ; sinon `null` (personne d'autre n'y est). */
  roleOf(workspaceId: string): SessionRole | null;
  signedIn(): boolean;
  userName(): string;
}

/** Ne rejoint un canal que si la page est dans un espace synchronisé, que le compte est connecté et que le réseau existe. */
export function createPresenceService(d: PresenceDeps): PresenceService {
  return {
    attach(nodeId: string, ydoc: Y.Doc, awareness: Awareness) {
      if (!d.socket || !d.signedIn()) return () => undefined;
      const ws = d.workspaceOf(nodeId);
      const role = ws ? d.roleOf(ws) : null;
      if (!ws || !role || !UUID.test(ws) || !UUID.test(nodeId)) return () => undefined;
      const s = startPageSession({
        socket: d.socket,
        topic: `doc:${ws}:${nodeId}`,
        ydoc,
        awareness,
        role,
        userName: d.userName(),
      });
      return () => s.leave();
    },
  };
}
