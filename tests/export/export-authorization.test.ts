import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ExportAuthorizationStore } from '../../src/main/export/export-authorization.js';

describe('ExportAuthorizationStore', () => {
  test('binds a one-use native-picker grant to its renderer and photo selection', () => {
    const store = new ExportAuthorizationStore();
    const grant = store.issue(7, ['cloud-original'], '/chosen', 1_000);

    assert.throws(() => store.consume(8, ['cloud-original'], grant, 1_001));
    assert.throws(() => store.consume(7, ['cloud-original'], grant, 1_001), /invalid or expired/);
  });

  test('returns the authorized destination exactly once', () => {
    const store = new ExportAuthorizationStore();
    const grant = store.issue(7, ['a', 'b'], '/chosen', 1_000);

    assert.equal(store.consume(7, ['a', 'b'], grant, 1_001), '/chosen');
    assert.throws(() => store.consume(7, ['a', 'b'], grant, 1_002));
  });

  test('rejects changed photo IDs and expired grants', () => {
    const store = new ExportAuthorizationStore();
    const changed = store.issue(7, ['cloud-original'], '/chosen', 1_000);
    assert.throws(() => store.consume(7, ['different'], changed, 1_001));

    const expired = store.issue(7, ['cloud-original'], '/chosen', 1_000);
    assert.throws(() => store.consume(7, ['cloud-original'], expired, 301_001));
  });
});
