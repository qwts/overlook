import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';

import { AnnouncerProvider } from '../../src/renderer/src/components/LiveAnnouncer.js';
import { StatusBar } from '../../src/renderer/src/shell/StatusBar.js';
import { AppStateProvider } from '../../src/renderer/src/state/app-state-context.js';
import type { LibraryStats } from '../../src/shared/library/types.js';

// #1301: before the first stats load the left slot says what is happening,
// never a lone dash; once stats arrive it shows the library's size.
test('the status bar left slot says it is counting until stats load, never a lone dash', () => {
  const previous = window.overlook;
  Object.defineProperty(window, 'overlook', {
    configurable: true,
    value: { library: { onPendingCountChanged: () => () => undefined } },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (stats: LibraryStats | null): void => {
    act(() => {
      root.render(
        <IntlProvider locale="en">
          <AppStateProvider>
            <AnnouncerProvider>
              <StatusBar stats={stats} />
            </AnnouncerProvider>
          </AppStateProvider>
        </IntlProvider>,
      );
    });
  };
  const left = (): string => container.querySelector('[data-testid="statusbar-left"]')?.textContent ?? '';
  try {
    render(null);
    assert.equal(left(), 'Counting photos…');
    // A status sentence, not machine data: prose type inside the mono strip.
    assert.equal(container.querySelector('[data-testid="statusbar-left"] .prose-note')?.textContent, 'Counting photos…');

    render({
      photos: 12,
      bytes: 2048,
      pending: 0,
      lastBackupAt: null,
      offloadedBytes: 0,
      excludedCount: 0,
      excludedBytes: 0,
      pendingRemovals: 0,
    });
    assert.match(left(), /^12 photos · /u);
    assert.notEqual(left().trim(), '—');
    assert.equal(container.querySelector('[data-testid="statusbar-left"] .prose-note'), null);
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
    Object.defineProperty(window, 'overlook', { configurable: true, value: previous });
  }
});
