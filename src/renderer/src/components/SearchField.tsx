import { useState } from 'react';
import type { ReactElement } from 'react';

import './forms.css';
import { Icon } from './Icon';

export interface SearchFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  /** Mono shortcut hint, hidden while focused (and while text is present). */
  readonly shortcut?: string;
  readonly width?: number;
  /** Durable accessible name — the placeholder is not one. */
  readonly label?: string;
}

// components/forms/SearchField.jsx + the clear affordance from #60's scope:
// an × appears when there is text, clears it, and returns focus to the input.
export function SearchField({
  value,
  onChange,
  placeholder = 'Search photos, places, cameras…',
  shortcut = '',
  width = 280,
  label = 'Search',
}: SearchFieldProps): ReactElement {
  const [focus, setFocus] = useState(false);
  return (
    <div className="ovl-search" style={{ width }}>
      <Icon name="search" size={14} />
      <input
        className="ovl-search__input"
        type="text"
        role="searchbox"
        aria-label={label}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onFocus={() => {
          setFocus(true);
        }}
        onBlur={() => {
          setFocus(false);
        }}
        placeholder={placeholder}
      />
      {value.length > 0 ? (
        <button
          type="button"
          aria-label="Clear search"
          className="ovl-search__clear"
          onMouseDown={(event) => {
            // Keep focus in the field across the click.
            event.preventDefault();
          }}
          onClick={() => {
            onChange('');
          }}
        >
          <Icon name="x" size={12} />
        </button>
      ) : shortcut !== '' && !focus ? (
        <span className="ovl-search__hint">{shortcut}</span>
      ) : null}
    </div>
  );
}
