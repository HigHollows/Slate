import type { Editor, Range } from '@tiptap/core';
import type { IconName } from '@slate/icons';
import { normalize } from '../../shared/text';
import { IMAGE_INSERT_EVENT } from './ImageToolbar';

export interface SlashItem {
  id: string;
  group: 'basic' | 'lists' | 'advanced';
  icon?: IconName;
  glyph?: string;
  keywords: string[];
  run(editor: Editor, range: Range): void;
}

const chain = (e: Editor, r: Range) => e.chain().focus().deleteRange(r);

/** Blocs insérables. Sur un bloc existant, la commande le TRANSFORME (le texte tapé après `/` est supprimé). */
export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'paragraph',
    group: 'basic',
    glyph: '¶',
    keywords: ['text', 'texte', 'paragraph', 'paragraphe'],
    run: (e, r) => chain(e, r).setParagraph().run(),
  },
  {
    id: 'h1',
    group: 'basic',
    glyph: 'H1',
    keywords: ['title', 'titre', 'heading', 'h1'],
    run: (e, r) => chain(e, r).setNode('heading', { level: 1 }).run(),
  },
  {
    id: 'h2',
    group: 'basic',
    glyph: 'H2',
    keywords: ['title', 'titre', 'heading', 'h2'],
    run: (e, r) => chain(e, r).setNode('heading', { level: 2 }).run(),
  },
  {
    id: 'h3',
    group: 'basic',
    glyph: 'H3',
    keywords: ['title', 'titre', 'heading', 'h3'],
    run: (e, r) => chain(e, r).setNode('heading', { level: 3 }).run(),
  },
  {
    id: 'h4',
    group: 'basic',
    glyph: 'H4',
    keywords: ['title', 'titre', 'heading', 'h4'],
    run: (e, r) => chain(e, r).setNode('heading', { level: 4 }).run(),
  },
  {
    id: 'h5',
    group: 'basic',
    glyph: 'H5',
    keywords: ['title', 'titre', 'heading', 'h5'],
    run: (e, r) => chain(e, r).setNode('heading', { level: 5 }).run(),
  },
  {
    id: 'h6',
    group: 'basic',
    glyph: 'H6',
    keywords: ['title', 'titre', 'heading', 'h6'],
    run: (e, r) => chain(e, r).setNode('heading', { level: 6 }).run(),
  },
  {
    id: 'highlight',
    group: 'basic',
    icon: 'pen-alt',
    keywords: ['highlight', 'surlignage', 'surligner', 'marker'],
    run: (e, r) => chain(e, r).toggleHighlight({ color: 'yellow' }).run(),
  },
  {
    id: 'bullet',
    group: 'lists',
    icon: 'list',
    keywords: ['list', 'liste', 'puces', 'bullet'],
    run: (e, r) => chain(e, r).toggleBulletList().run(),
  },
  {
    id: 'ordered',
    group: 'lists',
    glyph: '1.',
    keywords: ['list', 'liste', 'numérotée', 'numbered', 'ordered'],
    run: (e, r) => chain(e, r).toggleOrderedList().run(),
  },
  {
    id: 'task',
    group: 'lists',
    icon: 'tasks',
    keywords: ['todo', 'tâche', 'task', 'checkbox', 'case'],
    run: (e, r) => chain(e, r).toggleTaskList().run(),
  },
  {
    id: 'quote',
    group: 'advanced',
    glyph: '“',
    keywords: ['quote', 'citation', 'blockquote'],
    run: (e, r) => chain(e, r).toggleBlockquote().run(),
  },
  {
    id: 'callout',
    group: 'advanced',
    icon: 'info',
    keywords: ['callout', 'encadré', 'note', 'info'],
    run: (e, r) => chain(e, r).toggleCallout('note').run(),
  },
  {
    id: 'callout_info',
    group: 'advanced',
    icon: 'info',
    keywords: ['information', 'encadré', 'callout'],
    run: (e, r) => chain(e, r).toggleCallout('info').run(),
  },
  {
    id: 'callout_warning',
    group: 'advanced',
    icon: 'alert-triangle',
    keywords: ['avertissement', 'warning', 'attention', 'encadré', 'callout'],
    run: (e, r) => chain(e, r).toggleCallout('warning').run(),
  },
  {
    id: 'callout_important',
    group: 'advanced',
    icon: 'alert-circle',
    keywords: ['important', 'encadré', 'callout'],
    run: (e, r) => chain(e, r).toggleCallout('important').run(),
  },
  {
    id: 'callout_tip',
    group: 'advanced',
    icon: 'sparkles',
    keywords: ['conseil', 'tip', 'astuce', 'encadré', 'callout'],
    run: (e, r) => chain(e, r).toggleCallout('tip').run(),
  },
  {
    id: 'callout_definition',
    group: 'advanced',
    icon: 'paper',
    keywords: ['définition', 'definition', 'encadré', 'callout'],
    run: (e, r) => chain(e, r).toggleCallout('definition').run(),
  },
  {
    id: 'callout_summary',
    group: 'advanced',
    icon: 'list',
    keywords: ['résumé', 'summary', 'encadré', 'callout'],
    run: (e, r) => chain(e, r).toggleCallout('summary').run(),
  },
  {
    id: 'details',
    group: 'advanced',
    icon: 'chevron-down',
    keywords: ['repliable', 'toggle', 'details', 'accordéon', 'accordion', 'collapse'],
    run: (e, r) => chain(e, r).setDetails().run(),
  },
  {
    id: 'toc',
    group: 'advanced',
    icon: 'menu',
    keywords: ['sommaire', 'table des matières', 'toc', 'contents'],
    run: (e, r) => chain(e, r).insertToc().run(),
  },
  {
    id: 'code',
    group: 'advanced',
    icon: 'code',
    keywords: ['code', 'snippet'],
    run: (e, r) => chain(e, r).toggleCodeBlock().run(),
  },
  {
    id: 'image',
    group: 'advanced',
    icon: 'gallery',
    keywords: ['image', 'photo', 'picture', 'illustration'],
    run: (e, r) => {
      chain(e, r).run();
      window.dispatchEvent(new Event(IMAGE_INSERT_EVENT));
    },
  },
  {
    id: 'divider',
    group: 'advanced',
    glyph: '—',
    keywords: ['divider', 'séparateur', 'separator', 'line', 'ligne', 'hr'],
    run: (e, r) => chain(e, r).setHorizontalRule().run(),
  },
  {
    id: 'table',
    group: 'advanced',
    icon: 'grid',
    keywords: ['table', 'tableau', 'grid'],
    run: (e, r) => chain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'mention',
    group: 'advanced',
    glyph: '@',
    keywords: ['page', 'link', 'lien', 'mention', 'reference'],
    run: (e, r) => chain(e, r).insertContent('@').run(),
  },
];

/** Filtre par titre traduit + mots-clés (insensible à la casse et aux accents) ; ordre d'origine conservé. */
export function filterSlash(query: string, title: (id: string) => string): SlashItem[] {
  const q = normalize(query.trim());
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (it) =>
      normalize(title(it.id)).includes(q) || it.keywords.some((k) => normalize(k).includes(q)),
  );
}
