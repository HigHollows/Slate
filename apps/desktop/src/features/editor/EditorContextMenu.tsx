import * as M from '@radix-ui/react-dropdown-menu';
import type { Editor } from '@tiptap/react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../../shared/ui';
import { COMMENT_NEW_EVENT } from './CommentAnchor';
import { pasteFromClipboard } from './clipboard';
import { HIGHLIGHT_COLORS, TEXT_COLORS, cssColor } from './format';
import { IMAGE_INSERT_EVENT } from './ImageToolbar';
import { LINK_OPEN_EVENT } from './LinkOpen';

const item =
  'flex h-[var(--row-h)] cursor-default select-none items-center gap-2 rounded-md px-2 text-[0.8125rem] outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40';
const panel = 'anim-pop z-50 min-w-48 rounded-lg bg-elevated p-1 shadow-pop';
const sep = <M.Separator className="my-1 h-px bg-line" />;

// Composants au niveau du module : leur identité est stable d'un rendu à l'autre (sinon les éléments seraient
// remontés au milieu d'un clic dès que l'éditeur se rafraîchit).
function Item({
  label,
  onSelect,
  disabled,
  shortcut,
}: {
  label: string;
  onSelect(): void;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <M.Item className={item} disabled={disabled ?? false} onSelect={onSelect}>
      <span className="flex-1">{label}</span>
      {shortcut ? <span className="text-xs text-muted">{shortcut}</span> : null}
    </M.Item>
  );
}

function Toggle({
  label,
  checked,
  onSelect,
  shortcut,
}: {
  label: string;
  checked: boolean;
  onSelect(): void;
  shortcut?: string;
}) {
  return (
    <M.CheckboxItem className={item} checked={checked} onSelect={onSelect}>
      <span className="w-4 text-center">
        <M.ItemIndicator>✓</M.ItemIndicator>
      </span>
      <span className="flex-1">{label}</span>
      {shortcut ? <span className="text-xs text-muted">{shortcut}</span> : null}
    </M.CheckboxItem>
  );
}

function Sub({ label, children }: { label: string; children: ReactNode }) {
  return (
    <M.Sub>
      <M.SubTrigger className={item}>
        <span className="flex-1">{label}</span>
        <span aria-hidden className="text-muted">
          ›
        </span>
      </M.SubTrigger>
      <M.Portal>
        <M.SubContent className={panel} sideOffset={4} alignOffset={-4}>
          {children}
        </M.SubContent>
      </M.Portal>
    </M.Sub>
  );
}

/** État capturé à l'ouverture du menu : ce qui est affiché dépend de ce qui est sous le curseur. */
interface Ctx {
  x: number;
  y: number;
  editable: boolean;
  hasSelection: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  href: string | null;
  inTable: boolean;
  onImage: boolean;
}

function capture(editor: Editor, x: number, y: number): Ctx {
  const { from, to } = editor.state.selection;
  return {
    x,
    y,
    editable: editor.isEditable,
    hasSelection: from !== to,
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    strike: editor.isActive('strike'),
    code: editor.isActive('code'),
    href: (editor.getAttributes('link')['href'] as string | undefined) ?? null,
    inTable: editor.isActive('table'),
    onImage: editor.isActive('imageFigure'),
  };
}

/** Menu du clic droit : actions rapides et traitement de texte, adaptées au contexte (sélection, lien, tableau, image, lecture seule). */
export function EditorContextMenu({ editor, onLink }: { editor: Editor; onLink(): void }) {
  const { t } = useTranslation();
  const [ctx, setCtx] = useState<Ctx | null>(null);

  useEffect(() => {
    const dom = editor.view.dom;
    const onMenu = (e: MouseEvent) => {
      e.preventDefault();
      // Un clic droit hors de la sélection place le curseur à l'endroit cliqué (comme un traitement de texte).
      const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      const { from, to } = editor.state.selection;
      if (
        hit &&
        (hit.pos < from || hit.pos > to) &&
        !(e.target as HTMLElement).closest?.('figure[data-image]')
      ) {
        editor.commands.setTextSelection(hit.pos);
      }
      setCtx(capture(editor, e.clientX, e.clientY));
    };
    dom.addEventListener('contextmenu', onMenu);
    return () => dom.removeEventListener('contextmenu', onMenu);
  }, [editor]);

  if (!ctx) return null;
  const c = () => editor.chain().focus();
  const close = () => setCtx(null);
  const run = (f: () => unknown) => () => void f();
  const clip = (cmd: 'cut' | 'copy') => () => {
    editor.commands.focus();
    if (typeof document.execCommand !== 'function' || !document.execCommand(cmd))
      toast.error(t('contextMenu.clipboardFailed'));
  };
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  const hasLink = ctx.href !== null;

  return (
    <M.Root open onOpenChange={(o) => !o && close()} modal={false}>
      <M.Trigger asChild>
        <span
          aria-hidden
          aria-label={t('contextMenu.label')}
          style={{
            position: 'fixed',
            left: ctx.x,
            top: ctx.y,
            width: 1,
            height: 1,
            pointerEvents: 'none',
          }}
        />
      </M.Trigger>
      <M.Portal>
        <M.Content
          aria-label={t('contextMenu.label')}
          className={panel}
          align="start"
          side="bottom"
          sideOffset={2}
          collisionPadding={8}
          // Un changement de focus (l'éditeur qui se rafraîchit, une barre flottante) ne doit pas refermer le menu ;
          // un clic ailleurs ou Échap le ferment toujours.
          onFocusOutside={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (!editor.isDestroyed) editor.commands.focus();
          }}
        >
          {ctx.editable ? (
            <>
              <Item
                label={t('contextMenu.cut')}
                disabled={!ctx.hasSelection}
                onSelect={clip('cut')}
                shortcut={`${mod}X`}
              />
              <Item
                label={t('contextMenu.copy')}
                disabled={!ctx.hasSelection}
                onSelect={clip('copy')}
                shortcut={`${mod}C`}
              />
              <Sub label={t('contextMenu.paste')}>
                <Item
                  label={t('editor.pasteKeep')}
                  onSelect={() => void pasteFromClipboard(editor, 'keep', t)}
                />
                <Item
                  label={t('editor.pasteCompatible')}
                  onSelect={() => void pasteFromClipboard(editor, 'compatible', t)}
                />
                <Item
                  label={t('editor.pastePlain')}
                  onSelect={() => void pasteFromClipboard(editor, 'plain', t)}
                />
              </Sub>
              <Item
                label={t('contextMenu.selectAll')}
                onSelect={run(() => editor.commands.selectAll())}
                shortcut={`${mod}A`}
              />
              {sep}
              <Toggle
                label={t('editor.bold')}
                checked={ctx.bold}
                onSelect={run(() => c().toggleBold().run())}
                shortcut={`${mod}B`}
              />
              <Toggle
                label={t('editor.italic')}
                checked={ctx.italic}
                onSelect={run(() => c().toggleItalic().run())}
                shortcut={`${mod}I`}
              />
              <Toggle
                label={t('editor.underline')}
                checked={ctx.underline}
                onSelect={run(() => c().toggleUnderline().run())}
                shortcut={`${mod}U`}
              />
              <Toggle
                label={t('editor.strike')}
                checked={ctx.strike}
                onSelect={run(() => c().toggleStrike().run())}
              />
              <Toggle
                label={t('editor.inlineCode')}
                checked={ctx.code}
                onSelect={run(() => c().toggleCode().run())}
              />
              <Sub label={t('editor.textColor')}>
                {TEXT_COLORS.map((col) => (
                  <M.Item
                    key={col}
                    className={item}
                    onSelect={run(() => c().setTextColor(col).run())}
                  >
                    <span
                      aria-hidden
                      className="size-3.5 rounded-sm border border-line"
                      style={{ background: cssColor(col, 'text') }}
                    />
                    {t(`editor.color.${col}`)}
                  </M.Item>
                ))}
                <Item
                  label={t('editor.colorDefault')}
                  onSelect={run(() => c().unsetTextColor().run())}
                />
              </Sub>
              <Sub label={t('editor.highlight')}>
                {HIGHLIGHT_COLORS.map((col) => (
                  <M.Item
                    key={col}
                    className={item}
                    onSelect={run(() => c().setHighlight({ color: col }).run())}
                  >
                    <span
                      aria-hidden
                      className="size-3.5 rounded-sm border border-line"
                      style={{ background: cssColor(col, 'highlight') }}
                    />
                    {t(`editor.color.${col}`)}
                  </M.Item>
                ))}
                <Item
                  label={t('editor.highlightNone')}
                  onSelect={run(() => c().unsetHighlight().run())}
                />
              </Sub>
              <Item
                label={t('editor.clearFormatting')}
                onSelect={run(() => c().clearFormatting().run())}
                shortcut={`${mod}\\`}
              />
              {sep}
              <Sub label={t('editor.paragraph')}>
                <Item label={t('editor.style.p')} onSelect={run(() => c().setParagraph().run())} />
                {([1, 2, 3, 4, 5, 6] as const).map((n) => (
                  <Item
                    key={n}
                    label={t('editor.style.heading', { n })}
                    onSelect={run(() => c().setHeading({ level: n }).run())}
                  />
                ))}
                <Item
                  label={t('editor.style.quote')}
                  onSelect={run(() => c().toggleBlockquote().run())}
                />
                <Item
                  label={t('editor.style.code')}
                  onSelect={run(() => c().toggleCodeBlock().run())}
                />
                {sep}
                {(['left', 'center', 'right', 'justify'] as const).map((a) => (
                  <Item
                    key={a}
                    label={t(`editor.align.${a}`)}
                    onSelect={run(() => c().setTextAlign(a).run())}
                  />
                ))}
                {sep}
                <Item label={t('editor.indent')} onSelect={run(() => c().increaseIndent().run())} />
                <Item
                  label={t('editor.outdent')}
                  onSelect={run(() => c().decreaseIndent().run())}
                />
              </Sub>
              <Sub label={t('contextMenu.lists')}>
                <Item
                  label={t('editor.bulletList')}
                  onSelect={run(() => c().toggleBulletList().run())}
                  shortcut={`${mod}⇧8`}
                />
                <Item
                  label={t('editor.orderedList')}
                  onSelect={run(() => c().toggleOrderedList().run())}
                  shortcut={`${mod}⇧7`}
                />
                <Item
                  label={t('editor.taskList')}
                  onSelect={run(() => c().toggleTaskList().run())}
                />
              </Sub>
              <Sub label={t('contextMenu.insert')}>
                <Item
                  label={t('editor.insertTable')}
                  onSelect={run(() =>
                    c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
                  )}
                />
                <Item
                  label={t('editor.image.insert')}
                  onSelect={() => window.dispatchEvent(new Event(IMAGE_INSERT_EVENT))}
                />
                <Item
                  label={t('slash.divider.title')}
                  onSelect={run(() => c().setHorizontalRule().run())}
                />
                <Item
                  label={t('slash.callout.title')}
                  onSelect={run(() => c().toggleCallout('note').run())}
                />
                <Item
                  label={t('slash.details.title')}
                  onSelect={run(() => c().setDetails().run())}
                />
                <Item label={t('slash.toc.title')} onSelect={run(() => c().insertToc().run())} />
              </Sub>
              {ctx.inTable ? (
                <Sub label={t('contextMenu.table')}>
                  <Item
                    label={t('editor.table.rowBefore')}
                    onSelect={run(() => c().addRowBefore().run())}
                  />
                  <Item
                    label={t('editor.table.rowAfter')}
                    onSelect={run(() => c().addRowAfter().run())}
                  />
                  <Item
                    label={t('editor.table.rowDelete')}
                    onSelect={run(() => c().deleteRow().run())}
                  />
                  {sep}
                  <Item
                    label={t('editor.table.colBefore')}
                    onSelect={run(() => c().addColumnBefore().run())}
                  />
                  <Item
                    label={t('editor.table.colAfter')}
                    onSelect={run(() => c().addColumnAfter().run())}
                  />
                  <Item
                    label={t('editor.table.colDelete')}
                    onSelect={run(() => c().deleteColumn().run())}
                  />
                  {sep}
                  <Item
                    label={t('editor.table.merge')}
                    onSelect={run(() => c().mergeCells().run())}
                  />
                  <Item
                    label={t('editor.table.split')}
                    onSelect={run(() => c().splitCell().run())}
                  />
                  <Item
                    label={t('editor.table.delete')}
                    onSelect={run(() => c().deleteTable().run())}
                  />
                </Sub>
              ) : null}
              {ctx.onImage ? (
                <Item
                  label={t('editor.image.remove')}
                  onSelect={run(() => c().deleteNode('imageFigure').run())}
                />
              ) : null}
              {sep}
              <Item
                label={hasLink ? t('editor.linkEdit') : t('editor.link')}
                onSelect={onLink}
                shortcut={`${mod}⇧K`}
              />
              <Item
                label={t('comments.add')}
                disabled={!ctx.hasSelection}
                onSelect={() => window.dispatchEvent(new Event(COMMENT_NEW_EVENT))}
              />
            </>
          ) : (
            <>
              <Item
                label={t('contextMenu.copy')}
                disabled={!ctx.hasSelection}
                onSelect={clip('copy')}
                shortcut={`${mod}C`}
              />
              <Item
                label={t('contextMenu.selectAll')}
                onSelect={run(() => editor.commands.selectAll())}
                shortcut={`${mod}A`}
              />
            </>
          )}
          {hasLink ? (
            <>
              {sep}
              <Item
                label={t('editor.linkOpen')}
                onSelect={() =>
                  window.dispatchEvent(new CustomEvent(LINK_OPEN_EVENT, { detail: ctx.href }))
                }
              />
              <Item
                label={t('editor.linkCopy')}
                onSelect={() =>
                  void navigator.clipboard.writeText(ctx.href ?? '').then(
                    () => toast.success(t('editor.linkCopied')),
                    () => toast.error(t('editor.linkCopyFailed')),
                  )
                }
              />
              {ctx.editable ? (
                <Item
                  label={t('editor.linkRemove')}
                  onSelect={run(() => c().extendMarkRange('link').unsetLink().run())}
                />
              ) : null}
            </>
          ) : null}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
