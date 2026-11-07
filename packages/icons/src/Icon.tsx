import type { SVGProps } from 'react';
import { CATALOG, type IconDef } from './catalog.generated';

export type IconName = keyof typeof CATALOG;
export const ICON_NAMES = Object.keys(CATALOG) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: IconName;
  size?: number;
  /** Texte alternatif. Sans `label`, l'icône est décorative (masquée aux lecteurs d'écran). */
  label?: string;
}

/** Icône Papicons (MIT). La couleur suit `currentColor`. */
export function Icon({ name, size = 18, label, ...rest }: IconProps) {
  const def: IconDef = CATALOG[name];
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg
      width={size}
      height={size}
      viewBox={def.viewBox}
      fill="currentColor"
      focusable="false"
      {...a11y}
      {...rest}
    >
      {def.paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fillRule={p.evenodd ? 'evenodd' : 'nonzero'}
          clipRule={p.evenodd ? 'evenodd' : 'nonzero'}
        />
      ))}
    </svg>
  );
}
