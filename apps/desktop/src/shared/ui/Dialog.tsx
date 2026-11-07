import * as D from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Les palettes ont un en-tête visuel propre : le titre reste lisible par les lecteurs d'écran. */
  hideTitle?: boolean;
  className?: string;
  align?: 'center' | 'top';
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  hideTitle,
  className = '',
  align = 'center',
}: Props) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="anim-fade fixed inset-0 z-40 bg-black/30" />
        <D.Content
          aria-describedby={description ? undefined : undefined}
          className={`anim-pop fixed left-1/2 z-50 w-[min(92vw,32rem)] -translate-x-1/2 rounded-xl bg-elevated text-fg shadow-pop outline-none ${
            align === 'top' ? 'top-[14vh]' : 'top-1/2 -translate-y-1/2'
          } ${className}`}
        >
          <D.Title className={hideTitle ? 'sr-only' : 'px-5 pt-5 text-base font-semibold'}>
            {title}
          </D.Title>
          {description ? (
            <D.Description className={hideTitle ? 'sr-only' : 'px-5 pt-1 text-muted'}>
              {description}
            </D.Description>
          ) : null}
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
