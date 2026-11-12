import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Segmented, SettingRow, toast } from '../../shared/ui';
import { MAX_PASSWORD, MIN_PASSWORD, type AuthError } from './authClient';
import { SharingSection, SyncSection, useSyncControl } from '../sync';
import { usePagesStore } from '../pages';
import { useAccount, useAccountStore } from './context';

const field =
  'h-9 w-full select-text rounded-md border border-line bg-surface px-3 outline-none focus-visible:border-accent';

function ErrorLine({ error }: { error: AuthError | null }) {
  const { t } = useTranslation();
  return error ? (
    <p role="alert" className="text-danger">
      {t(`account.error.${error.code}`)}
    </p>
  ) : null;
}

/** Compte Slate (Supabase Auth). Le mode invité reste pleinement utilisable : se connecter est facultatif. */
export function AccountTab() {
  const { t } = useTranslation();
  const store = useAccountStore();
  const status = useAccount((s) => s.status);
  const email = useAccount((s) => s.email);
  const profile = useAccount((s) => s.profile);
  const notice = useAccount((s) => s.notice);
  const [mode, setMode] = useState<'signIn' | 'signUp' | 'recover'>('signIn');
  const [mail, setMail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<AuthError | null>(null);
  const [busy, setBusy] = useState(false);
  const [wantSync, setWantSync] = useState(true);
  const sync = useSyncControl();
  const pages = usePagesStore();
  const [draftName, setDraftName] = useState('');
  useEffect(() => setDraftName(profile?.displayName ?? ''), [profile?.displayName]);
  useEffect(() => {
    if (status === 'signedIn') setMode('signIn');
  }, [status]);

  const run = async (f: () => Promise<AuthError | null>) => {
    setBusy(true);
    setError(null);
    const e = await f();
    setBusy(false);
    setError(e);
    if (!e) setPassword(''); // le mot de passe ne reste jamais en mémoire de l'interface
    return e;
  };

  if (status === 'loading')
    return (
      <p role="status" className="text-muted">
        {t('account.loading')}
      </p>
    );
  if (status === 'unavailable') {
    return (
      <section aria-labelledby="tab-account">
        <h2 id="tab-account" className="sr-only">
          {t('settings.tabs.account')}
        </h2>
        <p className="rounded-lg bg-surface p-4 text-muted">{t('account.unavailable')}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="tab-account" className="space-y-4">
      <h2 id="tab-account" className="sr-only">
        {t('settings.tabs.account')}
      </h2>
      {status === 'offline' ? (
        <p role="status" className="rounded-lg bg-surface p-3 text-muted">
          {t('account.offline')}
        </p>
      ) : null}
      {notice === 'sessionNotRemembered' ? (
        <p role="alert" className="rounded-lg bg-surface p-3 text-danger">
          {t('account.notice.sessionNotRemembered')}
        </p>
      ) : null}

      {status === 'signedIn' || status === 'offline' ? (
        <>
          <SettingRow title={t('account.signedInAs')} description={email ?? ''}>
            <Button variant="danger" onClick={() => void store.getState().signOut()}>
              {t('account.signOut')}
            </Button>
          </SettingRow>
          {profile ? (
            <form
              className="space-y-3 rounded-lg bg-surface p-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => store.getState().updateProfile({ displayName: draftName })).then(
                  (er) => !er && toast.success(t('account.profileSaved')),
                );
              }}
            >
              <h3 className="font-medium">{t('account.profile')}</h3>
              <label className="block space-y-1">
                <span>{t('account.displayName')}</span>
                <input
                  className={field}
                  maxLength={100}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span>{t('account.locale')}</span>
                  <select
                    className={field}
                    value={profile.locale}
                    onChange={(e) =>
                      void run(() =>
                        store.getState().updateProfile({ locale: e.target.value as 'fr' | 'en' }),
                      )
                    }
                  >
                    <option value="fr">Français</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <label className="block space-y-1">
                  <span>{t('account.timezone')}</span>
                  <select
                    className={field}
                    value={profile.timezone}
                    onChange={(e) =>
                      void run(() => store.getState().updateProfile({ timezone: e.target.value }))
                    }
                  >
                    {[...new Set([profile.timezone, ...Intl.supportedValuesOf('timeZone')])].map(
                      (z) => (
                        <option key={z} value={z}>
                          {z}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              </div>
              <ErrorLine error={error} />
              <Button
                variant="primary"
                type="submit"
                disabled={busy || draftName === profile.displayName}
              >
                {t('common.apply')}
              </Button>
            </form>
          ) : null}
          <SyncSection />
          <SharingSection />
        </>
      ) : (
        <>
          <p className="text-muted">{t('account.guestIntro')}</p>
          {notice === 'confirmEmail' ? (
            <p role="status" className="rounded-lg bg-surface p-3">
              {t('account.notice.confirmEmail')}
            </p>
          ) : null}
          {notice === 'resetSent' ? (
            <p role="status" className="rounded-lg bg-surface p-3">
              {t('account.notice.resetSent')}
            </p>
          ) : null}
          {mode !== 'recover' ? (
            <Segmented
              label={t('account.mode')}
              value={mode}
              onChange={(m) => {
                setMode(m);
                setError(null);
                store.getState().dismissNotice();
              }}
              options={[
                { value: 'signIn', label: t('account.signIn') },
                { value: 'signUp', label: t('account.signUp') },
              ]}
            />
          ) : null}
          <form
            className="max-w-sm space-y-3"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (mode === 'signIn')
                void run(() => store.getState().signIn(mail, password)).then((err) => {
                  // Connexion réussie : on active la synchronisation de cet appareil si la case est cochée.
                  const ws = pages.getState().workspaceId;
                  if (!err && wantSync && ws) void sync.enable(ws);
                });
              else if (mode === 'signUp')
                void run(() => store.getState().signUp(mail, password, name));
              else void run(() => store.getState().recover(mail));
            }}
          >
            {mode === 'signUp' ? (
              <label className="block space-y-1">
                <span>{t('account.displayName')}</span>
                <input
                  className={field}
                  autoComplete="name"
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            ) : null}
            <label className="block space-y-1">
              <span>{t('account.email')}</span>
              <input
                className={field}
                type="email"
                autoComplete="username"
                inputMode="email"
                required
                value={mail}
                onChange={(e) => setMail(e.target.value)}
              />
            </label>
            {mode !== 'recover' ? (
              <label className="block space-y-1">
                <span>{t('account.password')}</span>
                <input
                  className={field}
                  type="password"
                  autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
                  maxLength={MAX_PASSWORD}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {mode === 'signUp' ? (
                  <span className="text-xs text-muted">
                    {t('account.passwordHint', { min: MIN_PASSWORD })}
                  </span>
                ) : null}
              </label>
            ) : null}
            {mode === 'signIn' ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={wantSync}
                  onChange={(e) => setWantSync(e.target.checked)}
                  className="size-4 accent-[var(--fg)]"
                />
                <span>{t('account.syncOnSignIn')}</span>
              </label>
            ) : null}
            <ErrorLine error={error} />
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                type="submit"
                disabled={busy || mail === '' || (mode !== 'recover' && password === '')}
              >
                {mode === 'signIn'
                  ? t('account.signIn')
                  : mode === 'signUp'
                    ? t('account.signUp')
                    : t('account.sendReset')}
              </Button>
              {mode === 'recover' ? (
                <button
                  type="button"
                  className="text-muted underline underline-offset-2"
                  onClick={() => {
                    setMode('signIn');
                    setError(null);
                  }}
                >
                  {t('account.backToSignIn')}
                </button>
              ) : mode === 'signIn' ? (
                <button
                  type="button"
                  className="text-muted underline underline-offset-2"
                  onClick={() => {
                    setMode('recover');
                    setError(null);
                    store.getState().dismissNotice();
                  }}
                >
                  {t('account.forgot')}
                </button>
              ) : null}
            </div>
          </form>
          <p className="rounded-lg bg-surface p-3 text-xs text-muted">
            {t('account.syncNotAvailable')}
          </p>
        </>
      )}
    </section>
  );
}
