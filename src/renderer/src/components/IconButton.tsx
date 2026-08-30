import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

import './controls.css';
import { Icon, type IconName } from './Icon.js';
import type { ControlSize } from './Button.js';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  readonly icon: IconName;
  /** Accessible name — the glyph is aria-hidden, so icon-only controls must
   * always carry one (PR #140 review). */
  readonly label: string;
  readonly size?: ControlSize;
  /** Cyan tint for a stuck-on state (e.g. inspector open, active filter). */
  readonly active?: boolean;
}

// components/core/IconButton.jsx — square control, 24/28/34px.
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', active, className, ...rest },
  ref,
) {
  const classes = ['ovl-icon-button', `ovl-icon-button--${size}`, active ? 'ovl-icon-button--active' : undefined, className]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type="button" aria-label={label} aria-pressed={active} className={classes} {...rest}>
      <Icon name={icon} size={size === 'lg' ? 20 : 16} />
    </button>
  );
});
