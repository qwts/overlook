import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

type SyncHandle = Pick<FileHandle, 'close' | 'sync'>;
type OpenDirectory = (path: string) => Promise<SyncHandle>;
type OpenWritableFile = (path: string, flags: 'r+') => Promise<SyncHandle>;

async function openDirectory(path: string): Promise<SyncHandle> {
  return open(path, 'r');
}

async function openWritableFile(path: string, flags: 'r+'): Promise<SyncHandle> {
  return open(path, flags);
}

/**
 * Flushes an Overlook-owned staging file before atomic publication. Windows
 * requires write authority on the handle passed to fsync; reopening the file
 * read-only returns EPERM even though the file itself remains writable.
 */
export async function syncFileData(path: string, openHandle: OpenWritableFile = openWritableFile): Promise<void> {
  const handle = await openHandle(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Flushes an atomically published directory entry where the host supports it.
 * Windows rejects syncing directory handles with EPERM, so its strongest
 * available contract is regular-file fsync followed by atomic publication.
 */
export async function syncDirectoryEntry(
  path: string,
  platform: NodeJS.Platform = process.platform,
  openHandle: OpenDirectory = openDirectory,
): Promise<void> {
  if (platform === 'win32') return;

  const handle = await openHandle(path);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
