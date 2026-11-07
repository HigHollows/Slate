import { describe, expect, it, vi } from 'vitest';
import { SyncError, createSyncClient } from './client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const mk = (f: typeof fetch, token: () => Promise<string | null> = async () => 'jeton-acces') =>
  createSyncClient({
    url: 'https://abc.supabase.co/',
    anonKey: 'cle-publique',
    token,
    fetch: f,
    timeoutMs: 200,
  });

describe('client de synchronisation', () => {
  it('push : bon point d’accès, en-têtes, corps ; jamais le jeton dans l’URL', async () => {
    const f = vi.fn(async () => json([{ op_id: 'a', status: 'applied', reason: null }]));
    const r = await mk(f as never).push('ws', [
      {
        op_id: 'a',
        entity: 'node',
        entity_id: 'n',
        fields: { title: 'x' },
        clock: { ms: 1, device: 'd' },
      },
    ]);
    expect(r[0]!.status).toBe('applied');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://abc.supabase.co/rest/v1/rpc/sync_push');
    expect(url).not.toContain('jeton');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer jeton-acces');
    expect((init.headers as Record<string, string>)['apikey']).toBe('cle-publique');
    expect(JSON.parse(init.body as string)).toEqual({
      p_workspace: 'ws',
      p_ops: [
        {
          op_id: 'a',
          entity: 'node',
          entity_id: 'n',
          fields: { title: 'x' },
          clock: { ms: 1, device: 'd' },
        },
      ],
    });
  });

  it('pull : paramètres de curseurs', async () => {
    const f = vi.fn(async () =>
      json({
        nodes: [],
        node_cursor: null,
        more_nodes: false,
        docs: [],
        doc_cursor: null,
        more_docs: false,
      }),
    );
    await mk(f as never).pull('ws', 5, 9, 50);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://abc.supabase.co/rest/v1/rpc/sync_pull');
    expect(JSON.parse(init.body as string)).toEqual({
      p_workspace: 'ws',
      p_node_since: 5,
      p_doc_since: 9,
      p_limit: 50,
    });
  });

  it('pullStruct : point d’accès et paramètres ; réponse inattendue = erreur serveur', async () => {
    const f = vi.fn(async () => json({ items: [], cursor: null, more: false }));
    await mk(f as never).pullStruct('ws', 12, 40);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://abc.supabase.co/rest/v1/rpc/sync_pull_struct');
    expect(JSON.parse(init.body as string)).toEqual({
      p_workspace: 'ws',
      p_since: 12,
      p_limit: 40,
    });
    await expect(
      mk((async () => json({ truc: 1 })) as never).pullStruct('ws', 0),
    ).rejects.toMatchObject({ code: 'server' });
  });

  it('création d’espace idempotente (ignore les doublons)', async () => {
    const f = vi.fn(async () => new Response(null, { status: 201 }));
    await mk(f as never).ensureWorkspace('id', 'Perso', 'u1');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://abc.supabase.co/rest/v1/workspaces');
    expect((init.headers as Record<string, string>)['Prefer']).toContain('ignore-duplicates');
    expect(JSON.parse(init.body as string)).toEqual({ id: 'id', name: 'Perso', owner_id: 'u1' });
  });

  it('classe les erreurs sans exposer le détail serveur', async () => {
    const code = async (status: number, body = '') => {
      const f = vi.fn(async () => new Response(body, { status }));
      return mk(f as never)
        .pull('ws', 0, 0)
        .catch((e: unknown) => (e as SyncError).code);
    };
    expect(await code(401)).toBe('auth');
    expect(await code(403)).toBe('forbidden');
    expect(await code(400, '{"code":"42501"}')).toBe('forbidden');
    expect(await code(500)).toBe('server');
    expect(await code(503)).toBe('server');
    expect(await code(422, 'x')).toBe('invalid');
    const net = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(mk(net as never).pull('ws', 0, 0)).rejects.toMatchObject({ code: 'network' });
    await expect(mk(vi.fn() as never, async () => null).pull('ws', 0, 0)).rejects.toMatchObject({
      code: 'auth',
    });
  });

  it('délai dépassé = réseau ; réponse inattendue = erreur serveur', async () => {
    const slow = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) =>
          init.signal!.addEventListener('abort', () =>
            rej(new DOMException('abort', 'AbortError')),
          ),
        ),
    );
    await expect(mk(slow as never).pull('ws', 0, 0)).rejects.toMatchObject({ code: 'network' });
    await expect(
      mk((async () => json({ truc: 1 })) as never).pull('ws', 0, 0),
    ).rejects.toMatchObject({ code: 'server' });
    await expect(
      mk((async () => json({ pas: 'un tableau' })) as never).push('ws', []),
    ).rejects.toMatchObject({ code: 'server' });
  });
});
