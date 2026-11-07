import { Icon, type IconName } from '@slate/icons';
import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon: IconName;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
      <span className="grid size-11 place-items-center rounded-xl bg-surface text-muted">
        <Icon name={icon} size={22} />
      </span>
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? <p className="text-muted">{description}</p> : null}
      {children ? <div className="mt-1 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </div>
  );
}
