import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { usePages } from '../pages';
import { Button } from '../../shared/ui';
import { SyncError, type Invitation, type Member, type WorkspaceRole } from './client';
import { useSync, useSyncControl } from './context';

const field =
  'h-9 w-full select-text rounded-md border border-line bg-surface px-3 outline-none focus-visible:border-accent';
const ROLES: WorkspaceRole[] = ['viewer', 'editor', 'admin'];

/** Message affiché pour une erreur de partage : jamais le détail technique du serveur. */
function useErrorText() {
  const { t } = useTranslation();
  return (e: unknown): string => {
    if (e instanceof SyncError) {
      if (
        e.code === 'invalid' &&
        ['invitation_invalid', 'too_many_invitations', 'invalid_email'].includes(e.message)
      )
        return t(`sharing.error.${e.message}`);
      if (e.code === 'network') return t('sync.cause.network');
      if (e.code === 'forbidden') return t('sync.cause.forbidden');
      if (e.code === 'auth') return t('sync.cause.auth');
    }
    return t('sharing.error.generic');
  };
}

function JoinForm() {
  const { t } = useTranslation();
  const control = useSyncControl();
  const errorText = useErrorText();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      // `join` signale déjà l'erreur (toast) ; on affiche ici une ligne locale et accessible.
      const r = await control.join(token);
      if (r) {
        setToken('');
        setMsg({ ok: true, text: t('sharing.joined', { name: r.name }) });
      } else setMsg({ ok: false, text: t('sharing.error.invitation_invalid') });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2">
      <h4 className="font-medium">{t('sharing.joinTitle')}</h4>
      <p className="text-muted">{t('sharing.joinHelp')}</p>
      <label className="block space-y-1">
        <span>{t('sharing.tokenLabel')}</span>
        <input
          className={field}
          value={token}
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <Button type="submit" variant="primary" disabled={busy || token.trim().length === 0}>
        {t('sharing.join')}
      </Button>
      {msg ? (
        <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? undefined : 'text-danger'}>
          {msg.text}
        </p>
      ) : null}
    </form>
  );
}

function ManagePanel({ workspaceId }: { workspaceId: string }) {
  const { t, i18n } = useTranslation();
  const control = useSyncControl();
  const client = control.client;
  const errorText = useErrorText();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('editor');
  const [created, setCreated] = useState<{ email: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [wantMail, setWantMail] = useState(true);
  type Mail = 'sending' | 'sent' | 'notConfigured' | 'rateLimited' | 'failed';
  const [mail, setMail] = useState<Mail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );

  const reload = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([
        client.listMembers(workspaceId),
        client.listInvitations(workspaceId),
      ]);
      setMembers(m);
      setInvites(
        i.filter((x) => !x.accepted_at && !x.revoked_at && new Date(x.expires_at) > new Date()),
      );
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId]);
  useEffect(() => void reload(), [reload]);
  useEffect(() => setCreated(null), [workspaceId]);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      setError(null);
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const invite = (e: FormEvent) => {
    e.preventDefault();
    const target = email.trim();
    void act(async () => {
      const r = await client.createInvitation(workspaceId, target, role);
      setCreated({ email: r.email, token: r.token });
      setCopied(false);
      setEmail('');
      setMail(null);
      if (wantMail) void sendMail(r.token);
    });
  };

  /**
   * Envoi par e-mail : on n'affirme « envoyé » que lorsque le serveur confirme que le fournisseur a accepté le message.
   * Quoi qu'il arrive, le jeton reste affiché : l'invitation ne dépend jamais de l'e-mail.
   */
  const sendMail = async (token: string) => {
    setMail('sending');
    try {
      await client.emailInvitation(token, i18n.language.startsWith('en') ? 'en' : 'fr');
      setMail('sent');
    } catch (e) {
      const detail = e instanceof SyncError && e.code === 'invalid' ? e.message : '';
      setMail(
        detail === 'not_configured'
          ? 'notConfigured'
          : detail === 'rate_limited'
            ? 'rateLimited'
            : 'failed',
      );
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
    } catch {
      setCopied(false); // presse-papiers refusé : le jeton reste visible et sélectionnable
    }
  };

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}

      <div className="space-y-2">
        <h4 className="font-medium">{t('sharing.members')}</h4>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {members.map((m) => (
            <li key={m.user_id} className="flex items-center justify-between gap-3 p-2.5">
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {m.display_name || m.email}
                  {m.is_me ? ` (${t('sharing.you')})` : ''}
                </div>
                <div className="truncate text-muted">{m.email}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <select
                  className={field + ' w-auto'}
                  aria-label={t('sharing.roleOf', { name: m.display_name || m.email })}
                  value={m.role}
                  disabled={busy || m.is_me}
                  onChange={(e) =>
                    void act(() =>
                      client.setMemberRole(workspaceId, m.user_id, e.target.value as WorkspaceRole),
                    )
                  }
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`sharing.role.${r}`)}
                    </option>
                  ))}
                </select>
                {!m.is_me ? (
                  <Button
                    variant="danger"
                    disabled={busy}
                    aria-label={t('sharing.remove', { name: m.display_name || m.email })}
                    onClick={() => void act(() => client.removeMember(workspaceId, m.user_id))}
                  >
                    {t('sharing.removeShort')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <form onSubmit={invite} className="space-y-2">
        <h4 className="font-medium">{t('sharing.inviteTitle')}</h4>
        <p className="text-muted">{t('sharing.inviteHelp')}</p>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <label className="block space-y-1">
            <span>{t('sharing.emailLabel')}</span>
            <input
              className={field}
              type="email"
              required
              autoComplete="off"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span>{t('sharing.roleField')}</span>
            <select
              className={field}
              value={role}
              onChange={(e) => setRole(e.target.value as WorkspaceRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`sharing.role.${r}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={wantMail}
            onChange={(e) => setWantMail(e.target.checked)}
            className="size-4 accent-[var(--fg)]"
          />
          <span>{t('sharing.mail.send')}</span>
        </label>
        <Button type="submit" variant="primary" disabled={busy || email.trim() === ''}>
          {t('sharing.invite')}
        </Button>
      </form>

      {created ? (
        <div role="status" className="space-y-2 rounded-lg bg-surface p-3">
          <p>{t('sharing.tokenOnce', { email: created.email })}</p>
          {mail ? (
            <p role={mail === 'sent' || mail === 'sending' ? 'status' : 'alert'}>
              {t(`sharing.mail.${mail}`, { email: created.email })}
            </p>
          ) : null}
          <input
            readOnly
            className={field + ' font-mono'}
            aria-label={t('sharing.tokenFor', { email: created.email })}
            value={created.token}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex gap-2">
            <Button onClick={() => void copy()}>
              {copied ? t('sharing.copied') : t('sharing.copy')}
            </Button>
            {mail !== null && mail !== 'sent' && mail !== 'sending' && mail !== 'notConfigured' ? (
              <Button onClick={() => void sendMail(created.token)}>
                {t('sharing.mail.retry')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <h4 className="font-medium">{t('sharing.pending')}</h4>
        {invites.length === 0 ? (
          <p className="text-muted">{t('sharing.noPending')}</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {invites.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 p-2.5">
                <div className="min-w-0">
                  <div className="truncate font-medium">{i.email}</div>
                  <div className="text-muted">
                    {t(`sharing.role.${i.role}`)} ·{' '}
                    {t('sharing.expires', { date: fmt.format(new Date(i.expires_at)) })}
                  </div>
                </div>
                <Button
                  variant="danger"
                  disabled={busy}
                  aria-label={t('sharing.revoke', { email: i.email })}
                  onClick={() => void act(() => client.revokeInvitation(i.id))}
                >
                  {t('sharing.revokeShort')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Partage de l'espace affiché : invitations et membres (administrateurs), et accès à un espace par jeton d'invitation. */
export function SharingSection() {
  const { t } = useTranslation();
  const status = useSync((s) => s.status);
  const workspaceId = usePages((s) => s.workspaceId);
  const workspaces = usePages((s) => s.workspaces);
  const current = workspaces.find((w) => w.id === workspaceId);
  const sync = status?.enabled
    ? status.workspaces.find((w) => w.workspaceId === workspaceId)
    : undefined;

  return (
    <section aria-labelledby="sharing-title" className="space-y-4">
      <h3 id="sharing-title" className="font-medium">
        {t('sharing.title')}
      </h3>
      {current ? (
        <p className="text-muted">{t('sharing.current', { name: current.name })}</p>
      ) : null}
      {!sync ? (
        <p className="rounded-lg bg-surface p-3">{t('sharing.needSync')}</p>
      ) : sync.role !== 'admin' ? (
        <p className="rounded-lg bg-surface p-3">
          {t('sharing.adminOnly', { role: t(`sharing.role.${sync.role}`) })}
        </p>
      ) : workspaceId ? (
        <ManagePanel workspaceId={workspaceId} />
      ) : null}
      <JoinForm />
      <p className="rounded-lg bg-surface p-3 text-xs text-muted">{t('sharing.limits')}</p>
    </section>
  );
}
