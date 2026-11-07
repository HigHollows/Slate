import { Icon } from '@slate/icons';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { Popover, cx } from '../../shared/ui';
import { CALLOUT_VARIANTS, sanitizeVariant } from './Callout';
import { HIGHLIGHT_COLORS, cssColor } from './format';
import { BULLET_STYLES, ORDERED_STYLES } from './ParagraphFormat';

const btn =
  'flex h-7 items-center gap-1 rounded-md px-2 text-[0.8125rem] hover:bg-hover disabled:opacity-40';

/** Barre contextuelle : n'apparaît que dans un tableau ou un encadré, avec des commandes qui agissent réellement. */
export function BlockToolbar({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      table: e.isActive('table'),
      callout: e.isActive('callout'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      listStyle:
        (e.getAttributes(e.isActive('orderedList') ? 'orderedList' : 'bulletList')['listStyle'] as
          string | null) ?? '',
      progress: e.isActive('taskList') && e.getAttributes('taskList')['progress'] === true,
      variant: sanitizeVariant(e.getAttributes('callout')['variant']),
      canMerge: e.can().mergeCells(),
      canSplit: e.can().splitCell(),
      headerRow: e.isActive('tableHeader'),
    }),
  });
  const inList = s.bullet || s.ordered || s.task;
  if (!s.table && !s.callout && !inList) return null;
  const c = () => editor.chain().focus();
  const tb = (label: string, run: () => boolean | void, disabled = false) => (
    <button
      key={label}
      type="button"
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void run()}
      className={btn}
    >
      {label}
    </button>
  );
  return (
    <div
      role="toolbar"
      aria-label={
        s.table
          ? t('editor.tableTools')
          : s.callout
            ? t('editor.calloutTools')
            : t('editor.listTools')
      }
      className="-mx-2 mb-4 flex flex-wrap items-center gap-0.5 rounded-lg bg-surface p-1"
    >
      {inList ? (
        <>
          {s.bullet || s.ordered ? (
            <select
              aria-label={t('editor.listStyle')}
              value={s.listStyle}
              onChange={(e) => e.target.value && c().setListStyle(e.target.value).run()}
              className="h-7 rounded-md border border-line bg-surface px-1.5 text-[0.8125rem] outline-none focus-visible:border-accent"
            >
              <option value="">{t('editor.fontDefault')}</option>
              {(s.ordered ? ORDERED_STYLES : BULLET_STYLES).map((v) => (
                <option key={v} value={v}>
                  {t(`editor.listStyles.${v}`)}
                </option>
              ))}
            </select>
          ) : null}
          {s.task ? (
            <button
              type="button"
              aria-pressed={s.progress}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void c().toggleTaskProgress().run()}
              className={cx(btn, s.progress && 'bg-accent text-accent-fg hover:bg-accent')}
            >
              {t('editor.taskProgressToggle')}
            </button>
          ) : null}
          {tb(t('editor.moveUp'), () => c().moveListItem(-1).run())}
          {tb(t('editor.moveDown'), () => c().moveListItem(1).run())}
        </>
      ) : null}
      {s.callout ? (
        <>
          <select
            aria-label={t('editor.calloutType')}
            value={s.variant}
            onChange={(e) =>
              c()
                .setCalloutVariant(e.target.value as (typeof CALLOUT_VARIANTS)[number])
                .run()
            }
            className="h-7 rounded-md border border-line bg-surface px-1.5 text-[0.8125rem] outline-none focus-visible:border-accent"
          >
            {CALLOUT_VARIANTS.map((v) => (
              <option key={v} value={v}>
                {t(`editor.callout.${v}`)}
              </option>
            ))}
          </select>
          {tb(t('editor.calloutRemove'), () => c().lift('callout').run())}
        </>
      ) : null}
      {s.table ? (
        <>
          {tb(t('editor.table.rowBefore'), () => c().addRowBefore().run())}
          {tb(t('editor.table.rowAfter'), () => c().addRowAfter().run())}
          {tb(t('editor.table.rowDelete'), () => c().deleteRow().run())}
          <span aria-hidden className="mx-1 h-4 w-px bg-line" />
          {tb(t('editor.table.colBefore'), () => c().addColumnBefore().run())}
          {tb(t('editor.table.colAfter'), () => c().addColumnAfter().run())}
          {tb(t('editor.table.colDelete'), () => c().deleteColumn().run())}
          <span aria-hidden className="mx-1 h-4 w-px bg-line" />
          {tb(t('editor.table.merge'), () => c().mergeCells().run(), !s.canMerge)}
          {tb(t('editor.table.split'), () => c().splitCell().run(), !s.canSplit)}
          {tb(t('editor.table.headerRow'), () => c().toggleHeaderRow().run())}
          {tb(t('editor.table.headerColumn'), () => c().toggleHeaderColumn().run())}
          <Popover
            label={t('editor.table.cellBackground')}
            trigger={
              <button type="button" onMouseDown={(e) => e.preventDefault()} className={cx(btn)}>
                <Icon name="palette" size={14} />
                {t('editor.table.cellBackground')}
              </button>
            }
          >
            <div className="grid w-44 grid-cols-6 gap-1.5 p-1">
              {HIGHLIGHT_COLORS.map((col) => (
                <button
                  key={col}
                  type="button"
                  aria-label={t(`editor.color.${col}`)}
                  title={t(`editor.color.${col}`)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => c().setCellBackground(col).run()}
                  className="size-6 rounded-md border border-line"
                  style={{ background: cssColor(col, 'highlight') }}
                />
              ))}
              <button
                type="button"
                aria-label={t('editor.table.cellBackgroundNone')}
                title={t('editor.table.cellBackgroundNone')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => c().unsetCellBackground().run()}
                className="grid size-6 place-items-center rounded-md border border-line text-xs"
              >
                <Icon name="cross" size={10} />
              </button>
            </div>
          </Popover>
          {tb(t('editor.table.delete'), () => c().deleteTable().run())}
        </>
      ) : null}
    </div>
  );
}
