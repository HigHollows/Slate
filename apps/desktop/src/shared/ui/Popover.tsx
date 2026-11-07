import * as P from '@radix-ui/react-popover';
import type { ReactNode } from 'react';

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = 'start',
  width,
  label,
}: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?(o: boolean): void;
  align?: 'start' | 'center' | 'end';
  width?: number;
  label: string;
}) {
  return (
    <P.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          style={width ? { width } : undefined}
          className="anim-pop z-50 max-h-[70vh] overflow-y-auto rounded-lg bg-elevated p-2 shadow-pop outline-none"
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
