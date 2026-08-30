import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { commandLineOpenPaths, ExternalOpenIntake, openPathKey, type IntakeScheduler } from '../../src/main/import/external-open-intake.js';

class ManualScheduler implements IntakeScheduler {
  private readonly tasks = new Map<number, () => void>();
  private next = 1;

  set(task: () => void): unknown {
    const id = this.next++;
    this.tasks.set(id, task);
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle);
  }

  run(): void {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) task();
  }
}

describe('external open intake (#406)', () => {
  test('dedupe keys preserve case only on case-sensitive platforms', () => {
    assert.equal(openPathKey('/Photos/FAMILY.overlooklibrary', 'darwin'), '/photos/family.overlooklibrary');
    assert.equal(openPathKey('/Photos/FAMILY.overlooklibrary', 'win32'), '/photos/family.overlooklibrary');
    assert.equal(openPathKey('/Photos/FAMILY.overlooklibrary', 'linux'), '/Photos/FAMILY.overlooklibrary');
  });

  test('argv parsing strips Electron launch arguments and rejects flags', () => {
    assert.deepEqual(commandLineOpenPaths(['/Electron', '/app', 'one.jpg', '--inspect', '/two.nef'], false, '/cwd', 'darwin'), [
      '/cwd/one.jpg',
      '/two.nef',
    ]);
    assert.deepEqual(commandLineOpenPaths(['/Overlook', 'folder'], true, '/cwd', 'darwin'), ['/cwd/folder']);
  });

  test('P0: 800 open-file events become one authorized renderer delivery', () => {
    const scheduler = new ManualScheduler();
    const deliveries: string[][] = [];
    const intake = new ExternalOpenIntake({
      scheduler,
      platform: 'darwin',
      deliver: (paths) => deliveries.push([...paths]),
    });
    for (let index = 0; index < 800; index += 1) intake.enqueue([`/photos/${String(index)}.jpg`]);
    scheduler.run();
    assert.deepEqual(intake.stats(), { pending: 800, ready: false, authorized: false });
    intake.setAuthorized(true);
    intake.rendererReady();
    scheduler.run();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.length, 800);
    assert.equal(intake.stats().pending, 0);
  });

  test('locked and renderer-reload states retain and deduplicate paths', () => {
    const scheduler = new ManualScheduler();
    const deliveries: string[][] = [];
    const intake = new ExternalOpenIntake({
      scheduler,
      platform: 'darwin',
      deliver: (paths) => deliveries.push([...paths]),
    });
    intake.setAuthorized(true);
    intake.rendererReady();
    intake.enqueue(['/Photos/A.JPG', '/photos/a.jpg']);
    intake.setAuthorized(false);
    scheduler.run();
    assert.equal(deliveries.length, 0);
    assert.equal(intake.stats().pending, 1);
    intake.setAuthorized(true);
    scheduler.run();
    assert.equal(deliveries.length, 0, 'unlock alone cannot race ahead of the replacement renderer');
    intake.rendererReady();
    scheduler.run();
    assert.deepEqual(deliveries, [['/photos/a.jpg']]);
  });

  test('later bursts coalesce while the same renderer remains ready', () => {
    const scheduler = new ManualScheduler();
    const deliveries: string[][] = [];
    const intake = new ExternalOpenIntake({ scheduler, platform: 'darwin', deliver: (paths) => deliveries.push([...paths]) });
    intake.setAuthorized(true);
    intake.rendererReady();
    scheduler.run();
    intake.enqueue(['/one.jpg']);
    intake.enqueue(['/two.jpg']);
    scheduler.run();
    assert.deepEqual(deliveries, [['/one.jpg', '/two.jpg']]);
  });
});
