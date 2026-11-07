import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

export const IMAGE_ALIGNS = ['left', 'center', 'right', 'wide', 'full'] as const;
export type ImageAlign = (typeof IMAGE_ALIGNS)[number];
export const IMAGE_WIDTHS = [25, 50, 75, 100] as const;
export const MAX_ALT = 500;

export const sanitizeHash = (v: unknown): string | null =>
  typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null;
export const sanitizeAlign = (v: unknown): ImageAlign =>
  typeof v === 'string' && (IMAGE_ALIGNS as readonly string[]).includes(v)
    ? (v as ImageAlign)
    : 'center';
export const sanitizeWidth = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && (IMAGE_WIDTHS as readonly number[]).includes(n) ? n : null;
};
export const sanitizeAlt = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, MAX_ALT) : '';

export interface ImageOptions {
  /** Enregistre un fichier image et retourne son empreinte ; `undefined` si refusé (l'erreur est déjà signalée). */
  upload(file: File): Promise<string | undefined>;
  /** URL affichable (blob:) pour une empreinte. */
  load(hash: string): Promise<string>;
  missing: string;
  open(hash: string, alt: string): void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    imageFigure: {
      insertImage: (a: { hash: string; alt?: string }) => ReturnType;
      updateImage: (a: {
        alt?: string;
        align?: string;
        width?: number | null;
        hash?: string;
      }) => ReturnType;
    };
  }
}

const imageFiles = (list: FileList | readonly File[] | null | undefined) =>
  [...(list ?? [])].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));

/**
 * Image avec légende éditable. Le document ne contient que l'empreinte du fichier (jamais de base64) :
 * le fichier est dans le stockage local de Slate (voir `media.rs`).
 */
export const ImageFigure = Node.create<ImageOptions>({
  name: 'imageFigure',
  group: 'block',
  content: 'inline*',
  defining: true,
  draggable: true,
  addAttributes() {
    return {
      hash: {
        default: null,
        parseHTML: (el: HTMLElement) => sanitizeHash(el.getAttribute('data-hash')),
        renderHTML: (a: Record<string, unknown>) => {
          const h = sanitizeHash(a['hash']);
          return h ? { 'data-hash': h } : {};
        },
      },
      alt: {
        default: '',
        parseHTML: (el: HTMLElement) => sanitizeAlt(el.getAttribute('data-alt')),
        renderHTML: (a: Record<string, unknown>) => ({ 'data-alt': sanitizeAlt(a['alt']) }),
      },
      align: {
        default: 'center',
        parseHTML: (el: HTMLElement) => sanitizeAlign(el.getAttribute('data-align')),
        renderHTML: (a: Record<string, unknown>) => ({ 'data-align': sanitizeAlign(a['align']) }),
      },
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => sanitizeWidth(el.getAttribute('data-width')),
        renderHTML: (a: Record<string, unknown>) => {
          const w = sanitizeWidth(a['width']);
          return w ? { 'data-width': String(w) } : {};
        },
      },
    };
  },
  parseHTML: () => [{ tag: 'figure[data-image]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'figure',
    mergeAttributes(HTMLAttributes, { 'data-image': '' }),
    ['figcaption', 0],
  ],
  addCommands() {
    return {
      insertImage:
        ({ hash, alt }) =>
        ({ commands }) => {
          const h = sanitizeHash(hash);
          return h
            ? commands.insertContent({ type: this.name, attrs: { hash: h, alt: sanitizeAlt(alt) } })
            : false;
        },
      updateImage:
        (a) =>
        ({ commands }) => {
          const attrs: Record<string, unknown> = {};
          if (a.alt !== undefined) attrs['alt'] = sanitizeAlt(a.alt);
          if (a.align !== undefined) {
            if (!(IMAGE_ALIGNS as readonly string[]).includes(a.align)) return false; // refus, pas de remplacement silencieux
            attrs['align'] = a.align;
          }
          if (a.width !== undefined) {
            if (a.width !== null && sanitizeWidth(a.width) === null) return false;
            attrs['width'] = a.width;
          }
          if (a.hash !== undefined) {
            const h = sanitizeHash(a.hash);
            if (!h) return false;
            attrs['hash'] = h;
          }
          return commands.updateAttributes(this.name, attrs);
        },
    };
  },
  addNodeView() {
    const opts = this.options;
    return ({ node }) => {
      let current = node;
      const dom = document.createElement('figure');
      dom.setAttribute('data-image', '');
      const frame = document.createElement('div');
      frame.className = 'image-frame';
      frame.contentEditable = 'false';
      const img = document.createElement('img');
      img.draggable = false;
      const miss = document.createElement('p');
      miss.className = 'image-missing';
      miss.hidden = true;
      miss.textContent = opts.missing;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'image-open';
      open.addEventListener('mousedown', (e) => e.preventDefault());
      open.addEventListener('click', () => {
        const h = sanitizeHash(current.attrs['hash']);
        if (h) opts.open(h, sanitizeAlt(current.attrs['alt']));
      });
      open.append(img);
      frame.append(open, miss);
      const caption = document.createElement('figcaption');
      dom.append(frame, caption);

      let shown: string | null = null;
      const paint = () => {
        dom.setAttribute('data-align', sanitizeAlign(current.attrs['align']));
        const w = sanitizeWidth(current.attrs['width']);
        if (w) dom.setAttribute('data-width', String(w));
        else dom.removeAttribute('data-width');
        img.alt = sanitizeAlt(current.attrs['alt']);
        open.setAttribute('aria-label', sanitizeAlt(current.attrs['alt']) || opts.missing);
        const h = sanitizeHash(current.attrs['hash']);
        if (h === shown) return;
        shown = h;
        miss.hidden = true;
        img.removeAttribute('src');
        if (!h) {
          miss.hidden = false;
          return;
        }
        opts.load(h).then(
          (url) => {
            if (shown === h) img.src = url;
          },
          () => {
            if (shown === h) miss.hidden = false;
          },
        );
      };
      paint();
      return {
        dom,
        contentDOM: caption,
        update(n) {
          if (n.type !== current.type) return false;
          current = n;
          paint();
          return true;
        },
        ignoreMutation: (m) => frame.contains(m.target),
        stopEvent: (e) => frame.contains(e.target as globalThis.Node) && e.type !== 'dragstart',
      };
    };
  },
  addProseMirrorPlugins() {
    const { upload } = this.options;
    const editor = this.editor;
    const insertAll = async (files: File[], at?: number) => {
      for (const f of files) {
        const hash = await upload(f);
        if (!hash) continue;
        const content = {
          type: this.name,
          attrs: { hash, alt: sanitizeAlt(f.name.replace(/\.[^.]+$/, '')) },
        };
        if (at !== undefined) editor.chain().focus().insertContentAt(at, content).run();
        else editor.chain().focus().insertContent(content).run();
      }
    };
    return [
      new Plugin({
        props: {
          handlePaste: (_v, event) => {
            const files = imageFiles(event.clipboardData?.files);
            if (files.length === 0) return false;
            void insertAll(files);
            return true;
          },
          handleDrop: (view, event) => {
            const files = imageFiles(event.dataTransfer?.files);
            if (files.length === 0) return false;
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            void insertAll(files, pos);
            return true;
          },
        },
      }),
    ];
  },
});
