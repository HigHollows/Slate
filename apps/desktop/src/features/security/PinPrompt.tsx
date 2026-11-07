import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog } from '../../shared/ui';
import type { SlateError } from '../../shared/ipc/errors';

/** Demande le PIN actuel avant une action sensible. `onSubmit` retourne l'erreur éventuelle (le dialogue reste ouvert). */
export function PinPrompt({
  open,
  title,
  description,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose(): void;
  onSubmit(pin: string): Promise<SlateError | null>;
}) {
  const { t } = useTranslation();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<SlateError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const err = await onSubmit(pin);
    setBusy(false);
    setPin('');
    setError(err);
    if (!err) onClose();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setPin('');
          setError(null);
          onClose();
        }
      }}
      title={title}
      {...(description ? { description } : {})}
    >
      <form
        className="space-y-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (pin.length >= 4) void submit();
        }}
      >
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          aria-label={t('security.currentPin')}
          aria-invalid={error !== null}
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, '').slice(0, 6));
            setError(null);
          }}
          className="h-10 w-full select-text rounded-md border border-line bg-surface px-3 text-center tracking-[0.5em] outline-none focus-visible:border-accent"
        />
        {error ? (
          <p role="alert" className="text-danger">
            {error.code === 'pin.locked'
              ? t('security.blocked', { seconds: Math.ceil((error.retryAfterMs ?? 0) / 1000) })
              : error.code === 'pin.invalid'
                ? t('security.wrongPin', { count: Math.max(0, 5 - (error.failedCount ?? 0)) })
                : t(error.messageKey)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={pin.length < 4 || busy}>
            {t('common.apply')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
