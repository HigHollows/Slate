import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeSocket, realtimeUrl, type ChannelStatus } from './socket';

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(f: unknown) {
    this.onmessage?.({ data: typeof f === 'string' ? f : JSON.stringify(f) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}
const last = () => FakeWS.all[FakeWS.all.length - 1]!;
const flush = () => vi.advanceTimersByTimeAsync(0);
const mk = (over: Partial<Parameters<typeof createRealtimeSocket>[0]> = {}) =>
  createRealtimeSocket({
    url: 'https://abc.supabase.co',
    anonKey: 'anon-key',
    token: async () => 'jwt-1',
    webSocket: (u) => new FakeWS(u) as never,
    ...over,
  });
const topic = 'doc:w:p';

beforeEach(() => {
  FakeWS.all = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => vi.useRealTimers());

describe('client Realtime', () => {
  it('exige https et n’embarque que la clé publique dans l’URL', () => {
    expect(realtimeUrl('https://abc.supabase.co', 'k')).toBe(
      'wss://abc.supabase.co/realtime/v1/websocket?apikey=k&vsn=1.0.0',
    );
    expect(() => realtimeUrl('http://abc.supabase.co', 'k')).toThrow();
    expect(() => realtimeUrl('ftp://x', 'k')).toThrow();
  });

  it('rejoint un canal PRIVÉ avec le jeton, n’envoie qu’une fois rejoint, et reçoit les messages des autres', async () => {
    const got: [string, unknown][] = [];
    const states: ChannelStatus[] = [];
    const ch = mk().join(topic, {
      onMessage: (e, p) => got.push([e, p]),
      onStatus: (s) => states.push(s),
    });
    const ws = last();
    expect(ws.url).toContain('wss://abc.supabase.co/realtime/v1/websocket');
    ch.send('x', { a: 1 }); // pas encore rejoint : sans effet
    ws.open();
    await flush();
    const join = ws.sent.find((f) => f.event === 'phx_join')!;
    expect(join.topic).toBe(`realtime:${topic}`);
    const payload = join.payload as { config: Record<string, unknown>; access_token: string };
    expect(payload.access_token).toBe('jwt-1');
    expect(payload.config.private).toBe(true);
    expect(payload.config.broadcast).toEqual({ self: false, ack: false });
    expect(ws.sent.some((f) => f.event === 'broadcast')).toBe(false);
    ws.receive({
      topic: `realtime:${topic}`,
      event: 'phx_reply',
      payload: { status: 'ok' },
      ref: join.ref,
    });
    expect(ch.joined).toBe(true);
    expect(states).toContain('joined');
    ch.send('awareness', { u: 'AA' });
    expect(ws.sent.at(-1)).toMatchObject({
      event: 'broadcast',
      payload: { type: 'broadcast', event: 'awareness', payload: { u: 'AA' } },
    });
    ws.receive({
      topic: `realtime:${topic}`,
      event: 'broadcast',
      payload: { type: 'broadcast', event: 'doc', payload: { u: 'BB' } },
    });
    expect(got).toEqual([['doc', { u: 'BB' }]]);
  });

  it('refus du serveur (rôle insuffisant) : le canal n’est jamais « rejoint » et rien n’est envoyé', async () => {
    const states: ChannelStatus[] = [];
    const ch = mk().join(topic, { onMessage: () => undefined, onStatus: (s) => states.push(s) });
    const ws = last();
    ws.open();
    await flush();
    const join = ws.sent.find((f) => f.event === 'phx_join')!;
    ws.receive({
      topic: `realtime:${topic}`,
      event: 'phx_reply',
      payload: { status: 'error', response: { reason: 'Unauthorized' } },
      ref: join.ref,
    });
    expect(ch.joined).toBe(false);
    expect(states.at(-1)).toBe('error');
    ch.send('x', {});
    expect(ws.sent.some((f) => f.event === 'broadcast')).toBe(false);
  });

  it('refus passager (partition du jour pas encore créée) : nouvelles tentatives espacées, puis arrêt', async () => {
    const states: ChannelStatus[] = [];
    const ch = mk().join(topic, { onMessage: () => undefined, onStatus: (s) => states.push(s) });
    const ws = last();
    ws.open();
    await flush();
    const joins = () => ws.sent.filter((f) => f.event === 'phx_join');
    const refuse = () =>
      ws.receive({
        topic: `realtime:${topic}`,
        event: 'phx_reply',
        payload: { status: 'error', response: { reason: 'MissingPartition' } },
        ref: joins().at(-1)!.ref,
      });
    refuse();
    expect(joins().length).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(joins().length).toBe(2);
    refuse(); // encore refusé
    await vi.advanceTimersByTimeAsync(5000);
    expect(joins().length).toBe(3);
    // cette fois le serveur accepte
    ws.receive({
      topic: `realtime:${topic}`,
      event: 'phx_reply',
      payload: { status: 'ok' },
      ref: joins().at(-1)!.ref,
    });
    expect(ch.joined).toBe(true);
    expect(states.at(-1)).toBe('joined');
  });

  it('refus durable (droits) : quelques tentatives seulement, jamais de boucle', async () => {
    mk().join(topic, { onMessage: () => undefined });
    const ws = last();
    ws.open();
    await flush();
    const joins = () => ws.sent.filter((f) => f.event === 'phx_join');
    for (let i = 0; i < 6; i++) {
      ws.receive({
        topic: `realtime:${topic}`,
        event: 'phx_reply',
        payload: { status: 'error', response: { reason: 'Unauthorized' } },
        ref: joins().at(-1)!.ref,
      });
      await vi.advanceTimersByTimeAsync(20000);
    }
    expect(joins().length).toBe(4); // 1 + 3 nouvelles tentatives, pas plus
  });

  it('sans jeton (déconnecté) : aucune demande de rejoindre', async () => {
    const states: ChannelStatus[] = [];
    mk({ token: async () => null }).join(topic, {
      onMessage: () => undefined,
      onStatus: (s) => states.push(s),
    });
    const ws = last();
    ws.open();
    await flush();
    expect(ws.sent.some((f) => f.event === 'phx_join')).toBe(false);
    expect(states).toContain('error');
  });

  it('ignore les trames malformées, d’un autre sujet, ou démesurées', async () => {
    const got: unknown[] = [];
    mk().join(topic, { onMessage: (e) => got.push(e) });
    const ws = last();
    ws.open();
    await flush();
    ws.receive('pas du json');
    ws.receive('{"x":1}');
    ws.receive({
      topic: 'realtime:autre',
      event: 'broadcast',
      payload: { type: 'broadcast', event: 'doc' },
    });
    ws.receive({
      topic: `realtime:${topic}`,
      event: 'broadcast',
      payload: { type: 'broadcast', event: 42 },
    });
    ws.receive('x'.repeat(5 * 1024 * 1024));
    ws.onmessage?.({ data: new ArrayBuffer(4) });
    expect(got).toEqual([]);
  });

  it('battement de cœur régulier', async () => {
    mk({ heartbeatMs: 1000 }).join(topic, { onMessage: () => undefined });
    const ws = last();
    ws.open();
    await flush();
    await vi.advanceTimersByTimeAsync(2100);
    expect(ws.sent.filter((f) => f.event === 'heartbeat').length).toBe(2);
  });

  it('coupure : reconnexion avec délai croissant puis nouvelle demande de rejoindre (jeton renouvelé)', async () => {
    let n = 0;
    const states: ChannelStatus[] = [];
    mk({ backoffMs: [100, 200], token: async () => `jwt-${++n}` }).join(topic, {
      onMessage: () => undefined,
      onStatus: (s) => states.push(s),
    });
    const ws1 = last();
    ws1.open();
    await flush();
    const j1 = ws1.sent.find((f) => f.event === 'phx_join')!;
    ws1.receive({
      topic: `realtime:${topic}`,
      event: 'phx_reply',
      payload: { status: 'ok' },
      ref: j1.ref,
    });
    ws1.drop();
    expect(states).toContain('closed');
    expect(FakeWS.all.length).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeWS.all.length).toBe(2);
    const ws2 = last();
    ws2.drop(); // échoue encore : délai suivant, plafonné
    await vi.advanceTimersByTimeAsync(150);
    expect(FakeWS.all.length).toBe(2);
    await vi.advanceTimersByTimeAsync(60);
    expect(FakeWS.all.length).toBe(3);
    const ws3 = last();
    ws3.open();
    await flush();
    const j3 = ws3.sent.find((f) => f.event === 'phx_join')!;
    expect((j3.payload as { access_token: string }).access_token).toBe('jwt-2');
  });

  it('quitter le dernier canal ferme la connexion et ne la rétablit pas', async () => {
    const ch = mk({ backoffMs: [10] }).join(topic, { onMessage: () => undefined });
    const ws = last();
    ws.open();
    await flush();
    const j = ws.sent.find((f) => f.event === 'phx_join')!;
    ws.receive({
      topic: `realtime:${topic}`,
      event: 'phx_reply',
      payload: { status: 'ok' },
      ref: j.ref,
    });
    ch.leave();
    expect(ws.sent.some((f) => f.event === 'phx_leave')).toBe(true);
    expect(ws.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWS.all.length).toBe(1);
    ch.send('x', {});
  });

  it('close() arrête tout, y compris les reconnexions prévues', async () => {
    const s = mk({ backoffMs: [10] });
    s.join(topic, { onMessage: () => undefined });
    const ws = last();
    ws.open();
    await flush();
    ws.drop();
    s.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWS.all.length).toBe(1);
  });
});
