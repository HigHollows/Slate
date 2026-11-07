import { Icon } from '@slate/icons';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useTranslation } from 'react-i18next';
import { cx } from '../../shared/ui';
import { COMMENT_NEW_EVENT } from './CommentAnchor';

function Tool({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cx(
        'grid size-7 place-items-center rounded-md text-[0.8125rem] font-semibold hover:bg-hover',
        active && 'bg-pressed text-accent-fg bg-accent hover:bg-accent',
      )}
    >
      {children}
    </button>
  );
}

/** Barre de mise en forme flottante sur sélection. I et S sont typographiques (absents de Papicons). */
export function BubbleToolbar({ editor, onLink }: { editor: Editor; onLink(): void }) {
  const { t } = useTranslation();
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
    }),
  });
  const c = () => editor.chain().focus();
  return (
    <>
      <BubbleMenu
        editor={editor}
        options={{ placement: 'top' }}
        shouldShow={({ editor: e, from, to }) => from !== to && !e.isActive('codeBlock')}
      >
        <div
          role="toolbar"
          aria-label={t('editor.format')}
          className="anim-pop flex items-center gap-0.5 rounded-lg bg-elevated p-1 shadow-pop"
        >
          <Tool label={t('editor.bold')} active={s.bold} onClick={() => c().toggleBold().run()}>
            <Icon name="bold" size={15} />
          </Tool>
          <Tool
            label={t('editor.italic')}
            active={s.italic}
            onClick={() => c().toggleItalic().run()}
          >
            <span className="italic">I</span>
          </Tool>
          <Tool
            label={t('editor.underline')}
            active={s.underline}
            onClick={() => c().toggleUnderline().run()}
          >
            <Icon name="underline" size={15} />
          </Tool>
          <Tool
            label={t('editor.strike')}
            active={s.strike}
            onClick={() => c().toggleStrike().run()}
          >
            <span className="line-through">S</span>
          </Tool>
          <Tool
            label={t('editor.inlineCode')}
            active={s.code}
            onClick={() => c().toggleCode().run()}
          >
            <Icon name="code" size={15} />
          </Tool>
          <Tool
            label={t('comments.add')}
            active={false}
            onClick={() => window.dispatchEvent(new Event(COMMENT_NEW_EVENT))}
          >
            <Icon name="text-bubble" size={15} />
          </Tool>
          <Tool label={t('editor.link')} active={s.link} onClick={onLink}>
            <Icon name="link" size={15} />
          </Tool>
        </div>
      </BubbleMenu>
    </>
  );
}
