import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { BlobStore, BlobStoreError } from '../../src/main/blobs/blob-store.js';
import type { EnvelopeKey, KeyResolver } from '../../src/main/crypto/envelope.js';

const KEY: EnvelopeKey = { id: 1, key: randomBytes(32) };
const RESOLVE: KeyResolver = (id) => (id === 1 ? KEY.key : undefined);

async function freshStore(): Promise<{ store: BlobStore; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-blobs-'));
  const store = new BlobStore({ dataDir });
  await store.init();
  return { store, dataDir };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      out.push(join(entry.parentPath, entry.name));
    }
  }
  return out;
}

describe('BlobStore', () => {
  test('original round-trip: put returns the content address, getStream decrypts', async () => {
    const { store } = await freshStore();
    const plaintext = randomBytes(300_000);
    const ref = await store.putOriginal(Readable.from([plaintext]), KEY, 'photo-1');
    assert.equal(ref.contentHash, createHash('sha256').update(plaintext).digest('hex'));
    assert.equal(ref.keyId, 1);
    assert.equal(ref.bytes, plaintext.length);
    const back = await buffer(store.getStream(ref.contentHash, RESOLVE, 'photo-1'));
    assert.deepEqual(back, plaintext);
  });

  test('thumb round-trip addressed by original hash + size', async () => {
    const { store } = await freshStore();
    const original = randomBytes(2048);
    const thumb = randomBytes(512);
    const ref = await store.putOriginal(Readable.from([original]), KEY, 'photo-2');
    await store.putThumb(Readable.from([thumb]), KEY, 'photo-2', ref.contentHash, 'thumb');
    const back = await buffer(store.getThumbStream(ref.contentHash, 'thumb', RESOLVE, 'photo-2'));
    assert.deepEqual(back, thumb);
  });

  test('thumbnail repair atomically replaces a corrupt legacy envelope', async () => {
    const { store } = await freshStore();
    const original = randomBytes(2048);
    const oldThumb = randomBytes(128);
    const repairedThumb = randomBytes(256);
    const ref = await store.putOriginal(Readable.from([original]), KEY, 'photo-repair');
    await store.putThumb(Readable.from([oldThumb]), KEY, 'photo-repair', ref.contentHash, 'thumb');
    await store.replaceThumb(Readable.from([repairedThumb]), KEY, 'photo-repair', ref.contentHash, 'thumb');
    assert.deepEqual(await buffer(store.getThumbStream(ref.contentHash, 'thumb', RESOLVE, 'photo-repair')), repairedThumb);
  });

  test('EXIT CRITERIA: no plaintext fixture bytes anywhere under the store', async () => {
    const { store, dataDir } = await freshStore();
    // A recognizable fixture: repeated marker so any at-rest leak is findable.
    const marker = Buffer.from('OVERLOOK-PLAINTEXT-MARKER-0123456789');
    const fixture = Buffer.concat(Array.from({ length: 2000 }, () => marker));
    const ref = await store.putOriginal(Readable.from([fixture]), KEY, 'photo-3');
    await store.putThumb(Readable.from([fixture.subarray(0, 4096)]), KEY, 'photo-3', ref.contentHash, 'thumb');
    await store.putThumb(Readable.from([fixture.subarray(0, 9000)]), KEY, 'photo-3', ref.contentHash, 'mid');

    const files = walkFiles(dataDir);
    assert.ok(files.length >= 3);
    for (const file of files) {
      const bytes = readFileSync(file);
      assert.equal(bytes.includes(marker), false, `plaintext marker found in ${file}`);
    }
  });

  test('verify walks every auth tag and the content address', async () => {
    const { store, dataDir } = await freshStore();
    const plaintext = randomBytes(150_000);
    const ref = await store.putOriginal(Readable.from([plaintext]), KEY, 'photo-4');
    assert.equal(await store.verifyOriginal(ref.contentHash, RESOLVE, 'photo-4'), true);

    // Tamper one ciphertext byte on disk → verify fails.
    const [file] = walkFiles(join(dataDir, 'blobs'));
    const bytes = readFileSync(file!);
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 0xff;
    writeFileSync(file!, bytes);
    assert.equal(await store.verifyOriginal(ref.contentHash, RESOLVE, 'photo-4'), false);
  });

  test('ephemeral ciphertext verifies, promotes atomically, and never becomes plaintext at rest (#306)', async () => {
    const { store, dataDir } = await freshStore();
    const marker = Buffer.from('EPHEMERAL-PLAINTEXT-MUST-NOT-PERSIST');
    const plaintext = Buffer.concat(Array.from({ length: 1000 }, () => marker));
    const ref = await store.putOriginal(Readable.from([plaintext]), KEY, 'photo-view');
    const ciphertext = await buffer(store.getEncryptedStream(ref.contentHash));
    await store.deleteOriginal(ref.contentHash);

    const encryptedBytes = await store.stageEphemeralOriginal(ref.contentHash, Readable.from([ciphertext]), RESOLVE, 'photo-view');
    assert.equal(encryptedBytes, ciphertext.length);
    assert.equal(store.hasOriginal(ref.contentHash), false, 'ledger may remain offloaded');
    assert.equal(store.hasEphemeralOriginal(ref.contentHash), true);
    assert.deepEqual(await buffer(store.getEphemeralStream(ref.contentHash, RESOLVE, 'photo-view')), plaintext);
    for (const file of walkFiles(join(dataDir, 'ephemeral'))) {
      assert.equal(readFileSync(file).includes(marker), false, `plaintext marker found in ${file}`);
    }

    await store.promoteEphemeralOriginal(ref.contentHash);
    assert.equal(store.hasOriginal(ref.contentHash), true);
    assert.deepEqual(await buffer(store.getStream(ref.contentHash, RESOLVE, 'photo-view')), plaintext);
    await store.deleteEphemeralOriginal(ref.contentHash);
    assert.equal(store.hasEphemeralOriginal(ref.contentHash), false);
    assert.equal(store.hasOriginal(ref.contentHash), true, 'promotion has independent durable custody');
  });

  test('ephemeral corruption fails closed and restart cleanup removes abandoned custody (#306)', async () => {
    const { store, dataDir } = await freshStore();
    const plaintext = randomBytes(4096);
    const ref = await store.putOriginal(Readable.from([plaintext]), KEY, 'photo-crash');
    const ciphertext = await buffer(store.getEncryptedStream(ref.contentHash));
    await store.deleteOriginal(ref.contentHash);

    const corrupt = Buffer.from(ciphertext);
    const corruptAt = Math.floor(corrupt.length / 2);
    corrupt[corruptAt] = (corrupt[corruptAt] ?? 0) ^ 0xff;
    await assert.rejects(store.stageEphemeralOriginal(ref.contentHash, Readable.from([corrupt]), RESOLVE, 'photo-crash'), BlobStoreError);
    assert.equal(store.hasEphemeralOriginal(ref.contentHash), false);

    await store.stageEphemeralOriginal(ref.contentHash, Readable.from([ciphertext]), RESOLVE, 'photo-crash');
    assert.equal(store.hasEphemeralOriginal(ref.contentHash), true);
    const reborn = new BlobStore({ dataDir });
    await reborn.init();
    assert.equal(reborn.hasEphemeralOriginal(ref.contentHash), false, 'process restart clears temporary custody');
    assert.equal(reborn.hasOriginal(ref.contentHash), false, 'cleanup never changes durable custody');
  });

  test('wrong photo context cannot read a blob', async () => {
    const { store } = await freshStore();
    const ref = await store.putOriginal(Readable.from([randomBytes(64)]), KEY, 'photo-5');
    await assert.rejects(buffer(store.getStream(ref.contentHash, RESOLVE, 'other-photo')));
  });

  test('crash simulation: a failed put leaves no staged garbage; an orphaned stage file is scannable', async () => {
    const { store, dataDir } = await freshStore();
    // Failure mid-stream: source errors → put rejects → tmp cleaned up.
    const failing = new Readable({
      read(): void {
        this.destroy(new Error('simulated source failure'));
      },
    });
    await assert.rejects(store.putOriginal(failing, KEY, 'photo-6'), /simulated source failure/);
    assert.deepEqual(readdirSync(join(dataDir, 'tmp')), []);

    // Hard-crash simulation: a stage file that never reached rename.
    writeFileSync(join(dataDir, 'tmp', 'stage-deadbeef'), randomBytes(128));
    const good = await store.putOriginal(Readable.from([randomBytes(256)]), KEY, 'photo-7');
    const orphans = await store.scanOrphans(new Set([good.contentHash]));
    assert.equal(orphans.staged.length, 1);
    assert.ok(orphans.staged[0]?.includes('stage-deadbeef'));
    assert.deepEqual(orphans.unknown, []);
    // The completed blob is intact despite the leftover staging file.
    assert.equal(await store.verifyOriginal(good.contentHash, RESOLVE, 'photo-7'), true);
  });

  test('orphan scan flags originals the database does not know', async () => {
    const { store } = await freshStore();
    const known = await store.putOriginal(Readable.from([randomBytes(64)]), KEY, 'photo-8');
    const stray = await store.putOriginal(Readable.from([randomBytes(64)]), KEY, 'photo-9');
    const orphans = await store.scanOrphans(new Set([known.contentHash]));
    assert.deepEqual(
      orphans.unknown.map((path) => basename(path)),
      [stray.contentHash],
    );
  });

  test('re-importing identical bytes never replaces the existing envelope', async () => {
    const { store, dataDir } = await freshStore();
    const plaintext = randomBytes(4096);
    const first = await store.putOriginal(Readable.from([plaintext]), KEY, 'photo-original');

    const otherKey: EnvelopeKey = { id: 2, key: randomBytes(32) };
    const resolveBoth: KeyResolver = (id) => (id === 1 ? KEY.key : id === 2 ? otherKey.key : undefined);
    const second = await store.putOriginal(Readable.from([plaintext]), otherKey, 'photo-duplicate');

    // Same address, existing envelope kept: its key id is reported and the
    // ORIGINAL photo context still decrypts.
    assert.equal(second.contentHash, first.contentHash);
    assert.equal(second.keyId, 1);
    const back = await buffer(store.getStream(first.contentHash, resolveBoth, 'photo-original'));
    assert.deepEqual(back, plaintext);
    // No staging leftovers from the deduped put.
    assert.deepEqual(readdirSync(join(dataDir, 'tmp')), []);
  });

  test('delete removes originals and thumbs; getStream then fails cleanly', async () => {
    const { store } = await freshStore();
    const ref = await store.putOriginal(Readable.from([randomBytes(64)]), KEY, 'photo-10');
    await store.putThumb(Readable.from([randomBytes(32)]), KEY, 'photo-10', ref.contentHash, 'thumb');
    await store.deleteOriginal(ref.contentHash);
    await store.deleteThumbs(ref.contentHash);
    assert.throws(() => store.getStream(ref.contentHash, RESOLVE, 'photo-10'), BlobStoreError);
    assert.throws(() => store.getThumbStream(ref.contentHash, 'thumb', RESOLVE, 'photo-10'), BlobStoreError);
  });

  test('malformed content hashes are refused', async () => {
    const { store } = await freshStore();
    assert.throws(() => store.getStream('not-a-hash', RESOLVE, 'p'), /64 lowercase hex/);
    await assert.rejects(store.deleteOriginal('ABCD'), /64 lowercase hex/);
  });

  test('fan-out layout matches ADR-0005', async () => {
    const { store, dataDir } = await freshStore();
    const ref = await store.putOriginal(Readable.from([randomBytes(64)]), KEY, 'photo-11');
    const expected = join(dataDir, 'blobs', ref.contentHash.slice(0, 2), ref.contentHash.slice(2, 4), ref.contentHash);
    assert.ok(statSync(expected).isFile());
  });
});
