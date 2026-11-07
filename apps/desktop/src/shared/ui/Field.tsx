import type { ReactNode } from 'react';

/** Ligne de paramètre : libellé + description à gauche, contrôle à droite. */
export function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-3 last:border-0">
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        {description ? <div className="text-muted">{description}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
