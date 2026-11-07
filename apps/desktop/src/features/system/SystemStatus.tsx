import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Ipc, SystemInfo } from '../../shared/ipc/client';
import { SlateError, toSlateError } from '../../shared/ipc/errors';
import type { AppConfig } from '../../shared/config/env';

interface Props {
  ipc: Pick<Ipc, 'systemInfo'>;
  config: AppConfig;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; info: SystemInfo }
  | { status: 'error'; error: SlateError };

export function SystemStatus({ ipc, config }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(() => {
    setState({ status: 'loading' });
    ipc.systemInfo().then(
      (info) => setState({ status: 'ready', info }),
      (e: unknown) => setState({ status: 'error', error: toSlateError(e) }),
    );
  }, [ipc]);

  useEffect(load, [load]);

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-[var(--muted)]">
        {t('system.loading')}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div role="alert" className="space-y-3">
        <p>{t(state.error.messageKey)}</p>
        {state.error.detail ? (
          <p className="text-sm text-[var(--muted)]">{state.error.detail}</p>
        ) : null}
        {state.error.retryable ? (
          <button
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={load}
          >
            {t('system.retry')}
          </button>
        ) : null}
      </div>
    );
  }
  const { info } = state;
  const rows: [string, string][] = [
    [t('system.version'), info.appVersion],
    [t('system.schema'), String(info.schemaVersion)],
    [t('system.device'), info.deviceId],
    [t('system.dbPath'), info.dbPath],
    [t('system.integrity'), info.integrityOk ? t('system.integrityOk') : t('system.integrityKo')],
    [
      t('system.mode'),
      config.cloudEnabled ? t('system.modeCloudConfigured') : t('system.modeGuest'),
    ],
  ];
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--muted)]">{k}</dt>
          <dd className="select-text break-all font-mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
