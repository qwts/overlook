import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

import './inputs.css';
import { Icon } from './Icon.js';

export interface CheckboxProps {
  readonly checked: boolean;
  readonly indeterminate?: boolean;
  readonly onChange?: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly label: string;
  /** Keep the label as the accessible name but do not show it, for a row
   *  that already names its subject visibly (#1298). */
  readonly hideLabel?: boolean;
}

// components/forms/Checkbox.jsx over a real hidden input (#61 exit criteria):
// keyboard operable, indeterminate reported as aria-checked=mixed.
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  disabled = false,
  label,
  hideLabel = false,
}: CheckboxProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current !== null) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  const on = checked || indeterminate;
  return (
    <label className={`ovl-checkbox${disabled ? ' ovl-checkbox--disabled' : ''}`}>
      <input
        ref={inputRef}
        type="checkbox"
        className="ovl-checkbox__input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          // Browsers clear the DOM indeterminate flag on activation; keep it
          // in sync with the prop so mixed state survives until the parent
          // decides the next state (PR #144 review).
          event.target.indeterminate = indeterminate;
          onChange?.(event.target.checked);
        }}
      />
      <span className={`ovl-checkbox__box${on ? ' ovl-checkbox__box--on' : ''}`}>
        {indeterminate ? <Icon name="minus" size={11} strokeWidth={3} /> : checked ? <Icon name="check" size={11} strokeWidth={3} /> : null}
      </span>
      <span className={hideLabel ? 'ovl-sr-only' : undefined}>{label}</span>
    </label>
  );
}
