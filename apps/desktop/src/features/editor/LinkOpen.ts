import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { isAllowedHref } from './link';

export const LINK_OPEN_EVENT = 'slate:link-open';

/**
 * Ouverture d'un lien : Ctrl/Cmd + clic en édition, simple clic en lecture seule. Un simple clic en édition place
 * le curseur (la carte du lien propose alors « Ouvrir »). L'adresse est revalidée avant toute ouverture.
 */
export const LinkOpen = Extension.create({
  name: 'linkOpen',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            click(view, event) {
              const a = (event.target as HTMLElement | null)?.closest?.('a[href]');
              if (!a) return false;
              const wantsOpen = event.metaKey || event.ctrlKey || !view.editable;
              const href = a.getAttribute('href');
              if (!wantsOpen || !isAllowedHref(href)) return false;
              event.preventDefault();
              window.dispatchEvent(new CustomEvent(LINK_OPEN_EVENT, { detail: href }));
              return true;
            },
          },
        },
      }),
    ];
  },
});
