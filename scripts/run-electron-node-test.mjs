#!/usr/bin/env node

import { spawn } from 'node:child_process';
import electron from 'electron';
import { pathToFileURL } from 'node:url';

export function electronTestEnvironment(environment = process.env) {
  return { ...environment, ELECTRON_RUN_AS_NODE: '1' };
}

export function runElectronNodeTest(patterns, spawnProcess = spawn) {
  if (patterns.length === 0) throw new Error('usage: run-electron-node-test.mjs <test-pattern> [test-pattern...]');
  return new Promise((resolve, reject) => {
    const child = spawnProcess(electron, ['--test', ...patterns], {
      stdio: 'inherit',
      env: electronTestEnvironment(),
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const result = await runElectronNodeTest(process.argv.slice(2));
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
