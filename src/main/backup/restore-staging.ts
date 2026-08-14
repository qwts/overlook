import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { RestoreError, type RestoreCheckpoint } from './restore-types.js';

const checkpointSchema = z.strictObject({
  version: z.literal(1),
  libraryId: z.string().min(1),
  manifestPath: z.string().min(1),
  sealedManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  completedBlobIds: z.array(z.string().min(1)).readonly(),
  completedThumbnailIds: z.array(z.string().min(1)).readonly(),
  completedProtectedObjectIds: z.array(z.string().min(1)).readonly().default([]),
  /** Sidecar objects already restored + verified (#484). */
  completedSidecarIds: z.array(z.string().min(1)).readonly().optional(),
});

export interface RestorePaths {
  readonly targetDir: string;
  readonly stagingDir: string;
  readonly previousDir: string;
  readonly checkpointPath: string;
}

export interface ActivationOperations {
  readonly rename: typeof rename;
  readonly rm: typeof rm;
}

const defaultOperations: ActivationOperations = { rename, rm };

export function restorePaths(targetDir: string): RestorePaths {
  return {
    targetDir,
    stagingDir: `${targetDir}.restore-staging`,
    previousDir: `${targetDir}.restore-previous`,
    checkpointPath: `${targetDir}.restore-staging/restore-checkpoint.json`,
  };
}

async function directoryHasEntries(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return (await readdir(path)).length > 0;
}

export async function assertRestoreAuthorized(paths: RestorePaths, allowReplace: boolean): Promise<void> {
  if ((await directoryHasEntries(paths.targetDir)) && !allowReplace) {
    throw new RestoreError('destructive-authorization', 'refusing to replace a non-empty library without explicit authorization');
  }
}

export async function recoverInterruptedActivation(paths: RestorePaths): Promise<void> {
  const targetExists = existsSync(paths.targetDir);
  const previousExists = existsSync(paths.previousDir);
  if (!targetExists && previousExists) {
    await rename(paths.previousDir, paths.targetDir);
  } else if (targetExists && previousExists) {
    await rm(paths.previousDir, { recursive: true, force: true });
  }
}

export async function resetStaging(paths: RestorePaths): Promise<void> {
  await rm(paths.stagingDir, { recursive: true, force: true });
  await mkdir(paths.stagingDir, { recursive: true });
}

export async function loadCheckpoint(paths: RestorePaths): Promise<RestoreCheckpoint | null> {
  if (!existsSync(paths.checkpointPath)) return null;
  try {
    return checkpointSchema.parse(JSON.parse(await readFile(paths.checkpointPath, 'utf8')));
  } catch {
    return null;
  }
}

export async function saveCheckpoint(paths: RestorePaths, checkpoint: RestoreCheckpoint): Promise<void> {
  const parsed = checkpointSchema.parse(checkpoint);
  await mkdir(dirname(paths.checkpointPath), { recursive: true });
  const temporary = `${paths.checkpointPath}.tmp`;
  await writeFile(temporary, JSON.stringify(parsed));
  await rename(temporary, paths.checkpointPath);
}

/** Sibling-directory renames keep activation on one filesystem. If the
 * staged rename fails, the previous library is restored before surfacing. */
export async function activateStagedLibrary(paths: RestorePaths, operations: ActivationOperations = defaultOperations): Promise<void> {
  await operations.rm(paths.previousDir, { recursive: true, force: true });
  const hadTarget = existsSync(paths.targetDir);
  if (hadTarget) await operations.rename(paths.targetDir, paths.previousDir);
  try {
    await operations.rename(paths.stagingDir, paths.targetDir);
  } catch (error) {
    if (hadTarget && existsSync(paths.previousDir)) {
      // Closing the active library does not stop every renderer query. One
      // can recreate the target directory (for example by minting a
      // library-id) after the previous library has moved aside. It is still
      // failed-activation debris: remove it before restoring known-good
      // custody, even when the failed rename partially created the target.
      // Linux can report ENOTEMPTY when that recreation lands during the
      // recursive removal itself. fs.rm's bounded retry closes that race;
      // after it succeeds the rename immediately replaces the target with
      // the saved directory.
      await operations.rm(paths.targetDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
      await operations.rename(paths.previousDir, paths.targetDir);
    }
    throw error;
  }
  await operations.rm(paths.previousDir, { recursive: true, force: true });
}
