import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from '@slate/icons';
import { Tooltip } from './Tooltip';
import { cx } from './cx';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label'
> {
  icon: IconName;
  /** Obligatoire : nom accessible et infobulle. */
  label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, className, type = 'button', ...rest },
  ref,
) {
  return (
    <Tooltip label={label}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={cx(
          'inline-grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg active:bg-pressed disabled:pointer-events-none disabled:opacity-40',
          className,
        )}
        {...rest}
      >
        <Icon name={icon} size={16} />
      </button>
    </Tooltip>
  );
});
