import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Session } from 'electron';

import { installDenyAllPermissionRequestHandler } from '../../src/main/permission-policy.js';

test('permission policy denies every renderer permission request', () => {
  let checkHandler: Parameters<Session['setPermissionCheckHandler']>[0] | undefined;
  let handler: Parameters<Session['setPermissionRequestHandler']>[0] | undefined;
  const defaultSession = {
    setPermissionCheckHandler(value: Parameters<Session['setPermissionCheckHandler']>[0]): void {
      checkHandler = value;
    },
    setPermissionRequestHandler(value: Parameters<Session['setPermissionRequestHandler']>[0]): void {
      handler = value;
    },
  } as unknown as Session;

  installDenyAllPermissionRequestHandler(defaultSession);
  assert.notEqual(checkHandler, undefined);
  assert.notEqual(handler, undefined);

  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read'] as const) {
    assert.equal(
      checkHandler?.({} as never, permission, 'https://overlook.invalid', {} as never),
      false,
      `${permission} checks must be denied`,
    );
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
