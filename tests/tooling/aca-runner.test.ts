import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { runAca } from '../../scripts/run-aca.js';

const report = { check: 'doc-drift', provider: 'test', model: 'test', verdicts: [{ file: 'é.ts', verdict: 'fail' }] };
const posix = process.platform === 'win32' ? 'ACA execution uses POSIX process groups on its Ubuntu runner' : false;

async function fixture(source: string, timeoutMs = 2_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), 'overlook-aca-'));
  const cliPath = join(root, 'judge.mjs');
  await writeFile(cliPath, source);
  let stdout = '';
  let stderr = '';
  try {
    const code = await runAca({
      check: 'doc-drift',
      cliPath,
      timeoutMs,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, stdout, stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('ACA execution boundary', { skip: posix }, () => {
  test('publishes a complete advisory failure without turning it into an execution failure', async () => {
    const result = await fixture(`process.stdout.write(${JSON.stringify(JSON.stringify(report))});`);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), report);
  });

  test('accepts a complete empty report when no files apply', async () => {
    const empty = { ...report, verdicts: [] };
    const result = await fixture(`process.stdout.write(${JSON.stringify(JSON.stringify(empty))});`);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), empty);
  });

  test('rejects absent, malformed, wrong-check, and unavailable judgments even after exit zero', async () => {
    for (const output of ['', '{', '{}', JSON.stringify({ ...report, check: 'other' })]) {
      const result = await fixture(`process.stderr.write('judge unavailable'); process.stdout.write(${JSON.stringify(output)});`);
      assert.equal(result.code, 78);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /unavailable or incomplete judgment/);
    }
    const failed = await fixture(`process.stdout.write(${JSON.stringify(JSON.stringify(report))}); process.exitCode = 78;`);
    assert.equal(failed.code, 78);
    assert.equal(failed.stdout, '');
  });

  for (const transient of [false, true]) {
    test(`terminates ${transient ? 'repeated transient failures' : 'a never-responding provider'} within one total budget`, async () => {
      let requests = 0;
      const server = createServer((_request, response) => {
        requests += 1;
        if (transient) {
          response.writeHead(503);
          response.end('retry');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const started = performance.now();
      try {
        const result = await fixture(
          `
          process.stderr.write('pid=' + process.pid + '\\n');
          process.stdout.write('{"partial":');
          process.on('SIGTERM', () => {});
          while (true) {
            await fetch('http://127.0.0.1:${String(address.port)}');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        `,
          800,
        );
        assert.equal(result.code, 124);
        assert.equal(result.stdout, '', 'partial findings must not be published');
        assert.match(result.stderr, /execution timed out/);
        assert.ok(requests >= (transient ? 2 : 1), 'provider request must actually start');
        assert.ok(performance.now() - started < 3_000, 'retries must not reset the total deadline');
        const pid = Number(/pid=(\d+)/.exec(result.stderr)?.[1]);
        assert.ok(Number.isInteger(pid) && pid > 0);
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    });
  }
});
