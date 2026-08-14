import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import type { PhotoRecord } from '../../src/shared/library/types.js';
import type { FileProviderDomain, FileProviderBridge } from '../../src/main/file-provider/file-provider-bridge.js';
import { FileProviderService, type OpenedProviderOriginal } from '../../src/main/file-provider/file-provider-service.js';
import { FileProviderStore } from '../../src/main/file-provider/file-provider-store.js';

function photo(id: string, fileName = `${id}.jpg`, syncState: PhotoRecord['syncState'] = 'local'): PhotoRecord {
  return {
    id,
    fileName,
    fileKind: 'jpeg',
    width: 1,
    height: 1,
    bytes: 5,
    contentHash: id.padEnd(64, '0'),
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
    importedAt: '2026-01-01T00:00:00.000Z',
    importSource: '/source',
    favorite: false,
    isOriginal: false,
    keyId: 1,
    deletedAt: null,
    previewFailure: null,
    dimensionStatus: 'verified',
    mediaInfo: null,
    syncState,
  };
}

class FakeBridge implements FileProviderBridge {
  domains: FileProviderDomain[] = [];
  removed: string[] = [];
  evicted: string[] = [];
  changes = 0;
  closed = false;
  failChanged = false;

  status() {
    return { available: true, reason: null } as const;
  }

  register(domain: FileProviderDomain): Promise<void> {
    this.domains.push(domain);
    return Promise.resolve();
  }

  remove(domainId: string): Promise<void> {
    this.removed.push(domainId);
    return Promise.resolve();
  }

  evict(domainId: string): Promise<void> {
    this.evicted.push(domainId);
    return Promise.resolve();
  }

  changed(): Promise<void> {
    this.changes += 1;
    return this.failChanged ? Promise.reject(new Error('signal failed')) : Promise.resolve();
  }

  close(): void {
    this.closed = true;
  }
}

function fixture() {
  const bridge = new FakeBridge();
  const directory = mkdtempSync(path.join(tmpdir(), 'overlook-file-provider-'));
  const store = new FileProviderStore(path.join(directory, 'file-provider.json'));
  const photos = new Map([
    ['P1', photo('P1', 'Shared.jpg')],
    ['P2', photo('P2', 'shared.JPG', 'offloaded')],
    ['P3', photo('P3')],
  ]);
  let admitted = true;
  let releases = 0;
  let openOriginal = (): Promise<OpenedProviderOriginal> =>
    Promise.resolve({
      stream: Readable.from(['bytes']),
      release: () => {
        releases += 1;
        return Promise.resolve();
      },
    });
  const service = new FileProviderService({
    bridge,
    store,
    library: { id: 'LIB1', name: 'Family' },
    albums: () => [
      { id: 'A1', name: 'Travel', count: 2 },
      { id: 'A2', name: 'travel', count: 1 },
    ],
    selectPhotoIds: (albumId) => (albumId === undefined ? ['P1', 'P2', 'P3'] : albumId === 'A1' ? ['P1', 'P2'] : ['P3']),
    getPhoto: (id) => photos.get(id),
    isMigrating: (id) => id === 'P3',
    openOriginal: () => openOriginal(),
    admit: () => admitted,
  });
  return {
    bridge,
    directory,
    service,
    store,
    lock: () => {
      admitted = false;
    },
    releases: () => releases,
    setOpenOriginal: (next: () => Promise<OpenedProviderOriginal>) => {
      openOriginal = next;
    },
  };
}

describe('read-only macOS File Provider (#797)', () => {
  test('fails closed on malformed persisted consent', () => {
    const { directory, store } = fixture();
    writeFileSync(path.join(directory, 'file-provider.json'), '{"enabled":true}');
    assert.equal(store.load().enabled, false);
  });

  test('requires current consent and a current album selection', async () => {
    const { service } = fixture();
    await assert.rejects(service.enable({ kind: 'library' }, 0), /disclosure/u);
    await assert.rejects(service.enable({ kind: 'albums', albumIds: ['STALE'] }, 1), /stale/u);
  });

  test('registers one stable library domain and persists only the explicit scope', async () => {
    const { bridge, directory, service } = fixture();
    await service.enable({ kind: 'albums', albumIds: ['A1'] }, 1);
    assert.deepEqual(bridge.domains, [{ id: 'com.zts1.overlook.library.LIB1', displayName: 'Family' }]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'file-provider.json'), 'utf8')), {
      version: 1,
      enabled: true,
      consentVersion: 1,
      scope: { kind: 'albums', albumIds: ['A1'] },
    });
  });

  test('rolls persisted consent back when activation signalling fails', async () => {
    const { bridge, service, store } = fixture();
    bridge.failChanged = true;
    await assert.rejects(service.enable({ kind: 'library' }, 1), /signal failed/u);
    assert.equal(store.load().enabled, false);
    assert.deepEqual(bridge.removed, ['com.zts1.overlook.library.LIB1']);
  });

  test('projects stable read-only identifiers and truthful offloaded state', async () => {
    const { service } = fixture();
    await service.enable({ kind: 'albums', albumIds: ['A1'] }, 1);
    const albums = service.enumerate('root');
    assert.deepEqual(
      albums.map(({ name }) => name),
      ['Travel'],
    );
    const files = service.enumerate(albums[0]?.id ?? 'missing');
    assert.deepEqual(
      files.map(({ name, dataless, readOnly }) => ({ name, dataless, readOnly })),
      [
        { name: 'Shared.jpg', dataless: false, readOnly: true },
        { name: 'shared (2).JPG', dataless: true, readOnly: true },
      ],
    );
    assert.deepEqual(service.enumerate(albums[0]?.id ?? 'missing'), files, 'identifiers must be stable across enumerations');
  });

  test('disambiguates normalization and case-insensitive album names', async () => {
    const { service } = fixture();
    await service.enable({ kind: 'albums', albumIds: ['A1', 'A2'] }, 1);
    assert.deepEqual(
      service.enumerate('root').map(({ name }) => name),
      ['Travel', 'travel (2)'],
    );
  });

  test('never advertises protected-migration records and rejects mutation', async () => {
    const { service } = fixture();
    await service.enable({ kind: 'library' }, 1);
    assert.deepEqual(
      service.enumerate('root').map(({ name }) => name),
      ['Shared.jpg', 'shared (2).JPG'],
    );
    assert.throws(() => service.rejectMutation(), /read-only/u);
  });

  test('rechecks authorization after asynchronous materialization and releases late custody', async () => {
    const { lock, releases, service } = fixture();
    await service.enable({ kind: 'library' }, 1);
    const item = service.enumerate('root')[0];
    assert.ok(item);
    lock();
    await assert.rejects(service.materialize(item.id), /unavailable/u);
    assert.equal(releases(), 0, 'locked requests must not open originals');
  });

  test('rechecks scope and membership after a pending original opens', async () => {
    const { service, setOpenOriginal, store } = fixture();
    await service.enable({ kind: 'library' }, 1);
    const item = service.enumerate('root')[0];
    assert.ok(item);
    let resolveOpen: ((opened: OpenedProviderOriginal) => void) | undefined;
    setOpenOriginal(() => new Promise((resolve) => (resolveOpen = resolve)));
    const pending = service.materialize(item.id);
    await new Promise((resolve) => setImmediate(resolve));
    store.save({ version: 1, enabled: true, consentVersion: 1, scope: { kind: 'albums', albumIds: ['A1'] } });
    let released = 0;
    resolveOpen?.({
      stream: Readable.from(['late bytes']),
      release: () => {
        released += 1;
        return Promise.resolve();
      },
    });
    await assert.rejects(pending, /unavailable/u);
    assert.equal(released, 1);
  });

  test('disable persists denial before eviction and removes the domain', async () => {
    const { bridge, service, store } = fixture();
    await service.enable({ kind: 'library' }, 1);
    const result = await service.disable();
    assert.equal(result.config.enabled, false);
    assert.equal(store.load().enabled, false);
    assert.deepEqual(bridge.evicted, ['com.zts1.overlook.library.LIB1']);
    assert.deepEqual(bridge.removed, ['com.zts1.overlook.library.LIB1']);
  });
});
