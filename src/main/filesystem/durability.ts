import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

type DirectoryHandle = Pick<FileHandle, 'close' | 'sync'>;
type OpenDirectory = (path: string) => Promise<DirectoryHandle>;

async function openDirectory(path: string): Promise<DirectoryHandle> {
  return open(path, 'r');
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
