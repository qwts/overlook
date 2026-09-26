import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createIntl, createIntlCache, IntlProvider } from 'react-intl';
import { OriginalRecoveryAction, recoverOriginalWithMessage } from '../../src/renderer/src/inspector/original-recovery-action.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';

test('recovery action names the absent retained key rather than the present original key (#1101)', async () => {
  // The locked path only reads these presentation fields and never calls IPC.
  const photo = {
    id: 'recovered',
    keyId: 3,
    missingKeyId: 2,
    locked: true,
    originalFailure: 'missing-original',
    deletedAt: null,
  } as PhotoRecord;
  const intl = createIntl({ locale: 'en', messages: {} }, createIntlCache());
  assert.equal(await recoverOriginalWithMessage(photo, intl), 'LOCKED — KEY #2 IS NOT ON THIS DEVICE');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <IntlProvider locale="en" messages={{}}>
          <OriginalRecoveryAction photo={photo} />
        </IntlProvider>,
      ),
    );
    const button = container.querySelector('button');
    assert.ok(button);
    assert.equal(button.disabled, true);
    assert.equal(button.title, 'LOCKED — KEY #2 IS NOT ON THIS DEVICE');
    assert.ok(container.textContent?.includes('KEY #2'));
    assert.ok(!container.textContent?.includes('KEY #3'));
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
