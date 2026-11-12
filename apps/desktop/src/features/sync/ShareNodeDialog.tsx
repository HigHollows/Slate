import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { bus, type BusEvents } from '../../shared/bus';
import { usePages } from '../pages';
import { Button, Dialog } from '../../shared/ui';
import { SyncError, type NodeShares } from './client';
import { useSync, useSyncControl } from './context';

const field =
  'h-9 w-full select-text rounded-md border border-line bg-surface px-3 outline-none focus-visible:border-accent';
type Target = BusEvents['share-node'];

/**
 * Partage d'UN dossier ou d'UNE page : la personne invitée ne voit que cet élément et ce qu'il contient.
 * Tout est décidé par le serveur (administrateurs de l'espace seulement) ; cette fenêtre ne fait qu'appeler ses fonctions.
 */
export function ShareNodeDialog() {
  const { t } = useTranslation();
  const [target, setTarget] = useState<Target | null>(null);
  useEffect(() => bus.on('share-node', (e) => setTarget(e)), []);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => !o && setTarget(null)}
      title={target ? t('sharing.node.title', { title: target.title }) : ''}
    >
      {target ? <Body key={target.id} target={target} /> : null}
    </Dialog>
  );
}

function Body({ target }: { target: Target }) {
  const { t } = useTranslation();
  const client = useSyncControl().client;
  const status = useSync((s) => s.status);
  const workspaceId = usePages((s) => s.workspaceId);
  const synced = Boolean(
    status?.enabled && status.workspaces.some((w) => w.workspaceId === workspaceId),
  );
  const [data, setData] = useState<NodeShares | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor'>('editor');
  const [created, setCreated] = useState<{ email: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const message = (e: unknown): string => {
    if (e instanceof SyncError) {
      if (e.code === 'invalid' && ['too_many_invitations', 'invalid_email'].includes(e.message))
        return t(`sharing.error.${e.message}`);
      if (e.code === 'network') return t('sync.cause.network');
      if (e.code === 'forbidden') return t('sync.cause.forbidden');
      if (e.code === 'auth') return t('sync.cause.auth');
    }
    return t('sharing.error.generic');
  };

  const reload = useCallback(async () => {
    try {
      setData(await client.listNodeShares(target.id));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, target.id]);
  useEffect(() => {
    if (synced) void reload();
  }, [synced, reload]);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      setError(null);
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const invite = (e: FormEvent) => {
    e.preventDefault();
    const to = email.trim();
    void act(async () => {
      const r = await client.createNodeInvitation(target.id, to, role);
      setCreated({ email: r.email, token: r.token });
      setCopied(false);
      setEmail('');
    });
  };
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(
        t('sharing.message', { token: created.token, email: created.email }),
      );
      setCopied(true);
    } catch {
      setCopied(false); // presse-papiers refusé : le jeton reste visible et sélectionnable
    }
  };

  if (!synced) return <p className="p-5">{t('sharing.node.needSync')}</p>;

  return (
    <div className="space-y-4 p-5">
      <p className="text-muted">{t(`sharing.node.intro.${target.kind}`)}</p>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}

      <form onSubmit={invite} className="space-y-2">
        <h3 className="font-medium">{t('sharing.node.invite')}</h3>
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
              onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')}
            >
              <option value="editor">{t('sharing.role.editor')}</option>
              <option value="viewer">{t('sharing.role.viewer')}</option>
            </select>
          </label>
        </div>
        <Button type="submit" variant="primary" disabled={busy || email.trim() === ''}>
          {t('sharing.invite')}
        </Button>
      </form>

      {created ? (
        <div role="status" className="space-y-2 rounded-lg bg-surface p-3">
          <p>{t('sharing.node.created', { email: created.email })}</p>
          <input
            readOnly
            className={field + ' font-mono'}
            aria-label={t('sharing.tokenFor', { email: created.email })}
            value={created.token}
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button onClick={() => void copy()}>
            {copied ? t('sharing.copied') : t('sharing.copy')}
          </Button>
        </div>
      ) : null}

      <div className="space-y-2">
        <h3 className="font-medium">{t('sharing.node.access')}</h3>
        {data && data.shares.length === 0 && data.invitations.length === 0 ? (
          <p className="text-muted">{t('sharing.node.noAccess')}</p>
        ) : null}
        {data && (data.shares.length > 0 || data.invitations.length > 0) ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {data.shares.map((s) => (
              <li key={s.user_id} className="flex items-center justify-between gap-3 p-2.5">
                <div className="min-w-0">
                  <div className="truncate font-medium">{s.display_name || s.email}</div>
                  <div className="truncate text-muted">
                    {s.email} · {t(`sharing.role.${s.role}`)}
                  </div>
                </div>
                <Button
                  variant="danger"
                  disabled={busy}
                  aria-label={t('sharing.node.removeAccess', { name: s.display_name || s.email })}
                  onClick={() => void act(() => client.removeNodeShare(target.id, s.user_id))}
                >
                  {t('sharing.removeShort')}
                </Button>
              </li>
            ))}
            {data.invitations.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 p-2.5">
                <div className="min-w-0">
                  <div className="truncate font-medium">{i.email}</div>
                  <div className="text-muted">
                    {t(`sharing.role.${i.role}`)} · {t('sharing.pending')}
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
        ) : null}
      </div>
    </div>
  );
}
