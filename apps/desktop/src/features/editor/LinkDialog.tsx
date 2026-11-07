import type { Editor } from '@tiptap/react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { displayTitle, usePages } from '../pages';
import { normalize } from '../../shared/text';
import { Button, Dialog } from '../../shared/ui';
import { displayForHref, internalPageId, normalizeLink, pageLink } from './link';

/** Compatibilité : l'ancien contrôle de lien (http, https, mailto) est désormais dans `link.ts`. */
export { isAllowedHref as isSafeLink } from './link';

const input =
  'h-9 w-full select-text rounded-md border border-line bg-surface px-3 outline-none focus-visible:border-accent';

/** Insertion / modification d'un lien : adresse (normalisée), texte affiché, ou page de Slate. */
export function LinkDialog({
  editor,
  open,
  onOpenChange,
}: {
  editor: Editor;
  open: boolean;
  onOpenChange(o: boolean): void;
}) {
  const { t } = useTranslation();
  const nodes = usePages((s) => s.nodes);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  // Lien existant à modifier, sélection à lier, ou point d'insertion (aucun des deux) ?
  const [mode, setMode] = useState<'edit' | 'wrap' | 'insert'>('insert');

  useEffect(() => {
    if (!open) return;
    const existing = editor.getAttributes('link')['href'] as string | undefined;
    const { from, to } = editor.state.selection;
    setUrl(existing ?? '');
    setQuery('');
    setText('');
    setMode(existing ? 'edit' : from !== to ? 'wrap' : 'insert');
  }, [open, editor]);

  const href = url.trim() === '' ? '' : normalizeLink(url);
  const valid = url.trim() === '' || href !== null;
  const pages = useMemo(() => {
    const q = normalize(query.trim());
    return nodes
      .filter((n) => n.kind === 'page' && (q === '' || normalize(n.title).includes(q)))
      .slice(0, 6);
  }, [nodes, query]);

  const apply = () => {
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else if (href) {
      if (mode === 'insert') {
        const label = text.trim() || displayForHref(href);
        editor
          .chain()
          .focus()
          .insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] })
          .run();
      } else {
        const c = editor.chain().focus();
        (mode === 'edit' ? c.extendMarkRange('link') : c).setLink({ href }).run();
      }
    } else return;
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('editor.link')}
      description={t('editor.linkHint')}
    >
      <form
        className="space-y-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        {mode === 'insert' ? (
          <label className="block space-y-1">
            <span>{t('editor.linkText')}</span>
            <input
              className={input}
              value={text}
              maxLength={300}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
        ) : null}
        <label className="block space-y-1">
          <span>{t('editor.linkUrl')}</span>
          <input
            autoFocus
            aria-invalid={!valid}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            className={input}
          />
        </label>
        {!valid ? (
          <p role="alert" className="text-danger">
            {t('editor.linkInvalid')}
          </p>
        ) : href && href !== url.trim() ? (
          <p role="status" className="text-xs text-muted">
            {t('editor.linkWillBe', { href })}
          </p>
        ) : null}
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted">{t('editor.linkPage')}</legend>
          <input
            aria-label={t('editor.linkPageSearch')}
            placeholder={t('editor.linkPageSearch')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={input}
          />
          <ul aria-label={t('editor.linkPages')} className="max-h-36 overflow-y-auto">
            {pages.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-pressed={internalPageId(url.trim()) === p.id}
                  onClick={() => {
                    setUrl(pageLink(p.id));
                    if (mode === 'insert' && text.trim() === '')
                      setText(displayTitle(p, t('pages.untitled')));
                  }}
                  className="w-full truncate rounded-md px-2 py-1 text-left hover:bg-hover aria-pressed:bg-pressed"
                >
                  {displayTitle(p, t('pages.untitled'))}
                </button>
              </li>
            ))}
          </ul>
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={!valid}>
            {t('common.apply')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
