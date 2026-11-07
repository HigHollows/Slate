import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { usePresenceService } from './presence';
import { usePagesStore } from '../pages';
import { Button } from '../../shared/ui';
import type { Ipc } from '../../shared/ipc/client';
import { toSlateError } from '../../shared/ipc/errors';
import { BubbleToolbar } from './BubbleToolbar';
import { BlockToolbar } from './BlockToolbar';
import { EditorContextMenu } from './EditorContextMenu';
import { FindBar } from './FindBar';
import { FormatToolbar } from './FormatToolbar';
import { liveDocs } from './liveDocs';
import { LinkCard } from './LinkCard';
import { LinkDialog } from './LinkDialog';
import { createMedia } from './media';
import { ImageToolbar } from './ImageToolbar';
import { Dialog, toast } from '../../shared/ui';
import { docStats } from './stats';
import { extractLinkTargets, fromBase64, toBase64 } from './content';
import { LINK_SHORTCUT_EVENT, buildExtensions } from './extensions';
import { SaveManager, registerManager, type SaveStatus } from '../../shared/save-manager';

export type EditorApi = Pick<
  Ipc,
  | 'pageGet'
  | 'pageSave'
  | 'backlinksList'
  | 'nodeGet'
  | 'mediaPut'
  | 'mediaGet'
  | 'versionCreate'
  | 'versionList'
  | 'versionGet'
  | 'versionRename'
  | 'versionDelete'
  | 'threadCreate'
  | 'threadList'
  | 'commentAdd'
  | 'commentEdit'
  | 'commentDelete'
  | 'threadResolve'
  | 'threadDelete'
  | 'openExternal'
>;

interface Props {
  nodeId: string;
  api: EditorApi;
  onStatus(status: SaveStatus, retry: () => void): void;
  onEditor(editor: Editor | null): void;
  /** Appelé après chaque enregistrement réussi (ex. rafraîchir les rétroliens). */
  onSaved(): void;
  onSaveError(error: unknown): void;
  /** Faux : mode lecture (aucune modification possible, commandes d'édition masquées). */
  editable: boolean;
  /** Présence : appelé avec l'awareness de la page ouverte, `null` à la fermeture. */
  onAwareness?(awareness: Awareness | null): void;
}

type Loaded =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; ydoc: Y.Doc };

/** Charge l'état Yjs de la page puis monte la surface d'édition. Le contenu n'est jamais perdu : voir SaveManager. */
export function PageEditor(props: Props) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const { nodeId, api } = props;

  useEffect(() => {
    let cancelled = false;
    setLoaded({ state: 'loading' });
    api.pageGet(nodeId).then(
      (data) => {
        if (cancelled) return;
        const ydoc = new Y.Doc();
        if (data.docState) Y.applyUpdate(ydoc, fromBase64(data.docState));
        setLoaded({ state: 'ready', ydoc });
      },
      (e: unknown) =>
        !cancelled && setLoaded({ state: 'error', message: t(toSlateError(e).messageKey) }),
    );
    return () => {
      cancelled = true;
    };
  }, [api, nodeId, attempt, t]);

  if (loaded.state === 'loading')
    return (
      <p role="status" className="text-muted">
        {t('editor.loading')}
      </p>
    );
  if (loaded.state === 'error') {
    return (
      <div role="alert" className="space-y-2">
        <p>{loaded.message}</p>
        <Button onClick={() => setAttempt((a) => a + 1)}>{t('system.retry')}</Button>
      </div>
    );
  }
  return <Surface key={`${nodeId}:${attempt}`} {...props} ydoc={loaded.ydoc} />;
}

function Surface({
  nodeId,
  api,
  ydoc,
  onStatus,
  onEditor,
  onSaved,
  onSaveError,
  editable,
  onAwareness,
}: Props & { ydoc: Y.Doc }) {
  const { t } = useTranslation();
  const pages = usePagesStore();
  const editorRef = useRef<Editor | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  useEffect(() => liveDocs.register(nodeId, ydoc), [nodeId, ydoc]);
  const onAwarenessRef = useRef(onAwareness);
  onAwarenessRef.current = onAwareness;
  // Présence : l'awareness existe toujours (soi-même seulement tant qu'aucun transport n'est attaché).
  const awareness = useMemo(() => new Awareness(ydoc), [ydoc]);
  const presence = usePresenceService();
  useEffect(() => {
    const detach = presence?.attach(nodeId, ydoc, awareness);
    onAwarenessRef.current?.(awareness);
    return () => {
      detach?.();
      onAwarenessRef.current?.(null);
      awareness.destroy();
    };
  }, [presence, nodeId, ydoc, awareness]);

  const cb = useRef({ onStatus, onSaved, onSaveError, onEditor });
  cb.current = { onStatus, onSaved, onSaveError, onEditor };

  // Le gestionnaire est créé dans l'effet (et non mémoïsé) : il survit ainsi au double montage de React StrictMode.
  useEffect(() => {
    const build = () => {
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) throw new Error('éditeur indisponible');
      const json = ed.getJSON();
      return {
        id: nodeId,
        docState: toBase64(Y.encodeStateAsUpdate(ydoc)),
        contentJson: JSON.stringify(json),
        textPlain: ed.getText({ blockSeparator: '\n' }),
        linkTargets: extractLinkTargets(json),
      };
    };
    let unregister = () => {};
    const manager: SaveManager<ReturnType<typeof build>> = new SaveManager({
      getPayload: build,
      save: async (p) => {
        await api.pageSave(p);
      },
      onStatus: (s, err) => {
        cb.current.onStatus(s, () => void manager.retryNow().catch(() => undefined));
        if (s === 'saved') cb.current.onSaved();
        if (s === 'error') cb.current.onSaveError(err);
      },
      onReleased: () => unregister(),
    });
    unregister = registerManager(manager);

    // Les mises à jour produites par le montage de l'éditeur ne sont pas des modifications de l'utilisateur.
    let armed = false;
    const arm = setTimeout(() => (armed = true), 0);
    const onUpdate = () => {
      if (armed) manager.markDirty();
    };
    ydoc.on('update', onUpdate);

    return () => {
      clearTimeout(arm);
      ydoc.off('update', onUpdate);
      // Fermeture de la page : figer le contenu AVANT la destruction de l'éditeur, écrire,
      // et continuer d'essayer en arrière-plan en cas d'échec (jamais d'abandon silencieux).
      if (manager.hasPending()) {
        try {
          const snapshot = build();
          manager.setSource(() => snapshot);
        } catch {
          /* éditeur déjà détruit : la source précédente reste valable tant que `editorRef` l'est */
        }
      }
      manager.release();
    };
  }, [api, nodeId, ydoc]);

  const i18n = useMemo(
    () => ({
      placeholder: t('editor.placeholder'),
      slashLabel: t('editor.slashLabel'),
      slashEmpty: t('editor.slashEmpty'),
      mentionLabel: t('editor.mentionLabel'),
      mentionEmpty: t('editor.mentionEmpty'),
      untitled: t('pages.untitled'),
      createPage: (title: string) => t('editor.createPage', { title }),
      slashTitle: (id: string) => t(`slash.${id}.title`),
      slashDescription: (id: string) => t(`slash.${id}.description`),
      slashGroup: (g: string) => t(`slash.group.${g}`),
      calloutLabel: (v: string) => t(`editor.callout.${v}`),
      detailsCollapse: t('editor.detailsCollapse'),
      detailsExpand: t('editor.detailsExpand'),
      imageMissing: t('editor.image.missing'),
      code: {
        language: t('editor.code.language'),
        copy: t('editor.code.copy'),
        copied: t('editor.code.copied'),
        copyFailed: t('editor.code.copyFailed'),
        lineNumbers: t('editor.code.lineNumbers'),
        collapse: t('editor.code.collapse'),
        expand: t('editor.code.expand'),
        languageName: (id: string) => t(`editor.code.languages.${id}`),
      },
      taskProgress: (done: number, total: number) => t('editor.taskProgress', { done, total }),
      tocLabel: t('editor.toc'),
      tocEmpty: t('editor.tocEmpty'),
      summaryPlaceholder: t('editor.summaryPlaceholder'),
    }),
    [t],
  );

  const media = useMemo(
    () => createMedia(api, (e) => toast.error(t(toSlateError(e).messageKey))),
    [api, t],
  );
  const [viewer, setViewer] = useState<{ hash: string; alt: string; url?: string } | null>(null);

  const extensions = useMemo(
    () =>
      buildExtensions({
        ydoc,
        awareness,
        i18n,
        getPages: () => pages.getState().nodes,
        media: {
          upload: media.upload,
          load: media.load,
          open: (hash, alt) => {
            setViewer({ hash, alt });
            void media
              .load(hash)
              .then((url) => setViewer((v) => (v?.hash === hash ? { ...v, url } : v)));
          },
        },
        createPage: (title) => pages.getState().createNode({ parentId: null, kind: 'page', title }),
      }),
    [ydoc, awareness, i18n, pages, media],
  );

  const editor = useEditor(
    {
      extensions,
      editable,
      editorProps: {
        attributes: {
          class: 'slate-editor',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': t('editor.label'),
        },
      },
      onCreate: ({ editor: ed }) => {
        editorRef.current = ed;
        cb.current.onEditor(ed);
      },
      onDestroy: () => {
        // L'éditeur détruit ne doit plus être exposé aux autres composants.
        if (editorRef.current?.isDestroyed) cb.current.onEditor(null);
      },
    },
    [extensions],
  );
  editorRef.current = editor;
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => () => cb.current.onEditor(null), []);

  useEffect(() => {
    const open = () => setLinkOpen(true);
    window.addEventListener(LINK_SHORTCUT_EVENT, open);
    return () => window.removeEventListener(LINK_SHORTCUT_EVENT, open);
  }, []);
  const [text, setText] = useState('');
  useEffect(() => {
    if (!editor) return;
    const update = () => setText(editor.getText({ blockSeparator: '\n' }));
    update();
    editor.on('update', update);
    return () => void editor.off('update', update);
  }, [editor]);
  const stats = useMemo(() => docStats(text), [text]);

  if (!editor || editor.isDestroyed) return null;
  return (
    <div className="relative">
      {editable ? (
        <DragHandle editor={editor}>
          <span aria-hidden className="slate-grip" title={t('editor.dragHandle')} />
        </DragHandle>
      ) : null}
      {editable ? <FormatToolbar editor={editor} onLink={() => setLinkOpen(true)} /> : null}
      <FindBar editor={editor} editable={editable} />
      {editable ? <BlockToolbar editor={editor} /> : null}
      <ImageToolbar editor={editor} media={media} showTools={editable} />
      <Dialog
        open={viewer !== null}
        onOpenChange={(o) => !o && setViewer(null)}
        title={t('editor.image.view')}
        description={viewer?.alt || t('editor.image.view')}
      >
        <div className="p-4">
          {viewer?.url ? (
            <img src={viewer.url} alt={viewer.alt} className="mx-auto max-h-[75vh] max-w-full" />
          ) : (
            <p role="status" className="text-muted">
              {t('editor.loading')}
            </p>
          )}
        </div>
      </Dialog>
      {editable ? <BubbleToolbar editor={editor} onLink={() => setLinkOpen(true)} /> : null}
      <EditorContextMenu editor={editor} onLink={() => setLinkOpen(true)} />
      <LinkCard editor={editor} onEdit={() => setLinkOpen(true)} />
      <LinkDialog editor={editor} open={linkOpen} onOpenChange={setLinkOpen} />
      <EditorContent editor={editor} />
      <p aria-label={t('editor.stats')} className="mt-6 flex flex-wrap gap-x-3 text-xs text-muted">
        <span>{t('editor.wordCount', { count: stats.words })}</span>
        <span>{t('editor.chars', { count: stats.chars })}</span>
        <span>{t('editor.charsNoSpaces', { count: stats.charsNoSpaces })}</span>
        <span>{t('editor.paragraphs', { count: stats.paragraphs })}</span>
        {stats.readingMinutes > 0 ? (
          <span>{t('editor.readingTime', { minutes: stats.readingMinutes })}</span>
        ) : null}
      </p>
    </div>
  );
}
