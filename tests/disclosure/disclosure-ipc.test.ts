import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { registerDisclosureHandlersWith } from '../../src/main/disclosure/disclosure-ipc.js';
import type { DisclosureService } from '../../src/main/disclosure/disclosure-service.js';
import { DEFAULT_DISCLOSURE_POLICY, PINNED_PRIVATE } from '../../src/shared/disclosure/policy.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { fakeRegistrar, INVALID_REQUEST, withQuietConsole } from '../ipc/fake-registrar.js';

// #509 / ADR-0032 §6: the renderer sends intent only; every channel admits
// through the app-lock gate before the service sees it.

describe('disclosure IPC adapters (#509)', () => {
  test('admits every channel and forwards field, scope, and preview intent to the service', async () => {
    const { registrar, invoke, channels: registered } = fakeRegistrar();
    let admitted = 0;
    const calls: unknown[][] = [];
    const overrides = [{ field: 'location', class: 'shared', widened: true }];
    const preview = {
      boundary: 'export',
      destination: 'public',
      policyVersion: 3,
      photos: 2,
      fields: [{ field: 'camera', class: 'shared', disclosed: 2, withheld: 0, present: 2, sample: 'Leica M11', widened: false }],
      embedded: ['camera'],
      blocked: [],
      retainedSidecars: 0,
    };
    const service = {
      policy: () => DEFAULT_DISCLOSURE_POLICY,
      pinned: () => PINNED_PRIVATE,
      setField: (...args: unknown[]) => {
        calls.push(['setField', ...args]);
        return DEFAULT_DISCLOSURE_POLICY;
      },
      overrides: (...args: unknown[]) => {
        calls.push(['overrides', ...args]);
        return overrides;
      },
      setOverride: (...args: unknown[]) => {
        calls.push(['setOverride', ...args]);
        return overrides;
      },
      preview: (...args: unknown[]) => {
        calls.push(['preview', ...args]);
        return preview;
      },
    } as unknown as DisclosureService;
    registerDisclosureHandlersWith(
      () => service,
      () => {
        admitted += 1;
      },
      registrar,
    );
    assert.deepEqual(
      [...registered()].sort(),
      [
        channels.disclosureOverrides.name,
        channels.disclosurePolicy.name,
        channels.disclosurePreview.name,
        channels.disclosureSetField.name,
        channels.disclosureSetOverride.name,
      ].sort(),
    );

    assert.deepEqual(await invoke(channels.disclosurePolicy.name, {}), {
      policy: DEFAULT_DISCLOSURE_POLICY,
      pinned: [...PINNED_PRIVATE],
    });
    assert.deepEqual(await invoke(channels.disclosureSetField.name, { field: 'camera', class: 'public' }), {
      policy: DEFAULT_DISCLOSURE_POLICY,
    });
    assert.deepEqual(await invoke(channels.disclosureOverrides.name, { scope: 'photo', id: 'P1' }), { overrides });
    assert.deepEqual(await invoke(channels.disclosureSetOverride.name, { scope: 'collection', id: 'A1', field: 'location', class: null }), {
      overrides,
    });
    const previewRequest = { boundary: 'export', destination: 'public', photoIds: ['P1', 'P2'], payload: 'original' };
    assert.deepEqual(await invoke(channels.disclosurePreview.name, previewRequest), preview);
    assert.deepEqual(calls, [
      ['setField', 'camera', 'public'],
      ['overrides', 'photo', 'P1'],
      ['setOverride', 'collection', 'A1', 'location', null],
      ['preview', previewRequest],
    ]);
    assert.equal(admitted, 5);
  });

  test('rejects a request outside the schema before admitting it and logs main-side only', async () => {
    const { registrar, invoke } = fakeRegistrar();
    let admitted = 0;
    registerDisclosureHandlersWith(
      () => ({}) as DisclosureService,
      () => {
        admitted += 1;
      },
      registrar,
    );
    const logged = await withQuietConsole(async () => {
      assert.deepEqual(await invoke(channels.disclosureSetField.name, { field: 'fileName', class: 'public' }), INVALID_REQUEST);
      assert.deepEqual(
        await invoke(channels.disclosurePreview.name, { boundary: 'export', destination: 'public', fields: ['camera'] }),
        INVALID_REQUEST,
      );
    });
    assert.equal(admitted, 0);
    assert.equal(logged.length, 2);
    assert.match(logged[0] ?? '', /IPC_INVALID_REQUEST on disclosure:set-field/);
  });
});
