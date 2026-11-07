import { Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

/** Alt+Maj+↑/↓ : déplace le bloc de premier niveau contenant le curseur (alternative clavier au glisser-déposer). */
export const BlockMove = Extension.create({
  name: 'blockMove',
  addKeyboardShortcuts() {
    const move = (dir: -1 | 1) => () => {
      const { state, view } = this.editor;
      const { $from } = state.selection;
      if ($from.depth < 1) return false;
      const index = $from.index(0);
      const target = index + dir;
      const doc = state.doc;
      if (target < 0 || target >= doc.childCount) return true; // bord : rien à faire, geste consommé
      const offsets: number[] = [];
      let pos = 0;
      doc.forEach((n) => {
        offsets.push(pos);
        pos += n.nodeSize;
      });
      const a = Math.min(index, target);
      const first = doc.child(a);
      const second = doc.child(a + 1);
      const from = offsets[a] as number;
      const to = from + first.nodeSize + second.nodeSize;
      const tr = state.tr.replaceWith(from, to, [second, first]);
      const movedStart = dir === -1 ? from : from + second.nodeSize;
      const cursor = Math.min(movedStart + 1, tr.doc.content.size);
      tr.setSelection(TextSelection.near(tr.doc.resolve(cursor)));
      view.dispatch(tr.scrollIntoView());
      return true;
    };
    return { 'Alt-Shift-ArrowUp': move(-1), 'Alt-Shift-ArrowDown': move(1) };
  },
});
