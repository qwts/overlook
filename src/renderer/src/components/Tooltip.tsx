import { cloneElement, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import './controls.css';

export interface TooltipProps {
  readonly label: string;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
  readonly children: ReactElement<{ readonly 'aria-describedby'?: string | undefined }>;
  /** Suppresses the bubble without re-parenting `children`, so a control that
   *  only needs a tooltip at some sizes keeps its focus when that changes. */
  readonly disabled?: boolean | undefined;
}

/** The mock's own bubble offset from the anchor. */
const GAP = 6;

// components/core/Tooltip.jsx — JS-driven (not CSS :hover) exactly like the
// mock, which also keeps it drivable by the interaction tests' synthetic
// events. Focus/blur mirror hover so keyboard users get the same hint (PR
// #140 review); React's onFocus/onBlur bubble from the wrapped control.
// 200ms fade via --duration-normal.
//
// The updated mock (#238) positions the bubble with `fixed` viewport coords
// measured on show, so an overflow/scroll ancestor can never clip it — the
// collapsed sidebar rail relies on that for its right-side tooltips — and
// adds the left/right sides.
export function Tooltip({ label, side = 'top', children, disabled = false }: TooltipProps): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [coords, setCoords] = useState<CSSProperties | null>(null);
  const show = (): void => {
    const el = ref.current;
    if (el === null || disabled) {
      return;
    }
    const r = el.getBoundingClientRect();
    if (side === 'right') {
      setCoords({ top: r.top + r.height / 2, left: r.right + GAP, transform: 'translateY(-50%)' });
    } else if (side === 'left') {
      setCoords({ top: r.top + r.height / 2, left: r.left - GAP, transform: 'translate(-100%, -50%)' });
    } else if (side === 'bottom') {
      setCoords({ top: r.bottom + GAP, left: r.left + r.width / 2, transform: 'translateX(-50%)' });
    } else {
      setCoords({ top: r.top - GAP, left: r.left + r.width / 2, transform: 'translate(-50%, -100%)' });
    }
  };
  const hide = (): void => {
    setCoords(null);
  };
  const visible = coords !== null && !disabled;
  const describedBy = [children.props['aria-describedby'], visible ? tooltipId : undefined].filter(Boolean).join(' ') || undefined;
  return (
    // A passive wrapper, not the control: the interactive element is `children`, and the
    // mouse handlers are already mirrored by onFocus/onBlur, so the keyboard path this
    // rule asks for exists. Giving the span a role and tabIndex would insert a second,
    // meaningless Tab stop in front of every tooltipped button.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <span
      ref={ref}
      className="ovl-tooltip"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && coords !== null) {
          event.stopPropagation();
          hide();
        }
      }}
    >
      {cloneElement(children, { 'aria-describedby': describedBy })}
      {!visible ? null : (
        <span id={tooltipId} role="tooltip" className="ovl-tooltip__bubble" style={coords}>
          {label}
        </span>
      )}
    </span>
  );
}
