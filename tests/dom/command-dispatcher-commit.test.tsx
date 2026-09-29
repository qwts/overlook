import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, useLayoutEffect, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';

import { AppStateProvider, useAppState } from '../../src/renderer/src/state/app-state-context.js';
import { useCommandDispatcher } from '../../src/renderer/src/state/use-command-dispatcher.js';

// #1279: a shortcut pressed the moment a dialog closes (or the Lightbox opens)
// must see the committed state. The listener used to be re-registered in a
// passive effect, so a key landing between the DOM commit and that effect was
// judged by the previous render — here, "Help is open", so `i` was ignored.

const noop = (): void => undefined;

function Dispatcher({ helpOpen }: { readonly helpOpen: boolean }): null {
  useCommandDispatcher('darwin', noop, helpOpen, noop);
  return null;
}

/** Presses `i` in its layout effect: after this commit's DOM changes, before
 *  any passive effect runs. Rendered after Dispatcher, so it runs after
 *  Dispatcher's layout effects. */
function PressOnCommit({ press }: { readonly press: boolean }): null {
  useLayoutEffect(() => {
    if (press) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }));
  }, [press]);
  return null;
}

function InspectorFlag(): ReactElement {
  return <output data-testid="inspector" data-open={String(useAppState().inspectorOpen)} />;
}

function Harness({ helpOpen, press }: { readonly helpOpen: boolean; readonly press: boolean }): ReactElement {
  return (
    <IntlProvider locale="en" defaultLocale="en">
      <AppStateProvider>
        <Dispatcher helpOpen={helpOpen} />
        <PressOnCommit press={press} />
        <InspectorFlag />
      </AppStateProvider>
    </IntlProvider>
  );
}

test('a shortcut pressed in the same commit that closes a dialog is judged by the new state', () => {
  const previous = window.overlook;
  Object.defineProperty(window, 'overlook', {
    configurable: true,
    value: { library: { onPendingCountChanged: () => () => undefined } },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => {
      root.render(<Harness helpOpen press={false} />);
    });
    act(() => {
      root.render(<Harness helpOpen={false} press />);
    });
    assert.equal(container.querySelector('[data-testid="inspector"]')?.getAttribute('data-open'), 'true');
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
    Object.defineProperty(window, 'overlook', { configurable: true, value: previous });
  }
});
