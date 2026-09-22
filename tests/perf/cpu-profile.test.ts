import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureDuringOperation } from './cpu-profile.js';

test('CPU capture finishes before a pending operation and runs only once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete: ((value: number) => void) | undefined;
  const operation = new Promise<number>((resolve) => {
    complete = resolve;
  });
  let captures = 0;
  let completed = false;
  const result = captureDuringOperation(
    () => operation,
    () => {
      captures += 1;
      return Promise.resolve();
    },
  ).then((value) => {
    completed = true;
    return value;
  });
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(captures, 1);
  assert.equal(completed, false, 'capturing must not terminate the import');
  assert.ok(complete);
  complete(100);
  assert.equal(await result, 100);
  t.mock.timers.tick(30_000);
  assert.equal(captures, 1);
});

test('an early operation failure still captures once and retains its error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failure = new Error('import failed');
  let captures = 0;
  await assert.rejects(
    captureDuringOperation(
      () => Promise.reject(failure),
      () => {
        captures += 1;
        return Promise.resolve();
      },
    ),
    (error) => error === failure,
  );
  t.mock.timers.tick(30_000);
  assert.equal(captures, 1);
});

test('an early capture failure is observed when the operation settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete: (() => void) | undefined;
  const operation = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const failure = new Error('inspector disconnected');
  const result = captureDuringOperation(
    () => operation,
    () => Promise.reject(failure),
  );
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.ok(complete);
  complete();
  await assert.rejects(result, (error) => error === failure);
});
