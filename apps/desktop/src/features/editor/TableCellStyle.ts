import { Extension } from '@tiptap/core';
import { cssColor, luminanceClass, sanitizeColor } from './format';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tableCellStyle: {
      setCellBackground: (color: string) => ReturnType;
      unsetCellBackground: () => ReturnType;
    };
  }
}

/** Fond de cellule : valeur validée (palette de surlignage ou #rrggbb), comme le surlignage de texte. */
export const TableCellStyle = Extension.create({
  name: 'tableCellStyle',
  addGlobalAttributes() {
    return [
      {
        types: ['tableCell', 'tableHeader'],
        attributes: {
          background: {
            default: null,
            parseHTML: (el: HTMLElement) => sanitizeColor(el.getAttribute('data-bg'), 'highlight'),
            renderHTML: (a: Record<string, unknown>) => {
              const c = sanitizeColor(a['background'], 'highlight');
              return c
                ? {
                    'data-bg': c,
                    ...(c.startsWith('#') ? { 'data-lum': luminanceClass(c) } : {}),
                    style: `background-color: ${cssColor(c, 'highlight')}`,
                  }
                : {};
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setCellBackground:
        (color) =>
        ({ commands }) => {
          const c = sanitizeColor(color, 'highlight');
          return c ? commands.setCellAttribute('background', c) : false;
        },
      unsetCellBackground:
        () =>
        ({ commands }) =>
          commands.setCellAttribute('background', null),
    };
  },
});
