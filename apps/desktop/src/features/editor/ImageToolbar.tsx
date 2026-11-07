import { Icon } from '@slate/icons';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IMAGE_ALIGNS, IMAGE_WIDTHS, MAX_ALT, sanitizeAlign, sanitizeWidth } from './ImageFigure';
import type { createMedia } from './media';

const btn = 'flex h-7 items-center gap-1 rounded-md px-2 text-[0.8125rem] hover:bg-hover';

/** Insertion d'image (bouton de la barre) et barre contextuelle d'une image sélectionnée. */
export const IMAGE_INSERT_EVENT = 'slate:editor-image-insert';

export function ImageToolbar({
  editor,
  media,
  showTools = true,
}: {
  editor: Editor;
  media: ReturnType<typeof createMedia>;
  showTools?: boolean;
}) {
  const { t } = useTranslation();
  const file = useRef<HTMLInputElement>(null);
  const replace = useRef(false);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const a = e.getAttributes('imageFigure');
      return {
        active: e.isActive('imageFigure'),
        alt: (a['alt'] as string | undefined) ?? '',
        align: sanitizeAlign(a['align']),
        width: sanitizeWidth(a['width']),
      };
    },
  });
  useEffect(() => {
    const open = () => {
      replace.current = false;
      file.current?.click();
    };
    window.addEventListener(IMAGE_INSERT_EVENT, open);
    return () => window.removeEventListener(IMAGE_INSERT_EVENT, open);
  }, []);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    const hash = await media.upload(f);
    if (!hash) return;
    if (replace.current) editor.chain().focus().updateImage({ hash }).run();
    else
      editor
        .chain()
        .focus()
        .insertImage({ hash, alt: f.name.replace(/\.[^.]+$/, '') })
        .run();
  };
  return (
    <>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        aria-label={t('editor.image.choose')}
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {s.active && showTools ? (
        <div
          role="toolbar"
          aria-label={t('editor.image.tools')}
          className="-mx-2 mb-4 flex flex-wrap items-center gap-0.5 rounded-lg bg-surface p-1"
        >
          {IMAGE_ALIGNS.map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={s.align === a}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().updateImage({ align: a }).run()}
              className={btn + (s.align === a ? ' bg-accent text-accent-fg hover:bg-accent' : '')}
            >
              {t(`editor.image.align.${a}`)}
            </button>
          ))}
          <select
            aria-label={t('editor.image.width')}
            value={s.width ?? ''}
            onChange={(e) =>
              editor
                .chain()
                .focus()
                .updateImage({ width: e.target.value ? Number(e.target.value) : null })
                .run()
            }
            className="h-7 rounded-md border border-line bg-surface px-1.5 text-[0.8125rem] outline-none focus-visible:border-accent"
          >
            <option value="">{t('editor.image.widthAuto')}</option>
            {IMAGE_WIDTHS.map((w) => (
              <option key={w} value={w}>
                {w} %
              </option>
            ))}
          </select>
          <input
            aria-label={t('editor.image.alt')}
            placeholder={t('editor.image.alt')}
            maxLength={MAX_ALT}
            value={s.alt}
            onChange={(e) => editor.chain().updateImage({ alt: e.target.value }).run()}
            className="h-7 min-w-40 flex-1 select-text rounded-md border border-line bg-surface px-2 outline-none focus-visible:border-accent"
          />
          <button
            type="button"
            className={btn}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              replace.current = true;
              file.current?.click();
            }}
          >
            {t('editor.image.replace')}
          </button>
          <button
            type="button"
            className={btn}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor.chain().focus().deleteNode('imageFigure').run()}
          >
            <Icon name="trash" size={14} />
            {t('editor.image.remove')}
          </button>
        </div>
      ) : null}
    </>
  );
}
