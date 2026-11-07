import { Icon } from '@slate/icons';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cx } from '../../shared/ui';
import { searchKey } from './SearchReplace';

export const FIND_EVENT = 'slate:editor-find';

const field =
  'h-8 min-w-0 flex-1 select-text rounded-md border border-line bg-surface px-2 outline-none focus-visible:border-accent';

/** Recherche et remplacement dans le document (Ctrl/Cmd+F). Les occurrences sont repérées dans le texte, sans le modifier. */
export function FindBar({ editor, editable = true }: { editor: Editor; editable?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [replacement, setReplacement] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const st = searchKey.getState(e.state);
      return {
        term: st?.term ?? '',
        caseSensitive: st?.caseSensitive ?? false,
        wholeWord: st?.wholeWord ?? false,
        count: st?.matches.length ?? 0,
        current: st?.current ?? -1,
      };
    },
  });

  useEffect(() => {
    const show = () => {
      setOpen(true);
      requestAnimationFrame(() => input.current?.select());
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(FIND_EVENT, show);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(FIND_EVENT, show);
      if (!editor.isDestroyed) editor.commands.clearSearch(); // un éditeur détruit n'a plus de vue
    };
  }, [editor]);

  if (!open) return null;
  const close = () => {
    editor.commands.clearSearch();
    setOpen(false);
    editor.commands.focus();
  };
  const toggle = (active: boolean, label: string, onClick: () => void, glyph: string) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'grid size-8 place-items-center rounded-md text-xs font-semibold hover:bg-hover',
        active && 'bg-accent text-accent-fg hover:bg-accent',
      )}
    >
      {glyph}
    </button>
  );
  const small = 'h-8 rounded-md px-2 text-[0.8125rem] hover:bg-hover disabled:opacity-40';
  return (
    <div
      role="search"
      aria-label={t('find.label')}
      className="sticky top-12 z-10 -mx-2 mb-3 flex flex-wrap items-center gap-1 rounded-lg bg-elevated p-1.5 shadow-pop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <input
        ref={input}
        autoFocus
        aria-label={t('find.search')}
        placeholder={t('find.search')}
        value={s.term}
        maxLength={500}
        onChange={(e) => editor.commands.setSearch({ term: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) editor.commands.findPrev();
            else editor.commands.findNext();
          }
        }}
        className={field}
      />
      <span role="status" aria-live="polite" className="min-w-16 text-center text-xs text-muted">
        {s.term === ''
          ? ''
          : s.count === 0
            ? t('find.none')
            : t('find.position', { current: s.current + 1, count: s.count })}
      </span>
      <button
        type="button"
        aria-label={t('find.prev')}
        title={t('find.prev')}
        disabled={s.count === 0}
        onClick={() => editor.commands.findPrev()}
        className={small}
      >
        <Icon name="chevron-up" size={14} />
      </button>
      <button
        type="button"
        aria-label={t('find.next')}
        title={t('find.next')}
        disabled={s.count === 0}
        onClick={() => editor.commands.findNext()}
        className={small}
      >
        <Icon name="chevron-down" size={14} />
      </button>
      {toggle(
        s.caseSensitive,
        t('find.matchCase'),
        () => editor.commands.setSearch({ caseSensitive: !s.caseSensitive }),
        'Aa',
      )}
      {toggle(
        s.wholeWord,
        t('find.wholeWord'),
        () => editor.commands.setSearch({ wholeWord: !s.wholeWord }),
        'ab',
      )}
      {editable ? (
        <>
          <input
            aria-label={t('find.replaceWith')}
            placeholder={t('find.replaceWith')}
            value={replacement}
            maxLength={2000}
            onChange={(e) => setReplacement(e.target.value)}
            className={field}
          />
          <button
            type="button"
            disabled={s.count === 0}
            onClick={() => editor.commands.replaceCurrent(replacement)}
            className={small}
          >
            {t('find.replace')}
          </button>
          <button
            type="button"
            disabled={s.count === 0}
            onClick={() => editor.commands.replaceAll(replacement)}
            className={small}
          >
            {t('find.replaceAll')}
          </button>
        </>
      ) : null}
      <button
        type="button"
        aria-label={t('find.close')}
        title={t('find.close')}
        onClick={close}
        className={small}
      >
        <Icon name="cross" size={12} />
      </button>
    </div>
  );
}
