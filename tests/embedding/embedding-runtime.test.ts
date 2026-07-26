import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { executionProviders } from '../../src/main/embedding/embedding-runtime.js';

describe('embedding execution-provider fallback', () => {
  test('probes each native accelerator before the required CPU floor', () => {
    assert.deepEqual(executionProviders('darwin'), ['coreml', 'cpu']);
    assert.deepEqual(executionProviders('win32'), ['dml', 'cpu']);
    assert.deepEqual(executionProviders('linux'), ['cpu']);
  });

  test('main-process worker URLs stay colocated with explicit build entries', () => {
    const source = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');
    const config = source('electron.vite.config.ts');
    assert.match(config, /'thumbnail-worker': 'src\/main\/import\/thumbnail-worker\.ts'/u);
    assert.match(config, /'embedding-worker': 'src\/main\/embedding\/embedding-worker\.ts'/u);
    assert.match(source('src/main/import/import-application-runtime.ts'), /new URL\('\.\/thumbnail-worker\.js', import\.meta\.url\)/u);
    assert.match(
      source('src/main/embedding/embedding-application-runtime.ts'),
      /new URL\('\.\/embedding-worker\.js', import\.meta\.url\)/u,
    );
  });
});
