import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../shared/ui';
import { useSecurity, useSecurityStore } from './context';
import { LockScreen } from './LockScreen';
import { useIdleLock } from './useIdleLock';

/** Ne montre l'application que déverrouillée. L'état « verrouillé » vient du cœur natif (source de vérité). */
export function LockGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const store = useSecurityStore();
  const status = useSecurity((s) => s.status);
  const locked = useSecurity((s) => s.lock?.locked === true);
  useEffect(() => {
    void store.getState().refresh();
  }, [store]);
  useIdleLock();

  if (status === 'loading')
    return (
      <div role="status" className="sr-only">
        {t('security.checking')}
      </div>
    );
  if (status === 'error') {
    return (
      <div role="alert" className="grid h-full place-items-center p-8 text-center">
        <div className="space-y-3">
          <p>{t('security.statusFailed')}</p>
          <Button onClick={() => void store.getState().refresh()}>{t('system.retry')}</Button>
        </div>
      </div>
    );
  }
  return locked ? <LockScreen /> : <>{children}</>;
}
