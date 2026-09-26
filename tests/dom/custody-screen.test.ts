import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';

import type { OverlookApi } from '../../src/shared/ipc/api.js';
import { CustodyScreen } from '../../src/renderer/src/lock/CustodyScreen.js';

let root: Root | undefined;

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
    root = undefined;
  }
  Reflect.deleteProperty(window, 'overlook');
  document.body.replaceChildren();
});

function render(onRecovered: () => void): void {
  const overlook = {
    keys: {
      pickFile: () => Promise.resolve({ path: '/library/recovery.key' }),
      import: () => Promise.resolve({ installed: true, fingerprint: 'ABCD', reason: null }),
    },
    minimizeWindow: () => Promise.resolve(),
    toggleMaximizeWindow: () => Promise.resolve(false),
    closeWindow: () => Promise.resolve(),
  } as unknown as OverlookApi;
  Object.defineProperty(window, 'overlook', { configurable: true, value: overlook });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(
        IntlProvider,
        { locale: 'en', defaultLocale: 'en' },
        createElement(CustodyScreen, {
          platform: 'darwin',
          state: 'unwrap-failed',
          onRecovered,
          onSwitchLibrary: () => undefined,
        }),
      ),
    );
  });
}

test('an unwrap failure shows the recovery screen and not the photo grid', () => {
  render(() => undefined);
  assert.ok(document.querySelector('[data-testid="custody-screen"]') instanceof HTMLElement);
  assert.equal(document.querySelector('[data-testid="virtual-grid"]'), null);
  assert.match(document.body.textContent ?? '', /cannot unwrap the library’s master key/u);
  assert.match(document.body.textContent ?? '', /photos are still in the library/u);
});

test('a successful recovery-key import clears the screen', async () => {
  let recovered = false;
  render(() => {
    recovered = true;
  });
  const choose = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Choose recovery key');
  assert.ok(choose instanceof HTMLButtonElement);
  await act(async () => {
    choose.click();
    await Promise.resolve();
  });
  const password = document.querySelector('input[name="recovery-key-password"]');
  const form = document.querySelector('form');
  assert.ok(password instanceof HTMLInputElement);
  assert.ok(form instanceof HTMLFormElement);
  act(() => {
    Object.defineProperty(password, 'value', { configurable: true, value: 'correct horse', writable: true });
    password.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  assert.equal(recovered, true);
});
