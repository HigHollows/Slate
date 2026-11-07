import { Extension, type Command } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export const BULLET_STYLES = ['disc', 'circle', 'square', 'dash'] as const;
export const ORDERED_STYLES = [
  'decimal',
  'lower-alpha',
  'upper-alpha',
  'lower-roman',
  'upper-roman',
] as const;
export const SPACINGS = [0, 4, 8, 12, 16, 24, 32] as const;
export const MAX_INDENT = 8;
export const INDENT_REM = 1.5;

export const sanitizeBulletStyle = (v: unknown) =>
  (BULLET_STYLES as readonly unknown[]).includes(v) ? (v as (typeof BULLET_STYLES)[number]) : null;
export const sanitizeOrderedStyle = (v: unknown) =>
  (ORDERED_STYLES as readonly unknown[]).includes(v)
    ? (v as (typeof ORDERED_STYLES)[number])
    : null;
export const sanitizeIndent = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_INDENT ? n : null;
};
export const sanitizeSpacing = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && (SPACINGS as readonly number[]).includes(n) ? n : null;
};

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphFormat: {
      increaseIndent: () => ReturnType;
      decreaseIndent: () => ReturnType;
      increaseRightIndent: () => ReturnType;
      decreaseRightIndent: () => ReturnType;
      setParagraphSpacing: (s: { before?: number | null; after?: number | null }) => ReturnType;
      resetParagraphFormat: () => ReturnType;
      setListStyle: (style: string) => ReturnType;
      toggleTaskProgress: () => ReturnType;
      moveListItem: (dir: -1 | 1) => ReturnType;
    };
  }
}

const TEXTBLOCKS = ['paragraph', 'heading'];

function attrDef(
  name: string,
  parse: (v: string | null) => unknown,
  render: (v: unknown) => Record<string, string>,
) {
  return {
    default: null,
    parseHTML: (el: HTMLElement) => parse(el.getAttribute(`data-${name}`)),
    renderHTML: (a: Record<string, unknown>) => render(a[camel(name)]),
  };
}
const camel = (s: string) => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

/** Coordonnées (début, fin) des blocs de texte atteints par la sélection. */
function textblocksIn(editor: { state: { selection: { from: number; to: number }; doc: PMNode } }) {
  const out: { node: PMNode; pos: number }[] = [];
  const { from, to } = editor.state.selection;
  editor.state.doc.nodesBetween(from, to, (n, pos) => {
    if (TEXTBLOCKS.includes(n.type.name)) out.push({ node: n, pos });
    return true;
  });
  return out;
}

export const progressKey = new PluginKey('taskProgress');

/** Compte les cases d'une liste de tâches (imbriquées comprises). */
export function taskCounts(list: PMNode): { done: number; total: number } {
  let done = 0;
  let total = 0;
  list.descendants((n) => {
    if (n.type.name === 'taskItem') {
      total++;
      if (n.attrs['checked']) done++;
    }
    return true;
  });
  return { done, total };
}

export const ParagraphFormat = Extension.create<{
  progressLabel: (done: number, total: number) => string;
}>({
  name: 'paragraphFormat',
  priority: 200, // avant BlockMove : Alt+Maj+↑/↓ déplace l'élément de liste quand le curseur est dans une liste
  addOptions: () => ({ progressLabel: (d, t) => `${d}/${t}` }),
  addGlobalAttributes() {
    const indentRender = (key: string, side: 'left' | 'right') => (v: unknown) => {
      const n = sanitizeIndent(v);
      return n ? { [`data-${key}`]: String(n), style: `margin-${side}: ${n * INDENT_REM}rem` } : {};
    };
    const spaceRender = (key: string, side: 'top' | 'bottom') => (v: unknown) => {
      const n = sanitizeSpacing(v);
      return n === null ? {} : { [`data-${key}`]: String(n), style: `margin-${side}: ${n}px` };
    };
    return [
      {
        types: TEXTBLOCKS,
        attributes: {
          indent: attrDef('indent', (v) => sanitizeIndent(v), indentRender('indent', 'left')),
          indentRight: attrDef(
            'indent-right',
            (v) => sanitizeIndent(v),
            indentRender('indent-right', 'right'),
          ),
          spaceBefore: attrDef(
            'space-before',
            (v) => sanitizeSpacing(v),
            spaceRender('space-before', 'top'),
          ),
          spaceAfter: attrDef(
            'space-after',
            (v) => sanitizeSpacing(v),
            spaceRender('space-after', 'bottom'),
          ),
        },
      },
      {
        types: ['bulletList'],
        attributes: {
          listStyle: attrDef(
            'list-style',
            (v) => sanitizeBulletStyle(v),
            (v) => {
              const s = sanitizeBulletStyle(v);
              return s ? { 'data-list-style': s } : {};
            },
          ),
        },
      },
      {
        types: ['orderedList'],
        attributes: {
          listStyle: attrDef(
            'list-style',
            (v) => sanitizeOrderedStyle(v),
            (v) => {
              const s = sanitizeOrderedStyle(v);
              return s ? { 'data-list-style': s } : {};
            },
          ),
        },
      },
      {
        types: ['taskList'],
        attributes: {
          progress: {
            default: false,
            parseHTML: (el: HTMLElement) => el.getAttribute('data-progress') === 'true',
            renderHTML: (a: Record<string, unknown>) =>
              a['progress'] === true ? { 'data-progress': 'true' } : {},
          },
        },
      },
    ];
  },
  addCommands() {
    const indentBy =
      (key: 'indent' | 'indentRight', dir: 1 | -1): Command =>
      ({ editor, chain, state, dispatch }) => {
        if (key === 'indent' && (editor.isActive('listItem') || editor.isActive('taskItem'))) {
          const item = editor.isActive('taskItem') ? 'taskItem' : 'listItem';
          return dir === 1 ? chain().sinkListItem(item).run() : chain().liftListItem(item).run();
        }
        const blocks = textblocksIn(editor);
        if (blocks.length === 0) return false;
        const tr = state.tr;
        let changed = false;
        for (const { node, pos } of blocks) {
          const cur = (sanitizeIndent(node.attrs[key]) ?? 0) + dir;
          const next = cur < 1 ? null : Math.min(cur, MAX_INDENT);
          if (next !== (sanitizeIndent(node.attrs[key]) ?? null)) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, [key]: next });
            changed = true;
          }
        }
        if (changed) dispatch?.(tr);
        return changed;
      };
    return {
      increaseIndent: () => indentBy('indent', 1),
      decreaseIndent: () => indentBy('indent', -1),
      increaseRightIndent: () => indentBy('indentRight', 1),
      decreaseRightIndent: () => indentBy('indentRight', -1),
      setParagraphSpacing:
        (s) =>
        ({ editor, state, dispatch }) => {
          if (
            (s.before !== undefined && s.before !== null && sanitizeSpacing(s.before) === null) ||
            (s.after !== undefined && s.after !== null && sanitizeSpacing(s.after) === null)
          )
            return false;
          const blocks = textblocksIn(editor);
          if (blocks.length === 0) return false;
          const tr = state.tr;
          for (const { node, pos } of blocks) {
            const attrs = { ...node.attrs };
            if (s.before !== undefined) attrs['spaceBefore'] = s.before;
            if (s.after !== undefined) attrs['spaceAfter'] = s.after;
            tr.setNodeMarkup(pos, undefined, attrs);
          }
          dispatch?.(tr);
          return true;
        },
      resetParagraphFormat:
        () =>
        ({ editor, state, dispatch }) => {
          const blocks = textblocksIn(editor);
          if (blocks.length === 0) return false;
          const tr = state.tr;
          for (const { node, pos } of blocks)
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              indent: null,
              indentRight: null,
              spaceBefore: null,
              spaceAfter: null,
              lineHeight: null,
            });
          dispatch?.(tr);
          return true;
        },
      setListStyle:
        (style) =>
        ({ editor, commands }) => {
          if (editor.isActive('bulletList')) {
            const s = sanitizeBulletStyle(style);
            return s ? commands.updateAttributes('bulletList', { listStyle: s }) : false;
          }
          if (editor.isActive('orderedList')) {
            const s = sanitizeOrderedStyle(style);
            return s ? commands.updateAttributes('orderedList', { listStyle: s }) : false;
          }
          return false;
        },
      toggleTaskProgress:
        () =>
        ({ editor, commands }) =>
          editor.isActive('taskList')
            ? commands.updateAttributes('taskList', {
                progress: !editor.getAttributes('taskList')['progress'],
              })
            : false,
      moveListItem:
        (dir) =>
        ({ state, dispatch }) => {
          const { $from } = state.selection;
          let depth = $from.depth;
          while (depth > 0 && !['listItem', 'taskItem'].includes($from.node(depth).type.name))
            depth--;
          if (depth === 0) return false;
          const parent = $from.node(depth - 1);
          const index = $from.index(depth - 1);
          const target = index + dir;
          if (target < 0 || target >= parent.childCount) return true; // bord : geste consommé, rien à faire
          const a = Math.min(index, target);
          const listStart = $from.start(depth - 1);
          let offset = 0;
          for (let i = 0; i < a; i++) offset += parent.child(i).nodeSize;
          const first = parent.child(a);
          const second = parent.child(a + 1);
          const from = listStart + offset;
          const tr = state.tr.replaceWith(from, from + first.nodeSize + second.nodeSize, [
            second,
            first,
          ]);
          const movedStart = dir === -1 ? from : from + second.nodeSize;
          tr.setSelection(
            TextSelection.near(tr.doc.resolve(Math.min(movedStart + 2, tr.doc.content.size))),
          );
          dispatch?.(tr.scrollIntoView());
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Alt-ArrowRight': () => this.editor.commands.increaseIndent(),
      'Mod-Alt-ArrowLeft': () => this.editor.commands.decreaseIndent(),
      'Alt-Shift-ArrowUp': () => this.editor.commands.moveListItem(-1),
      'Alt-Shift-ArrowDown': () => this.editor.commands.moveListItem(1),
    };
  },
  addProseMirrorPlugins() {
    const label = this.options.progressLabel;
    return [
      new Plugin({
        key: progressKey,
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            state.doc.descendants((n, pos) => {
              if (n.type.name !== 'taskList' || n.attrs['progress'] !== true) return true;
              const { done, total } = taskCounts(n);
              decos.push(
                Decoration.widget(
                  pos + 1,
                  () => {
                    const w = document.createElement('li');
                    w.className = 'task-progress';
                    w.contentEditable = 'false';
                    w.setAttribute('role', 'progressbar');
                    w.setAttribute('aria-valuemin', '0');
                    w.setAttribute('aria-valuemax', String(total));
                    w.setAttribute('aria-valuenow', String(done));
                    w.setAttribute('aria-label', label(done, total));
                    const bar = document.createElement('span');
                    bar.className = 'task-progress-bar';
                    const fill = document.createElement('span');
                    fill.style.width = total === 0 ? '0%' : `${Math.round((done / total) * 100)}%`;
                    bar.append(fill);
                    const txt = document.createElement('span');
                    txt.className = 'task-progress-text';
                    txt.textContent = label(done, total);
                    w.append(bar, txt);
                    return w;
                  },
                  { side: -1, key: `p${done}/${total}` },
                ),
              );
              return true;
            });
            return decos.length ? DecorationSet.create(state.doc, decos) : null;
          },
        },
      }),
    ];
  },
});
