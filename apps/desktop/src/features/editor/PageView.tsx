import { Icon } from '@slate/icons';
import type { Editor } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNav } from '../navigation';
import { ancestors, displayTitle, usePages, usePagesStore } from '../pages';
import { RowProperties } from '../databases';
import { Button, EmptyState, IconButton, Menu, cx, toast } from '../../shared/ui';
import type { NodeRow } from '../../shared/ipc/client';
import { toSlateError } from '../../shared/ipc/errors';
import { FIND_EVENT } from './FindBar';
import { LINK_OPEN_EVENT } from './LinkOpen';
import { internalPageId, isExternalHref } from './link';
import { COMMENT_NEW_EVENT, COMMENT_OPEN_EVENT } from './CommentAnchor';
import { CommentsPanel, type Draft } from './CommentsPanel';
import { WIDTH_CLASS, useWritingMode } from './writingMode';
import { usePreferences, usePreferencesStore } from '../preferences';
import { VersionsDialog } from './VersionsDialog';
import { PageEditor, type EditorApi } from './PageEditor';
import { PresenceBar } from './presence';
import type { Awareness } from 'y-protocols/awareness';
import { SaveManager, registerManager, type SaveStatus } from '../../shared/save-manager';

function StatusBadge({ status, retry }: { status: SaveStatus; retry(): void }) {
  const { t } = useTranslation();
  const label = {
    saved: t('editor.saved'),
    dirty: t('editor.unsaved'),
    saving: t('editor.saving'),
    error: t('editor.saveFailed'),
  }[status];
  return (
    <span
      role="status"
      className={cx(
        'flex items-center gap-2 text-xs',
        status === 'error' ? 'text-danger' : 'text-muted',
      )}
    >
      {status === 'error' ? <Icon name="alert-circle" size={13} /> : null}
      {label}
      {status === 'error' ? (
        <button type="button" onClick={retry} className="font-medium underline underline-offset-2">
          {t('editor.retry')}
        </button>
      ) : null}
    </span>
  );
}

export function PageView({ id, api }: { id: string; api: EditorApi }) {
  const { t } = useTranslation();
  const store = usePagesStore();
  const treeNode = usePages((s) => s.nodes.find((n) => n.id === id));
  // Une ligne de base de données est une page absente de l'arbre : on la charge à la demande.
  const [extra, setExtra] = useState<{ node: NodeRow; databaseId: string | null } | null>(null);
  useEffect(() => {
    setExtra(null);
    if (treeNode) return;
    let cancelled = false;
    api.nodeGet(id).then(
      (r) => !cancelled && setExtra(r),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, id, treeNode]);
  const node = treeNode ?? extra?.node;
  const rowDatabaseId = extra?.databaseId ?? null;
  const status = usePages((s) => s.status);
  const nodes = usePages((s) => s.nodes);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const retryRef = useRef<() => void>(() => undefined);
  const [editor, setEditor] = useState<Editor | null>(null);
  // Un éditeur détruit (changement de page, double montage) n'a plus de schéma : aucun composant ne doit le lire.
  const liveEditor = editor && !editor.isDestroyed ? editor : null;
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const canEdit = usePages((s) => s.canEdit);
  const [awareness, setAwareness] = useState<Awareness | null>(null);
  const readMode = useWritingMode((m) => m.readMode) || !canEdit;
  const focusMode = useWritingMode((m) => m.focusMode);
  const readingWidth = usePreferences((p) => p.prefs.readingWidth);
  const prefsStore = usePreferencesStore();
  const [backlinks, setBacklinks] = useState<NodeRow[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(node?.title ?? '');
  const lastSaved = useRef(node?.title ?? '');
  const titleManager = useRef<SaveManager<string> | null>(null);
  const titleValue = useRef(title);
  titleValue.current = title;
  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: KeyboardEvent) => {
      // Échap quitte le mode focus, sauf s'il sert déjà à fermer autre chose (dialogue, menu, recherche).
      if (
        e.key === 'Escape' &&
        !e.defaultPrevented &&
        !document.querySelector('[role="dialog"], [role="menu"], [role="search"]')
      )
        useWritingMode.getState().setFocusMode(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode]);
  useEffect(() => {
    const onOpen = (e: Event) => {
      setCommentsOpen(true);
      setActiveThread((e as CustomEvent<string>).detail);
    };
    const onNew = () => {
      if (!editor || !editor.isEditable) {
        toast.error(t('comments.readOnly'));
        return;
      }
      const { from, to } = editor.state.selection;
      const quote = editor.state.doc.textBetween(from, to, '\n').trim();
      if (from === to || quote === '') {
        toast.error(t('comments.selectFirst'));
        return;
      }
      setDraft({ from, to, quote: editor.state.doc.textBetween(from, to, '\n') });
      setCommentsOpen(true);
    };
    window.addEventListener(COMMENT_OPEN_EVENT, onOpen);
    window.addEventListener(COMMENT_NEW_EVENT, onNew);
    return () => {
      window.removeEventListener(COMMENT_OPEN_EVENT, onOpen);
      window.removeEventListener(COMMENT_NEW_EVENT, onNew);
    };
  }, [editor, t]);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const href = (e as CustomEvent<string>).detail;
      const pid = internalPageId(href);
      if (pid) {
        if (store.getState().nodes.some((n) => n.id === pid && !n.deletedAt))
          useNav.getState().navigate({ name: 'page', id: pid });
        else toast.error(t('editor.missingPage'));
      } else if (isExternalHref(href)) {
        api
          .openExternal(href)
          .catch((err: unknown) => toast.error(t(toSlateError(err).messageKey)));
      }
    };
    window.addEventListener(LINK_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(LINK_OPEN_EVENT, onOpen);
  }, [api, store, t]);
  const existed = node !== undefined;
  const nodeTitle = node?.title;

  // Titre : même garantie que le contenu (jamais abandonné en cas d'échec).
  useEffect(() => {
    if (!existed) return;
    let unregister = () => {};
    const m: SaveManager<string> = new SaveManager<string>({
      debounceMs: 400,
      getPayload: () => titleValue.current,
      save: async (v) => {
        if (v === lastSaved.current) return;
        const row = await store.getState().rename(id, v);
        if (!row) throw new Error('renommage impossible');
        lastSaved.current = v;
      },
      onReleased: () => unregister(),
    });
    unregister = registerManager(m);
    titleManager.current = m;
    return () => {
      m.release();
      titleManager.current = null;
    };
  }, [id, existed, store]);

  // Le titre affiché suit la page ouverte ; pour une ligne de base (chargée après le premier rendu), on l'initialise à l'arrivée.
  const titleFor = useRef<string | null>(null);
  useEffect(() => {
    if (node && titleFor.current !== id) {
      titleFor.current = id;
      setTitle(node.title);
      lastSaved.current = node.title;
    }
  }, [id, node]);

  useEffect(() => {
    if (existed) void store.getState().touch(id);
  }, [id, existed, store]);

  useEffect(() => {
    if (existed && (nodeTitle ?? '') === '') titleRef.current?.focus();
    // Page neuve : le curseur démarre dans le titre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, existed]);

  const loadBacklinks = useCallback(() => {
    api.backlinksList(id).then(setBacklinks, () => setBacklinks([]));
  }, [api, id]);
  useEffect(loadBacklinks, [loadBacklinks]);

  const lastStatus = useRef<SaveStatus>('saved');
  const onStatus = useCallback((s: SaveStatus, retry: () => void) => {
    setSaveStatus(s);
    retryRef.current = retry;
  }, []);
  const onSaveError = useCallback(
    (e: unknown) => {
      // Une seule alerte par épisode d'échec (le badge reste affiché et les tentatives continuent).
      if (lastStatus.current !== 'error')
        toast.error(`${t(toSlateError(e).messageKey)} — ${t('editor.willRetry')}`);
    },
    [t],
  );
  useEffect(() => {
    lastStatus.current = saveStatus;
  }, [saveStatus]);

  if (!node) {
    if (status !== 'ready')
      return (
        <p role="status" className="p-8 text-muted">
          {t('editor.loading')}
        </p>
      );
    return (
      <div className="grid h-full place-items-center p-8">
        <EmptyState
          icon="paper"
          title={t('editor.notFoundTitle')}
          description={t('editor.notFoundBody')}
        >
          <Button onClick={() => useNav.getState().navigate({ name: 'home' })}>
            {t('nav.home')}
          </Button>
        </EmptyState>
      </div>
    );
  }

  const trail = ancestors(nodes, id);
  return (
    <div
      className={`mx-auto px-10 pb-24 pt-4 ${WIDTH_CLASS[readingWidth]}`}
      data-writing-mode={focusMode ? 'focus' : readMode ? 'read' : 'edit'}
    >
      <div hidden={focusMode} className="mb-6 flex items-center justify-between gap-4">
        <nav
          aria-label={t('editor.breadcrumb')}
          className="flex min-w-0 items-center gap-1 text-xs text-muted"
        >
          {trail.map((a) => (
            <span key={a.id} className="flex items-center gap-1">
              {a.kind === 'page' ? (
                <button
                  type="button"
                  className="truncate hover:text-fg"
                  onClick={() => useNav.getState().navigate({ name: 'page', id: a.id })}
                >
                  {displayTitle(a, t('pages.untitled'))}
                </button>
              ) : (
                <span className="truncate">{displayTitle(a, t('pages.untitled'))}</span>
              )}
              <Icon name="chevron-right" size={10} />
            </span>
          ))}
          <span className="truncate text-fg">{displayTitle(node, t('pages.untitled'))}</span>
        </nav>
        <div className="flex shrink-0 items-center gap-3">
          <StatusBadge status={saveStatus} retry={() => retryRef.current()} />
          <Menu
            trigger={<IconButton icon="gears" label={t('writing.menu')} />}
            items={[
              {
                id: 'read',
                label: readMode ? t('writing.editMode') : t('writing.readMode'),
                onSelect: () => useWritingMode.getState().toggleReadMode(),
              },
              {
                id: 'focus',
                label: t('writing.focusMode'),
                onSelect: () => useWritingMode.getState().setFocusMode(true),
              },
              ...(['narrow', 'normal', 'wide', 'full'] as const).map((w) => ({
                id: `width-${w}`,
                label: `${t('writing.width')} : ${t(`writing.widths.${w}`)}${readingWidth === w ? ` — ${t('writing.current')}` : ''}`,
                onSelect: () =>
                  void prefsStore
                    .getState()
                    .update({ readingWidth: w })
                    .catch(() => undefined),
              })),
            ]}
          />
          <IconButton
            icon="search"
            label={t('find.open')}
            onClick={() => window.dispatchEvent(new Event(FIND_EVENT))}
          />
          <IconButton
            icon="text-bubble"
            label={t('comments.open')}
            aria-pressed={commentsOpen}
            onClick={() => setCommentsOpen((o) => !o)}
          />
          <IconButton
            icon="clock"
            label={t('versions.open')}
            onClick={() => setVersionsOpen(true)}
          />
          {treeNode ? (
            <IconButton
              icon="star"
              label={node.isFavorite ? t('pages.unfavorite') : t('pages.favorite')}
              aria-pressed={node.isFavorite}
              className={node.isFavorite ? 'text-accent' : ''}
              onClick={() => void store.getState().toggleFavorite(id)}
            />
          ) : null}
        </div>
      </div>

      <VersionsDialog
        nodeId={id}
        editor={editor}
        api={api}
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
      />
      <input
        ref={titleRef}
        aria-label={t('editor.titleLabel')}
        readOnly={readMode}
        placeholder={t('pages.untitled')}
        value={title}
        maxLength={500}
        onChange={(e) => {
          setTitle(e.target.value);
          titleManager.current?.markDirty();
        }}
        onBlur={() => void titleManager.current?.flush().catch(() => undefined)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            editor?.commands.focus('start');
          }
        }}
        className="mb-4 w-full select-text bg-transparent text-3xl font-bold tracking-tight outline-none placeholder:text-muted/60"
      />

      {rowDatabaseId ? <RowProperties databaseId={rowDatabaseId} rowId={id} /> : null}

      {commentsOpen && liveEditor && !focusMode ? (
        <CommentsPanel
          nodeId={id}
          editor={liveEditor}
          api={api}
          draft={draft}
          onDraftDone={() => setDraft(null)}
          activeId={activeThread}
          onActive={setActiveThread}
          onClose={() => {
            setCommentsOpen(false);
            setDraft(null);
            setActiveThread(null);
          }}
        />
      ) : null}
      {focusMode ? (
        <div className="fixed right-4 top-3 z-20 flex items-center gap-2 rounded-lg bg-elevated/90 p-1 shadow-pop">
          <StatusBadge status={saveStatus} retry={() => retryRef.current()} />
          <IconButton
            icon="cross"
            label={t('writing.exitFocus')}
            onClick={() => useWritingMode.getState().setFocusMode(false)}
          />
        </div>
      ) : null}
      {readMode ? (
        <p role="status" className="mb-3 text-xs text-muted">
          {!canEdit ? t('sharing.viewerNotice') : t('writing.reading')}
        </p>
      ) : null}
      <PresenceBar awareness={awareness} />
      <PageEditor
        onAwareness={setAwareness}
        editable={!readMode}
        nodeId={id}
        api={api}
        onStatus={onStatus}
        onEditor={setEditor}
        onSaved={loadBacklinks}
        onSaveError={onSaveError}
      />

      {backlinks.length > 0 ? (
        <section aria-label={t('editor.backlinks')} className="mt-12 border-t border-line pt-4">
          <h2 className="mb-2 text-xs font-medium text-muted">{t('editor.backlinks')}</h2>
          <ul className="space-y-0.5">
            {backlinks.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => useNav.getState().navigate({ name: 'page', id: b.id })}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover"
                >
                  <Icon name="paper" size={14} className="text-muted" />
                  {displayTitle(b, t('pages.untitled'))}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
