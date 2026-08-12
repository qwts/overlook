import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { configureAppProfile } from '../../src/main/app-profile.js';
import { OVERLOOK_PRODUCT_NAME } from '../../src/shared/app-identity.js';

function profileApp(
  isPackaged = false,
  paths?: { readonly appData: string; readonly userData: string },
): {
  app: Parameters<typeof configureAppProfile>[0];
  calls: string[];
} {
  const calls: string[] = [];
  const defaults = paths ?? { appData: '/profiles', userData: '/profiles/electron' };
  return {
    app: {
      isPackaged,
      getPath: (name) => defaults[name],
      setName: (name) => calls.push(`name:${name}`),
      setPath: (name, value) => calls.push(`path:${name}:${value}`),
    },
    calls,
  };
}

describe('app profile identity', () => {
  it('sets the stable product name before an unpackaged profile override', () => {
    const { app, calls } = profileApp();

    assert.equal(configureAppProfile(app, '/tmp/overlook-profile'), '/tmp/overlook-profile');
    assert.deepEqual(calls, [`name:${OVERLOOK_PRODUCT_NAME}`, 'path:userData:/tmp/overlook-profile']);
  });

  it('binds an unpackaged launch to the stable Overlook profile by default', () => {
    const appData = mkdtempSync(join(tmpdir(), 'overlook-app-profile-development-'));
    const stable = join(appData, OVERLOOK_PRODUCT_NAME);
    const { app, calls } = profileApp(false, { appData, userData: join(appData, 'electron') });

    assert.equal(configureAppProfile(app, undefined), undefined);
    assert.equal(existsSync(stable), true);
    assert.deepEqual(readdirSync(appData), [OVERLOOK_PRODUCT_NAME]);
    assert.deepEqual(calls, [`name:${OVERLOOK_PRODUCT_NAME}`, `path:userData:${stable}`]);
  });

  it('capitalizes an existing lowercase profile without changing its children or custody', () => {
    const appData = mkdtempSync(join(tmpdir(), 'overlook-app-profile-case-migration-'));
    const legacy = join(appData, OVERLOOK_PRODUCT_NAME.toLowerCase());
    const stable = join(appData, OVERLOOK_PRODUCT_NAME);
    mkdirSync(join(legacy, 'library'), { recursive: true });
    writeFileSync(join(legacy, 'libraries.json'), '{"version":1,"entries":[]}');
    writeFileSync(join(legacy, 'library', 'library.db'), 'encrypted');
    const { app, calls } = profileApp(true, { appData, userData: legacy });

    configureAppProfile(app, undefined);

    assert.deepEqual(readdirSync(appData), [OVERLOOK_PRODUCT_NAME]);
    assert.equal(existsSync(join(stable, 'libraries.json')), true);
    assert.equal(existsSync(join(stable, 'library', 'library.db')), true);
    assert.deepEqual(calls, [`name:${OVERLOOK_PRODUCT_NAME}`, `path:userData:${stable}`]);
  });

  it('does not discover a legacy photos profile', () => {
    const appData = mkdtempSync(join(tmpdir(), 'overlook-app-profile-no-legacy-fallback-'));
    const stable = join(appData, OVERLOOK_PRODUCT_NAME);
    const legacy = join(appData, 'photos');
    const initial = join(appData, 'electron');
    mkdirSync(join(legacy, 'library'), { recursive: true });
    writeFileSync(join(legacy, 'library', 'library.db'), 'legacy');
    const { app, calls } = profileApp(true, { appData, userData: initial });

    configureAppProfile(app, undefined);

    assert.equal(existsSync(stable), true);
    assert.deepEqual(calls, [`name:${OVERLOOK_PRODUCT_NAME}`, `path:userData:${stable}`]);
  });

  it('ignores profile overrides and creates the stable profile before binding it in packaged builds', () => {
    const appData = mkdtempSync(join(tmpdir(), 'overlook-app-profile-first-launch-'));
    const stable = join(appData, OVERLOOK_PRODUCT_NAME);
    const { app, calls } = profileApp(true, { appData, userData: join(appData, 'electron') });

    assert.equal(configureAppProfile(app, '/tmp/overlook-profile'), undefined);
    assert.equal(existsSync(stable), true);
    assert.deepEqual(calls, [`name:${OVERLOOK_PRODUCT_NAME}`, `path:userData:${stable}`]);
  });

  it('reuses the established packaged profile containing the library registry and provider custody', () => {
    const appData = mkdtempSync(join(tmpdir(), 'overlook-app-profile-'));
    const stable = join(appData, OVERLOOK_PRODUCT_NAME);
    const initial = join(appData, 'com.zts1.overlook');
    mkdirSync(join(stable, 'provider-auth', 'pcloud'), { recursive: true });
    writeFileSync(join(stable, 'libraries.json'), '{"version":1,"entries":[]}');
    writeFileSync(join(stable, 'provider-auth', 'pcloud', 'pcloud-auth.bin'), 'sealed');
    const { app, calls } = profileApp(true, { appData, userData: initial });

    configureAppProfile(app, undefined);

    assert.deepEqual(calls, [`name:${OVERLOOK_PRODUCT_NAME}`, `path:userData:${stable}`]);
  });

  it('preserves a populated packaged profile when the conventional path is empty', () => {
    const appData = mkdtempSync(join(tmpdir(), 'overlook-app-profile-current-'));
    const initial = join(appData, 'current-profile');
    mkdirSync(join(initial, 'library'), { recursive: true });
    writeFileSync(join(initial, 'library', 'library.db'), 'encrypted');
    const { app, calls } = profileApp(true, { appData, userData: initial });

    configureAppProfile(app, undefined);

    assert.deepEqual(calls, [`name:${OVERLOOK_PRODUCT_NAME}`, `path:userData:${initial}`]);
  });
});
