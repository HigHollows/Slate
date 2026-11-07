import { mergeAttributes } from '@tiptap/core';
import CodeBlockLowlight, {
  type CodeBlockLowlightOptions,
} from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';

export const CODE_LANGUAGES = [
  'plaintext',
  'javascript',
  'typescript',
  'html',
  'css',
  'json',
  'python',
  'rust',
  'sql',
  'bash',
  'markdown',
  'yaml',
  'java',
  'c',
  'cpp',
] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];
export const sanitizeLanguage = (v: unknown): CodeLanguage =>
  typeof v === 'string' && (CODE_LANGUAGES as readonly string[]).includes(v)
    ? (v as CodeLanguage)
    : 'plaintext';

export const lowlight = createLowlight(common);

export interface CodeLabels {
  language: string;
  copy: string;
  copied: string;
  copyFailed: string;
  lineNumbers: string;
  collapse: string;
  expand: string;
  languageName(id: string): string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    codeBlockPro: {
      setCodeLanguage: (language: string) => ReturnType;
      toggleCodeLineNumbers: () => ReturnType;
      toggleCodeCollapsed: () => ReturnType;
    };
  }
}

const bool = (v: unknown) => v === true || v === 'true';

/**
 * Bloc de code : langage (liste blanche), coloration syntaxique (lowlight), numéros de ligne, copie, repli.
 * Le code est du TEXTE : jamais interprété comme HTML (aucune insertion par `innerHTML`).
 */
export const CodeBlock = CodeBlockLowlight.extend<
  CodeBlockLowlightOptions & { labels: CodeLabels }
>({
  addOptions() {
    const parent = (this.parent?.() ?? {}) as Record<string, unknown>;
    return {
      ...parent,
      lowlight,
      defaultLanguage: 'plaintext',
      labels: {
        language: 'Langage',
        copy: 'Copier',
        copied: 'Copié',
        copyFailed: 'Copie impossible',
        lineNumbers: 'Numéros de ligne',
        collapse: 'Replier',
        expand: 'Déplier',
        languageName: (id: string) => id,
      },
    } as never;
  },
  addAttributes() {
    return {
      language: {
        default: 'plaintext',
        parseHTML: (el: HTMLElement) =>
          sanitizeLanguage(
            el.getAttribute('data-language') ??
              /language-([\w+-]+)/
                .exec(el.querySelector('code')?.className ?? '')?.[1]
                ?.replace('js', 'javascript'),
          ),
        renderHTML: (a: Record<string, unknown>) => ({
          'data-language': sanitizeLanguage(a['language']),
        }),
      },
      lineNumbers: {
        default: false,
        parseHTML: (el: HTMLElement) => bool(el.getAttribute('data-line-numbers')),
        renderHTML: (a: Record<string, unknown>) =>
          bool(a['lineNumbers']) ? { 'data-line-numbers': 'true' } : {},
      },
      collapsed: {
        default: false,
        parseHTML: (el: HTMLElement) => bool(el.getAttribute('data-collapsed')),
        renderHTML: (a: Record<string, unknown>) =>
          bool(a['collapsed']) ? { 'data-collapsed': 'true' } : {},
      },
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['pre', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), ['code', {}, 0]];
    void node;
  },
  addCommands() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      setCodeLanguage:
        (language: string) =>
        ({ commands }: { commands: { updateAttributes: (n: string, a: object) => boolean } }) =>
          commands.updateAttributes(this.name, { language: sanitizeLanguage(language) }),
      toggleCodeLineNumbers:
        () =>
        ({
          editor,
          commands,
        }: {
          editor: { getAttributes: (n: string) => Record<string, unknown> };
          commands: { updateAttributes: (n: string, a: object) => boolean };
        }) =>
          commands.updateAttributes(this.name, {
            lineNumbers: !bool(editor.getAttributes(this.name)['lineNumbers']),
          }),
      toggleCodeCollapsed:
        () =>
        ({
          editor,
          commands,
        }: {
          editor: { getAttributes: (n: string) => Record<string, unknown> };
          commands: { updateAttributes: (n: string, a: object) => boolean };
        }) =>
          commands.updateAttributes(this.name, {
            collapsed: !bool(editor.getAttributes(this.name)['collapsed']),
          }),
    } as never;
  },
  addNodeView() {
    const labels = this.options.labels;
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'code-block';
      const head = document.createElement('div');
      head.className = 'code-head';
      head.contentEditable = 'false';

      const select = document.createElement('select');
      select.setAttribute('aria-label', labels.language);
      for (const id of CODE_LANGUAGES) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = labels.languageName(id);
        select.append(o);
      }
      const act = (f: () => void) => {
        const pos = getPos();
        if (typeof pos === 'number') editor.chain().setNodeSelection(pos).run();
        f();
      };
      select.addEventListener('change', () =>
        act(() => void editor.chain().focus().setCodeLanguage(select.value).run()),
      );

      const mk = (cls: string) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.addEventListener('mousedown', (e) => e.preventDefault());
        return b;
      };
      const numbers = mk('code-numbers');
      numbers.textContent = labels.lineNumbers;
      numbers.addEventListener('click', () =>
        act(() => void editor.chain().focus().toggleCodeLineNumbers().run()),
      );
      const fold = mk('code-fold');
      fold.addEventListener('click', () =>
        act(() => void editor.chain().focus().toggleCodeCollapsed().run()),
      );
      const copy = mk('code-copy');
      copy.textContent = labels.copy;
      const status = document.createElement('span');
      status.setAttribute('role', 'status');
      status.className = 'sr-only';
      let timer: ReturnType<typeof setTimeout> | undefined;
      copy.addEventListener('click', () => {
        const flash = (text: string) => {
          copy.textContent = text;
          status.textContent = text;
          clearTimeout(timer);
          timer = setTimeout(() => {
            copy.textContent = labels.copy;
            status.textContent = '';
          }, 1500);
        };
        navigator.clipboard.writeText(current.textContent).then(
          () => flash(labels.copied),
          () => flash(labels.copyFailed),
        );
      });
      head.append(select, numbers, fold, copy, status);

      const body = document.createElement('div');
      body.className = 'code-body';
      const gutter = document.createElement('div');
      gutter.className = 'code-gutter';
      gutter.setAttribute('aria-hidden', 'true');
      gutter.contentEditable = 'false';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      pre.append(code);
      body.append(gutter, pre);
      dom.append(head, body);

      const paint = () => {
        const lang = sanitizeLanguage(current.attrs['language']);
        select.value = lang;
        const nums = bool(current.attrs['lineNumbers']);
        const collapsed = bool(current.attrs['collapsed']);
        dom.dataset['language'] = lang;
        dom.dataset['lineNumbers'] = String(nums);
        dom.dataset['collapsed'] = String(collapsed);
        numbers.setAttribute('aria-pressed', String(nums));
        fold.textContent = collapsed ? labels.expand : labels.collapse;
        fold.setAttribute('aria-expanded', String(!collapsed));
        gutter.hidden = !nums;
        if (nums) {
          const n = current.textContent.split('\n').length;
          gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
        }
      };
      paint();
      return {
        dom,
        contentDOM: code,
        update(n) {
          if (n.type !== current.type) return false;
          current = n;
          paint();
          return true;
        },
        ignoreMutation: (m) => head.contains(m.target) || gutter.contains(m.target),
        stopEvent: (e) => head.contains(e.target as Node),
        destroy: () => clearTimeout(timer),
      };
    };
  },
});
