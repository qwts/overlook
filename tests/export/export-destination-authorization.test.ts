import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ExportDestinationAuthorization } from '../../src/main/export/export-destination-authorization.js';

describe('export destination authorization', () => {
  test('only the selecting renderer can consume a destination once', () => {
    const authorizations = new ExportDestinationAuthorization();
    const token = authorizations.authorize(7, '/chosen/export');

    assert.throws(() => authorizations.consume(8, token), /not authorized/u);
    assert.equal(authorizations.consume(7, token), '/chosen/export');
    assert.throws(() => authorizations.consume(7, token), /not authorized/u);
  });

  test('a newer selection invalidates the previous selection', () => {
    const authorizations = new ExportDestinationAuthorization();
    const oldToken = authorizations.authorize(7, '/old');
    const newToken = authorizations.authorize(7, '/new');

    assert.throws(() => authorizations.consume(7, oldToken), /not authorized/u);
    assert.equal(authorizations.consume(7, newToken), '/new');
  });
});
