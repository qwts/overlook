import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  createBoundedExternalDropReporter,
  installExternalFileDropBoundary,
  type ExternalDropDiagnostic,
  type ExternalFileDropBoundary,
} from '../../src/renderer/src/shell/external-file-drop.js';

import { ALBUM_REORDER_DRAG_TYPE } from '../../src/shared/library/album-reorder-drag.js';
import { PHOTO_DRAG_TYPE } from '../../src/shared/library/photo-drag.js';

const boundaries: ExternalFileDropBoundary[] = [];

afterEach(() => {
  for (const boundary of boundaries.splice(0)) boundary.dispose();
  document.body.replaceChildren();
});

function dataTransfer(files: readonly File[], types: readonly string[]): DataTransfer {
  return {
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    types,
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

function dispatchDrag(type: string, target: EventTarget, transfer: DataTransfer): DragEvent {
  const event = new DragEvent(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  target.dispatchEvent(event);
  return event;
}

function install(overrides: Partial<Parameters<typeof installExternalFileDropBoundary>[1]> = {}): {
  readonly states: boolean[];
  readonly paths: (readonly string[])[];
  readonly diagnostics: ExternalDropDiagnostic[];
  readonly unsupported: { count: number };
} {
  const states: boolean[] = [];
  const paths: (readonly string[])[] = [];
  const diagnostics: ExternalDropDiagnostic[] = [];
  const unsupported = { count: 0 };
  boundaries.push(
    installExternalFileDropBoundary(window, {
      pathForFile: () => '',
      onDraggingChange: (dragging) => states.push(dragging),
      onPaths: (dropped) => paths.push(dropped),
      onUnsupported: () => (unsupported.count += 1),
      report: createBoundedExternalDropReporter((entry) => diagnostics.push(entry)),
      ...overrides,
    }),
  );
  return { states, paths, diagnostics, unsupported };
}

test('alternate Finder file types are captured, deduplicated, and reported without private names', () => {
  const privateFile = new File(['raw'], 'Family-Reunion-secret.NEF', { type: 'image/x-nikon-nef' });
  const transfer = dataTransfer([privateFile, privateFile], ['public.file-url']);
  const result = install({ pathForFile: () => '/Users/ansel/Private/Family-Reunion-secret.NEF' });

  const enter = dispatchDrag('dragenter', document.body, transfer);
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(result.states, [true]);

  const drop = dispatchDrag('drop', document.body, transfer);
  assert.equal(drop.defaultPrevented, true);
  assert.deepEqual(result.states, [true, false]);
  assert.deepEqual(result.paths, [['/Users/ansel/Private/Family-Reunion-secret.NEF']]);
  assert.deepEqual(result.diagnostics.at(-1)?.fileKinds, ['nef', 'nef']);
  assert.equal(JSON.stringify(result.diagnostics).includes('Family-Reunion'), false);
});

test('child churn cancels a pending leave reset while blur always clears drag state', async () => {
  const file = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
  const transfer = dataTransfer([file], ['Files']);
  const result = install();

  dispatchDrag('dragenter', document.body, transfer);
  dispatchDrag('dragleave', document.body, transfer);
  dispatchDrag('dragover', document.body, transfer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(result.states, [true]);

  window.dispatchEvent(new Event('blur'));
  assert.deepEqual(result.states, [true, false]);
  assert.equal(result.diagnostics.at(-1)?.reason, 'window-blur');
});

test('recovery-key targets retain their file drop while unknown drops cannot navigate', () => {
  const file = new File(['key'], 'overlook-recovery.key', { type: 'application/octet-stream' });
  const fileTransfer = dataTransfer([file], ['Files']);
  const textTransfer = dataTransfer([], ['text/uri-list']);
  const result = install();
  const keyTarget = document.createElement('button');
  keyTarget.dataset['overlookFileDropTarget'] = 'recovery-key';
  document.body.append(keyTarget);
  let keyDrops = 0;
  keyTarget.addEventListener('drop', (event) => {
    event.preventDefault();
    keyDrops += 1;
  });

  const keyDrop = dispatchDrag('drop', keyTarget, fileTransfer);
  assert.equal(keyDrop.defaultPrevented, true);
  assert.equal(keyDrops, 1);
  assert.deepEqual(result.paths, []);

  const unknownDrop = dispatchDrag('drop', document.body, textTransfer);
  assert.equal(unknownDrop.defaultPrevented, true);
  assert.equal(result.unsupported.count, 0);
});

test('internal collection and photo drags reach their nested target through the window capture boundary', () => {
  const result = install();
  const target = document.createElement('button');
  document.body.append(target);
  const received: string[] = [];
  const captured: boolean[] = [];
  target.addEventListener('drop', (event) => {
    event.preventDefault();
    received.push(...Array.from(event.dataTransfer?.types ?? []));
  });
  for (const type of [ALBUM_REORDER_DRAG_TYPE, PHOTO_DRAG_TYPE]) {
    const transfer = dataTransfer([], [type]);
    captured.push(dispatchDrag('dragenter', target, transfer).defaultPrevented);
    captured.push(dispatchDrag('dragover', target, transfer).defaultPrevented);
    assert.equal(dispatchDrag('drop', target, transfer).defaultPrevented, true);
  }
  assert.deepEqual(received, [ALBUM_REORDER_DRAG_TYPE, PHOTO_DRAG_TYPE]);
  assert.deepEqual(captured, [false, false, false, false]);
  assert.deepEqual(result.states, []);
  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.unsupported.count, 0);
});

test('drop diagnostics are bounded', () => {
  const diagnostics: ExternalDropDiagnostic[] = [];
  const report = createBoundedExternalDropReporter((entry) => diagnostics.push(entry));
  const entry: ExternalDropDiagnostic = {
    phase: 'reset',
    reason: 'test',
    eventPath: [],
    transferTypes: [],
    fileKinds: [],
    fileCount: 0,
  };
  for (let index = 0; index < 100; index += 1) report(entry);
  assert.equal(diagnostics.length, 16);
});
