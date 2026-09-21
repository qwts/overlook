import { useId, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';

import './overlays.css';
import { Icon, type IconName } from './Icon.js';
import { IconButton } from './IconButton.js';
import { useDialogKeyboard } from './use-dialog-keyboard.js';
import { useDialogPresence } from './use-dialog-presence.js';

export interface DialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly icon?: IconName;
  /** 420 (flow dialogs) or 640 (settings) per the design. */
  readonly width?: number;
  readonly onClose?: (() => void) | undefined;
  readonly bodyClassName?: string;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

// feedback/Dialog.jsx, upgraded per #59: aria-modal + labelled title, Esc
// closes, and focus is trapped inside while open (the mock only had
// backdrop-click + stopPropagation, which are kept).
export function Dialog({ open, title, icon, width = 420, onClose, bodyClassName, footer, children }: DialogProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { rendered, closing, requestClose } = useDialogPresence(open, onClose, panelRef);
  useDialogKeyboard(rendered, panelRef, requestClose);

  if (!rendered) {
    return null;
  }
  return (
    // Click-to-dismiss on the scrim, and the panel's stopPropagation that shields it.
    // jsx-a11y cannot see that both already have a keyboard equivalent: the Escape
    // listener installed above closes the topmost dialog, which is the same `onClose`.
    // Verified, not assumed — the audit re-confirmed it (#398). A keydown handler here
    // would be dead code on an element that never takes focus.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className={`ovl-dialog-scrim${closing ? ' ovl-dialog-scrim--closing' : ''}`} onClick={requestClose}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`ovl-dialog${closing ? ' ovl-dialog--closing' : ''}`}
        data-state={closing ? 'closing' : 'open'}
        style={{ width }}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="ovl-dialog__header">
          {icon === undefined ? null : <Icon name={icon} size={18} color="var(--text-muted)" />}
          <h2 id={titleId} className="ovl-dialog__title">
            {title}
          </h2>
          {onClose === undefined ? null : <IconButton icon="x" label="Close" size="sm" onClick={requestClose} />}
        </div>
        <div className={`ovl-dialog__body${bodyClassName === undefined ? '' : ` ${bodyClassName}`}`}>{children}</div>
        {footer === undefined ? null : <div className="ovl-dialog__footer">{footer}</div>}
      </div>
    </div>
  );
}
