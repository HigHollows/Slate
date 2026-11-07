import { ReactRenderer, type Editor } from '@tiptap/react';
import { computePosition, flip, shift, offset } from '@floating-ui/dom';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { SuggestionList, type SuggestionItem, type SuggestionListHandle } from './SuggestionList';

/** Rendu générique d'une suggestion (menu `/`, mentions `@`) : liste React positionnée sous le curseur. */
export function createSuggestionRenderer(labels: () => { label: string; empty: string }) {
  return () => {
    let component: ReactRenderer<SuggestionListHandle> | null = null;
    let host: HTMLDivElement | null = null;

    const place = (props: SuggestionProps<SuggestionItem, SuggestionItem>) => {
      const rect = props.clientRect?.();
      if (!rect || !host) return;
      const ref = { getBoundingClientRect: () => rect };
      void computePosition(ref, host, {
        placement: 'bottom-start',
        middleware: [offset(6), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        if (host) Object.assign(host.style, { left: `${x}px`, top: `${y}px` });
      });
    };
    const make = (props: SuggestionProps<SuggestionItem, SuggestionItem>) => ({
      ...props,
      label: labels().label,
      emptyLabel: labels().empty,
    });

    return {
      onStart(props: SuggestionProps<SuggestionItem, SuggestionItem>) {
        component = new ReactRenderer(SuggestionList, {
          props: make(props),
          editor: props.editor as Editor,
        });
        host = document.createElement('div');
        host.style.cssText = 'position:fixed;z-index:70;left:0;top:0';
        host.appendChild(component.element);
        document.body.appendChild(host);
        place(props);
      },
      onUpdate(props: SuggestionProps<SuggestionItem, SuggestionItem>) {
        component?.updateProps(make(props));
        place(props);
      },
      onKeyDown({ event }: SuggestionKeyDownProps) {
        if (event.key === 'Escape') {
          host?.remove();
          return false; // laisse le plugin fermer la suggestion
        }
        return component?.ref?.onKeyDown(event) ?? false;
      },
      onExit() {
        component?.destroy();
        host?.remove();
        component = null;
        host = null;
      },
    };
  };
}
