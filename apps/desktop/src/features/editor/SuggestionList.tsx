import { Icon, type IconName } from '@slate/icons';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { cx } from '../../shared/ui';

export interface SuggestionItem {
  id: string;
  title: string;
  description?: string;
  group?: string;
  icon?: IconName;
  /** Repère typographique quand Papicons n'a pas d'icône adaptée (jamais d'emoji). */
  glyph?: string;
}

export interface SuggestionListHandle {
  onKeyDown(e: KeyboardEvent): boolean;
}

interface Props {
  items: SuggestionItem[];
  label: string;
  emptyLabel: string;
  command(item: SuggestionItem): void;
}

/** Liste de suggestions flottante. Le focus reste dans l'éditeur : la navigation clavier passe par `onKeyDown`. */
export const SuggestionList = forwardRef<SuggestionListHandle, Props>(function SuggestionList(
  { items, label, emptyLabel, command },
  ref,
) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [items]);
  useEffect(() => {
    document.getElementById(`sg-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useImperativeHandle(ref, () => ({
    onKeyDown(e) {
      if (items.length === 0) return false;
      if (e.key === 'ArrowDown') setActive((a) => (a + 1) % items.length);
      else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + items.length) % items.length);
      else if (e.key === 'Enter' || e.key === 'Tab') {
        const it = items[active];
        if (it) command(it);
      } else return false;
      return true;
    },
  }));

  if (items.length === 0) {
    return (
      <div role="status" className="w-64 rounded-lg bg-elevated px-3 py-2 text-muted shadow-pop">
        {emptyLabel}
      </div>
    );
  }
  return (
    <ul
      role="listbox"
      aria-label={label}
      aria-activedescendant={`sg-${active}`}
      className="max-h-80 w-72 overflow-y-auto rounded-lg bg-elevated p-1 shadow-pop"
    >
      {items.map((it, i) => (
        <li key={it.id} role="presentation">
          {it.group && items[i - 1]?.group !== it.group ? (
            <div className="px-2 pb-0.5 pt-2 text-xs font-medium text-muted">{it.group}</div>
          ) : null}
          <div
            id={`sg-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseMove={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault(); // garde le focus dans l'éditeur
              command(it);
            }}
            className={cx(
              'flex items-center gap-2.5 rounded-md px-2 py-1.5',
              i === active && 'bg-hover',
            )}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-surface text-xs font-semibold text-muted">
              {it.icon ? <Icon name={it.icon} size={15} /> : it.glyph}
            </span>
            <span className="min-w-0">
              <span className="block truncate">{it.title}</span>
              {it.description ? (
                <span className="block truncate text-xs text-muted">{it.description}</span>
              ) : null}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
});
