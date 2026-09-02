import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { registerCoverageHandlersWith } from '../../src/main/backup/coverage-ipc.js';
import type { CoverageService } from '../../src/main/backup/coverage-service.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { fakeRegistrar, INVALID_REQUEST, withQuietConsole } from '../ipc/fake-registrar.js';

// #506 / ADR-0033 §7: preflight is read-only; exclude and include mutate
// custody and count as provider work for as long as they run.

describe('backup coverage IPC adapters (#506)', () => {
  test('admits every channel and runs the mutations inside the provider-work window', async () => {
    const { registrar, invoke, channels: registered } = fakeRegistrar();
    let admitted = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    const calls: unknown[][] = [];
    const preflight = {
      tier: 'irreversible',
      eligible: 1,
      ineligible: 0,
      bytes: 10,
      remoteCopies: 1,
      remoteBytes: 10,
      downloads: 0,
      sharedRetained: 0,
      provider: 'pCloud',
      account: 'me@example.com',
      items: [{ photoId: 'P1', bytes: 10, eligible: true, reason: null, remoteCopy: true, download: false, sharedRetained: false }],
    };
    const service = {
      preflight: (...args: unknown[]) => {
        calls.push(['preflight', ...args]);
        return preflight;
      },
      exclude: (...args: unknown[]) => {
        calls.push(['exclude', inFlight, ...args]);
        return Promise.resolve({
          excluded: 1,
          removalPending: 0,
          skipped: 0,
          failed: 0,
          results: [{ photoId: 'P1', outcome: 'excluded', reason: null }],
        });
      },
      include: (...args: unknown[]) => {
        calls.push(['include', inFlight, ...args]);
        return Promise.resolve({ included: 1, skipped: 0, failed: 0, results: [{ photoId: 'P1', outcome: 'included', reason: null }] });
      },
    } as unknown as CoverageService;
    registerCoverageHandlersWith(
      () => service,
      () => {
        admitted += 1;
      },
      registrar,
      async (operation) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        try {
          return await operation();
        } finally {
          inFlight -= 1;
        }
      },
    );
    assert.deepEqual(
      [...registered()].sort(),
      [channels.coverageExclude.name, channels.coverageInclude.name, channels.coveragePreflight.name].sort(),
    );

    assert.deepEqual(await invoke(channels.coveragePreflight.name, { photoIds: ['P1'] }), preflight);
    const excluded = (await invoke(channels.coverageExclude.name, { photoIds: ['P1'], authorization: 'REMOVE 1 CLOUD COPY' })) as {
      excluded: number;
    };
    assert.equal(excluded.excluded, 1);
    const included = (await invoke(channels.coverageInclude.name, { photoIds: ['P1'] })) as { included: number };
    assert.equal(included.included, 1);
    assert.deepEqual(calls, [
      ['preflight', ['P1']],
      ['exclude', 1, ['P1'], 'REMOVE 1 CLOUD COPY'],
      ['include', 1, ['P1']],
    ]);
    assert.equal(peakInFlight, 1);
    assert.equal(inFlight, 0);
    assert.equal(admitted, 3);
  });

  test('refuses an empty selection before admitting', async () => {
    const { registrar, invoke } = fakeRegistrar();
    let admitted = 0;
    registerCoverageHandlersWith(
      () => ({}) as CoverageService,
      () => {
        admitted += 1;
      },
      registrar,
      (operation) => operation(),
    );
    const logged = await withQuietConsole(async () => {
      assert.deepEqual(await invoke(channels.coveragePreflight.name, { photoIds: [] }), INVALID_REQUEST);
    });
    assert.equal(admitted, 0);
    assert.match(logged[0] ?? '', /IPC_INVALID_REQUEST on coverage:preflight/);
  });
});
