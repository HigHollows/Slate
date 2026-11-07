/**
 * Client minimal du protocole Realtime de Supabase (canaux Phoenix, messages « broadcast » sur canal PRIVÉ).
 * Aucun secret : la clé publique + le jeton de l'utilisateur ; l'autorisation est entièrement décidée par le serveur
 * (politiques sur `realtime.messages`, voir supabase/migrations/…_realtime_presence.sql).
 * Un message n'est jamais « confirmé » : c'est de l'éphémère (curseurs, présence, accélération de la synchronisation) ;
 * la source de vérité reste la synchronisation par journal.
 */

export type ChannelStatus = 'joining' | 'joined' | 'closed' | 'error';

export interface ChannelHandlers {
  /** Message reçu d'un autre participant (jamais le nôtre : `self: false`). */
  onMessage(event: string, payload: unknown): void;
  onStatus?(status: ChannelStatus): void;
}

export interface RealtimeChannel {
  /** Envoie un message aux autres participants ; sans effet tant que le canal n'est pas rejoint. */
  send(event: string, payload: unknown): void;
  readonly joined: boolean;
  leave(): void;
}

export interface RealtimeSocket {
  join(topic: string, h: ChannelHandlers): RealtimeChannel;
  close(): void;
}

interface Frame {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref?: string | null;
}

interface WS {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
}
export type WebSocketFactory = (url: string) => WS;

export interface SocketOptions {
  /** URL du projet (https://xxx.supabase.co). */
  url: string;
  anonKey: string;
  token(): Promise<string | null>;
  webSocket?: WebSocketFactory;
  heartbeatMs?: number;
  /** Délais de reconnexion successifs (le dernier se répète). */
  backoffMs?: number[];
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

const OPEN = 1;
const MAX_FRAME = 4 * 1024 * 1024;

export function realtimeUrl(projectUrl: string, anonKey: string): string {
  const u = new URL(projectUrl);
  if (u.protocol !== 'https:') throw new Error('Realtime exige https');
  return `wss://${u.host}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;
}

export function createRealtimeSocket(o: SocketOptions): RealtimeSocket {
  const wsUrl = realtimeUrl(o.url, o.anonKey);
  const mk: WebSocketFactory = o.webSocket ?? ((u) => new WebSocket(u) as unknown as WS);
  const timer = o.setTimer ?? setTimeout;
  const untimer = o.clearTimer ?? clearTimeout;
  const backoff = o.backoffMs ?? [500, 1500, 4000, 10000, 30000];
  const heartbeatMs = o.heartbeatMs ?? 25_000;

  interface Chan {
    topic: string; // sujet complet « realtime:… »
    h: ChannelHandlers;
    joined: boolean;
    joinRef: string | null;
    wanted: boolean;
    /** Refus consécutifs à la jonction (partition de messages pas encore créée, jeton expiré…). */
    refusals: number;
  }
  const chans = new Map<string, Chan>();
  let ws: WS | null = null;
  let seq = 0;
  let attempts = 0;
  let hb: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let connecting = false;

  const ref = () => String(++seq);
  const raw = (f: Frame) => {
    if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(f));
  };
  const status = (c: Chan, s: ChannelStatus) => c.h.onStatus?.(s);

  async function sendJoin(c: Chan) {
    const token = await o.token().catch(() => null);
    if (!token || !c.wanted || !ws || ws.readyState !== OPEN) {
      status(c, 'error');
      return;
    }
    c.joinRef = ref();
    status(c, 'joining');
    raw({
      topic: c.topic,
      event: 'phx_join',
      payload: {
        config: {
          broadcast: { self: false, ack: false },
          presence: { enabled: false },
          private: true,
        },
        access_token: token,
      },
      ref: c.joinRef,
    });
  }

  /**
   * Un refus peut être passager (le serveur crée la partition du jour à la première utilisation, le jeton vient d'expirer) :
   * on réessaie quelques fois avec un délai croissant, puis on s'arrête (un vrai refus de droits ne doit pas boucler).
   */
  const JOIN_RETRY_MS = [1500, 5000, 15000];
  function retryJoin(c: Chan) {
    const d = JOIN_RETRY_MS[c.refusals];
    c.refusals++;
    if (d === undefined || !c.wanted) return;
    timer(() => {
      if (c.wanted && !c.joined && ws && ws.readyState === OPEN) void sendJoin(c);
    }, d);
  }

  function startHeartbeat() {
    if (hb) untimer(hb);
    const beat = () => {
      raw({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: ref() });
      hb = timer(beat, heartbeatMs);
    };
    hb = timer(beat, heartbeatMs);
  }

  function scheduleReconnect() {
    if (closed || retry || ![...chans.values()].some((c) => c.wanted)) return;
    const d = backoff[Math.min(attempts, backoff.length - 1)] ?? 30_000;
    attempts++;
    retry = timer(() => {
      retry = null;
      connect();
    }, d);
  }

  function connect() {
    if (closed || connecting || (ws && ws.readyState <= OPEN)) return;
    connecting = true;
    let sock: WS;
    try {
      sock = mk(wsUrl);
    } catch {
      connecting = false;
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      connecting = false;
      attempts = 0;
      startHeartbeat();
      for (const c of chans.values()) if (c.wanted) void sendJoin(c);
    };
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data.length > MAX_FRAME) return;
      let f: Frame;
      try {
        f = JSON.parse(e.data) as Frame;
      } catch {
        return;
      }
      if (!f || typeof f.event !== 'string' || typeof f.topic !== 'string') return;
      const c = chans.get(f.topic);
      if (!c) return;
      if (f.event === 'phx_reply' && f.ref && f.ref === c.joinRef) {
        const ok = (f.payload as { status?: string }).status === 'ok';
        c.joined = ok;
        status(c, ok ? 'joined' : 'error');
        if (ok) c.refusals = 0;
        else retryJoin(c);
      } else if (f.event === 'phx_error' || f.event === 'phx_close') {
        c.joined = false;
        status(c, f.event === 'phx_close' ? 'closed' : 'error');
        if (c.wanted && ws && ws.readyState === OPEN) void sendJoin(c); // rejoindre (jeton renouvelé)
      } else if (f.event === 'broadcast') {
        const p = f.payload as { event?: unknown; payload?: unknown };
        if (typeof p.event === 'string') c.h.onMessage(p.event, p.payload);
      }
    };
    const down = () => {
      connecting = false;
      if (hb) untimer(hb);
      hb = null;
      if (ws === sock) ws = null;
      for (const c of chans.values()) {
        if (c.joined) status(c, 'closed');
        c.joined = false;
      }
      scheduleReconnect();
    };
    sock.onclose = down;
    sock.onerror = () => {
      /* onclose suit : la reconnexion y est gérée */
    };
  }

  return {
    join(topic, h) {
      const full = `realtime:${topic}`;
      const c: Chan = { topic: full, h, joined: false, joinRef: null, wanted: true, refusals: 0 };
      chans.set(full, c);
      if (ws && ws.readyState === OPEN) void sendJoin(c);
      else connect();
      return {
        send(event, payload) {
          if (!c.joined) return;
          raw({
            topic: full,
            event: 'broadcast',
            payload: { type: 'broadcast', event, payload },
            ref: ref(),
          });
        },
        get joined() {
          return c.joined;
        },
        leave() {
          c.wanted = false;
          const was = c.joined;
          c.joined = false;
          chans.delete(full);
          if (was) raw({ topic: full, event: 'phx_leave', payload: {}, ref: ref() });
          if (chans.size === 0 && ws) {
            ws.close();
            ws = null;
            if (hb) untimer(hb);
            hb = null;
          }
        },
      };
    },
    close() {
      closed = true;
      if (retry) untimer(retry);
      if (hb) untimer(hb);
      chans.clear();
      ws?.close();
      ws = null;
    },
  };
}
