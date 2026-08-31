import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveE2EWindowMode } from '../../src/main/e2e-window-visibility.js';
import { tmpRegistryEnvVar } from './support/tmp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Build the app exactly once, before any worker starts (image-trail's pattern:
// `npm run build` begins by removing dist/, so concurrent per-worker builds would
// clobber each other's output). The smoke lane doesn't consume dist/ yet, but the
// E2E lane failing on a broken build is part of the gate's job.
export default function globalSetup(): void {
  process.env['OVERLOOK_E2E'] = '1';
  process.env['OVERLOOK_E2E_WINDOW'] = resolveE2EWindowMode(process.platform, process.env['OVERLOOK_E2E_VISIBLE']);

  // Worker processes inherit process.env as set here (same mechanism as
  // OVERLOOK_E2E/OVERLOOK_E2E_WINDOW above), so every worker's mkE2eTmpDir calls
  // land in one file that global-teardown.ts sweeps after the whole run finishes.
  const registryPath = path.join(tmpdir(), `overlook-e2e-tmp-registry-${process.pid}.txt`);
  writeFileSync(registryPath, '', 'utf8');
  process.env[tmpRegistryEnvVar] = registryPath;

  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run build'] : ['run', 'build'];
  execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit', env: process.env });
}
