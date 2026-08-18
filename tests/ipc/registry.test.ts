import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { channels, events } from '../../src/shared/ipc/channels.js';
import { createEmitter, createInvoker, createSubscriber, IpcRemoteError, wrapHandler } from '../../src/shared/ipc/registry.js';
import { PHOTO_PURGE_AUTHORIZATION, PROVIDER_AUTHORIZATION_REMOVAL } from '../../src/shared/destructive-actions.js';

describe('channel registry', () => {
  test('channel and event names are unique', () => {
    const names = [...Object.values(channels).map((c) => c.name), ...Object.values(events).map((e) => e.name)];
    assert.equal(new Set(names).size, names.length);
  });

  test('offload workflow schemas preserve exact preflight and partial-result details (#281)', () => {
    assert.deepEqual(
      channels.backupOffloadPreflight.response.parse({
        eligible: 1,
        ineligible: 1,
        estimatedFreedBytes: 42,
        items: [
          { photoId: 'P1', bytes: 42, eligible: true, reason: null },
          { photoId: 'P2', bytes: 9, eligible: false, reason: 'dirty' },
        ],
      }),
      {
        eligible: 1,
        ineligible: 1,
        estimatedFreedBytes: 42,
        items: [
          { photoId: 'P1', bytes: 42, eligible: true, reason: null },
          { photoId: 'P2', bytes: 9, eligible: false, reason: 'dirty' },
        ],
      },
    );
    assert.throws(() => channels.backupOffload.response.parse({ offloaded: 1, skipped: 0, freedBytes: 42 }));
  });

  test('bulk metadata summaries allow aggregate tag unions beyond the per-photo cap (#508 review)', () => {
    const varyingTags = Array.from({ length: 102 }, (_, index) => `tag-${String(index).padStart(3, '0')}`);
    assert.deepEqual(
      channels.libraryMetadataSummary.response.parse({
        found: 2,
        missing: 0,
        title: { mixed: false, value: null },
        description: { mixed: false, value: null },
        commonTags: [],
        varyingTags,
      }).varyingTags,
      varyingTags,
    );
  });

  test('Touch ID IPC exposes states but strips native and unlock secrets (#310)', () => {
    assert.deepEqual(
      channels.appLockTouchIdStatus.response.parse({
        available: true,
        reason: null,
        enabled: true,
        reenrollmentRequired: false,
        nativeDetail: 'LAError -42',
      }),
      { available: true, reason: null, enabled: true, reenrollmentRequired: false },
    );
    assert.deepEqual(
      channels.appLockTouchIdUnlock.response.parse({
        ok: true,
        reason: null,
        retryAfterMs: 0,
        attemptsRemaining: 3,
        unlockKey: Buffer.alloc(32, 5),
        masterKey: Buffer.alloc(32, 6),
      }),
      { ok: true, reason: null, retryAfterMs: 0, attemptsRemaining: 3 },
    );
  });

  test('interop IPC accepts one-shot passwords but status cannot carry credentials or keys (#676)', () => {
    assert.deepEqual(channels.interopPairingUnlock.request.parse({ password: 'pairing password' }), { password: 'pairing password' });
    assert.throws(() => channels.interopPairingUnlock.request.parse({ password: '' }));
    const cleanStatus = {
      provider: { provider: 'pcloud', status: 'connected', busy: false, token: 'secret' },
      pairing: {
        status: 'unlocked',
        pairingId: '665fc4f8-8287-42db-b195-f7828d530da8',
        keyId: 'interop:81ad4f06-0ecf-4a24-8c65-fcd34075cf15',
        createdAt: '2026-07-21T12:00:00.000Z',
        interopKey: 'secret',
      },
      batches: [],
      selectedTransferId: null,
      progress: { transferId: null, phase: 'queued', processed: 0, total: 0, accepted: 0, retained: 0 },
      error: null,
    };
    assert.throws(() => channels.interopStatus.response.parse(cleanStatus));
    assert.doesNotThrow(() =>
      channels.interopStatus.response.parse({
        ...cleanStatus,
        provider: { provider: 'pcloud', status: 'connected', busy: false },
        pairing: {
          status: 'unlocked',
          pairingId: '665fc4f8-8287-42db-b195-f7828d530da8',
          keyId: 'interop:81ad4f06-0ecf-4a24-8c65-fcd34075cf15',
          createdAt: '2026-07-21T12:00:00.000Z',
        },
      }),
    );
  });

  test('protected album IPC strips domain equality and library custody fields (#327)', () => {
    const parsed = channels.protectedAlbumPage.response.parse({
      photos: [
        {
          id: 'P1',
          fileName: 'private.jpg',
          fileKind: 'jpeg',
          mediaInfo: null,
          width: 10,
          height: 10,
          bytes: 42,
          camera: null,
          lens: null,
          iso: null,
          aperture: null,
          shutter: null,
          focalLength: null,
          takenAt: null,
          gpsLat: null,
          gpsLon: null,
          place: null,
          title: null,
          description: null,
          tags: [],
          userTags: [],
          importedKeywords: [],
          suppressedKeywords: [],
          metadataVersion: 1,
          importedAt: '2026-07-16T12:00:00.000Z',
          importSource: 'test',
          favorite: false,
          deletedAt: null,
          contentHash: 'a'.repeat(64),
          keyId: 1,
          syncState: 'synced',
        },
      ],
      nextCursor: null,
    });
    const [photo] = parsed.photos;
    assert.ok(photo);
    assert.equal('contentHash' in photo, false);
    assert.equal('keyId' in photo, false);
    assert.equal('syncState' in photo, false);
    assert.throws(() =>
      channels.protectedAlbumExportRun.request.parse({
        albumId: '',
        photoIds: [],
        destination: '',
      }),
    );
  });

  test('diagnostics export accepts only a unique bounded reviewed snapshot (#286)', () => {
    const eventId = '98f581d6-ef9a-45e2-ae19-8b90099aef2e';
    assert.deepEqual(channels.diagnosticsExport.request.parse({ eventIds: [eventId] }), { eventIds: [eventId] });
    assert.throws(() => channels.diagnosticsExport.request.parse({ eventIds: [eventId, eventId] }));
    assert.throws(() => channels.diagnosticsExport.request.parse({ eventIds: Array.from({ length: 51 }, () => eventId) }));
  });

  test('permanent purge requires the ADR-0023 ceremony acknowledgement', () => {
    assert.throws(() => channels.libraryPurge.request.parse({ photoIds: ['P1'] }));
    assert.throws(() => channels.libraryPurge.request.parse({ photoIds: ['P1'], authorization: 'stale-confirmation' }));
    assert.deepEqual(channels.libraryPurge.request.parse({ photoIds: ['P1'], authorization: PHOTO_PURGE_AUTHORIZATION }), {
      photoIds: ['P1'],
      authorization: PHOTO_PURGE_AUTHORIZATION,
    });
  });

  test('emergency provider removal requires its ADR-0023 risk acknowledgement (#732)', () => {
    assert.throws(() => channels.backupRemoveAuthorizationAnyway.request.parse({ providerId: 'pcloud' }));
    assert.throws(() =>
      channels.backupRemoveAuthorizationAnyway.request.parse({ providerId: 'pcloud', authorization: 'stale-confirmation' }),
    );
    assert.deepEqual(
      channels.backupRemoveAuthorizationAnyway.request.parse({
        providerId: 'pcloud',
        authorization: PROVIDER_AUTHORIZATION_REMOVAL,
      }),
      { providerId: 'pcloud', authorization: PROVIDER_AUTHORIZATION_REMOVAL },
    );
  });

  test('disconnect custody preflight is read-only and provider-addressed (#734)', () => {
    assert.deepEqual(channels.backupDisconnectPreflight.request.parse({ providerId: 'pcloud' }), { providerId: 'pcloud' });
    assert.throws(() => channels.backupDisconnectPreflight.request.parse({ providerId: '../pcloud' }));
    assert.deepEqual(
      channels.backupDisconnectPreflight.response.parse({
        ok: false,
        reason: 'Restore required.',
        code: 'custody-restore-required',
        retryable: false,
        custody: {
          credential: { providerId: 'pcloud', accountId: 'account-1' },
          totalItems: 1,
          totalBytes: 42,
          libraries: [{ libraryId: 'library-1', name: 'Archive', items: 1, bytes: 42, legacyUnbound: false }],
        },
      }).code,
      'custody-restore-required',
    );
  });

  test('clipboard writes are bounded and registry-validated (#805)', () => {
    assert.deepEqual(channels.clipboardWrite.request.parse({ text: 'copy me' }), { text: 'copy me' });
    assert.throws(() => channels.clipboardWrite.request.parse({ text: 'x'.repeat(1_000_001) }));
    assert.deepEqual(channels.clipboardWrite.response.parse({}), {});
  });
});

describe('createInvoker', () => {
  test('round-trips a valid request through the transport', async () => {
    const calls: Array<{ name: string; request: unknown }> = [];
    const invoke = createInvoker(channels.ping, (name, request) => {
      calls.push({ name, request });
      return Promise.resolve({ echoed: 'hello' });
    });

    const response = await invoke({ message: 'hello' });

    assert.deepEqual(response, { echoed: 'hello' });
    assert.deepEqual(calls, [{ name: 'demo:ping', request: { message: 'hello' } }]);
  });

  test('rejects an invalid request before it reaches the transport', async () => {
    let transportCalled = false;
    const invoke = createInvoker(channels.ping, () => {
      transportCalled = true;
      return Promise.resolve({ echoed: 'x' });
    });

    // Cast simulates a caller sidestepping the compile-time types.
    // type-coverage:ignore-next-line
    await assert.rejects(invoke({ message: 42 } as unknown as { message: string }));
    assert.equal(transportCalled, false);
  });

  test('rejects a malformed response from the transport', async () => {
    const invoke = createInvoker(channels.ping, () => Promise.resolve({ wrong: true }));
    await assert.rejects(invoke({ message: 'hello' }));
  });

  test('turns a main-process failure envelope into an opaque renderer error', async () => {
    const invoke = createInvoker(channels.ping, () =>
      Promise.resolve({
        __overlookIpcFailure: true,
        error: { code: 'IPC_HANDLER_FAILED' },
        detail: 'SECRET /Users/example/private-library',
      }),
    );

    await assert.rejects(invoke({ message: 'hello' }), (error: unknown) => {
      assert.ok(error instanceof IpcRemoteError);
      assert.equal(error.code, 'IPC_HANDLER_FAILED');
      assert.equal(error.message, 'IPC_HANDLER_FAILED');
      assert.doesNotMatch(JSON.stringify(error), /SECRET|private-library/u);
      return true;
    });
  });
});

describe('wrapHandler', () => {
  test('validates the request, runs the handler, validates the response', async () => {
    const handler = wrapHandler(channels.ping, ({ message }) => ({ echoed: message }));
    assert.deepEqual(await handler({ message: 'hi' }), { echoed: 'hi' });
  });

  test('returns an opaque code for a malformed request without running the handler', async () => {
    let handlerRan = false;
    const handler = wrapHandler(channels.ping, ({ message }) => {
      handlerRan = true;
      return { echoed: message };
    });

    assert.deepEqual(await handler({ nope: true }), {
      __overlookIpcFailure: true,
      error: { code: 'IPC_INVALID_REQUEST' },
    });
    assert.equal(handlerRan, false);
  });

  test('returns an opaque code for a handler response that violates the schema', async () => {
    // type-coverage:ignore-next-line
    const handler = wrapHandler(channels.ping, () => ({ echoed: 7 }) as unknown as { echoed: string });
    assert.deepEqual(await handler({ message: 'hi' }), {
      __overlookIpcFailure: true,
      error: { code: 'IPC_INVALID_RESPONSE' },
    });
  });

  test('reports handler detail main-side but returns only an opaque failure code', async () => {
    const secret = 'SECRET /Users/example/private-library';
    const thrown = new Error(secret);
    const reports: unknown[] = [];
    const handler = wrapHandler(
      channels.ping,
      () => {
        throw thrown;
      },
      { reportError: (report) => reports.push(report) },
    );

    const response = await handler({ message: 'hi' });

    assert.deepEqual(response, { __overlookIpcFailure: true, error: { code: 'IPC_HANDLER_FAILED' } });
    assert.deepEqual(reports, [{ channelName: 'demo:ping', code: 'IPC_HANDLER_FAILED', error: thrown }]);
    assert.doesNotMatch(JSON.stringify(response), /SECRET|private-library/u);
  });

  test('a broken main-side reporter cannot replace the opaque failure', async () => {
    const handler = wrapHandler(
      channels.ping,
      () => {
        throw new Error('SECRET handler failure');
      },
      {
        reportError: () => {
          throw new Error('SECRET logger failure');
        },
      },
    );

    assert.deepEqual(await handler({ message: 'hi' }), {
      __overlookIpcFailure: true,
      error: { code: 'IPC_HANDLER_FAILED' },
    });
  });
});

describe('events', () => {
  test('emitter validates and sends the payload', () => {
    const sent: Array<{ name: string; payload: unknown }> = [];
    const emit = createEmitter(events.focusChanged, (name, payload) => {
      sent.push({ name, payload });
    });

    emit({ focused: true });

    assert.deepEqual(sent, [{ name: 'window:focus-changed', payload: { focused: true } }]);
  });

  test('emitter throws on a malformed payload', () => {
    const emit = createEmitter(events.focusChanged, () => {});
    // type-coverage:ignore-next-line
    assert.throws(() => emit({ focused: 'yes' } as unknown as { focused: boolean }));
  });

  test('subscriber delivers validated payloads and unsubscribes', () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const subscribe = createSubscriber(events.focusChanged, (name, listener) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    });

    const received: unknown[] = [];
    const unsubscribe = subscribe((payload) => received.push(payload));
    listeners.get('window:focus-changed')?.({ focused: false });
    assert.deepEqual(received, [{ focused: false }]);

    unsubscribe();
    assert.equal(listeners.size, 0);
  });

  test('subscriber throws on a malformed payload instead of delivering it', () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const subscribe = createSubscriber(events.focusChanged, (name, listener) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    });

    const received: unknown[] = [];
    subscribe((payload) => received.push(payload));

    assert.throws(() => listeners.get('window:focus-changed')?.({ focused: 'broken' }));
    assert.equal(received.length, 0);
  });
});
