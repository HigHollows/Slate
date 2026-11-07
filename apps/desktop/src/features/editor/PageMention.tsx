import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@slate/icons';
import { useNav } from '../navigation';
import { displayTitle, usePages } from '../pages';

function MentionView({ node, selected }: NodeViewProps) {
  const { t } = useTranslation();
  const id = String(node.attrs['id'] ?? '');
  const target = usePages((s) => s.nodes.find((n) => n.id === id));
  return (
    <NodeViewWrapper as="span" className="inline">
      <button
        type="button"
        contentEditable={false}
        data-selected={selected ? '' : undefined}
        onClick={() => target && useNav.getState().navigate({ name: 'page', id })}
        className="slate-mention"
        aria-label={
          target
            ? t('editor.openPage', { title: displayTitle(target, t('pages.untitled')) })
            : t('editor.missingPage')
        }
      >
        <Icon name="paper" size={13} />
        <span className={target ? '' : 'italic opacity-70'}>
          {target ? displayTitle(target, t('pages.untitled')) : t('editor.missingPage')}
        </span>
      </button>
    </NodeViewWrapper>
  );
}

/** Mention de page : n'enregistre que l'identifiant ; le titre affiché suit les renommages. */
export const PageMention = Node.create({
  name: 'pageMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ id: { default: '' } }),
  parseHTML: () => [{ tag: 'span[data-page-mention]' }],
  renderHTML: ({ node, HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes, { 'data-page-mention': node.attrs['id'] as string }),
    '@',
  ],
  renderText: () => '',
  addNodeView: () => ReactNodeViewRenderer(MentionView),
});
