import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { cleanName } from '../../shared/presence';
import type { RealtimeSocket } from './socket';

/**
 * Session de présence d'UNE page : curseurs / présents (awareness Yjs) et mises à jour du document en direct, sur un canal
 * privé `doc:<espace>:<page>`. Tout ce qui arrive du réseau est NON FIABLE : taille bornée, forme vérifiée, jamais
 * d'exception qui remonte à l'éditeur, jamais d'écrasement de notre propre état.
 *
 * Le direct n'est qu'une accélération : les mises à jour y sont aussi dans le journal de synchronisation (rattrapage
 * toutes les 15 s). Perdre un message ici ne perd jamais de contenu.
 */

export type SessionRole = 'viewer' | 'editor' | 'admin';

export interface SessionOptions {
  socket: RealtimeSocket;
  topic: string;
  ydoc: Y.Doc;
  awareness: Awareness;
  role: SessionRole;
  /** Nom affiché aux autres (déclaré par le client : indicatif, non authentifié). */
  userName: string;
  flushMs?: number;
}

/** Origines des mises à jour qu'on ne rediffuse pas : déjà issues du serveur ou du direct. */
export const REMOTE_ORIGINS = new Set<unknown>(['remote', 'realtime']);

const MAX_BYTES = 256 * 1024; // au-delà : la synchronisation par journal s'en charge
const MAX_MSG_CHARS = Math.ceil((MAX_BYTES * 4) / 3) + 16;

export const toB64 = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
export function fromB64(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_MSG_CHARS) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function validRelPos(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  try {
    Y.createRelativePositionFromJSON(v);
    return true;
  } catch {
    return false;
  }
}

/** Un état d'awareness distant est accepté s'il a la forme attendue ; sinon tout le message est ignoré. */
export function validAwarenessState(s: unknown): boolean {
  if (s === null) return true; // départ
  if (typeof s !== 'object') return false;
  const st = s as { user?: unknown; cursor?: unknown };
  if (st.user !== undefined) {
    if (st.user === null || typeof st.user !== 'object') return false;
    const n = (st.user as { name?: unknown }).name;
    if (n !== undefined && (typeof n !== 'string' || n.length > 200)) return false;
  }
  if (st.cursor !== undefined && st.cursor !== null) {
    const c = st.cursor as { anchor?: unknown; head?: unknown };
    if (typeof c !== 'object' || !validRelPos(c.anchor) || !validRelPos(c.head)) return false;
  }
  return true;
}

export interface PageSession {
  leave(): void;
}

export function startPageSession(o: SessionOptions): PageSession {
  const flushMs = o.flushMs ?? 80;
  const canSend = o.role !== 'viewer';
  const { ydoc, awareness } = o;
  let alive = true;
  let pendingDocs: Uint8Array[] = [];
  let awarenessDirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  awareness.setLocalStateField('user', { name: cleanName(o.userName) || '?' });

  const chan = o.socket.join(o.topic, {
    onMessage: (event, payload) => {
      if (!alive) return;
      try {
        receive(event, payload);
      } catch {
        /* message mal formé : ignoré */
      }
    },
    onStatus: (s) => {
      if (!alive) return;
      if (s === 'joined' && canSend) {
        // Faire connaissance : demander ce qui nous manque, et annoncer notre présence.
        chan.send('hello', { sv: toB64(Y.encodeStateVector(ydoc)) });
        awarenessDirty = true;
        schedule();
      }
      if (s === 'closed' || s === 'error') dropRemotes();
    },
  });

  function dropRemotes() {
    const others = [...awareness.getStates().keys()].filter((id) => id !== ydoc.clientID);
    if (others.length) {
      // Retire sans diffuser : ces participants ne sont plus joignables.
      awareness.states.forEach((_v, id) => {
        if (id !== ydoc.clientID) awareness.states.delete(id);
      });
      awareness.emit('change', [{ added: [], updated: [], removed: others }, 'realtime']);
      awareness.emit('update', [{ added: [], updated: [], removed: others }, 'realtime']);
    }
  }

  function receive(event: string, payload: unknown) {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (event === 'doc') {
      const u = fromB64(p.u);
      if (u) Y.applyUpdate(ydoc, u, 'realtime');
    } else if (event === 'awareness') {
      const u = fromB64(p.u);
      if (!u) return;
      // Analyse dans un état JETABLE (jamais partagé d'un message à l'autre : un état refusé ne doit laisser aucune trace
      // qui ferait ignorer, plus tard, une mise à jour légitime ou accepter une autre) avant d'appliquer pour de bon.
      const scratch = new Awareness(new Y.Doc());
      const ids: number[] = [];
      let ok = false;
      try {
        scratch.setLocalState(null);
        scratch.on(
          'update',
          ({
            added,
            updated,
            removed,
          }: {
            added: number[];
            updated: number[];
            removed: number[];
          }) => ids.push(...added, ...updated, ...removed),
        );
        applyAwarenessUpdate(scratch, u, 'check');
        // on ne se laisse jamais réécrire ; tout état doit avoir la forme attendue
        ok =
          !ids.includes(ydoc.clientID) &&
          ids.every((id) => validAwarenessState(scratch.getStates().get(id) ?? null));
      } finally {
        scratch.destroy();
      }
      if (ok && ids.length) applyAwarenessUpdate(awareness, u, 'realtime');
    } else if (event === 'hello' && canSend) {
      const sv = fromB64(p.sv);
      if (!sv) return;
      const diff = Y.encodeStateAsUpdate(ydoc, sv);
      if (diff.length > 2 && diff.length <= MAX_BYTES) chan.send('doc', { u: toB64(diff) });
      awarenessDirty = true;
      schedule();
    }
  }

  function flush() {
    timer = null;
    if (!alive || !chan.joined || !canSend) {
      pendingDocs = [];
      awarenessDirty = false;
      return;
    }
    if (pendingDocs.length) {
      const merged = pendingDocs.length === 1 ? pendingDocs[0]! : Y.mergeUpdates(pendingDocs);
      pendingDocs = [];
      if (merged.length <= MAX_BYTES) chan.send('doc', { u: toB64(merged) });
    }
    if (awarenessDirty) {
      awarenessDirty = false;
      chan.send('awareness', { u: toB64(encodeAwarenessUpdate(awareness, [ydoc.clientID])) });
    }
  }
  function schedule() {
    if (!timer) timer = setTimeout(flush, flushMs);
  }

  const onDoc = (update: Uint8Array, origin: unknown) => {
    if (!canSend || REMOTE_ORIGINS.has(origin)) return;
    pendingDocs.push(update);
    schedule();
  };
  const onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === 'realtime' || origin === 'check') return;
    if (![...added, ...updated, ...removed].includes(ydoc.clientID)) return;
    awarenessDirty = true;
    schedule();
  };
  ydoc.on('update', onDoc);
  awareness.on('update', onAwareness);

  return {
    leave() {
      if (!alive) return;
      alive = false;
      ydoc.off('update', onDoc);
      awareness.off('update', onAwareness);
      if (timer) clearTimeout(timer);
      if (canSend && chan.joined) {
        // Départ annoncé : les autres retirent notre curseur sans attendre l'expiration.
        awareness.setLocalState(null);
        chan.send('awareness', { u: toB64(encodeAwarenessUpdate(awareness, [ydoc.clientID])) });
      }
      chan.leave();
      dropRemotes();
    },
  };
}
