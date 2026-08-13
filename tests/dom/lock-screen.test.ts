import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';

import type { OverlookApi } from '../../src/shared/ipc/api.js';
import { LockScreen } from '../../src/renderer/src/lock/LockScreen.js';

let root: Root | undefined;

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
    root = undefined;
  }
  Reflect.deleteProperty(window, 'overlook');
  document.body.replaceChildren();
});

test('LockScreen synchronizes the shared attempt budget after a status update', () => {
  const appLock = {
    touchIdStatus: () => new Promise<never>(() => undefined),
    onTouchIdChanged: () => () => undefined,
  } as unknown as OverlookApi['appLock'];
  Object.defineProperty(window, 'overlook', {
    configurable: true,
    value: { appLock },
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  const render = (attemptsRemaining: number): void => {
    root?.render(
      createElement(
        IntlProvider,
        { locale: 'en', defaultLocale: 'en' },
        createElement(LockScreen, {
          platform: 'darwin',
          state: 'locked',
          retryAfterMs: 0,
          attemptsRemaining,
          onSwitchLibrary: () => undefined,
        }),
      ),
    );
  };

  act(() => render(3));
  const budget = document.querySelector('[data-testid="app-lock-attempts-remaining"]');
  assert.ok(budget instanceof HTMLDivElement);
  assert.match(budget.textContent, /3 attempts remaining/u);

  act(() => render(1));
  assert.match(budget.textContent, /1 attempt remaining/u);
});
