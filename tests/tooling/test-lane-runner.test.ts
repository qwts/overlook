import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

interface LaneOutcome {
  readonly code: number | null;
  readonly signal?: string | null;
}

interface LaneResult {
  readonly lane: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly code?: number | null;
  readonly signal?: string | null;
  readonly durationMs?: number;
}

interface LaneRunnerModule {
  readonly runLanes: (lanes: readonly string[], runLane: (lane: string) => Promise<LaneOutcome>) => Promise<LaneResult[]>;
  readonly laneCommand: (scripts: Readonly<Record<string, string>>, lane: string) => string;
  readonly spawnLane: (lane: string, scripts: Readonly<Record<string, string>>) => Promise<LaneOutcome>;
  readonly summary: (results: readonly LaneResult[]) => string;
  readonly exitCode: (results: readonly LaneResult[]) => number;
}

const root = process.cwd();

const { runLanes, laneCommand, spawnLane, summary, exitCode } = (await import(
  pathToFileURL(join(root, 'scripts/run-test-lanes.mjs')).href
)) as LaneRunnerModule;

function outcomes(byLane: Readonly<Record<string, LaneOutcome>>): { run: (lane: string) => Promise<LaneOutcome>; ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    run: (lane) => {
      ran.push(lane);
      return Promise.resolve(byLane[lane] ?? { code: 0, signal: null });
    },
  };
}

// PR #995: `test:run` was `unit && dom && guard`, so one broken unit test skipped the DOM lane —
// which is what covers the renderer files admitted to `.c8rc.json`. Every run then reported both a
// failing test AND a coverage-floor breach, and ten fix attempts chased the coverage number while
// three real DOM regressions sat unreported in the lane that never ran.
describe('test lane runner (PR #995)', () => {
  it('runs every lane even after one fails, and reports the failure', async () => {
    const { run, ran } = outcomes({ 'test:unit:run': { code: 1, signal: null } });
    const results = await runLanes(['test:unit:run', 'test:dom:run', 'test:guard:conformance'], run);

    assert.deepEqual(ran, ['test:unit:run', 'test:dom:run', 'test:guard:conformance']);
    assert.deepEqual(
      results.map((result) => [result.lane, result.status]),
      [
        ['test:unit:run', 'failed'],
        ['test:dom:run', 'passed'],
        ['test:guard:conformance', 'passed'],
      ],
    );
    assert.equal(exitCode(results), 1);
  });

  it('names every failing lane, not just the first', async () => {
    const { run } = outcomes({ 'test:unit:run': { code: 1, signal: null }, 'test:guard:conformance': { code: 7, signal: null } });
    const results = await runLanes(['test:unit:run', 'test:dom:run', 'test:guard:conformance'], run);

    assert.match(summary(results), /Failing lane\(s\): test:unit:run, test:guard:conformance/u);
    assert.equal(exitCode(results), 1);
  });

  it('exits zero only when every lane passed', async () => {
    const { run } = outcomes({});
    const results = await runLanes(['test:unit:run', 'test:dom:run'], run);

    assert.equal(exitCode(results), 0);
    assert.match(summary(results), /All 2 lane\(s\) passed\./u);
  });

  // A signal is the guard's rss-limit kill, a step timeout, or Ctrl-C — someone else ending the
  // run. Starting the next lane would fight that teardown, so the remaining lanes are reported as
  // not-run rather than silently omitted, and the run still fails.
  it('stops after a signal-terminated lane and marks the rest as not run', async () => {
    const { run, ran } = outcomes({ 'test:unit:run': { code: null, signal: 'SIGKILL' } });
    const results = await runLanes(['test:unit:run', 'test:dom:run', 'test:guard:conformance'], run);

    assert.deepEqual(ran, ['test:unit:run']);
    assert.deepEqual(
      results.map((result) => result.status),
      ['failed', 'skipped', 'skipped'],
    );
    assert.match(summary(results), /terminated by SIGKILL/u);
    assert.match(summary(results), /SKIP {2}test:dom:run/u);
    assert.equal(exitCode(results), 1);
  });

  // The runner dispatches the lane's own command rather than re-entering `npm run <lane>`, which
  // would hold a second npm resident beside every lane inside the guard's one group-wide RSS lease.
  it('reads each lane command straight from package.json', () => {
    const scripts =
      (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { readonly scripts?: Record<string, string> }).scripts ?? {};

    assert.equal(laneCommand(scripts, 'test:dom:run'), scripts['test:dom:run']);
    assert.throws(() => laneCommand(scripts, 'test:nope'), /defines no "test:nope" script/u);
  });

  it('reports an unknown lane as a failed lane, not a crashed runner', async () => {
    assert.deepEqual(await spawnLane('test:nope', {}), { code: 1, signal: null });
  });

  it('keeps the three lanes wired into test:run through this runner', () => {
    const scripts =
      (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { readonly scripts?: Record<string, string> }).scripts ?? {};
    const testRun = scripts['test:run'] ?? '';

    assert.match(testRun, /scripts\/run-test-lanes\.mjs/u, 'test:run must aggregate lanes, not chain them with &&');
    assert.doesNotMatch(testRun, /&&/u, '&& lets one red lane skip the lanes after it (PR #995)');
    for (const lane of ['test:unit:run', 'test:dom:run', 'test:guard:conformance']) {
      assert.ok(testRun.split(' ').includes(lane), `${lane} must stay in test:run`);
    }
  });
});
