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

test('LockScreen restores the authoritative attempt budget after recovery', async () => {
  const appLock = {
    touchIdStatus: () => new Promise<never>(() => undefined),
    onTouchIdChanged: () => () => undefined,
    unlock: () => Promise.resolve({ ok: false as const, reason: 'wrong-password' as const, retryAfterMs: 0, attemptsRemaining: 1 }),
  } as unknown as OverlookApi['appLock'];
  Object.defineProperty(window, 'overlook', {
    configurable: true,
    value: { appLock },
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  const render = (state: 'locked' | 'recovery-required', attemptsRemaining: number): void => {
    root?.render(
      createElement(
        IntlProvider,
        { locale: 'en', defaultLocale: 'en' },
        createElement(LockScreen, {
          platform: 'darwin',
          state,
          retryAfterMs: 0,
          attemptsRemaining,
          onSwitchLibrary: () => undefined,
        }),
      ),
    );
  };

  act(() => render('locked', 3));
  const password = document.querySelector('input[name="app-password"]');
  const form = document.querySelector('form');
  assert.ok(password instanceof HTMLInputElement);
  assert.ok(form instanceof HTMLFormElement);
  act(() => {
    Object.defineProperty(password, 'value', {
      configurable: true,
      value: 'wrong password',
      writable: true,
    });
    password.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  const budget = document.querySelector('[data-testid="app-lock-attempts-remaining"]');
  assert.ok(budget instanceof HTMLDivElement);
  assert.match(budget.textContent, /1 attempt remaining/u);

  act(() => render('recovery-required', 0));
  act(() => render('locked', 3));
  const restoredBudget = document.querySelector('[data-testid="app-lock-attempts-remaining"]');
  assert.ok(restoredBudget instanceof HTMLDivElement);
  assert.match(restoredBudget.textContent, /3 attempts remaining/u);
});

test('LockScreen distinguishes unavailable secure storage from a wrong password', async () => {
  const appLock = {
    touchIdStatus: () => new Promise<never>(() => undefined),
    onTouchIdChanged: () => () => undefined,
    unlock: () => Promise.resolve({ ok: false as const, reason: 'storage-unavailable' as const, retryAfterMs: 0, attemptsRemaining: 3 }),
  } as unknown as OverlookApi['appLock'];
  Object.defineProperty(window, 'overlook', {
    configurable: true,
    value: { appLock },
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      createElement(
        IntlProvider,
        { locale: 'en', defaultLocale: 'en' },
        createElement(LockScreen, {
          platform: 'darwin',
          state: 'locked',
          retryAfterMs: 0,
          attemptsRemaining: 3,
          onSwitchLibrary: () => undefined,
        }),
      ),
    );
  });
  const password = document.querySelector('input[name="app-password"]');
  const form = document.querySelector('form');
  assert.ok(password instanceof HTMLInputElement);
  assert.ok(form instanceof HTMLFormElement);
  act(() => {
    Object.defineProperty(password, 'value', {
      configurable: true,
      value: 'correct password',
      writable: true,
    });
    password.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  const status = document.querySelector('[role="status"]');
  assert.ok(status instanceof HTMLDivElement);
  assert.match(status.textContent, /Secure storage is unavailable/u);
  assert.doesNotMatch(status.textContent, /password did not unlock/u);
});

test('LockScreen keeps password unlock available after a zero-delay Touch ID failure', async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const appLock = {
      touchIdStatus: () => Promise.resolve({ available: true, reason: null, enabled: true, reenrollmentRequired: false }),
      onTouchIdChanged: () => () => undefined,
      touchIdUnlock: () => Promise.resolve({ ok: false as const, reason: 'cancelled' as const, retryAfterMs: 0, attemptsRemaining: 3 }),
    } as unknown as OverlookApi['appLock'];
    Object.defineProperty(window, 'overlook', {
      configurable: true,
      value: { appLock },
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          IntlProvider,
          { locale: 'en', defaultLocale: 'en' },
          createElement(LockScreen, {
            platform: 'darwin',
            state: 'locked',
            retryAfterMs: 0,
            attemptsRemaining: 3,
            onSwitchLibrary: () => undefined,
          }),
        ),
      );
      await Promise.resolve();
    });
    const password = document.querySelector('input[name="app-password"]');
    const touchIdButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Unlock with Touch ID');
    assert.ok(password instanceof HTMLInputElement);
    assert.ok(touchIdButton instanceof HTMLButtonElement);
    act(() => {
      Object.defineProperty(password, 'value', {
        configurable: true,
        value: 'app password',
        writable: true,
      });
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });

    now = 2_000;
    await act(async () => {
      touchIdButton.click();
      await Promise.resolve();
    });

    const unlockButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Unlock');
    assert.ok(unlockButton instanceof HTMLButtonElement);
    assert.equal(unlockButton.disabled, false);
    assert.equal(document.querySelector('#lock-screen-retry-countdown'), null);
  } finally {
    Date.now = originalNow;
  }
});
