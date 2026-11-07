import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, SettingRow, Switch, toast } from '../../shared/ui';
import type { SlateError } from '../../shared/ipc/errors';
import { useSecurity, useSecurityStore } from './context';
import { PinPrompt } from './PinPrompt';

const IDLE_CHOICES = [0, 1, 5, 15, 30, 60];
const field =
  'h-9 w-44 select-text rounded-md border border-line bg-surface px-3 text-center tracking-[0.4em] outline-none focus-visible:border-accent';

function PinField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
}) {
  return (
    <input
      type="password"
      inputMode="numeric"
      autoComplete="off"
      maxLength={6}
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      className={field}
    />
  );
}

/** Paramètres du verrouillage local. Le PIN protège l'accès à l'application ; il ne chiffre pas le fichier de données. */
export function SecurityTab() {
  const { t } = useTranslation();
  const store = useSecurityStore();
  const lock = useSecurity((s) => s.lock);
  const [mode, setMode] = useState<'idle' | 'enable' | 'change'>('idle');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<SlateError | null>(null);
  const [prompt, setPrompt] = useState<null | {
    title: string;
    run(pin: string): Promise<SlateError | null>;
  }>(null);
  if (!lock) return null;

  const validFormat = (p: string) => p.length === 4 || p.length === 6;
  const canSubmit =
    validFormat(next) && next === confirm && (mode === 'enable' || validFormat(current));
  const reset = () => {
    setMode('idle');
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
  };
  const submit = async () => {
    const err = await store.getState().setPin(next, mode === 'change' ? current : null);
    setError(err);
    if (!err) {
      toast.success(mode === 'enable' ? t('security.enabledToast') : t('security.changedToast'));
      reset();
    }
  };

  return (
    <section aria-labelledby="tab-security">
      <h2 id="tab-security" className="sr-only">
        {t('settings.tabs.security')}
      </h2>
      <p className="pb-3 text-muted">{t('security.intro')}</p>

      {!lock.enabled && mode === 'idle' ? (
        <SettingRow title={t('security.pinTitle')} description={t('security.pinOffHint')}>
          <Button variant="primary" icon="lock" onClick={() => setMode('enable')}>
            {t('security.enable')}
          </Button>
        </SettingRow>
      ) : null}

      {mode !== 'idle' ? (
        <form
          className="space-y-3 rounded-lg bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          <h3 className="font-medium">
            {mode === 'enable' ? t('security.enable') : t('security.change')}
          </h3>
          {mode === 'change' ? (
            <PinField label={t('security.currentPin')} value={current} onChange={setCurrent} />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <PinField label={t('security.newPin')} value={next} onChange={setNext} />
            <PinField label={t('security.confirmPin')} value={confirm} onChange={setConfirm} />
          </div>
          <p className="text-xs text-muted">{t('security.format')}</p>
          {confirm !== '' && next !== confirm ? (
            <p role="alert" className="text-danger">
              {t('security.mismatch')}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-danger">
              {error.code === 'pin.locked'
                ? t('security.blocked', { seconds: Math.ceil((error.retryAfterMs ?? 0) / 1000) })
                : error.code === 'pin.invalid'
                  ? t('security.wrongPin', { count: Math.max(0, 5 - (error.failedCount ?? 0)) })
                  : t(error.messageKey)}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button onClick={reset}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" disabled={!canSubmit}>
              {t('common.apply')}
            </Button>
          </div>
        </form>
      ) : null}

      {lock.enabled && mode === 'idle' ? (
        <>
          <SettingRow title={t('security.lockNow')} description={t('security.lockNowHint')}>
            <Button icon="lock" onClick={() => void store.getState().lockNow()}>
              {t('security.lockNowAction')}
            </Button>
          </SettingRow>
          <SettingRow title={t('security.onStart')} description={t('security.onStartHint')}>
            <Switch
              label={t('security.onStart')}
              checked={lock.lockOnStart}
              onCheckedChange={(v) =>
                setPrompt({
                  title: t('security.confirmChange'),
                  run: (pin) => store.getState().setOptions(pin, v, lock.idleMinutes),
                })
              }
            />
          </SettingRow>
          <SettingRow title={t('security.idle')} description={t('security.idleHint')}>
            <select
              aria-label={t('security.idle')}
              className="h-9 rounded-md border border-line bg-surface px-2"
              value={lock.idleMinutes}
              onChange={(e) => {
                const v = Number(e.target.value);
                setPrompt({
                  title: t('security.confirmChange'),
                  run: (pin) => store.getState().setOptions(pin, lock.lockOnStart, v),
                });
              }}
            >
              {IDLE_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? t('security.idleNever') : t('security.idleMinutes', { count: m })}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title={t('security.change')} description={t('security.changeHint')}>
            <Button onClick={() => setMode('change')}>{t('security.change')}</Button>
          </SettingRow>
          <SettingRow title={t('security.disable')} description={t('security.disableHint')}>
            <Button
              variant="danger"
              onClick={() =>
                setPrompt({
                  title: t('security.disable'),
                  run: (pin) => store.getState().disablePin(pin),
                })
              }
            >
              {t('security.disable')}
            </Button>
          </SettingRow>
        </>
      ) : null}

      <p className="mt-4 rounded-lg bg-surface p-3 text-xs text-muted">{t('security.limits')}</p>

      <PinPrompt
        key={prompt?.title ?? 'none'}
        open={prompt !== null}
        title={prompt?.title ?? ''}
        description={t('security.confirmHint')}
        onClose={() => setPrompt(null)}
        onSubmit={async (pin) => (prompt ? prompt.run(pin) : null)}
      />
    </section>
  );
}
