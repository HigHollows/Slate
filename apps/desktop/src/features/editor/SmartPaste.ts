import { Extension, type Editor } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { DOMParser as PMDOMParser, Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { cleanPastedHTML, effectiveMode, type PasteMode, type PasteSource } from './paste';

const PRESENTATION_MARKS = new Set(['textStyle', 'highlight']);
const PRESENTATION_ATTRS: Record<string, string[]> = {
  paragraph: ['textAlign', 'lineHeight'],
  heading: ['textAlign', 'lineHeight'],
  tableCell: ['background'],
  tableHeader: ['background'],
};

/** Retire la présentation (couleurs, polices, tailles, surlignage, alignement, interligne, fond de cellule), garde la structure et la sémantique. */
export function stripPresentation(f: Fragment): Fragment {
  const out: PMNode[] = [];
  f.forEach((n) => {
    if (n.isText) {
      out.push(n.mark(n.marks.filter((m) => !PRESENTATION_MARKS.has(m.type.name))));
      return;
    }
    const reset = PRESENTATION_ATTRS[n.type.name];
    const attrs = reset
      ? {
          ...n.attrs,
          ...Object.fromEntries(reset.map((k) => [k, n.type.spec.attrs?.[k]?.default ?? null])),
        }
      : n.attrs;
    out.push(
      n.type.create(
        attrs,
        stripPresentation(n.content),
        n.marks.filter((m) => !PRESENTATION_MARKS.has(m.type.name)),
      ),
    );
  });
  return Fragment.fromArray(out);
}

interface State {
  /** Mode forcé pour le prochain collage uniquement. */
  forced: PasteMode;
  source: PasteSource;
}

/**
 * Collage intelligent : HTML nettoyé à l'arrivée, politique selon la source (Word / Docs / Slate : mise en forme
 * conservée ; web : normalisée selon le design de Slate), modes explicites via `pasteHtml`.
 */
export const SmartPaste = Extension.create<object, State>({
  name: 'smartPaste',
  addStorage: () => ({ forced: 'auto' as PasteMode, source: 'web' as PasteSource }),
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        props: {
          transformPastedHTML(html) {
            const r = cleanPastedHTML(html);
            storage.source = r.source;
            return r.html;
          },
          transformPasted(slice) {
            const mode = effectiveMode(storage.forced, storage.source);
            storage.forced = 'auto';
            return mode === 'compatible'
              ? new Slice(stripPresentation(slice.content), slice.openStart, slice.openEnd)
              : slice;
          },
        },
      }),
    ];
  },
});

/**
 * Insère du HTML avec un mode de collage explicite. Passe par la même chaîne de nettoyage que le collage natif
 * (utile pour « Coller sans mise en forme » depuis le presse-papiers, et testable sans événement de collage).
 */
export function pasteHtml(editor: Editor, html: string, mode: PasteMode): boolean {
  const { html: clean, source } = cleanPastedHTML(html);
  const holder = document.createElement('div');
  holder.innerHTML = clean;
  let slice = PMDOMParser.fromSchema(editor.schema).parseSlice(holder, {
    preserveWhitespace: false,
  });
  if (effectiveMode(mode, source) === 'compatible')
    slice = new Slice(stripPresentation(slice.content), slice.openStart, slice.openEnd);
  editor.view.dispatch(editor.state.tr.replaceSelection(slice).scrollIntoView());
  return true;
}

/** Texte brut : paragraphes séparés par une ligne vide, sauts de ligne simples conservés. Rien n'est interprété comme du HTML. */
export function pastePlainText(editor: Editor, text: string): boolean {
  const norm = text.replace(/\r\n?/g, '\n');
  if (norm.trim() === '') return false;
  const inline = (p: string) =>
    p
      .split('\n')
      .flatMap((line, i) => [
        ...(i > 0 ? [{ type: 'hardBreak' }] : []),
        ...(line ? [{ type: 'text', text: line }] : []),
      ]);
  const paras = norm.split(/\n{2,}/).filter((p) => p.trim() !== '');
  const content =
    paras.length === 1
      ? inline(paras[0]!)
      : paras.map((p) => ({ type: 'paragraph', content: inline(p) }));
  return editor.chain().focus().insertContent(content).run();
}
