import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, createAuthClient, mapError, toSession, type AuthClient } from './authClient';
import { createAccountStore, type SessionVault } from './store';

const URL_ = 'https://proj.supabase.co';
const KEY = 'sb_publishable_test';
const NOW = 1_800_000_000_000;

const tokenBody = (over: Record<string, unknown> = {}) => ({
  access_token: 'acc-1',
  refresh_token: 'ref-1',
  expires_in: 3600,
  user: { id: 'u1', email: 'a@b.fr', email_confirmed_at: '2026-01-01T00:00:00Z' },
  ...over,
});
const res = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe('client Auth REST', () => {
  const setup = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
    const f = vi.fn(impl) as unknown as typeof fetch & { mock: { calls: [string, RequestInit][] } };
    return { f, c: createAuthClient({ url: `${URL_}/`, anonKey: KEY, fetch: f, now: () => NOW }) };
  };

  it('connexion : bon endpoint, en-têtes de clé publique, mot de passe dans le corps seulement', async () => {
    const { f, c } = setup(async () => res(200, tokenBody()));
    const s = await c.signIn('a@b.fr', 'mot-de-passe-secret');
    expect(s).toMatchObject({
      accessToken: 'acc-1',
      refreshToken: 'ref-1',
      expiresAt: NOW + 3_600_000,
      user: { id: 'u1', email: 'a@b.fr', emailConfirmed: true },
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${URL_}/auth/v1/token?grant_type=password`);
    expect(url).not.toContain('mot-de-passe');
    expect((init.headers as Record<string, string>)['apikey']).toBe(KEY);
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'a@b.fr',
      password: 'mot-de-passe-secret',
    });
  });

  it('inscription : confirmation requise (pas de session), identique que l’adresse existe ou non', async () => {
    const fresh = setup(async () =>
      res(200, { id: 'u2', email: 'n@b.fr', identities: [{ id: 'x' }] }),
    );
    const exists = setup(async () => res(200, { id: 'fake', email: 'n@b.fr', identities: [] }));
    expect(await fresh.c.signUp('n@b.fr', 'longpassword', 'Nina')).toEqual({
      session: null,
      needsConfirmation: true,
    });
    expect(await exists.c.signUp('n@b.fr', 'longpassword', 'Nina')).toEqual({
      session: null,
      needsConfirmation: true,
    });
    expect(JSON.parse(String(fresh.f.mock.calls[0]![1].body)).data).toEqual({
      display_name: 'Nina',
    });
  });

  it('inscription avec confirmation automatique : retourne la session', async () => {
    const { c } = setup(async () => res(200, tokenBody()));
    const r = await c.signUp('a@b.fr', 'longpassword', '');
    expect(r.session?.user.id).toBe('u1');
  });

  it('actualisation, déconnexion avec le jeton d’accès, récupération de mot de passe', async () => {
    const { f, c } = setup(async (url) =>
      url.includes('logout') || url.includes('recover')
        ? res(204, undefined)
        : res(200, tokenBody({ access_token: 'acc-2', refresh_token: 'ref-2' })),
    );
    expect((await c.refresh('ref-1')).refreshToken).toBe('ref-2');
    expect(JSON.parse(String(f.mock.calls[0]![1].body))).toEqual({ refresh_token: 'ref-1' });
    await c.signOut('acc-2');
    expect((f.mock.calls[1]![1].headers as Record<string, string>)['Authorization']).toBe(
      'Bearer acc-2',
    );
    await c.recover('a@b.fr');
    expect(f.mock.calls[2]![0]).toBe(`${URL_}/auth/v1/recover`);
  });

  it.each([
    [400, { error_code: 'invalid_credentials' }, 'invalid_credentials'],
    [400, { error_code: 'email_not_confirmed' }, 'email_not_confirmed'],
    [422, { error_code: 'weak_password' }, 'weak_password'],
    [422, { error_code: 'signup_disabled' }, 'signup_disabled'],
    [429, { error_code: 'over_email_send_rate_limit' }, 'rate_limited'],
    [429, {}, 'rate_limited'],
    [400, { error_code: 'refresh_token_not_found' }, 'session_invalid'],
    [400, { error_code: 'refresh_token_already_used' }, 'session_invalid'],
    [500, { msg: 'boom' }, 'unknown'],
    [400, null, 'unknown'],
  ])('erreur %s %j → %s', async (status, body, code) => {
    expect(mapError(status, body).code).toBe(code);
    const { c } = setup(async () => res(status, body ?? undefined));
    await expect(c.signIn('a@b.fr', 'x')).rejects.toMatchObject({ code });
  });

  it('réseau absent, corps illisible ou réponse inattendue : erreurs typées, jamais de plantage', async () => {
    const net = setup(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(net.c.signIn('a@b.fr', 'x')).rejects.toMatchObject({ code: 'network' });
    const garbage = setup(async () => new Response('<html>pas du json</html>', { status: 200 }));
    await expect(garbage.c.signIn('a@b.fr', 'x')).rejects.toMatchObject({ code: 'unknown' });
    const partial = setup(async () => res(200, { access_token: 'seulement' }));
    await expect(partial.c.refresh('r')).rejects.toBeInstanceOf(AuthError);
  });

  it('délai dépassé : requête annulée, erreur réseau', async () => {
    vi.useFakeTimers();
    const c = createAuthClient({
      url: URL_,
      anonKey: KEY,
      timeoutMs: 100,
      fetch: ((_u: string, init: RequestInit) =>
        new Promise((_r, rej) =>
          init.signal?.addEventListener('abort', () =>
            rej(new DOMException('abort', 'AbortError')),
          ),
        )) as unknown as typeof fetch,
    });
    const p = c.signIn('a@b.fr', 'x');
    const assertion = expect(p).rejects.toMatchObject({ code: 'network' });
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    vi.useRealTimers();
  });

  it('profil : lecture et mise à jour par PostgREST avec le jeton d’accès', async () => {
    const row = { id: 'u1', display_name: 'Nina', locale: 'fr', timezone: 'Europe/Paris' };
    const { f, c } = setup(async () => res(200, [row]));
    expect(await c.getProfile('acc', 'u1')).toEqual({
      id: 'u1',
      displayName: 'Nina',
      locale: 'fr',
      timezone: 'Europe/Paris',
    });
    expect(f.mock.calls[0]![0]).toContain('/rest/v1/profiles?id=eq.u1');
    await c.updateProfile('acc', 'u1', { displayName: 'N'.repeat(300), locale: 'en' });
    const [, init] = f.mock.calls[1]!;
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ display_name: 'N'.repeat(100), locale: 'en' });
    await expect(setup(async () => res(200, [])).c.getProfile('acc', 'u1')).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('un identifiant utilisateur hostile est encodé dans l’URL', async () => {
    const { f, c } = setup(async () => res(200, []));
    await c.getProfile('acc', 'x&select=*;--').catch(() => undefined);
    expect(f.mock.calls[0]![0]).toContain('id=eq.x%26select%3D*%3B--');
  });

  it('toSession : expires_at prioritaire, sinon expires_in', () => {
    expect(toSession(tokenBody({ expires_at: 1_900_000_000 }), NOW).expiresAt).toBe(
      1_900_000_000_000,
    );
    expect(toSession(tokenBody(), NOW).expiresAt).toBe(NOW + 3_600_000);
    expect(() => toSession({}, NOW)).toThrow();
  });
});

function memoryVault(initial: string | null = null) {
  let token = initial;
  const vault: SessionVault & { peek(): string | null; failSave: boolean } = {
    failSave: false,
    load: vi.fn(async () => token),
    save: vi.fn(async (t: string) => {
      if (vault.failSave) throw new Error('trousseau verrouillé');
      token = t;
    }),
    clear: vi.fn(async () => {
      token = null;
    }),
    peek: () => token,
  };
  return vault;
}
const session = (n: number, over: Partial<{ expiresAt: number }> = {}) => ({
  accessToken: `acc-${n}`,
  refreshToken: `ref-${n}`,
  expiresAt: NOW + 3_600_000,
  user: { id: 'u1', email: 'a@b.fr', emailConfirmed: true },
  ...over,
});
function fakeClient(
  over: Partial<AuthClient> = {},
): AuthClient & Record<keyof AuthClient, ReturnType<typeof vi.fn>> {
  const base = {
    signUp: vi.fn(async () => ({ session: null, needsConfirmation: true as const })),
    signIn: vi.fn(async () => session(1)),
    refresh: vi.fn(async () => session(2)),
    signOut: vi.fn(async () => undefined),
    recover: vi.fn(async () => undefined),
    getProfile: vi.fn(async () => ({
      id: 'u1',
      displayName: 'Nina',
      locale: 'fr' as const,
      timezone: 'UTC',
    })),
    updateProfile: vi.fn(async (_t: string, _u: string, p: object) => ({
      id: 'u1',
      displayName: 'Nina',
      locale: 'fr' as const,
      timezone: 'UTC',
      ...p,
    })),
    ...over,
  };
  return base as never;
}

describe('store de compte', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('sans configuration cloud : indisponible, jamais d’appel', async () => {
    const s = createAccountStore({ client: null, vault: memoryVault(), now: () => NOW });
    expect(s.getState().status).toBe('unavailable');
    await s.getState().init();
    expect(s.getState().status).toBe('unavailable');
    expect(await s.getState().signIn('a@b.fr', 'x')).toBeInstanceOf(AuthError);
  });

  it('démarrage sans jeton : déconnecté ; avec jeton valide : session rétablie et jeton tourné dans le coffre', async () => {
    const c = fakeClient();
    const v = memoryVault();
    const s1 = createAccountStore({ client: c, vault: v, now: () => NOW });
    await s1.getState().init();
    expect(s1.getState().status).toBe('signedOut');
    expect(c.refresh).not.toHaveBeenCalled();

    const v2 = memoryVault('ref-ancien');
    const s2 = createAccountStore({ client: c, vault: v2, now: () => NOW });
    await s2.getState().init();
    expect(c.refresh).toHaveBeenCalledWith('ref-ancien');
    expect(s2.getState()).toMatchObject({ status: 'signedIn', email: 'a@b.fr' });
    expect(v2.peek()).toBe('ref-2');
  });

  it('jeton révoqué : effacé du coffre, déconnecté (jamais bloqué)', async () => {
    const c = fakeClient({
      refresh: vi.fn(async () => {
        throw new AuthError('session_invalid', 400);
      }),
    });
    const v = memoryVault('ref-mort');
    const s = createAccountStore({ client: c, vault: v, now: () => NOW });
    await s.getState().init();
    expect(s.getState().status).toBe('signedOut');
    expect(v.peek()).toBeNull();
  });

  it('hors ligne au démarrage : le jeton est CONSERVÉ, nouvelle tentative automatique, puis reconnexion', async () => {
    let online = false;
    const c = fakeClient({
      refresh: vi.fn(async () => {
        if (!online) throw new AuthError('network');
        return session(3);
      }),
    });
    const v = memoryVault('ref-ok');
    const s = createAccountStore({ client: c, vault: v, now: () => NOW });
    await s.getState().init();
    expect(s.getState().status).toBe('offline');
    expect(v.peek()).toBe('ref-ok');
    online = true;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(s.getState().status).toBe('signedIn');
    expect(v.peek()).toBe('ref-3');
  });

  it('connexion : valide les saisies avant tout appel, mémorise le jeton, charge le profil', async () => {
    const c = fakeClient();
    const v = memoryVault();
    const s = createAccountStore({ client: c, vault: v, now: () => NOW });
    expect((await s.getState().signIn('pas-un-mail', 'x'))?.code).toBe('invalid_email');
    expect((await s.getState().signIn('a@b.fr', ''))?.code).toBe('invalid_password');
    expect(c.signIn).not.toHaveBeenCalled();
    expect(await s.getState().signIn('  A@B.fr ', 'secret-ok')).toBeNull();
    expect(c.signIn).toHaveBeenCalledWith('a@b.fr', 'secret-ok');
    expect(v.peek()).toBe('ref-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getState().profile?.displayName).toBe('Nina');
  });

  it('erreur de connexion : renvoyée pour affichage, état inchangé, rien dans le coffre', async () => {
    const c = fakeClient({
      signIn: vi.fn(async () => {
        throw new AuthError('invalid_credentials', 400);
      }),
    });
    const v = memoryVault();
    const s = createAccountStore({ client: c, vault: v, now: () => NOW });
    expect((await s.getState().signIn('a@b.fr', 'mauvais'))?.code).toBe('invalid_credentials');
    expect(s.getState().status).toBe('loading');
    expect(v.save).not.toHaveBeenCalled();
  });

  it('coffre inaccessible : connecté pour la session en cours, avertissement « session non mémorisée »', async () => {
    const v = memoryVault();
    v.failSave = true;
    const onError = vi.fn();
    const s = createAccountStore({ client: fakeClient(), vault: v, now: () => NOW, onError });
    await s.getState().signIn('a@b.fr', 'secret-ok');
    expect(s.getState().status).toBe('signedIn');
    expect(s.getState().notice).toBe('sessionNotRemembered');
    expect(onError).toHaveBeenCalled();
  });

  it('inscription : mot de passe trop court refusé localement ; confirmation d’e-mail annoncée', async () => {
    const c = fakeClient();
    const s = createAccountStore({ client: c, vault: memoryVault(), now: () => NOW });
    expect((await s.getState().signUp('a@b.fr', 'court', ''))?.code).toBe('weak_password');
    expect((await s.getState().signUp('a@b.fr', 'x'.repeat(73), ''))?.code).toBe('weak_password');
    expect(c.signUp).not.toHaveBeenCalled();
    expect(await s.getState().signUp('a@b.fr', 'assez-long-1', ' Nina ')).toBeNull();
    expect(c.signUp).toHaveBeenCalledWith('a@b.fr', 'assez-long-1', 'Nina');
    expect(s.getState()).toMatchObject({ notice: 'confirmEmail', status: 'loading' });
  });

  it('déconnexion : locale et immédiate même si le serveur est injoignable ; jeton effacé', async () => {
    const c = fakeClient({
      signOut: vi.fn(async () => {
        throw new AuthError('network');
      }),
    });
    const v = memoryVault();
    const s = createAccountStore({ client: c, vault: v, now: () => NOW });
    await s.getState().signIn('a@b.fr', 'secret-ok');
    await s.getState().signOut();
    expect(s.getState()).toMatchObject({ status: 'signedOut', email: null, profile: null });
    expect(v.peek()).toBeNull();
    expect(c.signOut).toHaveBeenCalledWith('acc-1');
  });

  it('le jeton d’accès est renouvelé avant son expiration, et le jeton de rafraîchissement tourne', async () => {
    let t = NOW;
    const c = fakeClient({
      signIn: vi.fn(async () => session(1, { expiresAt: t + 120_000 })),
      refresh: vi.fn(async () => session(2, { expiresAt: t + 3_600_000 })),
    });
    const v = memoryVault();
    const s = createAccountStore({ client: c, vault: v, now: () => t });
    await s.getState().signIn('a@b.fr', 'secret-ok');
    t += 61_000;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(c.refresh).toHaveBeenCalledTimes(1);
    expect(c.refresh).toHaveBeenCalledWith('ref-1');
    expect(v.peek()).toBe('ref-2');
    expect(await s.getState().accessToken()).toBe('acc-2');
  });

  it('accessToken : null sans session, renouvelle si proche de l’expiration, null si hors ligne', async () => {
    let t = NOW;
    const c = fakeClient({ signIn: vi.fn(async () => session(1, { expiresAt: t + 30_000 })) });
    const s = createAccountStore({ client: c, vault: memoryVault(), now: () => t });
    expect(await s.getState().accessToken()).toBeNull();
    await s.getState().signIn('a@b.fr', 'secret-ok');
    c.refresh.mockRejectedValueOnce(new AuthError('network'));
    expect(await s.getState().accessToken()).toBeNull();
    expect(s.getState().status).toBe('offline');
    t += 1;
  });

  it('profil : mise à jour, erreurs rendues sans exception', async () => {
    const c = fakeClient();
    const s = createAccountStore({ client: c, vault: memoryVault(), now: () => NOW });
    expect((await s.getState().updateProfile({ displayName: 'X' }))?.code).toBe('session_invalid');
    await s.getState().signIn('a@b.fr', 'secret-ok');
    expect(await s.getState().updateProfile({ displayName: 'Nouveau' })).toBeNull();
    expect(s.getState().profile?.displayName).toBe('Nouveau');
    c.updateProfile.mockRejectedValueOnce(new AuthError('rate_limited', 429));
    expect((await s.getState().updateProfile({ displayName: 'Y' }))?.code).toBe('rate_limited');
  });

  it('récupération de mot de passe : adresse validée, confirmation neutre', async () => {
    const c = fakeClient();
    const s = createAccountStore({ client: c, vault: memoryVault(), now: () => NOW });
    expect((await s.getState().recover('xx'))?.code).toBe('invalid_email');
    expect(await s.getState().recover('a@b.fr')).toBeNull();
    expect(s.getState().notice).toBe('resetSent');
  });
});
