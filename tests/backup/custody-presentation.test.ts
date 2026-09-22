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

test('custody messages interpolate fallback labels without leaking unused account values (#1170)', () => {
  const intl = createIntl(
    {
      locale: 'en',
      messages: {},
      onError: (error) => {
        throw error;
      },
    },
    createIntlCache(),
  );
  for (const state of states) {
    const { text } = custodyPresentation(intl, { state, providerId: null, providerLabel: null, accountLabel: null });
    assert.doesNotMatch(text, /\{(?:provider|account)\}/u);
    if (state !== 'legacy-unbound') assert.ok(text.includes('Cloud provider'), state);
    if (['available', 'disconnected', 'wrong-account', 'provider-required'].includes(state)) {
      assert.ok(text.includes('the recorded account'), state);
    } else {
      assert.ok(!text.includes('the recorded account'), state);
    }
  }
  const { text } = custodyPresentation(intl, { state: 'available', providerId: 'pcloud', providerLabel: null, accountLabel: null });
  assert.ok(text.includes('pcloud'), 'the recorded provider ID precedes the generic label');
});

test('typed custody descriptors still select translations and interpolate provider/account values (#1170)', () => {
  const intl = createIntl(
    {
      locale: 'en',
      messages: {
        'custody.state.available': '{account}: recover from {provider}',
        'custody.state.unavailable': 'Retry {provider}',
      },
      onError: (error) => {
        throw error;
      },
    },
    createIntlCache(),
  );
  const status = { providerId: 'google-drive', providerLabel: 'Drive label', accountLabel: 'Recorded account' } as const;
  assert.equal(custodyPresentation(intl, { ...status, state: 'available' }).text, 'Recorded account: recover from Drive label');
  assert.equal(custodyPresentation(intl, { ...status, state: 'unavailable' }).text, 'Retry Drive label');
});
