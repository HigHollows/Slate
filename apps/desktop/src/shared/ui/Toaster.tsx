import { Icon } from '@slate/icons';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useToasts, type Toast } from './toast';

function Item({ t }: { t: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const { t: tr } = useTranslation();
  useEffect(() => {
    if (t.kind === 'error') return; // une erreur reste jusqu'à fermeture explicite
    const h = setTimeout(() => dismiss(t.id), 4500);
    return () => clearTimeout(h);
  }, [t, dismiss]);
  return (
    <div
      role={t.kind === 'error' ? 'alert' : 'status'}
      className="anim-pop flex items-start gap-2 rounded-lg bg-elevated px-3 py-2 shadow-pop"
    >
      <Icon
        name={t.kind === 'error' ? 'alert-circle' : t.kind === 'success' ? 'check' : 'info'}
        size={16}
        className={t.kind === 'error' ? 'mt-0.5 text-danger' : 'mt-0.5 text-muted'}
      />
      <p className="flex-1">{t.message}</p>
      {t.action ? (
        <button
          type="button"
          onClick={() => {
            t.action?.run();
            dismiss(t.id);
          }}
          className="rounded px-1.5 font-medium text-fg underline underline-offset-2 hover:bg-hover"
        >
          {t.action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={tr('common.close')}
        onClick={() => dismiss(t.id)}
        className="rounded p-0.5 text-muted hover:text-fg"
      >
        <Icon name="cross" size={14} />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2 [&>*]:pointer-events-auto">
      {toasts.map((t) => (
        <Item key={t.id} t={t} />
      ))}
    </div>
  );
}
