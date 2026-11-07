import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { displayTitle, usePages } from '../pages';
import { toast } from '../../shared/ui';
import { LINK_OPEN_EVENT } from './LinkOpen';
import { internalPageId } from './link';

interface Target {
  href: string;
  /** Position dans le document, pour agir sur CE lien (survol) ou celui sous le curseur. */
  pos: number;
  x: number;
  y: number;
}

const rectOf = (editor: Editor, pos: number) => {
  try {
    const c = editor.view.coordsAtPos(pos);
    return { x: c.left, y: c.bottom };
  } catch {
    return { x: 0, y: 0 }; // environnement sans mise en page (tests)
  }
};

/** Carte d'un lien : adresse (ou titre de la page), ouvrir, copier, modifier, retirer. Au curseur et au survol. */
export function LinkCard({ editor, onEdit }: { editor: Editor; onEdit(): void }) {
  const { t } = useTranslation();
  const nodes = usePages((s) => s.nodes);
  const [hover, setHover] = useState<Target | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const overCard = useRef(false);

  const caret = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const href = e.getAttributes('link')['href'] as string | undefined;
      if (!href || !e.state.selection.empty) return null;
      return { href, pos: e.state.selection.from };
    },
  });

  useEffect(() => {
    const dom = editor.view.dom;
    const over = (ev: MouseEvent) => {
      const a = (ev.target as HTMLElement).closest?.('a[href]');
      if (!a) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const href = a.getAttribute('href') ?? '';
        const pos = editor.view.posAtDOM(a, 0);
        const r = a.getBoundingClientRect();
        setHover({ href, pos, x: r.left, y: r.bottom });
      }, 350);
    };
    const out = (ev: MouseEvent) => {
      if (!(ev.target as HTMLElement).closest?.('a[href]')) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => !overCard.current && setHover(null), 250);
    };
    dom.addEventListener('mouseover', over);
    dom.addEventListener('mouseout', out);
    return () => {
      clearTimeout(timer.current);
      dom.removeEventListener('mouseover', over);
      dom.removeEventListener('mouseout', out);
    };
  }, [editor]);

  const target: Target | null =
    hover ?? (caret ? { ...caret, ...rectOf(editor, caret.pos) } : null);
  if (!target) return null;

  const pageId = internalPageId(target.href);
  const page = pageId ? nodes.find((n) => n.id === pageId) : undefined;
  const label = pageId
    ? page
      ? displayTitle(page, t('pages.untitled'))
      : t('editor.missingPage')
    : target.href;
  const select = () => editor.chain().focus().setTextSelection(target.pos).extendMarkRange('link');
  const btn = 'h-7 rounded-md px-2 text-[0.8125rem] hover:bg-hover';

  return (
    <div
      role="group"
      aria-label={t('editor.linkCard')}
      onMouseEnter={() => (overCard.current = true)}
      onMouseLeave={() => {
        overCard.current = false;
        setHover(null);
      }}
      style={{ left: Math.max(8, Math.min(target.x, window.innerWidth - 360)), top: target.y + 6 }}
      className="fixed z-30 flex max-w-sm items-center gap-0.5 rounded-lg bg-elevated p-1 shadow-pop"
    >
      <span className="max-w-48 truncate px-2 text-xs text-muted" title={target.href}>
        {label}
      </span>
      <button
        type="button"
        className={btn}
        onClick={() =>
          window.dispatchEvent(new CustomEvent(LINK_OPEN_EVENT, { detail: target.href }))
        }
      >
        {t('editor.linkOpen')}
      </button>
      <button
        type="button"
        className={btn}
        onClick={() =>
          void navigator.clipboard.writeText(target.href).then(
            () => toast.success(t('editor.linkCopied')),
            () => toast.error(t('editor.linkCopyFailed')),
          )
        }
      >
        {t('editor.linkCopy')}
      </button>
      {editor.isEditable ? (
        <>
          <button
            type="button"
            className={btn}
            onClick={() => {
              select().run();
              setHover(null);
              onEdit();
            }}
          >
            {t('editor.linkEdit')}
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => {
              select().unsetLink().run();
              setHover(null);
            }}
          >
            {t('editor.linkRemove')}
          </button>
        </>
      ) : null}
    </div>
  );
}
