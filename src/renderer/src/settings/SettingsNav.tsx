import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';

import { Icon, type IconName } from '../components/Icon';

export interface SettingsNavSection<K extends string> {
  readonly key: K;
  readonly icon: IconName;
  readonly label: string;
}

export interface SettingsNavProps<K extends string> {
  readonly label: string;
  readonly sections: readonly SettingsNavSection<K>[];
  readonly active: K;
  readonly onSelect: (key: K) => void;
}

type Orientation = 'vertical' | 'horizontal';

// Settings section tabs (#1297). A column beside the pane, max-content between
// 160 and 200px; below a 560px dialog the stylesheet's container query lays
// them out as a row above the pane. The orientation is read back from the
// computed flex direction, so the CSS stays the one source for the breakpoint.
export function SettingsNav<K extends string>({ label, sections, active, onSelect }: SettingsNavProps<K>): ReactElement {
  const navRef = useRef<HTMLDivElement>(null);
  const [orientation, setOrientation] = useState<Orientation>('vertical');

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (nav === null) return;
    const observer = new ResizeObserver(() => {
      setOrientation(getComputedStyle(nav).flexDirection === 'row' ? 'horizontal' : 'vertical');
    });
    const root = nav.parentElement ?? nav;
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // The current tab stays in view when it changes, whatever changed it.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const tab = nav?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (nav != null && tab != null) keepInView(nav, tab);
  }, [active, orientation]);

  return (
    <div
      ref={navRef}
      className="ovl-settings__nav"
      role="tablist"
      aria-orientation={orientation}
      tabIndex={-1}
      aria-label={label}
      onKeyDown={moveTabFocus}
    >
      {sections.map(({ key, icon, label: sectionLabel }) => {
        const current = key === active;
        return (
          <button
            key={key}
            id={`settings-tab-${key}`}
            type="button"
            role="tab"
            className={`ovl-settings__navrow${current ? ' ovl-settings__navrow--active' : ''}`}
            aria-selected={current}
            aria-controls="settings-panel"
            tabIndex={current ? 0 : -1}
            onClick={() => {
              onSelect(key);
            }}
          >
            <Icon name={icon} size={14} color={current ? 'var(--accent-cyan)' : 'var(--text-faint)'} />
            <span>{sectionLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

// ←/→ and ↑/↓ both move, in either orientation (→ is next in LTR, ← in RTL);
// Home and End jump to the ends. Moving selects, as the panes load at once.
function moveTabFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
  const nav = event.currentTarget;
  const tabs = Array.from(nav.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  if (tabs.length === 0) return;
  const rtl = getComputedStyle(nav).direction === 'rtl';
  const steps: Readonly<Record<string, number>> = {
    ArrowDown: 1,
    ArrowUp: -1,
    ArrowRight: rtl ? -1 : 1,
    ArrowLeft: rtl ? 1 : -1,
  };
  const current = tabs.findIndex((tab) => tab === document.activeElement);
  const step = steps[event.key];
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : step === undefined
          ? null
          : (current + step + tabs.length) % tabs.length;
  const tab = next === null ? undefined : tabs[next];
  if (tab === undefined) return;
  event.preventDefault();
  // preventScroll + scrollLeft rather than scrollIntoView, which would also
  // scroll the dialog and the page behind it.
  tab.focus({ preventScroll: true });
  keepInView(nav, tab);
  tab.click();
}

function keepInView(nav: HTMLElement, tab: HTMLElement): void {
  const box = nav.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  if (rect.left < box.left) nav.scrollLeft -= box.left - rect.left;
  else if (rect.right > box.right) nav.scrollLeft += rect.right - box.right;
  if (rect.top < box.top) nav.scrollTop -= box.top - rect.top;
  else if (rect.bottom > box.bottom) nav.scrollTop += rect.bottom - box.bottom;
}
