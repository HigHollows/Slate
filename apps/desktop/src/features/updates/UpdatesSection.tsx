import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, SettingRow, Switch } from '../../shared/ui';
import { useUpdates, useUpdatesStore } from './context';

/** Version installée, recherche de mise à jour, installation (toujours sur clic) et vérification automatique. */
export function UpdatesSection() {
  const { t, i18n } = useTranslation();
  const store = useUpdatesStore();
  const status = useUpdates((s) => s.status);
  const version = useUpdates((s) => s.currentVersion);
  const info = useUpdates((s) => s.info);
  const progress = useUpdates((s) => s.progress);
  const checked = useUpdates((s) => s.lastCheckedAt);
  const auto = useUpdates((s) => s.auto);
  const fmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );
  const busy = status === 'checking' || status === 'downloading';

  return (
    <section aria-labelledby="updates-title" className="space-y-3">
      <h3 id="updates-title" className="font-medium">
        {t('updates.title')}
      </h3>
      {status === 'unavailable' ? (
        <p className="rounded-lg bg-surface p-3 text-muted">{t('updates.unavailable')}</p>
      ) : (
        <>
          <SettingRow
            title={t('updates.version', { version: version ?? '—' })}
            {...(checked
              ? { description: t('updates.checkedAt', { date: fmt.format(new Date(checked)) }) }
              : {})}
          >
            <Button disabled={busy} onClick={() => void store.getState().check()}>
              {t('updates.check')}
            </Button>
          </SettingRow>
          <p role="status" className="rounded-lg bg-surface p-3">
            {status === 'checking'
              ? t('updates.checking')
              : status === 'upToDate'
                ? t('updates.upToDate')
                : status === 'available' && info
                  ? t('updates.available', { version: info.version })
                  : status === 'downloading'
                    ? progress === null
                      ? t('updates.downloading')
                      : t('updates.downloadingPct', { pct: Math.round(progress * 100) })
                    : status === 'error'
                      ? t('updates.error')
                      : t('updates.idle')}
          </p>
          {status === 'available' && info ? (
            <div className="space-y-2">
              {info.notes ? (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-3 text-xs">
                  {info.notes}
                </pre>
              ) : null}
              <Button variant="primary" onClick={() => void store.getState().install()}>
                {t('updates.install')}
              </Button>
              <p className="text-xs text-muted">{t('updates.installHint')}</p>
            </div>
          ) : null}
          {status === 'downloading' ? (
            <progress
              className="w-full"
              aria-label={t('updates.downloading')}
              {...(progress === null ? {} : { value: progress, max: 1 })}
            />
          ) : null}
          <SettingRow title={t('updates.auto')} description={t('updates.autoHint')}>
            <Switch
              checked={auto}
              label={t('updates.auto')}
              onCheckedChange={(v) => void store.getState().setAuto(v)}
            />
          </SettingRow>
        </>
      )}
    </section>
  );
}
