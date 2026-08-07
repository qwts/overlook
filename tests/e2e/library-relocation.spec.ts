import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from '@playwright/test';
import type { OverlookApi } from '../../src/shared/ipc/api.js';

import { test, expect, expectRendererReload, appExited, type LaunchedApp } from './support/app.js';
import { mkE2eTmpDir } from './support/tmp-dir.js';

// #483 / ADR-0022: relocation moves a whole library with an atomic registry
// commit. Crash at every §4 boundary and prove exactly one authoritative,
// usable library remains (acceptance 6); refusals leave both sides untouched
// (acceptance 7); the active library reopens from its new home (acceptance 2).
//
// Launch/readiness/teardown run through the shared staged fixture (#630);
// the active-library move synchronizes on the renderer reload itself via
// expectRendererReload instead of racing firstWindow() against it.

async function createSecondLibrary(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
    const { library } = await overlook.libraries.create({ name: 'Second', path: null });
    return library.id;
  });
}

async function moveLibrary(
  page: Page,
  id: string,
  destPath: string,
): Promise<Awaited<ReturnType<OverlookApi['libraries']['move']>> | null> {
  return page
    .evaluate(
      async ({ target, dest }) => {
        const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
        return overlook.libraries.move({ id: target, destPath: dest });
      },
      { target: id, dest: destPath },
    )
    .catch((error: unknown) => {
      // Moving the ACTIVE library reloads the window mid-IPC; a fault kills
      // the process outright. Both sever this context — the caller asserts
      // through relaunch/reload instead of a response.
      const message = error instanceof Error ? error.message : String(error);
      if (!/context|destroyed|navigation|Target/iu.test(message)) throw error;
      return null;
    });
}

async function libraryPath(page: Page, id: string): Promise<{ path: string; open: boolean } | null> {
  return page.evaluate(async (target) => {
    const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
    const { libraries } = await overlook.libraries.list();
    const found = libraries.find((lib) => lib.id === target);
    return found === undefined ? null : { path: found.path, open: found.open };
  }, id);
}

test('ACCEPTANCE: an inactive library moves to a new folder and the registry follows (#483 acceptance 1)', async ({ launchOverlook }) => {
  // Budget: launch+ready (≤30s staged) + an inactive move (no reload, ~1s).
  test.setTimeout(60_000);
  const { page, userData } = await launchOverlook({ prefix: 'overlook-e2e-reloc-', env: { OVERLOOK_SEED: '1' } });
  const secondId = await createSecondLibrary(page);
  const dest = join(userData, 'moved', 'Second');
  mkdirSync(join(userData, 'moved'), { recursive: true });

  const outcome = await moveLibrary(page, secondId, dest);
  expect(outcome).toMatchObject({ ok: true, outcome: 'moved' });
  expect(await libraryPath(page, secondId)).toMatchObject({ path: dest });
  expect(existsSync(join(dest, 'library-id'))).toBe(true);
});

test('ACCEPTANCE: rename a library folder in place — Finder name changes, identity and registry follow, bad names refuse (#686)', async ({
  launchOverlook,
}) => {
  // Budget: launch+ready (≤30s staged) + three inactive renames (~1s each).
  test.setTimeout(60_000);
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-rename-', env: { OVERLOOK_SEED: '1' } });
  const secondId = await createSecondLibrary(page);
  const before = await libraryPath(page, secondId);
  expect(before).not.toBeNull();

  const rename = async (newName: string): Promise<Awaited<ReturnType<OverlookApi['libraries']['renameFolder']>>> =>
    page.evaluate(
      async ({ target, name }) => {
        const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
        return overlook.libraries.renameFolder({ id: target, newName: name });
      },
      { target: secondId, name: newName },
    );

  // Invalid names refuse before anything runs (conservative cross-platform).
  for (const bad of ['CON', 'ends.', 'a/b']) {
    expect(await rename(bad)).toMatchObject({ ok: false, reason: 'invalid-destination' });
  }
  expect(await libraryPath(page, secondId)).toMatchObject({ path: before?.path ?? '' });

  // A real rename lands the sibling path and the folder carries the new name.
  const renamed = await rename('Renamed Second');
  expect(renamed).toMatchObject({ ok: true, outcome: 'moved', mode: 'rename' });
  const after = await libraryPath(page, secondId);
  expect(after?.path.endsWith('Renamed Second')).toBe(true);
  expect(existsSync(join(after?.path ?? '', 'library-id'))).toBe(true);
  expect(existsSync(before?.path ?? '')).toBe(false);

  // Case-only rename works whatever the volume's case sensitivity (#686).
  const cased = await rename('RENAMED SECOND');
  expect(cased).toMatchObject({ ok: true, outcome: 'moved', mode: 'rename' });
  const casedPath = await libraryPath(page, secondId);
  expect(casedPath?.path.endsWith('RENAMED SECOND')).toBe(true);
  expect(existsSync(join(casedPath?.path ?? '', 'library-id'))).toBe(true);
});

test('ACCEPTANCE: the ACTIVE library moves (copy mode), reopens from the destination, and keeps its photos (#483 acceptance 2/5)', async ({
  launchOverlook,
}) => {
  // Budget: launch+ready (≤30s staged) + copy-mode move with an in-place
  // renderer reload (≤30s staged via expectRendererReload).
  test.setTimeout(90_000);
  const launched = await launchOverlook({
    prefix: 'overlook-e2e-reloc-active-',
    env: { OVERLOOK_SEED: '3', OVERLOOK_RELOCATION_FORCE_COPY: '1' },
  });
  const { page, userData } = launched;
  await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(3);
  const activeId = await page.evaluate(async () => {
    const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
    return (await overlook.libraries.current()).library.id;
  });
  const dest = join(userData, 'moved', 'Active');
  mkdirSync(join(userData, 'moved'), { recursive: true });

  // The move reactivates + reloads the window from the destination; the
  // helper arms the navigation listener before the trigger so the reload
  // cannot be missed, then requires the grid to come back.
  await expectRendererReload(launched, () => moveLibrary(page, activeId, dest));
  await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(3);
  await expect.poll(() => libraryPath(page, activeId)).toMatchObject({ path: dest, open: true });
});

test('ACCEPTANCE: pre-commit crashes offer verified resume; post-commit recovery finishes automatically (#483/#559)', async ({
  launchOverlook,
}) => {
  test.setTimeout(300_000);
  for (const point of ['after-copy', 'after-verify', 'after-activate', 'after-commit'] as const) {
    const crashed: LaunchedApp = await launchOverlook({
      prefix: `overlook-e2e-reloc-crash-${point}-`,
      env: { OVERLOOK_SEED: '1', OVERLOOK_RELOCATION_FORCE_COPY: '1', OVERLOOK_RELOCATION_FAULT: point },
    });
    const { page, userData } = crashed;
    const secondId = await createSecondLibrary(page);
    const sourcePath = (await libraryPath(page, secondId))?.path ?? '';
    const dest = join(userData, 'moved', 'Second');
    mkdirSync(join(userData, 'moved'), { recursive: true });

    await moveLibrary(page, secondId, dest);
    await appExited(crashed);

    // Relaunch clean: pre-commit copy staging stays inert and explicit; the
    // source remains authoritative until Resume re-verifies and commits it.
    // The post-commit fault still finishes cleanup automatically.
    const relaunchedApp = await launchOverlook({ userData });
    const relaunched = relaunchedApp.page;
    const after = await libraryPath(relaunched, secondId);
    const preCommit = point !== 'after-commit';
    expect(after?.path).toBe(preCommit ? sourcePath : dest);
    expect(existsSync(preCommit ? sourcePath : dest)).toBe(true);
    if (preCommit) {
      await expect(relaunched.getByTestId('move-resume-banner')).toBeVisible();
      await expect(relaunched.getByText(`${sourcePath} → ${dest}`)).toBeVisible();
      await relaunched.getByTestId('move-banner-resume').click();
      await expect(relaunched.getByTestId('move-resume-banner')).toBeHidden();
      expect(await libraryPath(relaunched, secondId)).toMatchObject({ path: dest });
      expect(existsSync(sourcePath)).toBe(false);
      expect(existsSync(dest)).toBe(true);
    } else {
      expect(existsSync(sourcePath)).toBe(false);
    }
    expect(existsSync(`${dest}.relocate-staging`)).toBe(false);
    // Close this iteration's instance before the next fault point launches:
    // fixture teardown would otherwise keep all four recovery apps alive to
    // the end of the test, stacking Electron processes in one worker.
    await relaunchedApp.close();
  }
});

test('ACCEPTANCE: a non-empty destination refuses — never overwrites, never merges (#483 acceptance 7)', async ({ launchOverlook }) => {
  test.setTimeout(60_000);
  const { page, userData } = await launchOverlook({ prefix: 'overlook-e2e-reloc-refuse-', env: { OVERLOOK_SEED: '1' } });
  const secondId = await createSecondLibrary(page);
  const before = (await libraryPath(page, secondId))?.path ?? '';

  // The profile directory itself is occupied — a guaranteed-non-empty target.
  const outcome = await moveLibrary(page, secondId, userData);
  expect(outcome).toMatchObject({ ok: false });
  expect(await libraryPath(page, secondId)).toMatchObject({ path: before });
  expect(existsSync(join(before, 'library-id'))).toBe(true);
});

test('ACCEPTANCE: the wizard moves a library end to end — Review probe, Progress, Results (#483 acceptance 1)', async ({
  launchOverlook,
}) => {
  test.setTimeout(90_000);
  const destRoot = mkE2eTmpDir('overlook-e2e-reloc-destroot-');
  const { page } = await launchOverlook({
    prefix: 'overlook-e2e-reloc-wizard-',
    env: { OVERLOOK_SEED: '1', OVERLOOK_PICK_LIBRARY_DIR: destRoot },
  });
  await createSecondLibrary(page);

  await page.getByTestId('library-trigger').click();
  await page.getByTestId('library-switcher').waitFor();
  await page.getByTestId('move-library-Second').click();
  await page.getByTestId('move-pick-destination').click();
  // The Review probe resolves the honest method chip before Start.
  await page.getByTestId('move-method-chip').waitFor();
  await page.getByTestId('move-start').click();
  await page.getByTestId('move-results').waitFor();
  await expect(page.getByTestId('move-results').getByText('Moved')).toBeVisible();
  await page.getByTestId('move-done').click();

  const after = await page.evaluate(async () => {
    const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
    const { libraries } = await overlook.libraries.list();
    return libraries.find((lib) => lib.name === 'Second')?.path ?? null;
  });
  expect(after).toBe(join(destRoot, 'Second'));
});

test('ACCEPTANCE: multi-select moves several libraries into one root with independent results (#483 acceptance 4)', async ({
  launchOverlook,
}) => {
  test.setTimeout(120_000);
  const destRoot = mkE2eTmpDir('overlook-e2e-reloc-multiroot-');
  const { page } = await launchOverlook({
    prefix: 'overlook-e2e-reloc-multi-',
    env: { OVERLOOK_SEED: '1', OVERLOOK_PICK_LIBRARY_DIR: destRoot },
  });
  await page.evaluate(async () => {
    const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
    await overlook.libraries.create({ name: 'Alpha2', path: null });
    await overlook.libraries.create({ name: 'Beta2', path: null });
  });

  await page.getByTestId('library-trigger').click();
  await page.getByTestId('library-switcher').waitFor();
  await page.getByLabel('Select Alpha2 to move').click();
  await page.getByLabel('Select Beta2 to move').click();
  await page.getByTestId('move-selected').click();
  await page.getByTestId('move-pick-destination').click();
  await page.getByTestId('move-start').click();
  await page.getByTestId('move-results').waitFor();
  await expect(page.getByTestId('move-results').getByText('Moved')).toHaveCount(2);
  await page.getByTestId('move-done').click();

  const paths = await page.evaluate(async () => {
    const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
    const { libraries } = await overlook.libraries.list();
    return libraries
      .filter((lib) => lib.name.endsWith('2'))
      .map((lib) => lib.path)
      .sort();
  });
  expect(paths).toEqual([join(destRoot, 'Alpha2'), join(destRoot, 'Beta2')].sort());
});
