import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';

export const COMMENT_OPEN_EVENT = 'slate:comment-open';
export const COMMENT_NEW_EVENT = 'slate:comment-new';
export const isThreadId = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

export interface CommentUi {
  resolved: string[];
  active: string | null;
}
export const commentUiKey = new PluginKey<CommentUi>('commentUi');

/** Étendue (de la première à la dernière portion) du texte ancré à un fil, ou `null` si l'ancrage a disparu. */
export function commentRange(doc: PMNode, threadId: string): { from: number; to: number } | null {
  let from = -1;
  let to = -1;
  doc.descendants((n, pos) => {
    if (
      n.isText &&
      n.marks.some((m) => m.type.name === 'comment' && m.attrs['threadId'] === threadId)
    ) {
      if (from < 0) from = pos;
      to = pos + n.nodeSize;
    }
    return true;
  });
  return from < 0 ? null : { from, to };
}

export function anchoredThreadIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((n) => {
    if (n.isText)
      for (const m of n.marks)
        if (m.type.name === 'comment' && isThreadId(m.attrs['threadId']))
          ids.add(m.attrs['threadId'] as string);
    return true;
  });
  return ids;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    commentAnchor: {
      setCommentThread: (threadId: string) => ReturnType;
      removeCommentThread: (threadId: string) => ReturnType;
      setCommentUi: (ui: Partial<CommentUi>) => ReturnType;
    };
  }
}

/**
 * Ancrage d'un commentaire : une MARQUE portant l'identifiant du fil. Elle vit dans l'état Yjs : elle suit le texte lors
 * des modifications, y compris concurrentes. Plusieurs fils peuvent se chevaucher (`excludes: ''`).
 */
export const CommentAnchor = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',
  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (el: HTMLElement) =>
          isThreadId(el.getAttribute('data-comment-thread'))
            ? el.getAttribute('data-comment-thread')
            : null,
        renderHTML: (a: Record<string, unknown>) =>
          isThreadId(a['threadId']) ? { 'data-comment-thread': a['threadId'] as string } : {},
      },
    };
  },
  parseHTML: () => [
    {
      tag: 'span[data-comment-thread]',
      getAttrs: (el) =>
        isThreadId((el as HTMLElement).getAttribute('data-comment-thread')) ? {} : false,
    },
  ],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes, { class: 'comment-anchor' }),
    0,
  ],
  addCommands() {
    return {
      setCommentThread:
        (threadId) =>
        ({ commands }) =>
          isThreadId(threadId) ? commands.setMark(this.name, { threadId }) : false,
      removeCommentThread:
        (threadId) =>
        ({ tr, state, dispatch }) => {
          if (!isThreadId(threadId)) return false;
          const type = state.schema.marks[this.name]!;
          state.doc.descendants((n, pos) => {
            if (!n.isText) return true;
            for (const m of n.marks)
              if (m.type === type && m.attrs['threadId'] === threadId)
                tr.removeMark(pos, pos + n.nodeSize, m);
            return true;
          });
          if (dispatch && tr.docChanged) dispatch(tr);
          return true;
        },
      setCommentUi:
        (ui) =>
        ({ tr, dispatch }) => {
          dispatch?.(tr.setMeta(commentUiKey, ui));
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    const type = this.type;
    const strip = (f: Fragment): Fragment => {
      const out: PMNode[] = [];
      f.forEach((n) =>
        out.push(
          n.isText ? n.mark(n.marks.filter((m) => m.type !== type)) : n.copy(strip(n.content)),
        ),
      );
      return Fragment.fromArray(out);
    };
    return [
      new Plugin<CommentUi>({
        key: commentUiKey,
        state: {
          init: () => ({ resolved: [], active: null }),
          apply: (tr, prev) => {
            const m = tr.getMeta(commentUiKey) as Partial<CommentUi> | undefined;
            return m ? { ...prev, ...m } : prev;
          },
        },
        props: {
          decorations(state) {
            const ui = commentUiKey.getState(state);
            if (!ui || (ui.resolved.length === 0 && ui.active === null)) return null;
            const decos: Decoration[] = [];
            state.doc.descendants((n, pos) => {
              if (!n.isText) return true;
              for (const m of n.marks) {
                if (m.type !== type) continue;
                const id = m.attrs['threadId'] as string;
                const cls = [
                  ui.resolved.includes(id) ? 'comment-resolved' : '',
                  ui.active === id ? 'comment-active' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                if (cls) decos.push(Decoration.inline(pos, pos + n.nodeSize, { class: cls }));
              }
              return true;
            });
            return DecorationSet.create(state.doc, decos);
          },
          handleClick(view, pos) {
            const $p = view.state.doc.resolve(pos);
            const mark =
              $p.marks().find((m) => m.type === type) ??
              $p.nodeAfter?.marks.find((m) => m.type === type);
            if (mark && isThreadId(mark.attrs['threadId']))
              window.dispatchEvent(
                new CustomEvent(COMMENT_OPEN_EVENT, { detail: mark.attrs['threadId'] }),
              );
            return false;
          },
          // Copier-coller : un commentaire reste attaché à SON texte, il n'est jamais dupliqué.
          transformPasted: (slice) =>
            new Slice(strip(slice.content), slice.openStart, slice.openEnd),
        },
      }),
    ];
  },
});
