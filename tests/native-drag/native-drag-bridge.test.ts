import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createNativeDragBridge } from '../../src/main/native-drag/native-drag-bridge.js';

describe('native macOS file-promise bridge (#796)', () => {
  test('uses signed NSFilePromiseProvider custody and keeps internal drag data on the pasteboard', () => {
    const source = readFileSync(join(process.cwd(), 'native/touch-id/native_drag.mm'), 'utf8');
    for (const contract of [
      'NSFilePromiseProvider',
      'writePromiseToURL',
      'beginDraggingSessionWithItems',
      'NSDragOperationCopy',
      'SecCodeCheckValidity',
      'kSecCodeSignatureAdhoc',
      'overlookInternalType',
      'napi_add_env_cleanup_hook',
    ]) {
      assert.ok(source.includes(contract), `native bridge must enforce ${contract}`);
    }
    assert.doesNotMatch(source, /NSTemporaryDirectory|mkdtemp|temporaryDirectory/u);
    assert.doesNotMatch(source, /URLByAppendingPathComponent:self\.fileName/u, 'AppKit already supplies the complete destination URL');
    assert.match(source, /CallRequest\(callbacks_, requestId, self\.token, url\.path\)/u);
    assert.match(readFileSync(join(process.cwd(), 'native/touch-id/drag.cjs'), 'utf8'), /drag\.node\.napi/u);
  });

  test('does not load on unsupported or unpackaged processes and fails malformed bindings closed', () => {
    let loads = 0;
    const loadBinding = () => {
      loads += 1;
      return {};
    };
    assert.deepEqual(createNativeDragBridge({ platform: 'win32', packaged: true, loadBinding }).status(), {
      available: false,
      reason: 'unsupported-platform',
    });
    assert.deepEqual(createNativeDragBridge({ platform: 'darwin', packaged: false, loadBinding }).status(), {
      available: false,
      reason: 'unsigned-build',
    });
    assert.equal(loads, 0);
    assert.deepEqual(createNativeDragBridge({ platform: 'darwin', packaged: true, loadBinding }).status(), {
      available: false,
      reason: 'native-unavailable',
    });
  });

  test('completes receiver promises only after the bounded materializer settles', async () => {
    const completions: Array<readonly [string, string | null]> = [];
    let request: ((requestId: string, token: string, destinationPath: string) => void) | undefined;
    const binding = {
      status: () => true,
      startDrag: (
        _bundle: string,
        _handle: Buffer,
        _items: unknown,
        _type: string,
        _payload: string,
        onRequest: (requestId: string, token: string, destinationPath: string) => void,
      ) => {
        request = onRequest;
        return true;
      },
      complete: (requestId: string, error: string | null) => completions.push([requestId, error]),
      cancelAll: () => undefined,
    };
    const bridge = createNativeDragBridge({ platform: 'darwin', packaged: true, loadBinding: () => binding });
    let materialized = '';
    assert.equal(
      bridge.start({
        windowHandle: Buffer.alloc(8),
        items: [{ token: 'token', fileName: 'IMG.JPG', fileType: 'public.jpeg' }],
        internalPayload: '{}',
        materialize: ({ destinationPath }) => {
          materialized = destinationPath;
          return Promise.resolve();
        },
        ended: () => undefined,
      }),
      true,
    );
    request?.('request', 'token', '/receiver/IMG.JPG');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(materialized, '/receiver/IMG.JPG');
    assert.deepEqual(completions, [['request', null]]);
  });
});
