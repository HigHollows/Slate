import { Icon } from '@slate/icons';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccount } from '../account';
import { usePages } from '../pages';
import { bus } from '../../shared/bus';
import { Button, cx, toast } from '../../shared/ui';
import type { CommentThread, Ipc, ThreadComment } from '../../shared/ipc/client';
import { toSlateError } from '../../shared/ipc/errors';
import { anchoredThreadIds, commentRange, isThreadId } from './CommentAnchor';

export type CommentsApi = Pick<
  Ipc,
  | 'threadCreate'
  | 'threadList'
  | 'commentAdd'
  | 'commentEdit'
  | 'commentDelete'
  | 'threadResolve'
  | 'threadDelete'
>;
export interface Draft {
  from: number;
  to: number;
  quote: string;
}

const area =
  'w-full select-text resize-y rounded-md border border-line bg-surface p-2 outline-none focus-visible:border-accent';

/** Panneau des commentaires d'une page : nouveau fil, réponses, résolution, modification, suppression. */
export function CommentsPanel({
  nodeId,
  editor,
  api,
  draft,
  onDraftDone,
  activeId,
  onActive,
  onClose,
}: {
  nodeId: string;
  editor: Editor;
  api: CommentsApi;
  draft: Draft | null;
  onDraftDone(): void;
  activeId: string | null;
  onActive(id: string | null): void;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const author = useAccount((s) => s.email);
  const role = usePages((s) => s.role);
  // Modifier ou supprimer le message d'un AUTRE : réservé aux administrateurs (le serveur refuse de toute façon).
  const mine = (who: string | null) =>
    who === null || author === null || who.toLowerCase() === author.toLowerCase();
  const canTouch = (who: string | null) => mine(who) || role === 'admin';
  const [threads, setThreads] = useState<CommentThread[] | null>(null);
  const [filter, setFilter] = useState<'open' | 'resolved'>('open');
  const [text, setText] = useState('');
  const [reply, setReply] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );
  const anchored = useEditorState({
    editor,
    selector: ({ editor: e }) => [...anchoredThreadIds(e.state.doc)].sort().join(','),
  });
  const editable = useEditorState({ editor, selector: ({ editor: e }) => e.isEditable });

  const guard = useCallback(
    async <T,>(f: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      try {
        return await f();
      } catch (e) {
        toast.error(t(toSlateError(e).messageKey));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );
  const reload = useCallback(async () => {
    const l = await guard(() => api.threadList(nodeId));
    if (l) setThreads(l);
  }, [api, nodeId, guard]);
  useEffect(() => void reload(), [reload]);
  // Des commentaires distants viennent d'arriver : on relit la liste.
  useEffect(() => bus.on('sync-applied', () => void reload()), [reload]);

  // Les surlignages du document reflètent l'état (résolu, actif).
  useEffect(() => {
    editor.commands.setCommentUi({
      resolved: (threads ?? []).filter((x) => x.resolvedAt).map((x) => x.id),
      active: activeId,
    });
  }, [editor, threads, activeId]);

  const patch = (t2: CommentThread) =>
    setThreads((cur) => (cur ?? []).map((x) => (x.id === t2.id ? t2 : x)));

  const createThread = async () => {
    if (!draft || !text.trim()) return;
    // L'ancrage ne doit viser que le texte réellement sélectionné : si le document a changé, on refuse.
    if (editor.state.doc.textBetween(draft.from, draft.to, '\n') !== draft.quote) {
      toast.error(t('comments.selectionChanged'));
      return;
    }
    const id = crypto.randomUUID();
    const created = await guard(() => api.threadCreate(id, nodeId, draft.quote, text, author));
    if (!created) return;
    const ok = editor
      .chain()
      .setTextSelection({ from: draft.from, to: draft.to })
      .setCommentThread(id)
      .run();
    if (!ok) {
      await guard(() => api.threadDelete(id)); // pas de fil sans ancrage
      toast.error(t('comments.anchorFailed'));
      return;
    }
    setText('');
    onDraftDone();
    onActive(id);
    setThreads((cur) => [...(cur ?? []), created]);
  };
  const addReply = async (th: CommentThread) => {
    const body = reply[th.id]?.trim();
    if (!body) return;
    const c = await guard(() => api.commentAdd(th.id, body, author));
    if (c) {
      setReply((r) => ({ ...r, [th.id]: '' }));
      patch({ ...th, comments: [...th.comments, c] });
    }
  };
  const saveEdit = async (th: CommentThread, c: ThreadComment) => {
    if (!editing || !editing.text.trim()) return;
    const upd = await guard(() => api.commentEdit(c.id, editing.text));
    if (upd) {
      patch({ ...th, comments: th.comments.map((x) => (x.id === c.id ? upd : x)) });
      setEditing(null);
    }
  };
  const removeComment = async (th: CommentThread, c: ThreadComment) => {
    const threadGone = await guard(() => api.commentDelete(c.id));
    if (threadGone === undefined) return;
    if (threadGone) {
      editor.commands.removeCommentThread(th.id);
      setThreads((cur) => (cur ?? []).filter((x) => x.id !== th.id));
      if (activeId === th.id) onActive(null);
    } else patch({ ...th, comments: th.comments.filter((x) => x.id !== c.id) });
  };
  const toggleResolved = async (th: CommentThread) => {
    const upd = await guard(() => api.threadResolve(th.id, !th.resolvedAt, author));
    if (upd) patch(upd);
  };
  const removeThread = async (th: CommentThread) => {
    const ok = await guard(async () => {
      await api.threadDelete(th.id);
      return true;
    });
    if (!ok) return;
    editor.commands.removeCommentThread(th.id);
    setThreads((cur) => (cur ?? []).filter((x) => x.id !== th.id));
    if (activeId === th.id) onActive(null);
  };
  const goTo = (th: CommentThread) => {
    onActive(th.id);
    const r = commentRange(editor.state.doc, th.id);
    if (r) editor.chain().setTextSelection(r).scrollIntoView().run();
  };

  const anchoredSet = new Set(anchored.split(',').filter(Boolean));
  const shown = (threads ?? []).filter((x) =>
    filter === 'open' ? !x.resolvedAt : Boolean(x.resolvedAt),
  );
  const openCount = (threads ?? []).filter((x) => !x.resolvedAt).length;

  return (
    <aside
      aria-label={t('comments.title')}
      className="fixed bottom-0 right-0 top-11 z-20 flex w-80 flex-col border-l border-line bg-bg shadow-pop"
    >
      <div className="flex items-center gap-2 border-b border-line p-3">
        <h2 className="flex-1 font-medium">{t('comments.title')}</h2>
        <button
          type="button"
          aria-label={t('comments.close')}
          title={t('comments.close')}
          onClick={onClose}
          className="grid size-7 place-items-center rounded-md hover:bg-hover"
        >
          <Icon name="cross" size={14} />
        </button>
      </div>

      {draft ? (
        <form
          className="space-y-2 border-b border-line p-3"
          aria-label={t('comments.new')}
          onSubmit={(e) => {
            e.preventDefault();
            void createThread();
          }}
        >
          <p className="line-clamp-3 border-l-2 border-line pl-2 text-xs text-muted">
            {draft.quote}
          </p>
          <textarea
            autoFocus
            aria-label={t('comments.body')}
            placeholder={t('comments.placeholder')}
            rows={3}
            maxLength={5000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={area}
          />
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setText('');
                onDraftDone();
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button variant="primary" type="submit" disabled={busy || !text.trim()}>
              {t('comments.send')}
            </Button>
          </div>
        </form>
      ) : null}

      <div role="group" aria-label={t('comments.filter')} className="flex gap-1 p-2">
        {(['open', 'resolved'] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cx(
              'h-7 rounded-md px-2 text-[0.8125rem] hover:bg-hover',
              filter === f && 'bg-accent text-accent-fg hover:bg-accent',
            )}
          >
            {t(`comments.filters.${f}`, {
              count: f === 'open' ? openCount : (threads ?? []).length - openCount,
            })}
          </button>
        ))}
      </div>

      <ul
        aria-label={t('comments.list')}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 pt-1"
      >
        {threads === null ? (
          <li role="status" className="text-muted">
            {t('editor.loading')}
          </li>
        ) : shown.length === 0 ? (
          <li className="text-muted">
            {filter === 'open' ? t('comments.emptyOpen') : t('comments.emptyResolved')}
          </li>
        ) : (
          shown.map((th) => {
            const orphan = !anchoredSet.has(th.id) && isThreadId(th.id);
            return (
              <li
                key={th.id}
                aria-label={t('comments.thread', { quote: th.quote })}
                className={cx(
                  'space-y-2 rounded-lg bg-surface p-2.5',
                  activeId === th.id && 'ring-2 ring-[var(--fg)]',
                )}
              >
                <button
                  type="button"
                  onClick={() => goTo(th)}
                  disabled={orphan}
                  className="block w-full text-left"
                >
                  <span className="line-clamp-2 border-l-2 border-line pl-2 text-xs text-muted">
                    {th.quote}
                  </span>
                </button>
                {orphan ? <p className="text-xs text-danger">{t('comments.orphan')}</p> : null}
                <ul className="space-y-2">
                  {th.comments.map((c) => (
                    <li key={c.id} className="text-[0.8125rem]">
                      <p className="text-xs text-muted">
                        {c.author ?? t('comments.you')} · {fmt.format(new Date(c.createdAt))}
                        {c.editedAt ? ` · ${t('comments.edited')}` : ''}
                      </p>
                      {editing?.id === c.id ? (
                        <div className="space-y-1">
                          <textarea
                            aria-label={t('comments.body')}
                            rows={3}
                            maxLength={5000}
                            value={editing.text}
                            onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
                            className={area}
                          />
                          <div className="flex justify-end gap-1">
                            <Button onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
                            <Button
                              variant="primary"
                              disabled={busy || !editing.text.trim()}
                              onClick={() => void saveEdit(th, c)}
                            >
                              {t('common.apply')}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap break-words">{c.body}</p>
                      )}
                      {editing?.id !== c.id && canTouch(c.author) ? (
                        <div className="mt-0.5 flex gap-2 text-xs text-muted">
                          <button
                            type="button"
                            className="underline underline-offset-2 hover:text-fg"
                            onClick={() => setEditing({ id: c.id, text: c.body })}
                          >
                            {t('comments.edit')}
                          </button>
                          <button
                            type="button"
                            className="underline underline-offset-2 hover:text-fg"
                            onClick={() => void removeComment(th, c)}
                          >
                            {t('comments.delete')}
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <div className="space-y-1">
                  <textarea
                    aria-label={t('comments.replyTo', { quote: th.quote })}
                    placeholder={t('comments.reply')}
                    rows={2}
                    maxLength={5000}
                    value={reply[th.id] ?? ''}
                    onChange={(e) => setReply((r) => ({ ...r, [th.id]: e.target.value }))}
                    className={area}
                  />
                  <div className="flex justify-between gap-1">
                    <Button onClick={() => void toggleResolved(th)} disabled={busy}>
                      {th.resolvedAt ? t('comments.reopen') : t('comments.resolve')}
                    </Button>
                    <div className="flex gap-1">
                      {canTouch(th.createdBy) ? (
                        <Button onClick={() => void removeThread(th)} disabled={busy}>
                          {t('comments.deleteThread')}
                        </Button>
                      ) : null}
                      <Button
                        variant="primary"
                        onClick={() => void addReply(th)}
                        disabled={busy || !(reply[th.id] ?? '').trim()}
                      >
                        {t('comments.send')}
                      </Button>
                    </div>
                  </div>
                  {th.resolvedAt ? (
                    <p className="text-xs text-muted">
                      {t('comments.resolvedBy', {
                        who: th.resolvedBy ?? t('comments.you'),
                        date: fmt.format(new Date(th.resolvedAt)),
                      })}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })
        )}
      </ul>
      {!editable ? (
        <p className="border-t border-line p-2 text-xs text-muted">{t('comments.readOnly')}</p>
      ) : null}
    </aside>
  );
}
