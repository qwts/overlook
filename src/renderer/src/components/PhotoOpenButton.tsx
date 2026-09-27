import type { DragEvent, KeyboardEvent, ReactElement } from 'react';
import { useIntl } from 'react-intl';

import { directionOf } from '../../../shared/i18n/locales.js';

export interface PhotoOpenButtonProps {
  readonly label: string;
  /** Hover text for state a tile pill shows only as a glyph (#1288). */
  readonly title?: string | undefined;
  readonly className: string;
  readonly onOpen?: (() => void) | undefined;
  readonly onContextAction?: ((point: { readonly x: number; readonly y: number; readonly origin: HTMLButtonElement }) => void) | undefined;
  readonly onDragStart?: ((event: DragEvent<HTMLButtonElement>) => void) | undefined;
  readonly onDragEnd?: (() => void) | undefined;
  readonly tabIndex?: 0 | -1 | undefined;
  readonly gridFocusTarget?: true | undefined;
  readonly onFocus?: (() => void) | undefined;
  readonly onKeyDown?: ((event: KeyboardEvent<HTMLButtonElement>) => void) | undefined;
}

export function PhotoOpenButton({
  label,
  title,
  className,
  onOpen,
  onContextAction,
  onDragStart,
  onDragEnd,
  tabIndex,
  gridFocusTarget,
  onFocus,
  onKeyDown,
}: PhotoOpenButtonProps): ReactElement {
  const direction = directionOf(useIntl().locale);
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      aria-haspopup={onContextAction === undefined ? undefined : 'menu'}
      className={className}
      tabIndex={tabIndex}
      data-grid-focus-target={gridFocusTarget}
      draggable={onDragStart !== undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onFocus={onFocus}
      onContextMenu={
        onContextAction === undefined
          ? undefined
          : (event) => {
              event.preventDefault();
              onContextAction({ x: event.clientX, y: event.clientY, origin: event.currentTarget });
            }
      }
      onKeyDown={
        onContextAction === undefined && onKeyDown === undefined
          ? undefined
          : (event) => {
              onKeyDown?.(event);
              if (event.defaultPrevented) return;
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                onContextAction?.({
                  x: direction === 'rtl' ? bounds.left - 224 : bounds.right + 4,
                  y: bounds.top,
                  origin: event.currentTarget,
                });
              }
            }
      }
    />
  );
}
