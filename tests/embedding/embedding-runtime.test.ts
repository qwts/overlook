import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { executionProviders } from '../../src/main/embedding/embedding-runtime.js';

const source = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');

describe('embedding execution-provider fallback', () => {
  test('probes each native accelerator before the required CPU floor', () => {
    assert.deepEqual(executionProviders('darwin'), ['coreml', 'cpu']);
    assert.deepEqual(executionProviders('win32'), ['dml', 'cpu']);
    assert.deepEqual(executionProviders('linux'), ['cpu']);
  });

  test('main-process worker URLs stay colocated with explicit build entries', () => {
    const config = source('electron.vite.config.ts');
    assert.match(config, /'thumbnail-worker': 'src\/main\/import\/thumbnail-worker\.ts'/u);
    assert.match(config, /'embedding-worker': 'src\/main\/embedding\/embedding-worker\.ts'/u);
    assert.match(source('src/main/import/import-application-runtime.ts'), /new URL\('\.\/thumbnail-worker\.js', import\.meta\.url\)/u);
    assert.match(
      source('src/main/embedding/embedding-application-runtime.ts'),
      /new URL\('\.\/embedding-worker\.js', import\.meta\.url\)/u,
    );
  });

  test('the worker wipes a zero-copy view of transferred image bytes', () => {
    const worker = source('src/main/embedding/embedding-worker.ts');
    assert.match(worker, /Buffer\.from\(request\.bytes\.buffer, request\.bytes\.byteOffset, request\.bytes\.byteLength\)/u);
    assert.doesNotMatch(worker, /Buffer\.from\(request\.bytes\)/u);
    assert.match(worker, /\.finally\(\(\) => bytes\.fill\(0\)\)/u);
  });

  test('packaging unpacks shared libraries only for the embedding native runtimes', () => {
    const builder = source('electron-builder.yml');
    assert.match(builder, /- '\*\*\/\*\.node'/u);
    assert.match(builder, /- 'node_modules\/onnxruntime-node\/\*\*\/\*\.\{dylib,so,dll\}'/u);
    assert.match(builder, /- 'node_modules\/sqlite-vec\*\/\*\*\/\*\.\{dylib,so,dll\}'/u);
    assert.doesNotMatch(builder, /- '\*\*\/\*\.(?:dylib|so|dll)'/u);
  });

  test('ordinary restoration and derivative repair reactivate deferred candidates', () => {
    const index = source('src/main/index.ts');
    const maintenance = source('src/main/import/maintenance-runtime.ts');
    assert.match(
      index,
      /libraryChanged: \(photoIds, membership\) => \{\s+emitLibraryChanged\(\{ photoIds: \[\.\.\.photoIds\], \.\.\.\(membership === undefined \? \{\} : \{ membership \}\) \}\);\s+notifyEmbeddingEligibilityChanged\(photoIds\);/u,
    );
    assert.match(
      index,
      /ordinaryChanged: \(photoIds\) => \{\s+emitLibraryChanged\(\{ photoIds: \[\.\.\.photoIds\] \}\);\s+notifyEmbeddingEligibilityChanged\(photoIds\);/u,
    );
    assert.equal(maintenance.match(/ctx\.embeddingEligible\(ids\)/gu)?.length, 2);
  });
});
