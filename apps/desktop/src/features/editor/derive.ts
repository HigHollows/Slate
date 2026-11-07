import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { buildExtensions } from './extensions';

const noop = { upload: async () => undefined, load: async () => '', open: () => undefined };

/**
 * Instantané JSON et texte brut d'un document Yjs, calculés SANS affichage (éditeur sans élément).
 * Sert à la synchronisation : après fusion d'un contenu distant, la recherche et les sauvegardes JSON restent justes.
 */
export function snapshotFromDoc(ydoc: Y.Doc): { contentJson: string; textPlain: string } {
  const editor = new Editor({
    extensions: buildExtensions({
      ydoc,
      i18n: {
        placeholder: '',
        slashLabel: '',
        slashEmpty: '',
        mentionLabel: '',
        mentionEmpty: '',
        untitled: '',
        createPage: (t: string) => t,
        slashTitle: (id: string) => id,
        slashDescription: (id: string) => id,
        slashGroup: (g: string) => g,
        calloutLabel: (v: string) => v,
        detailsCollapse: '',
        detailsExpand: '',
        imageMissing: '',
        taskProgress: (d: number, t: number) => `${d}/${t}`,
        code: {
          language: '',
          copy: '',
          copied: '',
          copyFailed: '',
          lineNumbers: '',
          collapse: '',
          expand: '',
          languageName: (id: string) => id,
        },
        tocLabel: '',
        tocEmpty: '',
        summaryPlaceholder: '',
      },
      getPages: () => [],
      createPage: async () => undefined,
      media: noop,
    }),
  });
  try {
    return {
      contentJson: JSON.stringify(editor.getJSON()),
      textPlain: editor.getText({ blockSeparator: '\n' }),
    };
  } finally {
    editor.destroy();
  }
}
