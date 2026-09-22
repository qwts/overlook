import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { OverlookApi } from '../../src/shared/ipc/api.js';

import { COLLECTION_BUDGETS } from './budgets.js';

const COLLECTIONS = 300;
const ROUNDS = 5;
const ROOT_NAME = 'Perf collections';

async function seedCollections(page: Page) {
  return page.evaluate(async (rootName) => {
    const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
    await overlook.settings.set({ patch: { autoBackupOnImport: false } });
    for (const album of (await overlook.library.albums()).albums) {
      await overlook.albums.delete({ albumId: album.id });
    }
    const photos = (await overlook.library.page({ source: 'all', limit: 200 })).photos;
    if (photos.length !== 200) throw new Error('collection fixture requires 200 member photos');
    const root = (await overlook.albums.create({ name: rootName, kind: 'folder' })).album;
    const destination = (await overlook.albums.create({ name: 'Move destination', kind: 'folder', parentId: root.id })).album;
    const leaves: string[] = [];
    for (let branch = 0; branch < 8; branch += 1) {
      let parentId = root.id;
      for (let depth = 1; depth <= 5; depth += 1) {
        parentId = (await overlook.albums.create({ name: `Branch ${branch} depth ${depth}`, kind: 'folder', parentId })).album.id;
      }
      leaves.push(parentId);
    }
    const albumIds: string[] = [];
    for (let index = 0; index < 258; index += 1) {
      const parentId = leaves[index % leaves.length];
      if (parentId === undefined) throw new Error('missing fixture parent');
      const album = (await overlook.albums.create({ name: `Perf album ${index}`, parentId })).album;
      const photoIds = Array.from({ length: 8 }, (_, offset) => photos[(index * 5 + offset) % photos.length]?.id ?? '');
      const added = await overlook.albums.addPhotos({ albumId: album.id, photoIds });
      if (added.added !== 8) throw new Error('collection fixture membership was not inserted');
      albumIds.push(album.id);
    }
    const movedId = albumIds[0];
    const originalParent = leaves[0];
    if (movedId === undefined || originalParent === undefined) throw new Error('missing mutation fixture');
    return { rootId: root.id, destinationId: destination.id, movedId, originalParent };
  }, ROOT_NAME);
}

function median(samples: readonly number[]): number {
  if (samples.length !== ROUNDS) throw new Error('incomplete collection timing samples');
  return [...samples].sort((a, b) => a - b)[Math.floor(ROUNDS / 2)]!;
}

/** Native DOM click to next painted frame with the complete subtree mounted.
 * IPC/seed time and Playwright transport are outside this render sample. */
async function expandMs(page: Page): Promise<number> {
  const root = page
    .locator('.ovl-sidebar__albumrow')
    .filter({ has: page.locator('.ovl-siderow__label', { hasText: /^Perf collections$/u }) });
  await root.locator(':scope > .ovl-siderow').click();
  await expect(page.locator('.ovl-sidebar__albumrow')).toHaveCount(1);
  return page.evaluate<number>(`(() => {
    const label = [...document.querySelectorAll('.ovl-siderow__label')].find((element) => element.textContent === ${JSON.stringify(ROOT_NAME)});
    const button = label?.closest('button');
    if (!button) throw new Error('missing folder expansion control');
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const frame = () => {
        if (document.querySelectorAll('.ovl-sidebar__albumrow').length === ${COLLECTIONS} && button.getAttribute('aria-expanded') === 'true') {
          requestAnimationFrame(() => resolve(performance.now() - started));
        } else if (performance.now() - started > 10_000) {
          reject(new Error('sidebar did not render the complete collection fixture'));
        } else {
          requestAnimationFrame(frame);
        }
      };
      button.click();
      requestAnimationFrame(frame);
    });
  })()`);
}

test('300 collections at depth six: list, reorder, move, and sidebar render (#1105)', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'overlook-collections-perf-'));
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, OVERLOOK_USER_DATA: userData, OVERLOOK_SEED_SYNTHETIC: '1000', OVERLOOK_INSECURE_KEYSTORE: '1' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('statusbar-left')).toContainText('1,000 photos ·', { timeout: 120_000 });
    const fixture = await seedCollections(page);
    await expect(page.locator('.ovl-sidebar__albumrow')).toHaveCount(COLLECTIONS);
    await expect(page.locator('.ovl-sidebar__albumrow[data-depth="6"]')).toHaveCount(258);
    const timings = await page.evaluate(
      async ({ rootId, destinationId, movedId, originalParent, rounds }) => {
        const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
        const samples = { list: [] as number[], reorder: [] as number[], move: [] as number[] };
        for (let round = 0; round < rounds; round += 1) {
          let start = performance.now();
          const listed = (await overlook.library.albums()).albums;
          samples.list.push(performance.now() - start);
          if (listed.length !== 300 || listed.find((album) => album.id === rootId)?.count !== 200)
            throw new Error('incomplete collection listing');
          if (listed.filter((album) => album.kind === 'album').some((album) => album.count !== 8))
            throw new Error('incorrect album counts');
          const siblings = listed.filter((album) => album.parentId === originalParent);
          const position = round % 2 === 0 ? siblings.length - 1 : 0;
          start = performance.now();
          const reordered = await overlook.albums.reorder({
            albumId: movedId,
            position,
            commandId: position === 0 ? 'album.reorder.top' : 'album.reorder.bottom',
          });
          samples.reorder.push(performance.now() - start);
          if (!reordered.changed || reordered.position !== position) throw new Error('reorder sample was a no-op');
          const ordered = (await overlook.library.albums()).albums.filter((album) => album.parentId === originalParent);
          if (ordered[position]?.id !== movedId) throw new Error('reorder did not persist');
          start = performance.now();
          const moved = await overlook.albums.move({ albumId: movedId, parentId: destinationId });
          samples.move.push(performance.now() - start);
          if (moved.album.parentId !== destinationId || moved.album.count !== 8) throw new Error('move did not preserve membership');
          const after = (await overlook.library.albums()).albums;
          if (after.find((album) => album.id === destinationId)?.count !== 8) throw new Error('destination folder count did not update');
          // Restore a real starting position for the next measured mutation.
          await overlook.albums.move({ albumId: movedId, parentId: originalParent });
          await overlook.albums.reorder({
            albumId: movedId,
            position,
            commandId: position === 0 ? 'album.reorder.top' : 'album.reorder.bottom',
          });
        }
        return samples;
      },
      { ...fixture, rounds: ROUNDS },
    );
    const render: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) render.push(await expandMs(page));
    const medians = {
      listMs: median(timings.list),
      reorderMs: median(timings.reorder),
      moveMs: median(timings.move),
      sidebarExpandMs: median(render),
    };
    const report = {
      collections: COLLECTIONS,
      folders: 42,
      albums: 258,
      maxDepth: 6,
      libraryPhotos: 1000,
      memberPhotos: 200,
      memberships: 2064,
      rounds: ROUNDS,
      samples: { ...timings, render },
      medians,
    };
    writeFileSync(join('test-results', 'collections-perf-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log('[perf] collections:', JSON.stringify(report));
    for (const [metric, value] of Object.entries(medians)) {
      expect(value, metric).toBeLessThan(COLLECTION_BUDGETS[metric as keyof typeof COLLECTION_BUDGETS]);
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
