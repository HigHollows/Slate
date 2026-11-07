import { Node, mergeAttributes } from '@tiptap/core';

export const CALLOUT_VARIANTS = [
  'note',
  'info',
  'warning',
  'important',
  'tip',
  'definition',
  'summary',
] as const;
export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];
export const sanitizeVariant = (v: unknown): CalloutVariant =>
  typeof v === 'string' && (CALLOUT_VARIANTS as readonly string[]).includes(v)
    ? (v as CalloutVariant)
    : 'note';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      toggleCallout: (variant?: CalloutVariant) => ReturnType;
      setCalloutVariant: (variant: CalloutVariant) => ReturnType;
    };
  }
}

/** Encadré typé : bloc conteneur (contient d'autres blocs). Les anciens encadrés sans type deviennent « note ». */
export const Callout = Node.create<{ label: (v: CalloutVariant) => string }>({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addOptions: () => ({ label: (v: CalloutVariant) => v }),
  addAttributes() {
    return {
      variant: {
        default: 'note',
        parseHTML: (el: HTMLElement) => sanitizeVariant(el.getAttribute('data-variant')),
        renderHTML: (a: Record<string, unknown>) => ({
          'data-variant': sanitizeVariant(a['variant']),
        }),
      },
    };
  },
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML({ node, HTMLAttributes }) {
    const v = sanitizeVariant(node.attrs['variant']);
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-callout': '', 'data-label': this.options.label(v) }),
      0,
    ];
  },
  addCommands() {
    return {
      toggleCallout:
        (variant = 'note') =>
        ({ commands, editor }) =>
          editor.isActive('callout')
            ? commands.lift(this.name)
            : commands.wrapIn(this.name, { variant: sanitizeVariant(variant) }),
      setCalloutVariant:
        (variant) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { variant: sanitizeVariant(variant) }),
    };
  },
});
