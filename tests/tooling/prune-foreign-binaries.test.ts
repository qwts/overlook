import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();

interface PruneModule {
  readonly ARCH_NAME: Readonly<Record<number, string>>;
  readonly BUNDLED_MULTI_PLATFORM_ROOTS: readonly string[];
  readonly isForeign: (platformDir: string, archDir: string, targetPlatform: string, targetArch: string) => boolean;
  readonly findRoots: (appOutDir: string, relativeRoot: string, depth?: number) => Promise<string[]>;
  readonly pruneForeignBinaries: (appOutDir: string, targetPlatform: string, targetArch: string) => Promise<string[]>;
}

function pruneModule(): Promise<PruneModule> {
  return import(pathToFileURL(join(root, 'scripts/prune-foreign-binaries.mjs')).href) as Promise<PruneModule>;
}

// The layout onnxruntime-node ships: every platform and arch in one package.
function packedApp(resourcesPrefix: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'prune-'));
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const arch of ['arm64', 'x64']) {
      if (platform === 'darwin' && arch === 'x64') continue; // matches the real package
      const leaf = join(dir, ...resourcesPrefix, 'node_modules/onnxruntime-node/bin/napi-v6', platform, arch);
      mkdirSync(leaf, { recursive: true });
      writeFileSync(join(leaf, 'onnxruntime_binding.node'), 'binary');
    }
  }
  return dir;
}

function survives(appDir: string, prefix: string[], platform: string, arch: string): boolean {
  return existsSync(join(appDir, ...prefix, 'node_modules/onnxruntime-node/bin/napi-v6', platform, arch));
}

describe('foreign binary pruning', () => {
  test('keeps only the target platform and arch', async () => {
    const { isForeign } = await pruneModule();
    assert.equal(isForeign('win32', 'x64', 'win32', 'x64'), false);
    assert.equal(isForeign('win32', 'arm64', 'win32', 'x64'), true); // wrong arch, right platform
    assert.equal(isForeign('darwin', 'arm64', 'win32', 'x64'), true); // Mach-O in a Windows build
    assert.equal(isForeign('linux', 'x64', 'win32', 'x64'), true); // ELF in a Windows build
  });

  test('a universal macOS build keeps both darwin slices', async () => {
    const { isForeign } = await pruneModule();
    assert.equal(isForeign('darwin', 'arm64', 'darwin', 'universal'), false);
    assert.equal(isForeign('darwin', 'x64', 'darwin', 'universal'), false);
    assert.equal(isForeign('win32', 'x64', 'darwin', 'universal'), true);
  });

  test('maps only the arches this app builds for', async () => {
    const { ARCH_NAME } = await pruneModule();
    assert.equal(ARCH_NAME[1], 'x64');
    assert.equal(ARCH_NAME[3], 'arm64');
    // An unmapped arch must prune nothing rather than guess and delete the
    // binary the build actually needs.
    assert.equal(ARCH_NAME[0], undefined);
  });

  // The packed layout differs per platform, so the hook searches rather than
  // hardcoding: Contents/Resources on macOS, resources elsewhere.
  for (const [label, prefix] of [
    ['windows and linux', ['resources', 'app.asar.unpacked']],
    ['macOS', ['Overlook.app', 'Contents', 'Resources', 'app.asar.unpacked']],
  ] as const) {
    test(`finds the bundled root in the ${label} layout`, async () => {
      const { findRoots, BUNDLED_MULTI_PLATFORM_ROOTS } = await pruneModule();
      const app = packedApp([...prefix]);
      const found = await findRoots(app, BUNDLED_MULTI_PLATFORM_ROOTS[0] ?? '');
      assert.equal(found.length, 1);
    });
  }

  test('removes exactly the four binaries that failed the Windows x64 gate (#683)', async () => {
    const { pruneForeignBinaries } = await pruneModule();
    const prefix = ['resources', 'app.asar.unpacked'];
    const app = packedApp(prefix);

    const removed = await pruneForeignBinaries(app, 'win32', 'x64');

    // Three non-PE (darwin/arm64, linux/arm64, linux/x64) plus win32/arm64,
    // which is a PE of the wrong machine type — the exact four the release run
    // reported before this hook existed.
    assert.equal(removed.length, 4);
    assert.equal(survives(app, prefix, 'win32', 'x64'), true);
    assert.equal(survives(app, prefix, 'win32', 'arm64'), false);
    assert.equal(survives(app, prefix, 'darwin', 'arm64'), false);
    assert.equal(survives(app, prefix, 'linux', 'x64'), false);
  });

  test('is a no-op when nothing foreign is packaged', async () => {
    const { pruneForeignBinaries } = await pruneModule();
    const empty = mkdtempSync(join(tmpdir(), 'prune-empty-'));
    assert.deepEqual(await pruneForeignBinaries(empty, 'win32', 'x64'), []);
  });
});
