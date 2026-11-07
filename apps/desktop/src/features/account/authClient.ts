import { z } from 'zod';

/**
 * Client minimal de Supabase Auth (GoTrue, REST). Choix volontaire : pas de SDK complet (poids, stockage de session
 * imposé) ; la session n'est PAS persistée par ce client — seul le jeton de rafraîchissement l'est, par le coffre natif.
 * Aucun mot de passe n'est journalisé ni conservé ; il ne transite que dans le corps HTTPS de la requête.
 */
export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'weak_password'
  | 'rate_limited'
  | 'signup_disabled'
  | 'invalid_email'
  | 'invalid_password'
  | 'session_invalid'
  | 'network'
  | 'unknown';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'AuthError';
  }
}

export interface AuthUser {
  id: string;
  email: string;
  emailConfirmed: boolean;
}
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** Instant d'expiration du jeton d'accès (ms epoch). */
  expiresAt: number;
  user: AuthUser;
}
export interface Profile {
  id: string;
  displayName: string;
  locale: 'fr' | 'en';
  timezone: string;
}
export type SignUpResult = { session: AuthSession } | { session: null; needsConfirmation: true };

export interface AuthClient {
  signUp(email: string, password: string, displayName: string): Promise<SignUpResult>;
  signIn(email: string, password: string): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession>;
  signOut(accessToken: string): Promise<void>;
  recover(email: string): Promise<void>;
  getProfile(accessToken: string, userId: string): Promise<Profile>;
  updateProfile(
    accessToken: string,
    userId: string,
    patch: Partial<Omit<Profile, 'id'>>,
  ): Promise<Profile>;
}

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 72; // limite de bcrypt côté GoTrue
export const isValidEmail = (e: string) =>
  e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(e);

const userSchema = z.object({
  id: z.string(),
  email: z.string().optional().default(''),
  email_confirmed_at: z.string().nullish(),
});
const sessionSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  expires_at: z.number().optional(),
  user: userSchema,
});
const profileRow = z.object({
  id: z.string(),
  display_name: z.string(),
  locale: z.enum(['fr', 'en']),
  timezone: z.string(),
});

const toUser = (u: z.infer<typeof userSchema>): AuthUser => ({
  id: u.id,
  email: u.email,
  emailConfirmed: !!u.email_confirmed_at,
});

export function toSession(raw: unknown, now: number): AuthSession {
  const s = sessionSchema.parse(raw);
  return {
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    expiresAt: s.expires_at ? s.expires_at * 1000 : now + s.expires_in * 1000,
    user: toUser(s.user),
  };
}

/** Traduit une réponse d'erreur GoTrue en code applicatif (sans exposer de détail sensible). */
export function mapError(status: number, body: unknown): AuthError {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const c = String(b['error_code'] ?? b['code'] ?? '');
  if (status === 429 || c === 'over_request_rate_limit' || c === 'over_email_send_rate_limit')
    return new AuthError('rate_limited', status);
  switch (c) {
    case 'invalid_credentials':
      return new AuthError('invalid_credentials', status);
    case 'email_not_confirmed':
      return new AuthError('email_not_confirmed', status);
    case 'weak_password':
      return new AuthError('weak_password', status);
    case 'signup_disabled':
    case 'email_provider_disabled':
      return new AuthError('signup_disabled', status);
    case 'validation_failed':
    case 'email_address_invalid':
      return new AuthError('invalid_email', status);
    case 'refresh_token_not_found':
    case 'refresh_token_already_used':
    case 'session_not_found':
    case 'session_expired':
    case 'bad_jwt':
    case 'invalid_grant':
      return new AuthError('session_invalid', status);
  }
  if (String(b['error']) === 'invalid_grant') return new AuthError('invalid_credentials', status);
  return new AuthError('unknown', status);
}

export function createAuthClient(opts: {
  url: string;
  anonKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): AuthClient {
  const base = opts.url.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? Date.now;

  async function call(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      token?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        signal: ctl.signal,
        headers: {
          apikey: opts.anonKey,
          Authorization: `Bearer ${init.token ?? opts.anonKey}`,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new AuthError('network');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw mapError(res.status, json);
    return json;
  }
  const parseSession = (raw: unknown) => {
    try {
      return toSession(raw, now());
    } catch {
      throw new AuthError('unknown');
    }
  };

  return {
    async signUp(email, password, displayName) {
      const raw = await call('/auth/v1/signup', {
        method: 'POST',
        body: { email, password, data: { display_name: displayName.slice(0, 100) } },
      });
      // Confirmation d'e-mail requise : pas de session. La réponse est volontairement identique si l'adresse existe déjà.
      if (typeof raw === 'object' && raw !== null && 'access_token' in raw)
        return { session: parseSession(raw) };
      return { session: null, needsConfirmation: true };
    },
    async signIn(email, password) {
      return parseSession(
        await call('/auth/v1/token?grant_type=password', {
          method: 'POST',
          body: { email, password },
        }),
      );
    },
    async refresh(refreshToken) {
      return parseSession(
        await call('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          body: { refresh_token: refreshToken },
        }),
      );
    },
    async signOut(accessToken) {
      await call('/auth/v1/logout', { method: 'POST', token: accessToken });
    },
    async recover(email) {
      await call('/auth/v1/recover', { method: 'POST', body: { email } });
    },
    async getProfile(accessToken, userId) {
      const raw = await call(
        `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,display_name,locale,timezone`,
        { token: accessToken },
      );
      const row = z.array(profileRow).parse(raw)[0];
      if (!row) throw new AuthError('unknown');
      return {
        id: row.id,
        displayName: row.display_name,
        locale: row.locale,
        timezone: row.timezone,
      };
    },
    async updateProfile(accessToken, userId, patch) {
      const body: Record<string, unknown> = {};
      if (patch.displayName !== undefined) body['display_name'] = patch.displayName.slice(0, 100);
      if (patch.locale) body['locale'] = patch.locale;
      if (patch.timezone) body['timezone'] = patch.timezone;
      const raw = await call(
        `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,display_name,locale,timezone`,
        {
          method: 'PATCH',
          token: accessToken,
          body,
          headers: { Prefer: 'return=representation' },
        },
      );
      const row = z.array(profileRow).parse(raw)[0];
      if (!row) throw new AuthError('unknown');
      return {
        id: row.id,
        displayName: row.display_name,
        locale: row.locale,
        timezone: row.timezone,
      };
    },
  };
}
