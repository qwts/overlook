import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { configureAppProfile, renameProfileDirectoryForMigration } from '../../src/main/app-profile.js';
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

  it('uses a distinct migration sibling when the first temporary name already exists', () => {
    const appData = mkdtempSync(join(tmpdir(), 'overlook-app-profile-case-temp-'));
    const legacy = join(appData, OVERLOOK_PRODUCT_NAME.toLowerCase());
    const stable = join(appData, OVERLOOK_PRODUCT_NAME);
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'libraries.json'), '{"version":1,"entries":[]}');
    writeFileSync(join(appData, `.overlook-case-migration-${String(process.pid)}`), 'occupied');
    const { app } = profileApp(true, { appData, userData: legacy });

    configureAppProfile(app, undefined);

    assert.equal(existsSync(join(stable, 'libraries.json')), true);
  });

  it('does not replace a distinct capitalized profile on a case-sensitive filesystem', () => {
    const appData = mkdtempSync(join(tmpdir(), 'overlook-app-profile-case-collision-'));
    const legacy = join(appData, OVERLOOK_PRODUCT_NAME.toLowerCase());
    const stable = join(appData, OVERLOOK_PRODUCT_NAME);
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'libraries.json'), 'legacy');
    mkdirSync(stable, { recursive: true });
    writeFileSync(join(stable, 'libraries.json'), 'stable');
    const legacyStat = statSync(legacy);
    const stableStat = statSync(stable);
    if (legacyStat.dev === stableStat.dev && legacyStat.ino === stableStat.ino) return;
    const { app, calls } = profileApp(true, { appData, userData: legacy });

    configureAppProfile(app, undefined);

    assert.equal(readFileSync(join(legacy, 'libraries.json'), 'utf8'), 'legacy');
    assert.equal(readFileSync(join(stable, 'libraries.json'), 'utf8'), 'stable');
    assert.deepEqual(calls, [`name:${OVERLOOK_PRODUCT_NAME}`, `path:userData:${stable}`]);
  });

  it('restores the lowercase profile when the capitalization rename fails', () => {
    const appData = mkdtempSync(join(tmpdir(), 'overlook-app-profile-case-rollback-'));
    const legacy = join(appData, 'overlook');
    const temporary = join(appData, '.migration');
    const stable = join(appData, 'Overlook');
    mkdirSync(legacy);
    const destinationError = new Error('destination unavailable');

    assert.throws(
      () =>
        renameProfileDirectoryForMigration(legacy, temporary, stable, (from, to) => {
          if (to === stable) throw destinationError;
          renameSync(from, to);
        }),
      (error: unknown) => error === destinationError,
    );
    assert.equal(existsSync(legacy), true);
    assert.equal(existsSync(temporary), false);
  });

  it('reports both errors when capitalization and rollback fail', () => {
    const appData = mkdtempSync(join(tmpdir(), 'overlook-app-profile-case-rollback-failure-'));
    const legacy = join(appData, 'overlook');
    const temporary = join(appData, '.migration');
    const stable = join(appData, 'Overlook');
    mkdirSync(legacy);
    const destinationError = new Error('destination unavailable');
    const rollbackError = new Error('rollback unavailable');
    let calls = 0;

    assert.throws(
      () =>
        renameProfileDirectoryForMigration(legacy, temporary, stable, (from, to) => {
          calls += 1;
          if (calls === 1) renameSync(from, to);
          else if (calls === 2) throw destinationError;
          else throw rollbackError;
        }),
      (error: unknown) => error instanceof AggregateError && error.errors[0] === destinationError && error.cause === rollbackError,
    );
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
