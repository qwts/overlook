import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { SettingsNav, type SettingsNavSection } from '../../src/renderer/src/settings/SettingsNav.js';

// #1297 (Pass C spec, Nav): ←/→ and ↑/↓ both move and select, → is next in
// LTR and previous in RTL, Home and End jump to the ends.

type Key = 'general' | 'storage' | 'privacy';

const SECTIONS: readonly SettingsNavSection<Key>[] = [
  { key: 'general', icon: 'sliders-horizontal', label: 'General' },
  { key: 'storage', icon: 'cloud', label: 'Storage & Backup' },
  { key: 'privacy', icon: 'shield-check', label: 'Privacy' },
];

let root: Root | undefined;

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

function Harness(): ReactElement {
  const [active, setActive] = useState<Key>('general');
  return <SettingsNav label="Settings sections" sections={SECTIONS} active={active} onSelect={setActive} />;
}

function render(dir: 'ltr' | 'rtl'): void {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {}
    disconnect(): void {}
  };
  const container = document.createElement('div');
  container.dir = dir;
  container.style.direction = dir;
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

function press(key: string): void {
  const target = document.activeElement ?? document.body;
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function selected(): string | null | undefined {
  return document.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
}

function start(): void {
  const tab = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  act(() => tab?.focus());
}

test('the tab list is named, and only the selected tab is in the tab order', () => {
  render('ltr');
  const nav = document.querySelector('[role="tablist"]');
  assert.equal(nav?.getAttribute('aria-label'), 'Settings sections');
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'), (tab) => tab.getAttribute('tabindex'));
  assert.deepEqual(tabs, ['0', '-1', '-1']);
});

test('arrows on both axes move and select; Home and End jump to the ends', () => {
  render('ltr');
  start();
  press('ArrowRight');
  assert.equal(selected(), 'Storage & Backup');
  assert.equal(document.activeElement?.textContent, 'Storage & Backup');
  press('ArrowDown');
  assert.equal(selected(), 'Privacy');
  press('ArrowDown');
  assert.equal(selected(), 'General', 'wraps past the end');
  press('ArrowUp');
  assert.equal(selected(), 'Privacy');
  press('ArrowLeft');
  assert.equal(selected(), 'Storage & Backup');
  press('Home');
  assert.equal(selected(), 'General');
  press('End');
  assert.equal(selected(), 'Privacy');
});

test('in RTL, → moves to the previous tab and ← to the next', () => {
  render('rtl');
  start();
  press('ArrowLeft');
  assert.equal(selected(), 'Storage & Backup');
  press('ArrowRight');
  assert.equal(selected(), 'General');
  press('ArrowDown');
  assert.equal(selected(), 'Storage & Backup', '↓ is next in either direction');
});
