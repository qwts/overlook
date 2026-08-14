#!/usr/bin/env node

// Runs every named npm test lane to completion, then fails once at the end if any lane failed.
//
// `test:run` used to be `test:unit:run && test:dom:run && test:guard:conformance`, so the first red
// lane took the rest of the suite with it. Under `test:cov` that is worse than a lost signal: the
// DOM lane is what covers the renderer files admitted to `.c8rc.json`, so a skipped DOM lane
// reported them at 0% and dragged the global line total under the floor. PR #995 read that as a
// coverage regression and spent ten runs chasing the number while three real DOM-test failures sat
// in the lane that never ran.
//
// So: one red lane must never hide another, and must never move the coverage numbers. Lanes still
// run one at a time — concurrent lanes would multiply peak RSS against the machine-wide budget the
// guard leases from — and the process still exits non-zero when any lane failed, which is the
// signal CI's `Test` step reads.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// This runner dispatches the lanes itself instead of re-entering `npm run <lane>`, which would keep
// a second npm resident alongside every lane. The guard leases one RSS ceiling for the whole process
// group and `npm test` already peaks within a couple of percent of it here, so the redundant hop is
// not free: reading the script line costs one process fewer per lane than the `&&` chain did. All
// npm contributes to these lanes is a shell and `node_modules/.bin` on PATH.
export function laneCommand(scripts, lane) {
  const command = scripts[lane];
  if (typeof command !== 'string' || command.trim() === '') throw new Error(`package.json defines no "${lane}" script`);
  return command;
}

function packageScripts() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
}

export function spawnLane(lane, scripts = packageScripts()) {
  return new Promise((resolve) => {
    let command;
    try {
      command = laneCommand(scripts, lane);
    } catch (error) {
      // An unknown lane is a failed lane, not a crashed runner: the lanes after it still owe a result.
      process.stderr.write(`[lanes] ${lane}: ${error.message}\n`);
      resolve({ code: 1, signal: null });
      return;
    }
    process.stdout.write(`\n[lanes] ▶ ${lane}: ${command}\n`);
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      cwd: root,
      env: { ...process.env, PATH: `${join(root, 'node_modules/.bin')}${delimiter}${process.env['PATH'] ?? ''}` },
    });
    // 'error' and 'close' can both fire; the first settle wins.
    child.on('error', (error) => {
      process.stderr.write(`[lanes] ${lane} failed to start: ${error.message}\n`);
      resolve({ code: 1, signal: null });
    });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

export async function runLanes(lanes, runLane) {
  const results = [];
  let terminated = false;
  for (const lane of lanes) {
    if (terminated) {
      results.push({ lane, status: 'skipped' });
      continue;
    }
    const startedAt = Date.now();
    const { code, signal } = await runLane(lane);
    const durationMs = Date.now() - startedAt;
    if (signal !== null && signal !== undefined) {
      // A signal is someone else ending this run — the guard's rss-limit kill, a step timeout, or
      // Ctrl-C. Starting the next lane would fight that teardown, so report and stop.
      results.push({ lane, status: 'failed', signal, durationMs });
      terminated = true;
      continue;
    }
    results.push({ lane, status: code === 0 ? 'passed' : 'failed', code, durationMs });
  }
  return results;
}

const LABEL = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP' };

function detail(result) {
  const seconds = `${((result.durationMs ?? 0) / 1000).toFixed(1)}s`;
  if (result.status === 'skipped') return 'not run — an earlier lane was terminated';
  if (result.signal !== null && result.signal !== undefined) return `terminated by ${result.signal} after ${seconds}`;
  return `exit ${result.code} in ${seconds}`;
}

export function summary(results) {
  const lines = ['', '[lanes] Test lane summary:'];
  for (const result of results) lines.push(`  ${LABEL[result.status]}  ${result.lane} — ${detail(result)}`);
  const failed = results.filter((result) => result.status !== 'passed').map((result) => result.lane);
  lines.push(failed.length === 0 ? `[lanes] All ${results.length} lane(s) passed.` : `[lanes] Failing lane(s): ${failed.join(', ')}`);
  return lines.join('\n');
}

export function exitCode(results) {
  return results.every((result) => result.status === 'passed') ? 0 : 1;
}

async function main() {
  const lanes = process.argv.slice(2);
  if (lanes.length === 0) {
    process.stderr.write('usage: run-test-lanes.mjs <npm-script> [npm-script...]\n');
    process.exit(2);
  }
  // Read package.json once, so a missing or malformed one fails here rather than per lane.
  const scripts = packageScripts();
  const results = await runLanes(lanes, (lane) => spawnLane(lane, scripts));
  process.stdout.write(`${summary(results)}\n`);
  process.exit(exitCode(results));
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
