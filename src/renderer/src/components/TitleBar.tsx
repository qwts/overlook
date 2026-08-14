import type { ReactElement, ReactNode } from 'react';

import './titlebar.css';
import { Icon } from './Icon.js';

export interface TitleBarProps {
  /** process.platform from the main process ('darwin' → mac variant). */
  readonly platform: string;
  /** Space reserved for macOS's native traffic lights — never drawn here. */
  readonly trafficLightInset?: number;
  /** Centered no-drag island (#386: the library switcher trigger). */
  readonly center?: ReactNode;
  /** No-drag affordance left of the window controls — the Windows/Linux
   *  titlebar Help menu (#699). Never rendered in the macOS variant. */
  readonly help?: ReactNode;
  readonly onMinimize?: () => void;
  readonly onToggleMaximize?: () => void;
  readonly onClose?: () => void;
}

// components/core/TitleBar.jsx — the only thing standing in for OS chrome on
// a frameless window. mac: the app is created with titleBarStyle hiddenInset,
// so macOS draws real traffic lights over our reserved inset. win/linux: no
// native chrome exists, so minimal custom controls call the #50 IPC channels
// (wired by the caller — this component stays Electron-free for Storybook).
export function TitleBar({
  platform,
  trafficLightInset = 78,
  center,
  help,
  onMinimize,
  onToggleMaximize,
  onClose,
}: TitleBarProps): ReactElement {
  const isMac = platform === 'darwin';
  return (
    <header className="ovl-titlebar">
      {isMac ? <div className="ovl-titlebar__inset" style={{ width: trafficLightInset }} /> : null}
      <div className="ovl-titlebar__spacer" />
      {center === undefined ? null : <div className="ovl-titlebar__center">{center}</div>}
      <div className="ovl-titlebar__spacer" />
      {isMac ? null : (
        <div className="ovl-titlebar__controls">
          {help}
          <button type="button" aria-label="Minimize" className="ovl-titlebar__button" onClick={onMinimize}>
            <Icon name="minus" size={13} />
          </button>
          <button type="button" aria-label="Maximize" className="ovl-titlebar__button" onClick={onToggleMaximize}>
            <Icon name="square" size={13} />
          </button>
          <button type="button" aria-label="Close" className="ovl-titlebar__button ovl-titlebar__button--close" onClick={onClose}>
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
    </header>
  );
}
