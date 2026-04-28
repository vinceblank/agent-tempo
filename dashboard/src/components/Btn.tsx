/**
 * Btn — design-language button primitive.
 *
 * Variants: primary (terracotta fill), ghost (transparent until hover),
 * danger (transparent + err border on hover), default (raised).
 * Sizes: sm / md (default) / lg.
 *
 * Source: `docs/design/dashboard-handoff/project/primitives.jsx:170-183`
 * + components.css `.btn*`.
 *
 * Caller MUST supply `data-testid` since the testid-coverage test
 * requires every interactive element to carry one. We forward the prop
 * directly rather than auto-generating to keep test surfaces explicit.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type BtnVariant = 'default' | 'primary' | 'ghost' | 'danger';
type BtnSize = 'sm' | 'md' | 'lg';

interface BtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: BtnVariant;
  size?: BtnSize;
  icon?: ReactNode;
  children?: ReactNode;
  /** Required — see file header for rationale. */
  'data-testid': string;
}

export function Btn({
  variant = 'default',
  size = 'md',
  icon,
  children,
  type = 'button',
  className,
  ...rest
}: BtnProps) {
  const cls = [
    'btn',
    variant !== 'default' && `btn-${variant}`,
    size !== 'md' && `btn-${size}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {icon && <span className="btn-icon">{icon}</span>}
      {children !== undefined && <span>{children}</span>}
    </button>
  );
}
