import { describe, expect, it, vi } from 'vitest';
import {
  compose,
  escapeHtml,
  handle,
  oneLine,
  type Deps,
} from '../../../../../supabase/functions/send-invitation/handler';

const JWT = 'aaa.bbb.ccc';
const TOKEN = 'a1'.repeat(32);
const CLAIM = {
  id: '0192f0a0-0000-7000-8000-0000000000e1',
  email: 'bob@example.com',
  role: 'editor',
  workspace_name: 'Équipe',
  inviter: 'Ada',
  expires_at: '2026-12-01T00:00:00Z',
};
const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://abc.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  RESEND_API_KEY: 're_secret_key',
  MAIL_FROM: 'Slate <invitations@exemple.fr>',
};

function setup(
  over: {
    env?: Record<string, string | undefined>;
    claim?: Response;
    send?: Response | Error;
  } = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    if (u.includes('/rpc/claim_invitation_email'))
      return over.claim ?? new Response(JSON.stringify(CLAIM), { status: 200 });
    if (u.includes('/rpc/release_invitation_email')) return new Response(null, { status: 204 });
    if (u === 'https://api.resend.com/emails') {
      if (over.send instanceof Error) throw over.send;
      return over.send ?? new Response(JSON.stringify({ id: 'mail1' }), { status: 200 });
    }
    throw new Error(`appel inattendu ${u}`);
  });
  const env = { ...ENV, ...over.env };
  const deps: Deps = { env: (n) => env[n], fetch: fetchMock as unknown as typeof fetch };
  const req = (
    body: unknown,
    headers: Record<string, string> = { authorization: `Bearer ${JWT}` },
    method = 'POST',
  ) =>
    new Request('https://f.example/send-invitation', {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(method === 'POST'
        ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
        : {}),
    });
  const sentMail = () => calls.find((c) => c.url === 'https://api.resend.com/emails');
  return { deps, req, calls, sentMail, fetchMock };
}

describe('fonction Edge send-invitation', () => {
  it('envoie à l’adresse de l’INVITATION (jamais celle du client), avec le jeton de l’appelant', async () => {
    const t = setup();
    const res = await handle(
      t.req({
        token: TOKEN,
        locale: 'fr',
        to: 'victime@example.com',
        email: 'victime@example.com',
      }),
      t.deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    const mail = JSON.parse(t.sentMail()!.init.body as string) as {
      to: string[];
      from: string;
      text: string;
    };
    expect(mail.to).toEqual(['bob@example.com']);
    expect(mail.from).toBe(ENV.MAIL_FROM);
    expect(mail.text).toContain(TOKEN);
    // la réservation SQL s'exécute avec le JETON DE L'APPELANT (jamais une clé de service)
    const claim = t.calls.find((c) => c.url.includes('claim_invitation_email'))!;
    expect((claim.init.headers as Record<string, string>).authorization).toBe(`Bearer ${JWT}`);
    expect(JSON.stringify(claim.init.headers)).not.toContain('re_secret_key');
    expect(JSON.parse(claim.init.body as string)).toEqual({ p_token: TOKEN });
    // la clé du fournisseur n'est envoyée qu'au fournisseur
    expect((t.sentMail()!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer re_secret_key',
    );
  });

  it('non configuré : 503 AVANT toute réservation (aucun compteur consommé, aucun appel)', async () => {
    for (const env of [{ RESEND_API_KEY: undefined }, { MAIL_FROM: undefined }]) {
      const t = setup({ env });
      const res = await handle(t.req({ token: TOKEN }), t.deps);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'not_configured' });
      expect(t.fetchMock).not.toHaveBeenCalled();
    }
  });

  it('refuse sans jeton d’appelant valide, méthode inattendue, corps invalide ou démesuré', async () => {
    const t = setup();
    expect((await handle(t.req({ token: TOKEN }, {}), t.deps)).status).toBe(401);
    expect(
      (await handle(t.req({ token: TOKEN }, { authorization: 'Bearer pas-un-jwt' }), t.deps))
        .status,
    ).toBe(401);
    expect(
      (await handle(t.req({ token: TOKEN }, { authorization: 'Basic abc' }), t.deps)).status,
    ).toBe(401);
    expect((await handle(t.req({}, undefined, 'GET'), t.deps)).status).toBe(405);
    expect((await handle(t.req('pas du json'), t.deps)).status).toBe(400);
    expect((await handle(t.req({ token: 'court' }), t.deps)).status).toBe(400);
    expect((await handle(t.req({ token: 42 }), t.deps)).status).toBe(400);
    expect((await handle(t.req({ token: TOKEN, junk: 'x'.repeat(5000) }), t.deps)).status).toBe(
      413,
    );
    expect(t.fetchMock).not.toHaveBeenCalled();
  });

  it('prévol CORS (le navigateur de l’application) sans aucun appel', async () => {
    const t = setup();
    const res = await handle(t.req(null, {}, 'OPTIONS'), t.deps);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(t.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'pas administrateur / jeton inconnu',
      new Response('{"code":"42501"}', { status: 403 }),
      403,
      'forbidden',
    ],
    [
      'invitation révoquée ou expirée',
      new Response('{"message":"invitation_invalid"}', { status: 400 }),
      409,
      'invitation_invalid',
    ],
    [
      'limite d’envois',
      new Response('{"message":"rate_limited"}', { status: 400 }),
      429,
      'rate_limited',
    ],
    ['session expirée', new Response('', { status: 401 }), 401, 'unauthorized'],
  ])('%s : aucun e-mail, réponse sobre', async (_n, claim, status, error) => {
    const t = setup({ claim });
    const res = await handle(t.req({ token: TOKEN }), t.deps);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expect(t.sentMail()).toBeUndefined();
  });

  it('refus du fournisseur ou panne réseau : la réservation est RENDUE et la réponse ne divulgue rien', async () => {
    for (const send of [
      new Response('{"message":"domain not verified re_secret_key"}', { status: 403 }),
      new Error('réseau'),
    ]) {
      const t = setup({ send });
      const res = await handle(t.req({ token: TOKEN }), t.deps);
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).toBe('{"error":"send_failed"}');
      expect(text).not.toContain('re_secret_key');
      const release = t.calls.find((c) => c.url.includes('release_invitation_email'))!;
      expect(JSON.parse(release.init.body as string)).toEqual({ p_id: CLAIM.id });
    }
  });

  it('le contenu venant de la base est échappé (HTML) et sans saut de ligne dans l’objet (en-têtes)', async () => {
    const t = setup({
      claim: new Response(
        JSON.stringify({
          ...CLAIM,
          workspace_name: '<script>alert(1)</script>\r\nBcc: x@y.z',
          inviter: '"><img src=x onerror=1>',
        }),
        { status: 200 },
      ),
    });
    const res = await handle(t.req({ token: TOKEN }), t.deps);
    expect(res.status).toBe(200);
    const mail = JSON.parse(t.sentMail()!.init.body as string) as { subject: string; html: string };
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('message en français ou en anglais, jeton affiché, expiration, aucune adresse d’autrui', () => {
    const fr = compose(CLAIM as never, TOKEN, 'fr');
    expect(fr.subject).toBe('Invitation à rejoindre « Équipe » sur Slate');
    expect(fr.text).toContain('en tant que éditeur');
    expect(fr.text).toContain('Compte → Partage → Rejoindre un espace');
    expect(fr.text).toContain('expire le 2026-12-01');
    const en = compose({ ...CLAIM, role: 'admin' } as never, TOKEN, 'en');
    expect(en.subject).toBe('Invitation to join “Équipe” on Slate');
    expect(en.text).toContain('as administrator');
    expect(en.html).toContain(`<code`);
  });

  it('utilitaires', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
    );
    expect(oneLine('a\r\nb\u0000c ')).toBe('abc');
    expect(oneLine('x'.repeat(500), 10)).toHaveLength(10);
  });
});
