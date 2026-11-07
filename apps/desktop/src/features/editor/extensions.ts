import { Extension, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import type { Awareness } from 'y-protocols/awareness';
import { PresenceCursors } from './presence';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { DocHighlight, Typography } from './Typography';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import type * as Y from 'yjs';
import { normalize } from '../../shared/text';
import type { NodeRow } from '../../shared/ipc/client';
import { BlockMove } from './BlockMove';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { Callout } from './Callout';
import { CodeBlock, type CodeLabels } from './CodeBlock';
import { ImageFigure, type ImageOptions } from './ImageFigure';
import { isAllowedHref } from './link';
import { ParagraphFormat } from './ParagraphFormat';
import { SmartPaste } from './SmartPaste';
import { LinkOpen } from './LinkOpen';
import { CommentAnchor } from './CommentAnchor';
import { SearchReplace } from './SearchReplace';
import { TableOfContents } from './TableOfContents';
import { TableCellStyle } from './TableCellStyle';
import { PageMention } from './PageMention';
import { createSuggestionRenderer } from './suggestion';
import type { SuggestionItem } from './SuggestionList';
import { filterSlash } from './slashItems';

export interface EditorI18n {
  placeholder: string;
  slashLabel: string;
  slashEmpty: string;
  mentionLabel: string;
  mentionEmpty: string;
  untitled: string;
  createPage(title: string): string;
  slashTitle(id: string): string;
  slashDescription(id: string): string;
  slashGroup(group: string): string;
  calloutLabel(variant: string): string;
  detailsCollapse: string;
  detailsExpand: string;
  imageMissing: string;
  code: CodeLabels;
  taskProgress(done: number, total: number): string;
  tocLabel: string;
  tocEmpty: string;
  summaryPlaceholder: string;
}

export interface EditorDeps {
  ydoc: Y.Doc;
  i18n: EditorI18n;
  getPages(): NodeRow[];
  createPage(title: string): Promise<NodeRow | undefined>;
  media: Pick<ImageOptions, 'upload' | 'load' | 'open'>;
  /** Présence en direct : curseurs des autres participants (absent = éditeur purement local). */
  awareness?: Awareness;
}

const slashKey = new PluginKey('slashSuggestion');
const mentionKey = new PluginKey('mentionSuggestion');

const notInCode = ({
  state,
  range,
}: {
  state: import('@tiptap/pm/state').EditorState;
  range: { from: number };
}) => !state.doc.resolve(range.from).parent.type.spec['code'];

function slashExtension(d: EditorDeps) {
  return Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      return [
        Suggestion<SuggestionItem, SuggestionItem>({
          editor: this.editor,
          char: '/',
          pluginKey: slashKey,
          allow: notInCode,
          items: ({ query }) =>
            filterSlash(query, d.i18n.slashTitle).map((it) => ({
              id: it.id,
              title: d.i18n.slashTitle(it.id),
              description: d.i18n.slashDescription(it.id),
              ...(query ? {} : { group: d.i18n.slashGroup(it.group) }),
              ...(it.icon ? { icon: it.icon } : {}),
              ...(it.glyph ? { glyph: it.glyph } : {}),
            })),
          command: ({ editor, range, props }) => {
            const item = filterSlash('', d.i18n.slashTitle).find((i) => i.id === props.id);
            item?.run(editor, range);
          },
          render: createSuggestionRenderer(() => ({
            label: d.i18n.slashLabel,
            empty: d.i18n.slashEmpty,
          })),
        }),
      ];
    },
  });
}

function mentionExtension(d: EditorDeps) {
  return Extension.create({
    name: 'pageMentionSuggestion',
    addProseMirrorPlugins() {
      return [
        Suggestion<SuggestionItem, SuggestionItem>({
          editor: this.editor,
          char: '@',
          pluginKey: mentionKey,
          allow: notInCode,
          items: ({ query }) => {
            const q = normalize(query.trim());
            const pages = d
              .getPages()
              .filter((n) => n.kind === 'page' && (q === '' || normalize(n.title).includes(q)))
              .slice(0, 8)
              .map<SuggestionItem>((n) => ({
                id: `page:${n.id}`,
                title: n.title.trim() || d.i18n.untitled,
                icon: 'paper',
              }));
            if (query.trim() !== '' && !pages.some((p) => normalize(p.title) === q)) {
              pages.push({
                id: `new:${query.trim()}`,
                title: d.i18n.createPage(query.trim()),
                icon: 'plus',
              });
            }
            return pages;
          },
          command: ({ editor, range, props }) => {
            const insert = (id: string) =>
              editor
                .chain()
                .focus()
                .insertContentAt(range, [
                  { type: 'pageMention', attrs: { id } },
                  { type: 'text', text: ' ' },
                ])
                .run();
            if (props.id.startsWith('page:')) insert(props.id.slice(5));
            else if (props.id.startsWith('new:')) {
              const title = props.id.slice(4);
              editor.chain().focus().deleteRange(range).run();
              void d.createPage(title).then((row) => {
                if (row) insert(row.id);
              });
            }
          },
          render: createSuggestionRenderer(() => ({
            label: d.i18n.mentionLabel,
            empty: d.i18n.mentionEmpty,
          })),
        }),
      ];
    },
  });
}

/** Raccourcis propres à la mise en forme. Ctrl/Cmd+K reste la palette de commandes de Slate : le lien est sur Ctrl/Cmd+Maj+K. */
export const LINK_SHORTCUT_EVENT = 'slate:editor-link';
const FormatShortcuts = Extension.create({
  name: 'formatShortcuts',
  addKeyboardShortcuts() {
    return {
      'Mod-\\': () => this.editor.commands.clearFormatting(),
      'Mod-Shift-k': () => {
        window.dispatchEvent(new Event(LINK_SHORTCUT_EVENT));
        return true;
      },
    };
  },
});

export function buildExtensions(d: EditorDeps): AnyExtension[] {
  return [
    StarterKit.configure({
      undoRedo: false, // l'annulation est gérée par Yjs (Collaboration), pas par l'historique ProseMirror
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      codeBlock: false,
      link: {
        openOnClick: false,
        autolink: true,
        // Seuls http(s), mailto et les liens internes sont admis, à la saisie, au collage et au chargement.
        isAllowedUri: (url: string) => isAllowedHref(url),
        protocols: [{ scheme: 'mailto', optionalSlashes: false }],
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      },
    }),
    Collaboration.configure({ document: d.ydoc }),
    ...(d.awareness ? [PresenceCursors.configure({ awareness: d.awareness })] : []),
    TextStyle,
    Typography,
    DocHighlight.configure({ multicolor: true }),
    Subscript.extend({ excludes: 'superscript' }),
    Superscript.extend({ excludes: 'subscript' }),
    TextAlign.configure({
      types: ['heading', 'paragraph'],
      alignments: ['left', 'center', 'right', 'justify'],
    }),
    Placeholder.configure({ placeholder: d.i18n.placeholder }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true, lastColumnResizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TableCellStyle,
    Callout.configure({ label: d.i18n.calloutLabel }),
    Details.configure({
      persist: true,
      renderToggleButton: ({ element, isOpen }) => {
        element.setAttribute('aria-label', isOpen ? d.i18n.detailsCollapse : d.i18n.detailsExpand);
        element.setAttribute('aria-expanded', String(isOpen));
      },
    }),
    DetailsSummary,
    DetailsContent,
    ImageFigure.configure({ ...d.media, missing: d.i18n.imageMissing }),
    CodeBlock.configure({ labels: d.i18n.code }),
    TableOfContents.configure({ label: d.i18n.tocLabel, empty: d.i18n.tocEmpty }),
    PageMention,
    ParagraphFormat.configure({ progressLabel: d.i18n.taskProgress }),
    BlockMove,
    SearchReplace,
    CommentAnchor,
    LinkOpen,
    SmartPaste,
    FormatShortcuts,
    slashExtension(d),
    mentionExtension(d),
  ];
}
