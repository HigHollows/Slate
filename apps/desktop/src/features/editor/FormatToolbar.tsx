import { Icon } from '@slate/icons';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, Popover, cx } from '../../shared/ui';
import { usePreferences, usePreferencesStore } from '../preferences';
import { pasteFromClipboard } from './clipboard';
import { SPACINGS } from './ParagraphFormat';
import type { PasteMode } from './paste';
import { IMAGE_INSERT_EVENT } from './ImageToolbar';
import { COMMENT_NEW_EVENT } from './CommentAnchor';
import {
  FONT_FAMILIES,
  FONT_SIZES,
  HIGHLIGHT_COLORS,
  LINE_HEIGHTS,
  TEXT_COLORS,
  cssColor,
  sanitizeColor,
  sanitizeFontSize,
} from './format';

function Btn({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // garde la sélection dans le document
      onClick={onClick}
      className={cx(
        'grid size-7 shrink-0 place-items-center rounded-md text-[0.8125rem] font-semibold hover:bg-hover disabled:opacity-40',
        active && 'bg-accent text-accent-fg hover:bg-accent',
      )}
    >
      {children}
    </button>
  );
}

const Sep = () => <span aria-hidden className="mx-1 h-4 w-px bg-line" />;

/** Quatre traits d'alignement : élément graphique minimal (Papicons n'a pas d'icône d'alignement). */
function AlignGlyph({ kind }: { kind: 'left' | 'center' | 'right' | 'justify' }) {
  const w = [14, 9, 14, 7];
  const x = (n: number) =>
    kind === 'left' || kind === 'justify' ? 1 : kind === 'right' ? 15 - n : (16 - n) / 2;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="currentColor">
      {w.map((n, i) => (
        <rect
          key={i}
          x={x(kind === 'justify' ? 14 : n)}
          y={2.5 + i * 3.5}
          width={kind === 'justify' ? 14 : n}
          height="1.5"
          rx=".5"
        />
      ))}
    </svg>
  );
}

function Swatch({
  value,
  kind,
  label,
  onPick,
}: {
  value: string;
  kind: 'text' | 'highlight';
  label: string;
  onPick(v: string): void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(value)}
      className="size-6 rounded-md border border-line hover:scale-110"
      style={
        kind === 'text'
          ? { color: cssColor(value, 'text'), background: 'var(--surface)' }
          : { background: cssColor(value, 'highlight') }
      }
    >
      {kind === 'text' ? <span className="text-xs font-bold">A</span> : null}
    </button>
  );
}

function ColorPicker({
  kind,
  onPick,
  onClear,
}: {
  kind: 'text' | 'highlight';
  onPick(v: string): void;
  onClear(): void;
}) {
  const { t } = useTranslation();
  const [hex, setHex] = useState('#');
  const valid = sanitizeColor(hex, kind) !== null && hex.startsWith('#');
  const palette = kind === 'text' ? TEXT_COLORS : HIGHLIGHT_COLORS;
  return (
    <div className="w-52 space-y-2 p-1">
      <div className="grid grid-cols-5 gap-1.5">
        {palette.map((c) => (
          <Swatch key={c} value={c} kind={kind} label={t(`editor.color.${c}`)} onPick={onPick} />
        ))}
      </div>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const v = sanitizeColor(hex, kind);
          if (v && valid) onPick(v);
        }}
      >
        <span
          aria-hidden
          className="size-6 shrink-0 rounded-md border border-line"
          style={{ background: valid ? hex : 'transparent' }}
        />
        <input
          aria-label={t('editor.colorHex')}
          aria-invalid={hex.length > 1 && !valid}
          value={hex}
          maxLength={7}
          onChange={(e) => setHex(e.target.value)}
          placeholder="#rrggbb"
          className="h-7 min-w-0 flex-1 select-text rounded-md border border-line bg-surface px-2 outline-none focus-visible:border-accent"
        />
        <button
          type="submit"
          disabled={!valid}
          className="h-7 rounded-md px-2 hover:bg-hover disabled:opacity-40"
        >
          {t('common.apply')}
        </button>
      </form>
      <button
        type="button"
        onClick={onClear}
        className="h-7 w-full rounded-md text-left px-2 text-muted hover:bg-hover"
      >
        {kind === 'text' ? t('editor.colorDefault') : t('editor.highlightNone')}
      </button>
    </div>
  );
}

const selectCls =
  'h-7 rounded-md border border-line bg-surface px-1.5 text-[0.8125rem] outline-none hover:bg-hover focus-visible:border-accent';

/** Barre d'outils fixe de mise en forme (réductible). Chaque contrôle agit réellement sur le document. */
export function FormatToolbar({ editor, onLink }: { editor: Editor; onLink(): void }) {
  const { t } = useTranslation();
  const prefs = usePreferencesStore();
  const collapsed = usePreferences((p) => p.prefs.toolbarCollapsed);
  const setCollapsed = (v: boolean) =>
    void prefs
      .getState()
      .update({ toolbarCollapsed: v })
      .catch(() => undefined);
  const [custom, setCustom] = useState('');
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const ts = e.getAttributes('textStyle') as Record<string, unknown>;
      const heading = ([1, 2, 3, 4, 5, 6] as const).find((level) =>
        e.isActive('heading', { level }),
      );
      return {
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        block: heading
          ? `h${heading}`
          : e.isActive('blockquote')
            ? 'quote'
            : e.isActive('codeBlock')
              ? 'code'
              : 'p',
        font: (ts['fontFamily'] as string | null) ?? '',
        size: (ts['fontSize'] as number | null) ?? null,
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        code: e.isActive('code'),
        sub: e.isActive('subscript'),
        sup: e.isActive('superscript'),
        highlight: e.isActive('highlight'),
        color: (ts['color'] as string | null) ?? null,
        left: e.isActive({ textAlign: 'left' }),
        center: e.isActive({ textAlign: 'center' }),
        right: e.isActive({ textAlign: 'right' }),
        justify: e.isActive({ textAlign: 'justify' }),
        bullet: e.isActive('bulletList'),
        ordered: e.isActive('orderedList'),
        task: e.isActive('taskList'),
        link: e.isActive('link'),
        table: e.isActive('table'),
        inList: e.isActive('listItem') || e.isActive('taskItem'),
      };
    },
  });
  const c = () => editor.chain().focus();

  const pasteMode = (mode: PasteMode) => void pasteFromClipboard(editor, mode, t);

  const setBlock = (v: string) => {
    if (v === 'p') c().setParagraph().run();
    else if (v === 'quote') c().setParagraph().toggleBlockquote().run();
    else if (v === 'code') c().toggleCodeBlock().run();
    else
      c()
        .setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6 })
        .run();
  };
  const applySize = (raw: string) => {
    const n = sanitizeFontSize(raw);
    if (n) c().setFontSize(n).run();
  };

  if (collapsed) {
    return (
      <div className="mb-2 flex justify-center">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          aria-label={t('editor.toolbarShow')}
          title={t('editor.toolbarShow')}
          className="grid h-5 w-12 place-items-center rounded-b-md text-muted hover:bg-hover hover:text-fg"
        >
          <Icon name="chevron-down" size={14} />
        </button>
      </div>
    );
  }
  return (
    <div
      role="toolbar"
      aria-label={t('editor.toolbar')}
      className="sticky top-0 z-10 -mx-2 mb-4 flex flex-wrap items-center gap-0.5 rounded-lg bg-elevated/95 p-1 shadow-pop backdrop-blur"
    >
      <Menu
        trigger={
          <button
            type="button"
            aria-label={t('editor.paste')}
            title={t('editor.paste')}
            onMouseDown={(e) => e.preventDefault()}
            className="grid h-7 place-items-center rounded-md px-2 text-[0.8125rem] hover:bg-hover"
          >
            {t('editor.paste')}
          </button>
        }
        items={[
          {
            id: 'keep',
            label: t('editor.pasteKeep'),
            onSelect: () => pasteMode('keep'),
          },
          {
            id: 'compatible',
            label: t('editor.pasteCompatible'),
            onSelect: () => pasteMode('compatible'),
          },
          {
            id: 'plain',
            label: t('editor.pastePlain'),
            onSelect: () => pasteMode('plain'),
          },
        ]}
      />
      <Sep />
      <Btn label={t('editor.undo')} disabled={!s.canUndo} onClick={() => c().undo().run()}>
        <Icon name="arrow-left-down" size={15} />
      </Btn>
      <Btn label={t('editor.redo')} disabled={!s.canRedo} onClick={() => c().redo().run()}>
        <Icon name="arrow-right-down" size={15} />
      </Btn>
      <Sep />
      <select
        aria-label={t('editor.paragraphStyle')}
        className={selectCls}
        value={s.block}
        onChange={(e) => setBlock(e.target.value)}
      >
        <option value="p">{t('editor.style.p')}</option>
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <option key={n} value={`h${n}`}>
            {t('editor.style.heading', { n })}
          </option>
        ))}
        <option value="quote">{t('editor.style.quote')}</option>
        <option value="code">{t('editor.style.code')}</option>
      </select>
      <select
        aria-label={t('editor.font')}
        className={selectCls}
        value={s.font}
        onChange={(e) =>
          e.target.value ? c().setFontFamily(e.target.value).run() : c().unsetFontFamily().run()
        }
      >
        <option value="">{t('editor.fontDefault')}</option>
        {FONT_FAMILIES.map((f) => (
          <option key={f} value={f}>
            {t(`editor.fonts.${f}`)}
          </option>
        ))}
      </select>
      <select
        aria-label={t('editor.fontSize')}
        className={cx(selectCls, 'w-16')}
        value={
          s.size !== null && (FONT_SIZES as readonly number[]).includes(s.size)
            ? String(s.size)
            : ''
        }
        onChange={(e) => (e.target.value ? applySize(e.target.value) : c().unsetFontSize().run())}
      >
        <option value="">{s.size !== null ? String(s.size) : t('editor.sizeDefault')}</option>
        {FONT_SIZES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <input
        aria-label={t('editor.fontSizeCustom')}
        inputMode="numeric"
        value={custom}
        placeholder="px"
        maxLength={2}
        onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            applySize(custom);
            setCustom('');
          }
        }}
        className="h-7 w-10 select-text rounded-md border border-line bg-surface px-1.5 text-center outline-none focus-visible:border-accent"
      />
      <Sep />
      <Btn label={t('editor.bold')} active={s.bold} onClick={() => c().toggleBold().run()}>
        <Icon name="bold" size={15} />
      </Btn>
      <Btn label={t('editor.italic')} active={s.italic} onClick={() => c().toggleItalic().run()}>
        <span className="italic">I</span>
      </Btn>
      <Btn
        label={t('editor.underline')}
        active={s.underline}
        onClick={() => c().toggleUnderline().run()}
      >
        <Icon name="underline" size={15} />
      </Btn>
      <Btn label={t('editor.strike')} active={s.strike} onClick={() => c().toggleStrike().run()}>
        <span className="line-through">S</span>
      </Btn>
      <Btn label={t('editor.subscript')} active={s.sub} onClick={() => c().toggleSubscript().run()}>
        <span>
          x<sub className="text-[0.6rem]">2</sub>
        </span>
      </Btn>
      <Btn
        label={t('editor.superscript')}
        active={s.sup}
        onClick={() => c().toggleSuperscript().run()}
      >
        <span>
          x<sup className="text-[0.6rem]">2</sup>
        </span>
      </Btn>
      <Btn label={t('editor.inlineCode')} active={s.code} onClick={() => c().toggleCode().run()}>
        <Icon name="code" size={15} />
      </Btn>
      <Sep />
      <Popover
        label={t('editor.textColor')}
        trigger={
          <button
            type="button"
            aria-label={t('editor.textColor')}
            title={t('editor.textColor')}
            onMouseDown={(e) => e.preventDefault()}
            className="grid size-7 place-items-center rounded-md hover:bg-hover"
          >
            <span
              className="text-sm font-bold"
              style={s.color ? { color: cssColor(s.color, 'text') } : undefined}
            >
              A
            </span>
          </button>
        }
      >
        <ColorPicker
          kind="text"
          onPick={(v) => c().setTextColor(v).run()}
          onClear={() => c().unsetTextColor().run()}
        />
      </Popover>
      <Popover
        label={t('editor.highlight')}
        trigger={
          <button
            type="button"
            aria-label={t('editor.highlight')}
            aria-pressed={s.highlight}
            title={t('editor.highlight')}
            onMouseDown={(e) => e.preventDefault()}
            className={cx(
              'grid size-7 place-items-center rounded-md hover:bg-hover',
              s.highlight && 'bg-pressed',
            )}
          >
            <Icon name="pen-alt" size={15} />
          </button>
        }
      >
        <ColorPicker
          kind="highlight"
          onPick={(v) => c().setHighlight({ color: v }).run()}
          onClear={() => c().unsetHighlight().run()}
        />
      </Popover>
      <Sep />
      {(['left', 'center', 'right', 'justify'] as const).map((a) => (
        <Btn
          key={a}
          label={t(`editor.align.${a}`)}
          active={s[a]}
          onClick={() => c().setTextAlign(a).run()}
        >
          <AlignGlyph kind={a} />
        </Btn>
      ))}
      <select
        aria-label={t('editor.lineHeight')}
        className={cx(selectCls, 'w-16')}
        defaultValue=""
        onChange={(e) => {
          if (e.target.value === 'reset') c().unsetLineHeight().run();
          else if (e.target.value) c().setLineHeight(e.target.value).run();
          e.target.value = '';
        }}
      >
        <option value="">{t('editor.lineHeightShort')}</option>
        {LINE_HEIGHTS.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
        <option value="reset">{t('editor.lineHeightReset')}</option>
      </select>
      <Sep />
      <Btn
        label={t('editor.bulletList')}
        active={s.bullet}
        onClick={() => c().toggleBulletList().run()}
      >
        <Icon name="list" size={15} />
      </Btn>
      <Btn
        label={t('editor.orderedList')}
        active={s.ordered}
        onClick={() => c().toggleOrderedList().run()}
      >
        <span className="text-xs">1.</span>
      </Btn>
      <Btn label={t('editor.taskList')} active={s.task} onClick={() => c().toggleTaskList().run()}>
        <Icon name="tasks" size={15} />
      </Btn>
      <Btn label={t('editor.outdent')} onClick={() => c().decreaseIndent().run()}>
        <Icon name="arrow-left" size={15} />
      </Btn>
      <Btn label={t('editor.indent')} onClick={() => c().increaseIndent().run()}>
        <Icon name="arrow-right" size={15} />
      </Btn>
      <Popover
        label={t('editor.paragraphTools')}
        trigger={
          <button
            type="button"
            aria-label={t('editor.paragraph')}
            title={t('editor.paragraph')}
            onMouseDown={(e) => e.preventDefault()}
            className="grid h-7 place-items-center rounded-md px-2 text-[0.8125rem] hover:bg-hover"
          >
            ¶
          </button>
        }
      >
        <div className="w-60 space-y-2 p-1 text-[0.8125rem]">
          <div className="flex items-center justify-between gap-2">
            <span>{t('editor.indentRight')}</span>
            <span className="flex gap-1">
              <button
                type="button"
                aria-label={t('editor.outdentRight')}
                className="size-7 rounded-md hover:bg-hover"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor.commands.decreaseRightIndent()}
              >
                −
              </button>
              <button
                type="button"
                aria-label={t('editor.indentRight')}
                className="size-7 rounded-md hover:bg-hover"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor.commands.increaseRightIndent()}
              >
                +
              </button>
            </span>
          </div>
          {(['before', 'after'] as const).map((side) => (
            <label key={side} className="flex items-center justify-between gap-2">
              <span>{side === 'before' ? t('editor.spaceBefore') : t('editor.spaceAfter')}</span>
              <select
                aria-label={side === 'before' ? t('editor.spaceBefore') : t('editor.spaceAfter')}
                defaultValue=""
                className={selectCls}
                onChange={(e) => {
                  const v = e.target.value === '' ? null : Number(e.target.value);
                  // sans reprendre le focus : le menu reste ouvert pour régler plusieurs valeurs de suite
                  editor.commands.setParagraphSpacing(
                    side === 'before' ? { before: v } : { after: v },
                  );
                }}
              >
                <option value="">{t('editor.spaceNone')}</option>
                {SPACINGS.filter((n) => n > 0).map((n) => (
                  <option key={n} value={n}>
                    {n} px
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button
            type="button"
            className="h-7 w-full rounded-md px-2 text-left text-muted hover:bg-hover"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor.commands.resetParagraphFormat()}
          >
            {t('editor.resetParagraph')}
          </button>
        </div>
      </Popover>
      <Sep />
      <Btn
        label={t('comments.add')}
        onClick={() => window.dispatchEvent(new Event(COMMENT_NEW_EVENT))}
      >
        <Icon name="text-bubble" size={15} />
      </Btn>
      <Btn label={t('editor.link')} active={s.link} onClick={onLink}>
        <Icon name="link" size={15} />
      </Btn>
      <Btn
        label={t('editor.image.insert')}
        onClick={() => window.dispatchEvent(new Event(IMAGE_INSERT_EVENT))}
      >
        <Icon name="gallery" size={15} />
      </Btn>
      <Btn
        label={t('editor.insertTable')}
        active={s.table}
        onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        <Icon name="grid" size={15} />
      </Btn>
      <Btn label={t('editor.clearFormatting')} onClick={() => c().clearFormatting().run()}>
        <span className="text-xs">
          T<span className="align-super text-[0.55rem]">x</span>
        </span>
      </Btn>
      <span className="ml-auto" />
      <Btn label={t('editor.toolbarHide')} onClick={() => setCollapsed(true)}>
        <Icon name="chevron-up" size={14} />
      </Btn>
    </div>
  );
}
