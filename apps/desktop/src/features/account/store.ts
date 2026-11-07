import { createStore } from 'zustand';
import {
  AuthError,
  MAX_PASSWORD,
  MIN_PASSWORD,
  isValidEmail,
  type AuthClient,
  type AuthSession,
  type Profile,
} from './authClient';

/** Coffre du jeton de rafraîchissement (trousseau du système). */
export interface SessionVault {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
}

export type AccountStatus = 'loading' | 'unavailable' | 'signedOut' | 'signedIn' | 'offline';
export type Notice = 'confirmEmail' | 'resetSent' | 'sessionNotRemembered' | null;

export interface AccountState {
  status: AccountStatus;
  email: string | null;
  userId: string | null;
  profile: Profile | null;
  notice: Notice;
  init(): Promise<void>;
  /** Retournent `null` en cas de succès, sinon le code d'erreur à afficher sur place. */
  signIn(email: string, password: string): Promise<AuthError | null>;
  signUp(email: string, password: string, displayName: string): Promise<AuthError | null>;
  signOut(): Promise<void>;
  recover(email: string): Promise<AuthError | null>;
  updateProfile(patch: Partial<Omit<Profile, 'id'>>): Promise<AuthError | null>;
  /** Jeton d'accès valide (rafraîchi si nécessaire) pour les futurs modules cloud ; `null` si hors connexion. */
  accessToken(): Promise<string | null>;
  dismissNotice(): void;
}

const RENEW_MARGIN_MS = 60_000;
const OFFLINE_RETRY_MS = 30_000;

export function createAccountStore(opts: {
  client: AuthClient | null;
  vault: SessionVault;
  now?: () => number;
  onError?: (e: unknown) => void;
}) {
  const now = opts.now ?? Date.now;
  const onError = opts.onError ?? (() => undefined);
  let session: AuthSession | null = null; // le jeton d'accès reste en mémoire, jamais persisté
  let timer: ReturnType<typeof setTimeout> | null = null;

  return createStore<AccountState>((set, get) => {
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const schedule = (ms: number) => {
      clearTimer();
      timer = setTimeout(() => void renew(), Math.max(1_000, ms));
    };
    async function adopt(s: AuthSession, remember: boolean): Promise<void> {
      session = s;
      set({ status: 'signedIn', email: s.user.email, userId: s.user.id });
      schedule(s.expiresAt - now() - RENEW_MARGIN_MS);
      if (remember) {
        try {
          await opts.vault.save(s.refreshToken); // le jeton tourne à chaque rafraîchissement : on le mémorise toujours
        } catch (e) {
          onError(e);
          set({ notice: 'sessionNotRemembered' });
        }
      }
      if (!get().profile || get().profile?.id !== s.user.id) void loadProfile();
    }
    async function loadProfile() {
      if (!opts.client || !session) return;
      try {
        set({ profile: await opts.client.getProfile(session.accessToken, session.user.id) });
      } catch (e) {
        if (!(e instanceof AuthError && e.code === 'network')) onError(e);
      }
    }
    async function dropSession() {
      clearTimer();
      session = null;
      try {
        await opts.vault.clear();
      } catch (e) {
        onError(e);
      }
      set({ status: 'signedOut', email: null, userId: null, profile: null });
    }
    /** Renouvelle la session avec le jeton du coffre. Réseau absent : on garde le jeton et on réessaie plus tard. */
    async function renew(): Promise<boolean> {
      if (!opts.client) return false;
      let token: string | null = session?.refreshToken ?? null;
      try {
        token = token ?? (await opts.vault.load());
      } catch (e) {
        onError(e);
        set({ status: 'signedOut' });
        return false;
      }
      if (!token) {
        set({ status: 'signedOut' });
        return false;
      }
      try {
        await adopt(await opts.client.refresh(token), true);
        return true;
      } catch (e) {
        if (e instanceof AuthError && e.code === 'network') {
          set({ status: 'offline' });
          schedule(OFFLINE_RETRY_MS);
        } else if (e instanceof AuthError && e.code === 'session_invalid') {
          await dropSession(); // jeton révoqué ou expiré : on l'efface
        } else {
          onError(e);
          set({ status: 'offline' });
          schedule(OFFLINE_RETRY_MS);
        }
        return false;
      }
    }

    return {
      status: opts.client ? 'loading' : 'unavailable',
      email: null,
      userId: null,
      profile: null,
      notice: null,

      async init() {
        if (!opts.client) {
          set({ status: 'unavailable' });
          return;
        }
        await renew();
      },

      async signIn(email, password) {
        if (!opts.client) return new AuthError('unknown');
        const e = email.trim().toLowerCase();
        if (!isValidEmail(e)) return new AuthError('invalid_email');
        if (password.length === 0 || password.length > MAX_PASSWORD)
          return new AuthError('invalid_password');
        try {
          set({ notice: null });
          await adopt(await opts.client.signIn(e, password), true);
          return null;
        } catch (err) {
          if (err instanceof AuthError) return err;
          onError(err);
          return new AuthError('unknown');
        }
      },

      async signUp(email, password, displayName) {
        if (!opts.client) return new AuthError('unknown');
        const e = email.trim().toLowerCase();
        if (!isValidEmail(e)) return new AuthError('invalid_email');
        if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)
          return new AuthError('weak_password');
        try {
          const r = await opts.client.signUp(e, password, displayName.trim());
          if (r.session) await adopt(r.session, true);
          else set({ notice: 'confirmEmail' });
          return null;
        } catch (err) {
          if (err instanceof AuthError) return err;
          onError(err);
          return new AuthError('unknown');
        }
      },

      async signOut() {
        const token = session?.accessToken;
        // Déconnexion locale TOUJOURS effectuée, même si le serveur est injoignable.
        await dropSession();
        if (token && opts.client) await opts.client.signOut(token).catch(() => undefined);
      },

      async recover(email) {
        if (!opts.client) return new AuthError('unknown');
        const e = email.trim().toLowerCase();
        if (!isValidEmail(e)) return new AuthError('invalid_email');
        try {
          await opts.client.recover(e);
          set({ notice: 'resetSent' });
          return null;
        } catch (err) {
          return err instanceof AuthError ? err : new AuthError('unknown');
        }
      },

      async updateProfile(patch) {
        if (!opts.client || !session) return new AuthError('session_invalid');
        try {
          set({
            profile: await opts.client.updateProfile(session.accessToken, session.user.id, patch),
          });
          return null;
        } catch (err) {
          return err instanceof AuthError ? err : new AuthError('unknown');
        }
      },

      async accessToken() {
        if (!session) return null;
        if (session.expiresAt - now() > RENEW_MARGIN_MS) return session.accessToken;
        return (await renew()) ? (session?.accessToken ?? null) : null;
      },

      dismissNotice: () => set({ notice: null }),
    };
  });
}
export type AccountStore = ReturnType<typeof createAccountStore>;
