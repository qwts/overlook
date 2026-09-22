import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const job = workflow.split('  dml-arm64-qualification:\n')[1]?.split('\n  windows-main-smoke:')[0];
assert.ok(job);
const condition = job.match(/ {4}if: >-\n([\s\S]*?)\n {4}runs-on:/u)?.[1]?.trim();
assert.ok(condition);

for (const event of ['pull_request', 'push', 'merge_group', 'workflow_dispatch']) {
  for (const requested of [false, true]) {
    for (const authorized of [false, true]) {
      test(`DML runner selection: ${event}, requested=${String(requested)}, authorized=${String(authorized)}`, () => {
        const selected: unknown = runInNewContext(condition, {
          github: { event_name: event },
          inputs: { qualify_dml_arm64: requested },
          needs: { policy: { result: authorized ? 'success' : 'failure', outputs: { run_full: authorized ? 'true' : 'false' } } },
        });
        assert.equal(selected, event === 'workflow_dispatch' && requested && authorized);
      });
    }
  }
}

test('DML hardware qualification defaults off and retains native strict controls', () => {
  assert.match(workflow, /qualify_dml_arm64:[\s\S]*?type: boolean\n {8}default: false/u);
  assert.match(job, /needs: policy/u);
  assert.match(job, /runs-on: \[self-hosted, Windows, ARM64\]/u);
  assert.match(job, /persist-credentials: false/u);
  assert.match(job, /architecture: arm64/u);
  assert.match(job, /node scripts\/assert-platform\.mjs win32 arm64/u);
  assert.match(job, /run: npm run test:embedding-native:inner/u);
  const tests = readFileSync('tests/embedding/native-worker.test.ts', 'utf8');
  assert.match(tests, /CPU rejection with fallback disabled/u);
  assert.match(tests, /CPU fallback cannot qualify a platform accelerator/u);
});
