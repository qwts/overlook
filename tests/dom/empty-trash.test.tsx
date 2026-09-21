import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';

import { AppStateProvider } from '../../src/renderer/src/state/app-state-context.js';
import { useEmptyTrash } from '../../src/renderer/src/grid/use-empty-trash.js';

function Probe(): ReactElement {
  const trash = useEmptyTrash();
  return (
    <>
      <button type="button" onClick={trash.open}>
        Empty Trash
      </button>
      {trash.dialog}
    </>
  );
}

test('Empty Trash counts pending and settled exclusions across every page and purges the same selection', async () => {
  const previous = window.overlook;
  const requests: unknown[] = [];
  const purges: unknown[] = [];
  Object.defineProperty(window, 'overlook', {
    configurable: true,
    value: {
      library: {
        onPendingCountChanged: () => () => undefined,
        page: (request: unknown) => {
          requests.push(request);
          return Promise.resolve(
            requests.length === 1
              ? { photos: [{ id: 'pending', coverage: 'excluding' }], nextCursor: 'next' }
              : {
                  photos: [
                    { id: 'settled', coverage: 'excluded' },
                    { id: 'included', coverage: 'included' },
                  ],
                  nextCursor: null,
                },
          );
        },
        purge: (request: unknown) => {
          purges.push(request);
          return Promise.resolve({ status: 'cancelled' });
        },
      },
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => {
      root.render(
        <IntlProvider locale="en">
          <AppStateProvider>
            <Probe />
          </AppStateProvider>
        </IntlProvider>,
      );
    });
    await act(async () => {
      container.querySelector('button')?.click();
      await Promise.resolve();
    });
    assert.equal(requests.length, 2);
    assert.match(container.querySelector('[role="dialog"]')?.textContent ?? '', /Delete 3 photos permanently/u);
    assert.match(container.querySelector('[data-testid="purge-excluding"]')?.textContent ?? '', /1 photo may still have a cloud copy/u);
    assert.match(container.querySelector('[data-testid="purge-excluded"]')?.textContent ?? '', /1 of these is kept on this device only/u);
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete permanently')?.click();
      await Promise.resolve();
    });
    assert.deepEqual(purges, [{ photoIds: ['pending', 'settled', 'included'] }]);
  } finally {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(window, 'overlook', { configurable: true, value: previous });
  }
});
