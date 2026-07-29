import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ImportJournal } from '../../src/main/import/import-journal.js';
import type { ImportManifest, ManifestFile } from '../../src/main/import/import-engine.js';

// Append-only journal: the crash-safety anchor must persist a per-file
// stage transition WITHOUT rewriting the whole manifest (the O(N²) rewrite
// behind the 2026-07 multi-day import freeze), while a torn write still
// never corrupts previously journaled state.

function manifestOf(count: number): ImportManifest {
  return {
    batchId: 'BATCH',
    mode: 'copy',
    source: '/card',
    files: Array.from({ length: count }, (_, index) => ({
      path: `/card/photo-${index}.jpg`,
      fileName: `photo-${index}.jpg`,
      kind: 'jpeg' as const,
      stage: 'pending' as const,
    })),
  };
}

function doneFile(base: ManifestFile): ManifestFile {
  return { ...base, stage: 'done', status: 'imported', contentHash: 'hash', photoId: 'P1' };
}

function fileAt(manifest: ImportManifest, index: number): ManifestFile {
  const file = manifest.files[index];
  assert.ok(file, `manifest has a file at ${String(index)}`);
  return file;
}

function journalAt(dir: string): { journal: ImportJournal; path: string } {
  const path = join(dir, 'import-journal.json');
  return { journal: new ImportJournal(path), path };
}

describe('import journal (append-only, torn-write safe)', () => {
  test('begin → read round-trips; updates replay in order on top of the snapshot', async () => {
    const { journal, path } = journalAt(mkdtempSync(join(tmpdir(), 'overlook-journal-')));
    const manifest = manifestOf(3);
    await journal.begin(manifest);
    const first = fileAt(manifest, 0);
    await journal.update([{ index: 0, file: { ...first, stage: 'recorded', status: 'imported', photoId: 'P1' } }]);
    await journal.update([{ index: 0, file: doneFile(first) }]);

    // The transitions APPENDED — the snapshot line was written once.
    assert.equal(readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').length, 3);

    const replayed = await new ImportJournal(path).read();
    assert.equal(replayed?.batchId, 'BATCH');
    assert.deepEqual(
      { stage: replayed?.files[0]?.stage, status: replayed?.files[0]?.status, photoId: replayed?.files[0]?.photoId },
      { stage: 'done', status: 'imported', photoId: 'P1' },
    );
    assert.equal(replayed?.files[1]?.stage, 'pending', 'untouched files keep snapshot state');
  });

  test('a torn appended line is dropped; every line before it survives', async () => {
    const { journal, path } = journalAt(mkdtempSync(join(tmpdir(), 'overlook-journal-torn-')));
    const manifest = manifestOf(2);
    await journal.begin(manifest);
    await journal.update([{ index: 0, file: doneFile(fileAt(manifest, 0)) }]);
    // A crash mid-append leaves a prefix of the update line.
    appendFileSync(path, '{"index":1,"file":{"path":"/card/pho', 'utf8');

    const replayed = await new ImportJournal(path).read();
    assert.equal(replayed?.files[0]?.stage, 'done', 'intact update replays');
    assert.equal(replayed?.files[1]?.stage, 'pending', 'torn tail is ignored, not corrupting');
  });

  test('a torn or corrupt snapshot line means no pending batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-journal-corrupt-'));
    const { path } = journalAt(dir);
    writeFileSync(path, '{"batchId":"BATCH","mo', 'utf8');
    assert.equal(await new ImportJournal(path).read(), null);
    writeFileSync(path, '"not-a-manifest"\n', 'utf8');
    assert.equal(await new ImportJournal(path).read(), null);
  });

  test('an out-of-range or malformed update entry stops the replay there', async () => {
    const { journal, path } = journalAt(mkdtempSync(join(tmpdir(), 'overlook-journal-bad-entry-')));
    const manifest = manifestOf(1);
    await journal.begin(manifest);
    appendFileSync(path, '{"index":9,"file":{"path":"/x","fileName":"x","kind":"jpeg","stage":"done"}}\n', 'utf8');
    const replayed = await new ImportJournal(path).read();
    assert.equal(replayed?.files[0]?.stage, 'pending');
  });

  test('a pre-append single-line journal (old format) still resumes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-journal-legacy-'));
    const { path } = journalAt(dir);
    const manifest = manifestOf(2);
    fileAt(manifest, 0).stage = 'recorded';
    writeFileSync(path, JSON.stringify(manifest), 'utf8'); // the old whole-manifest write: one line, no terminator
    const replayed = await new ImportJournal(path).read();
    assert.equal(replayed?.files[0]?.stage, 'recorded');
    assert.equal(replayed?.files[1]?.stage, 'pending');
  });

  test('read() resumes appending where the log left off', async () => {
    const { journal, path } = journalAt(mkdtempSync(join(tmpdir(), 'overlook-journal-resume-append-')));
    const manifest = manifestOf(3);
    await journal.begin(manifest);
    await journal.update([{ index: 0, file: doneFile(fileAt(manifest, 0)) }]);

    const reopened = new ImportJournal(path);
    const replayed = await reopened.read();
    assert.ok(replayed, 'the interrupted batch is readable');
    await reopened.update([{ index: 1, file: doneFile(fileAt(replayed, 1)) }]);
    const again = await new ImportJournal(path).read();
    assert.deepEqual([again?.files[0]?.stage, again?.files[1]?.stage, again?.files[2]?.stage], ['done', 'done', 'pending']);
  });

  test('the log compacts instead of growing without bound; a full batch journals in O(N) bytes', async () => {
    const { journal, path } = journalAt(mkdtempSync(join(tmpdir(), 'overlook-journal-compact-')));
    const manifest = manifestOf(4);
    await journal.begin(manifest);
    let peak = 0;
    // Drive well past the compaction floor: every file transitions many
    // times, as a pathological resume loop would.
    for (let round = 0; round < 100; round += 1) {
      for (const [index, file] of manifest.files.entries()) {
        await journal.update([{ index, file: round % 2 === 0 ? doneFile(file) : { ...file, stage: 'recorded' } }]);
        peak = Math.max(peak, statSync(path).size);
      }
    }
    const snapshotBytes = JSON.stringify(manifest).length;
    assert.ok(peak < snapshotBytes + 300 * 260, `journal stayed bounded (peak ${String(peak)}B)`);

    const replayed = await new ImportJournal(path).read();
    assert.equal(replayed?.files[3]?.stage, 'recorded', 'compacted state matches the last update');
  });

  test('an empty update never touches the file; updating before begin throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-journal-empty-'));
    const { journal, path } = journalAt(dir);
    await journal.update([]);
    assert.throws(() => statSync(path), 'no journal file materializes from a no-op');
    await assert.rejects(journal.update([{ index: 0, file: fileAt(manifestOf(1), 0) }]), /before begin/u);
  });

  test('clear removes the journal; reading again finds no batch', async () => {
    const { journal, path } = journalAt(mkdtempSync(join(tmpdir(), 'overlook-journal-clear-')));
    await journal.begin(manifestOf(1));
    await journal.clear();
    assert.throws(() => statSync(path));
    assert.equal(await new ImportJournal(path).read(), null);
    assert.equal(await journal.read(), null, 'clearing twice stays a no-op');
    await journal.clear();
  });
});
