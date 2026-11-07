import * as M from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';

export interface MenuItem {
  id: string;
  label: string;
  onSelect(): void;
  danger?: boolean;
}

export function Menu({
  trigger,
  items,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  open?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  return (
    <M.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content
          align="start"
          sideOffset={6}
          className="anim-pop z-50 min-w-44 rounded-lg bg-elevated p-1 shadow-pop"
        >
          {items.map((it) => (
            <M.Item
              key={it.id}
              onSelect={it.onSelect}
              className={`flex h-[var(--row-h)] cursor-default items-center rounded-md px-2 text-[0.8125rem] outline-none data-[highlighted]:bg-hover ${it.danger ? 'text-danger' : ''}`}
            >
              {it.label}
            </M.Item>
          ))}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
