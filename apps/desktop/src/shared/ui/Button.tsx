import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from '@slate/icons';
import { cx } from './cx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: IconName;
  children?: ReactNode;
}

const styles: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 active:brightness-95',
  secondary: 'border border-line bg-elevated text-fg hover:bg-hover active:bg-pressed',
  ghost: 'text-fg hover:bg-hover active:bg-pressed',
  danger: 'border border-line text-danger hover:bg-hover active:bg-pressed',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', icon, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex h-[var(--row-h)] items-center gap-2 rounded-md px-3 text-[0.8125rem] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        styles[variant],
        className,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
});
