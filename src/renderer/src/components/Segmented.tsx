import { useRef } from 'react';
import type { ReactElement } from 'react';

import './forms.css';
import { useFieldNameProps } from './field-name';
import { Icon, type IconName } from './Icon';
import { Tooltip } from './Tooltip';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: IconName;
  /** Icon-only rendering; the label becomes the Tooltip + accessible name. */
  readonly iconOnly?: boolean;
  /** Unavailable option (#113's locked-control pattern): rendered but not
   * selectable — the button disables and arrow keys skip it. */
  readonly disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  readonly options: readonly (T | SegmentedOption<T>)[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** Accessible name for the group (e.g. "View", "On import"). Omit it in an
   *  auto settings row, which names the group by its label (#1295). */
  readonly label?: string | undefined;
  /** Disables the whole group (#114's disconnected-controls pattern). */
  readonly disabled?: boolean;
}

function normalize<T extends string>(option: T | SegmentedOption<T>): SegmentedOption<T> {
  return typeof option === 'string' ? { value: option, label: option } : option;
}

// components/forms/Segmented.jsx + keyboard operation per #60's exit
// criteria: radiogroup semantics, arrow keys move the exclusive selection.
export function Segmented<T extends string>({ options, value, onChange, label, disabled = false }: SegmentedProps<T>): ReactElement {
  const groupRef = useRef<HTMLDivElement>(null);
  const normalized = options.map(normalize);
  const names = useFieldNameProps(label);

  const moveSelection = (delta: number): void => {
    if (disabled) {
      return;
    }
    const enabled = normalized.filter((option) => option.disabled !== true);
    const index = enabled.findIndex((option) => option.value === value);
    const next = enabled[(index + delta + enabled.length) % enabled.length];
    if (next !== undefined) {
      onChange(next.value);
      groupRef.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
    }
  };

  return (
    // A radiogroup is a COMPOSITE widget: per the APG the container is not focusable —
    // its radios are, via the roving tabIndex below. jsx-a11y models every interactive
    // role as individually focusable and so cannot express that pattern. The audit
    // (#398) names this component the correct in-repo reference for it.
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      {...names}
      className="ovl-segmented"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          moveSelection(1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveSelection(-1);
        }
      }}
    >
      {normalized.map((option) => {
        const on = option.value === value;
        const iconOnly = option.iconOnly === true && option.icon !== undefined;
        const button = (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={option.label}
            data-value={option.value}
            disabled={disabled || option.disabled}
            tabIndex={on ? 0 : -1}
            className={[
              'ovl-segmented__option',
              iconOnly ? 'ovl-segmented__option--icon-only' : undefined,
              on ? 'ovl-segmented__option--on' : undefined,
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => {
              onChange(option.value);
            }}
          >
            {option.icon === undefined ? null : <Icon name={option.icon} size={14} />}
            {iconOnly ? null : option.label}
          </button>
        );
        return iconOnly ? (
          <Tooltip key={option.value} label={option.label}>
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}
