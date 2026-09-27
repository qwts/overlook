import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';

import type { OverlookApi } from '../../src/shared/ipc/api.js';
import { AnnouncerProvider } from '../../src/renderer/src/components/LiveAnnouncer.js';
import { KeyDialog } from '../../src/renderer/src/settings/KeyDialog.js';

let root: Root | undefined;

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
    root = undefined;
  }
  Reflect.deleteProperty(window, 'overlook');
  document.body.replaceChildren();
});

async function render(platform: string): Promise<void> {
  const overlook = {
    getPlatform: () => Promise.resolve(platform),
    keys: {
      status: () => Promise.resolve({ fingerprint: '9F2C·4A81·D0E7·5B3A' }),
      export: () => Promise.resolve({ path: '/Users/ansel/Desktop/overlook-recovery.key' }),
    },
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
        createElement(AnnouncerProvider, null, createElement(KeyDialog, { open: true, mode: 'backup', onClose: () => undefined })),
      ),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function setInput(label: string, value: string): void {
  const input = document.querySelector(`input[aria-label="${label}"]`);
  assert.ok(input instanceof HTMLInputElement);
  // React tracks the prototype setter. Assigning input.value does not notify the controlled field.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to this input on the next line
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter !== undefined);
  Reflect.apply(setter, input, [value]);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function exportBackup(): Promise<void> {
  setInput('Encrypt backup with password', 'Correct Horse 9!');
  setInput('Confirm password', 'Correct Horse 9!');
  const checkbox = document.querySelector('input[type="checkbox"]');
  assert.ok(checkbox instanceof HTMLInputElement);
  act(() => {
    checkbox.click();
  });
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Export key backup');
  assert.ok(button instanceof HTMLButtonElement);
  assert.equal(button.disabled, false);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

test('a Mac recovery-key export says the library cannot be decrypted without the keychain copy and the recovery key', async () => {
  await render('darwin');
  await exportBackup();
  assert.match(document.body.textContent ?? '', /login-keychain copy of the master key/u);
  assert.match(document.body.textContent ?? '', /cannot be decrypted/u);
});

test('other platforms keep the recovery-key note without a login-keychain claim', async () => {
  await render('win32');
  await exportBackup();
  assert.match(document.body.textContent ?? '', /Keep this file and its password apart/u);
  assert.doesNotMatch(document.body.textContent ?? '', /login-keychain copy/u);
});
