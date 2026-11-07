import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface SearchOptions {
  term: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}
export interface Match {
  from: number;
  to: number;
}
export interface SearchState extends SearchOptions {
  matches: Match[];
  /** Index de l'occurrence courante, -1 s'il n'y en a pas. */
  current: number;
  decorations: DecorationSet;
}

export const searchKey = new PluginKey<SearchState>('searchReplace');
const MAX_TERM = 500;
const MAX_MATCHES = 20_000;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Occurrences dans le texte de chaque bloc (les marques de mise en forme ne coupent pas une occurrence). */
export function findMatches(doc: PMNode, o: SearchOptions): Match[] {
  if (o.term === '' || o.term.length > MAX_TERM) return [];
  const body = escape(o.term);
  const re = new RegExp(
    o.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body,
    o.caseSensitive ? 'gu' : 'giu',
  );
  const out: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Texte du bloc + segments (début dans la chaîne -> position dans le document). Les nœuds non textuels comptent pour 1.
    let text = '';
    const segs: { at: number; pos: number; len: number }[] = [];
    node.forEach((child, offset) => {
      const pos0 = pos + 1 + offset;
      if (child.isText) {
        segs.push({ at: text.length, pos: pos0, len: child.text!.length });
        text += child.text!;
      } else {
        segs.push({ at: text.length, pos: pos0, len: 1 });
        text += '\uFFFC';
      }
    });
    const posOf = (i: number) => {
      let lo = 0;
      let hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid]!.at <= i) lo = mid;
        else hi = mid - 1;
      }
      return segs[lo]!.pos + (i - segs[lo]!.at);
    };
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null && out.length < MAX_MATCHES; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const from = posOf(m.index);
      const to = posOf(m.index + m[0].length - 1) + 1;
      out.push({ from, to });
    }
    return false;
  });
  return out;
}

function build(doc: PMNode, o: SearchOptions, current: number): SearchState {
  const matches = findMatches(doc, o);
  const cur = matches.length === 0 ? -1 : Math.min(Math.max(current, 0), matches.length - 1);
  const decorations = DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, {
        class: i === cur ? 'search-match search-match-current' : 'search-match',
      }),
    ),
  );
  return { ...o, matches, current: cur, decorations };
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    searchReplace: {
      setSearch: (o: Partial<SearchOptions>) => ReturnType;
      clearSearch: () => ReturnType;
      findNext: () => ReturnType;
      findPrev: () => ReturnType;
      replaceCurrent: (text: string) => ReturnType;
      replaceAll: (text: string) => ReturnType;
    };
  }
}

export const SearchReplace = Extension.create({
  name: 'searchReplace',
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: (_c, state) =>
            build(state.doc, { term: '', caseSensitive: false, wholeWord: false }, -1),
          apply(tr, prev) {
            const meta = tr.getMeta(searchKey) as
              { options?: Partial<SearchOptions>; current?: number } | undefined;
            if (!meta && !tr.docChanged) return prev;
            const o = {
              term: prev.term,
              caseSensitive: prev.caseSensitive,
              wholeWord: prev.wholeWord,
              ...(meta?.options ?? {}),
            };
            const cur = meta?.options ? 0 : (meta?.current ?? prev.current);
            return build(tr.doc, o, cur);
          },
        },
        props: { decorations: (state) => searchKey.getState(state)?.decorations ?? null },
      }),
    ];
  },
  addCommands() {
    const focusMatch =
      (idx: number): import('@tiptap/core').Command =>
      ({ state, tr, dispatch }) => {
        const s = searchKey.getState(state);
        const m = s?.matches[idx];
        if (!s || !m) return false;
        if (dispatch) {
          tr.setMeta(searchKey, { current: idx })
            .setSelection(TextSelection.create(tr.doc, m.from, m.to))
            .scrollIntoView();
          dispatch(tr);
        }
        return true;
      };
    return {
      setSearch:
        (o) =>
        ({ tr, dispatch }) => {
          if (o.term !== undefined && o.term.length > MAX_TERM) return false;
          dispatch?.(tr.setMeta(searchKey, { options: o }));
          return true;
        },
      clearSearch:
        () =>
        ({ tr, dispatch }) => {
          dispatch?.(tr.setMeta(searchKey, { options: { term: '' } }));
          return true;
        },
      findNext: () => (p) => {
        const s = searchKey.getState(p.state);
        return s && s.matches.length > 0
          ? focusMatch((s.current + 1) % s.matches.length)(p)
          : false;
      },
      findPrev: () => (p) => {
        const s = searchKey.getState(p.state);
        return s && s.matches.length > 0
          ? focusMatch((s.current - 1 + s.matches.length) % s.matches.length)(p)
          : false;
      },
      replaceCurrent:
        (text) =>
        ({ state, tr, dispatch }) => {
          const s = searchKey.getState(state);
          const m = s?.matches[s.current];
          if (!s || !m) return false;
          if (dispatch) {
            tr.insertText(text, m.from, m.to);
            tr.setMeta(searchKey, { current: s.current }); // l'occurrence suivante prend la place
            dispatch(tr);
          }
          return true;
        },
      replaceAll:
        (text) =>
        ({ state, tr, dispatch }) => {
          const s = searchKey.getState(state);
          if (!s || s.matches.length === 0) return false;
          if (dispatch) {
            // De la fin vers le début : les positions restent valables sans recalcul.
            for (const m of [...s.matches].reverse()) tr.insertText(text, m.from, m.to);
            dispatch(tr);
          }
          return true;
        },
    };
  },
});
