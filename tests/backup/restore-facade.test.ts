import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRestoreFacade, formatRestoreCsv } from '../../src/main/backup/restore-facade.js';
import type { RestoreCoordinator, RestoreKeySource } from '../../src/main/backup/restore-coordinator.js';
import type { AppAuthorizationResult, AppLockState } from '../../src/main/crypto/app-lock-controller.js';
import type { DiagnosticOccurrence } from '../../src/main/diagnostics/diagnostics-service.js';

// #741: the facade maps the IPC key argument onto the coordinator's key
// source — 'local-master' must never touch the recovery-key file path — and
// gates runs behind the provider-work lock.
// #754: releasing the resident master key is destructive-class authority.
// With a lock configured, discovery demands the app password at use time and
// refuses in the main process regardless of what the renderer sent.

function harness(options?: {
  busy?: boolean;
  lockState?: AppLockState | (() => AppLockState);
  authorize?: (password: string) => AppAuthorizationResult;
  runError?: { reason: 'io' | 'corrupt'; message: string; phase?: 'discovering' | 'downloading' | 'rebuilding' | 'activating' };
  verifyError?: { reason: 'io' | 'corrupt'; message: string; phase?: 'verify-scan' };
}) {
  const calls: {
    discovered: [string, RestoreKeySource][];
    ran: [string, string, string, boolean][];
    authorized: string[];
    diagnostics: DiagnosticOccurrence[];
    expired: number;
  } = {
    discovered: [],
    ran: [],
    authorized: [],
    diagnostics: [],
    expired: 0,
  };
  const coordinator = {
    discoverFrom: (providerId: string, source: RestoreKeySource) => {
      calls.discovered.push([providerId, source]);
      return Promise.resolve({ sessionId: 's1', libraries: [], error: null });
    },
    run: (sessionId: string, libraryId: string, verificationId: string, allowReplace: boolean) => {
      calls.ran.push([sessionId, libraryId, verificationId, allowReplace]);
      return Promise.resolve({ result: null, error: options?.runError ?? null });
    },
    verify: () => Promise.resolve({ result: null, error: options?.verifyError ?? null }),
    expireSession: () => {
      calls.expired += 1;
    },
    cancel: () => undefined,
  } as unknown as RestoreCoordinator;
  const facade = createRestoreFacade({
    coordinator: () => coordinator,
    fresh: () => true,
    pickKey: () => Promise.resolve('/tmp/key.ovrk'),
    busy: () => options?.busy ?? false,
    lockState: () => {
      const state = options?.lockState ?? 'unconfigured-unlocked';
      return typeof state === 'function' ? state() : state;
    },
    authorizePassword: (password) => {
      calls.authorized.push(password);
      return Promise.resolve(options?.authorize?.(password) ?? { ok: true });
    },
    recordDiagnostic: (occurrence) => {
      calls.diagnostics.push(occurrence);
      return true;
    },
  });
  return { facade, calls };
}

test('with no lock configured, the local key reaches the coordinator without custody password (#741/#754)', async () => {
  const { facade, calls } = harness();
  await facade.discover('pcloud', { localKey: true });
  assert.deepEqual(calls.discovered, [['pcloud', { kind: 'local-master' }]]);
  assert.deepEqual(calls.authorized, [], 'an unconfigured lock has no password to demand');
});

test('a recovery-key request carries path and password through unchanged', async () => {
  const { facade, calls } = harness();
  await facade.discover('pcloud', { keyPath: '/keys/r.ovrk', password: 'pw' });
  assert.deepEqual(calls.discovered, [['pcloud', { kind: 'recovery-key', path: '/keys/r.ovrk', password: 'pw' }]]);
});

test('configured lock: local-key discovery without a password is refused in main (#754)', async () => {
  const { facade, calls } = harness({ lockState: 'unlocked' });
  const response = await facade.discover('pcloud', { localKey: true });
  assert.equal(response.error?.reason, 'destructive-authorization');
  assert.deepEqual(calls.discovered, [], 'the master key must not be released');
  assert.deepEqual(calls.authorized, []);
});

test('configured lock: a wrong password is refused and never reaches the coordinator (#754)', async () => {
  const { facade, calls } = harness({ lockState: 'unlocked', authorize: () => ({ ok: false, reason: 'wrong-password' }) });
  const response = await facade.discover('pcloud', { localKey: true, password: 'nope' });
  assert.equal(response.error?.reason, 'destructive-authorization');
  assert.match(response.error?.message ?? '', /incorrect/u);
  assert.deepEqual(calls.authorized, ['nope'], 'the throttle-owning authorize path judged the attempt');
  assert.deepEqual(calls.discovered, []);
});

test('configured lock: throttled attempts surface the retry window (#754)', async () => {
  const { facade, calls } = harness({
    lockState: 'unlocked',
    authorize: () => ({ ok: false, reason: 'throttled', retryAfterMs: 4200 }),
  });
  const response = await facade.discover('pcloud', { localKey: true, password: 'pw' });
  assert.equal(response.error?.reason, 'destructive-authorization');
  assert.match(response.error?.message ?? '', /5s/u);
  assert.deepEqual(calls.discovered, []);
});

test('configured lock: the correct password proceeds and rides along as custody authority (#754)', async () => {
  const { facade, calls } = harness({ lockState: 'unlocked' });
  const response = await facade.discover('pcloud', { localKey: true, password: 'correct horse' });
  assert.equal(response.error, null);
  assert.deepEqual(calls.authorized, ['correct horse']);
  assert.deepEqual(calls.discovered, [['pcloud', { kind: 'local-master', custodyPassword: 'correct horse' }]]);
});

test('a locked or recovery-required app refuses local-key discovery outright (#754)', async () => {
  for (const lockState of ['locked', 'recovery-required'] as const) {
    const { facade, calls } = harness({ lockState });
    const response = await facade.discover('pcloud', { localKey: true, password: 'pw' });
    assert.equal(response.error?.reason, 'destructive-authorization');
    assert.deepEqual(calls.discovered, []);
    assert.deepEqual(calls.authorized, [], 'authorize is for open sessions; locked states fail closed first');
  }
});

test('every local-key refusal expires the prior discovery session (#757 review)', async () => {
  const missing = harness({ lockState: 'unlocked' });
  await missing.facade.discover('pcloud', { localKey: true });
  assert.equal(missing.calls.expired, 1, 'a missing password refusal expires the session');

  const wrong = harness({ lockState: 'unlocked', authorize: () => ({ ok: false, reason: 'wrong-password' }) });
  await wrong.facade.discover('pcloud', { localKey: true, password: 'nope' });
  assert.equal(wrong.calls.expired, 1, 'a wrong password refusal expires the session');

  const locked = harness({ lockState: 'locked' });
  await locked.facade.discover('pcloud', { localKey: true, password: 'pw' });
  assert.equal(locked.calls.expired, 1, 'a locked-state refusal expires the session');

  const granted = harness({ lockState: 'unlocked' });
  await granted.facade.discover('pcloud', { localKey: true, password: 'pw' });
  assert.equal(granted.calls.expired, 0, 'a granted discovery expires the old session itself');
});

test('a verified password survives a lock transition between authorization and forwarding (#757 review)', async () => {
  const states: AppLockState[] = ['unlocked', 'locked'];
  const { facade, calls } = harness({ lockState: () => states.shift() ?? 'locked' });
  const response = await facade.discover('pcloud', { localKey: true, password: 'still counts' });
  assert.equal(response.error, null);
  assert.deepEqual(calls.discovered, [['pcloud', { kind: 'local-master', custodyPassword: 'still counts' }]]);
});

test('runs are refused while provider work is active; idle runs delegate', async () => {
  const blocked = harness({ busy: true });
  const refused = await blocked.facade.run('s1', 'L1', 'v1', false);
  assert.equal(refused.error?.reason, 'io');
  assert.deepEqual(blocked.calls.ran, []);

  const idle = harness();
  await idle.facade.run('s1', 'L1', 'v1', false);
  assert.deepEqual(idle.calls.ran, [['s1', 'L1', 'v1', false]]);
  assert.deepEqual(idle.facade.profileStatus(), { fresh: true });
  assert.equal(await idle.facade.pickKey(), '/tmp/key.ovrk');
});

test('missing-object CSV quotes commas, quotes, and embedded newlines', () => {
  assert.equal(
    formatRestoreCsv([
      { path: 'blobs/a,"b"\nnext', kind: 'original', photoId: 'photo,1', reason: 'failed-verification' },
      { path: 'sidecars/lost', kind: 'sidecar', photoId: null, reason: 'not-found' },
    ]),
    'path,kind,photoId,reason\n"blobs/a,""b""\nnext","original","photo,1","failed-verification"\n"sidecars/lost","sidecar","","not-found"\n',
  );
});

test('restore diagnostics use the injected recorder, actual stage, and bounded message fields', async () => {
  const longMessage = 'x'.repeat(250);
  const run = harness({ runError: { reason: 'io', message: longMessage, phase: 'activating' } });
  await run.facade.run('s1', 'L1', 'v1', true);
  assert.deepEqual(run.calls.diagnostics, [
    {
      kind: 'restore-failed',
      failureReason: 'io',
      messagePreview: `${'x'.repeat(197)}...`,
      phase: 'activating',
    },
  ]);

  const verify = harness({ verifyError: { reason: 'corrupt', message: 'authentication failed', phase: 'verify-scan' } });
  await verify.facade.verify('s1', 'L1');
  assert.deepEqual(verify.calls.diagnostics, [
    {
      kind: 'restore-verify-failed',
      failureReason: 'corrupt',
      messagePreview: 'authentication failed',
      phase: 'verify-scan',
    },
  ]);
});
