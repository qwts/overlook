import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { KEY_FILE_LENGTH, readKeyFileFacts, sealKeyFile } from '../../src/main/crypto/key-file.js';
import { probeKeyAgainstStore, readKeyFile } from '../../src/main/crypto/keyring-probe.js';
import { KeyringAuthorizationError, KeyringService } from '../../src/main/crypto/keyring-service.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { KeyringRepository } from '../../src/main/db/keyring-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { REMOVE_KEY_AUTHORIZATION } from '../../src/shared/destructive-actions.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #517 / ADR-0032 §2 over the real KeyStore, database and blob store: the
// registry reconciles with custody at open, removal is a Tier D ceremony
// that leaves the key's photos locked rather than lost, an exported key
// file re-imports only when its reference names a row AND its material
// opens an object sealed under it, and identical material is idempotent.

const AT = '2026-09-02T00:00:00.000Z';
const PASSWORD = 'Correct Horse Battery 9!';

function fakeSafeStorage(pad: number): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ pad)),
    decryptString: (encrypted) => Buffer.from(encrypted.map((byte) => byte ^ pad)).toString('utf8'),
  };
}

function photo(id: string, keyId: number, contentHash: string, bytes: number): PhotoInsert {
  return {
    id,
    fileName: `${id}.JPG`,
    fileKind: 'jpeg',
    width: 30,
    height: 20,
    bytes,
    contentHash,
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
    importedAt: AT,
    importSource: 'camera',
    favorite: false,
    keyId,
  };
}

async function world() {
  const root = mkdtempSync(join(tmpdir(), 'overlook-keyring-service-'));
  const dataDir = join(root, 'library');
  mkdirSync(dataDir);
  const safeStorage = fakeSafeStorage(0x5a);
  let keyStore = KeyStore.open({ safeStorage, dataDir });
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  const blobStore = new BlobStore({ dataDir });
  await blobStore.init();
  const photos = new PhotosRepository(db);
  const repo = new KeyringRepository(db);
  const custody: string[][] = [];
  const audit: string[] = [];
  const exportPath = join(root, 'exported.key');
  let importPath = exportPath;
  const service = new KeyringService({
    keyStore: () => keyStore,
    repo: () => repo,
    now: () => AT,
    readKeyFile,
    writeFile: (path, data) => writeFile(path, data),
    pickExportDestination: () => Promise.resolve(exportPath),
    pickImportSource: () => Promise.resolve(importPath),
    probe: (keyId, key) => probeKeyAgainstStore(db, blobStore, keyId, key),
    custodyChanged: (ids) => {
      custody.push([...ids]);
    },
    audit: (line) => {
      audit.push(line);
    },
  });
  const seal = async (photoId: string, key: EnvelopeKey): Promise<void> => {
    const bytes = randomBytes(2048);
    const ref = await blobStore.putOriginal(Readable.from([bytes]), key, photoId);
    await blobStore.putThumb(Readable.from([bytes]), key, photoId, ref.contentHash, 'thumb');
    run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (?, 'test', ?)`, key.id, AT);
    photos.insert(photo(photoId, key.id, ref.contentHash, ref.bytes));
  };
  return {
    dataDir,
    db,
    photos,
    repo,
    service,
    custody,
    audit,
    exportPath,
    seal,
    keyStore: () => keyStore,
    reopenKeyStore: () => {
      keyStore = KeyStore.open({ safeStorage, dataDir });
    },
    importFrom: (path: string) => {
      importPath = path;
    },
  };
}

describe('keyring service (#517)', () => {
  test('reconcile registers custody with references and fingerprints, and legacy custody adopts the row it already has', async () => {
    const w = await world();
    await w.seal('P1', w.keyStore().currentKey());
    const minted = w.repo.get(1)?.keyRef;
    assert.ok(minted);
    const stored = w.keyStore().listKeys()[0]?.keyRef;
    assert.ok(stored);
    assert.deepEqual(w.service.reconcile(), []);
    assert.equal(w.repo.get(1)?.keyRef, stored, 'custody facts win over a trigger-minted reference');
    assert.match(w.repo.get(1)?.fingerprint ?? '', /^[0-9A-F]{4}·[0-9A-F]{4}·[0-9A-F]{4}·[0-9A-F]{4}$/u);

    // A keys.json written before #517 carries no registry facts: reconcile
    // adopts the row's reference so the identity never forks.
    const keysPath = join(w.dataDir, 'keys.json');
    const file = JSON.parse(readFileSync(keysPath, 'utf8')) as { keys: Record<string, unknown>[] };
    file.keys = file.keys.map(({ keyRef: _ref, version: _version, kind: _kind, origin: _origin, ...rest }) => rest);
    writeFileSync(keysPath, JSON.stringify(file));
    w.reopenKeyStore();
    assert.equal(w.keyStore().listKeys()[0]?.keyRef, undefined);
    w.service.reconcile();
    assert.equal(w.keyStore().listKeys()[0]?.keyRef, stored);
    assert.equal(w.repo.get(1)?.keyRef, stored);
  });

  test('removal: KEY #1 and the write key are refused, a retired key still sealing photos is Tier D and locks exactly them', async () => {
    const w = await world();
    const key1 = w.keyStore().currentKey();
    await w.seal('P1', key1);
    const key2 = w.keyStore().rotate();
    await w.seal('P2', key2);
    await w.seal('P3', key2);
    w.keyStore().rotate();
    w.service.reconcile();

    assert.deepEqual(
      w.service.list().map((entry) => [entry.id, entry.active, entry.databaseKey, entry.present, entry.usage.photos]),
      [
        [1, false, true, true, 1],
        [2, false, false, true, 2],
        [3, true, false, true, 0],
      ],
    );
    assert.equal(w.service.removePreflight(1).reason, 'database-key');
    assert.equal(w.service.removePreflight(3).reason, 'write-key');
    assert.equal(w.service.removePreflight(9).reason, 'not-found');
    const plan = w.service.removePreflight(2);
    assert.deepEqual(
      { allowed: plan.allowed, tier: plan.tier, usage: plan.usage },
      { allowed: true, tier: 'irreversible', usage: { photos: 2, sidecars: 0, bytes: 4096 } },
    );
    assert.throws(() => w.service.remove(2), KeyringAuthorizationError);
    assert.equal(w.keyStore().hasKey(2), true, 'a refused ceremony changes nothing');
    assert.deepEqual(w.service.remove(1), { removed: false, reason: 'database-key', locked: 0 });

    assert.deepEqual(w.service.remove(2, REMOVE_KEY_AUTHORIZATION), { removed: true, reason: null, locked: 2 });
    assert.equal(w.keyStore().hasKey(2), false);
    assert.deepEqual(
      w.custody.map((ids) => [...ids].sort()),
      [['P2', 'P3']],
    );
    assert.match(w.audit.at(-1) ?? '', /^KEYRING-REMOVE key=2 ref=[0-9a-f]{32} photos=2 sidecars=0 bytes=4096$/u);
    assert.equal(w.photos.get('P2')?.locked, true);
    assert.equal(w.photos.get('P1')?.locked, false);
    assert.equal(w.service.list().find((entry) => entry.id === 2)?.present, false);
    assert.equal(w.service.removePreflight(2).reason, 'not-present');
    await assert.rejects(w.service.exportKey(2, PASSWORD), /not present/u);
  });

  test('export then import: the file round-trips as held custody, unlocks the photos, and is idempotent', async () => {
    const w = await world();
    await w.seal('P1', w.keyStore().currentKey());
    const key2 = w.keyStore().rotate();
    const material2 = Buffer.from(key2.key); // removal zeroizes the store's own buffer
    await w.seal('P2', key2);
    w.keyStore().rotate();
    w.service.reconcile();
    const ref2 = w.repo.get(2)?.keyRef;
    assert.ok(ref2);

    assert.equal(await w.service.exportKey(2, PASSWORD), w.exportPath);
    const data = readFileSync(w.exportPath);
    assert.equal(data.length, KEY_FILE_LENGTH);
    assert.deepEqual(readKeyFileFacts(data), { kind: 'library', keyRef: ref2, version: 1 });
    assert.equal(data.includes(material2), false);
    assert.match(w.audit.at(-1) ?? '', /^KEYRING-EXPORT key=2 ref=[0-9a-f]{32} version=1$/u);

    w.service.remove(2, REMOVE_KEY_AUTHORIZATION);
    assert.equal(w.photos.get('P2')?.locked, true);
    assert.deepEqual(await w.service.importKey(w.exportPath, 'not the password'), {
      outcome: 'refused',
      keyId: null,
      fingerprint: null,
      unlocked: 0,
      reason: 'wrong-password',
    });
    assert.equal(w.photos.get('P2')?.locked, true, 'a refused import installs nothing');

    const imported = await w.service.importKey(w.exportPath, PASSWORD);
    assert.equal(imported.outcome, 'imported');
    assert.equal(imported.keyId, 2);
    assert.equal(imported.unlocked, 1);
    assert.equal(w.photos.get('P2')?.locked, false);
    assert.equal(
      w
        .keyStore()
        .listKeys()
        .find((key) => key.id === 2)?.status,
      'held',
    );
    assert.deepEqual(w.keyStore().keyBytes(2), material2);
    const entry = w.service.list().find((row) => row.id === 2);
    assert.deepEqual(
      { present: entry?.present, origin: entry?.origin, active: entry?.active },
      { present: true, origin: 'imported', active: false },
    );
    assert.equal(w.keyStore().currentKey().id, 3, 'held custody is never the write key');
    assert.equal(w.custody.length, 2, 'removal and import each announce the rows');

    assert.equal((await w.service.importKey(w.exportPath, PASSWORD)).outcome, 'already-present');
    assert.equal(w.custody.length, 2, 'identical material changes nothing');
  });

  test('import refuses foreign files, references the registry does not know, and material that opens nothing', async () => {
    const w = await world();
    await w.seal('P1', w.keyStore().currentKey());
    const key2 = w.keyStore().rotate();
    const material2 = Buffer.from(key2.key); // removal zeroizes the store's own buffer
    await w.seal('P2', key2);
    w.keyStore().rotate();
    w.service.reconcile();
    const ref2 = w.repo.get(2)?.keyRef;
    assert.ok(ref2);
    const dir = mkdtempSync(join(tmpdir(), 'overlook-keyring-files-'));
    const fileOf = (name: string, data: Buffer): string => {
      const path = join(dir, name);
      writeFileSync(path, data);
      return path;
    };
    const reasonOf = async (path: string, password = PASSWORD): Promise<string | null> =>
      (await w.service.importKey(path, password)).reason;

    assert.equal(await reasonOf(fileOf('short.key', randomBytes(KEY_FILE_LENGTH - 1))), 'invalid');
    assert.equal(await reasonOf(fileOf('noise.key', randomBytes(KEY_FILE_LENGTH))), 'invalid');
    assert.equal(await reasonOf(join(dir, 'missing.key')), 'invalid');
    const foreign = sealKeyFile(randomBytes(32), { kind: 'library', keyRef: 'f'.repeat(32), version: 1 }, PASSWORD);
    assert.equal(await reasonOf(fileOf('foreign.key', foreign)), 'matches-nothing');
    const impostorWhilePresent = sealKeyFile(randomBytes(32), { kind: 'library', keyRef: ref2, version: 1 }, PASSWORD);
    assert.equal(await reasonOf(fileOf('impostor.key', impostorWhilePresent)), 'mismatch', 'different material under a held reference');

    w.service.remove(2, REMOVE_KEY_AUTHORIZATION);
    assert.equal(
      await reasonOf(fileOf('impostor-absent.key', impostorWhilePresent)),
      'no-matching-object',
      'the probe refuses material that opens nothing',
    );
    assert.equal(w.keyStore().hasKey(2), false);
    assert.equal(w.photos.get('P2')?.locked, true);
    const genuine = sealKeyFile(material2, { kind: 'library', keyRef: ref2, version: 1 }, PASSWORD);
    assert.equal((await w.service.importKey(fileOf('genuine.key', genuine), PASSWORD)).outcome, 'imported');
    assert.equal(w.photos.get('P2')?.locked, false);
  });
});
