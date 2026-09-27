import type { ReactElement } from 'react';

import { useFieldNameProps } from './field-name';
import './inputs.css';

export interface SliderProps {
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
  readonly width?: number;
  /** Accessible name (e.g. "Zoom"). Omit it in an auto settings row, which
   *  names the slider by its label (#1295). */
  readonly label?: string | undefined;
  /** Real disabled semantics — unreachable by Tab, inert to arrows (#114). */
  readonly disabled?: boolean;
}

// components/forms/Slider.jsx — the fill gradient tracks the value; thumb
// styling comes from inputs.css (not an injected style tag).
export function Slider({ value, min = 0, max = 100, step = 1, onChange, width = 140, label, disabled = false }: SliderProps): ReactElement {
  const pct = ((value - min) / (max - min)) * 100;
  const names = useFieldNameProps(label);
  return (
    <input
      type="range"
      className="ovl-slider"
      aria-label={label}
      {...names}
      disabled={disabled}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(event) => {
        onChange(Number(event.target.value));
      }}
      style={{
        width,
        backgroundImage: `linear-gradient(to right, var(--white-2) ${pct}%, var(--gray-4) ${pct}%)`,
      }}
    />
  );
}
