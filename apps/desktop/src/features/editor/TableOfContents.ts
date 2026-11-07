import { Node, mergeAttributes, type Editor } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    toc: { insertToc: () => ReturnType };
  }
}

export interface Heading {
  level: number;
  text: string;
  pos: number;
}

/** Titres du document, dans l'ordre, avec leur position (les identifiants stables ne sont pas nécessaires : on navigue par position). */
export function collectHeadings(editor: Editor): Heading[] {
  const out: Heading[] = [];
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === 'heading' && n.textContent.trim() !== '')
      out.push({ level: n.attrs['level'] as number, text: n.textContent, pos });
    return true;
  });
  return out;
}

/** Sommaire : bloc atomique dont le contenu est recalculé à chaque modification. N'est jamais stocké (seul le bloc l'est). */
export const TableOfContents = Node.create<{ label: string; empty: string }>({
  name: 'toc',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addOptions: () => ({ label: 'Sommaire', empty: 'Aucun titre' }),
  parseHTML: () => [{ tag: 'div[data-toc]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-toc': '' })],
  addCommands() {
    return {
      insertToc:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },
  addNodeView() {
    const { label, empty } = this.options;
    return ({ editor }) => {
      const dom = document.createElement('nav');
      dom.setAttribute('aria-label', label);
      dom.setAttribute('data-toc', '');
      dom.contentEditable = 'false';
      const render = () => {
        dom.replaceChildren();
        const title = document.createElement('p');
        title.className = 'toc-title';
        title.textContent = label;
        dom.append(title);
        const heads = collectHeadings(editor);
        if (heads.length === 0) {
          const p = document.createElement('p');
          p.className = 'toc-empty';
          p.textContent = empty;
          dom.append(p);
          return;
        }
        const min = Math.min(...heads.map((h) => h.level));
        const ul = document.createElement('ul');
        for (const h of heads) {
          const li = document.createElement('li');
          li.style.paddingLeft = `${(h.level - min) * 1}rem`;
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = h.text; // texte : jamais interprété comme HTML
          b.addEventListener('mousedown', (e) => e.preventDefault());
          b.addEventListener('click', () => {
            editor
              .chain()
              .focus()
              .setTextSelection(h.pos + 1)
              .scrollIntoView()
              .run();
          });
          li.append(b);
          ul.append(li);
        }
        dom.append(ul);
      };
      render();
      editor.on('update', render);
      return { dom, destroy: () => void editor.off('update', render), ignoreMutation: () => true };
    };
  },
});
