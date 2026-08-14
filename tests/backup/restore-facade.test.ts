import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRestoreFacade, formatRestoreCsv } from '../../src/main/backup/restore-facade.js';
import type { RestoreCoordinator, RestoreKeySource } from '../../src/main/backup/restore-coordinator.js';
import type { RestoreVerifyResult } from '../../src/main/backup/restore-engine.js';
import type { AppAuthorizationResult, AppLockState } from '../../src/main/crypto/app-lock-controller.js';
import type { DiagnosticOccurrence } from '../../src/main/diagnostics/diagnostics-service.js';

// #741: the facade maps the IPC key argument onto the coordinator's key
// source — 'local-master' must never touch the recovery-key file path — and
// gates runs behind the provider-work lock.
// #754: releasing the resident master key is destructive-class authority.
// With a lock configured, discovery demands the app password at use time and
// refuses in the main process regardless of what the renderer sent.

function plan(overrides?: Partial<RestoreVerifyResult>): RestoreVerifyResult {
  return {
    libraryId: 'L1',
    generation: 59,
    manifestPath: 'manifest/gen-59.ovlk',
    sealedManifestSha256: 'a'.repeat(64),
    objectSetSha256: 'b'.repeat(64),
    photos: 1,
    missing: [],
    missingCount: 0,
    corruptCount: 0,
    verifiedCount: 1,
    ...overrides,
  };
}

function harness(options?: {
  busy?: boolean;
  lockState?: AppLockState | (() => AppLockState);
  authorize?: (password: string) => AppAuthorizationResult;
  runError?: { reason: 'io' | 'corrupt'; message: string; phase?: 'discovering' | 'downloading' | 'rebuilding' | 'activating' };
  verifyError?: { reason: 'io' | 'corrupt'; message: string; phase?: 'verify-scan' };
  verifyResult?: { missingCount: number; corruptCount: number };
  verification?: RestoreVerifyResult | null;
}) {
  const calls: {
    discovered: [string, RestoreKeySource][];
    ran: [string, string, string, boolean][];
    authorized: string[];
    diagnostics: DiagnosticOccurrence[];
    expired: number;
    cancelled: number;
    dismissed: number;
    trashed: [string, string, string, string][];
    exportedCorrupt: [string, string, string][];
  } = {
    discovered: [],
    ran: [],
    authorized: [],
    diagnostics: [],
    expired: 0,
    cancelled: 0,
    dismissed: 0,
    trashed: [],
    exportedCorrupt: [],
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
    verify: () =>
      Promise.resolve({
        result:
          options?.verifyResult === undefined
            ? null
            : {
                verificationId: 'v1',
                libraryId: 'L1',
                generation: 59,
                photos: 1,
                verifiedCount: 0,
                missingCount: options.verifyResult.missingCount,
                corruptCount: options.verifyResult.corruptCount,
                missing: [],
              },
        error: options?.verifyError ?? null,
      }),
    expireSession: () => {
      calls.expired += 1;
    },
    cancel: () => {
      calls.cancelled += 1;
    },
    dismissVerification: () => {
      calls.dismissed += 1;
    },
    verificationFor: () => options?.verification ?? null,
    trash: (sessionId: string, libraryId: string, verificationId: string, confirmation: string) => {
      calls.trashed.push([sessionId, libraryId, verificationId, confirmation]);
      return Promise.resolve({ trashed: true, error: null });
    },
    exportCorrupt: (
      sessionId: string,
      libraryId: string,
      verificationId: string,
      writeImage: (fileName: string, bytes: Buffer) => Promise<void>,
    ) => {
      calls.exportedCorrupt.push([sessionId, libraryId, verificationId]);
      return writeImage('P1-IMG_1.JPG', Buffer.from('jpeg')).then(() => ({
        exported: true,
        count: 1,
        unavailable: 0,
        error: null,
      }));
    },
    status: () => ({
      phase: 'idle' as const,
      sessionId: null,
      libraryId: null,
      providerId: null,
      progress: null,
      lastError: null,
      lastResult: null,
      verification: null,
      libraries: [],
    }),
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

test('status is the coordinator snapshot', () => {
  const { facade } = harness();
  assert.equal(facade.status().phase, 'idle');
});

test('Do nothing cancels in-flight work and dismisses the verify plan (#994)', () => {
  const { facade, calls } = harness();
  facade.cancel();
  assert.equal(calls.cancelled, 1);
  assert.equal(calls.dismissed, 1);
});

test('Discard refuses a mistyped confirmation before the coordinator runs', async () => {
  const { facade, calls } = harness();
  const refused = await facade.trash('s1', 'L1', 'v1', 'delete');
  assert.equal(refused.trashed, false);
  assert.deepEqual(calls.trashed, []);
  const accepted = await facade.trash('s1', 'L1', 'v1', 'Permanently Delete Backup');
  assert.equal(accepted.trashed, true);
  assert.deepEqual(calls.trashed, [['s1', 'L1', 'v1', 'Permanently Delete Backup']]);
});

test('verify is refused while provider work is active; gap results record corrupt diagnostics', async () => {
  const blocked = harness({ busy: true });
  const refused = await blocked.facade.verify('s1', 'L1');
  assert.equal(refused.error?.reason, 'io');

  const gaps = harness({ verifyResult: { missingCount: 2, corruptCount: 1 } });
  await gaps.facade.verify('s1', 'L1');
  assert.equal(gaps.calls.diagnostics[0]?.kind, 'restore-verify-failed');
  assert.equal(gaps.calls.diagnostics[0]?.failureReason, 'corrupt');
});

test('configured lock: a recovery-required authorize result is refused in main (#754)', async () => {
  const { facade, calls } = harness({
    lockState: 'unlocked',
    authorize: () => ({ ok: false, reason: 'recovery-required' }),
  });
  const response = await facade.discover('pcloud', { localKey: true, password: 'pw' });
  assert.equal(response.error?.reason, 'destructive-authorization');
  assert.match(response.error?.message ?? '', /recovery is required/u);
  assert.deepEqual(calls.discovered, []);
});

test('exportCsv and exportCorrupt refuse an expired plan without opening a dialog', async () => {
  const { facade } = harness({ verification: null });
  const csv = await facade.exportCsv('s1', 'L1', 'v1');
  assert.equal(csv.exported, false);
  assert.match(csv.error ?? '', /expired/u);
  const corrupt = await facade.exportCorrupt('s1', 'L1', 'v1');
  assert.equal(corrupt.exported, false);
  assert.match(corrupt.error ?? '', /expired/u);
});

test('exportCorrupt with no failed-verification objects is a no-op', async () => {
  const { facade, calls } = harness({
    verification: plan({
      missing: [{ path: 'blobs/aa/gone', kind: 'original', photoId: 'P1', reason: 'not-found' }],
      missingCount: 1,
    }),
  });
  const result = await facade.exportCorrupt('s1', 'L1', 'v1');
  assert.deepEqual(result, { exported: true, count: 0, unavailable: 0, error: null });
  assert.deepEqual(calls.exportedCorrupt, []);
});

async function withElectronDialogs(
  stubs: {
    showSaveDialog?: () => Promise<{ canceled: boolean; filePath?: string }>;
    showOpenDialog?: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  },
  run: () => Promise<void>,
): Promise<void> {
  const { dialog } = await import('electron');
  const showSaveDialog = dialog.showSaveDialog.bind(dialog);
  const showOpenDialog = dialog.showOpenDialog.bind(dialog);
  if (stubs.showSaveDialog !== undefined) {
    dialog.showSaveDialog = stubs.showSaveDialog as typeof dialog.showSaveDialog;
  }
  if (stubs.showOpenDialog !== undefined) {
    dialog.showOpenDialog = stubs.showOpenDialog;
  }
  try {
    await run();
  } finally {
    dialog.showSaveDialog = showSaveDialog;
    dialog.showOpenDialog = showOpenDialog;
  }
}

test('exportCsv writes the missing-object list when the save dialog returns a path', async () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'overlook-restore-csv-')), 'gaps.csv');
  await withElectronDialogs({ showSaveDialog: () => Promise.resolve({ canceled: false, filePath: dest }) }, async () => {
    const { facade } = harness({
      verification: plan({
        missing: [{ path: 'blobs/aa/gone', kind: 'original', photoId: 'P1', reason: 'not-found' }],
        missingCount: 1,
      }),
    });
    const result = await facade.exportCsv('s1', 'L1', 'v1');
    assert.deepEqual(result, { exported: true, path: dest, error: null });
    assert.match(readFileSync(dest, 'utf8'), /blobs\/aa\/gone/);
  });
});

test('exportCsv and exportCorrupt treat a canceled dialog as a no-op', async () => {
  await withElectronDialogs(
    {
      showSaveDialog: () => Promise.resolve({ canceled: true }),
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    },
    async () => {
      const { facade } = harness({
        verification: plan({
          missing: [{ path: 'blobs/bb/bad', kind: 'original', photoId: 'P2', reason: 'failed-verification' }],
          corruptCount: 1,
        }),
      });
      assert.deepEqual(await facade.exportCsv('s1', 'L1', 'v1'), { exported: false, path: null, error: null });
      assert.deepEqual(await facade.exportCorrupt('s1', 'L1', 'v1'), { exported: false, count: 0, unavailable: 0, error: null });
    },
  );
});

test('exportCorrupt writes decryptable images into the chosen directory', async () => {
  const destDir = mkdtempSync(join(tmpdir(), 'overlook-restore-corrupt-'));
  await withElectronDialogs({ showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [destDir] }) }, async () => {
    const { facade, calls } = harness({
      verification: plan({
        missing: [{ path: 'blobs/bb/bad', kind: 'original', photoId: 'P2', reason: 'failed-verification' }],
        corruptCount: 1,
      }),
    });
    const result = await facade.exportCorrupt('s1', 'L1', 'v1');
    assert.deepEqual(result, { exported: true, count: 1, unavailable: 0, error: null });
    assert.deepEqual(calls.exportedCorrupt, [['s1', 'L1', 'v1']]);
    assert.equal(readFileSync(join(destDir, 'P1-IMG_1.JPG')).toString(), 'jpeg');
  });
});
