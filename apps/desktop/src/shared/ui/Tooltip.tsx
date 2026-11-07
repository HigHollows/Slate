import * as T from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <T.Provider delayDuration={500} skipDelayDuration={200}>
    {children}
  </T.Provider>
);

export function Tooltip({
  label,
  children,
  side = 'bottom',
}: {
  label: string;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'right';
}) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="anim-fade z-50 rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-pop"
        >
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
