import type { Dirent } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

function root(dataDir: string): string {
  return path.resolve(dataDir, 'photokit-transfers');
}

function owned(dataDir: string, candidate: string): boolean {
  const relative = path.relative(root(dataDir), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && path.dirname(relative) === '.';
}

export async function createPhotoKitStage(dataDir: string): Promise<string> {
  const stagingRoot = root(dataDir);
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(stagingRoot, 'transfer-'));
}

export async function cleanupPhotoKitStage(dataDir: string, candidate: string): Promise<void> {
  if (owned(dataDir, candidate)) await rm(path.resolve(candidate), { recursive: true, force: true });
}

export async function cleanupPhotoKitOrphans(dataDir: string, preserve: string | null): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root(dataDir), { withFileTypes: true });
  } catch {
    return;
  }
  const preserved = preserve === null ? null : path.resolve(preserve);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('transfer-'))
      .map(async (entry) => {
        const candidate = path.join(root(dataDir), entry.name);
        if (candidate !== preserved) await cleanupPhotoKitStage(dataDir, candidate);
      }),
  );
}

export function isPhotoKitStage(dataDir: string, candidate: string): boolean {
  return owned(dataDir, candidate);
}
