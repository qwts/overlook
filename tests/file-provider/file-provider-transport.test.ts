import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import type { FileProviderItem } from '../../src/shared/file-provider/contract.js';
import { FileProviderTransport } from '../../src/main/file-provider/file-provider-transport.js';

const ITEM: FileProviderItem = {
  id: 'photo.library.UDE',
  parentId: 'root',
  name: 'P1.jpg',
  kind: 'file',
  size: 5,
  contentType: 'public.image',
  modifiedAt: '2026-01-01T00:00:00.000Z',
  dataless: false,
  readOnly: true,
};

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'overlook-file-provider-transport-'));
  let releases = 0;
  const transport = new FileProviderTransport(directory, {
    enumerate: (parent) => (parent === 'root' ? [ITEM] : []),
    item: (id) => (id === ITEM.id ? ITEM : undefined),
    materialize: (id) => {
      if (id !== ITEM.id) return Promise.reject(new Error('unavailable'));
      return Promise.resolve({
        stream: Readable.from(['bytes']),
        release: () => {
          releases += 1;
          return Promise.resolve();
        },
      });
    },
  });
  return { directory, releases: () => releases, transport };
}

function endpoint(directory: string): { readonly port: number; readonly token: string } {
  return JSON.parse(readFileSync(path.join(directory, 'endpoint.json'), 'utf8')) as { readonly port: number; readonly token: string };
}

function request(endpointValue: ReturnType<typeof endpoint>, pathname: string, token = endpointValue.token): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(endpointValue.port)}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('authenticated File Provider extension transport (#797)', () => {
  test('publishes only an authenticated loopback endpoint and removes it on stop', async () => {
    const { directory, transport } = fixture();
    await transport.start();
    const current = endpoint(directory);
    assert.ok(current.token.length >= 32);
    if (process.platform !== 'win32') assert.equal(statSync(path.join(directory, 'endpoint.json')).mode & 0o777, 0o600);
    assert.equal((await request(current, '/v1/enumerate?parent=root', 'wrong')).status, 404);
    const response = await request(current, '/v1/enumerate?parent=root');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [ITEM]);
    await transport.stop();
    assert.equal(existsSync(path.join(directory, 'endpoint.json')), false);
    await assert.rejects(request(current, '/v1/enumerate?parent=root'));
  });

  test('returns item metadata and releases materialized custody', async () => {
    const { directory, releases, transport } = fixture();
    await transport.start();
    const current = endpoint(directory);
    const item = await request(current, `/v1/item?id=${ITEM.id}`);
    assert.deepEqual(await item.json(), ITEM);
    const materialized = await request(current, `/v1/materialize?id=${ITEM.id}`);
    assert.equal(await materialized.text(), 'bytes');
    assert.equal(releases(), 1);
    assert.equal((await request(current, '/v1/item?id=unknown')).status, 404);
    await transport.stop();
  });

  test('drains an unresolved materialization and releases custody before stopping', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'overlook-file-provider-drain-'));
    let resolveMaterialization: ((opened: { stream: Readable; release: () => Promise<void> }) => void) | undefined;
    let releases = 0;
    const transport = new FileProviderTransport(directory, {
      enumerate: () => [],
      item: () => undefined,
      materialize: () => new Promise((resolve) => (resolveMaterialization = resolve)),
    });
    await transport.start();
    const pendingRequest = request(endpoint(directory), `/v1/materialize?id=${ITEM.id}`).catch(() => undefined);
    while (resolveMaterialization === undefined) await new Promise((resolve) => setImmediate(resolve));
    let stopped = false;
    const stopping = transport.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    resolveMaterialization({
      stream: Readable.from(['late bytes']),
      release: () => {
        releases += 1;
        return Promise.resolve();
      },
    });
    await Promise.all([pendingRequest, stopping]);
    assert.equal(releases, 1);
  });
});
