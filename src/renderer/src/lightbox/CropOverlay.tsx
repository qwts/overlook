import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';

import type { EditCrop } from '../../../shared/library/edit-revision.js';

// Crop drawing surface (#493). Sits exactly over the oriented image; a drag
// draws the crop rectangle in normalized oriented coordinates (ADR-0031 §2),
// the current crop shows as the lit region inside a scrim, and the viewport
// applies or cancels it. Keyboard users apply and cancel with Enter and Esc;
// the rectangle itself is pointer-drawn, which the acceptance doc names.

export interface CropOverlayBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface CropOverlayProps {
  /** The oriented image's box in viewport pixels. */
  readonly box: CropOverlayBox;
  readonly crop: EditCrop | null;
  readonly onChange: (crop: EditCrop) => void;
  readonly label: string;
}

/** Smaller than this (a slip of the pointer) is not a crop. */
const MIN_CROP_FRACTION = 0.02;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rectangle(start: { x: number; y: number }, end: { x: number; y: number }): EditCrop {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return { left, top, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export function CropOverlay({ box, crop, onChange, label }: CropOverlayProps): ReactElement {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<EditCrop | null>(null);
  const shown = draft ?? crop;
  const normalized = (event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clampUnit((event.clientX - bounds.left) / Math.max(1, bounds.width)),
      y: clampUnit((event.clientY - bounds.top) / Math.max(1, bounds.height)),
    };
  };
  const rectStyle =
    shown === null
      ? undefined
      : {
          left: `${String(shown.left * 100)}%`,
          top: `${String(shown.top * 100)}%`,
          width: `${String(shown.width * 100)}%`,
          height: `${String(shown.height * 100)}%`,
        };
  return (
    // The surface is a drawing tool (role application), not a control with a
    // keyboard idiom of its own: Enter/Esc are handled by the viewport.
    <div
      className="ovl-lightbox__crop"
      role="application"
      aria-label={label}
      data-testid="lightbox-crop"
      data-crop={shown === null ? 'none' : [shown.left, shown.top, shown.width, shown.height].map((part) => part.toFixed(3)).join(',')}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        startRef.current = normalized(event);
        setDraft(null);
      }}
      onPointerMove={(event) => {
        if (startRef.current === null) return;
        setDraft(rectangle(startRef.current, normalized(event)));
      }}
      onPointerUp={(event) => {
        const start = startRef.current;
        startRef.current = null;
        if (start === null) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        const next = rectangle(start, normalized(event));
        setDraft(null);
        if (next.width >= MIN_CROP_FRACTION && next.height >= MIN_CROP_FRACTION) onChange(next);
      }}
      onPointerCancel={() => {
        startRef.current = null;
        setDraft(null);
      }}
    >
      {rectStyle === undefined ? null : <div className="ovl-lightbox__crop-rect" style={rectStyle} />}
    </div>
  );
}
