import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RelocationDestinationAuthorization } from '../../src/main/library/relocation-destination-authorization.js';

test('a picker grant authorizes only the selected directory tree', () => {
  const authorization = new RelocationDestinationAuthorization();
  const token = authorization.authorize('/chosen/root');

  assert.equal(authorization.permits(token, '/chosen/root'), true);
  assert.equal(authorization.permits(token, '/chosen/root/Library'), true);
  assert.equal(authorization.permits(token, '/chosen/root-sibling/Library'), false);
  assert.equal(authorization.permits(token, '/attacker-controlled/Library'), false);
  assert.equal(authorization.permits('unknown-token', '/chosen/root'), false);
});
