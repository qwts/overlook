import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ImportService } from '../../src/main/import/import-service.js';
import type { ImportEngine, ImportSummary } from '../../src/main/import/import-engine.js';
import type { PhotosRepository } from '../../src/main/db/photos-repository.js';
import type { SourceScanSummary } from '../../src/main/import/source-scanner.js';
import { GoogleDriveImportSource } from '../../src/main/import/google-drive-source.js';

// The service owns "one journal, one writer" (#87, PR #183 review): batches
// and resumes never overlap, whatever order callers fire them in.

function fakeRepo(): PhotosRepository {
  return { hasContentHash: () => false } as unknown as PhotosRepository;
}

const IDLE_EVENTS = {
  scanProgress: () => undefined,
  copyProgress: () => undefined,
  thumbProgress: () => undefined,
  imported: () => undefined,
};

const EMPTY_SCAN: SourceScanSummary = {
  total: 0,
  newCount: 0,
  newBytes: 0,
  newRaw: 0,
  newJpg: 0,
  newOther: 0,
  newSidecars: 0,
  unmatchedCompanions: 0,
};

describe('import service serialization (#87)', () => {
  test('overlapping run()/resume() calls execute strictly in turn', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'overlook-src-'));
    writeFileSync(join(sourceDir, 'a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    let active = 0;
    let peak = 0;
    const enter = async (): Promise<ImportSummary> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        imported: 0,
        moved: 0,
        retained: 0,
        duplicates: 0,
        failed: 0,
        cancelled: 0,
        sidecars: 0,
        photoIds: [],
        moveCompensations: [],
      };
    };
    const engine = {
      importFiles: enter,
      resume: async () => enter(),
    } as unknown as ImportEngine;

    const service = new ImportService(fakeRepo(), IDLE_EVENTS, engine);
    await Promise.all([service.run(sourceDir, 'copy'), service.run(sourceDir, 'copy'), service.resume()]);
    assert.equal(peak, 1, 'the journal has exactly one writer at a time');
  });

  test('a failed batch does not wedge the queue', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'overlook-src-'));
    writeFileSync(join(sourceDir, 'a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    let calls = 0;
    const engine = {
      importFiles: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error('first batch dies'));
        }
        return Promise.resolve({ imported: 0, moved: 0, retained: 0, duplicates: 0, failed: 0, cancelled: 0, photoIds: [] });
      },
      resume: () => Promise.resolve(null),
    } as unknown as ImportEngine;
    const service = new ImportService(fakeRepo(), IDLE_EVENTS, engine);
    await assert.rejects(service.run(sourceDir, 'copy'));
    await service.run(sourceDir, 'copy'); // must not hang or reject
    assert.equal(calls, 2);
  });

  test('drain waits until serialized library writes finish', async () => {
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = {
      importFiles: () => Promise.resolve(null),
      resume: async () => {
        entered?.();
        await gate;
        return null;
      },
    } as unknown as ImportEngine;
    const service = new ImportService(fakeRepo(), IDLE_EVENTS, engine);
    const resume = service.resume();
    await started;
    let drained = false;
    const drain = service.drain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    release?.();
    await Promise.all([resume, drain]);
    assert.equal(drained, true);
  });

  test('close aborts admission for work already queued behind an active batch', async () => {
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const engine = {
      importFiles: () => Promise.resolve(null),
      resume: async () => {
        calls += 1;
        entered?.();
        await gate;
        return null;
      },
    } as unknown as ImportEngine;
    const service = new ImportService(fakeRepo(), IDLE_EVENTS, engine);
    const active = service.resume();
    await started;
    const queued = service.resume();

    service.close();
    release?.();

    await active;
    await assert.rejects(queued, /import service is closed/u);
    await service.drain();
    assert.equal(calls, 1);
  });

  test('close aborts and drains active scans before rejecting later scan admission', async () => {
    let started: (() => void) | undefined;
    const scanStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    const service = new ImportService(fakeRepo(), IDLE_EVENTS, {} as ImportEngine, () => undefined, {
      source: async (_path, _deps, _progress, activeSignal) => {
        signal = activeSignal;
        started?.();
        await gate;
        if (activeSignal?.aborted === true) throw new Error('scan cancelled');
        return { summary: EMPTY_SCAN, files: [] };
      },
      files: () => Promise.resolve({ summary: EMPTY_SCAN, files: [] }),
    });
    const scan = service.scanSource('/source');
    await scanStarted;

    service.close();
    assert.equal(signal?.aborted, true);
    let drained = false;
    const drain = service.drain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);

    release?.();
    await assert.rejects(scan, /scan cancelled/u);
    await drain;
    assert.equal(drained, true);
    await assert.rejects(service.scanDropped([]), /import service is closed/u);
  });
});

describe('local folder and dropped Move policy (#489)', () => {
  const fresh = {
    path: '/source/a.jpg',
    fileName: 'a.jpg',
    kind: 'jpeg' as const,
    bytes: 4,
    contentHash: 'a'.repeat(64),
    isNew: true,
    sidecars: [],
  };
  const existing = {
    ...fresh,
    path: '/source/duplicate.jpg',
    fileName: 'duplicate.jpg',
    contentHash: 'b'.repeat(64),
    isNew: false,
  };
  const scan = {
    summary: { total: 2, newCount: 1, newBytes: 4, newRaw: 0, newJpg: 1, newOther: 0, newSidecars: 0, unmatchedCompanions: 0 },
    files: [fresh, existing],
  };

  test('a selected local folder reaches the verified Move engine without pretending to be removable', async () => {
    const calls: Array<{ mode: string; source: string; paths: readonly string[] }> = [];
    const engine = {
      importFiles: (files: readonly { path: string }[], mode: string, source: string) => {
        calls.push({ mode, source, paths: files.map((file) => file.path) });
        return Promise.resolve({ imported: 1, moved: 1, retained: 0, duplicates: 0, failed: 0, cancelled: 0, photoIds: ['P1'] });
      },
    } as unknown as ImportEngine;
    const service = new ImportService(fakeRepo(), IDLE_EVENTS, engine, () => undefined, {
      source: () => Promise.resolve(scan),
      files: () => Promise.resolve(scan),
    });

    const summary = await service.run('/source', 'move');

    assert.deepEqual(calls, [{ mode: 'move', source: '/source', paths: ['/source/a.jpg'] }]);
    assert.deepEqual(
      { imported: summary.imported, moved: summary.moved, retained: summary.retained, duplicates: summary.duplicates },
      { imported: 1, moved: 1, retained: 1, duplicates: 1 },
    );
  });

  test('mixed dropped paths preserve the requested mode and never pass enclosing folders to deletion', async () => {
    const calls: Array<{ mode: string; source: string; paths: readonly string[] }> = [];
    const engine = {
      importFiles: (files: readonly { path: string }[], mode: string, source: string) => {
        calls.push({ mode, source, paths: files.map((file) => file.path) });
        return Promise.resolve({ imported: 1, moved: 1, retained: 0, duplicates: 0, failed: 0, cancelled: 0, photoIds: ['P1'] });
      },
    } as unknown as ImportEngine;
    const service = new ImportService(fakeRepo(), IDLE_EVENTS, engine, () => undefined, {
      source: () => Promise.resolve(scan),
      files: () => Promise.resolve(scan),
    });

    const summary = await service.runFiles(['/source', '/other/b.jpg'], 'move');

    assert.deepEqual(calls, [{ mode: 'move', source: 'dropped', paths: ['/source/a.jpg'] }]);
    assert.deepEqual(
      { moved: summary.moved, retained: summary.retained, duplicates: summary.duplicates },
      { moved: 1, retained: 1, duplicates: 1 },
    );
  });

  test('Move rejects admitted files inside the active library before the engine runs', async () => {
    let calls = 0;
    const engine = {
      importFiles: () => {
        calls += 1;
        return Promise.resolve({ imported: 0, moved: 0, retained: 0, duplicates: 0, failed: 0, cancelled: 0, photoIds: [] });
      },
    } as unknown as ImportEngine;
    const inside = { ...scan, files: [{ ...fresh, path: '/library/exports/a.jpg' }] };
    const service = new ImportService(
      fakeRepo(),
      IDLE_EVENTS,
      engine,
      () => undefined,
      { source: () => Promise.resolve(inside), files: () => Promise.resolve(inside) },
      undefined,
      '/library',
    );

    await assert.rejects(service.run('/library/exports', 'move'), /inside the active library/u);
    assert.equal(calls, 0);
  });
});

describe('import service fixture source is injector-gated (#129 F1)', () => {
  const engine = { importFiles: () => Promise.resolve(null), resume: () => Promise.resolve(null) } as unknown as ImportEngine;

  test('no injector surfaces no fixture folder (packaged/default posture)', async () => {
    const service = new ImportService(fakeRepo(), IDLE_EVENTS, engine);
    const sources = await service.listSources();
    assert.ok(!sources.some((s) => s.path === '/tmp/overlook-fixture'), 'default resolver yields undefined — env cannot inject a source');
  });

  test('injector returning a path surfaces it as the first source', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'overlook-fixture-'));
    const service = new ImportService(fakeRepo(), IDLE_EVENTS, engine, () => fixture);
    const sources = await service.listSources();
    assert.equal(sources[0]?.path, fixture, 'the gated injector, when it returns a path, wins first slot');
  });

  test('injector returning empty string is ignored', async () => {
    const service = new ImportService(fakeRepo(), IDLE_EVENTS, engine, () => '');
    const sources = await service.listSources();
    assert.ok(
      sources.every((s) => s.path !== ''),
      'empty string is not a source',
    );
  });
});

describe('Google Drive import service (#465)', () => {
  test('renderer cancellation closes the active Picker through the service boundary', async () => {
    let rejectResult: ((error: Error) => void) | undefined;
    let closes = 0;
    const googleDrive = new GoogleDriveImportSource({
      stagingRoot: mkdtempSync(join(tmpdir(), 'overlook-drive-service-cancel-')),
      clientId: () => 'desktop.apps.googleusercontent.com',
      openExternal: () => Promise.resolve(),
      capture: () => ({
        listening: Promise.resolve({ port: 1, redirectUri: 'http://127.0.0.1:1' }),
        result: new Promise((_resolve, reject) => {
          rejectResult = reject;
        }),
        close: () => {
          closes += 1;
          rejectResult?.(new Error('cancelled'));
        },
      }),
    });
    const service = new ImportService(
      fakeRepo(),
      IDLE_EVENTS,
      { resume: () => Promise.resolve(null) } as unknown as ImportEngine,
      () => undefined,
      undefined,
      googleDrive,
    );
    const picking = service.pickGoogleDrive();
    await new Promise((resolve) => setImmediate(resolve));
    service.cancelGoogleDrivePick();
    assert.deepEqual(await picking, { status: 'cancelled' });
    assert.ok(closes >= 1);
  });

  test('selected files reuse the serialized copy pipeline with a stable source label', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'overlook-drive-service-'));
    writeFileSync(join(fixture, 'cloud.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const googleDrive = new GoogleDriveImportSource({
      stagingRoot: join(fixture, 'unused-staging'),
      clientId: () => null,
      openExternal: () => Promise.resolve(),
      fixtureSource: () => fixture,
    });
    const calls: Array<{ source: string; mode: string; names: readonly string[]; cleanupPath: string | undefined }> = [];
    const engine = {
      importFiles: (files: readonly { fileName: string }[], mode: string, source: string, _signal: AbortSignal, cleanupPath?: string) => {
        calls.push({ source, mode, names: files.map((file) => file.fileName), cleanupPath });
        return Promise.resolve({ imported: 1, moved: 0, retained: 1, duplicates: 0, failed: 0, cancelled: 0, photoIds: ['P1'] });
      },
      resume: () => Promise.resolve(null),
    } as unknown as ImportEngine;
    const imported: string[][] = [];
    const service = new ImportService(
      fakeRepo(),
      { ...IDLE_EVENTS, imported: (ids) => imported.push([...ids]) },
      engine,
      () => undefined,
      undefined,
      googleDrive,
    );

    const picked = await service.pickGoogleDrive();
    assert.equal(picked.status, 'ready');
    if (picked.status !== 'ready') return;
    assert.equal(picked.summary.newCount, 1);
    const summary = await service.runGoogleDrive(picked.selectionId);
    assert.equal(summary.imported, 1);
    assert.deepEqual(calls, [{ source: 'Google Drive', mode: 'copy', names: ['cloud.jpg'], cleanupPath: undefined }]);
    assert.deepEqual(imported, [['P1']]);
    await assert.rejects(service.runGoogleDrive(picked.selectionId), /selection is unavailable/u);
  });
});
