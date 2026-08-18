import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIntl, createIntlCache } from 'react-intl';

import { custodyPresentation } from '../../src/renderer/src/backup/custody-presentation.js';
import type { PhotoCustodyState, PhotoCustodyStatus } from '../../src/shared/backup/custody-status.js';

const states: readonly PhotoCustodyState[] = [
  'available',
  'disconnected',
  'wrong-account',
  'unavailable',
  'missing-corrupt',
  'provider-required',
  'legacy-unbound',
];

test('every custody state has distinct actionable copy (#734)', () => {
  const intl = createIntl({ locale: 'en', messages: {} }, createIntlCache());
  const status = (state: PhotoCustodyState): PhotoCustodyStatus => ({
    state,
    providerId: 'google-drive',
    providerLabel: 'Google Drive',
    accountLabel: 'm.rivera@gmail.com',
  });
  const copy = new Map(states.map((state) => [state, custodyPresentation(intl, status(state)).text]));

  assert.equal(new Set(copy.values()).size, states.length);
  assert.match(copy.get('disconnected') ?? '', /disconnected/u);
  assert.match(copy.get('wrong-account') ?? '', /Wrong Google Drive account/u);
  assert.match(copy.get('unavailable') ?? '', /unavailable/u);
  assert.match(copy.get('missing-corrupt') ?? '', /missing or corrupt/u);
  assert.match(copy.get('provider-required') ?? '', /Google Drive required/u);
  assert.match(copy.get('legacy-unbound') ?? '', /legacy cloud-only original/u);
});
