import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { usePages } from '../pages';
import { Button, SettingRow } from '../../shared/ui';
import { useSync, useSyncControl } from './context';

/** Synchronisation de l'appareil : état honnête (jamais « à jour » sans accusé du serveur), actions, limites. */
export function SyncSection() {
  const { t, i18n } = useTranslation();
  const control = useSyncControl();
  const phase = useSync((s) => s.phase);
  const status = useSync((s) => s.status);
  const lastOkAt = useSync((s) => s.lastOkAt);
  const error = useSync((s) => s.error);
  const workspaceId = usePages((s) => s.workspaceId);
  const fmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );
  useEffect(() => void control.refreshStatus(), [control]);

  const enabled = status?.enabled ?? false;
  const line = !enabled
    ? t('sync.off')
    : phase === 'syncing'
      ? t('sync.syncing')
      : phase === 'offline'
        ? t('sync.offline', { count: status?.pending ?? 0 })
        : phase === 'auth'
          ? t('sync.auth')
          : phase === 'error'
            ? t('sync.error', { cause: t(`sync.cause.${error ?? 'server'}`) })
            : status && status.pending === 0 && lastOkAt
              ? t('sync.upToDate', { date: fmt.format(new Date(lastOkAt)) })
              : t('sync.pending', { count: status?.pending ?? 0 });

  return (
    <section aria-labelledby="sync-title" className="space-y-3">
      <h3 id="sync-title" className="font-medium">
        {t('sync.title')}
      </h3>
      <SettingRow title={t('sync.thisDevice')} description={t('sync.description')}>
        {enabled ? (
          <Button variant="danger" onClick={() => void control.disable()}>
            {t('sync.disable')}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!workspaceId}
            onClick={() => workspaceId && void control.enable(workspaceId)}
          >
            {t('sync.enable')}
          </Button>
        )}
      </SettingRow>
      <p role="status" className="rounded-lg bg-surface p-3">
        {line}
      </p>
      {enabled && (status?.rejected ?? 0) > 0 ? (
        <p role="alert" className="rounded-lg bg-surface p-3 text-danger">
          {t('sync.rejected', { count: status?.rejected ?? 0 })}
        </p>
      ) : null}
      {enabled ? (
        <Button onClick={() => void control.syncNow()} disabled={phase === 'syncing'}>
          {t('sync.now')}
        </Button>
      ) : null}
      <p className="rounded-lg bg-surface p-3 text-xs text-muted">{t('sync.limits')}</p>
    </section>
  );
}
