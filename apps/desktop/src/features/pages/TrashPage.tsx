import { Icon } from '@slate/icons';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, EmptyState } from '../../shared/ui';
import type { NodeRow } from '../../shared/ipc/client';
import { usePages, usePagesStore } from './context';
import { displayTitle } from './model';

type Confirm = { kind: 'one'; node: NodeRow } | { kind: 'all' } | null;

export function TrashPage() {
  const { t, i18n } = useTranslation();
  const store = usePagesStore();
  const trash = usePages((s) => s.trash);
  const [confirm, setConfirm] = useState<Confirm>(null);
  useEffect(() => {
    void store.getState().loadTrash();
  }, [store]);

  const fmt = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(iso),
        )
      : '';

  return (
    <div className="mx-auto max-w-2xl px-8 py-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-muted">{t('trash.hint')}</p>
        {trash.length > 0 ? (
          <Button variant="danger" onClick={() => setConfirm({ kind: 'all' })}>
            {t('trash.empty')}
          </Button>
        ) : null}
      </div>
      {trash.length === 0 ? (
        <div className="py-16">
          <EmptyState
            icon="trash"
            title={t('trash.emptyTitle')}
            description={t('trash.emptyDescription')}
          />
        </div>
      ) : (
        <ul>
          {trash.map((n) => (
            <li
              key={n.id}
              className="flex items-center gap-3 border-b border-line py-2 last:border-0"
            >
              <Icon
                name={n.kind === 'folder' ? 'folder' : n.kind === 'database' ? 'grid' : 'paper'}
                size={16}
                className="text-muted"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate">{displayTitle(n, t('pages.untitled'))}</div>
                <div className="text-xs text-muted">
                  {t('trash.deletedOn', { date: fmt(n.deletedAt) })}
                </div>
              </div>
              <Button onClick={() => void store.getState().restore(n.id)}>
                {t('trash.restore')}
              </Button>
              <Button variant="danger" onClick={() => setConfirm({ kind: 'one', node: n })}>
                {t('trash.deleteForever')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.kind === 'all' ? t('trash.confirmAllTitle') : t('trash.confirmTitle')}
        description={confirm?.kind === 'all' ? t('trash.confirmAllBody') : t('trash.confirmBody')}
      >
        <div className="flex justify-end gap-2 p-5">
          <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            onClick={() => {
              const c = confirm;
              setConfirm(null);
              if (c?.kind === 'one') void store.getState().purge(c.node.id);
              else if (c?.kind === 'all') void store.getState().emptyTrash();
            }}
          >
            {t('trash.deleteForever')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
