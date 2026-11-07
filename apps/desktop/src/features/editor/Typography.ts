import { Extension, type Command } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import {
  cssColor,
  isNeutralBackground,
  luminanceClass,
  parseCssColor,
  parseCssFontFamily,
  parseCssFontSize,
  sanitizeColor,
  sanitizeFontFamily,
  sanitizeFontSize,
  sanitizeLineHeight,
  FONT_STACKS,
} from './format';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    typography: {
      setTextColor: (color: string) => ReturnType;
      unsetTextColor: () => ReturnType;
      setFontFamily: (id: string) => ReturnType;
      unsetFontFamily: () => ReturnType;
      setFontSize: (px: number) => ReturnType;
      unsetFontSize: () => ReturnType;
      setLineHeight: (v: string) => ReturnType;
      unsetLineHeight: () => ReturnType;
      /** Retire tout le formatage de caractère (ou un seul format) sur la sélection ; le texte reste intact. */
      clearFormatting: () => ReturnType;
    };
  }
}

export const Typography = Extension.create({
  name: 'typography',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          color: {
            default: null,
            parseHTML: (el: HTMLElement) =>
              sanitizeColor(el.getAttribute('data-doc-color'), 'text') ??
              parseCssColor(el.style?.color ?? ''),
            renderHTML: (attrs: Record<string, unknown>) => {
              const c = sanitizeColor(attrs['color'], 'text');
              if (!c) return {};
              return {
                'data-doc-color': c,
                ...(c.startsWith('#') ? { 'data-lum': luminanceClass(c) } : {}),
                style: c.startsWith('#')
                  ? `color: ${c}; --c: ${c}`
                  : `color: ${cssColor(c, 'text')}`,
              };
            },
          },
          fontFamily: {
            default: null,
            parseHTML: (el: HTMLElement) =>
              sanitizeFontFamily(el.getAttribute('data-doc-font')) ??
              parseCssFontFamily(el.style?.fontFamily ?? ''),
            renderHTML: (attrs: Record<string, unknown>) => {
              const f = sanitizeFontFamily(attrs['fontFamily']);
              return f ? { 'data-doc-font': f, style: `font-family: ${FONT_STACKS[f]}` } : {};
            },
          },
          fontSize: {
            default: null,
            parseHTML: (el: HTMLElement) =>
              sanitizeFontSize(el.getAttribute('data-doc-size')) ??
              parseCssFontSize(el.style?.fontSize ?? ''),
            renderHTML: (attrs: Record<string, unknown>) => {
              const s = sanitizeFontSize(attrs['fontSize']);
              return s ? { 'data-doc-size': String(s), style: `font-size: ${s}px` } : {};
            },
          },
        },
      },
      {
        types: ['paragraph', 'heading'],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el: HTMLElement) => sanitizeLineHeight(el.getAttribute('data-line-height')),
            renderHTML: (attrs: Record<string, unknown>) => {
              const v = sanitizeLineHeight(attrs['lineHeight']);
              return v ? { 'data-line-height': v, style: `line-height: ${v}` } : {};
            },
          },
        },
      },
    ];
  },
  addCommands() {
    const set =
      (attr: string, value: unknown): Command =>
      ({ chain }) =>
        value === null
          ? false
          : chain()
              .setMark('textStyle', { [attr]: value })
              .run();
    const unset =
      (attr: string): Command =>
      ({ chain }) =>
        chain()
          .setMark('textStyle', { [attr]: null })
          .removeEmptyTextStyle()
          .run();
    return {
      setTextColor: (c) => set('color', sanitizeColor(c, 'text')),
      unsetTextColor: () => unset('color'),
      setFontFamily: (f) => set('fontFamily', sanitizeFontFamily(f)),
      unsetFontFamily: () => unset('fontFamily'),
      setFontSize: (n) => set('fontSize', sanitizeFontSize(n)),
      unsetFontSize: () => unset('fontSize'),
      setLineHeight:
        (v) =>
        ({ chain }) => {
          const h = sanitizeLineHeight(v);
          return h
            ? chain()
                .updateAttributes('paragraph', { lineHeight: h })
                .updateAttributes('heading', { lineHeight: h })
                .run()
            : false;
        },
      unsetLineHeight:
        () =>
        ({ chain }) =>
          chain()
            .resetAttributes('paragraph', 'lineHeight')
            .resetAttributes('heading', 'lineHeight')
            .run(),
      clearFormatting:
        () =>
        ({ chain }) =>
          chain().unsetAllMarks().run(),
    };
  },
});

/** Surlignage multicolore à valeurs validées (identifiant de palette ou #rrggbb). */
export const DocHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: 'yellow',
        parseHTML: (el: HTMLElement) => {
          const direct = sanitizeColor(el.getAttribute('data-color'), 'highlight');
          if (direct) return direct;
          const bg = parseCssColor(el.style?.backgroundColor ?? '');
          return bg && !isNeutralBackground(bg) ? bg : 'yellow';
        },
        renderHTML: (attrs: Record<string, unknown>) => {
          const c = sanitizeColor(attrs['color'], 'highlight') ?? 'yellow';
          return {
            'data-color': c,
            ...(c.startsWith('#') ? { 'data-lum': luminanceClass(c) } : {}),
            style: `background-color: ${cssColor(c, 'highlight')}`,
          };
        },
      },
    };
  },
});
