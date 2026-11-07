/**
 * Envoi d'une invitation par e-mail (fonction Edge Supabase). Code PUR (aucune API Deno) : testé avec Vitest.
 *
 * Sécurité :
 *  - aucun pouvoir propre : la fonction agit avec le JETON DE L'APPELANT (jamais de service_role) ;
 *  - le DESTINATAIRE n'est jamais fourni par l'appelant : il est lu dans l'invitation par la fonction SQL
 *    `claim_invitation_email`, qui vérifie aussi que l'appelant est administrateur de l'espace, que l'invitation est
 *    en attente, et applique les limites (3 envois, 1 par minute) ;
 *  - rien n'est réservé tant que l'envoi n'est pas configuré (secrets absents → 503, aucun compteur consommé) ;
 *  - tout ce qui vient de la base (nom d'espace, nom de l'invitant) est échappé avant d'entrer dans le message ;
 *  - ni clé, ni jeton, ni adresse n'apparaissent dans les journaux ni dans les réponses d'erreur.
 */

export interface Deps {
  env(name: string): string | undefined;
  fetch: typeof fetch;
}

type Locale = 'fr' | 'en';
const TOKEN = /^[0-9a-f]{64}$/;
const MAX_BODY = 2048;

const cors = {
  'access-control-allow-origin': '*', // jeton porté dans l'en-tête Authorization : aucun cookie, donc aucun risque de CSRF
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400',
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

export const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Ligne d'en-tête sûre : pas de saut de ligne (injection d'en-têtes), pas de contrôles, bornée. */
export const oneLine = (s: string, max = 120): string =>
  [...s]
    .filter((ch) => (ch.codePointAt(0) ?? 0) >= 0x20 && (ch.codePointAt(0) ?? 0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, max);

interface Claim {
  id: string;
  email: string;
  role: 'viewer' | 'editor' | 'admin';
  workspace_name: string;
  inviter: string;
  expires_at: string;
}

const ROLE: Record<Locale, Record<Claim['role'], string>> = {
  fr: { viewer: 'lecteur', editor: 'éditeur', admin: 'administrateur' },
  en: { viewer: 'viewer', editor: 'editor', admin: 'administrator' },
};

export function compose(
  c: Claim,
  token: string,
  locale: Locale,
): { subject: string; text: string; html: string } {
  const ws = oneLine(c.workspace_name, 80) || (locale === 'fr' ? 'un espace' : 'a space');
  const who = oneLine(c.inviter, 80) || (locale === 'fr' ? 'Quelqu’un' : 'Someone');
  const role = ROLE[locale][c.role];
  const date = new Date(c.expires_at);
  const until = Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  const t =
    locale === 'fr'
      ? {
          subject: `Invitation à rejoindre « ${ws} » sur Slate`,
          lines: [
            `${who} vous invite à rejoindre l’espace « ${ws} » sur Slate, en tant que ${role}.`,
            'Pour accepter : connectez-vous à Slate avec cette adresse e-mail, ouvrez Compte → Partage → Rejoindre un espace, puis collez ce jeton :',
            token,
            until ? `Cette invitation expire le ${until}.` : '',
            'Le jeton ne fonctionne qu’avec le compte de cette adresse e-mail. Si vous n’attendiez pas cette invitation, ignorez ce message.',
          ],
        }
      : {
          subject: `Invitation to join “${ws}” on Slate`,
          lines: [
            `${who} invites you to join the space “${ws}” on Slate, as ${role}.`,
            'To accept: sign in to Slate with this e-mail address, open Account → Sharing → Join a space, then paste this token:',
            token,
            until ? `This invitation expires on ${until}.` : '',
            'The token only works with the account of this e-mail address. If you were not expecting this invitation, ignore this message.',
          ],
        };
  const lines = t.lines.filter(Boolean);
  return {
    subject: oneLine(t.subject, 200),
    text: lines.join('\n\n'),
    html: lines
      .map((l) =>
        l === token
          ? `<p><code style="font-size:14px;word-break:break-all">${escapeHtml(l)}</code></p>`
          : `<p>${escapeHtml(l)}</p>`,
      )
      .join(''),
  };
}

export async function handle(req: Request, d: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(auth)) return json(401, { error: 'unauthorized' });

  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json(413, { error: 'too_large' });
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'bad_request' });
  }
  const b = (body ?? {}) as { token?: unknown; locale?: unknown };
  if (typeof b.token !== 'string' || !TOKEN.test(b.token))
    return json(400, { error: 'bad_request' });
  const locale: Locale = b.locale === 'en' ? 'en' : 'fr';

  const url = d.env('SUPABASE_URL');
  const anon = d.env('SUPABASE_ANON_KEY');
  const key = d.env('RESEND_API_KEY');
  const from = d.env('MAIL_FROM');
  // Pas configuré : on le dit AVANT de réserver quoi que ce soit.
  if (!key || !from) return json(503, { error: 'not_configured' });
  if (!url || !anon) return json(500, { error: 'server_misconfigured' });

  const rpc = (name: string, args: Record<string, unknown>) =>
    d.fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: anon, authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });

  let claimRes: Response;
  try {
    claimRes = await rpc('claim_invitation_email', { p_token: b.token });
  } catch {
    return json(502, { error: 'unavailable' });
  }
  if (!claimRes.ok) {
    const text = await claimRes.text().catch(() => '');
    if (/rate_limited/.test(text) || claimRes.status === 429)
      return json(429, { error: 'rate_limited' });
    if (/invitation_invalid/.test(text)) return json(409, { error: 'invitation_invalid' });
    if (claimRes.status === 401) return json(401, { error: 'unauthorized' });
    return json(403, { error: 'forbidden' });
  }
  const c = (await claimRes.json().catch(() => null)) as Claim | null;
  if (!c || typeof c.email !== 'string' || typeof c.id !== 'string')
    return json(502, { error: 'unavailable' });

  const release = () => rpc('release_invitation_email', { p_id: c.id }).catch(() => undefined);
  const msg = compose(c, b.token, locale);
  let send: Response;
  try {
    send = await d.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [c.email],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
    });
  } catch {
    await release();
    return json(502, { error: 'send_failed' });
  }
  if (!send.ok) {
    await release(); // le fournisseur n'a rien accepté : l'envoi ne compte pas
    return json(502, { error: 'send_failed' });
  }
  return json(200, { sent: true });
}
