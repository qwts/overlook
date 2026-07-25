import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Session } from 'electron';

import { installDenyAllPermissionRequestHandler } from '../../src/main/permission-policy.js';

test('permission policy denies every renderer permission request', () => {
  let handler: Parameters<Session['setPermissionRequestHandler']>[0] | undefined;
  const defaultSession = {
    setPermissionRequestHandler(value: Parameters<Session['setPermissionRequestHandler']>[0]): void {
      handler = value;
    },
  } as unknown as Session;

  installDenyAllPermissionRequestHandler(defaultSession);
  assert.notEqual(handler, undefined);

  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read']) {
    let allowed: boolean | undefined;
    handler?.(
      {} as never,
      permission,
      (value) => {
        allowed = value;
      },
      {} as never,
    );
    assert.equal(allowed, false, `${permission} must be denied`);
  }
});
