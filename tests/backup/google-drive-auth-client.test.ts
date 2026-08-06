import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GoogleDriveAuthClient } from '../../src/main/backup/google-drive/auth-client.js';
import { GoogleDriveTokenStore } from '../../src/main/backup/google-drive/token-store.js';
import { ProviderError } from '../../src/main/backup/provider.js';
import type { SafeStorageLike } from '../../src/main/crypto/keystore.js';

const CLIENT_ID = 'desktop.apps.googleusercontent.com';
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};

function bodyText(body: RequestInit['body']): string {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error('expected a string or URLSearchParams body');
}

function requiredSignal(signal: AbortSignal | null): AbortSignal {
  assert.ok(signal);
  return signal;
}

function world(fetchImpl: typeof fetch, clientId: string | null = CLIENT_ID, clientSecret: string | null = null) {
  const store = new GoogleDriveTokenStore({ safeStorage, dataDir: mkdtempSync(join(tmpdir(), 'overlook-google-client-')) });
  let now = 1_000_000;
  const auth = new GoogleDriveAuthClient({
    clientId: () => clientId,
    clientSecret: () => clientSecret,
    tokenStore: store,
    fetchImpl,
    now: () => now,
  });
  return { auth, store, advance: (ms: number) => (now += ms) };
}

describe('Google Drive access-token client (#277)', () => {
  test('missing or client-mismatched custody is disconnected and fails with auth', async () => {
    const { auth, store } = world(() => Promise.resolve(new Response('{}')));
    assert.equal(auth.authState(), 'not-connected');
    await assert.rejects(auth.accessToken(), (error: unknown) => error instanceof ProviderError && error.kind === 'auth');
    store.save({ clientId: 'other.apps.googleusercontent.com', refreshToken: 'r', connectedAt: 'now' });
    assert.equal(auth.authState(), 'not-connected');
    await assert.rejects(auth.accessToken(), (error: unknown) => error instanceof ProviderError && error.kind === 'auth');
  });

  test('refresh is shared, cached, expires early, invalidates, and clears', async () => {
    let calls = 0;
    const { auth, store, advance } = world((_input, init) => {
      calls += 1;
      const params = new URLSearchParams(bodyText(init?.body));
      assert.equal(params.get('refresh_token'), 'refresh-1');
      return Promise.resolve(new Response(JSON.stringify({ access_token: `access-${String(calls)}`, expires_in: 120 }), { status: 200 }));
    });
    store.save({ clientId: CLIENT_ID, refreshToken: 'refresh-1', connectedAt: 'now' });
    assert.equal(auth.authState(), 'connected');
    assert.deepEqual(await Promise.all([auth.accessToken(), auth.accessToken()]), ['access-1', 'access-1']);
    assert.equal(calls, 1);
    assert.equal(await auth.accessToken(), 'access-1');
    advance(61_000);
    assert.equal(await auth.accessToken(), 'access-2');
    auth.invalidate();
    assert.equal(await auth.accessToken(), 'access-3');
    auth.seed('seeded', 3600);
    assert.equal(await auth.accessToken(), 'seeded');
    auth.clear();
    assert.equal(store.load(), null);
    assert.equal(auth.authState(), 'not-connected');
  });

  test('refresh includes the issued Desktop client credential only when configured', async () => {
    const requests: URLSearchParams[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      requests.push(new URLSearchParams(bodyText(init?.body)));
      return Promise.resolve(new Response(JSON.stringify({ access_token: 'access', expires_in: 120 }), { status: 200 }));
    };
    const configured = world(fetchImpl, CLIENT_ID, 'desktop-secret');
    configured.store.save({ clientId: CLIENT_ID, refreshToken: 'refresh-1', connectedAt: 'now' });
    await configured.auth.accessToken();
    const unconfigured = world(fetchImpl);
    unconfigured.store.save({ clientId: CLIENT_ID, refreshToken: 'refresh-2', connectedAt: 'now' });
    await unconfigured.auth.accessToken();
    assert.equal(requests[0]?.get('client_secret'), 'desktop-secret');
    assert.equal(requests[1]?.get('client_secret'), null);
  });

  test('refresh maps transport, auth, service, and malformed responses', async () => {
    const check = async (fetchImpl: typeof fetch, kind: ProviderError['kind']) => {
      const { auth, store } = world(fetchImpl);
      store.save({ clientId: CLIENT_ID, refreshToken: 'refresh_token=SECRET', connectedAt: 'now' });
      await assert.rejects(
        auth.accessToken(),
        (error: unknown) => error instanceof ProviderError && error.kind === kind && !error.message.includes('SECRET'),
      );
    };
    await check(() => Promise.reject(new Error('refresh_token=SECRET')), 'transient');
    await check(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh_token=SECRET was rejected' }), {
            status: 400,
          }),
        ),
      'auth',
    );
    await check(() => Promise.resolve(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })), 'transient');
    await check(() => Promise.resolve(new Response('{}', { status: 200 })), 'transient');
  });
});

describe('Google Drive refresh cancellation (#730)', () => {
  test('one cancelled waiter does not abort a refresh still shared by another caller', async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    let refreshSignal: AbortSignal | null = null;
    const { auth, store } = world(
      (_input, init) =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
          refreshSignal = init?.signal ?? null;
        }),
    );
    store.save({ clientId: CLIENT_ID, refreshToken: 'refresh-1', connectedAt: 'now' });
    const cancelled = new AbortController();
    const first = auth.accessToken(false, cancelled.signal);
    const second = auth.accessToken();

    cancelled.abort(new Error('identity deadline'));
    await assert.rejects(first, /identity deadline/u);
    assert.equal(requiredSignal(refreshSignal).aborted, false, 'the live waiter retains the shared refresh');
    assert.ok(resolveRefresh);
    resolveRefresh(Response.json({ access_token: 'shared-access', expires_in: 120 }));
    assert.equal(await second, 'shared-access');
  });
});
