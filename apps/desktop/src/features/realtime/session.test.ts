import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanName } from '../../shared/presence';
import { createPresenceService } from './service';
import {
  REMOTE_ORIGINS,
  fromB64,
  startPageSession,
  toB64,
  validAwarenessState,
  type SessionRole,
} from './session';
import type { ChannelHandlers, RealtimeChannel, RealtimeSocket } from './socket';

/** Réseau en boucle : tout ce qu'un participant envoie est remis aux AUTRES du même sujet (comme `self: false`). */
function hub() {
  const peers: { topic: string; h: ChannelHandlers; joined: boolean }[] = [];
  const sent: { topic: string; event: string; payload: unknown }[] = [];
  const socket = (): RealtimeSocket => ({
    join(topic, h) {
      const me = { topic, h, joined: false };
      peers.push(me);
      const ch: RealtimeChannel = {
        send(event, payload) {
          if (!me.joined) return;
          sent.push({ topic, event, payload });
          for (const p of peers)
            if (p !== me && p.topic === topic && p.joined)
              p.h.onMessage(event, structuredClone(payload));
        },
        get joined() {
          return me.joined;
        },
        leave() {
          me.joined = false;
          peers.splice(peers.indexOf(me), 1);
        },
      };
      return ch;
    },
    close() {},
  });
  return {
    socket,
    sent,
    /** Le serveur accepte le canal du participant n° i. */
    join(i: number) {
      peers[i]!.joined = true;
      peers[i]!.h.onStatus?.('joined');
    },
    deliver(i: number, event: string, payload: unknown) {
      peers[i]!.h.onMessage(event, payload);
    },
    fail(i: number) {
      peers[i]!.joined = false;
      peers[i]!.h.onStatus?.('closed');
    },
  };
}

const TOPIC = 'doc:w:p';
function peer(h: ReturnType<typeof hub>, name: string, role: SessionRole = 'editor') {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const s = startPageSession({
    socket: h.socket(),
    topic: TOPIC,
    ydoc,
    awareness,
    role,
    userName: name,
    flushMs: 10,
  });
  return { ydoc, awareness, s };
}
const tick = (ms = 20) => vi.advanceTimersByTimeAsync(ms);
const names = (a: Awareness) =>
  [...a.getStates().entries()]
    .filter(([id]) => id !== a.clientID)
    .map(([, st]) => (st as { user?: { name?: string } }).user?.name);
const text = (d: Y.Doc) => d.getText('t').toString();

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('session de présence', () => {
  it('deux éditeurs : le texte tapé par l’un arrive chez l’autre en direct, sans écho, et converge', async () => {
    const h = hub();
    const a = peer(h, 'Ada');
    const b = peer(h, 'Bob');
    h.join(0);
    h.join(1);
    await tick();
    a.ydoc.getText('t').insert(0, 'Bonjour');
    await tick();
    expect(text(b.ydoc)).toBe('Bonjour');
    b.ydoc.getText('t').insert(7, ' monde');
    await tick();
    expect(text(a.ydoc)).toBe('Bonjour monde');
    // ce qui vient du direct n'est JAMAIS rediffusé (pas de ping-pong)
    const docs = h.sent.filter((m) => m.event === 'doc').length;
    await tick(500);
    expect(h.sent.filter((m) => m.event === 'doc').length).toBe(docs);
    expect(Y.encodeStateAsUpdate(a.ydoc)).toEqual(Y.encodeStateAsUpdate(b.ydoc));
  });

  it('frappes rapprochées : un seul message regroupé', async () => {
    const h = hub();
    const a = peer(h, 'Ada');
    peer(h, 'Bob');
    h.join(0);
    h.join(1);
    await tick();
    const before = h.sent.filter((m) => m.event === 'doc').length;
    for (const c of 'abcdef') a.ydoc.getText('t').insert(0, c);
    await tick();
    expect(h.sent.filter((m) => m.event === 'doc').length - before).toBe(1);
  });

  it('arrivée en cours de route : le nouvel arrivant reçoit ce qui lui manque et voit les présents', async () => {
    const h = hub();
    const a = peer(h, 'Ada');
    a.ydoc.getText('t').insert(0, 'déjà là');
    h.join(0);
    await tick();
    const b = peer(h, 'Bob');
    h.join(1);
    await tick();
    expect(text(b.ydoc)).toBe('déjà là');
    expect(names(a.awareness)).toEqual(['Bob']);
    expect(names(b.awareness)).toEqual(['Ada']);
  });

  it('la sélection d’un participant (position relative) est transmise ; son départ retire son curseur', async () => {
    const h = hub();
    const a = peer(h, 'Ada');
    const b = peer(h, 'Bob');
    h.join(0);
    h.join(1);
    a.ydoc.getText('t').insert(0, 'abcdef');
    await tick();
    const rel = (i: number) => Y.createRelativePositionFromTypeIndex(a.ydoc.getText('t'), i);
    a.awareness.setLocalStateField('cursor', { anchor: rel(1), head: rel(3) });
    await tick();
    const st = b.awareness.getStates().get(a.ydoc.clientID) as {
      cursor: { anchor: unknown };
      user: { name: string };
    };
    expect(st.user.name).toBe('Ada');
    expect(
      Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(st.cursor.anchor),
        b.ydoc,
      )?.index,
    ).toBe(1);
    a.s.leave();
    expect(b.awareness.getStates().has(a.ydoc.clientID)).toBe(false);
  });

  it('un lecteur reçoit mais n’envoie rien (ni texte, ni présence, ni demande)', async () => {
    const h = hub();
    const a = peer(h, 'Ada');
    const v = peer(h, 'Lecteur', 'viewer');
    h.join(0);
    h.join(1);
    await tick();
    a.ydoc.getText('t').insert(0, 'écrit par Ada');
    await tick();
    expect(text(v.ydoc)).toBe('écrit par Ada');
    v.ydoc.getText('t').insert(0, 'tentative ');
    v.awareness.setLocalStateField('cursor', null);
    await tick(100);
    expect(text(a.ydoc)).toBe('écrit par Ada');
    expect(names(a.awareness)).toEqual([]);
    expect(h.sent.filter((m) => m.event === 'hello').length).toBe(1); // celle d'Ada seulement
    // un « hello » reçu ne le fait pas répondre
    const sentBefore = h.sent.length;
    h.deliver(1, 'hello', { sv: toB64(Y.encodeStateVector(new Y.Doc())) });
    await tick();
    expect(h.sent.length).toBe(sentBefore);
  });

  it('les mises à jour venant du serveur (origine « remote ») ne sont pas rediffusées', async () => {
    expect(REMOTE_ORIGINS.has('remote') && REMOTE_ORIGINS.has('realtime')).toBe(true);
    const h = hub();
    const a = peer(h, 'Ada');
    h.join(0);
    await tick();
    const src = new Y.Doc();
    src.getText('t').insert(0, 'du journal');
    const before = h.sent.filter((m) => m.event === 'doc').length;
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(src), 'remote');
    await tick(100);
    expect(h.sent.filter((m) => m.event === 'doc').length).toBe(before);
  });

  it('coupure du canal : les présents disparaissent (on ne montre pas des fantômes)', async () => {
    const h = hub();
    const a = peer(h, 'Ada');
    peer(h, 'Bob');
    h.join(0);
    h.join(1);
    await tick();
    expect(names(a.awareness)).toEqual(['Bob']);
    h.fail(0);
    expect(names(a.awareness)).toEqual([]);
  });

  describe('entrées hostiles venant du réseau', () => {
    it('messages mal formés, démesurés ou inconnus : ignorés sans exception', async () => {
      const h = hub();
      const a = peer(h, 'Ada');
      h.join(0);
      await tick();
      const bad: [string, unknown][] = [
        ['doc', null],
        ['doc', {}],
        ['doc', { u: 42 }],
        ['doc', { u: '%%%pas du base64%%%' }],
        ['doc', { u: toB64(new Uint8Array([255, 255, 255, 255, 255])) }],
        ['doc', { u: 'A'.repeat(2_000_000) }],
        ['awareness', { u: 'AAAA' }],
        ['awareness', { u: toB64(new Uint8Array([1, 2, 3])) }],
        ['hello', { sv: 7 }],
        ['inconnu', { x: 1 }],
        ['', undefined],
      ];
      for (const [e, p] of bad) expect(() => h.deliver(0, e, p)).not.toThrow();
      expect(text(a.ydoc)).toBe('');
      expect(names(a.awareness)).toEqual([]);
    });

    function awarenessUpdateFor(state: unknown, clientID = 777) {
      const d = new Y.Doc();
      d.clientID = clientID;
      const aw = new Awareness(d);
      aw.setLocalState(state as never);
      const u = encodeAwarenessUpdate(aw, [clientID]);
      aw.destroy();
      return toB64(u);
    }

    it('un état de présence invalide est refusé en entier ; un état valide est accepté', async () => {
      const h = hub();
      const a = peer(h, 'Ada');
      h.join(0);
      await tick();
      const src = new Y.Doc();
      src.getText('t').insert(0, 'x');
      const rel = Y.createRelativePositionFromTypeIndex(src.getText('t'), 0);
      h.deliver(0, 'awareness', {
        u: awarenessUpdateFor({
          user: { name: 'Eve' },
          cursor: { anchor: 'n’importe quoi', head: 3 },
        }),
      });
      expect(names(a.awareness)).toEqual([]);
      h.deliver(0, 'awareness', { u: awarenessUpdateFor({ user: 'pas un objet' }) });
      expect(names(a.awareness)).toEqual([]);
      h.deliver(0, 'awareness', { u: awarenessUpdateFor({ user: { name: 'x'.repeat(500) } }) });
      expect(names(a.awareness)).toEqual([]);
      h.deliver(0, 'awareness', {
        u: awarenessUpdateFor({ user: { name: 'Bob' }, cursor: { anchor: rel, head: rel } }),
      });
      expect(names(a.awareness)).toEqual(['Bob']);
    });

    it('un message ne peut jamais réécrire NOTRE propre état de présence', async () => {
      const h = hub();
      const a = peer(h, 'Ada');
      h.join(0);
      await tick();
      h.deliver(0, 'awareness', {
        u: awarenessUpdateFor({ user: { name: 'Usurpateur' } }, a.ydoc.clientID),
      });
      expect((a.awareness.getLocalState() as { user: { name: string } }).user.name).toBe('Ada');
      // ni la faire disparaître
      h.deliver(0, 'awareness', { u: awarenessUpdateFor(null, a.ydoc.clientID) });
      expect(a.awareness.getLocalState()).not.toBeNull();
    });
  });

  it('quitter : plus aucun envoi, plus aucune réaction', async () => {
    const h = hub();
    const a = peer(h, 'Ada');
    const b = peer(h, 'Bob');
    h.join(0);
    h.join(1);
    await tick();
    a.s.leave();
    a.s.leave(); // idempotent
    const n = h.sent.length;
    a.ydoc.getText('t').insert(0, 'après le départ');
    await tick(100);
    expect(h.sent.length).toBe(n);
    expect(text(b.ydoc)).toBe('');
  });
});

describe('validation et nettoyage', () => {
  it('base64 : borné et strict', () => {
    expect(fromB64(toB64(new Uint8Array([1, 2, 3])))).toEqual(new Uint8Array([1, 2, 3]));
    expect(fromB64('')).toBeNull();
    expect(fromB64(5)).toBeNull();
    expect(fromB64('€€€')).toBeNull();
    expect(fromB64('A'.repeat(400_000))).toBeNull();
  });
  it('noms : texte seul, sans contrôle ni marque de direction, borné', () => {
    expect(cleanName('  Ada\u0000‮ Lovelace  ')).toBe('Ada Lovelace');
    expect(cleanName('x'.repeat(200)).length).toBe(60);
    expect(cleanName(42)).toBe('');
    expect(cleanName('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>'); // affiché comme TEXTE, jamais interprété
  });
  it('états d’awareness', () => {
    expect(validAwarenessState(null)).toBe(true);
    expect(validAwarenessState({})).toBe(true);
    expect(validAwarenessState({ user: { name: 'Ada' } })).toBe(true);
    expect(validAwarenessState('x')).toBe(false);
    expect(validAwarenessState({ user: null })).toBe(false);
    expect(validAwarenessState({ cursor: { anchor: 1, head: 2 } })).toBe(false);
  });
});

describe('service de présence', () => {
  const base = () => {
    const h = hub();
    const attach = vi.fn();
    const socket = h.socket();
    const join = vi.spyOn(socket, 'join');
    const mk = (over: Partial<Parameters<typeof createPresenceService>[0]> = {}) =>
      createPresenceService({
        socket,
        workspaceOf: () => '0192f0a0-0000-7000-8000-000000000001',
        roleOf: () => 'editor',
        signedIn: () => true,
        userName: () => 'Ada',
        ...over,
      });
    void attach;
    return { mk, join };
  };
  const PAGE = '0192f0a0-0000-7000-8000-0000000000a1';
  const att = (svc: ReturnType<ReturnType<typeof base>['mk']>) => {
    const d = new Y.Doc();
    return svc.attach(PAGE, d, new Awareness(d));
  };

  it('rejoint le canal « doc:<espace>:<page> » quand tout est réuni', () => {
    const { mk, join } = base();
    att(mk())();
    expect(join).toHaveBeenCalledWith(
      'doc:0192f0a0-0000-7000-8000-000000000001:' + PAGE,
      expect.anything(),
    );
  });
  it.each([
    ['cloud absent', { socket: null }],
    ['déconnecté', { signedIn: () => false }],
    ['page hors espace connu', { workspaceOf: () => null }],
    ['espace non synchronisé', { roleOf: () => null }],
    ['identifiant d’espace invalide', { workspaceOf: () => 'pas-un-uuid' }],
  ])('%s : aucun canal', (_n, over) => {
    const { mk, join } = base();
    const detach = att(mk(over as never));
    expect(join).not.toHaveBeenCalled();
    expect(() => detach()).not.toThrow();
  });
});
