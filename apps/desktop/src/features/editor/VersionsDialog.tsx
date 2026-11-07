import type { Editor } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccount } from '../account';
import { Button, Dialog, cx, toast } from '../../shared/ui';
import type { Ipc, VersionMeta } from '../../shared/ipc/client';
import { toSlateError } from '../../shared/ipc/errors';
import { flushAll } from '../../shared/save-manager';
import { diffLines, diffSummary } from './diff';

export type VersionsApi = Pick<
  Ipc,
  'versionCreate' | 'versionList' | 'versionGet' | 'versionRename' | 'versionDelete'
>;

/** Historique des versions d'une page : liste, enregistrement manuel, comparaison avec la version actuelle, restauration. */
export function VersionsDialog({
  nodeId,
  editor,
  api,
  open,
  onOpenChange,
}: {
  nodeId: string;
  editor: Editor | null;
  api: VersionsApi;
  open: boolean;
  onOpenChange(o: boolean): void;
}) {
  const { t, i18n } = useTranslation();
  const author = useAccount((s) => s.email);
  const [list, setList] = useState<VersionMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [selected, setSelected] = useState<{
    meta: VersionMeta;
    text: string;
    json: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const fmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );

  const run = useCallback(
    async <T,>(f: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await f();
      } catch (e) {
        setError(t(toSlateError(e).messageKey));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );
  const reload = useCallback(async () => {
    const v = await run(() => api.versionList(nodeId));
    if (v) setList(v);
  }, [api, nodeId, run]);

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setLabel('');
    void (async () => {
      await flushAll().catch(() => undefined); // l'historique reflète ce qui est affiché
      await reload();
    })();
  }, [open, reload]);

  const select = async (m: VersionMeta) => {
    const d = await run(() => api.versionGet(m.id));
    if (d) setSelected({ meta: m, text: d.textPlain, json: d.contentJson });
  };
  const save = async () => {
    await run(async () => {
      await flushAll();
      await api.versionCreate(nodeId, 'manual', label.trim() || null, author);
    });
    setLabel('');
    await reload();
  };
  const restore = async () => {
    if (!selected || !editor) return;
    const ok = await run(async () => {
      await flushAll();
      // 1) l'état actuel est sauvegardé AVANT toute modification : si cela échoue, rien n'est restauré.
      await api.versionCreate(nodeId, 'restore', t('versions.beforeRestore'), author);
      // 2) l'ancien contenu est appliqué comme une modification ordinaire (annulable avec Annuler).
      editor.commands.setContent(JSON.parse(selected.json) as object);
      return true;
    });
    if (ok) {
      toast.success(t('versions.restored'));
      onOpenChange(false);
    }
  };
  const remove = async (m: VersionMeta) => {
    await run(() => api.versionDelete(m.id));
    if (selected?.meta.id === m.id) setSelected(null);
    await reload();
  };

  // L'éditeur peut être détruit pendant un changement de page : on ne le lit que dialogue ouvert, version choisie, éditeur vivant.
  const current =
    open && selected && editor && !editor.isDestroyed
      ? editor.getText({ blockSeparator: '\n' })
      : '';
  const ops = open && selected ? diffLines(selected.text, current) : null;
  const sum = ops ? diffSummary(ops) : null;
  const reasonLabel = (m: VersionMeta) => t(`versions.reason.${m.reason}`);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('versions.title')}
      description={t('versions.description')}
    >
      <div className="space-y-3 p-5">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            aria-label={t('versions.nameLabel')}
            placeholder={t('versions.namePlaceholder')}
            maxLength={200}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="h-9 min-w-0 flex-1 select-text rounded-md border border-line bg-surface px-3 outline-none focus-visible:border-accent"
          />
          <Button variant="primary" type="submit" disabled={busy}>
            {t('versions.save')}
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
        <div className="grid max-h-[55vh] gap-3 overflow-hidden md:grid-cols-[16rem_1fr]">
          <ul aria-label={t('versions.list')} className="space-y-1 overflow-y-auto pr-1">
            {list === null ? (
              <li role="status" className="text-muted">
                {t('editor.loading')}
              </li>
            ) : list.length === 0 ? (
              <li className="text-muted">{t('versions.empty')}</li>
            ) : (
              list.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    aria-pressed={selected?.meta.id === m.id}
                    onClick={() => void select(m)}
                    className={cx(
                      'w-full rounded-md px-2 py-1.5 text-left hover:bg-hover',
                      selected?.meta.id === m.id && 'bg-pressed',
                    )}
                  >
                    <span className="block font-medium">
                      {m.label ?? fmt.format(new Date(m.createdAt))}
                    </span>
                    <span className="block text-xs text-muted">
                      {m.label ? `${fmt.format(new Date(m.createdAt))} · ` : ''}
                      {reasonLabel(m)} · {t('versions.words', { count: m.words })}
                      {m.author ? ` · ${m.author}` : ''}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
          <section
            aria-label={t('versions.compare')}
            className="min-w-0 overflow-y-auto rounded-md bg-surface p-3"
          >
            {!selected ? (
              <p className="text-muted">{t('versions.pick')}</p>
            ) : ops === null ? (
              <p role="status" className="text-muted">
                {t('versions.tooLarge')}
              </p>
            ) : (
              <>
                <p className="mb-2 text-xs text-muted" role="status">
                  {sum && sum.added + sum.removed === 0
                    ? t('versions.identical')
                    : t('versions.summary', { added: sum?.added, removed: sum?.removed })}
                </p>
                <ol className="space-y-px font-mono text-xs">
                  {ops.map((o, i) => (
                    <li
                      key={i}
                      className={cx(
                        'whitespace-pre-wrap break-words rounded px-1',
                        o.kind === 'add' && 'bg-[var(--doc-highlight-green)] text-[var(--fg)]',
                        o.kind === 'del' &&
                          'bg-[var(--doc-highlight-pink)] text-[var(--fg)] line-through',
                      )}
                    >
                      <span aria-hidden className="mr-1 select-none">
                        {o.kind === 'add' ? '+' : o.kind === 'del' ? '−' : ' '}
                      </span>
                      <span className="sr-only">{t(`versions.diff.${o.kind}`)}</span>
                      {o.text || ' '}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        </div>
        <div className="flex justify-between gap-2">
          <Button
            disabled={!selected || busy}
            onClick={() => selected && void remove(selected.meta)}
          >
            {t('versions.delete')}
          </Button>
          <div className="flex gap-2">
            <Button onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
            <Button
              variant="primary"
              disabled={!selected || busy || !editor || editor.isDestroyed || !editor.isEditable}
              onClick={() => void restore()}
            >
              {t('versions.restore')}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
