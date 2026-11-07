import { Icon } from '@slate/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Logo } from '../shell/Logo';
import { Button } from '../../shared/ui';
import type { SlateError } from '../../shared/ipc/errors';
import { useSecurity, useSecurityStore } from './context';

/** Écran de verrouillage plein écran. Le cœur natif refuse déjà toute donnée : ceci n'est que la porte d'entrée. */
export function LockScreen() {
  const { t } = useTranslation();
  const store = useSecurityStore();
  const retryAfter = useSecurity((s) => s.lock?.retryAfterMs ?? 0);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<SlateError | null>(null);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(retryAfter);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);
  // Décompte du blocage progressif (réaffiché à partir du temps restant côté natif).
  useEffect(() => {
    const until = Date.now() + retryAfter;
    setRemaining(retryAfter);
    if (retryAfter <= 0) return;
    const h = setInterval(() => {
      const left = until - Date.now();
      setRemaining(Math.max(0, left));
      if (left <= 0) clearInterval(h);
    }, 250);
    return () => clearInterval(h);
  }, [retryAfter]);

  const blocked = remaining > 0;
  const submit = async () => {
    if (blocked || busy || pin.length < 4) return;
    setBusy(true);
    const err = await store.getState().unlock(pin);
    setBusy(false);
    setPin('');
    setError(err);
    if (err) input.current?.focus();
  };

  const seconds = Math.ceil(remaining / 1000);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lock-title"
      className="fixed inset-0 z-[100] grid place-items-center bg-bg p-6"
    >
      <form
        className="anim-fade flex w-full max-w-xs flex-col items-center gap-5 text-center"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <span className="grid size-14 place-items-center rounded-2xl bg-surface">
          <Logo size={30} />
        </span>
        <div>
          <h1 id="lock-title" className="text-lg font-semibold">
            {t('security.lockedTitle')}
          </h1>
          <p className="text-muted">{t('security.lockedHint')}</p>
        </div>
        <input
          ref={input}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          aria-label={t('security.pin')}
          aria-invalid={error !== null}
          aria-describedby="lock-msg"
          disabled={blocked}
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, '').slice(0, 6));
            setError(null);
          }}
          className="h-12 w-full select-text rounded-xl border border-line bg-surface text-center text-2xl tracking-[0.6em] outline-none focus-visible:border-accent disabled:opacity-50"
        />
        <p id="lock-msg" role="alert" className="min-h-6 text-danger">
          {blocked
            ? t('security.blocked', { seconds })
            : error?.code === 'pin.invalid'
              ? t('security.wrongPin', { count: Math.max(0, 5 - (error.failedCount ?? 0)) })
              : error
                ? t(error.messageKey)
                : ''}
        </p>
        <Button
          variant="primary"
          type="submit"
          disabled={blocked || busy || pin.length < 4}
          icon="unlock"
          className="w-full justify-center"
        >
          {t('security.unlock')}
        </Button>
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Icon name="lock" size={12} />
          {t('security.localNote')}
        </p>
      </form>
    </div>
  );
}
