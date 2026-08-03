import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { DeterministicICloudDriveBridge } from '../../src/main/backup/icloud-drive/deterministic-bridge.js';
import { ICloudDriveNativeError, type ICloudDriveNativeListPage } from '../../src/main/backup/icloud-drive/native-bridge.js';
import {
  ICLOUD_LIVE_CONTRACT_ARGUMENT,
  ICLOUD_LIVE_CONTRACT_MARKER,
  runICloudLiveContractIfRequested,
} from '../../src/main/backup/icloud-drive/live-contract.js';

describe('signed packaged iCloud live contract (#659)', () => {
  test('the owner-only entrypoint is guarded and validates provisioned identity', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly scripts?: Record<string, string> };
    const command = packageJson.scripts?.['test:icloud:live'] ?? '';
    assert.match(command, /tools\/agent-guard\/run-guarded\.mjs/u);
    assert.match(command, /verify-macos-icloud-live-contract\.mjs/u);
    const verifier = readFileSync('scripts/verify-macos-icloud-live-contract.mjs', 'utf8');
    assert.match(verifier, /verify-macos-provisioned-app\.mjs/u);
    assert.match(verifier, /icloud-live-contract-evidence\.json/u);
    assert.doesNotMatch(verifier, /accountToken/u);
  });

  test('does not intercept normal launches', async () => {
    const exits: number[] = [];
    assert.equal(
      await runICloudLiveContractIfRequested(
        { isPackaged: true, exit: (code) => exits.push(code) },
        { argv: ['Overlook'], bridge: new DeterministicICloudDriveBridge() },
      ),
      false,
    );
    assert.deepEqual(exits, []);
  });

  test('runs shared object, restore, and fresh-profile contracts with complete cleanup', async () => {
    const exits: number[] = [];
    const output: string[] = [];
    const bridge = new DeterministicICloudDriveBridge();
    assert.equal(
      await runICloudLiveContractIfRequested(
        { isPackaged: true, exit: (code) => exits.push(code) },
        {
          argv: ['Overlook', ICLOUD_LIVE_CONTRACT_ARGUMENT],
          bridge,
          write: (value) => output.push(value),
        },
      ),
      true,
    );
    assert.deepEqual(exits, [0]);
    const evidence = JSON.parse(output.join('').slice(ICLOUD_LIVE_CONTRACT_MARKER.length)) as {
      readonly result: string;
      readonly cleanup: boolean;
      readonly checks: readonly string[];
    };
    assert.equal(evidence.result, 'pass');
    assert.equal(evidence.cleanup, true);
    assert.deepEqual(evidence.checks, [
      'object',
      'replacement-pagination-materialization-sha256',
      'restore-provider',
      'fresh-profile-disaster-recovery',
    ]);
    assert.equal(bridge.objects.size, 0);
    assert.ok(
      bridge.calls.some((call) => call.endsWith(':1')),
      'live contract forces native cursor pagination',
    );
  });

  test('refuses an unpackaged executable before touching iCloud', async () => {
    const exits: number[] = [];
    const output: string[] = [];
    const bridge = new DeterministicICloudDriveBridge();
    await runICloudLiveContractIfRequested(
      { isPackaged: false, exit: (code) => exits.push(code) },
      { argv: ['Overlook', ICLOUD_LIVE_CONTRACT_ARGUMENT], bridge, write: (value) => output.push(value) },
    );
    assert.deepEqual(exits, [1]);
    assert.match(output.join(''), /signed packaged app required/u);
    assert.equal(bridge.calls.length, 0);
  });

  test('checks scratch cleanup without a final global rediscovery of unrelated recovery homes', async () => {
    const exits: number[] = [];
    const output: string[] = [];
    class CleanupSensitiveBridge extends DeterministicICloudDriveBridge {
      private globalDiscoveries = 0;

      override list(path: string, cursor: string | null, limit: number, accountToken: string): Promise<ICloudDriveNativeListPage> {
        if (path === 'Overlook' && cursor === null && (this.globalDiscoveries += 1) > 5) {
          throw new ICloudDriveNativeError('materialization-delayed');
        }
        return super.list(path, cursor, limit, accountToken);
      }
    }
    const bridge = new CleanupSensitiveBridge();

    await runICloudLiveContractIfRequested(
      { isPackaged: true, exit: (code) => exits.push(code) },
      { argv: ['Overlook', ICLOUD_LIVE_CONTRACT_ARGUMENT], bridge, write: (value) => output.push(value) },
    );

    const evidence = JSON.parse(output.join('').slice(ICLOUD_LIVE_CONTRACT_MARKER.length)) as {
      readonly result: string;
      readonly cleanup: boolean;
    };
    assert.deepEqual(exits, [0]);
    assert.equal(evidence.result, 'pass');
    assert.equal(evidence.cleanup, true);
    assert.equal(bridge.objects.size, 0);
  });
});
