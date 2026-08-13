import { defineConfig } from '@playwright/test';

const isCi = Boolean(process.env['CI']);

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || (name === 'OVERLOOK_E2E_WORKERS' && value === 0)) {
    throw new Error(`${name} must be ${name === 'OVERLOOK_E2E_WORKERS' ? 'a positive' : 'a non-negative'} integer`);
  }
  return value;
}

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  // Files are the unit of parallelism: fullyParallel stays false so tests within a
  // spec run serially, but distinct spec files run concurrently across workers.
  // Each test launches its own Electron instance from the out/ bundle built once
  // in global-setup, so specs stay hermetic.
  fullyParallel: false,
  // exactOptionalPropertyTypes forbids an explicit `workers: undefined`, so spread
  // the CI-only override instead of image-trail's ternary.
  ...(isCi ? { workers: positiveInteger('OVERLOOK_E2E_WORKERS', 1) } : {}),
  // Required CI runs use the measured one-worker, zero-retry baseline from the
  // E2E timing audit. A diagnostic workflow dispatch may opt into retries
  // explicitly, but required and local runs stop on the first failure.
  retries: isCi ? positiveInteger('OVERLOOK_E2E_RETRIES', 0) : 0,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  // 'github' turns failures into file/line-anchored annotations in the run summary UI; without it
  // a red E2E step shows only a blank "Error:". 'list' keeps the readable log, 'html' the artifact.
  reporter: isCi ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
