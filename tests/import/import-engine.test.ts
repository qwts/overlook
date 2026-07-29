import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ImportEngine, type ImportEngineDeps, type ImportManifest, type ManifestFile } from '../../src/main/import/import-engine.js';
import type { ExtractedMetadata } from '../../src/main/import/exif.js';
import type { PhotoInsert, PhotoRecord } from '../../src/shared/library/types.js';

const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/exif');

const NULL_META: ExtractedMetadata = {
  width: null,
  height: null,
  camera: null,
  lens: null,
  iso: null,
  aperture: null,
  shutter: null,
  focalLength: null,
  takenAt: null,
  gpsLat: null,
  gpsLon: null,
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** In-memory world: sources, blob set, rows, journal — all inspectable. */
function harness(overrides?: Partial<ImportEngineDeps>) {
  const sources = new Map<string, Buffer>();
  const blobs = new Set<string>();
  const rows = new Map<string, PhotoInsert>();
  const hashes = new Set<string>();
  const copyEvents: number[] = [];
  const thumbEvents: number[] = [];
  let journal: ImportManifest | null = null;
  let idCounter = 0;
  let insertCalls = 0;

  const deps: ImportEngineDeps = {
    readFile: (path) => {
      const bytes = sources.get(path);
      // Model fs.readFile ownership: the engine may zeroize the returned
      // plaintext allocation without mutating the source file's bytes.
      return bytes === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(Buffer.from(bytes));
    },
    deleteFile: (path) => {
      sources.delete(path);
      return Promise.resolve();
    },
    // In-memory journal modeling the real serialization boundary: every
    // state crossing it is a snapshot, detached from the engine's mutations.
    journal: {
      read: () => Promise.resolve(journal === null ? null : structuredClone(journal)),
      begin: (manifest) => {
        journal = structuredClone(manifest);
        return Promise.resolve();
      },
      update: (updates) => {
        if (journal === null) return Promise.reject(new Error('journal update before begin'));
        for (const { index, file } of updates) {
          journal.files[index] = structuredClone(file);
        }
        return Promise.resolve();
      },
      clear: () => {
        journal = null;
        return Promise.resolve();
      },
    },
    repo: {
      hasContentHash: (hash) => hashes.has(hash),
      get: (id) => rows.get(id) as unknown as PhotoRecord | undefined,
      insert: (photo) => {
        insertCalls += 1;
        if (rows.has(photo.id)) {
          throw new Error(`duplicate id ${photo.id}`);
        }
        rows.set(photo.id, photo);
        hashes.add(photo.contentHash);
      },
      repairGeneratedDimensions: (id, width, height) => {
        const photo = rows.get(id);
        if (photo === undefined || (photo.width > 0 && photo.height > 0)) return false;
        rows.set(id, { ...photo, width, height });
        return true;
      },
      setDimensionStatus: () => false,
      setPreviewFailure: () => false,
    },
    blobs: {
      putOriginal: async (plaintext, _key, _photoId) => {
        let size = 0;
        const hasher = createHash('sha256');
        // type-coverage:ignore-next-line -- Readable yields untyped chunks
        for await (const chunk of plaintext) {
          // type-coverage:ignore-next-line -- Readable yields untyped chunks
          hasher.update(chunk as Buffer);
          size += (chunk as Buffer).length;
        }
        blobs.add(hasher.digest('hex'));
        return { keyId: 1, bytes: size };
      },
      verifyOriginal: (contentHash) => Promise.resolve(blobs.has(contentHash)),
    },
    generateThumbs: () => Promise.resolve({ generated: true, width: 1, height: 1 }),
    extractMetadata: () => Promise.resolve(NULL_META),
    currentKey: () => ({ id: 1, key: Buffer.alloc(32) }),
    resolveKey: () => Buffer.alloc(32),
    newId: () => {
      idCounter += 1;
      return `01IMPORT${String(idCounter).padStart(18, '0')}`;
    },
    now: () => '2026-07-12T00:00:00.000Z',
    events: {
      copyProgress: (done) => copyEvents.push(done),
      thumbProgress: (done) => thumbEvents.push(done),
    },
    sourceExists: (path) => sources.has(path),
    parentIdentity: () => Promise.resolve('card-parent'),
    ...overrides,
  };
  return {
    deps,
    sources,
    blobs,
    rows,
    hashes,
    copyEvents,
    thumbEvents,
    journalRaw: () => journal,
    setJournal: (manifest: ImportManifest) => {
      journal = structuredClone(manifest);
    },
    insertCalls: () => insertCalls,
    engine: () => new ImportEngine(deps),
  };
}

function addSource(world: ReturnType<typeof harness>, name: string, bytes: Buffer) {
  world.sources.set(`/card/${name}`, bytes);
  return { path: `/card/${name}`, fileName: name, kind: 'jpeg' as const };
}

describe('import engine (#87)', () => {
  const jpeg = readFileSync(join(FIXTURES, 'exif-full.jpg'));
  const other = readFileSync(join(FIXTURES, 'exif-stripped.jpg'));

  test('EXIT CRITERIA: copy batch — encrypted, recorded, journal cleared, sources intact', async () => {
    const world = harness();
    const files = [addSource(world, 'a.jpg', jpeg), addSource(world, 'b.jpg', other)];
    const summary = await world.engine().importFiles(files, 'copy', '/card');
    assert.deepEqual(
      { imported: summary.imported, duplicates: summary.duplicates, failed: summary.failed },
      { imported: 2, duplicates: 0, failed: 0 },
    );
    assert.equal(world.rows.size, 2);
    assert.ok(world.blobs.has(sha256(jpeg)));
    assert.equal(world.sources.size, 2, 'copy never touches sources');
    assert.equal(world.journalRaw(), null, 'completed batch clears the journal');
    // Both aggregate streams reach n/total = 2/2 and are monotonic.
    assert.equal(world.copyEvents.at(-1), 2);
    assert.equal(world.thumbEvents.at(-1), 2);
    assert.ok(world.copyEvents.every((value, index, all) => index === 0 || value >= (all[index - 1] ?? 0)));
    const row = [...world.rows.values()][0];
    assert.equal(row?.importSource, '/card');
  });

  test('already-known content hashes record as duplicates without storing', async () => {
    const world = harness();
    world.hashes.add(sha256(jpeg));
    const summary = await world.engine().importFiles([addSource(world, 'a.jpg', jpeg)], 'copy', '/card');
    assert.deepEqual({ imported: summary.imported, duplicates: summary.duplicates }, { imported: 0, duplicates: 1 });
    assert.equal(world.blobs.size, 0);
    assert.equal(world.insertCalls(), 0);
  });

  test('decoder dimensions repair a metadata-lite JPEG before import completes (#367)', async () => {
    const world = harness({
      generateThumbs: () => Promise.resolve({ generated: true, width: 960, height: 1280 }),
    });
    const summary = await world.engine().importFiles([addSource(world, 'stripped.jpg', other)], 'copy', '/card');
    assert.equal(summary.imported, 1);
    const row = [...world.rows.values()][0];
    assert.deepEqual({ width: row?.width, height: row?.height }, { width: 960, height: 1280 });
  });

  test('EXIT CRITERIA (Move): source deleted only after ITS blob verifies; a failed verify retains it', async () => {
    const world = harness();
    const good = addSource(world, 'good.jpg', jpeg);
    const summary = await world.engine().importFiles([good], 'move', '/card');
    assert.equal(summary.imported, 1);
    assert.deepEqual({ moved: summary.moved, retained: summary.retained }, { moved: 1, retained: 0 });
    assert.deepEqual(summary.moveCompensations, [
      {
        photoId: summary.photoIds[0],
        contentHash: sha256(jpeg),
        sourcePath: good.path,
        byteCharge: jpeg.length,
        parentIdentity: 'card-parent',
      },
    ]);
    assert.equal(world.sources.has(good.path), false, 'verified move removes the source');

    // Now a world whose store never verifies: the file fails, source stays.
    const broken = harness({
      blobs: {
        putOriginal: async () => Promise.resolve({ keyId: 1, bytes: 1 }),
        verifyOriginal: async () => Promise.resolve(false),
      },
    });
    const bad = addSource(broken, 'bad.jpg', other);
    const badSummary = await broken.engine().importFiles([bad], 'move', '/card');
    // The row committed before verification, so the photo IS imported; the
    // journal stays so cleanup retries on resume — and the source survives.
    assert.equal(badSummary.imported, 1);
    assert.deepEqual({ moved: badSummary.moved, retained: badSummary.retained }, { moved: 0, retained: 1 });
    assert.equal(broken.sources.has(bad.path), true, 'unverified source must NEVER be deleted');
    assert.notEqual(broken.journalRaw(), null, 'unfinished cleanup keeps the journal');
  });

  test('a crash after Move unlink resumes from the persisted compensation lease', async () => {
    const world = harness();
    const source = addSource(world, 'crash.jpg', jpeg);
    (world.deps as { deleteFile: (path: string) => Promise<void> }).deleteFile = (path) => {
      world.sources.delete(path);
      return Promise.reject(new Error('process died after unlink'));
    };
    const interrupted = await world.engine().importFiles([source], 'move', '/card');
    assert.equal(interrupted.moved, 0);
    assert.notEqual(world.journalRaw(), null);

    (world.deps as { deleteFile: (path: string) => Promise<void> }).deleteFile = () => Promise.resolve();
    const resumed = await world.engine().resume();
    assert.equal(resumed?.moved, 1);
    assert.equal(resumed?.moveCompensations[0]?.sourcePath, source.path);
    assert.equal(world.journalRaw(), null);
  });

  test('#489: a source permission failure reports imported-but-retained and keeps the cleanup journal', async () => {
    const world = harness({ deleteFile: () => Promise.reject(new Error('EACCES')) });
    const source = addSource(world, 'read-only.jpg', jpeg);

    const summary = await world.engine().importFiles([source], 'move', '/folder');

    assert.deepEqual(
      { imported: summary.imported, moved: summary.moved, retained: summary.retained, failed: summary.failed },
      { imported: 1, moved: 0, retained: 1, failed: 0 },
    );
    assert.equal(world.sources.has(source.path), true);
    assert.notEqual(world.journalRaw(), null);
  });

  test('a per-file failure is isolated; the batch continues', async () => {
    const world = harness();
    const one = addSource(world, 'one.jpg', jpeg);
    const gone = { path: '/card/vanished.jpg', fileName: 'vanished.jpg', kind: 'jpeg' as const }; // no bytes → readFile throws
    const two = addSource(world, 'two.jpg', other);
    const summary = await world.engine().importFiles([one, gone, two], 'copy', '/card');
    assert.deepEqual({ imported: summary.imported, failed: summary.failed }, { imported: 2, failed: 1 });
    assert.equal(world.journalRaw(), null);
  });

  describe('kill-test matrix: resume completes idempotently from every journaled stage', () => {
    function manifestWith(file: Partial<ManifestFile> & { path: string; fileName: string }, mode: 'copy' | 'move'): ImportManifest {
      return {
        batchId: 'BATCH',
        mode,
        source: '/card',
        files: [{ kind: 'jpeg', stage: 'pending', ...file }],
      };
    }

    test('killed before anything persisted (stage pending) → full import', async () => {
      const world = harness();
      const src = addSource(world, 'a.jpg', jpeg);
      world.setJournal(manifestWith({ path: src.path, fileName: src.fileName }, 'copy'));
      const summary = await world.engine().resume();
      assert.equal(summary?.imported, 1);
      assert.equal(world.rows.size, 1);
      assert.equal(world.journalRaw(), null);
    });

    test('killed between DB commit and journal write → own row recognized, never re-inserted', async () => {
      const world = harness();
      const src = addSource(world, 'a.jpg', jpeg);
      // Simulate: photoId journaled, row committed, but stage still pending.
      world.deps.repo.insert({
        id: 'OWNROW',
        fileName: src.fileName,
        fileKind: 'jpeg',
        width: 0,
        height: 0,
        bytes: jpeg.length,
        contentHash: sha256(jpeg),
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
        importedAt: 'x',
        importSource: '/card',
        keyId: 1,
      });
      const before = world.insertCalls();
      world.setJournal(manifestWith({ path: src.path, fileName: src.fileName, photoId: 'OWNROW' }, 'copy'));
      const summary = await world.engine().resume();
      assert.equal(summary?.imported, 1, 'finished as imported, not duplicate');
      assert.equal(world.insertCalls(), before, 'no second insert');
      assert.deepEqual({ width: world.rows.get('OWNROW')?.width, height: world.rows.get('OWNROW')?.height }, { width: 1, height: 1 });
      assert.equal(world.journalRaw(), null);
    });

    test('killed after record, before thumbs (stage recorded) → thumbs + cleanup only', async () => {
      const world = harness();
      const src = addSource(world, 'a.jpg', jpeg);
      let thumbCalls = 0;
      const deps = { ...world.deps, generateThumbs: () => ((thumbCalls += 1), Promise.resolve({ generated: true, width: 1, height: 1 })) };
      world.setJournal(
        manifestWith({ path: src.path, fileName: src.fileName, photoId: 'P1', status: 'imported', stage: 'recorded' }, 'copy'),
      );
      const summary = await new ImportEngine(deps).resume();
      assert.equal(summary?.imported, 1);
      assert.equal(thumbCalls, 1);
      assert.equal(world.insertCalls(), 0, 'record stage never re-runs');
    });

    test('killed after thumbs, before Move cleanup (stage thumbed) → verify then delete source', async () => {
      const world = harness();
      const src = addSource(world, 'a.jpg', jpeg);
      world.blobs.add(sha256(jpeg)); // the blob landed before the kill
      world.setJournal(
        manifestWith({ path: src.path, fileName: src.fileName, photoId: 'P1', status: 'imported', stage: 'thumbed' }, 'move'),
      );
      const summary = await world.engine().resume();
      assert.equal(summary?.imported, 1);
      assert.equal(world.sources.has(src.path), false, 'cleanup completed on resume');
      assert.equal(world.insertCalls(), 0);
    });

    test('user cancel finishes the current file, keeps completed, and finalizes the rest as cancelled (#88)', async () => {
      const world = harness();
      const files = [addSource(world, 'a.jpg', jpeg), addSource(world, 'b.jpg', other)];
      const controller = new AbortController();
      const deps = {
        ...world.deps,
        events: {
          copyProgress: (done: number) => {
            world.copyEvents.push(done);
            if (done === 1) {
              controller.abort(); // Cancel clicked after the first file lands
            }
          },
          thumbProgress: () => undefined,
        },
      };
      const summary = await new ImportEngine(deps).importFiles(files, 'copy', '/card', controller.signal);
      assert.deepEqual(
        { imported: summary.imported, cancelled: summary.cancelled, failed: summary.failed },
        { imported: 1, cancelled: 1, failed: 0 },
      );
      assert.equal(world.rows.size, 1, 'completed file kept');
      assert.equal(world.sources.size, 2, 'cancelled sources untouched');
      assert.equal(world.journalRaw(), null, 'a cancelled batch is FINAL — nothing resumes it');
      assert.equal(await world.engine().resume(), null);
    });

    test('a post-commit thumbnail failure stays imported and retries on resume', async () => {
      // The row is committed when thumbs blow up (PR #183 review): the file
      // must surface in photoIds (library:changed fires), keep its journal,
      // and finish its remaining stages on the next resume.
      const world = harness();
      addSource(world, 'a.jpg', jpeg);
      let healthy = false;
      const deps = {
        ...world.deps,
        generateThumbs: () =>
          healthy ? Promise.resolve({ generated: true, width: 1, height: 1 }) : Promise.reject(new Error('sharp exploded')),
      };
      const first = await new ImportEngine(deps).importFiles([{ path: '/card/a.jpg', fileName: 'a.jpg', kind: 'jpeg' }], 'copy', '/card');
      assert.deepEqual({ imported: first.imported, failed: first.failed }, { imported: 1, failed: 0 });
      assert.equal(first.photoIds.length, 1, 'committed photo announces itself');
      assert.notEqual(world.journalRaw(), null, 'unfinished stages keep the journal');
      assert.equal(world.insertCalls(), 1);

      healthy = true;
      const resumed = await new ImportEngine(deps).resume();
      assert.equal(resumed?.imported, 1);
      assert.equal(world.journalRaw(), null, 'retry completed and cleared the journal');
      assert.equal(world.insertCalls(), 1, 'never re-inserted');
    });

    test('resume with no journal is a no-op', async () => {
      const world = harness();
      assert.equal(await world.engine().resume(), null);
    });
  });
});

describe('signature-first classification and probed media info (ADR-0026, #547)', () => {
  const ANIMATED = join(import.meta.dirname, '../../../tests/fixtures/animated');
  const animatedGif = readFileSync(join(ANIMATED, 'animated.gif'));
  const staticWebp = readFileSync(join(ANIMATED, 'static.webp'));
  const jpeg = readFileSync(join(FIXTURES, 'exif-full.jpg'));

  test('animated GIF imports with kind gif and probed animation facts', async () => {
    const world = harness();
    world.sources.set('/card/party.gif', animatedGif);
    const summary = await world.engine().importFiles([{ path: '/card/party.gif', fileName: 'party.gif', kind: 'gif' }], 'copy', '/card');
    assert.equal(summary.imported, 1);
    const row = [...world.rows.values()][0];
    assert.equal(row?.fileKind, 'gif');
    assert.deepEqual(row?.mediaInfo, { animated: true, frameCount: 3, loopCount: 0 });
  });

  test('static WebP imports with kind webp and single-frame facts', async () => {
    const world = harness();
    world.sources.set('/card/still.webp', staticWebp);
    await world.engine().importFiles([{ path: '/card/still.webp', fileName: 'still.webp', kind: 'webp' }], 'copy', '/card');
    const row = [...world.rows.values()][0];
    assert.equal(row?.fileKind, 'webp');
    assert.deepEqual(row?.mediaInfo, { animated: false, frameCount: 1, loopCount: null });
  });

  test('a JPEG wearing a .gif suffix records what the bytes are (spoofed extension)', async () => {
    const world = harness();
    world.sources.set('/card/fake.gif', jpeg);
    await world.engine().importFiles([{ path: '/card/fake.gif', fileName: 'fake.gif', kind: 'gif' }], 'copy', '/card');
    const row = [...world.rows.values()][0];
    assert.equal(row?.fileKind, 'jpeg', 'signature wins over suffix');
    assert.equal(row?.mediaInfo ?? null, null);
    assert.equal(row?.fileName, 'fake.gif', 'original name and extension preserved verbatim');
  });

  test('still-image kinds keep null media info', async () => {
    const world = harness();
    const files = [addSource(world, 'plain.jpg', jpeg)];
    await world.engine().importFiles(files, 'copy', '/card');
    const row = [...world.rows.values()][0];
    assert.equal(row?.mediaInfo ?? null, null);
  });

  test('an undecodable gif imports as a placeholder with honest preview-failure state', async () => {
    const failures: Array<{ id: string; failure: unknown }> = [];
    const world = harness();
    const truncated = animatedGif.subarray(0, 24); // valid signature, unusable body
    world.sources.set('/card/broken.gif', Buffer.from(truncated));
    const deps: ImportEngineDeps = {
      ...world.deps,
      repo: {
        ...world.deps.repo,
        setPreviewFailure: (id, failure) => {
          failures.push({ id, failure });
          return true;
        },
      },
      generateThumbs: () => Promise.resolve({ generated: false, width: null, height: null }),
    };
    const summary = await new ImportEngine(deps).importFiles(
      [{ path: '/card/broken.gif', fileName: 'broken.gif', kind: 'gif' }],
      'copy',
      '/card',
    );
    assert.equal(summary.imported, 1, 'placeholder import, never a failed item');
    assert.deepEqual(failures, [{ id: [...world.rows.keys()][0], failure: 'decode-failed' }]);
  });
});
